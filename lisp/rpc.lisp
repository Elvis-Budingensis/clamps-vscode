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
           #:trace-toggle-for-repl #:untrace-all-for-repl
           #:traced-for-repl #:untrace-one-for-repl
           #:rt-status-for-repl #:completions-for-repl
           #:inspect-id-for-repl #:inspect-part-for-repl
           #:inspect-release-for-repl #:inspect-set-part-for-repl
           #:eval-for-repl-debuggable #:incudine-node-tree-for-repl
           #:packages-for-repl #:classes-for-repl #:threads-for-repl
           #:xref-for-repl #:apropos-for-repl #:break-on-signals-for-repl
           #:set-function-breakpoints-for-repl))
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

(defvar +unbound+ (make-symbol "UNBOUND")
  "Eindeutiger Marker für nicht gebundene Slots. Ein uninterniertes
   Symbol, damit es sich mit keinem echten Wert verwechseln lässt.")

(defun %inspect-describe (obj)
  "Beschreibt OBJ typspezifisch. Liefert (kind meta parts):

     kind  — Kategorie-String für den Client
     meta  — Liste von (schlüssel . wert) Strings, Kopfzeilen-Infos
     parts — Liste von (label wert preview setter)

   WERT ist das echte Lisp-Objekt, nicht ein Zugriffs-Ausdruck; darüber
   navigiert der Inspector, ohne beim Klick etwas neu zu berechnen.

   SETTER ist eine Funktion (lambda (neuer-wert) ...) oder nil, wenn der
   Teil nicht schreibbar ist. Die Alternative wäre gewesen, das Setzen in
   einer zweiten Funktion nochmal nach Typ zu unterscheiden — dann gäbe
   es zwei typecase-Kaskaden, die auseinanderlaufen können. So steht die
   Zuordnung Teil -> Schreibweg an genau einer Stelle.

   Die Reihenfolge im typecase ist relevant: null vor symbol/list,
   string vor vector, vector vor array, und package/pathname/random-state
   vor structure-object (in SBCL sind das defstructs)."
  (typecase obj
    (null
     (list "atom" (list (cons "hinweis" "nil — leere Liste und Symbol")) nil))

    (hash-table
     (let ((parts '()) (i 0) (truncated nil))
       (maphash (lambda (k v)
                  (if (< i 1000)
                      (progn
                        ;; k ist pro Aufruf frisch gebunden, die Closure
                        ;; fängt also den richtigen Schlüssel ein.
                        (push (list (%preview k) v (%preview v)
                                    (lambda (new) (setf (gethash k obj) new)))
                              parts)
                        (incf i))
                      (setf truncated t)))
                obj)
       (list "hash-table"
             (append
              (list (cons "count" (princ-to-string (hash-table-count obj)))
                    (cons "test" (string-downcase
                                  (princ-to-string (hash-table-test obj)))))
              (when truncated (list (cons "anzeige" "erste 1000"))))
             (nreverse parts))))

    (string
     (list "string"
           (list (cons "length" (princ-to-string (length obj)))
                 (cons "simple-p" (if (simple-string-p obj) "t" "nil")))
           nil))

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
     ;; Pathnames sind unveränderlich — kein Setter.
     (list "pathname"
           (list (cons "namestring" (handler-case (namestring obj)
                                      (error () "—")))
                 (cons "name" (format nil "~A" (pathname-name obj)))
                 (cons "type" (format nil "~A" (pathname-type obj)))
                 (cons "exists-p" (if (probe-file obj) "t" "nil")))
           (list (list "directory" (pathname-directory obj)
                       (%preview (pathname-directory obj)) nil))))

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
                   collect (let* ((sl slot)
                                  (bound (slot-boundp obj sl)))
                             (list (string-downcase (symbol-name sl))
                                   (if bound (slot-value obj sl) +unbound+)
                                   (if bound
                                       (%preview (slot-value obj sl))
                                       "#<unbound>")
                                   (lambda (new)
                                     (setf (slot-value obj sl) new))))))))

    (structure-object
     (let ((slots (%struct-slot-names obj)))
       (list "struct"
             (list (cons "type" (let ((*print-case* :downcase))
                                  (princ-to-string (type-of obj))))
                   (cons "slots" (princ-to-string (length slots))))
             (loop for slot in slots
                   collect (let ((sl slot))
                             (handler-case
                                 (let ((v (slot-value obj sl)))
                                   (list (string-downcase (symbol-name sl))
                                         v (%preview v)
                                         (lambda (new)
                                           (setf (slot-value obj sl) new))))
                               (error ()
                                 (list (string-downcase (symbol-name sl))
                                       +unbound+ "#<unbound>"
                                       (lambda (new)
                                         (setf (slot-value obj sl) new))))))))))

    (cons
     ;; Bounded traversal: verträgt dotted und zirkuläre Listen.
     (let ((parts '()) (i 0) (tail obj))
       (loop while (and (consp tail) (< i 1000))
             do (let ((cell tail))   ; frische Bindung für die Closure
                  (push (list (princ-to-string i) (car cell)
                              (%preview (car cell))
                              (lambda (new) (setf (car cell) new)))
                        parts))
                (incf i)
                (setf tail (cdr tail)))
       (when (and tail (not (consp tail)))
         (let ((lastcell (last obj)))
           (push (list "· cdr" tail (%preview tail)
                       (lambda (new) (setf (cdr lastcell) new)))
                 parts)))
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
           (loop for i from 0 below (min 1000 (length obj))
                 collect (let ((idx i))
                           (list (princ-to-string idx) (aref obj idx)
                                 (%preview (aref obj idx))
                                 (lambda (new) (setf (aref obj idx) new)))))))

    (array
     (list "array"
           (list (cons "dimensions" (format nil "~A" (array-dimensions obj)))
                 (cons "rank" (princ-to-string (array-rank obj)))
                 (cons "element-type"
                       (let ((*print-case* :downcase))
                         (princ-to-string (array-element-type obj)))))
           (loop for i from 0 below (min 1000 (array-total-size obj))
                 collect (let ((idx i))
                           (list (princ-to-string idx) (row-major-aref obj idx)
                                 (%preview (row-major-aref obj idx))
                                 (lambda (new)
                                   (setf (row-major-aref obj idx) new)))))))

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
              (list (list "symbol-value" (symbol-value obj)
                          (%preview (symbol-value obj))
                          (lambda (new) (setf (symbol-value obj) new)))))
            (when (fboundp obj)
              ;; Bewusst kein Setter: eine Funktionsdefinition versehentlich
              ;; über ein Eingabefeld zu überschreiben, wäre zu leicht.
              (list (list "symbol-function" (symbol-function obj)
                          (%preview (symbol-function obj)) nil)))
            (when (symbol-plist obj)
              (list (list "symbol-plist" (symbol-plist obj)
                          (%preview (symbol-plist obj))
                          (lambda (new) (setf (symbol-plist obj) new))))))))

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
     ;; Zahlen sind unveränderlich — real- und imagpart nur lesbar.
     (list "number"
           (list (cons "realpart" (%preview (realpart obj)))
                 (cons "imagpart" (%preview (imagpart obj))))
           (list (list "realpart" (realpart obj) (%preview (realpart obj)) nil)
                 (list "imagpart" (imagpart obj) (%preview (imagpart obj)) nil))))

    (character
     (list "character"
           (list (cons "char-code" (princ-to-string (char-code obj)))
                 (cons "hex" (format nil "#x~X" (char-code obj)))
                 (cons "name" (or (char-name obj) (string obj))))
           nil))

    (t (list "atom" nil nil))))

