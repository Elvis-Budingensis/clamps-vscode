;;;; test-xref.lisp — Regressionstest für XREF und Objekt-Identität.
;;;;
;;;;   sbcl --script lisp/test-xref.lisp
;;;;
;;;; Deckt die drei Fehler ab, die in v76/v77 unbemerkt ausgeliefert
;;;; wurden. Alle drei waren nur gegen ein laufendes Image sichtbar, und
;;;; genau das lief nie:
;;;;
;;;;   1. xref-for-repl übergab resolve-symbol den Paketnamen als STRING.
;;;;      resolve-symbol bindet *package* daran, SBCL deklariert
;;;;      *package* als Typ PACKAGE — Typfehler, vom handler-case
;;;;      verschluckt, Ergebnis NIL. swank:xref wurde nie aufgerufen;
;;;;      sechs der sieben XREF-Arten meldeten stur "Symbol nicht
;;;;      gefunden".
;;;;   2. %tool-entry setzte :line auf 1, wenn das Backend keine Zeile
;;;;      liefert. Der Client bevorzugte die Zeile, der daneben stehende
;;;;      Zeichen-Offset blieb ungenutzt — jeder Sprung landete am
;;;;      Dateianfang.
;;;;   3. %inspect-register vergab für dasselbe Objekt jedes Mal eine neue
;;;;      ID. Damit konnte die Zyklenerkennung des Clients, die IDs
;;;;      vergleicht, grundsätzlich nicht auslösen.
;;;;
;;;; Swank wird durch eine Attrappe ersetzt: der Test soll die Verkabelung
;;;; prüfen, nicht SBCLs Cross-Reference-Datenbank, und läuft so in
;;;; Sekunden ohne Quicklisp.

(in-package :cl-user)

