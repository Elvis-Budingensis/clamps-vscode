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

(format t "~&~%===== type-specific rendering =====~%")

(show "HASH TABLE"   "*ht*")
(show "CLOS OBJECT" "(make-instance 'foo)")
(show "STRUCT"      "(make-bar :a 1 :b 2)")
(show "LIST"         "(list 1 2 3)")
(show "VECTOR"       "#(1 2 3)")
(show "ARRAY 2D"    "(make-array '(2 3) :initial-element 0)")
(show "STRING"      "\"hallo\"")
(show "INTEGER"     "255")
(show "FLOAT"       "1.5d0")
(show "RATIO"       "22/7")
(show "COMPLEX"     "#c(1 2)")
(show "CHARACTER"   "#\\a")
(show "SYMBOL"      "'car")
(show "FUNCTION"     "#'car")
(show "PATHNAME"    "#p\"/tmp/x.txt\"")
(show "PACKAGE"     "*package*")
(show "NIL"         "nil")

(format t "~&~%===== object table =====~%")

;; The core point of the change: navigation must not recompute the
;; object. A counter in the constructor makes that visible.
(defparameter *ctr* 0)
(defclass counter () ((n :initform (incf *ctr*)) (inner :initform (list 1 2))))

(let* ((vorher *ctr*)
       (id (show "SIDE EFFECT" "(make-instance 'counter)")))
  (format t "~&  *ctr* after the first inspection: ~A (was ~A)~%" *ctr* vorher)
  ;; Navigate into slot 1 (inner) — this must create NO new instance.
  (let ((r (%rpc "inspect-part-for-repl" id 1)))
    (format t "  after navigate: *ctr*=~A  -> ~A kind=~A parts=~A~%"
            *ctr* (first r) (sixth r) (length (fifth r)))
    (format t "  ~:[FAILED: the object was recomputed!~;ok: no rebuild~]~%"
            (= *ctr* (1+ vorher)))))

