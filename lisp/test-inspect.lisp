;;;; test-inspect.lisp — Smoke-Test für das typspezifische Rendering.
;;;;
;;;;   sbcl --load ~/clamps-vscode/lisp/test-inspect.lisp
;;;;
;;;; Lädt nur rpc.lisp, nicht bootstrap.lisp: kein Quicklisp, kein CLAMPS,
;;;; kein Swank, kein Incudine-RT — der Lauf dauert Sekunden statt Minuten
;;;; und hängt nicht am Keep-Alive-Loop des Bootstraps.
;;;;
;;;; Zugriff über find-symbol statt der ::-Lesesyntax, weil das Paket beim
;;;; READ dieser Datei noch nicht existiert.

(in-package :cl-user)

(eval-when (:compile-toplevel :load-toplevel :execute)
  (unless (find-package :clamps-bridge-rpc)
    (let ((rpc (merge-pathnames "rpc.lisp"
                                (or *load-truename* *default-pathname-defaults*))))
      (if (probe-file rpc)
          (load rpc)
          (error "rpc.lisp nicht gefunden neben ~A" *load-truename*))))
  (unless (find-package :clamps-bridge-rpc)
    (error "CLAMPS-BRIDGE-RPC fehlt auch nach dem Laden von rpc.lisp.")))

(defun %rpc (name &rest args)
  (apply (find-symbol (string-upcase name) :clamps-bridge-rpc) args))

(defun %inspect-register-test (obj)
  "Registriert OBJ direkt, ohne Umweg über einen Ausdruck."
  (funcall (find-symbol "%INSPECT-REGISTER" :clamps-bridge-rpc) obj))

