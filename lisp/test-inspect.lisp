;;;; test-inspect.lisp — a smoke test for the type-specific rendering.
;;;;
;;;;   sbcl --load ~/clamps-vscode/lisp/test-inspect.lisp
;;;;
;;;; Loads only rpc.lisp, not bootstrap.lisp: no Quicklisp, no CLAMPS, no
;;;; Swank, no Incudine RT — the run takes seconds instead of minutes and
;;;; does not hang on the bootstrap's keep-alive loop.
;;;;
;;;; Access through find-symbol rather than the :: read syntax, because
;;;; the package does not yet exist when this file is READ.

(in-package :cl-user)

(eval-when (:compile-toplevel :load-toplevel :execute)
  (unless (find-package :clamps-bridge-rpc)
    (let ((rpc (merge-pathnames "rpc.lisp"
                                (or *load-truename* *default-pathname-defaults*))))
      (if (probe-file rpc)
          (load rpc)
          (error "rpc.lisp not found next to ~A" *load-truename*))))
  (unless (find-package :clamps-bridge-rpc)
    (error "CLAMPS-BRIDGE-RPC is missing even after loading rpc.lisp.")))

(defun %rpc (name &rest args)
  (apply (find-symbol (string-upcase name) :clamps-bridge-rpc) args))

(defun %inspect-register-test (obj)
  "Registers OBJ directly, without a detour through an expression."
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
         ;; Positional access rather than destructuring-bind: if a field
         ;; is added to the parts list, the test would otherwise abort
         ;; with an ARG-COUNT-ERROR instead of simply ignoring the
         ;; extension.
         (loop for p in parts repeat 4
               do (format t "    [~2A] ~16A = ~A~:[  (not enterable)~;~]~:[~;  [writable]~]~%"
                          (second p) (first p) (third p)
                          (fourth p) (fifth p)))
         (when (null parts)
           (format t "    print: ~A~%" print))
         id))
      (:crash (format t "  ABSTURZ ~A~%" (second r)) nil)
      (t      (format t "  FAILED  ~A~%" (second r)) nil))))

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

;; The core point of the change: navigation must not recompute the
;; object. A counter in the constructor makes that visible.
(defparameter *ctr* 0)
(defclass zaehler () ((n :initform (incf *ctr*)) (inner :initform (list 1 2))))

(let* ((vorher *ctr*)
       (id (show "SEITENEFFEKT" "(make-instance 'zaehler)")))
  (format t "~&  *ctr* after the first inspection: ~A (was ~A)~%" *ctr* vorher)
  ;; Navigate into slot 1 (inner) — this must create NO new instance.
  (let ((r (%rpc "inspect-part-for-repl" id 1)))
    (format t "  after navigate: *ctr*=~A  -> ~A kind=~A parts=~A~%"
            *ctr* (first r) (sixth r) (length (fifth r)))
    (format t "  ~:[FAILED: the object was recomputed!~;ok: no rebuild~]~%"
            (= *ctr* (1+ vorher)))))

