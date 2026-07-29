;;;; test-xref.lisp — a regression test for XREF and object identity.
;;;;
;;;;   sbcl --script lisp/test-xref.lisp
;;;;
;;;; Covers the three bugs that were shipped unnoticed in v76/v77. All
;;;; three were visible only against a running image, and that is exactly
;;;; what never ran:
;;;;
;;;;   1. xref-for-repl passed resolve-symbol the package name as a
;;;;      STRING. resolve-symbol binds *package* to it, SBCL declares
;;;;      *package* to be of type PACKAGE — a type error, swallowed by the
;;;;      handler-case, result NIL. swank:xref was never called; six of
;;;;      the seven XREF kinds stubbornly reported "symbol not found".
;;;;   2. %tool-entry set :line to 1 when the backend supplies no line.
;;;;      The client preferred the line and the character offset next to
;;;;      it went unused — every jump landed at the start of the file.
;;;;   3. %inspect-register handed out a new ID for the same object every
;;;;      time. With that, the client's cycle detection, which compares
;;;;      IDs, could never trigger at all.
;;;;
;;;; Swank is replaced by a stand-in: the test is meant to check the
;;;; wiring, not SBCL's cross-reference database, and so runs in seconds
;;;; without Quicklisp.

(in-package :cl-user)

(defpackage :swank
  (:use :cl)
  (:export #:xref #:find-definitions-for-emacs))
(in-package :swank)

(defvar *calls* '()
  "A log: what did the client ask swank:xref for?")

(defun xref (type name)
  (push (list type name) *calls*)
  ;; A realistic SBCL answer: the name as a string, the location with
  ;; (:position N) and WITHOUT (:line …) — the normal case on which the
  ;; jump failed. The duplicate entry also checks the deduplication.
  (let ((loc (list :location (list :file "/tmp/clamps-xref-probe.lisp")
                   (list :position 4711)
                   (list :snippet "(defun bar"))))
    (list (list "cl-user::bar" loc)
          (list "cl-user::bar" loc))))

(in-package :cl-user)

(let ((rpc (merge-pathnames "rpc.lisp"
                            (or *load-truename* *default-pathname-defaults*))))
  (unless (probe-file rpc)
    (format *error-output* "~&rpc.lisp not found next to ~A~%" *load-truename*)
    (sb-ext:exit :code 1))
  (handler-bind ((warning #'muffle-warning))
    (load rpc)))

(defvar *failed* 0)

(defun check (name actual expected)
  (unless (equal actual expected)
    (incf *failed*)
    (format t "~&FAILED ~A~%  expected: ~S~%  got:      ~S~%" name expected actual)))

(defun truthy (name actual)
  (unless actual
    (incf *failed*)
    (format t "~&FAILED ~A~%  expected: something true, got: NIL~%" name)))

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
    (truthy (format nil "~A calls swank:xref" kind) swank::*calls*)
    ;; Passed fully qualified, so that the caller's package does not have
    ;; a say in which symbol is meant.
    (truthy (format nil "~A uebergibt qualifizierten Namen" kind)
            (search "common-lisp::car" (second (first swank::*calls*))))))

(check "an unknown kind is reported"
       (first (rpc "xref-for-repl" "car" "COMMON-LISP-USER" "quatsch")) :error)
(check "an unknown symbol is reported"
       (first (rpc "xref-for-repl" "gibtsnicht-xyzzy" "COMMON-LISP-USER" "callers"))
       :error)

;;; And none is left behind either: read-from-string interns, so the
;;; fallback path in resolve-symbol used to create a symbol in the package
;;; on every typo and report it as a hit.
(check "a typo creates no symbol"
       (nth-value 1 (find-symbol "GIBTSNICHT-XYZZY" :common-lisp-user))
       nil)

;;; Nothing may blow up with a package that does not exist either: it
;;; falls back to COMMON-LISP-USER.
(check "an unknown package falls back"
       (first (rpc "xref-for-repl" "car" "GIBTSNICHT" "callers")) :ok)

;;; ---------------------------------------------------------------------
;;; 2. The line stays empty, the offset comes through, duplicates drop out
;;; ---------------------------------------------------------------------
(let* ((r (rpc "xref-for-repl" "car" "COMMON-LISP-USER" "callers"))
       (entries (second r))
       (e (first entries)))
  (check "Duplikate entfernt" (length entries) 1)
  (check "no invented line" (getf e :line) nil)
  (check "Offset durchgereicht" (getf e :offset) 4711)
  (check "Art benannt" (getf e :description) "calls")
  ;; The probe file does not exist — then NIL rather than a jump into the
  ;; void, and the client reports that honestly.
  (check "fehlende Quelle ehrlich" (getf e :file) nil)
  ;; The name arrives as a string; an inspectable expression must come
  ;; out all the same.
  (check "inspect expression from a string name"
         (getf e :inspect) "common-lisp-user::bar"))

;;; An existing file is resolved and keeps its offset.
(let ((probe "/tmp/clamps-xref-probe.lisp"))
  (with-open-file (s probe :direction :output :if-exists :supersede)
    (format s "(defun bar () 1)~%"))
  (unwind-protect
       (let ((e (first (second (rpc "xref-for-repl" "car" "COMMON-LISP-USER" "callers")))))
         (check "vorhandene Quelle aufgeloest" (getf e :file) probe)
         (check "the offset stays on the hit" (getf e :offset) 4711)
         (check "no line then either" (getf e :line) nil))
    (ignore-errors (delete-file probe))))

;;; ---------------------------------------------------------------------
;;; 3. Object identity: the same ID for the same object
;;; ---------------------------------------------------------------------
(let* ((reg (find-symbol "%INSPECT-REGISTER" :clamps-bridge-rpc))
       (a (list 1 2 3))
       (b (list 1 2 3)))
  (check "gleiches Objekt, gleiche ID" (funcall reg a) (funcall reg a))
  (truthy "verschiedene Objekte, verschiedene IDs"
          (/= (funcall reg a) (funcall reg b)))
  ;; The cycle itself: a structure pointing at itself.
  (let ((ring (list 1)))
    (setf (cdr ring) ring)
    (check "selbstreferenziell, stabile ID"
           (funcall reg ring) (funcall reg (cdr ring)))))

;;; After releasing, the table is empty — and hands out new IDs without
;;; dragging old identities along.
(let* ((reg (find-symbol "%INSPECT-REGISTER" :clamps-bridge-rpc))
       (o (list :x))
       (before (funcall reg o)))
  (rpc "inspect-release-for-repl")
  (let ((after (funcall reg o)))
    (truthy "a new ID after releasing" (/= before after))))

;;; ---------------------------------------------------------------------
;;; 4. The expand arrow: only where there is something to expand
;;; ---------------------------------------------------------------------
(let ((p (find-symbol "%INSPECT-EXPANDABLE-P" :clamps-bridge-rpc)))
  (dolist (case '((42 nil) (#\a nil) ("text" nil) (nil nil)
                  ((1 2) t) (:kw t)))
    (destructuring-bind (val expected) case
      (check (format nil "expandable-p ~S" val)
             (and (funcall p val) t) expected)))
  (check "an empty hash table does not" (and (funcall p (make-hash-table)) t) nil)
  (let ((h (make-hash-table)))
    (setf (gethash :a h) 1)
    (check "a filled hash table does" (and (funcall p h) t) t))
  (check "an empty vector does not" (and (funcall p (vector)) t) nil)
  (check "a filled vector does" (and (funcall p (vector 1)) t) t)
  ;; Unbound slots get no arrow, otherwise it leads nowhere.
  (check "the unbound marker does not"
         (and (funcall p (symbol-value (find-symbol "+UNBOUND+" :clamps-bridge-rpc))) t)
         nil))

;;; And the parts list really does carry the field.
(defclass probe-person () ((name :initform "Anna") (alter :initform 42)))
(let* ((obj (make-instance 'probe-person))
       (reg (find-symbol "%INSPECT-REGISTER" :clamps-bridge-rpc))
       (desc (find-symbol "%DESCRIBE-REGISTERED" :clamps-bridge-rpc))
       (r (funcall desc obj (funcall reg obj)))
       (parts (fifth r)))
  (check "zwei Slots" (length parts) 2)
  (dolist (p parts)
    (check (format nil "six fields for ~A" (first p)) (length p) 6)
    ;; A string and a number are both not expandable.
    (check (format nil "~A without an arrow" (first p)) (sixth p) nil)))

(if (zerop *failed*)
    (format t "~&ok — XREF wiring, jump target and object identity are right.~%")
    (format t "~&~D check(s) failed.~%" *failed*))
(sb-ext:exit :code (if (zerop *failed*) 0 1))