;; Hash keys that cannot be printed readably: previously unnavigable.
(let ((h (make-hash-table :test 'eq)))
  (setf (gethash (make-instance 'counter) h) :value-behind)
  (let* ((id (%inspect-register-test h))
         (r (%rpc "inspect-part-for-repl" id 0)))
    (format t "~&CLOS KEY         -> ~A print=~A~%" (first r) (fourth r))))

;; An unbound slot must not be enterable.
(let* ((id (%inspect-register-test (make-instance 'foo)))
       (r (%rpc "inspect-part-for-repl" id 1)))
  (format t "~&ENTER UNBOUND    -> ~A ~A~%" (first r) (second r)))

;; Freigabe
(%rpc "inspect-release-for-repl")
(format t "~&AFTER RELEASE    -> ~A~%"
        (second (%rpc "inspect-id-for-repl" 1)))

(format t "~&~%===== setting slots =====~%")

(defvar *setpart-failures* 0)
(defvar *repl-cap-probe* nil)

(defun setpart (label obj index value &optional (pkg "COMMON-LISP-USER")
                                        (expect :ok))
  "Sets a part and CHECKS the outcome against EXPECT.

EXPECT is :ok or :error.  Until 1.0.3 this function only printed the
outcome and returned it; nothing compared it against anything.  The file
therefore ran to the end and exited 0 even when a line said ERROR — and
one did: on SBCL 2.2.9 under Linux the struct case reported \"Part no
longer exists\" while it succeeded on macOS.  The gate chain reported
success in both cases, which is the same blind spot as a stripped
comment: the output was there, nobody read it.

Four of the calls below expect :error — a read-only part, a syntax error,
a type error.  So the expectation has to be stated per call; a blanket
\"no ERROR anywhere\" would have to ignore exactly the cases that check
the refusals."
  (let* ((id (%inspect-register-test obj))
         (r (handler-case (%rpc "inspect-set-part-for-repl" id index value pkg)
              (error (e) (list :crash (princ-to-string e)))))
         (got (if (eq (first r) :ok) :ok :error)))
    (format t "~&~20A ~A" label (first r))
    (if (eq (first r) :ok)
        (format t "   -> ~A~%" (third r))
        (format t "   ~A~%" (second r)))
    (unless (eq got expect)
      (incf *setpart-failures*)
      (format t "~&  FAILED ~A: expected ~A, got ~A~@[ (~A)~]~%"
              label expect got (and (not (eq got :ok)) (second r))))
    r))

;; CLOS-Slot
(let ((o (make-instance 'foo)))
  (setpart "CLOS slot" o 0 "99")
  (format t "  x is now: ~A~%" (slot-value o 'x)))

;; Bind an unbound slot — setting has to manage that too
(let ((o (make-instance 'foo)))
  (setpart "bind an unbound slot" o 1 ":now-here")
  (format t "  y bound: ~A value=~A~%"
          (slot-boundp o 'y) (and (slot-boundp o 'y) (slot-value o 'y))))

;; Struct
(let ((b (make-bar :a 1 :b 2)))
  (setpart "struct slot" b 0 "\"new\"")
  (format t "  a is now: ~S~%" (bar-a b)))

;; Vektor
(let ((v (vector 1 2 3)))
  (setpart "vector" v 1 "(list :x)")
  (format t "  v = ~S~%" v))

;; A list — the setter has to hit the right cell
(let ((l (list :a :b :c)))
  (setpart "list index 1" l 1 ":changed")
  (format t "  l = ~S~%" l))

;; A hash table — the setter has to hit the right key
(let ((h (make-hash-table :test 'equal)))
  (setf (gethash "k1" h) 1 (gethash "k2" h) 2)
  (setpart "hash value" h 1 "42")
  (format t "  k1=~A k2=~A~%" (gethash "k1" h) (gethash "k2" h)))

;; Symbol value
(defparameter *should-change* :old)
(setpart "symbol-value" '*should-change* 0 ":fresh")
(format t "  *should-change* = ~A~%" *should-change*)

;; Parts that are not writable have to refuse cleanly
(setpart "complex number (ro)" #c(1 2) 0 "5" "COMMON-LISP-USER" :error)
(setpart "symbol-function (ro)" 'car 0 "#'cdr" "COMMON-LISP-USER" :error)

;; Faulty input must not blow through
(setpart "syntax error" (vector 1 2) 0 "(((" "COMMON-LISP-USER" :error)
(setpart "type error" (make-array 2 :element-type 'double-float
                                   :initial-element 0d0) 0 ":not-a-float"
         "COMMON-LISP-USER" :error)

(format t "~&~%===== parts cache =====~%")

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
      (format t "~&VECTOR 2000   describe: ~,1F ms   navigate 20x: ~,1F ms~%"
              (/ (- t1 t0) (/ internal-time-units-per-second 1000.0))
              (/ (- t2 t1) (/ internal-time-units-per-second 1000.0)))
      (format t "  ~:[SLOW: the cache is not taking effect~;ok: navigation is markedly cheaper~]~%"
              (< (- t2 t1) (* 3 (max 1 (- t1 t0))))))))

;; Refresh has to discard the cache, otherwise it shows stale values.
(let* ((v (vector :old))
       (id (%inspect-register-test v)))
  (%rpc "inspect-id-for-repl" id)
  (setf (aref v 0) :fresh)
  (let* ((r (%rpc "inspect-id-for-repl" id))
         (p (first (fifth r))))
    (format t "~&REFRESH       preview after a change: ~A ~:[FAILED: stale~;ok~]~%"
            (third p) (search "FRESH" (string-upcase (third p))))))

(format t "~&~%===== edge cases =====~%")

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
  (format t "~&DOTTED        kind=~A last=(~S ~S ~S)~%"
          (first d) (first p) (second p) (third p)))

(let* ((d (%rpc "%inspect-describe" (make-instance 'foo)))
       (p (find "y" (third d) :key #'first :test #'string=)))
  (format t "~&UNBOUND-SLOT  label=~S value=~A preview=~S writable=~:[no~;yes~]~%"
          (first p) (second p) (third p) (fourth p)))

(format t "~&~%===== completion =====~%")

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

(cshow "CL function"     "mapc"        "COMMON-LISP-USER")
(cshow "macro"           "with-op"     "COMMON-LISP-USER")
(cshow "qualified"       "cl:list-"    "COMMON-LISP-USER")
(cshow "intern (::)"     "sb-kernel::%fun" "COMMON-LISP-USER")
(cshow "Keyword"         ":dir"        "COMMON-LISP-USER")
(cshow "unknown package" "nosuchpkg:x" "COMMON-LISP-USER")
(cshow "empty prefix"    ""            "COMMON-LISP-USER")

(format t "~&~%===== SBCL internals (may return NIL, but must not blow up) =====~%")
(format t "~&%fn-name        ~S~%" (%rpc "%fn-name" #'car))
(format t "~&%fn-lambda-list ~S~%" (%rpc "%fn-lambda-list" #'car))
(when (> *setpart-failures* 0)
  ;; The whole point of 1.0.3: a printed ERROR now ends the run. Before
  ;; this the file exited 0 and the gate chain said "ok".
  (format t "~&~%~D setpart check(s) failed.~%" *setpart-failures*)
  (sb-ext:exit :code 1))


;;; ---------------------------------------------------------------------
;;; The REPL caps what it prints
;;; ---------------------------------------------------------------------
;;; (defparameter *buf* (make-array 100000 ...)) returns the array. Printed
;;; in full that is some 800 kilobytes through the bridge, into the
;;; terminal, and past the scrollback, so that the input which caused it is
;;; gone. A REPL that punishes you for making a buffer is a REPL you stop
;;; using for buffers.
;;;
;;; The cap must sit around the PRINTING of the result and not around the
;;; evaluation: code that prints for itself is the user's own output and
;;; must not be truncated behind their back. Both halves are checked here,
;;; because getting the first right and the second wrong looks identical
;;; until somebody's loop output goes missing.
(let* ((big (make-array 100000 :element-type 'double-float
                               :initial-element 0.01d0))
       (result (clamps-bridge-rpc:eval-for-repl
                "cl-user::*repl-cap-probe*" "CL-USER"))
       (ignore (setf cl-user::*repl-cap-probe* big))
       (text (second (clamps-bridge-rpc:eval-for-repl
                      "cl-user::*repl-cap-probe*" "CL-USER"))))
  (declare (ignore result ignore))
  (when (> (length text) 20000)
    (format t "~&FAILED the REPL printed ~D characters for a 100000-element ~
array — the cap is not taking effect~%" (length text)))
  (unless (search "..." text)
    (format t "~&FAILED the truncation is not marked with \"...\" — the ~
output would look complete~%")))

;;; And the user's own output stays whole.
(let ((text (second (clamps-bridge-rpc:eval-for-repl
                     "(dotimes (i 40) (format t \"~D \" i))" "CL-USER"))))
  (unless (search "39" text)
    (format t "~&FAILED the user's own printing was truncated: ~S~%" text)))

(format t "~&~%done.~%")

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

(format t "~&Presentation type labels …~%")
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
(format t "ok — presentation labels readable, arity equal in both branches.~%")
