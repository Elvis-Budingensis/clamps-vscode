;;;; loadcheck.lisp — the gate that would have found v72's paren bug.
;;;;
;;;; Run: sbcl --script lisp/loadcheck.lisp
;;;;
;;;; Why it is needed: check.py counts characters, and a missing paren
;;;; balanced out by a surplus one at the end of the file is invisible to
;;;; any counter. The reader was satisfied, the paren balance was zero —
;;;; and yet there stood a handler-case without a clause, which turned
;;;; (error (e) ...) into a function call: "The function
;;;; clamps-bridge-rpc::e is undefined", every time the debugger was
;;;; attached.
;;;;
;;;; Three stages:
;;;;   1. READ    — every file form by form; finds real syntax errors
;;;;   2. SHAPE   — handler-case/handler-bind must have clauses
;;;;   3. LOAD    — rpc.lisp against a bare SBCL; every WARNING is a
;;;;                failure, STYLE-WARNING is reported
;;;;
;;;; Only rpc.lisp is loaded: by its own header comment it is free of
;;;; CLAMPS, Swank and Incudine. bridge-server.lisp needs Swank and can
;;;; only be read and checked for shape here.

(require :sb-posix)

(defpackage :loadcheck (:use :cl))
(in-package :loadcheck)

(defvar *problems* 0)

(defun problem (fmt &rest args)
  (incf *problems*)
  (format *error-output* "~&ERROR: ~?~%" fmt args))

;;; --- Stufe 1: Lesen --------------------------------------------------

