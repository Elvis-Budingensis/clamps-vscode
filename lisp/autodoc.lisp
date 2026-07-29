;;;; Additive Autodoc-Unterstuetzung. rpc.lisp bleibt unveraendert.
(in-package :clamps-bridge-rpc)

(export '(autodoc-for-repl))

(defun %autodoc-lambda-list (sym)
  (when (and sym (fboundp sym))
    (or (ignore-errors
          (let ((fn (find-symbol "FUNCTION-LAMBDA-LIST" :sb-introspect)))
            (and fn (fboundp fn) (funcall fn (fdefinition sym)))))
        (ignore-errors
          (multiple-value-bind (lambda-expr closure-p name)
              (function-lambda-expression (fdefinition sym))
            (declare (ignore closure-p name))
            (and (consp lambda-expr) (eq (first lambda-expr) 'lambda)
                 (second lambda-expr)))))))

(defun %autodoc-doc (sym)
  (or (ignore-errors (documentation sym 'function))
      (ignore-errors (documentation sym 'compiler-macro))
      (ignore-errors (documentation sym 'setf))))

(defun %autodoc-param-labels (lambda-list)
  (let ((out nil))
    (dolist (item lambda-list (nreverse out))
      (cond
        ((member item '(&optional &rest &body &key &allow-other-keys &aux
                        &whole &environment) :test #'eq)
         (push (string-downcase (symbol-name item)) out))
        ((symbolp item) (push (string-downcase (symbol-name item)) out))
        ((consp item)
         (let ((head (first item)))
           (push (cond
                   ((symbolp head) (string-downcase (symbol-name head)))
                   ((and (consp head) (symbolp (first head)))
                    (string-downcase (symbol-name (first head))))
                   (t (let ((*print-case* :downcase) (*print-pretty* nil))
                        (prin1-to-string item))))
                 out)))))))

(defun autodoc-for-repl (symbol-string package-name)
  "Liefert (:ok LABEL PARAMETER DOC) fuer LSP Signature Help."
  (handler-case
      (let* ((pkg (or (find-package (string-upcase package-name))
                      (find-package :common-lisp-user)))
             (sym (resolve-symbol symbol-string pkg)))
        (unless (and sym (fboundp sym))
          (return-from autodoc-for-repl (list :error "No function definition.")))
        (let* ((ll (%autodoc-lambda-list sym))
               (name (let ((*print-case* :downcase))
                       (princ-to-string sym)))
               (label (if ll
                          (format nil "(~A~{ ~A~})" name
                                  (mapcar (lambda (x)
                                            (let ((*print-case* :downcase)
                                                  (*print-pretty* nil))
                                              (prin1-to-string x))) ll))
                          (format nil "(~A ...)" name)))
               (params (if ll (%autodoc-param-labels ll) nil))
               (doc (%autodoc-doc sym)))
          (list :ok label params (or doc ""))))
    (error (e) (list :error (princ-to-string e)))))
