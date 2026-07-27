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
           #:set-function-breakpoints-for-repl
           #:indentation-rules-for-repl #:presentation-value
           #:asdf-operation-for-repl #:sticker-record-for-repl
           #:make-sticker-state-for-repl #:make-sticker-sample-state-for-repl
           #:register-sticker-state-for-repl
           #:sticker-state-record-for-repl #:sticker-state-record-sample-for-repl
           #:sticker-state-record-rms-for-repl
           #:sticker-samples-since-for-repl #:sticker-keys-for-repl
           #:sticker-snapshot-for-repl #:sticker-clear-for-repl))
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
(defvar *inspect-ids* (make-hash-table :test 'eq)
  "Objekt -> id, die Umkehrung von *INSPECT-TABLE*.

   Ohne diese Tabelle bekam DASSELBE Objekt bei jedem Betreten eine neue
   Nummer. Der Client erkennt Zyklen daran, dass die ID eines
   Unterobjekts schon in der Kette der Vorfahren steht — das konnte so
   nie zutreffen, die Zyklenerkennung war wirkungslos und eine
   selbstbezügliche Struktur klappte stumpf bis zur Tiefengrenze durch.

   Test ist EQ, also Identität: zwei gleich aussehende Listen sind zwei
   Objekte und bekommen zu Recht zwei Nummern.")
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
  "Legt OBJ ab und liefert dessen ID.

   Ist OBJ schon bekannt, kommt die BESTEHENDE ID zurück — nur so kann
   der Client erkennen, dass er im Kreis läuft. Der Eintrag rutscht
   dabei in der Räumungsreihenfolge wieder nach vorn: was gerade
   angeschaut wird, soll nicht als Ältestes hinausfliegen."
  (let ((known (gethash obj *inspect-ids*)))
    (when known
      (setf *inspect-order* (cons known (remove known *inspect-order*)))
      (return-from %inspect-register known)))
  (let ((id (incf *inspect-counter*)))
    (setf (gethash id *inspect-table*) obj)
    (setf (gethash obj *inspect-ids*) id)
    (push id *inspect-order*)
    (when (> (hash-table-count *inspect-table*) *inspect-capacity*)
      (let ((keep (subseq *inspect-order* 0 *inspect-capacity*)))
        (dolist (old (nthcdr *inspect-capacity* *inspect-order*))
          (multiple-value-bind (victim found) (gethash old *inspect-table*)
            ;; Umkehrtabelle mitziehen, sonst zeigt sie auf geräumte IDs
            ;; und inspect-part-for-repl meldet "nicht mehr verfügbar"
            ;; für ein Objekt, das gerade neu registriert wurde.
            (when (and found (eql (gethash victim *inspect-ids*) old))
              (remhash victim *inspect-ids*)))
          (remhash old *inspect-table*)
          (remhash old *inspect-parts-cache*))
        (setf *inspect-order* keep)))
    id))

(defun inspect-release-for-repl ()
  "Gibt alle gehaltenen Objekte frei. Der Client ruft das beim Schließen
   des Inspector-Panels.

   *INSPECT-IDS* MUSS mit: die Umkehrtabelle hält die Objekte selbst als
   Schlüssel, hier stehen also starke Referenzen auf alles, was je
   angeschaut wurde — genau das, was Freigeben verhindern soll. Und
   funktional noch schlimmer: bliebe sie stehen, käme beim erneuten
   Inspizieren desselben Objekts die alte ID zurück, zu der es in
   *INSPECT-TABLE* keinen Eintrag mehr gibt. Der nächste Klick meldete
   dann 'Objekt nicht mehr verfügbar' für ein frisch geöffnetes Panel."
  (clrhash *inspect-table*)
  (clrhash *inspect-parts-cache*)
  (clrhash *inspect-ids*)
  (setf *inspect-order* '())
  (list :ok))

(defun %inspect-expandable-p (val)
  "Hat VAL selbst Teile, lohnt sich also ein Aufklapp-Pfeil?

   Der Client kann das nicht wissen: er sieht nur Label und Vorschau und
   müsste jeden Teil laden, um es herauszufinden. Ohne diese Auskunft
   bekommt JEDE gebundene Zeile einen Pfeil — auch Fixnums und Strings,
   die aufgeklappt nur 'Keine navigierbaren Teile' zeigen.

   Bewusst ein billiger Typtest und kein Aufruf von %inspect-describe:
   die Vorhersage steht neben jedem der bis zu 1000 Teile, ein echtes
   Beschreiben wäre genau die Rechenlast, die der Teile-Cache vermeidet.
   Die Zweige spiegeln %inspect-describe; bei Grenzfällen (Symbol ohne
   Wert und ohne Funktion) darf ein Pfeil ins Leere führen, das ist
   harmloser als ein fehlender Pfeil an einem betretbaren Objekt."
  (when (eq val +unbound+)
    (return-from %inspect-expandable-p nil))
  (typecase val
    (null nil)
    ((or number character string package random-state) nil)
    (hash-table (plusp (hash-table-count val)))
    (pathname t)                        ; directory-Teil
    (cons t)
    ((and vector (not string)) (plusp (length val)))
    (array (plusp (array-total-size val)))
    ((or standard-object structure-object) t)
    (symbol t)
    (function t)
    (t nil)))

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
            ;; (label index preview navigierbar-p schreibbar-p aufklappbar-p)
            (loop for p in parts
                  for i from 0
                  collect (list (first p) i (or (third p) "")
                                (if (eq (second p) +unbound+) nil t)
                                (if (fourth p) t nil)
                                (if (%inspect-expandable-p (second p)) t nil)))
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

(defun %sym-kind-label (kind)
  "Lesbarer Name zu einer LSP-CompletionItemKind-Zahl.
Gebraucht von APROPOS-FOR-REPL: dort stand (symbol-name (%sym-kind sym)),
und %SYM-KIND liefert eine ZAHL. APROPOS lieferte deshalb immer nur
(:error \"The value 3 is not of type SYMBOL\")."
  (case kind
    (2 "method")
    (3 "function")
    (6 "variable")
    (7 "class")
    (12 "value")
    (14 "macro")
    (20 "keyword")
    (21 "constant")
    (22 "struct")
    (t (format nil "kind-~A" kind))))

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

(defun completions-for-repl (prefix package-name &optional context)
  "Symbolvervollständigung für PREFIX im Kontext von PACKAGE-NAME.

   CONTEXT wird hier NICHT ausgewertet, muss aber angenommen werden:
   handle-completion in bridge-server.lisp schickt grundsätzlich drei
   Argumente, weil completion.lisp den Quelltext vor dem Cursor für
   lokale Bindungen und Kopfposition braucht. Ohne dieses &optional
   scheiterte JEDER Vervollständigungsversuch mit \"invalid number of
   arguments: 3\", sobald completion.lisp nicht geladen war — und damit
   war der angebliche Rückfall auf die Basis-Completion keiner: es kamen
   überhaupt keine Vorschläge mehr. Die Signaturen der Basis- und der
   Erweiterungsfassung müssen deckungsgleich bleiben.

   Bewusst nicht swank:simple-completions: das liefert nur Namen. Hier
   kommen Art (Funktion/Makro/Variable/Klasse), Lambda-Liste und erste
   Doku-Zeile in einem einzigen Roundtrip mit — bei Incudine-DSP- und
   CLAMPS-Funktionen ist die Arglist beim Tippen der eigentliche Nutzen.

   Rückgabe: (:ok truncated-p ((label kind detail doc) ...))"
  (declare (ignore context))
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
                           ;; Reader-Rückfall nur für Namen mit
                           ;; Maskierung (|foo bar|, a\.b): genau die
                           ;; kann die find-symbol-Schleife oben nicht
                           ;; finden, weil sie stumpf upcased.
                           ;;
                           ;; Für alles andere wäre er schädlich, denn
                           ;; READ-FROM-STRING INTERNIERT: ein Tippfehler
                           ;; in der XREF-Eingabe legte bisher ein neues
                           ;; Symbol im Paket an und lieferte es zurück,
                           ;; als wäre es gefunden worden. Das Paket
                           ;; verschmutzte bei jedem Vertipper, und der
                           ;; Aufrufer bekam :ok mit leerer Trefferliste
                           ;; statt "Symbol nicht gefunden".
                           (and (not (find #\: symbol-string))
                                (or (find #\| symbol-string)
                                    (find #\\ symbol-string))
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



;;; ---------------------------------------------------------------------
;;; Additive tooling shared by the richer VS Code front-end.
;;; ---------------------------------------------------------------------

(defvar *presentation-table* (make-hash-table :test 'eql)
  "Presentation-ID -> live Lisp object. Kept separate from the Inspector table.")
(defvar *presentation-ids* (make-hash-table :test 'eq)
  "Live Lisp object -> Presentation-ID, for stable identity.")
(defvar *presentation-history* '())
(defvar *presentation-counter* 0)
(defparameter *presentation-capacity* 200)

(defun %presentation-register (value)
  "Keep VALUE in a presentation-specific bounded registry and return its stable id.

The presentation registry is deliberately independent from the Inspector registry:
closing an Inspector panel may release its navigation cache, but must not invalidate
REPL results that are still visible and reusable."
  (let ((known (gethash value *presentation-ids*)))
    (when known
      (setf *presentation-history* (cons known (remove known *presentation-history*)))
      (return-from %presentation-register known)))
  (let ((id (incf *presentation-counter*)))
    (setf (gethash id *presentation-table*) value
          (gethash value *presentation-ids*) id)
    (push id *presentation-history*)
    (when (> (length *presentation-history*) *presentation-capacity*)
      (dolist (old (nthcdr *presentation-capacity* *presentation-history*))
        (multiple-value-bind (victim found) (gethash old *presentation-table*)
          (when (and found (eql (gethash victim *presentation-ids*) old))
            (remhash victim *presentation-ids*)))
        (remhash old *presentation-table*))
      (setf *presentation-history*
            (subseq *presentation-history* 0 *presentation-capacity*)))
    id))

(defun %presentation-type-label (value)
  "Kurzes, lesbares Typ-Etikett fuer die REPL-Zeile.

Nicht type-of: das liefert bei Zahlen und Sequenzen den exakten
Typspezifizierer statt eines Namens — 2 wird zu
\"(integer 0 4611686018427387903)\", \"abc\" zu \"(simple-array character
(3))\", #(1 2) zu \"(simple-vector 2)\". In der Zeile
\"[#4 (integer 0 4611686018427387903)] ,inspect 4\" ist das unbrauchbar.
class-of gibt den Klassennamen, also fixnum bzw. simple-vector.

Fuer die seltenen Faelle ohne Klassennamen (anonyme Klassen) bleibt
type-of der Rueckfall — ein Etikett ist besser als keins."
  (let ((*print-case* :downcase)
        (*print-pretty* nil))
    (or (ignore-errors
          (let ((name (class-name (class-of value))))
            (and (symbolp name) (princ-to-string name))))
        (ignore-errors (princ-to-string (type-of value)))
        "t")))

(defun presentation-value (id)
  "Return a live REPL result by id. Intended for explicit user actions only."
  (multiple-value-bind (value found) (gethash id *presentation-table*)
    (if found value (error "Presentation ~D ist nicht mehr verfuegbar (Registry haelt die letzten ~D Ergebnisse)."
                   id *presentation-capacity*))))

(defun indentation-rules-for-repl ()
  "Return image-known macro indentation rules without requiring Swank internals.
The front-end merges these with conservative Common Lisp defaults."
  (let ((rules '()))
    (do-all-symbols (symbol)
      (when (macro-function symbol)
        (let* ((name (string-downcase (symbol-name symbol)))
               (pkg (symbol-package symbol))
               (qualified (and pkg (format nil "~A::~A"
                                           (string-downcase (package-name pkg)) name))))
          ;; Unknown macros default to one distinguished argument. This is
          ;; deliberately conservative; user/source declarations can override it.
          (push (list (or qualified name) 1) rules))))
    (list :ok (remove-duplicates rules :key #'first :test #'string=))))

(defun asdf-operation-for-repl (operation system)
  "Run a small, whitelisted ASDF operation.

ASDF symbols are resolved only after REQUIRE has loaded the package.  This
keeps RPC.LISP readable and compilable in a fresh Lisp image where ASDF does
not yet exist."
  (handler-case
      (progn
        (require :asdf)
        (let* ((asdf-package (or (find-package "ASDF")
                                 (error "ASDF was required but its package is unavailable")))
               (operate-symbol (or (find-symbol "OPERATE" asdf-package)
                                   (error "ASDF:OPERATE is unavailable")))
               (operation-name (ecase operation
                                 (:load "LOAD-OP")
                                 (:compile "COMPILE-OP")
                                 (:test "TEST-OP")))
               (operation-symbol (or (find-symbol operation-name asdf-package)
                                     (error "ASDF operation ~A is unavailable"
                                            operation-name))))
          (funcall operate-symbol operation-symbol system)
          (list :ok (format nil "~(~A~) completed for ~A" operation system))))
    (error (e) (list :error (format nil "~A" e)))))

(defvar *sticker-records* (make-hash-table :test 'equal))
(defparameter *sticker-capacity* 256)

;; Realtime stickers use an explicitly allocated state object.  The DSP hot
;; path only writes into a preallocated array and updates fixnum indices.  It
;; performs no consing, printing, hash lookup, clock access or inspector
;; registration.  Registration and presentation happen on the control/REPL
;; side.
;;
;; Two storage layouts exist because they have different allocation
;; behaviour:
;;
;;   :element-type t             VALUES is a SIMPLE-VECTOR.  Storing a
;;                               double-float into it boxes the float, i.e.
;;                               it allocates.  Fine for control-thread and
;;                               fixnum/symbol use, not for a DSP hot path.
;;
;;   :element-type 'double-float SAMPLES is a specialised
;;                               (SIMPLE-ARRAY DOUBLE-FLOAT (*)).  The store
;;                               is unboxed and allocates nothing.  This is
;;                               the layout for dsp! bodies.
;;
;; The unused array is allocated with length 0 so that both slots stay
;; monomorphic and the hot path needs no type dispatch.
;;
;; DECIMATION exists so that the caller never has to write a conditional in
;; the DSP body.  A form like
;;
;;   (when (zerop counter) (sticker-state-record-sample-for-repl s in))
;;
;; is not merely inelegant: it changes what the Incudine VUG compiler
;; produces.  The update code of a VUG variable is emitted at its first
;; textual reference, so putting that first reference inside WHEN moves the
;; oscillator update into the branch and the variable is only advanced when
;; the branch is taken.  Recording every 441st sample then turns a 330 Hz
;; sine into a 100 Hz sample-and-hold staircase — an audible pulse.  Calling
;; the recorder unconditionally and letting it drop samples internally keeps
;; the reference unconditional and the audio intact.
(defstruct (sticker-state
             (:constructor %make-sticker-state
                 (values samples capacity element-type decimation
                         window-scale)))
  (values #() :type simple-vector)
  (samples (make-array 0 :element-type 'double-float)
   :type (simple-array double-float (*)))
  (capacity 0 :type fixnum)
  (element-type t :type symbol)
  (decimation 1 :type fixnum)
  (phase 0 :type fixnum)
  ;; Aggregating recorders sum into ACCUMULATOR over one decimation window
  ;; and store once at its end.  WINDOW-SCALE is 1/DECIMATION, precomputed so
  ;; the hot path needs no division and no fixnum-to-float conversion.
  (accumulator 0.0d0 :type double-float)
  (window-scale 1.0d0 :type double-float)
  (write-index 0 :type fixnum)
  (count 0 :type fixnum)
  (sequence 0 :type fixnum))

(defun make-sticker-state-for-repl (&optional (capacity *sticker-capacity*)
                                    &key (element-type t) (decimation 1))
  "Allocate a bounded sticker ring once, outside the realtime thread.

ELEMENT-TYPE is T (any value, boxed) or DOUBLE-FLOAT (unboxed samples).
DECIMATION N keeps every Nth recorded value and discards the rest, so the
DSP body can call the recorder unconditionally."
  (check-type capacity (and fixnum (integer 1)))
  (check-type decimation (and fixnum (integer 1)))
  (unless (member element-type '(t double-float))
    (error "sticker element-type muss T oder DOUBLE-FLOAT sein, nicht ~S."
           element-type))
  (let ((double-p (eq element-type 'double-float)))
    (%make-sticker-state
     (make-array (if double-p 0 capacity) :initial-element nil)
     (make-array (if double-p capacity 0)
                 :element-type 'double-float
                 :initial-element 0.0d0)
     capacity element-type decimation
     (/ 1.0d0 (float decimation 1.0d0)))))

(defun make-sticker-sample-state-for-repl
    (&optional (capacity *sticker-capacity*) (decimation 1))
  "Convenience constructor for the unboxed DSP layout."
  (make-sticker-state-for-repl capacity
                               :element-type 'double-float
                               :decimation decimation))

(defun register-sticker-state-for-repl (key state)
  "Expose preallocated STATE under KEY for later REPL snapshots.
Call this before starting DSP processing."
  (check-type key string)
  (check-type state sticker-state)
  (setf (gethash key *sticker-records*) state)
  state)

(declaim (inline %sticker-state-advance))
(defun %sticker-state-advance (state)
  "Advance ring indices after a store.  Fixnum arithmetic only."
  (declare (type sticker-state state)
           (optimize (speed 3) (safety 0) (debug 0)))
  (let ((index (sticker-state-write-index state))
        (capacity (sticker-state-capacity state)))
    (declare (type fixnum index capacity))
    (setf (sticker-state-write-index state)
          (let ((next (the fixnum (1+ index))))
            (if (= next capacity) 0 next)))
    (when (< (sticker-state-count state) capacity)
      (setf (sticker-state-count state)
            (the fixnum (1+ (sticker-state-count state)))))
    ;; Sequence is diagnostic only.  Wrap before fixnum overflow rather than
    ;; promoting to a bignum, which would allocate.
    (setf (sticker-state-sequence state)
          (if (= (sticker-state-sequence state) most-positive-fixnum)
              0
              (the fixnum (1+ (sticker-state-sequence state)))))
    (values)))

(declaim (inline %sticker-state-due-p))
(defun %sticker-state-due-p (state)
  "True when this call falls on a kept phase.  Always advances the phase."
  (declare (type sticker-state state)
           (optimize (speed 3) (safety 0) (debug 0)))
  (let ((phase (sticker-state-phase state)))
    (declare (type fixnum phase))
    (setf (sticker-state-phase state)
          (let ((next (the fixnum (1+ phase))))
            (if (>= next (sticker-state-decimation state)) 0 next)))
    (= phase 0)))

(declaim (inline %sticker-state-store-sample))
(defun %sticker-state-store-sample (state value)
  "Write VALUE into the unboxed ring and advance.  Allocates nothing."
  (declare (type sticker-state state)
           (type double-float value)
           (optimize (speed 3) (safety 0) (debug 0)))
  (setf (aref (sticker-state-samples state)
              (sticker-state-write-index state))
        value)
  (%sticker-state-advance state)
  (values))

(declaim (inline sticker-state-record-sample-for-repl))
(defun sticker-state-record-sample-for-repl (state value)
  "Store sample VALUE in preallocated STATE and return VALUE.

This is the dsp!-safe path: it allocates nothing.  STATE must have been made
with :ELEMENT-TYPE 'DOUBLE-FLOAT.  Call it unconditionally on every sample;
use the state's DECIMATION to thin the recording out."
  (declare (type sticker-state state)
           (type double-float value)
           (optimize (speed 3) (safety 0) (debug 0)))
  (when (%sticker-state-due-p state)
    (%sticker-state-store-sample state value))
  value)

(declaim (inline sticker-state-record-rms-for-repl))
(defun sticker-state-record-rms-for-repl (state value)
  "Accumulate VALUE and store one RMS figure per decimation window.

STICKER-STATE-RECORD-SAMPLE-FOR-REPL keeps one instantaneous sample per
window and throws the rest away.  For a periodic signal that is aliasing,
not metering: at 330 Hz with a window of 441 the kept samples land on ten
fixed phase points and say nothing about level, and at 300 Hz they would all
land on the same phase and read as a constant.

This recorder squares every sample, so no sample is discarded, and writes
sqrt(mean(x^2)) over the window.  It is the dsp!-safe path and allocates
nothing.  Call it unconditionally on every sample; STATE must have been made
with :ELEMENT-TYPE 'DOUBLE-FLOAT.

Unlike the sample path this stores at the *end* of a window, so the first
value appears after DECIMATION calls rather than on the first one."
  (declare (type sticker-state state)
           (type double-float value)
           (optimize (speed 3) (safety 0) (debug 0)))
  (let ((sum (+ (sticker-state-accumulator state)
                (* value value)))
        (phase (the fixnum (1+ (sticker-state-phase state))))
        (window (sticker-state-decimation state)))
    (declare (type double-float sum)
             (type fixnum phase window))
    (cond ((>= phase window)
           (%sticker-state-store-sample
            state
            (sqrt (* sum (sticker-state-window-scale state))))
           (setf (sticker-state-accumulator state) 0.0d0
                 (sticker-state-phase state) 0))
          (t
           (setf (sticker-state-accumulator state) sum
                 (sticker-state-phase state) phase))))
  value)

(declaim (inline sticker-state-record-for-repl))
(defun sticker-state-record-for-repl (state value)
  "Store VALUE in preallocated STATE and return VALUE.

General path for arbitrary values.  Storing a float here boxes it, so for
dsp! bodies use STICKER-STATE-RECORD-SAMPLE-FOR-REPL instead."
  (declare (type sticker-state state)
           (optimize (speed 3) (safety 0) (debug 0)))
  (when (%sticker-state-due-p state)
    (if (eq (sticker-state-element-type state) 'double-float)
        (setf (aref (sticker-state-samples state)
                    (sticker-state-write-index state))
              (float value 1.0d0))
        (setf (svref (sticker-state-values state)
                     (sticker-state-write-index state))
              value))
    (%sticker-state-advance state))
  value)

(defun sticker-record-for-repl (key value)
  "Legacy control-thread sticker.  This allocates and is not DSP-safe."
  (let ((items (gethash key *sticker-records*)))
    (when (typep items 'sticker-state)
      (return-from sticker-record-for-repl
        (sticker-state-record-for-repl items value)))
    (push (list (get-universal-time) (%inspect-register value) (prin1-to-string value)) items)
    (when (> (length items) *sticker-capacity*)
      (setf items (subseq items 0 *sticker-capacity*)))
    (setf (gethash key *sticker-records*) items))
  value)

(defun %sticker-state-values-oldest-first (state)
  "Copy live ring entries for control-thread presentation."
  (let* ((count (sticker-state-count state))
         (capacity (sticker-state-capacity state))
         (write-index (sticker-state-write-index state))
         (double-p (eq (sticker-state-element-type state) 'double-float))
         (start (if (= count capacity) write-index 0)))
    (loop for offset below count
          for index = (mod (+ start offset) capacity)
          collect (if double-p
                      (aref (sticker-state-samples state) index)
                      (svref (sticker-state-values state) index)))))

(defun %sticker-state-tail (state n)
  "Die N juengsten Werte des Rings, aeltester zuerst."
  (let* ((count (sticker-state-count state))
         (n (max 0 (min n count)))
         (capacity (sticker-state-capacity state))
         (double-p (eq (sticker-state-element-type state) 'double-float))
         (start (mod (- (sticker-state-write-index state) n) capacity)))
    (loop for offset below n
          for index = (mod (+ start offset) capacity)
          collect (if double-p
                      (aref (sticker-state-samples state) index)
                      (svref (sticker-state-values state) index)))))

(defun %finite-sample (value)
  "NaN und Unendlich auf 0 abbilden.

Der JSON-Schreiber der Bridge gibt Fliesskommazahlen mit ~F aus; ein NaN
oder eine Unendlichkeit erzeugt dort ungueltiges JSON und legt die
Verbindung lahm.  Genau diese Werte entstehen aber, wenn eine Rueckkopplung
im DSP hochlaeuft — also gerade in dem Moment, in dem man auf den Pegel
schaut."
  (handler-case
      (let ((x (float value 1.0d0)))
        (if (and (= x x) (< (abs x) 1.0d38)) x 0.0d0))
    (error () 0.0d0)))

(defun sticker-samples-since-for-repl (key since &optional (limit 4096))
  "Neue Werte eines registrierten Rings seit Sequenznummer SINCE.

Rueckgabe: (:ok SEQUENCE DROPPED VALUES).  SEQUENCE ist der neue Stand,
den der Aufrufer beim naechsten Mal mitschickt.  DROPPED sagt, wie viele
Werte zwischen zwei Abfragen aus dem Ring gefallen sind — die Anzeige darf
das nicht als Luecke verschweigen, sonst sieht ein ueberlaufener Ring aus
wie ein lueckenloser Verlauf.

Ohne dieses Verfahren muesste bei jeder Abfrage der ganze Ring uebertragen
werden.  Bei 256 Werten ist das egal, bei einem Spektrogramm mit 30
Abfragen pro Sekunde nicht."
  (let ((state (gethash key *sticker-records*)))
    (if (not (typep state 'sticker-state))
        (list :ok 0 0 nil)
        (let* ((sequence (sticker-state-sequence state))
               (count (sticker-state-count state))
               ;; SINCE > SEQUENCE heisst: der Ring wurde neu angelegt oder
               ;; die Sequenz ist uebergelaufen.  Dann alles Vorhandene neu
               ;; schicken statt eine negative Differenz zu rechnen.
               (pending (if (> since sequence) count (- sequence since)))
               (available (min pending count))
               (take (min available limit))
               (dropped (- pending take)))
          (list :ok sequence dropped
                (mapcar #'%finite-sample (%sticker-state-tail state take)))))))

(defun sticker-keys-for-repl ()
  "Registrierte Ringe mit ihren Kenndaten, ohne die Werte selbst."
  (list :ok
        (loop for key being the hash-keys of *sticker-records* using (hash-value state)
              when (typep state 'sticker-state)
                collect (list key
                              (sticker-state-capacity state)
                              (sticker-state-decimation state)
                              (string-downcase (symbol-name (sticker-state-element-type state)))
                              (sticker-state-sequence state)))))

(defun sticker-snapshot-for-repl ()
  (list :ok
        (loop for key being the hash-keys of *sticker-records* using (hash-value records)
              collect
              (list key
                    (if (typep records 'sticker-state)
                        (loop for value in (%sticker-state-values-oldest-first records)
                              for n from 1
                              collect (list n (%inspect-register value)
                                            (prin1-to-string value)))
                        (reverse records))))))

(defun sticker-clear-for-repl ()
  (loop for records being the hash-values of *sticker-records*
        when (typep records 'sticker-state)
          do (fill (sticker-state-values records) nil)
             (fill (sticker-state-samples records) 0.0d0)
             (setf (sticker-state-write-index records) 0
                   (sticker-state-count records) 0
                   (sticker-state-phase records) 0
                   (sticker-state-accumulator records) 0.0d0
                   (sticker-state-sequence records) 0))
  (clrhash *sticker-records*)
  (list :ok))

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
           (values-strings '())
           (presentations '()))
      (with-input-from-string (in code-string)
        (loop
          (let ((form (read in nil :eof)))
            (when (eq form :eof) (return))
            (let ((results (multiple-value-list (eval form))))
              (setf values-strings
                    (append values-strings
                            (mapcar #'prin1-to-string results)))
              (setf presentations
                    (append presentations
                            (mapcar (lambda (v)
                                      (list (%presentation-register v)
                                            (prin1-to-string v)
                                            (%presentation-type-label v)))
                                    results)))))))
      (let* ((printed (get-output-stream-string out))
             (value-text (format nil "~{~A~^~%~}" values-strings))
             (combined (concatenate 'string printed
                                    (if (and (> (length printed) 0)
                                             (> (length value-text) 0))
                                        (string #\Newline) "")
                                    value-text)))
        ;; *package* auslesen, nicht pkg: ein (in-package ...) im Code
        ;; hat es innerhalb dieser Bindung verändert.
        (list :ok combined (package-name *package*) presentations)))))

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
               (values-strings '())
               (presentations '()))
          ;; Mehrere Forms nacheinander lesen und auswerten, damit eine
          ;; REPL-Zeile wie "(defparameter *x* 1) *x*" komplett läuft.
          (with-input-from-string (in code-string)
            (loop
              (let ((form (read in nil :eof)))
                (when (eq form :eof) (return))
                (let ((results (multiple-value-list (eval form))))
                  (setf values-strings
                        (append values-strings
                                (mapcar (lambda (v) (prin1-to-string v)) results)))
                  (setf presentations
                        (append presentations
                                (mapcar (lambda (v)
                                          (list (%presentation-register v)
                                                (prin1-to-string v)
                                                (%presentation-type-label v)))
                                        results)))))))
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
            (list :ok combined current-pkg-name presentations)))
      (error (e)
        (let ((printed (get-output-stream-string out)))
          ;; Vierter Wert NIL: derselbe Vertrag wie im Erfolgszweig.
          ;; Vorher war der Fehlerzweig dreistellig, der Erfolgszweig
          ;; vierstellig — jeder Aufrufer musste das selbst abfangen.
          (list :error
                (concatenate 'string printed
                             (if (> (length printed) 0) (string #\Newline) "")
                             (format nil "~A" e))
                (package-name pkg)
                nil))))))


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
        :file file
        ;; line bewusst NICHT auf 1 vorbelegen. Der Client bevorzugt eine
        ;; vorhandene Zeile vor dem Offset; eine erfundene 1 hat den
        ;; Offset daneben nutzlos gemacht und jeden Treffer an den
        ;; Dateianfang geschickt — genau der Fehler, der behoben sein
        ;; sollte. NIL heißt: "keine Zeile bekannt, nimm den Offset".
        :line line :character (or character 0)
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

(defun %swank-symbol (name package-designator)
  "FIND-SYMBOL, aber NIL statt Fehler, wenn es das Paket nicht gibt.
Ein Image ohne geladenes Swank soll die vorgesehene Meldung bekommen
und keinen Paket-Typfehler."
  (let ((pkg (find-package package-designator)))
    (and pkg (find-symbol name pkg))))

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

(defun %xref-inspect-expr (name pkg)
  "Ausdruck, mit dem der Client den XREF-Treffer inspizieren kann.

NAME ist meist ein String (\"cl-user::bar\"), bei manchen Backends auch
ein Symbol oder ein Setf-Name (setf foo). Nur einfache Symbole ergeben
etwas Inspizierbares; alles andere liefert NIL, damit der Client ehrlich
'keine Quelldatei verfügbar' meldet statt auf einen kaputten Ausdruck
zu springen."
  (handler-case
      (let ((sym (cond ((symbolp name) name)
                       ((stringp name) (resolve-symbol name pkg))
                       (t nil))))
        (and sym (symbolp sym) (%package-qualified sym)))
    (error () nil)))

(defun %definition-xref-entries (symbol-string package-name)
  "Wandelt FIND-DEFINITIONS-FOR-REPL in dasselbe Tool-Entry-Format wie XREF um."
  (let ((result (find-definitions-for-repl symbol-string package-name))
        (out nil))
    (unless (and (consp result) (eq (first result) :ok))
      (return-from %definition-xref-entries result))
    (dolist (entry (second result))
      (destructuring-bind (file line character label) entry
        (push (%tool-entry label
                           :description "definition"
                           :detail (if file file "Quelldatei nicht verfügbar")
                           :file file
                           ;; find-definitions-for-repl liefert bereits
                           ;; nullbasierte LSP-Zeilen; ToolEntry erwartet
                           ;; dagegen eine einsbasierte Zeile.
                           :line (and file (1+ line))
                           :character character)
              out)))
    (list :ok (nreverse out))))

(defun xref-for-repl (symbol-string package-name kind)
  "Vollständige SLIME-XREF-Abfrage einschließlich Definitionen.

KIND ist einer von definitions, callers, callees, references, bindings,
setters oder macroexpands. Die Rückgabe ist (:ok TOOL-ENTRIES) bzw.
(:error TEXT)."
  (handler-case
      (when (string-equal kind "definitions")
        (return-from xref-for-repl
          (%definition-xref-entries symbol-string package-name)))
    (error (e) (return-from xref-for-repl (list :error (princ-to-string e)))))
  (handler-case
      (let* ((pkg (or (find-package (string-upcase package-name))
                      (find-package :common-lisp-user)))
             ;; resolve-symbol bindet *PACKAGE* an dieses Argument. SBCL
             ;; deklariert *PACKAGE* als Typ PACKAGE, ein String löst dort
             ;; einen Typfehler aus, den resolve-symbol still zu NIL
             ;; verschluckt. Ergebnis war: jede XREF-Art außer
             ;; "definitions" meldete "Symbol nicht gefunden", swank:xref
             ;; wurde nie aufgerufen. Deshalb hier ein Paket-OBJEKT, wie
             ;; an allen anderen Aufrufstellen auch.
             (sym (resolve-symbol symbol-string pkg))
             (type (%xref-type kind))
             ;; find-symbol signalisiert, wenn das Paket fehlt — dann käme
             ;; ein Typfehler statt der vorgesehenen Meldung heraus.
             (fn (or (%swank-symbol "XREF" :swank)
                     (%swank-symbol "XREF" :swank/backend))))
        (unless sym
          (return-from xref-for-repl
            (list :error (format nil "Symbol ~A wurde im Paket ~A nicht gefunden."
                                 symbol-string package-name))))
        (unless type
          (return-from xref-for-repl
            (list :error (format nil "Unbekannte XREF-Art: ~A" kind))))
        (unless (and fn (fboundp fn))
          (return-from xref-for-repl
            (list :error "XREF wird von diesem Swank/Image nicht angeboten.")))
        (let ((raw (funcall fn type (%package-qualified sym))) (out nil))
          (dolist (entry raw)
            (let* ((name (if (consp entry) (first entry) entry))
                   (loc (and (consp entry) (second entry))))
              (multiple-value-bind (file line character offset) (%location-file-line loc)
                ;; Swank kann logische Pathnames oder nicht existierende
                ;; Build-Pfade liefern. Dieselbe Auflösung wie M-. nutzen.
                (let ((resolved (and file (%resolve-source-file file))))
                  (push (%tool-entry (princ-to-string name)
                                     :description (string-downcase (symbol-name type))
                                     :detail (princ-to-string loc)
                                     :file resolved :line line :character character
                                     :offset offset
                                     ;; swank:xref schickt den Namen durch
                                     ;; xref>elisp, es kommt also ein
                                     ;; STRING an — die alte symbolp-Probe
                                     ;; war immer falsch und der
                                     ;; Inspect-Rückfallweg damit tot.
                                     :inspect (%xref-inspect-expr name pkg))
                        out)))))
          ;; Doppelte Treffer derselben Quelle entfernt Swank nicht immer,
          ;; besonders bei generischen Funktionen. Stabil deduplizieren.
          (let ((seen (make-hash-table :test #'equal)) (dedup nil))
            (dolist (entry (nreverse out))
              (let ((key (list (getf entry :label) (getf entry :file)
                               (getf entry :line) (getf entry :character)
                               (getf entry :offset))))
                (unless (gethash key seen)
                  (setf (gethash key seen) t)
                  (push entry dedup))))
            (list :ok (nreverse dedup)))))
    (error (e) (list :error (princ-to-string e)))))

(defun apropos-for-repl (query package-name all-packages-p)
  (handler-case
      (let ((symbols (apropos-list query (and (not all-packages-p) (find-package package-name))))
            (out nil))
        (dolist (sym (sort (copy-list symbols) #'string< :key #'%package-qualified))
          (let ((kind (%sym-kind sym)))
            (push (%tool-entry (%package-qualified sym)
                               :description (%sym-kind-label kind)
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

