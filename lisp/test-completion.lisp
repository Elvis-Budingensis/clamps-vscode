(load (merge-pathnames "rpc.lisp" (or *load-truename* *default-pathname-defaults*)))
(load (merge-pathnames "completion.lisp" (or *load-truename* *default-pathname-defaults*)))
(in-package :clamps-bridge-rpc)
(flet ((labels-of (prefix context)
         (mapcar #'first (third (completions-for-repl prefix "COMMON-LISP-USER" context)))))
  (assert (member "mapcar" (labels-of "mc" "(mc") :test #'string=))
  (assert (member ":test" (labels-of ":te" "(:te") :test #'string=))
  (assert (member "my-value" (labels-of "mv" "(let ((my-value 1)) mv") :test #'string=)))
;; APROPOS shares %SYM-KIND with the completion. There it said
;; (string-downcase (symbol-name kind)) — but %SYM-KIND returns an LSP
;; NUMBER. APROPOS therefore returned nothing but
;; (:error "The value 3 is not of type SYMBOL") on EVERY query. The
;; handler-case swallowed the error, so in operation it only showed up as
;; an empty list.
(let ((r (apropos-for-repl "mapcar" "COMMON-LISP-USER" nil)))
  (assert (eq :ok (first r)))
  (assert (second r))
  (let ((hit (find "common-lisp::mapcar" (second r)
                   :key (lambda (e) (getf e :label)) :test #'string=)))
    (assert hit)
    (assert (string= "function" (getf hit :description)))))
(assert (string= "macro" (%sym-kind-label (%sym-kind 'when))))
(assert (string= "kind-99" (%sym-kind-label 99)))

;; The signature contract: handle-completion in bridge-server.lisp ALWAYS
;; sends three arguments. The base version in rpc.lisp took only two, so
;; every completion failed with "invalid number of arguments: 3" as soon
;; as completion.lisp was not loaded — without an error message in the
;; editor, simply no suggestions arrived. Both versions have to accept
;; three arguments, and "map" has to contain "mapcar".
(let ((r (completions-for-repl "map" "COMMON-LISP-USER" "(map")))
  (assert (eq :ok (first r)))
  (assert (member "mapcar" (third r) :key #'first :test #'string=)))


;;; ------------------------------------------------------------------
;;; v81.14 — Parser, Scope, &key-Kontext, Rangfolge
;;; ------------------------------------------------------------------

(flet ((labels-of (prefix context)
         (mapcar #'first (third (completions-for-repl prefix "COMMON-LISP-USER" context))))
       (rank-of (label prefix context)
         (position label (mapcar #'first (third (completions-for-repl prefix "COMMON-LISP-USER" context)))
                   :test #'string=)))

  ;; The tokenizer must not let strings, comments or character literals
  ;; slip it a paren.  That is exactly where the old window heuristic
  ;; failed.
  (multiple-value-bind (tree open) (%completion-tokenize "(foo \"( bar\" ; (baz
 #\\( qu")
    (declare (ignore tree))
    (assert (= 1 (length open)))
    (assert (string= "foo" (first (first open))))
    ;; foo, the string, the character literal, "qu" — the parens inside
    ;; them do not count.
    (assert (string= "qu" (first (last (first open))))))

  ;; Unclosed forms are the normal case and yield the chain of forms the
  ;; cursor stands in.
  (multiple-value-bind (tree open) (%completion-tokenize "(defun f (x) (let ((y 1)) (+ y ")
    (declare (ignore tree))
    (assert (= 3 (length open)))
    (assert (string= "defun" (first (first open))))
    (assert (string= "+" (first (third open)))))

  ;; Operator position now comes from the parser, not from a backwards
  ;; search for the nearest paren.
  (assert (%completion-head-position-p (nth-value 1 (%completion-tokenize "(map"))))
  (assert (%completion-head-position-p (nth-value 1 (%completion-tokenize "(foo (bar"))))
  (assert (not (%completion-head-position-p (nth-value 1 (%completion-tokenize "(mapcar #'car li")))))

  ;; Incudine forms bind.  Up to v81.13 the scanner did not know dsp!
  ;; parameters and with-samples variables at all.
  (let ((ctx "(dsp! simple (freq amp)
  (with-samples ((in (sine freq amp 0)))
    (out i"))
    (assert (member "in" (labels-of "i" ctx) :test #'string=))
    (assert (member "freq" (labels-of "f" ctx) :test #'string=))
    (assert (member "amp" (labels-of "a" ctx) :test #'string=)))

  ;; Weitere Binder.
  (assert (member "acc" (labels-of "ac" "(labels ((helper (acc) ac") :test #'string=))
  (assert (member "helper" (labels-of "he" "(labels ((helper (acc) 1)) (he") :test #'string=))
  (assert (member "item" (labels-of "it" "(dolist (item xs) it") :test #'string=))
  (assert (member "quotient" (labels-of "qu" "(multiple-value-bind (quotient rem) (floor 3 2) qu") :test #'string=))
  (assert (member "row" (labels-of "ro" "(loop for row in rows do (print ro") :test #'string=))

  ;; &-markers and keywords are not variable names.
  (let ((found (labels-of "" "(defun f (a &optional b) ")))
    (assert (not (member "&optional" found :test #'string=))))

  ;; Names from the scope rank above names from neighbouring forms.
  (let ((ctx "(defun one (alpha) alpha)
(defun two (alphabet) alph"))
    (let ((in-scope (rank-of "alphabet" "alph" ctx))
          (nearby (rank-of "alpha" "alph" ctx)))
      (assert in-scope)
      (assert nearby)
      (assert (< in-scope nearby)
              () "The scope name ranked at ~D, the neighbouring one at ~D." in-scope nearby)))

  ;; &key parameters of the enclosing form come right at the top and
  ;; carry a detail saying where they come from.
  (let ((items (third (completions-for-repl ":el" "COMMON-LISP-USER" "(make-array 3 :el"))))
    (assert items)
    (assert (string= ":element-type" (first (first items))))
    (assert (search "make-array" (third (first items)))))

  ;; With an empty symbol part, exclusively the &key names arrive —
  ;; otherwise the space trigger would be unusable.
  (let ((result (completions-for-repl "" "COMMON-LISP-USER" "(make-array 3 ")))
    (assert (second result) () "An empty prefix must report isIncomplete.")
    (let ((found (mapcar #'first (third result))))
      (assert (member ":element-type" found :test #'string=))
      (assert (not (member "mapcar" found :test #'string=))
              () "An empty prefix must send no symbols.")))

  ;; Without &key parameters the space trigger stays quiet.
  (assert (null (third (completions-for-repl "" "COMMON-LISP-USER" "(car "))))

  ;; At operator position, keywords are not a sensible suggestion.
  (assert (null (third (completions-for-repl "" "COMMON-LISP-USER" "(make-array ("))))

  ;; Word starts count: "mvb" has to find multiple-value-bind, and to do
  ;; so ahead of symbols in which m, v and b merely occur by chance.
  (let ((rank (rank-of "multiple-value-bind" "mvb" "(mvb")))
    (assert rank () "mvb does not find multiple-value-bind.")
    (assert (< rank 5) () "multiple-value-bind only ranked at ~D." rank))

  ;; v81.15 — visibility at the binding site.
  ;; Under LET the value of the second binding is computed in the outer
  ;; scope, so ALPHA is not yet visible there.
  (assert (not (member "alpha" (labels-of "al" "(let ((alpha 1) (beta al") :test #'string=))
          () "LET must not offer ALPHA inside the binding list.")
  ;; Under LET* it is.
  (assert (member "alpha" (labels-of "al" "(let* ((alpha 1) (beta al") :test #'string=)
          () "LET* must offer ALPHA inside the binding list.")
  ;; Incudine's WITH-SAMPLES binds sequentially like LET*.
  (assert (member "car1" (labels-of "ca" "(with-samples ((car1 (sine 330)) (mod (* car1 ca") :test #'string=))
  ;; In the body all the names are visible under both.
  (assert (member "alpha" (labels-of "al" "(let ((alpha 1) (beta 2)) al") :test #'string=))
  ;; In its own lambda list nothing is bound yet.
  (assert (not (member "alpha" (labels-of "al" "(defun f (alpha al") :test #'string=))
          () "A lambda list must not offer its own names yet.")
  ;; In the body it is after all.
  (assert (member "alpha" (labels-of "al" "(defun f (alpha) al") :test #'string=))

  ;; Package-qualified prefixes still distinguish external from internal.
  (assert (member "common-lisp:mapcar" (labels-of "common-lisp:mapc" "(common-lisp:mapc")
                  :test #'string=)))

(format t "completion tests ok~%")
