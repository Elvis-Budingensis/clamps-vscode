;;;; rpc.lisp — RPC-Funktionen für die VS-Code-Bridge.
;;;;
;;;; Bewusst frei von CLAMPS, Swank, Slynk und Incudine: hier drin steckt
;;;; nur portables CL plus ein paar SBCL-Interna (sb-mop, sb-kernel,
;;;; sb-introspect). Dadurch lässt sich die Datei gegen ein nacktes SBCL
;;;; laden und testen, ohne den kompletten Audio-Stack hochzufahren:
;;;;
;;;;   sbcl --load lisp/rpc.lisp
;;;;
;;;; bootstrap.lisp lädt diese Datei; die Trennung existiert nur, damit
;;;; Tests nicht am Prozess-Setup hängen.

(in-package :cl-user)

;;; ---------------------------------------------------------------------
;;; Eval-Kanal für die VS-Code-REPL
;;;
;;; Die Bridge ruft CLAMPS-BRIDGE-EVAL per Swank-RPC auf. Bewusst NICHT
;;; swank:listener-eval verwendet: das druckt REPL-Nebeneffekte auf einen
;;; an Emacs gebundenen Stream und ist von außen schwer sauber
;;; abzugreifen. Stattdessen fangen wir stdout/stderr in einen String,
;;; werten mehrere aufeinanderfolgende Forms aus (wie eine echte REPL-
;;; Eingabe mit mehreren Ausdrücken) und geben Werte + Ausgabe als EINEN
;;; String zurück. Die Funktion lebt im COMMON-LISP-USER-Paket, ist aber
;;; über ihren vollen Namen aufrufbar.
;;;
;;; Rückgabe: eine Liste (:ok "<ausgabe+werte>" "<paketname>") bzw.
;;; (:error "<fehlertext>" "<paketname>"). Die Bridge übersetzt das in
;;; das JSON {output, package}, das der TypeScript-Client erwartet.
;;; ---------------------------------------------------------------------

