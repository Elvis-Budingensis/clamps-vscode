;;;; test-bridge-context.lisp — the completion's context window.
;;;;
;;;; bridge-server.lisp cannot be loaded here: it needs usocket,
;;;; bordeaux-threads and a Swank connection. The test therefore fetches
;;;; exactly the functions in question out of the shipped file and
;;;; evaluates only those. That way the real source is checked and not a
;;;; copy that can drift apart.

(defpackage :bridge-context-test (:use :cl))
(in-package :bridge-context-test)

(defparameter *source-path*
  (merge-pathnames "bridge-server.lisp"
                   (or *load-truename* *default-pathname-defaults*)))

(defun file-text (path)
  (with-open-file (in path :external-format :utf-8)
    (let ((s (make-string (file-length in))))
      (subseq s 0 (read-sequence s in)))))

(defun form-source (text name)
  "The source of the top-level form beginning with NAME.

It searches for the string in column 0 and counts parens to the end of
the form. Strings and comments do not count."
  (let ((start (search name text)))
    (unless start
      (error "~A is not in bridge-server.lisp." name))
    (let ((depth 0) (i start) (n (length text)))
      (loop while (< i n) do
        (let ((c (char text i)))
          (cond ((char= c #\;)
                 (loop while (and (< i n) (char/= (char text i) #\Newline)) do (incf i)))
                ((char= c #\")
                 (incf i)
                 (loop while (< i n)
                       do (cond ((char= (char text i) #\\) (incf i 2))
                                ((char= (char text i) #\") (incf i) (return))
                                (t (incf i)))))
                ((and (char= c #\#) (< (1+ i) n) (char= (char text (1+ i)) #\\))
                 (incf i 3))
                ((char= c #\() (incf depth) (incf i))
                ((char= c #\))
                 (decf depth) (incf i)
                 (when (zerop depth) (return-from form-source (subseq text start i))))
                (t (incf i)))))
      (error "~A is not closed in bridge-server.lisp." name))))

(let ((text (file-text *source-path*)))
  (dolist (name '("(defparameter *completion-context-max-lines*"
                  "(defun nth-line"
                  "(defun completion-context-start-line"
                  ;; With the argument list, otherwise SEARCH hits
                  ;; COMPLETION-CONTEXT-START-LINE first and
                  ;; COMPLETION-CONTEXT would stay undefined.
                  "(defun completion-context (text"))
    (eval (read-from-string (form-source text name)))))

;;; --- Verhalten -------------------------------------------------------

(defparameter *doc*
  (format nil "~{~A~^~%~}"
          '("(in-package :clamps)"
            ""
            "(defun helper (x) x)"
            ""
            "(dsp! simple (freq amp)"
            "  (with-samples ((in (sine freq amp 0)))"
            "    (out in in)))")))

;; The context begins at the start of the enclosing top-level form, not
;; 120 lines before it and not at the start of the file.
(let ((ctx (completion-context *doc* 6 10)))
  (assert (eql 0 (search "(dsp! simple" ctx))
          () "The context does not begin at the dsp! form: ~S" ctx)
  (assert (not (search "helper" ctx))
          () "The context reaches into the previous top-level form: ~S" ctx))

;; The cursor cuts the last line off; nothing behind it comes along.
(let ((ctx (completion-context *doc* 6 10)))
  (assert (string= "    (out i" (subseq ctx (- (length ctx) 10)))
          () "Cursorzeile falsch abgeschnitten: ~S" ctx))

;; If the cursor itself is on the line with the paren in column 0, that
;; is the start.
(assert (= 4 (completion-context-start-line *doc* 4)))
(assert (= 4 (completion-context-start-line *doc* 6)))
(assert (= 2 (completion-context-start-line *doc* 3)))

;; A long form no longer loses its start. That was the point: with the
;; old window of 120 lines the parameters of a longer DEFUN fell out and
;; were no longer completed.
(let* ((filler (with-output-to-string (out)
                 (dotimes (i 300) (format out "  (progn ~D)~%" i))))
       (long (format nil "(defun big (alpha beta)~%~A  al" filler)))
  (let ((ctx (completion-context long 302 5)))
    (assert (search "alpha beta" ctx)
            () "Parameters of the long form are missing from the context.")))

;; Without a paren in column 0 the fallback cap takes effect, instead of
;; sending the whole file.
(let* ((lines (with-output-to-string (out)
                (dotimes (i 900) (format out "  x~D~%" i))))
       (start (completion-context-start-line lines 899)))
  (assert (= start (- 899 *completion-context-max-lines*))
          () "The fallback cap is not taking effect: ~D" start))

;; Empty lines and lines beyond the text must not throw.
(assert (stringp (completion-context "" 0 0)))
(assert (stringp (completion-context *doc* 99 5)))

(format t "bridge-context tests ok~%")
