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
       (destructuring-bind (ok type print parts pkg &optional kind meta) r
         (declare (ignore ok pkg))
         (format t "  kind   ~A~%  type   ~A~%" kind type)
         (when meta
           (format t "  meta~%")
           (dolist (m meta)
             (format t "    ~14A ~A~%" (first m) (second m))))
         (format t "  parts  ~A~:[~; (erste 4)~]~%"
                 (length parts) (> (length parts) 4))
         (loop for p in parts repeat 4
               do (format t "    ~16A = ~A~%" (first p) (third p)))
         (when (null parts)
           (format t "    print: ~A~%" print))))
      (:crash (format t "  ABSTURZ ~A~%" (second r)))
      (t      (format t "  FEHLER  ~A~%" (second r))))))

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

(format t "~&~%===== SBCL-Interna (dürfen NIL liefern, aber nicht knallen) =====~%")
(format t "~&%fn-name        ~S~%" (%rpc "%fn-name" #'car))
(format t "~&%fn-lambda-list ~S~%" (%rpc "%fn-lambda-list" #'car))
(format t "~&~%fertig.~%")

(when (sb-ext:posix-getenv "TEST_EXIT")
  (sb-ext:exit :code 0))