(defpackage :clamps-bridge-rpc
  (:use :cl)
  (:export #:eval-for-repl #:macroexpand-for-repl #:disassemble-for-repl
           #:find-definitions-for-repl #:inspect-for-repl
           #:trace-toggle-for-repl #:untrace-all-for-repl))
(in-package :clamps-bridge-rpc)

(defun %class-slot-names (class)
  (handler-case
      (mapcar (lambda (s)
                (funcall (find-symbol "SLOT-DEFINITION-NAME" :sb-mop) s))
              (funcall (find-symbol "CLASS-SLOTS" :sb-mop) class))
    (error () nil)))

(defun %struct-slot-names (obj)
  (handler-case
      (mapcar (lambda (dsd)
                (funcall (find-symbol "DSD-NAME" :sb-kernel) dsd))
              (funcall (find-symbol "DD-SLOTS" :sb-kernel)
                       (funcall (find-symbol "LAYOUT-INFO" :sb-kernel)
                                (funcall (find-symbol "%INSTANCE-LAYOUT" :sb-kernel) obj))))
    (error () nil)))

(defun %package-qualified (sym)
  "Symbolname mit Paket, damit slot-value es im richtigen Paket findet."
  (let ((pkg (symbol-package sym)))
    (if pkg
        (format nil "~A::~A" (string-downcase (package-name pkg))
                (string-downcase (symbol-name sym)))
        (string-downcase (symbol-name sym)))))

(defun %replace-obj (template expr-string)
  "Ersetzt jedes __OBJ__ im Template durch den geklammerten expr-string."
  (let ((wrapped (format nil "(progn ~A)" expr-string))
        (result (make-string-output-stream))
        (pos 0))
    (loop
      (let ((idx (search "__OBJ__" template :start2 pos)))
        (cond
          (idx
           (write-string (subseq template pos idx) result)
           (write-string wrapped result)
           (setf pos (+ idx 7)))
          (t
           (write-string (subseq template pos) result)
           (return)))))
    (get-output-stream-string result)))

(defun %preview (val)
  "Kurze, einzeilige Druckdarstellung für Slot-/Element-Vorschauen.
   Bewusst hart begrenzt: die Vorschau steht neben jedem Eintrag in der
   Liste, da darf nichts umbrechen oder minutenlang drucken."
  (handler-case
      (let ((s (let ((*print-length* 6)
                     (*print-level* 2)
                     (*print-circle* t)
                     (*print-pretty* nil)
                     (*print-case* :downcase))
                 (prin1-to-string val))))
        (if (> (length s) 90)
            (concatenate 'string (subseq s 0 87) "...")
            s))
    (error () "#<nicht druckbar>")))

(defun %fn-name (fn)
  "Funktionsname über SBCL-Interna. Die Kandidaten sind versionsabhängig:
   sb-impl::function-name existiert in neueren SBCLs (>= 2.6) nicht mehr,
   sb-kernel:%fun-name schon. Wir probieren der Reihe nach und geben nil
   zurück, wenn keiner greift — die Meta-Zeile entfällt dann eben."
  (dolist (cand '(("%FUN-NAME"    . :sb-kernel)
                  ("FUNCTION-NAME" . :sb-impl)
                  ("FUN-NAME"      . :sb-kernel))
           nil)
    (let ((r (handler-case
                 (let ((sym (find-symbol (car cand) (cdr cand))))
                   (when (and sym (fboundp sym))
                     (let ((n (funcall sym fn)))
                       (and n (let ((*print-case* :downcase))
                                (princ-to-string n))))))
               (error () nil))))
      (when r (return r)))))

;; sb-introspect ist nicht per Default im Image; ohne require findet
;; find-symbol das Paket gar nicht erst und die Lambda-Liste fehlt still.
(eval-when (:compile-toplevel :load-toplevel :execute)
  (handler-case (require :sb-introspect) (error () nil)))

(defun %fn-lambda-list (fn)
  (handler-case
      (let* ((sym (find-symbol "FUNCTION-LAMBDA-LIST" :sb-introspect))
             (ll (and sym (funcall sym fn))))
        (and ll (let ((*print-case* :downcase)) (princ-to-string ll))))
    (error () nil)))

(defun %inspect-describe (obj)
  "Beschreibt OBJ typspezifisch. Liefert (kind meta parts):

     kind  — Kategorie-String, den der Client zum Rendern nutzt
             (object struct list vector array hash-table string symbol
              function number character pathname package atom)
     meta  — Liste von (schlüssel . wert) Strings, Kopfzeilen-Infos
     parts — Liste von (label accessor preview); accessor enthält
             __OBJ__ als Platzhalter für den Zugriffs-Ausdruck

   Die Reihenfolge im typecase ist relevant: null vor symbol/list,
   string vor vector, vector vor array."
  (typecase obj
    (null
     (list "atom" (list (cons "hinweis" "nil — leere Liste und Symbol")) nil))

    (hash-table
     (let ((parts '()) (i 0) (truncated nil))
       (maphash (lambda (k v)
                  (if (< i 200)
                      (progn
                        (push (list (%preview k)
                                    (format nil "(gethash '~S __OBJ__)" k)
                                    (%preview v))
                              parts)
                        (incf i))
                      (setf truncated t)))
                obj)
       (list "hash-table"
             (append
              (list (cons "count" (princ-to-string (hash-table-count obj)))
                    (cons "test" (string-downcase
                                  (princ-to-string (hash-table-test obj)))))
              (when truncated (list (cons "anzeige" "erste 200"))))
             (nreverse parts))))

    (string
     (list "string"
           (list (cons "length" (princ-to-string (length obj)))
                 (cons "simple-p" (if (simple-string-p obj) "t" "nil")))
           nil))

    ;; ACHTUNG Reihenfolge: in SBCL sind package, pathname und
    ;; random-state als defstruct implementiert. Stünden sie hinter der
    ;; structure-object-Klausel, wären sie toter Code — SBCL warnt dann
    ;; mit "Clause X is shadowed by structure-object".
    (package
     (list "package"
           (list (cons "name" (package-name obj))
                 (cons "nicknames"
                       (format nil "~{~A~^, ~}" (package-nicknames obj)))
                 (cons "use-list"
                       (format nil "~{~A~^, ~}"
                               (mapcar #'package-name (package-use-list obj)))))
           nil))

    (pathname
     (list "pathname"
           (list (cons "namestring" (handler-case (namestring obj)
                                      (error () "—")))
                 (cons "name" (format nil "~A" (pathname-name obj)))
                 (cons "type" (format nil "~A" (pathname-type obj)))
                 (cons "exists-p" (if (probe-file obj) "t" "nil")))
           (list (list "directory" "(pathname-directory __OBJ__)"
                       (%preview (pathname-directory obj))))))

    (random-state
     (list "atom" (list (cons "typ" "random-state")) nil))

    (standard-object
     (let* ((class (class-of obj))
            (slots (%class-slot-names class)))
       (list "object"
             (list (cons "class" (let ((*print-case* :downcase))
                                   (princ-to-string (class-name class))))
                   (cons "slots" (princ-to-string (length slots))))
             (loop for slot in slots
                   collect (list (string-downcase (symbol-name slot))
                                 (format nil "(slot-value __OBJ__ '~A)"
                                         (%package-qualified slot))
                                 (if (slot-boundp obj slot)
                                     (%preview (slot-value obj slot))
                                     "#<unbound>"))))))

    (structure-object
     (let ((slots (%struct-slot-names obj)))
       (list "struct"
             (list (cons "type" (let ((*print-case* :downcase))
                                  (princ-to-string (type-of obj))))
                   (cons "slots" (princ-to-string (length slots))))
             (loop for slot in slots
                   collect (list (string-downcase (symbol-name slot))
                                 (format nil "(slot-value __OBJ__ '~A)"
                                         (%package-qualified slot))
                                 (handler-case (%preview (slot-value obj slot))
                                   (error () "#<unbound>")))))))

    (cons
     ;; Bounded traversal: verträgt auch dotted und zirkuläre Listen.
     (let ((parts '()) (i 0) (tail obj))
       (loop while (and (consp tail) (< i 200))
             do (push (list (princ-to-string i)
                            (format nil "(nth ~A __OBJ__)" i)
                            (%preview (car tail)))
                      parts)
                (incf i)
                (setf tail (cdr tail)))
       (when (and tail (not (consp tail)))
         (push (list "· cdr" "(cdr (last __OBJ__))" (%preview tail)) parts))
       (list "list"
             (list (cons "length" (if (consp tail)
                                      (format nil "> ~A" i)
                                      (princ-to-string i)))
                   (cons "proper-p" (if (consp tail) "?" (if tail "nil" "t"))))
             (nreverse parts))))

    ((and vector (not string))
     (list "vector"
           (list (cons "length" (princ-to-string (length obj)))
                 (cons "element-type"
                       (let ((*print-case* :downcase))
                         (princ-to-string (array-element-type obj))))
                 (cons "fill-pointer"
                       (if (array-has-fill-pointer-p obj)
                           (princ-to-string (fill-pointer obj))
                           "—")))
           (loop for i from 0 below (min 200 (length obj))
                 collect (list (princ-to-string i)
                               (format nil "(aref __OBJ__ ~A)" i)
                               (%preview (aref obj i))))))

    (array
     (list "array"
           (list (cons "dimensions" (format nil "~A" (array-dimensions obj)))
                 (cons "rank" (princ-to-string (array-rank obj)))
                 (cons "element-type"
                       (let ((*print-case* :downcase))
                         (princ-to-string (array-element-type obj)))))
           (loop for i from 0 below (min 200 (array-total-size obj))
                 collect (list (princ-to-string i)
                               (format nil "(row-major-aref __OBJ__ ~A)" i)
                               (%preview (row-major-aref obj i))))))

    (symbol
     (list "symbol"
           (append
            (list (cons "name" (symbol-name obj))
                  (cons "package" (if (symbol-package obj)
                                      (package-name (symbol-package obj))
                                      "#:uninterned"))
                  (cons "boundp" (if (boundp obj) "t" "nil"))
                  (cons "fboundp" (if (fboundp obj) "t" "nil")))
            (let ((doc (or (documentation obj 'variable)
                           (documentation obj 'function))))
              (when doc (list (cons "documentation" doc)))))
           (append
            (when (boundp obj)
              (list (list "symbol-value" "(symbol-value __OBJ__)"
                          (%preview (symbol-value obj)))))
            (when (fboundp obj)
              (list (list "symbol-function" "(symbol-function __OBJ__)"
                          (%preview (symbol-function obj)))))
            (when (symbol-plist obj)
              (list (list "symbol-plist" "(symbol-plist __OBJ__)"
                          (%preview (symbol-plist obj))))))))

    (function
     (list "function"
           (append
            (let ((n (%fn-name obj))) (when n (list (cons "name" n))))
            (let ((ll (%fn-lambda-list obj)))
              (when ll (list (cons "lambda-list" ll))))
            (let ((doc (documentation obj 'function)))
              (when doc (list (cons "documentation" doc)))))
           nil))

    (integer
     (list "number"
           (list (cons "decimal" (format nil "~D" obj))
                 (cons "hex" (format nil "#x~X" obj))
                 (cons "octal" (format nil "#o~O" obj))
                 (cons "binary" (if (< (integer-length obj) 256)
                                    (format nil "#b~B" obj)
                                    "— zu groß —"))
                 (cons "integer-length"
                       (princ-to-string (integer-length obj))))
           nil))

    (ratio
     (list "number"
           (list (cons "numerator" (princ-to-string (numerator obj)))
                 (cons "denominator" (princ-to-string (denominator obj)))
                 (cons "float" (handler-case
                                   (princ-to-string (float obj 1.0d0))
                                 (error () "—"))))
           nil))

    (float
     (list "number"
           (append
            (list (cons "value" (princ-to-string obj))
                  (cons "type" (let ((*print-case* :downcase))
                                 (princ-to-string (type-of obj)))))
            (handler-case
                (multiple-value-bind (sig exp sign) (decode-float obj)
                  (list (cons "significand" (princ-to-string sig))
                        (cons "exponent" (princ-to-string exp))
                        (cons "sign" (princ-to-string sign))))
              (error () nil)))
           nil))

    (complex
     (list "number"
           (list (cons "realpart" (%preview (realpart obj)))
                 (cons "imagpart" (%preview (imagpart obj))))
           (list (list "realpart" "(realpart __OBJ__)" (%preview (realpart obj)))
                 (list "imagpart" "(imagpart __OBJ__)" (%preview (imagpart obj))))))

    (character
     (list "character"
           (list (cons "char-code" (princ-to-string (char-code obj)))
                 (cons "hex" (format nil "#x~X" (char-code obj)))
                 (cons "name" (or (char-name obj) (string obj))))
           nil))

    (t (list "atom" nil nil))))

(defun inspect-for-repl (expr-string package-name)
  "Wertet EXPR-STRING aus und beschreibt das Ergebnis-Objekt typspezifisch.
   Gibt zurück:
   (:ok type print ((label accessor preview) ...) package kind
        ((meta-key . meta-value) ...))
   accessor enthält __OBJ__ als Platzhalter für EXPR-STRING.
   kind und meta sind neu — ältere Clients ignorieren sie einfach."
  (let ((pkg (or (find-package (string-upcase package-name))
                 (find-package :common-lisp-user))))
    (handler-case
        (let* ((*package* pkg)
               (*read-eval* nil)
               (form (read-from-string expr-string))
               (obj (eval form))
               (type-str (let ((*print-case* :downcase))
                           (princ-to-string (type-of obj))))
               (print-str (let ((*print-length* 100)
                                (*print-level* 5)
                                (*print-circle* t))
                            (prin1-to-string obj)))
               (described (%inspect-describe obj)))
          (destructuring-bind (kind meta parts) described
            (list :ok type-str print-str
                  (mapcar (lambda (p)
                            ;; (label accessor preview) — __OBJ__ ersetzen
                            (list (first p)
                                  (%replace-obj (second p) expr-string)
                                  (or (third p) "")))
                          parts)
                  (package-name pkg)
                  kind
                  (mapcar (lambda (m) (list (car m) (cdr m))) meta))))
      (error (e)
        (list :error (format nil "~A" e) "" nil (package-name pkg)
              "error" nil)))))

(defun %offset->line-col (filepath offset)
  "Zählt Zeilen/Spalten bis OFFSET (0-indexiert für LSP). Läuft im
   Image, wo die Datei sicher lesbar ist."
  (handler-case
      (with-open-file (s filepath :direction :input
                                   :external-format :utf-8)
        (let ((line 0) (col 0) (count 0))
          (loop
            (let ((ch (read-char s nil nil)))
              (when (or (null ch) (>= count offset)) (return))
              (if (char= ch #\Newline)
                  (progn (incf line) (setf col 0))
                  (incf col))
              (incf count)))
          (list line col)))
    (error () (list 0 0))))

(defun %resolve-source-file (raw-file)
  "Übersetzt einen Datei-Eintrag aus einer Swank-Location in einen
   existierenden physischen Pfad. SBCL-interne Definitionen kommen als
   Logical Pathnames (SYS:SRC;CODE;LIST.LISP) — translate-logical-pathname
   macht daraus den echten Pfad der installierten SBCL-Quellen. Gibt
   NIL zurück, wenn die Datei nicht existiert (z.B. SBCL ohne Quellen
   installiert), damit der Client das ehrlich melden kann statt ins
   Leere zu springen."
  (handler-case
      (let* ((path (etypecase raw-file
                     (pathname raw-file)
                     (string (parse-namestring raw-file))))
             (physical (translate-logical-pathname path)))
        (when (probe-file physical)
          (namestring physical)))
    (error () nil)))

(defun resolve-symbol (symbol-string pkg)
  "Löst SYMBOL-STRING zu einem echten Symbol-Objekt auf. Behandelt
   qualifizierte Namen (incudine:rt-start, clamps::foo) direkt über den
   Reader; für nackte Namen (rt-start) wird zuerst im übergebenen Paket
   PKG gesucht, dann fällt es auf einen unqualifizierten Reader-Versuch
   zurück. Gibt NIL zurück, wenn nichts gefunden wird."
  (handler-case
      (let ((*package* pkg) (*read-eval* nil))
        (if (find #\: symbol-string)
            ;; Qualifizierter Name: Reader macht das korrekt.
            (let ((obj (read-from-string symbol-string)))
              (and (symbolp obj) obj))
            ;; Nackter Name: erst im Paket suchen (findet auch geerbte
            ;; und interne Symbole), dann bild-weit, dann Reader-Fallback.
            (let ((upcased (string-upcase symbol-string)))
              (multiple-value-bind (sym status) (find-symbol upcased pkg)
                (cond
                  (status sym)
                  ;; Nicht im aktuellen Paket sichtbar (z.B. rt-start ohne
                  ;; (in-package :incudine) in der Datei): über alle Pakete
                  ;; suchen. Bevorzugt ein Symbol, das tatsächlich fboundp
                  ;; oder boundp ist, damit wir nicht ein zufälliges
                  ;; gleichnamiges Keyword o.ä. erwischen.
                  (t (let ((candidates '()))
                       (dolist (p (list-all-packages))
                         (multiple-value-bind (s st) (find-symbol upcased p)
                           (when (and st (eq (symbol-package s) p))
                             (pushnew s candidates))))
                       (or (find-if (lambda (s) (or (fboundp s) (boundp s)
                                                    (find-class s nil)))
                                    candidates)
                           (first candidates)
                           (and (not (find #\: symbol-string))
                                (ignore-errors
                                  (let ((obj (read-from-string symbol-string)))
                                    (and (symbolp obj) obj))))))))))))
    (error () nil)))

(defun trace-toggle-for-repl (symbol-string package-name)
  "Schaltet Trace für die Funktion am Symbol an/aus (SLIME
   C-c C-t Verhalten). (trace) ohne Argumente liefert die Liste der
   aktuell getracten Funktionsnamen — darüber wird der Zustand geprüft.
   trace/untrace sind Makros, daher der Umweg über eval mit
   eingesetztem Symbol. Gibt (:ok STATUS-TEXT TRACED-P) zurück."
  (let ((pkg (or (find-package (string-upcase package-name))
                 (find-package :common-lisp-user))))
    (handler-case
        (let* ((*package* pkg)
               (sym (resolve-symbol symbol-string pkg)))
          (cond
            ((null sym)
             (list :error (format nil "Symbol ~A nicht gefunden." symbol-string) nil))
            ((not (fboundp sym))
             (list :error (format nil "~A ist keine Funktion." sym) nil))
            (t
             (let ((traced (member sym (eval '(trace)) :test #'eq)))
               (if traced
                   (progn
                     (eval `(untrace ,sym))
                     (list :ok (format nil "Trace AUS: ~A" sym) nil))
                   (progn
                     (eval `(trace ,sym))
                     (list :ok (format nil "Trace AN: ~A - Aufrufe erscheinen in der REPL" sym) t)))))))
      (error (e)
        (list :error (format nil "~A" e) nil)))))

(defun untrace-all-for-repl ()
  "Schaltet alle Traces aus. Gibt (:ok TEXT) zurück."
  (handler-case
      (let ((traced (eval '(trace))))
        (eval '(untrace))
        (list :ok (if traced
                      (format nil "Alle Traces aus (~A Funktion~:P)." (length traced))
                      "Es war nichts getraced.")))
    (error (e) (list :error (format nil "~A" e)))))

(defun find-definitions-for-repl (symbol-string package-name)
  "Findet alle Definitionsorte des Symbols — auch für eingebaute
   SBCL-Funktionen, Variablen, Makros, Klassen (das M-. Erlebnis).
   Gibt (:ok ((file line col label) ...)) zurück; Einträge, deren
   Quelldatei nicht auffindbar ist, kommen mit file=NIL und dem Label,
   damit der Client sie anzeigen kann (z.B. 'Quelle nicht installiert')."
  (let ((pkg (or (find-package (string-upcase package-name))
                 (find-package :common-lisp-user))))
    (handler-case
        (let* ((*package* pkg)
               ;; Symbol zu einem echten Symbol-Objekt auflösen, dann
               ;; Swank mit dem VOLLQUALIFIZIERTEN Namen füttern. Grund:
               ;; find-definitions-for-emacs findet "rt-start" NICHT,
               ;; wenn man nur das Paket INCUDINE mitgibt, aber
               ;; "incudine:rt-start" schon. Wir bestimmen also das
               ;; Home-Paket des Symbols und bauen den qualifizierten
               ;; Namen selbst.
               (sym (resolve-symbol symbol-string pkg))
               (query-name (if sym
                               (let ((*package* (find-package :keyword)))
                                 ;; prin1 mit keyword-package erzwingt volle
                                 ;; Paket-Qualifizierung im ausgegebenen Namen.
                                 (let ((*print-case* :downcase)
                                       (*print-readably* nil))
                                   (prin1-to-string sym)))
                               symbol-string))
               (defs (funcall (find-symbol "FIND-DEFINITIONS-FOR-EMACS" :swank)
                              query-name))
               (results '()))
          (dolist (def defs)
            (let* ((label (let ((*print-case* :downcase))
                            (princ-to-string (first def))))
                   (loc (second def)))
              (when (and (consp loc) (eq (first loc) :location))
                (let ((file nil) (position nil))
                  ;; Location-Teile einsammeln: (:file "...") (:position n)
                  ;; oder (:buffer ...) (:offset start n) je nach Quelle.
                  (dolist (part (rest loc))
                    (when (consp part)
                      (case (first part)
                        (:file (setf file (second part)))
                        (:buffer-and-file (setf file (third part)))
                        (:position (setf position (second part)))
                        (:offset (setf position (+ (or (second part) 0)
                                                   (or (third part) 0)))))))
                  (let ((resolved (and file (%resolve-source-file file))))
                    (if resolved
                        (destructuring-bind (line col)
                            (%offset->line-col resolved
                                               (max 0 (1- (or position 1))))
                          (push (list resolved line col label) results))
                        ;; Datei nicht auffindbar: Label trotzdem melden.
                        (push (list nil 0 0 label) results)))))))
          (list :ok (nreverse results)))
      (error (e)
        (list :error (format nil "~A" e))))))

(defun disassemble-for-repl (symbol-string package-name)
  "Disassembliert die Funktion, auf die SYMBOL-STRING im Paket
   PACKAGE-NAME zeigt, und gibt den nativen Maschinencode als Text
   zurück. Das ist genau das, was SBCLs (disassemble #'fn) auf
   *standard-output* schreibt — wir fangen es in einen String.
   Gibt (STATUS OUTPUT-STRING PACKAGE-STRING) zurück."
  (let ((pkg (or (find-package (string-upcase package-name))
                 (find-package :common-lisp-user))))
    (handler-case
        (let* ((*package* pkg)
               ;; Symbol aus dem String lesen (respektiert Paket-Prefixe
               ;; wie clamps::rts-start, weil *package* gebunden ist).
               (sym (let ((*read-eval* nil))
                      (read-from-string symbol-string))))
          (cond
            ((not (symbolp sym))
             (list :error
                   (format nil "~S ist kein Symbol." sym)
                   (package-name pkg)))
            ((not (fboundp sym))
             (list :error
                   (format nil "~A ist keine Funktion (fboundp = nil)." sym)
                   (package-name pkg)))
            ((macro-function sym)
             ;; disassemble auf ein Makro ist wenig sinnvoll — die
             ;; Expander-Funktion würde disassembliert, nicht das, was
             ;; der Nutzer erwartet. Ehrlich zurückmelden.
             (list :error
                   (format nil "~A ist ein Makro, kein disassemblierbarer Funktionsaufruf.~%~
                                Für Makros eignet sich Macroexpand." sym)
                   (package-name pkg)))
            (t
             (let ((out (make-string-output-stream)))
               (let ((*standard-output* out))
                 (disassemble (fdefinition sym)))
               (list :ok (get-output-stream-string out) (package-name pkg))))))
      (error (e)
        (list :error (format nil "~A" e) (package-name pkg))))))

(defun macroexpand-for-repl (code-string package-name full-p)
  "Liest die ERSTE Form aus CODE-STRING und expandiert sie im Paket
   PACKAGE-NAME. FULL-P nil = macroexpand-1 (nur eine Ebene, meist
   nützlicher beim interaktiven Arbeiten), FULL-P non-nil = macroexpand
   (vollständig). Gibt (STATUS OUTPUT-STRING PACKAGE-STRING) zurück.
   Die Ausgabe ist pretty-printed, damit der expandierte Code lesbar
   formatiert ist statt als eine lange Zeile."
  (let ((pkg (or (find-package (string-upcase package-name))
                 (find-package :common-lisp-user))))
    (handler-case
        (let* ((*package* pkg)
               (form (with-input-from-string (in code-string)
                       (read in nil :eof))))
          (if (eq form :eof)
              (list :ok "" (package-name pkg))
              (multiple-value-bind (expansion expanded-p)
                  (if full-p
                      (macroexpand form)
                      (macroexpand-1 form))
                (let ((text (if expanded-p
                                (let ((*print-pretty* t)
                                      (*print-right-margin* 80)
                                      (*print-case* :downcase))
                                  (prin1-to-string expansion))
                                ;; Kein Makro -> das ehrlich zurückmelden,
                                ;; statt die unveränderte Form als
                                ;; vermeintliche Expansion auszugeben.
                                (format nil ";; keine Makroexpansion (kein Makroaufruf)~%~A"
                                        (let ((*print-pretty* t)
                                              (*print-case* :downcase))
                                          (prin1-to-string expansion))))))
                  (list :ok text (package-name pkg))))))
      (error (e)
        (list :error (format nil "~A" e) (package-name pkg))))))

(defun eval-for-repl (code-string package-name)
  "Wertet CODE-STRING im Paket PACKAGE-NAME aus. Fängt Standard-Output
   und alle Rückgabewerte ein. Gibt (STATUS OUTPUT-STRING PACKAGE-STRING)
   zurück, STATUS ist :OK oder :ERROR."
  (let* ((pkg (or (find-package (string-upcase package-name))
                  (find-package :common-lisp-user)))
         (out (make-string-output-stream))
         ;; Ein Synonym-Stream, der auf out zeigt, damit alle Streams
         ;; wirklich denselben Puffer teilen.
         (two-way (make-two-way-stream (make-string-input-stream "") out)))
    (declare (ignorable two-way))
    (handler-case
        ;; ALLE Standard-Output-Streams auf out binden. Vorher waren nur
        ;; *standard-output*/*error-output*/*trace-output* gebunden; CLAMPS
        ;; (z.B. (clamps), describe) schreibt aber teils über *debug-io*,
        ;; *query-io* und *terminal-io*. Blieb einer davon an Swanks
        ;; Original-Stream gebunden, erschien die Ausgabe zusätzlich über
        ;; Swank und damit DOPPELT in der REPL. Jetzt teilen sich alle
        ;; denselben Puffer.
        (let* ((*package* pkg)
               (*standard-output* out)
               (*error-output* out)
               (*trace-output* out)
               (*debug-io* (make-two-way-stream (make-string-input-stream "") out))
               (*query-io* (make-two-way-stream (make-string-input-stream "") out))
               (*terminal-io* (make-two-way-stream (make-string-input-stream "") out))
               (values-strings '()))
          ;; Mehrere Forms nacheinander lesen und auswerten, damit eine
          ;; REPL-Zeile wie "(defparameter *x* 1) *x*" komplett läuft.
          (with-input-from-string (in code-string)
            (loop
              (let ((form (read in nil :eof)))
                (when (eq form :eof) (return))
                (let ((results (multiple-value-list (eval form))))
                  (setf values-strings
                        (append values-strings
                                (mapcar (lambda (v) (prin1-to-string v)) results)))))))
          (let* ((printed (get-output-stream-string out))
                 (value-text (format nil "~{~A~^~%~}" values-strings))
                 (combined (concatenate 'string
                                        printed
                                        (if (and (> (length printed) 0)
                                                 (> (length value-text) 0))
                                            (string #\Newline) "")
                                        value-text))
                 ;; *package* AUSLESEN, nicht pkg: wenn der Code ein
                 ;; (in-package ...) enthielt, hat sich *package* innerhalb
                 ;; dieser Bindung geändert. pkg zeigt weiter aufs alte
                 ;; Paket — deshalb blieb der REPL-Prompt hängen.
                 (current-pkg-name (package-name *package*)))
            (list :ok combined current-pkg-name)))
      (error (e)
        (let ((printed (get-output-stream-string out)))
          (list :error
                (concatenate 'string printed
                             (if (> (length printed) 0) (string #\Newline) "")
                             (format nil "~A" e))
                (package-name pkg)))))))