(defun strip-package-markers (text)
  "Replaces package prefixes (foo:bar -> foo-bar) OUTSIDE strings,
comments and character literals.

For the shape check it does not matter which package a symbol lives in —
what matters is list structure and heads such as HANDLER-CASE. This
fallback makes files checkable that name foreign packages (ql:quickload,
sb-posix:getpid) and are therefore unreadable in a bare SBCL. Without it
bridge-server.lisp would stay unchecked — that is, precisely the file
that cannot be loaded and therefore needs a check most urgently."
  (let ((out (make-string-output-stream))
        (i 0) (n (length text)))
    (loop while (< i n) do
      (let ((c (char text i)))
        (cond
          ;; Take the string over unchanged
          ((char= c #\")
           (write-char c out) (incf i)
           (loop while (and (< i n) (char/= (char text i) #\"))
                 do (when (and (char= (char text i) #\\) (< (1+ i) n))
                      (write-char (char text i) out) (incf i))
                    (write-char (char text i) out) (incf i))
           (when (< i n) (write-char (char text i) out) (incf i)))
          ;; Zeilenkommentar
          ((char= c #\;)
           (loop while (and (< i n) (char/= (char text i) #\Newline))
                 do (write-char (char text i) out) (incf i)))
          ;; Character literal: #\: must not be a package marker
          ((and (char= c #\#) (< (1+ i) n) (char= (char text (1+ i)) #\\))
           (write-char c out) (write-char #\\ out) (incf i 2)
           (when (< i n) (write-char (char text i) out) (incf i)))
          ;; Colon: replace it with a hyphen, so that foo:bar stays a
          ;; single token FOO-BAR. A keyword at the start of a token (:ok)
          ;; stays a keyword.
          ((char= c #\:)
           (let ((prev (and (> i 0) (char text (1- i)))))
             (cond
               ;; A leading colon = a keyword, unchanged.
               ;;
               ;; #\# MUST be in this list: #:foo is an uninterned symbol
               ;; name, not a package prefix. If the colon there became a
               ;; hyphen, #-foo arose — a read-time conditional that
               ;; silently skips the next form. In a defpackage form that
               ;; swallowed half the export list and reported a surplus
               ;; paren at the end of the file.
               ((or (null prev)
                    (member prev '(#\Space #\Tab #\Newline #\( #\) #\' #\#)))
                (write-char c out) (incf i))
               (t
                (if (and (< (1+ i) n) (char= (char text (1+ i)) #\:))
                    (incf i 2)
                    (incf i))
                (write-char #\- out)))))
          (t (write-char c out) (incf i)))))
    (get-output-stream-string out)))

(defun read-forms-from-string (text)
  (with-input-from-string (in text)
    ;; A package of our own, so that the file's symbols overwrite
    ;; nothing, and *read-eval* off: #. must execute nothing while
    ;; checking.
    (let ((*package* (make-package (gensym "LC") :use '(:cl)))
          (*read-eval* nil)
          (forms '()))
      (loop for form = (read in nil :eof)
            until (eq form :eof)
            do (push form forms))
      (nreverse forms))))

(defun file-text (path)
  (with-open-file (in path :external-format :utf-8)
    (let ((s (make-string (file-length in))))
      (subseq s 0 (read-sequence s in)))))

(defun read-all (path)
  "Reads PATH form by form. Directly first; if that fails on foreign
packages, then from a copy without package prefixes."
  (let ((text (handler-case (file-text path)
                (error (e)
                  (problem "~A is not readable: ~A" (file-namestring path) e)
                  nil))))
    (when text
      (handler-case (read-forms-from-string text)
        (error ()
          (handler-case (read-forms-from-string (strip-package-markers text))
            (error (e)
              (problem "~A cannot be read: ~A" (file-namestring path) e)
              nil)))))))

;;; --- Stufe 2: Gestalt ------------------------------------------------

(defun head-name (form)
  (and (consp form) (symbolp (first form)) (symbol-name (first form))))

(defun clause-p (c)
  "Does C look like a handler-case clause? (TYPE (VAR) ...) or (TYPE () ...)"
  (and (consp c) (symbolp (first c)) (listp (second c))))

(defun check-shape (form path)
  "Checks handler-case/handler-bind for the presence of clauses and
descends further. The clauses themselves are NOT counted as calls —
otherwise every correct clause reports an error."
  (when (consp form)
    (let ((head (head-name form)))
      (cond
        ((and head (string= head "HANDLER-CASE"))
         (let ((clauses (cddr form)))
           (if (null clauses)
               ;; Exactly the bug from v72.
               (problem "~A: handler-case without a clause — one paren too ~
                         many? The clause has slipped into the protected form ~
                         and becomes a function call there." path)
               (dolist (c clauses)
                 (unless (clause-p c)
                   (problem "~A: unusable handler-case clause: ~S" path c))))
           ;; Check the protected form, skip the clause heads.
           (check-shape (second form) (format nil "~A/protected" path))
           (loop for c in clauses for i from 0
                 do (dolist (body-form (cddr c))
                      (check-shape body-form (format nil "~A/klausel~D" path i))))))
        ((and head (string= head "HANDLER-BIND"))
         (let ((bindings (second form)))
           (unless (and (listp bindings) bindings)
             (problem "~A: handler-bind without a binding" path)))
         (dolist (x (cddr form)) (check-shape x path)))
        (t
         ;; Suspicious: (ERROR (X) ...) as an ordinary call. That is what
         ;; a slipped clause looks like when it ends up in the body.
         (when (and head (string= head "ERROR")
                    (consp (second form))
                    (= 1 (length (second form)))
                    (symbolp (first (second form)))
                    (not (keywordp (first (second form)))))
           (problem "~A: (error (~A) ...) stands as a call, not as a clause"
                    path (first (second form))))
         (when (listp (cdr (last form)))   ; only walk proper lists
           (loop for x in form for i from 0
                 do (check-shape x (format nil "~A/~D" path i)))))))))

(defun check-file-shape (path)
  (let ((forms (read-all path)))
    (loop for form in forms for i from 1
          do (check-shape
              form
              (format nil "~A Form~D~@[ ~A~]"
                      (file-namestring path) i
                      (and (consp form) (symbolp (second form)) (second form)))))
    (format t "~&  ~A: ~D Formen gelesen.~%" (file-namestring path) (length forms))))

;;; --- Stufe 3: Laden --------------------------------------------------

;;; --- Stage 4: compile -------------------------------------------------
;;;
;;; LOAD of a source file catches compile errors itself: the compiler
;;; reports "caught ERROR" onto the stream, replaces the form with a stub
;;; that only blows up when CALLED — and LOAD returns successfully. That
;;; is exactly how (let ((pi 0)) ...) got through stage 3: PI is a
;;; constant, the file was readable, well shaped and "loaded", and yet
;;; every completion returned nothing but "Execution of a form compiled
;;; with errors".
;;;
;;; COMPILE-FILE returns FAILURE-P and is therefore the honest gate.
;;; STYLE-WARNINGs do not set it — so the intended redefinition of
;;; COMPLETIONS-FOR-REPL stays permitted.

(defun check-compile (path)
  (let ((out (merge-pathnames (format nil "loadcheck-~A.fasl" (pathname-name path))
                              #p"/tmp/")))
    (multiple-value-bind (fasl warnings-p failure-p)
        (handler-bind ((style-warning #'muffle-warning))
          (handler-case (compile-file path :output-file out :verbose nil :print nil)
            (error (e)
              (problem "~A cannot be compiled: ~A" (file-namestring path) e)
              (values nil t t))))
      (declare (ignore warnings-p))
      (when failure-p
        (problem "~A compiles with an error or a serious warning"
                 (file-namestring path)))
      (unless failure-p
        (format t "~&  ~A compiles cleanly.~%" (file-namestring path)))
      (when fasl (ignore-errors (delete-file fasl))))))

(defun check-load (path)
  (let ((styles 0))
    (handler-bind
        ((style-warning (lambda (c)
                          (incf styles)
                          (format t "~&  Stilwarnung: ~A~%" c)
                          (muffle-warning c)))
         ;; A WARNING without STYLE- is serious: an undefined variable, a
         ;; type error, a contradictory declaration. This is exactly where
         ;; "undefined variable: E" would have struck.
         (warning (lambda (c)
                    (problem "~A loads with a warning: ~A" (file-namestring path) c)
                    (muffle-warning c))))
      (handler-case (load path)
        (error (e) (problem "~A cannot be loaded: ~A"
                            (file-namestring path) e))))
    (format t "~&  ~A geladen, ~D Stilwarnung(en).~%" (file-namestring path) styles)))

;;; --- Hauptteil -------------------------------------------------------

(let* ((here (directory-namestring *load-truename*))
       (rpc (merge-pathnames "rpc.lisp" here))
       (others (remove-if (lambda (p) (equal (pathname-name p) "rpc"))
                          (directory (merge-pathnames "*.lisp" here)))))
  (format t "~&Checking shape …~%")
  (check-file-shape rpc)
  (dolist (p others) (check-file-shape p))
  ;; Like rpc.lisp, completion.lisp and autodoc.lisp are free of CLAMPS,
  ;; Swank and Incudine and build only on rpc.lisp. They MUST be checked
  ;; here as well: (let ((pi 0)) ...) is readable and well shaped, but a
  ;; compile error — stages 1 and 2 see nothing of it.
  ;;
  ;; Compiling comes BEFORE loading. The other way round, autodoc.lisp
  ;; executed (export '(autodoc-for-repl)) while loading, and the later
  ;; compilation of rpc.lisp then reported a package discrepancy against
  ;; its own DEFPACKAGE — a warning produced solely by the order of the
  ;; checks, saying nothing about the files.
  (let ((extras (remove nil
                        (mapcar (lambda (name)
                                  (let ((p (merge-pathnames
                                            (concatenate 'string name ".lisp") here)))
                                    (and (probe-file p) p)))
                                '("completion" "autodoc")))))
    (format t "~&Checking compilation …~%")
    (check-compile rpc)
    (dolist (p extras) (check-compile p))
    (format t "~&Checking loading …~%")
    (check-load rpc)
    (dolist (p extras) (check-load p)))
  (if (zerop *problems*)
      (format t "~&ok — Lisp loads cleanly and without slipped clauses.~%")
      (format t "~&~D Problem(e).~%" *problems*))
  (sb-ext:exit :code (if (zerop *problems*) 0 1)))