(defpackage :swank
  (:use :cl)
  (:export #:xref #:find-definitions-for-emacs))
(in-package :swank)

(defvar *calls* '()
  "Protokoll: was hat der Client bei swank:xref angefragt?")

(defun xref (type name)
  (push (list type name) *calls*)
  ;; Realistische SBCL-Antwort: Name als String, Ort mit (:position N)
  ;; und OHNE (:line …) — der Normalfall, an dem der Sprung scheiterte.
  ;; Der doppelte Eintrag prüft zugleich die Deduplizierung.
  (let ((loc (list :location (list :file "/tmp/clamps-xref-probe.lisp")
                   (list :position 4711)
                   (list :snippet "(defun bar"))))
    (list (list "cl-user::bar" loc)
          (list "cl-user::bar" loc))))

(in-package :cl-user)

(let ((rpc (merge-pathnames "rpc.lisp"
                            (or *load-truename* *default-pathname-defaults*))))
  (unless (probe-file rpc)
    (format *error-output* "~&rpc.lisp nicht gefunden neben ~A~%" *load-truename*)
    (sb-ext:exit :code 1))
  (handler-bind ((warning #'muffle-warning))
    (load rpc)))

(defvar *failed* 0)

(defun check (name actual expected)
  (unless (equal actual expected)
    (incf *failed*)
    (format t "~&FEHLER ~A~%  erwartet: ~S~%  bekommen: ~S~%" name expected actual)))

(defun truthy (name actual)
  (unless actual
    (incf *failed*)
    (format t "~&FEHLER ~A~%  erwartet: etwas Wahres, bekommen: NIL~%" name)))

(defun rpc (name &rest args)
  (apply (or (find-symbol (string-upcase name) :clamps-bridge-rpc)
             (error "~A fehlt in CLAMPS-BRIDGE-RPC" name))
         args))

;;; ---------------------------------------------------------------------
;;; 1. Alle XREF-Arten erreichen Swank
;;; ---------------------------------------------------------------------
(dolist (kind '("callers" "callees" "references" "bindings" "setters"
                "macroexpands"))
  (setf swank::*calls* '())
  (let ((r (rpc "xref-for-repl" "car" "COMMON-LISP-USER" kind)))
    (check (format nil "~A liefert :ok" kind) (first r) :ok)
    (truthy (format nil "~A ruft swank:xref auf" kind) swank::*calls*)
    ;; Vollqualifiziert übergeben, damit das Paket des Aufrufers nicht
    ;; mitentscheidet, welches Symbol gemeint ist.
    (truthy (format nil "~A uebergibt qualifizierten Namen" kind)
            (search "common-lisp::car" (second (first swank::*calls*))))))

(check "unbekannte Art wird gemeldet"
       (first (rpc "xref-for-repl" "car" "COMMON-LISP-USER" "quatsch")) :error)
(check "unbekanntes Symbol wird gemeldet"
       (first (rpc "xref-for-repl" "gibtsnicht-xyzzy" "COMMON-LISP-USER" "callers"))
       :error)

;;; Und es bleibt auch keins zurück: read-from-string interniert, der
;;; Rückfallweg in resolve-symbol legte deshalb bei jedem Tippfehler ein
;;; Symbol im Paket an und meldete es als Treffer.
(check "Tippfehler legt kein Symbol an"
       (nth-value 1 (find-symbol "GIBTSNICHT-XYZZY" :common-lisp-user))
       nil)

;;; Auch mit einem Paket, das es nicht gibt, darf nichts knallen: es wird
;;; auf COMMON-LISP-USER zurückgefallen.
(check "unbekanntes Paket faellt zurueck"
       (first (rpc "xref-for-repl" "car" "GIBTSNICHT" "callers")) :ok)

;;; ---------------------------------------------------------------------
;;; 2. Zeile bleibt leer, Offset kommt durch, Duplikate fallen weg
;;; ---------------------------------------------------------------------
(let* ((r (rpc "xref-for-repl" "car" "COMMON-LISP-USER" "callers"))
       (entries (second r))
       (e (first entries)))
  (check "Duplikate entfernt" (length entries) 1)
  (check "keine erfundene Zeile" (getf e :line) nil)
  (check "Offset durchgereicht" (getf e :offset) 4711)
  (check "Art benannt" (getf e :description) "calls")
  ;; Die Probedatei existiert nicht — dann NIL statt eines Sprungs ins
  ;; Leere, und der Client meldet das ehrlich.
  (check "fehlende Quelle ehrlich" (getf e :file) nil)
  ;; Der Name kommt als String; trotzdem muss ein inspizierbarer
  ;; Ausdruck herausfallen.
  (check "Inspect-Ausdruck aus String-Namen"
         (getf e :inspect) "common-lisp-user::bar"))

;;; Eine existierende Datei wird aufgelöst und behält ihren Offset.
(let ((probe "/tmp/clamps-xref-probe.lisp"))
  (with-open-file (s probe :direction :output :if-exists :supersede)
    (format s "(defun bar () 1)~%"))
  (unwind-protect
       (let ((e (first (second (rpc "xref-for-repl" "car" "COMMON-LISP-USER" "callers")))))
         (check "vorhandene Quelle aufgeloest" (getf e :file) probe)
         (check "Offset bleibt am Treffer" (getf e :offset) 4711)
         (check "auch dann keine Zeile" (getf e :line) nil))
    (ignore-errors (delete-file probe))))

;;; ---------------------------------------------------------------------
;;; 3. Objekt-Identität: dieselbe ID für dasselbe Objekt
;;; ---------------------------------------------------------------------
(let* ((reg (find-symbol "%INSPECT-REGISTER" :clamps-bridge-rpc))
       (a (list 1 2 3))
       (b (list 1 2 3)))
  (check "gleiches Objekt, gleiche ID" (funcall reg a) (funcall reg a))
  (truthy "verschiedene Objekte, verschiedene IDs"
          (/= (funcall reg a) (funcall reg b)))
  ;; Der Zyklus selbst: eine Struktur, die auf sich zeigt.
  (let ((ring (list 1)))
    (setf (cdr ring) ring)
    (check "selbstreferenziell, stabile ID"
           (funcall reg ring) (funcall reg (cdr ring)))))

;;; Nach dem Freigeben ist die Tabelle leer — und vergibt neue IDs, ohne
;;; alte Identitäten weiterzuschleppen.
(let* ((reg (find-symbol "%INSPECT-REGISTER" :clamps-bridge-rpc))
       (o (list :x))
       (before (funcall reg o)))
  (rpc "inspect-release-for-repl")
  (let ((after (funcall reg o)))
    (truthy "nach Freigabe neue ID" (/= before after))))

;;; ---------------------------------------------------------------------
;;; 4. Aufklapp-Pfeil: nur wo es etwas aufzuklappen gibt
;;; ---------------------------------------------------------------------
(let ((p (find-symbol "%INSPECT-EXPANDABLE-P" :clamps-bridge-rpc)))
  (dolist (case '((42 nil) (#\a nil) ("text" nil) (nil nil)
                  ((1 2) t) (:kw t)))
    (destructuring-bind (val expected) case
      (check (format nil "expandable-p ~S" val)
             (and (funcall p val) t) expected)))
  (check "leere Hashtable nicht" (and (funcall p (make-hash-table)) t) nil)
  (let ((h (make-hash-table)))
    (setf (gethash :a h) 1)
    (check "gefuellte Hashtable schon" (and (funcall p h) t) t))
  (check "leerer Vektor nicht" (and (funcall p (vector)) t) nil)
  (check "gefuellter Vektor schon" (and (funcall p (vector 1)) t) t)
  ;; Ungebundene Slots bekommen keinen Pfeil, sonst führt er ins Leere.
  (check "Unbound-Marke nicht"
         (and (funcall p (symbol-value (find-symbol "+UNBOUND+" :clamps-bridge-rpc))) t)
         nil))

;;; Und die Teileliste trägt das Feld tatsächlich mit.
(defclass probe-person () ((name :initform "Anna") (alter :initform 42)))
(let* ((obj (make-instance 'probe-person))
       (reg (find-symbol "%INSPECT-REGISTER" :clamps-bridge-rpc))
       (desc (find-symbol "%DESCRIBE-REGISTERED" :clamps-bridge-rpc))
       (r (funcall desc obj (funcall reg obj)))
       (parts (fifth r)))
  (check "zwei Slots" (length parts) 2)
  (dolist (p parts)
    (check (format nil "sechs Felder bei ~A" (first p)) (length p) 6)
    ;; String und Zahl sind beide nicht aufklappbar.
    (check (format nil "~A ohne Pfeil" (first p)) (sixth p) nil)))

(if (zerop *failed*)
    (format t "~&ok — XREF-Verkabelung, Sprungziel und Objekt-Identität stimmen.~%")
    (format t "~&~D Prüfung(en) fehlgeschlagen.~%" *failed*))
(sb-ext:exit :code (if (zerop *failed*) 0 1))