;;; ---------------------------------------------------------------------
;;; Objekt-Tabelle
;;;
;;; Der Inspector navigiert über IDs statt über re-evaluierbare
;;; Ausdrücke. Damit inspiziert man tatsächlich das vorhandene Objekt
;;; statt bei jedem Klick eine Neuberechnung anzustoßen, die bei
;;; Seiteneffekten ein anderes Objekt liefert.
;;;
;;; Lebensdauer: Einträge halten starke Referenzen, verhindern also GC.
;;; Das ist beabsichtigt (ein angezeigtes Objekt darf nicht unter der
;;; Hand verschwinden), aber bei laufendem Audio heikel — deshalb die
;;; FIFO-Grenze und das explizite Freigeben beim Schließen des Panels.
;;; ---------------------------------------------------------------------

(defvar *inspect-table* (make-hash-table :test 'eql)
  "id (fixnum) -> Objekt")
(defvar *inspect-order* '()
  "IDs in Einfügereihenfolge, jüngste zuerst — für die FIFO-Räumung.")
(defvar *inspect-counter* 0)

(defvar *inspect-parts-cache* (make-hash-table :test 'eql)
  "id -> (kind meta parts), die zuletzt berechnete Beschreibung.

   Ohne den Cache berechnete inspect-part-for-repl bei JEDEM Klick alle
   Teile neu, nur um einen davon zu benutzen: bei einem ATS-Vektor mit
   tausend Partials also tausend prin1-to-string-Aufrufe für Vorschauen,
   von denen 999 weggeworfen werden.

   Der ursprüngliche Grund dagegen — die Teile würden Objekte am GC
   vorbei festhalten — war ein Denkfehler: die Teile eines Vektors hält
   der Vektor ohnehin, und der Vektor steht bereits in *inspect-table*.
   Der Cache kostet also keine zusätzliche Retention und wird zusammen
   mit der Tabelle freigegeben.")

(defparameter *inspect-capacity* 500
  "Höchstzahl gehaltener Objekte. Darüber fliegen die ältesten raus.
   Verhindert, dass eine lange Inspektionssitzung Audio-Buffer am GC
   vorbei am Leben hält.")

(defun %inspect-register (obj)
  "Legt OBJ ab und liefert dessen ID."
  (let ((id (incf *inspect-counter*)))
    (setf (gethash id *inspect-table*) obj)
    (push id *inspect-order*)
    (when (> (hash-table-count *inspect-table*) *inspect-capacity*)
      (let ((keep (subseq *inspect-order* 0 *inspect-capacity*)))
        (dolist (old (nthcdr *inspect-capacity* *inspect-order*))
          (remhash old *inspect-table*)
          (remhash old *inspect-parts-cache*))
        (setf *inspect-order* keep)))
    id))

(defun inspect-release-for-repl ()
  "Gibt alle gehaltenen Objekte frei. Der Client ruft das beim Schließen
   des Inspector-Panels."
  (clrhash *inspect-table*)
  (clrhash *inspect-parts-cache*)
  (setf *inspect-order* '())
  (list :ok))

(defun %describe-registered (obj id)
  "Baut die Antwort für ein bereits registriertes Objekt."
  (let ((type-str (let ((*print-case* :downcase))
                    (princ-to-string (type-of obj))))
        (print-str (let ((*print-length* 100)
                         (*print-level* 5)
                         (*print-circle* t))
                     (prin1-to-string obj))))
    (destructuring-bind (kind meta parts) (%inspect-describe obj)
      ;; Für die spätere Navigation aufheben.
      (setf (gethash id *inspect-parts-cache*) parts)
      (list :ok id type-str print-str
            ;; (label index preview navigierbar-p schreibbar-p)
            (loop for p in parts
                  for i from 0
                  collect (list (first p) i (or (third p) "")
                                (if (eq (second p) +unbound+) nil t)
                                (if (fourth p) t nil)))
            kind
            (mapcar (lambda (m) (list (car m) (cdr m))) meta)))))

(defun inspect-for-repl (expr-string package-name)
  "Wertet EXPR-STRING aus, registriert das Ergebnis und beschreibt es.
   Rückgabe: (:ok id type print parts kind meta) oder (:error msg ...)."
  (let ((pkg (or (find-package (string-upcase package-name))
                 (find-package :common-lisp-user))))
    (handler-case
        (let* ((*package* pkg)
               (*read-eval* nil)
               (form (read-from-string expr-string))
               (obj (eval form)))
          (%describe-registered obj (%inspect-register obj)))
      (error (e)
        (list :error (format nil "~A" e) "" nil "error" nil)))))

(defun inspect-id-for-repl (id)
  "Beschreibt das Objekt mit ID neu — für Refresh, wenn es sich
   inzwischen geändert hat."
  (handler-case
      (multiple-value-bind (obj found) (gethash id *inspect-table*)
        (if found
            ;; Cache verwerfen: Refresh existiert gerade dafür, dass sich
            ;; das Objekt inzwischen geändert haben kann.
            (progn (remhash id *inspect-parts-cache*)
                   (%describe-registered obj id))
            (list :error "Objekt nicht mehr verfügbar (Panel neu öffnen)"
                  "" nil "error" nil)))
    (error (e) (list :error (format nil "~A" e) "" nil "error" nil))))

(defun inspect-part-for-repl (id index)
  "Navigiert vom Objekt ID zu dessen Teil INDEX.

   Nutzt die beim Beschreiben abgelegte Teileliste. Fehlt sie (Cache
   geräumt, Image neu gestartet), wird einmal neu berechnet — richtig
   bleibt das Ergebnis in beiden Fällen, nur langsamer."
  (handler-case
      (multiple-value-bind (obj found) (gethash id *inspect-table*)
        (if (not found)
            (list :error "Objekt nicht mehr verfügbar (Panel neu öffnen)"
                  "" nil "error" nil)
            (let ((parts (or (gethash id *inspect-parts-cache*)
                             (let ((d (%inspect-describe obj)))
                               (setf (gethash id *inspect-parts-cache*)
                                     (third d))))))
              (let ((part (nth index parts)))
                (cond
                  ((null part)
                   (list :error "Teil existiert nicht mehr" "" nil "error" nil))
                  ((eq (second part) +unbound+)
                   (list :error "Slot ist nicht gebunden" "" nil "error" nil))
                  (t (let ((v (second part)))
                       (%describe-registered v (%inspect-register v)))))))))
    (error (e) (list :error (format nil "~A" e) "" nil "error" nil))))

(defun %sym-kind (sym)
  "LSP CompletionItemKind. Die Zahlen sind LSP-Konstanten; die Auswahl
   bestimmt nur, welches Icon VS Code zeigt. Makros bekommen bewusst ein
   anderes Icon als Funktionen — beim Lesen fremden CLAMPS-Codes ist der
   Unterschied wichtiger als in den meisten Sprachen."
  (cond
    ((keywordp sym) 20)                                   ; EnumMember
    ((macro-function sym) 14)                             ; Keyword
    ((and (fboundp sym)
          (typep (ignore-errors (fdefinition sym))
                 'standard-generic-function)) 2)          ; Method
    ((fboundp sym) 3)                                     ; Function
    ((find-class sym nil)
     (if (subtypep sym 'structure-object) 22 7))          ; Struct / Class
    ((constantp sym) 21)                                  ; Constant
    ((boundp sym) 6)                                      ; Variable
    (t 12)))                                              ; Value

(defun %arglist (sym)
  "Lambda-Liste als String, oder nil. sb-introspect kennt auch Makros."
  (handler-case
      (let ((f (find-symbol "FUNCTION-LAMBDA-LIST" :sb-introspect)))
        (when (and f (fboundp sym))
          (let ((ll (funcall f sym)))
            ;; Bei parameterlosen Funktionen ist die Lambda-Liste NIL;
            ;; princ-to-string macht daraus "nil", was in der Detail-
            ;; spalte wie ein Wert aussieht statt wie eine leere Liste.
            (if (null ll)
                "()"
                (let ((*print-case* :downcase) (*print-pretty* nil))
                  (princ-to-string ll))))))
    (error () nil)))

(defun %short-doc (sym)
  "Erste Zeile der Dokumentation, gekappt — die Completion-Liste ist
   kein Ort für dreißigzeilige Docstrings."
  (handler-case
      (let ((d (or (documentation sym 'function)
                   (documentation sym 'variable)
                   (documentation sym 'type))))
        (when d
          (let* ((nl (position #\Newline d))
                 (line (if nl (subseq d 0 nl) d)))
            (if (> (length line) 120) (subseq line 0 117) line))))
    (error () nil)))

(defun %split-prefix (prefix)
  "Zerlegt PREFIX in (paketname symbolteil internal-p). Paketname nil
   bedeutet: im aktuellen Paket suchen.
     \"rt-\"             -> (nil \"rt-\" nil)
     \"incudine:rt-\"    -> (\"INCUDINE\" \"rt-\" nil)
     \"incudine::rt-\"   -> (\"INCUDINE\" \"rt-\" t)
     \":foo\"            -> (\"KEYWORD\" \"foo\" nil)"
  (let ((c (position #\: prefix)))
    (cond
      ((null c) (list nil prefix nil))
      ((= c 0)  (list "KEYWORD" (string-left-trim ":" prefix) nil))
      ((and (< (1+ c) (length prefix)) (char= (char prefix (1+ c)) #\:))
       (list (string-upcase (subseq prefix 0 c)) (subseq prefix (+ c 2)) t))
      (t (list (string-upcase (subseq prefix 0 c)) (subseq prefix (1+ c)) nil)))))

(defun %prefix-match-p (name pattern)
  (and (<= (length pattern) (length name))
       (string-equal pattern name :end2 (length pattern))))

(defparameter *completion-limit* 300
  "Obergrenze für Kandidaten. Wird sie erreicht, meldet die Bridge
   isIncomplete=t und VS Code fragt beim nächsten Zeichen erneut an —
   sonst müssten wir bei leerem Präfix zehntausende Symbole schicken.")

(defun completions-for-repl (prefix package-name)
  "Symbolvervollständigung für PREFIX im Kontext von PACKAGE-NAME.

   Bewusst nicht swank:simple-completions: das liefert nur Namen. Hier
   kommen Art (Funktion/Makro/Variable/Klasse), Lambda-Liste und erste
   Doku-Zeile in einem einzigen Roundtrip mit — bei Incudine-DSP- und
   CLAMPS-Funktionen ist die Arglist beim Tippen der eigentliche Nutzen.

   Rückgabe: (:ok truncated-p ((label kind detail doc) ...))"
  (handler-case
      (destructuring-bind (pkg-part sym-part internal-p) (%split-prefix prefix)
        (let* ((home (or (find-package (string-upcase package-name))
                         (find-package :common-lisp-user)))
               (target (if pkg-part (find-package pkg-part) home))
               (seen (make-hash-table :test 'eq))
               (out '())
               (count 0)
               (truncated nil))
          (when target
            (flet ((consider (sym)
                     (unless (or (gethash sym seen)
                                 (>= count *completion-limit*))
                       (setf (gethash sym seen) t)
                       (let ((name (symbol-name sym)))
                         (when (%prefix-match-p name sym-part)
                           (incf count)
                           (push (list
                                  ;; Label mit Qualifier, falls der Nutzer
                                  ;; einen getippt hat — sonst ersetzt
                                  ;; VS Code den Paketteil nicht mit.
                                  (let ((n (string-downcase name)))
                                    (cond ((string= pkg-part "KEYWORD")
                                           (concatenate 'string ":" n))
                                          (pkg-part
                                           (concatenate 'string
                                                        (string-downcase pkg-part)
                                                        (if internal-p "::" ":") n))
                                          (t n)))
                                  (%sym-kind sym)
                                  (or (%arglist sym) "")
                                  (or (%short-doc sym) ""))
                                 out))))))
              ;; Ohne Qualifier: alles im aktuellen Paket Sichtbare.
              ;; Mit einfachem Doppelpunkt: nur externe Symbole — genau
              ;; die, die das Paket als Schnittstelle anbietet.
              (if (and pkg-part (not internal-p)
                       (not (string= pkg-part "KEYWORD")))
                  (do-external-symbols (sym target) (consider sym))
                  (do-symbols (sym target) (consider sym)))
              (when (>= count *completion-limit*) (setf truncated t))))
          (list :ok truncated
                (sort (nreverse out) #'string< :key #'first))))
    (error (e)
      (list :ok nil (list (list (format nil "; Completion-Fehler: ~A" e)
                                1 "" ""))))))

(defparameter *rt-packages* '(:incudine :clamps :incudine.util)
  "Pakete, in denen nach den RT-Funktionen gesucht wird, in dieser
   Reihenfolge. rt-status liegt in INCUDINE; CLAMPS steht mit drin,
   falls dort eigene Wrapper hinzukommen.")

(defun %rt-sym (name)
  "Erstes fbound-Symbol NAME aus *rt-packages*. Liefert (values symbol
   paketname) oder nil."
  (dolist (pkg-name *rt-packages* nil)
    (let ((pkg (find-package pkg-name)))
      (when pkg
        (let ((sym (find-symbol (string-upcase name) pkg)))
          (when (and sym (fboundp sym))
            (return (values sym (package-name pkg)))))))))

(defun %incudine (name)
  "Rückwärtskompatibler Alias — sucht inzwischen in allen *rt-packages*."
  (%rt-sym name))

(defun %rt-symbols ()
  "Alle RT-*-Symbole aus *rt-packages* — Diagnosehilfe, wenn keiner der
   erwarteten Namen greift."
  (let ((out '()))
    (dolist (pkg-name *rt-packages*)
      (let ((pkg (find-package pkg-name)))
        (when pkg
          (do-symbols (sym pkg)
            (let ((n (symbol-name sym)))
              (when (and (> (length n) 3)
                         (string= "RT-" (subseq n 0 3))
                         (fboundp sym))
                (pushnew (format nil "~A:~A"
                                 (string-downcase
                                  (package-name (symbol-package sym)))
                                 (string-downcase n))
                         out :test #'string=)))))))
    (sort out #'string<)))

(defun rt-status-for-repl ()
  "Zustand des Incudine-Realtime-Servers für die Statusleiste.

   Hintergrund: CLAMPS setzt in rts-start/rts-stop per
   slynk:eval-in-emacs ein Modeline-Label (\"DSP ✓\"). Ohne Emacs-
   Connection ist dieser Aufruf im Bootstrap ein No-op, wodurch in
   VS Code jede Anzeige fehlt, ob DSP läuft.

   Rückgabe: (:ok running-p ((schlüssel . wert) ...)), Werte als Strings."
  (handler-case
      (if (notany #'find-package *rt-packages*)
          (list :ok nil (list (cons "pakete" "weder incudine noch clamps geladen")))
          (let ((running :unbekannt)
                (info '()))

            ;; 1) rt-status — liefert typischerweise :started / :stopped
            (multiple-value-bind (sym where) (%rt-sym "RT-STATUS")
              (when sym
                (handler-case
                    (let ((v (funcall sym)))
                      (push (cons "rt-status"
                                  (format nil "~A (aus ~A)"
                                          (string-downcase (princ-to-string v))
                                          (string-downcase where)))
                            info)
                      (setf running
                            (and (member v '(:started :running :on)) t)))
                  (error () nil))))

            ;; 2) Fallback: rt-running-p (ältere/andere Versionen)
            (when (eq running :unbekannt)
              (multiple-value-bind (sym where) (%rt-sym "RT-RUNNING-P")
                (when sym
                  (handler-case
                      (progn
                        (setf running (and (funcall sym) t))
                        (push (cons "quelle"
                                    (format nil "rt-running-p aus ~A"
                                            (string-downcase where)))
                              info))
                    (error () nil)))))

            ;; 3) Nichts gefunden: nicht raten, sondern zeigen was da ist.
            (when (eq running :unbekannt)
              (setf running nil)
              (let ((syms (%rt-symbols)))
                (push (cons "hinweis"
                            (if syms
                                (format nil "kein rt-status/rt-running-p; vorhanden: ~{~A~^, ~}"
                                        (subseq syms 0 (min 8 (length syms))))
                                "keine RT-Symbole gefunden"))
                      info)))

            ;; Zusatzinfos für den Tooltip; jede einzeln abgesichert.
            (dolist (probe '(("sample-rate" . "RT-SAMPLE-RATE")
                             ("block-size"  . "BLOCK-SIZE")
                             ("client"      . "RT-CLIENT-NAME")
                             ("xruns"       . "RT-XRUNS")))
              (let ((sym (%rt-sym (cdr probe))))
                (when sym
                  (handler-case
                      (push (cons (car probe)
                                  (princ-to-string (funcall sym)))
                            info)
                    (error () nil)))))

            (list :ok running (nreverse info))))
    (error (e)
      (list :ok nil (list (cons "fehler" (princ-to-string e)))))))

(defun inspect-set-part-for-repl (id index value-string package-name)
  "Setzt Teil INDEX des Objekts ID auf das Ergebnis von VALUE-STRING.

   VALUE-STRING wird im Kontext von PACKAGE-NAME gelesen UND ausgewertet
   — man soll \"(list 1 2)\" oder \"*foo*\" eintippen können, nicht nur
   Literale. *read-eval* bleibt aus, damit #. nicht zusätzlich greift.

   Danach wird das Objekt neu beschrieben, weil sich durch das Setzen
   auch Kopfzeilen ändern können (etwa hash-table count)."
  (handler-case
      (multiple-value-bind (obj found) (gethash id *inspect-table*)
        (if (not found)
            (list :error "Objekt nicht mehr verfügbar (Panel neu öffnen)"
                  "" nil "error" nil)
            (let* ((parts (or (gethash id *inspect-parts-cache*)
                              (third (%inspect-describe obj))))
                   (part (nth index parts))
                   (setter (and part (fourth part))))
              (cond
                ((null part)
                 (list :error "Teil existiert nicht mehr" "" nil "error" nil))
                ((null setter)
                 (list :error "Dieser Teil ist nicht schreibbar"
                       "" nil "error" nil))
                (t
                 (let* ((pkg (or (find-package (string-upcase package-name))
                                 (find-package :common-lisp-user)))
                        (new (let ((*package* pkg) (*read-eval* nil))
                               (eval (read-from-string value-string)))))
                   (funcall setter new)
                   ;; Cache verwerfen: Vorschauen und Kopfzeilen sind alt.
                   (remhash id *inspect-parts-cache*)
                   (%describe-registered obj id)))))))
    (error (e) (list :error (format nil "~A" e) "" nil "error" nil))))

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

;;; Zustand der Beobachtungswerkzeuge. Bewusst HIER, vor der ersten
;;; Benutzung in traced-for-repl: nach hinten gestellt melden SBCLs
;;; Compiler beide als undefined variable, und diese Warnungen landen
;;; jetzt in clamps.log — dem Ort, an dem man einen Absturz sucht.
(defvar *clamps-function-breakpoints* (make-hash-table :test #'equal))

(defvar *rt-breakpoint-notes* nil
  "Symbole, für die ein Breakpoint im Echtzeit-Thread übersprungen wurde.")

(defun %restore-function-breakpoint (key)
  (let ((record (gethash key *clamps-function-breakpoints*)))
    (when record
      (let ((sym (getf record :symbol)) (original (getf record :original))
            (wrapper (getf record :wrapper)))
        (when (and (fboundp sym) (eq (fdefinition sym) wrapper))
          (setf (fdefinition sym) original))
        (remhash key *clamps-function-breakpoints*)))))

(defun traced-for-repl ()
  "Liste der aktuell getraceten Funktionen für den Trace-Browser.

(TRACE) ohne Argumente liefert laut Standard die getraceten Namen; das
ist portabler als in SBCLs Innereien zu greifen. Namen können auch
zusammengesetzt sein ((SETF FOO), (METHOD BAR (T))), deshalb wird
princ-to-string benutzt und nicht symbol-name.

Zusätzlich kommen die Funktions-Breakpoints mit, damit der Browser beide
Arten von Beobachtung an einer Stelle zeigt — sonst sucht man den Grund
für ein anhaltendes Image an zwei Orten."
  (handler-case
      (let ((entries nil))
        (dolist (name (eval '(trace)))
          (push (list :label (princ-to-string name)
                      :description "TRACE"
                      :tooltip "Aufrufe erscheinen in der REPL. Klick: inspizieren."
                      :icon "radio-tower"
                      :inspect (and (symbolp name) (%package-qualified name)))
                entries))
        (maphash
         (lambda (key record)
           (declare (ignore key))
           (let ((sym (getf record :symbol)))
             (let ((skipped (member sym *rt-breakpoint-notes*)))
               (push (list :label (princ-to-string sym)
                           ;; Vermerk, falls der Breakpoint im Echtzeit-
                           ;; Thread uebersprungen wurde. Ohne diesen
                           ;; Hinweis wirkt er kaputt.
                           :description (if skipped
                                            "BREAKPOINT (im RT-Thread uebersprungen)"
                                            "BREAKPOINT")
                           :tooltip (if skipped
                                        "Wurde im Incudine-Echtzeit-Thread aufgerufen und dort NICHT angehalten — ein BREAK haette den Audio-Callback blockiert."
                                        "Haelt beim Eintritt in die Funktion an.")
                           :icon (if skipped "warning" "debug-breakpoint")
                           :inspect (%package-qualified sym))
                     entries))))
         *clamps-function-breakpoints*)
        (list :ok (sort entries #'string< :key (lambda (e) (getf e :label)))))
    (error (e) (list :error (princ-to-string e)))))

(defun untrace-one-for-repl (label)
  "Nimmt genau einen Eintrag zurück — Trace oder Funktions-Breakpoint.
LABEL ist die Zeichenkette, die traced-for-repl geliefert hat."
  (handler-case
      (let ((hit nil))
        ;; Erst die Breakpoints: dort ist der Vergleich eindeutig.
        (maphash (lambda (key record)
                   (declare (ignore record))
                   (when (string-equal key label) (setf hit key)))
                 *clamps-function-breakpoints*)
        (when hit
          (%restore-function-breakpoint hit)
          (return-from untrace-one-for-repl
            (list :ok (format nil "Breakpoint entfernt: ~A" label))))
        (dolist (name (eval '(trace)))
          (when (string= (princ-to-string name) label)
            (eval `(untrace ,name))
            (return-from untrace-one-for-repl
              (list :ok (format nil "Trace aus: ~A" label)))))
        (list :error (format nil "~A ist nicht beobachtet." label)))
    (error (e) (list :error (princ-to-string e)))))

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

(defun eval-for-repl-debuggable (code-string package-name)
  "Wie eval-for-repl, aber OHNE handler-case.

   Der Unterschied ist der ganze Zweck: eval-for-repl fängt jede
   Condition ab und macht Text daraus. Swank tritt dadurch nie in seinen
   Debugger ein, und die REPL kann keinen auslösen. Diese Fassung lässt
   die Condition durch, damit Swank ein :debug-Ereignis schickt.

   Deshalb darf sie NUR über die Verbindung des Debug-Adapters gerufen
   werden — der kann das Ereignis empfangen und Restarts zurückschicken.
   Über die Bridge gerufen würde der Aufruf hängen, weil dort niemand
   antwortet.

   *debug-io* und *query-io* bleiben hier bewusst UNGEBUNDEN: über sie
   verhandelt Swank mit dem Debugger. Nur die Ausgabeströme werden
   umgeleitet."
  (let* ((pkg (or (find-package (string-upcase package-name))
                  (find-package :common-lisp-user)))
         (out (make-string-output-stream)))
    (let* ((*package* pkg)
           (*standard-output* out)
           (*error-output* out)
           (*trace-output* out)
           (values-strings '()))
      (with-input-from-string (in code-string)
        (loop
          (let ((form (read in nil :eof)))
            (when (eq form :eof) (return))
            (let ((results (multiple-value-list (eval form))))
              (setf values-strings
                    (append values-strings
                            (mapcar #'prin1-to-string results)))))))
      (let* ((printed (get-output-stream-string out))
             (value-text (format nil "~{~A~^~%~}" values-strings))
             (combined (concatenate 'string printed
                                    (if (and (> (length printed) 0)
                                             (> (length value-text) 0))
                                        (string #\Newline) "")
                                    value-text)))
        ;; *package* auslesen, nicht pkg: ein (in-package ...) im Code
        ;; hat es innerhalb dieser Bindung verändert.
        (list :ok combined (package-name *package*))))))

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


;;; ---------------------------------------------------------------------
;;; Incudine Node Browser (read-only)
;;;
;;; Liest den laufenden Node-Baum, ohne Incudine zu verändern. Die
;;; Incudine-Symbole werden erst zur Laufzeit aufgelöst, damit rpc.lisp
;;; weiterhin gegen ein nacktes SBCL ohne Incudine ladbar bleibt.
;;; ---------------------------------------------------------------------

(defparameter *node-accessors*
  '("DOGRAPH" "NODE-ID" "NODE-NAME" "GROUP" "GROUP-P"
    "CONTROL-NAMES" "CONTROL-LIST" "PAUSE-P" "DONE-P" "NODE-UPTIME")
  "Incudine-Symbole, die der Snapshot benutzt. Welche davon es in der
   installierten Version wirklich gibt, ist nicht garantiert — deshalb
   wird das gemeldet statt stillschweigend zu Lücken zu führen.")

(defun %node-accessor-report ()
  "Liste der fehlenden Accessoren, als Strings. Leer heisst: alle da.

   Nötig, weil ein fehlender Accessor sonst unsichtbar bleibt: ein
   nicht auflösbares GROUP etwa liefert für jeden Node parent=nil, und
   der Baum erscheint flach — was wie ein leeres Setup aussieht statt
   wie ein fehlendes Symbol."
  (let ((pkg (find-package :incudine))
        (missing '()))
    (when pkg
      (dolist (name *node-accessors*)
        (let ((sym (find-symbol name pkg)))
          (unless (and sym (or (fboundp sym) (macro-function sym)))
            (push (string-downcase name) missing)))))
    (nreverse missing)))

(defparameter *node-snapshot-source*
  "(let ((result '()))
     (incudine:dograph (n)
       (let* ((group-p (incudine:group-p n))
              (parent (ignore-errors (incudine:group n)))
              (names (unless group-p
                       (ignore-errors (incudine:control-names n))))
              (vals  (unless group-p
                       (ignore-errors (incudine:control-list n)))))
         (push
          (list :id (incudine:node-id n)
                :parent (and parent (ignore-errors (incudine:node-id parent)))
                :name (let ((name (ignore-errors (incudine:node-name n))))
                        (cond ((stringp name) name)
                              ((symbolp name) (if name (symbol-name name) \"\"))
                              (t (princ-to-string name))))
                :kind (if group-p :group :dsp)
                :paused (not (null (ignore-errors (incudine:pause-p n))))
                :done (and (not group-p)
                           (not (null (ignore-errors (incudine:done-p n)))))
                :uptime (if group-p
                            \"\"
                            (handler-case
                                (let* ((samples (round (incudine:node-uptime n)))
                                       (sr (ignore-errors
                                            (incudine:rt-sample-rate))))
                                  ;; Samples zusätzlich in Sekunden: die
                                  ;; reine Sample-Zahl ist beim Hinsehen
                                  ;; nicht einzuordnen.
                                  (if (and sr (> sr 0))
                                      (format nil \"~,1Fs (~D samples)\"
                                              (/ samples sr) samples)
                                      (format nil \"~D samples\" samples)))
                              (error () \"\")))
                :controls (loop for cn in names
                                for cv in vals
                                collect (list :name (if (symbolp cn)
                                                        (symbol-name cn)
                                                        (princ-to-string cn))
                                              :value (clamps-bridge-rpc::%preview cv))))
          result)))
     (nreverse result))"
  "Quelltext des Traversals als String.

   Grund für den Umweg über read-from-string: incudine:dograph ist ein
   Makro und die Symbole existieren beim Laden dieser Datei nicht
   zwingend. Beim Lesen ist *read-eval* aus, es wird also nichts zur
   Lesezeit ausgeführt; ausgewertet wird nur genau dieser feste Text.")

(defun incudine-node-tree-for-repl ()
  "Read-only Snapshot des Incudine-Node-Baums.

   Rückgabe: (:ok hinweis nodes) | (:unavailable grund nil)
             | (:error meldung nil)

   HINWEIS ZUR NEBENLÄUFIGKEIT: Der Graph wird vom Realtime-Thread
   verändert, gelesen wird hier aus einem Swank-Worker. Ein Snapshot
   während laufendem DSP kann daher einen Zwischenzustand zeigen
   (Node gerade entfernt, Controls halb gesetzt). Für eine Anzeige ist
   das hinnehmbar; die einzelnen Zugriffe sind zusätzlich in
   ignore-errors gekapselt, damit ein unter der Hand verschwundener
   Node nicht den ganzen Snapshot kippt."
  (let ((pkg (find-package :incudine)))
    (cond
      ((null pkg)
       (list :unavailable "Incudine ist nicht geladen." nil))
      ((member "DOGRAPH" (%node-accessor-report) :test #'string-equal)
       (list :unavailable
             "Diese Incudine-Version kennt kein dograph — Node-Baum nicht lesbar."
             nil))
      (t
       (handler-case
           (let* ((missing (%node-accessor-report))
                  ;; *package* festnageln: der String wird zur Laufzeit
                  ;; gelesen, und ohne diese Bindung entscheidet das Paket
                  ;; des Aufrufers, wohin unqualifizierte Symbole zeigen.
                  (nodes (let ((*read-eval* nil)
                               (*package* (find-package :clamps-bridge-rpc)))
                           (eval (read-from-string *node-snapshot-source*)))))
             (list :ok
                   (if missing
                       (format nil "Nicht verfügbar in dieser Incudine-Version: ~{~A~^, ~}"
                               missing)
                       "")
                   nodes))
         (error (e) (list :error (princ-to-string e) nil)))))))


;;; ---------------------------------------------------------------------
;;; Image-Browser für VS Code
;;; ---------------------------------------------------------------------
(defun %down (x) (let ((*print-case* :downcase)) (princ-to-string x)))

(defun packages-for-repl ()
  (handler-case
      (list :ok
            (sort
             (mapcar (lambda (p)
                       (list :label (package-name p)
                             :description (format nil "~D extern · ~D intern"
                                                  (loop for s being the external-symbols of p count s)
                                                  (loop for s being the present-symbols of p
                                                        unless (eq (nth-value 1 (find-symbol (symbol-name s) p)) :external)
                                                        count s))
                             :tooltip (format nil "Nicknames: ~{~A~^, ~}~%Uses: ~{~A~^, ~}"
                                              (package-nicknames p)
                                              (mapcar #'package-name (package-use-list p)))
                             :icon "package"
                             :inspect (format nil "(find-package ~S)" (package-name p))))
                     (list-all-packages))
             #'string-lessp :key (lambda (x) (getf x :label))))
    (error (e) (list :error (format nil "~A" e) nil))))

(defun classes-for-repl ()
  (handler-case
      (let ((seen (make-hash-table :test #'eq)) (rows nil))
        (dolist (p (list-all-packages))
          (do-symbols (s p)
            (let ((c (ignore-errors (find-class s nil))))
              (when (and c (eq (symbol-package s) p) (not (gethash c seen)))
                (setf (gethash c seen) t)
                (push (list :label (%down s)
                            :description (%down (class-of c))
                            :tooltip (or (documentation s 'type) "")
                            :icon "symbol-class"
                            :inspect (format nil "(find-class '~S)" s)) rows)))))
        (list :ok (sort rows #'string-lessp :key (lambda (x) (getf x :label)))))
    (error (e) (list :error (format nil "~A" e) nil))))

(defun threads-for-repl ()
  (handler-case
      (let* ((pkg (find-package :bordeaux-threads))
             (all (and pkg (find-symbol "ALL-THREADS" pkg)))
             (name (and pkg (find-symbol "THREAD-NAME" pkg)))
             (alive (and pkg (find-symbol "THREAD-ALIVE-P" pkg))))
        (if (and all (fboundp all))
            (list :ok
                  (loop for th in (funcall all)
                        collect (list :label (or (and name (fboundp name) (funcall name th)) (%preview th))
                                      :description (if (and alive (fboundp alive) (funcall alive th)) "alive" "stopped")
                                      :tooltip (%preview th)
                                      :icon "debug-thread"
                                      :inspect (format nil "(find ~S (bordeaux-threads:all-threads) :key #'bordeaux-threads:thread-name :test #'equal)"
                                                       (and name (fboundp name) (funcall name th))))))
            (list :error "Bordeaux-Threads ist nicht verfügbar." nil)))
    (error (e) (list :error (format nil "~A" e) nil))))


;;; ---------------------------------------------------------------------
;;; SLY/SLIME-Werkzeuge: isolierte Ergänzungen für v72
;;; ---------------------------------------------------------------------


(defun %tool-entry (label &key description detail file line character inspect offset)
  (list :label label :description (or description "") :detail (or detail "")
        :file file :line (or line 1) :character (or character 0)
        ;; Offset MIT durchreichen: SBCL liefert in Quellorten fast immer
        ;; (:position N) statt (:line N), und N ist ein Zeichen-Offset.
        ;; Ohne dieses Feld landet jeder Sprung auf Zeile 1 — derselbe
        ;; Fehler, der im Debugger schon einmal behoben wurde. Umgerechnet
        ;; wird auf der TS-Seite, die die Datei ohnehin öffnet.
        :offset offset
        :inspect inspect))

(defun %location-file-line (location)
  "Liefert (values file line character offset) aus einem Swank-Quellort.
line/character sind nur gesetzt, wenn das Backend sie ausdrücklich
liefert; sonst steht der Zeichen-Offset in offset."
  (let ((file nil) (line nil) (character nil) (offset nil))
    (labels ((walk (x)
               (when (consp x)
                 (case (car x)
                   (:file (when (stringp (second x)) (setf file (second x))))
                   (:line (when (numberp (second x)) (setf line (second x)))
                          (when (numberp (third x)) (setf character (third x))))
                   (:position (when (numberp (second x)) (setf offset (second x))))
                   (:offset
                    ;; (:offset START DELTA) — beides addiert ergibt die Stelle.
                    (when (numberp (second x))
                      (setf offset (+ (second x) (if (numberp (third x)) (third x) 0))))))
                 (dolist (e x) (walk e)))))
      (walk location))
    (values file line character offset)))

(defun %xref-type (kind)
  (cdr (assoc (string-downcase kind)
              ;; "definitions" absichtlich NICHT dabei: swank:xref kennt
              ;; den Typ nicht (Definitionen laufen ueber
              ;; find-definitions-for-emacs) und signalisiert stattdessen.
              '(("callers" . :calls)
                ("callees" . :calls-who)
                ("references" . :references)
                ("bindings" . :binds)
                ("setters" . :sets)
                ("macroexpands" . :macroexpands))
              :test #'string=)))

(defun xref-for-repl (symbol-string package-name kind)
  (handler-case
      (let* ((sym (resolve-symbol symbol-string package-name))
             (type (%xref-type kind))
             (fn (or (find-symbol "XREF" :swank)
                     (find-symbol "XREF" :swank/backend))))
        (unless (and sym type fn (fboundp fn))
          (return-from xref-for-repl (list :error "XREF wird von diesem Swank/Image nicht angeboten.")))
        (let ((raw (funcall fn type (%package-qualified sym))) (out nil))
          (dolist (entry raw)
            (let* ((name (if (consp entry) (first entry) entry))
                   (loc (and (consp entry) (second entry))))
              (multiple-value-bind (file line character offset) (%location-file-line loc)
                (push (%tool-entry (princ-to-string name)
                                   :description (string-downcase (symbol-name type))
                                   :detail (princ-to-string loc)
                                   :file file :line line :character character
                                   :offset offset
                                   :inspect (and (symbolp name) (%package-qualified name)))
                      out))))
          (list :ok (nreverse out))))
    (error (e) (list :error (princ-to-string e)))))

(defun apropos-for-repl (query package-name all-packages-p)
  (handler-case
      (let ((symbols (apropos-list query (and (not all-packages-p) (find-package package-name))))
            (out nil))
        (dolist (sym (sort (copy-list symbols) #'string< :key #'%package-qualified))
          (let ((kind (%sym-kind sym)))
            (push (%tool-entry (%package-qualified sym)
                               :description (string-downcase (symbol-name kind))
                               :detail (%short-doc sym)
                               :inspect (%package-qualified sym)) out)))
        (list :ok (nreverse out)))
    (error (e) (list :error (princ-to-string e)))))

(defun break-on-signals-for-repl (condition-names)
  "Setzt *BREAK-ON-SIGNALS*. Der Wert ist ein TYPSPEZIFIZIERER, keine Liste.

Wichtig, weil SIGNAL diese Variable bei JEDER signalisierten Condition
gegen TYPEP prüft: eine Liste (WARNING TYPE-ERROR) wird als zusammen-
gesetzter Typspezifizierer mit Kopf WARNING gelesen, der ungültig ist.
TYPEP signalisiert dann selbst — bei jedem Signal, also auch beim
Aufräumen des dadurch entstehenden Fehlers. Das Image ist danach nicht
mehr benutzbar. Mehrere Typen müssen als (OR a b) zusammengefasst werden.

Zielvariable ist CL:*BREAK-ON-SIGNALS* aus dem Standard; nur falls das
Image eine eigene Swank-Variante mitbringt, wird die bevorzugt."
  (handler-case
      (let ((var (or (let ((s (find-symbol "*BREAK-ON-SIGNALS*" :swank)))
                       (and s (boundp s) s))
                     (find-symbol "*BREAK-ON-SIGNALS*" :common-lisp))))
        (unless var
          (return-from break-on-signals-for-repl
            (list :error "*BREAK-ON-SIGNALS* ist in diesem Image nicht verfügbar.")))
        (let ((types (loop for name in condition-names
                           for sym = (or (ignore-errors (resolve-symbol name "COMMON-LISP-USER"))
                                         (find-symbol (string-upcase name) :common-lisp))
                           when sym collect sym)))
          ;; Jeden Typ einzeln prüfen, BEVOR er scharf gestellt wird —
          ;; ein Tippfehler darf nicht dazu führen, dass erst der nächste
          ;; SIGNAL das Image lahmlegt.
          (dolist (type types)
            (unless (ignore-errors (progn (typep nil type) t))
              (return-from break-on-signals-for-repl
                (list :error (format nil "~A ist kein gültiger Condition-Typ." type)))))
          (let ((spec (cond ((null types) nil)
                            ((null (cdr types)) (first types))
                            (t (cons 'or types)))))
            ;; setf symbol-value statt set: set ist gestrichen und sagt
            ;; nichts darüber, welche Bindung getroffen wird.
            (setf (symbol-value var) spec)
            (list :ok (mapcar #'%package-qualified types)))))
    (error (e) (list :error (princ-to-string e)))))

(defun %generic-function-p (sym)
  (handler-case
      (let ((gf (find-symbol "GENERIC-FUNCTION" :common-lisp)))
        (and gf (fboundp sym) (typep (fdefinition sym) gf)))
    (error () nil)))


(defun %rt-breakpoint-note (sym)
  "Im Echtzeit-Thread nur vermerken, nicht anhalten. Kein Ausgeben:
Konsolen-I/O aus dem Audio-Callback ist selbst schon eine Frist-
verletzung. Der Vermerk wird beim nächsten Abruf der Breakpoint-Liste
sichtbar."
  (pushnew sym *rt-breakpoint-notes*)
  nil)

(defun %rt-thread-p ()
  "Läuft der aktuelle Thread als Incudine-Echtzeit-Thread?

Kein Fehler, wenn Incudine gar nicht geladen ist — dann gibt es auch
keinen Echtzeit-Thread."
  (handler-case
      (let ((fn (find-symbol "RT-THREAD-P" :incudine))
            (var (find-symbol "*RT-THREAD*" :incudine)))
        (cond ((and fn (fboundp fn)) (and (funcall fn) t))
              ((and var (boundp var))
               (let ((bt (find-symbol "CURRENT-THREAD" :bordeaux-threads)))
                 (and bt (fboundp bt) (eq (funcall bt) (symbol-value var)))))
              (t nil)))
    (error () nil)))

(defun set-function-breakpoints-for-repl (names package-name)
  "Setzt Eintritts-Breakpoints für gewöhnliche Funktionen. Bestehende
Definitionen werden bewahrt und beim Entfernen exakt wiederhergestellt."
  (handler-case
      (progn
        (let ((wanted (mapcar #'string-upcase names)))
          (maphash (lambda (key value) (declare (ignore value))
                     (unless (member key wanted :test #'string=)
                       (%restore-function-breakpoint key)))
                   *clamps-function-breakpoints*)
          (let ((result nil))
            (dolist (name names)
              (let* ((sym (resolve-symbol name package-name))
                     (key (string-upcase name)))
                (cond
                  ((null sym) (push (list :name name :verified nil :message "Symbol nicht gefunden.") result))
                  ((macro-function sym) (push (list :name name :verified nil :message "Makros werden nicht gewrappt.") result))
                  ((not (fboundp sym)) (push (list :name name :verified nil :message "Keine Funktionsdefinition.") result))
                  ;; Generische Funktionen NICHT ersetzen: fdefinition
                  ;; würde die ganze GF samt Dispatch durch ein Lambda
                  ;; tauschen. Ein spätere defmethod auf dasselbe Symbol
                  ;; trifft dann ins Leere, und die Methoden sind weg.
                  ((%generic-function-p sym)
                   (push (list :name name :verified nil
                               :message "Generische Funktion — Dispatch würde verloren gehen. Stattdessen TRACE benutzen.")
                         result))
                  ((gethash key *clamps-function-breakpoints*)
                   (push (list :name name :verified t :message "Aktiv.") result))
                  (t
                   (let* ((original (fdefinition sym))
                          (wrapper (lambda (&rest args)
                                     ;; NIEMALS im Echtzeit-Thread in den
                                     ;; Debugger. Incudines Audio-Callback
                                     ;; hat eine harte Frist; ein BREAK
                                     ;; dort blockiert ihn, und mit ihm
                                     ;; das ganze Image — im besten Fall
                                     ;; hörbar als Aussetzer, im
                                     ;; schlechteren als Absturz, den
                                     ;; hinterher niemand zuordnen kann.
                                     (if (%rt-thread-p)
                                         (%rt-breakpoint-note sym)
                                         (break "Funktions-Breakpoint: ~A~%Argumente: ~S" sym args))
                                     (apply original args))))
                     (setf (fdefinition sym) wrapper)
                     (setf (gethash key *clamps-function-breakpoints*)
                           (list :symbol sym :original original :wrapper wrapper))
                     (push (list :name name :verified t :message "Aktiv.") result))))))
            (list :ok (nreverse result)))))
    (error (e) (list :error (princ-to-string e)))))