(defparameter *ht* (make-hash-table :test 'equal))
(setf (gethash "a" *ht*) 1
      (gethash "b" *ht*) '(1 2 3))

(defclass foo () ((x :initform 42) (y)))   ; y bleibt absichtlich unbound
(defstruct bar a b)

(defun show (label expr)
  (let ((r (handler-case (%rpc "inspect-for-repl" expr "COMMON-LISP-USER")
             (error (e) (list :crash (princ-to-string e))))))
    (format t "~&~%~A~%  expr   ~A~%" label expr)
    (case (first r)
      (:ok
       (destructuring-bind (ok id type print parts kind meta) r
         (declare (ignore ok))
         (format t "  id     #~A~%  kind   ~A~%  type   ~A~%" id kind type)
         (when meta
           (format t "  meta~%")
           (dolist (m meta)
             (format t "    ~14A ~A~%" (first m) (second m))))
         (format t "  parts  ~A~:[~; (erste 4)~]~%"
                 (length parts) (> (length parts) 4))
         ;; Positionszugriff statt destructuring-bind: kommt in der
         ;; Teileliste ein Feld dazu, bricht der Test sonst mit einem
         ;; ARG-COUNT-ERROR ab, statt die Erweiterung einfach zu ignorieren.
         (loop for p in parts repeat 4
               do (format t "    [~2A] ~16A = ~A~:[  (nicht betretbar)~;~]~:[~;  [schreibbar]~]~%"
                          (second p) (first p) (third p)
                          (fourth p) (fifth p)))
         (when (null parts)
           (format t "    print: ~A~%" print))
         id))
      (:crash (format t "  ABSTURZ ~A~%" (second r)) nil)
      (t      (format t "  FEHLER  ~A~%" (second r)) nil))))

(format t "~&~%===== typspezifisches Rendering =====~%")

(show "HASH-TABLE"  "*ht*")
(show "CLOS-OBJEKT" "(make-instance 'foo)")
(show "STRUCT"      "(make-bar :a 1 :b 2)")
(show "LISTE"       "(list 1 2 3)")
(show "VEKTOR"      "#(1 2 3)")
(show "ARRAY 2D"    "(make-array '(2 3) :initial-element 0)")
(show "STRING"      "\"hallo\"")
(show "INTEGER"     "255")
(show "FLOAT"       "1.5d0")
(show "RATIO"       "22/7")
(show "COMPLEX"     "#c(1 2)")
(show "CHARACTER"   "#\\a")
(show "SYMBOL"      "'car")
(show "FUNKTION"    "#'car")
(show "PATHNAME"    "#p\"/tmp/x.txt\"")
(show "PACKAGE"     "*package*")
(show "NIL"         "nil")

(format t "~&~%===== Objekt-Tabelle =====~%")

;; Der Kernpunkt der Umstellung: Navigation darf das Objekt nicht neu
;; berechnen. Ein Zähler im Konstruktor macht das sichtbar.
(defparameter *ctr* 0)
(defclass zaehler () ((n :initform (incf *ctr*)) (inner :initform (list 1 2))))

(let* ((vorher *ctr*)
       (id (show "SEITENEFFEKT" "(make-instance 'zaehler)")))
  (format t "~&  *ctr* nach erster Inspektion: ~A (war ~A)~%" *ctr* vorher)
  ;; In Slot 1 (inner) navigieren — darf KEINE neue Instanz erzeugen.
  (let ((r (%rpc "inspect-part-for-repl" id 1)))
    (format t "  nach navigate: *ctr*=~A  -> ~A kind=~A parts=~A~%"
            *ctr* (first r) (sixth r) (length (fifth r)))
    (format t "  ~:[FEHLER: Objekt wurde neu berechnet!~;ok: kein Neuaufbau~]~%"
            (= *ctr* (1+ vorher)))))

;; Nicht lesbar druckbare Hash-Schlüssel: früher unnavigierbar.
(let ((h (make-hash-table :test 'eq)))
  (setf (gethash (make-instance 'zaehler) h) :wert-dahinter)
  (let* ((id (%inspect-register-test h))
         (r (%rpc "inspect-part-for-repl" id 0)))
    (format t "~&CLOS-SCHLUESSEL  -> ~A print=~A~%" (first r) (fourth r))))

;; Unbound-Slot darf nicht betretbar sein.
(let* ((id (%inspect-register-test (make-instance 'foo)))
       (r (%rpc "inspect-part-for-repl" id 1)))
  (format t "~&UNBOUND betreten -> ~A ~A~%" (first r) (second r)))

;; Freigabe
(%rpc "inspect-release-for-repl")
(format t "~&NACH RELEASE     -> ~A~%"
        (second (%rpc "inspect-id-for-repl" 1)))

(format t "~&~%===== Slots setzen =====~%")

(defun setpart (label obj index value &optional (pkg "COMMON-LISP-USER"))
  (let* ((id (%inspect-register-test obj))
         (r (handler-case (%rpc "inspect-set-part-for-repl" id index value pkg)
              (error (e) (list :crash (princ-to-string e))))))
    (format t "~&~20A ~A" label (first r))
    (if (eq (first r) :ok)
        (format t "   -> ~A~%" (third r))
        (format t "   ~A~%" (second r)))
    r))

;; CLOS-Slot
(let ((o (make-instance 'foo)))
  (setpart "CLOS-Slot" o 0 "99")
  (format t "  x ist jetzt: ~A~%" (slot-value o 'x)))

;; Unbound-Slot binden — Setzen muss auch das können
(let ((o (make-instance 'foo)))
  (setpart "unbound binden" o 1 ":jetzt-da")
  (format t "  y gebunden: ~A wert=~A~%"
          (slot-boundp o 'y) (and (slot-boundp o 'y) (slot-value o 'y))))

;; Struct
(let ((b (make-bar :a 1 :b 2)))
  (setpart "Struct-Slot" b 0 "\"neu\"")
  (format t "  a ist jetzt: ~S~%" (bar-a b)))

;; Vektor
(let ((v (vector 1 2 3)))
  (setpart "Vektor" v 1 "(list :x)")
  (format t "  v = ~S~%" v))

;; Liste — der Setter muss die richtige Zelle treffen
(let ((l (list :a :b :c)))
  (setpart "Liste Index 1" l 1 ":geaendert")
  (format t "  l = ~S~%" l))

;; Hash-Table — der Setter muss den richtigen Schlüssel treffen
(let ((h (make-hash-table :test 'equal)))
  (setf (gethash "k1" h) 1 (gethash "k2" h) 2)
  (setpart "Hash-Wert" h 1 "42")
  (format t "  k1=~A k2=~A~%" (gethash "k1" h) (gethash "k2" h)))

;; Symbol-Wert
(defparameter *sollgeaendert* :alt)
(setpart "symbol-value" '*sollgeaendert* 0 ":neu")
(format t "  *sollgeaendert* = ~A~%" *sollgeaendert*)

;; Nicht schreibbare Teile müssen sauber ablehnen
(setpart "Komplexzahl (ro)" #c(1 2) 0 "5")
(setpart "symbol-function (ro)" 'car 0 "#'cdr")

;; Fehlerhafte Eingabe darf nicht durchschlagen
(setpart "Syntaxfehler" (vector 1 2) 0 "(((")
(setpart "Typfehler" (make-array 2 :element-type 'double-float
                                   :initial-element 0d0) 0 ":kein-float")

(format t "~&~%===== Teile-Cache =====~%")

;; Messbar machen: %preview zählen. Ohne Cache berechnet jeder Klick
;; alle Vorschauen neu.
(defparameter *gross* (make-array 2000 :initial-element 7))

(let* ((id (%inspect-register-test *gross*))
       (t0 (get-internal-real-time)))
  ;; erste Beschreibung füllt den Cache
  (%rpc "inspect-id-for-repl" id)
  (let ((t1 (get-internal-real-time)))
    ;; 20 Navigationen, sollten den Cache nutzen
    (dotimes (k 20) (%rpc "inspect-part-for-repl" id k))
    (let ((t2 (get-internal-real-time)))
      (format t "~&VEKTOR 2000   beschreiben: ~,1F ms   20x navigieren: ~,1F ms~%"
              (/ (- t1 t0) (/ internal-time-units-per-second 1000.0))
              (/ (- t2 t1) (/ internal-time-units-per-second 1000.0)))
      (format t "  ~:[LANGSAM: Cache greift nicht~;ok: Navigation deutlich billiger~]~%"
              (< (- t2 t1) (* 3 (max 1 (- t1 t0))))))))

;; Refresh muss den Cache verwerfen, sonst zeigt er alte Werte.
(let* ((v (vector :alt))
       (id (%inspect-register-test v)))
  (%rpc "inspect-id-for-repl" id)
  (setf (aref v 0) :neu)
  (let* ((r (%rpc "inspect-id-for-repl" id))
         (p (first (fifth r))))
    (format t "~&REFRESH       Vorschau nach Änderung: ~A ~:[FEHLER: veraltet~;ok~]~%"
            (third p) (search "NEU" (string-upcase (third p))))))

(format t "~&~%===== Kanten =====~%")

;; Vorher lief dolist hier endlos.
(let ((l (list 1 2 3)))
  (setf (cdr (last l)) l)
  (let ((d (%rpc "%inspect-describe" l)))
    (format t "~&ZIRKULÄR      kind=~A meta=~A parts=~A~%"
            (first d) (second d) (length (third d)))))

(let ((d (%rpc "%inspect-describe" '(1 2 . 3))))
  (format t "~&DOTTED        kind=~A letzter=~A~%"
          (first d) (car (last (third d)))))

(let ((d (%rpc "%inspect-describe" (make-instance 'foo))))
  (format t "~&UNBOUND-SLOT  ~A~%"
          (find "y" (third d) :key #'first :test #'string=)))

(format t "~&~%===== Completion =====~%")

(defun cshow (label prefix pkg)
  (let ((r (handler-case (%rpc "completions-for-repl" prefix pkg)
             (error (e) (list :crash (princ-to-string e))))))
    (if (eq (first r) :ok)
        (destructuring-bind (ok truncated items) r
          (declare (ignore ok))
          (format t "~&~%~A  prefix=~S paket=~A~%  ~A Treffer~:[~; (gekappt)~]~%"
                  label prefix pkg (length items) truncated)
          (loop for it in items repeat 5
                do (format t "    ~24A kind=~2A ~A~@[  — ~A~]~%"
                           (first it) (second it) (third it)
                           (let ((doc (or (fourth it) "")))
                             (when (string/= doc "")
                               (subseq doc 0 (min 40 (length doc))))))))
        (format t "~&~A  ABSTURZ ~A~%" label (second r)))))

(cshow "CL-Funktion"     "mapc"        "COMMON-LISP-USER")
(cshow "Makro"           "with-op"     "COMMON-LISP-USER")
(cshow "qualifiziert"    "cl:list-"    "COMMON-LISP-USER")
(cshow "intern (::)"     "sb-kernel::%fun" "COMMON-LISP-USER")
(cshow "Keyword"         ":dir"        "COMMON-LISP-USER")
(cshow "unbekanntes Pkt" "gibtsnicht:x" "COMMON-LISP-USER")
(cshow "leer"            ""            "COMMON-LISP-USER")

(format t "~&~%===== SBCL-Interna (dürfen NIL liefern, aber nicht knallen) =====~%")
(format t "~&%fn-name        ~S~%" (%rpc "%fn-name" #'car))
(format t "~&%fn-lambda-list ~S~%" (%rpc "%fn-lambda-list" #'car))
(format t "~&~%fertig.~%")

(when (sb-ext:posix-getenv "TEST_EXIT")
  (sb-ext:exit :code 0))