;; Hash keys that cannot be printed readably: previously unnavigable.
(let ((h (make-hash-table :test 'eq)))
  (setf (gethash (make-instance 'zaehler) h) :wert-dahinter)
  (let* ((id (%inspect-register-test h))
         (r (%rpc "inspect-part-for-repl" id 0)))
    (format t "~&CLOS-SCHLUESSEL  -> ~A print=~A~%" (first r) (fourth r))))

;; An unbound slot must not be enterable.
(let* ((id (%inspect-register-test (make-instance 'foo)))
       (r (%rpc "inspect-part-for-repl" id 1)))
  (format t "~&UNBOUND betreten -> ~A ~A~%" (first r) (second r)))

;; Freigabe
(%rpc "inspect-release-for-repl")
(format t "~&AFTER RELEASE    -> ~A~%"
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
  (format t "  x is now: ~A~%" (slot-value o 'x)))

;; Bind an unbound slot — setting has to manage that too
(let ((o (make-instance 'foo)))
  (setpart "unbound binden" o 1 ":jetzt-da")
  (format t "  y gebunden: ~A wert=~A~%"
          (slot-boundp o 'y) (and (slot-boundp o 'y) (slot-value o 'y))))

;; Struct
(let ((b (make-bar :a 1 :b 2)))
  (setpart "Struct-Slot" b 0 "\"neu\"")
  (format t "  a is now: ~S~%" (bar-a b)))

;; Vektor
(let ((v (vector 1 2 3)))
  (setpart "Vektor" v 1 "(list :x)")
  (format t "  v = ~S~%" v))

;; A list — the setter has to hit the right cell
(let ((l (list :a :b :c)))
  (setpart "Liste Index 1" l 1 ":geaendert")
  (format t "  l = ~S~%" l))

;; A hash table — the setter has to hit the right key
(let ((h (make-hash-table :test 'equal)))
  (setf (gethash "k1" h) 1 (gethash "k2" h) 2)
  (setpart "hash value" h 1 "42")
  (format t "  k1=~A k2=~A~%" (gethash "k1" h) (gethash "k2" h)))

;; Symbol value
(defparameter *sollgeaendert* :alt)
(setpart "symbol-value" '*sollgeaendert* 0 ":neu")
(format t "  *sollgeaendert* = ~A~%" *sollgeaendert*)

;; Parts that are not writable have to refuse cleanly
(setpart "Komplexzahl (ro)" #c(1 2) 0 "5")
(setpart "symbol-function (ro)" 'car 0 "#'cdr")

;; Faulty input must not blow through
(setpart "Syntaxfehler" (vector 1 2) 0 "(((")
(setpart "Typfehler" (make-array 2 :element-type 'double-float
                                   :initial-element 0d0) 0 ":not-a-float")

(format t "~&~%===== Teile-Cache =====~%")

;; Make it measurable: count %preview. Without the cache every click
;; recomputes all the previews.
(defparameter *gross* (make-array 2000 :initial-element 7))

(let* ((id (%inspect-register-test *gross*))
       (t0 (get-internal-real-time)))
  ;; the first description fills the cache
  (%rpc "inspect-id-for-repl" id)
  (let ((t1 (get-internal-real-time)))
    ;; 20 navigations, which should use the cache
    (dotimes (k 20) (%rpc "inspect-part-for-repl" id k))
    (let ((t2 (get-internal-real-time)))
      (format t "~&VEKTOR 2000   beschreiben: ~,1F ms   20x navigieren: ~,1F ms~%"
              (/ (- t1 t0) (/ internal-time-units-per-second 1000.0))
              (/ (- t2 t1) (/ internal-time-units-per-second 1000.0)))
      (format t "  ~:[SLOW: the cache is not taking effect~;ok: navigation is markedly cheaper~]~%"
              (< (- t2 t1) (* 3 (max 1 (- t1 t0))))))))

;; Refresh has to discard the cache, otherwise it shows stale values.
(let* ((v (vector :alt))
       (id (%inspect-register-test v)))
  (%rpc "inspect-id-for-repl" id)
  (setf (aref v 0) :neu)
  (let* ((r (%rpc "inspect-id-for-repl" id))
         (p (first (fifth r))))
    (format t "~&REFRESH       preview after a change: ~A ~:[FAILED: stale~;ok~]~%"
            (third p) (search "NEU" (string-upcase (third p))))))

(format t "~&~%===== Kanten =====~%")

;; Previously dolist ran here forever.
(let ((l (list 1 2 3)))
  (setf (cdr (last l)) l)
  (let ((d (%rpc "%inspect-describe" l)))
    (format t "~&CIRCULAR      kind=~A meta=~A parts=~A~%"
            (first d) (second d) (length (third d)))))

(let* ((d (%rpc "%inspect-describe" '(1 2 . 3)))
       (p (car (last (third d)))))
  ;; Only the first three fields: the fourth is the setter, and a printed
  ;; #<FUNCTION ...> says nothing here.
  (format t "~&DOTTED        kind=~A letzter=(~S ~S ~S)~%"
          (first d) (first p) (second p) (third p)))

(let* ((d (%rpc "%inspect-describe" (make-instance 'foo)))
       (p (find "y" (third d) :key #'first :test #'string=)))
  (format t "~&UNBOUND-SLOT  label=~S wert=~A preview=~S setzbar=~:[nein~;ja~]~%"
          (first p) (second p) (third p) (fourth p)))

(format t "~&~%===== Completion =====~%")

(defun cshow (label prefix pkg)
  (let ((r (handler-case (%rpc "completions-for-repl" prefix pkg)
             (error (e) (list :crash (princ-to-string e))))))
    (if (eq (first r) :ok)
        (destructuring-bind (ok truncated items) r
          (declare (ignore ok))
          (format t "~&~%~A  prefix=~S package=~A~%  ~A match(es)~:[~; (truncated)~]~%"
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

(format t "~&~%===== SBCL internals (may return NIL, but must not blow up) =====~%")
(format t "~&%fn-name        ~S~%" (%rpc "%fn-name" #'car))
(format t "~&%fn-lambda-list ~S~%" (%rpc "%fn-lambda-list" #'car))
(format t "~&~%fertig.~%")

(when (sb-ext:posix-getenv "TEST_EXIT")
  (sb-ext:exit :code 0))

(format t "~&Presentation registry isolation …~%")
(let* ((obj (list :presentation :survives-inspector-release))
       (pid (clamps-bridge-rpc::%presentation-register obj)))
  (clamps-bridge-rpc:inspect-for-repl "(list :temporary-inspector)" "COMMON-LISP-USER")
  (clamps-bridge-rpc:inspect-release-for-repl)
  (assert (eq obj (clamps-bridge-rpc:presentation-value pid)))
  (assert (= pid (clamps-bridge-rpc::%presentation-register obj))))
(format t "ok — presentations survive the inspector release and keep their ID.~%")

(format t "~&Presentation-Typ-Etiketten …~%")
;; A regression: the labels came from type-of and were therefore exact
;; type specifiers rather than names for numbers and sequences. The REPL
;; line then read "[#4 (integer 0 4611686018427387903)] ,inspect 4".
;; The check is against the values on which type-of gets it wrong.
(dolist (case '((2   "fixnum")
                (1   "fixnum")
                ("abc" "simple-character-string")
                (#(1 2) "simple-vector")))
  (destructuring-bind (value expected) case
    (let ((got (clamps-bridge-rpc::%presentation-type-label value)))
      (unless (string= got expected)
        (format t "~&FAILED label for ~S: expected ~S, got ~S~%"
                value expected got)
        (sb-ext:exit :code 1))
      (when (find #\( got)
        (format t "~&FAILED label for ~S contains parens: ~S~%" value got)
        (sb-ext:exit :code 1)))))
;; The label and the ID have to come for EVERY value, including those
;; without a class name — an empty label would not be recognisable in the
;; line.
(dolist (value (list nil t 1/3 #\a 'foo (make-hash-table) #*01 (lambda () 1)))
  (let ((label (clamps-bridge-rpc::%presentation-type-label value)))
    (when (or (null label) (string= label ""))
      (format t "~&FAILED empty label for ~S~%" value)
      (sb-ext:exit :code 1))))
;; The same arity in both branches of eval-for-repl: the error branch had
;; three elements, the success branch four.
(let ((ok (clamps-bridge-rpc:eval-for-repl "(+ 1 1)" "COMMON-LISP-USER"))
      (bad (clamps-bridge-rpc:eval-for-repl "(car 1)" "COMMON-LISP-USER")))
  (unless (= (length ok) (length bad))
    (format t "~&FAILED arity: ok=~D error=~D~%" (length ok) (length bad))
    (sb-ext:exit :code 1))
  (unless (eq (first bad) :error)
    (format t "~&FAILED the error branch reports ~S~%" (first bad))
    (sb-ext:exit :code 1)))
(format t "ok — Presentation-Etiketten lesbar, Stelligkeit in beiden Zweigen gleich.~%")
