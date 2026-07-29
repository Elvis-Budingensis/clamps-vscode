;;;; completion.lisp — an additive, SLY-like completion extension.
;;;;
;;;; This file overrides COMPLETIONS-FOR-REPL from rpc.lisp and nothing
;;;; else. The original stays unchanged and can be restored at any time by
;;;; removing this LOAD line.

(in-package :clamps-bridge-rpc)

(defparameter *completion-fuzzy-limit* 300)

;; In Common Lisp there is no \t / \n / \r inside strings — "\t\r\n"
;; would literally be "trn" and would have treated t, r and n as
;; separators. Hence real character objects.
(defparameter *completion-whitespace*
  (coerce (list #\Space #\Tab #\Return #\Newline #\Page) 'string))

(defun %completion-space-p (c)
  (and c (find c *completion-whitespace*)))

(defun %completion-segment-hits (pattern name)
  "How many characters from PATTERN hit the start of a word in NAME.

The start of a word means: position 0, or directly after - / * / % / +."
  (let ((hits 0) (pidx 0) (len (length name)))
    (loop for i from 0 below len
          while (< pidx (length pattern))
          do (let ((boundary (or (zerop i) (find (char name (1- i)) "-*%+"))))
               (when (and boundary (char= (char name i) (char pattern pidx)))
                 (incf hits)
                 (incf pidx))))
    hits))

(defun %completion-subsequence-score (pattern name)
  "Fuzzy score; smaller values are better, NIL means no match."
  (let ((p (string-downcase pattern)) (n (string-downcase name)))
    (cond
      ((zerop (length p)) 1000)
      ((%prefix-match-p n p) (- (length n) (length p)))
      (t
       ;; No binding of CL:PI / CL:FIRST / CL:LAST — PI is a constant and
       ;; the COMMON-LISP package is locked.
       (let ((pidx 0) (hit-first nil) (hit-last nil) (gaps 0))
         (loop for ni from 0 below (length n)
               while (< pidx (length p))
               when (char= (char p pidx) (char n ni))
                 do (unless hit-first (setf hit-first ni))
                    (when hit-last (incf gaps (max 0 (1- (- ni hit-last)))))
                    (setf hit-last ni)
                    (incf pidx))
         (when (= pidx (length p))
           ;; Hits at the start of a segment count for more: "mvb" should
           ;; find multiple-value-bind and not some symbol in which m, v
           ;; and b happen to occur in that order.
           (let ((segment-hits (%completion-segment-hits p n)))
             (+ 100 (* 4 (or hit-first 0)) (* 3 gaps)
                (- (length n) (length p))
                (* -8 segment-hits)))))))))

(defun %completion-tokenize (source)
  "Break SOURCE into a tree of forms without troubling the reader.

Returns: (values TREE OPEN-CHAIN).  TREE contains the completed forms,
OPEN-CHAIN the forms still open at the end of SOURCE, from the outside
in.  Since SOURCE ends at the cursor, that last chain is exactly the path
of the forms the cursor stands in.

A node is either a string (an atom) or a list (a form).  Strings, line
comments and character literals are skipped, so that a \"(\" in the text
opens no form.  Half-finished input is the normal case and not an error."
  (let* ((len (length source))
         (stack (list (cons :root '())))
         (i 0))
    (labels ((add (node) (push node (cdr (first stack)))))
      (loop while (< i len) do
        (let ((c (char source i)))
          (cond
            ((char= c #\;)
             (loop while (and (< i len) (char/= (char source i) #\Newline))
                   do (incf i)))
            ((char= c #\")
             (incf i)
             (loop while (< i len)
                   do (cond ((char= (char source i) #\\) (incf i 2))
                            ((char= (char source i) #\") (incf i) (return))
                            (t (incf i))))
             (add ""))
            ((and (char= c #\#) (< (1+ i) len) (char= (char source (1+ i)) #\\))
             (incf i (min 3 (- len i)))
             (add ""))
            ((char= c #\()
             (push (cons :form '()) stack)
             (incf i))
            ((char= c #\))
             (incf i)
             (when (cdr stack)
               (let ((done (pop stack)))
                 (add (nreverse (cdr done))))))
            ((%completion-space-p c) (incf i))
            ((find c "'`,@#") (incf i))
            (t
             (let ((start i))
               (loop while (and (< i len)
                                (not (%completion-space-p (char source i)))
                                (not (find (char source i) "()\";'`,")))
                     do (incf i))
               (add (subseq source start i))))))))
    (values (reverse (cdr (first (last stack))))
            (reverse (mapcar (lambda (node) (reverse (cdr node)))
                             (butlast stack))))))

(defparameter *completion-binding-forms*
  '(("let" . :bindings) ("let*" . :bindings) ("symbol-macrolet" . :bindings)
    ("with-samples" . :bindings) ("with" . :bindings)
    ("with-slots" . :bindings) ("with-accessors" . :bindings)
    ("do" . :bindings) ("do*" . :bindings) ("prog" . :bindings) ("prog*" . :bindings)
    ("multiple-value-bind" . :lambda-list) ("destructuring-bind" . :lambda-list)
    ("lambda" . :lambda-list)
    ("flet" . :fbindings) ("labels" . :fbindings) ("macrolet" . :fbindings)
    ("defun" . :named-lambda) ("defmacro" . :named-lambda)
    ("dsp!" . :named-lambda) ("define-vug" . :named-lambda)
    ("define-vug-macro" . :named-lambda) ("define-ugen" . :named-lambda)
    ("dolist" . :iteration) ("dotimes" . :iteration)
    ("loop" . :loop))
  "Forms from which lexical names are taken.

The Incudine forms have equal standing here: in a dsp! body, FREQ, AMP
and the with-samples variables are the names one actually types.  Up to
v81.13 the scanner did not know them.")

(defparameter *completion-sequential-binders*
  '("let*" "with-samples" "with" "do*" "prog*")
  "Binders whose names are already visible in the following init forms.

Incudine's WITH-SAMPLES and WITH bind sequentially like LET*, not in
parallel like LET.")

(defun %completion-atom-p (node) (stringp node))

(defun %completion-clean-name (token)
  "Nil for anything that is not a usable lexical name."
  (let ((s (string-downcase (or token ""))))
    (cond ((zerop (length s)) nil)
          ((char= (char s 0) #\&) nil)      ; &optional, &key, &rest
          ((find #\: s) nil)                ; keywords and qualified symbols
          ((every #'digit-char-p s) nil)
          ((string= s "nil") nil)
          ((string= s "t") nil)
          (t s))))

(defun %completion-lambda-list-names (node)
  "Names from a lambda list; &-markers and default values are left out."
  (when (listp node)
    (let ((out '()) (skip nil))
      (dolist (item node (nreverse out))
        (cond ((and (%completion-atom-p item)
                    (plusp (length item))
                    (char= (char item 0) #\&))
               ;; After &aux and &environment come no user names one would
               ;; want to complete.
               (setf skip (member (string-downcase item) '("&aux" "&environment")
                                  :test #'string=)))
              (skip nil)
              ((%completion-atom-p item)
               (let ((n (%completion-clean-name item))) (when n (push n out))))
              ;; (var default) or ((:key var) default)
              ((and (consp item) (%completion-atom-p (first item)))
               (let ((n (%completion-clean-name (first item)))) (when n (push n out))))
              ((and (consp item) (consp (first item))
                    (%completion-atom-p (second (first item))))
               (let ((n (%completion-clean-name (second (first item)))))
                 (when n (push n out)))))))))

(defun %completion-binding-list-names (node)
  "Names from a LET-like binding list."
  (when (listp node)
    (let ((out '()))
      (dolist (binding node (nreverse out))
        (let ((token (cond ((%completion-atom-p binding) binding)
                           ((and (consp binding) (%completion-atom-p (first binding)))
                            (first binding)))))
          (let ((n (and token (%completion-clean-name token))))
            (when n (push n out))))))))

(defun %completion-form-names (form)
  "Names that FORM itself binds.  FORM is a parsed node."
  (let* ((head (and (consp form) (%completion-atom-p (first form))
                    (string-downcase (first form))))
         (rule (and head (cdr (assoc head *completion-binding-forms* :test #'string=)))))
    (case rule
      (:bindings (%completion-binding-list-names (second form)))
      (:lambda-list (%completion-lambda-list-names (second form)))
      (:named-lambda (%completion-lambda-list-names (third form)))
      (:iteration (and (consp (second form))
                       (let ((n (and (%completion-atom-p (first (second form)))
                                     (%completion-clean-name (first (second form))))))
                         (and n (list n)))))
      (:fbindings
       (let ((out '()))
         (dolist (binding (second form) (nreverse out))
           (when (consp binding)
             (let ((n (and (%completion-atom-p (first binding))
                           (%completion-clean-name (first binding)))))
               (when n (push n out)))
             (dolist (a (%completion-lambda-list-names (second binding)))
               (push a out))))))
      (:loop
       ;; LOOP has no binding list but keywords.
       (let ((out '()) (take nil))
         (dolist (item form (nreverse out))
           (cond ((and (%completion-atom-p item)
                       (member (string-downcase item) '("for" "with" "and")
                               :test #'string=))
                  (setf take t))
                 (take
                  (let ((n (and (%completion-atom-p item) (%completion-clean-name item))))
                    (when n (push n out)))
                  (setf take nil))))))
      (t nil))))

(defun %completion-collect-names (node)
  "All binding names in the subtree NODE."
  (let ((out (copy-list (%completion-form-names node))))
    (when (consp node)
      (dolist (child node)
        (when (consp child)
          (setf out (nconc out (%completion-collect-names child))))))
    out))

(defun %completion-attach-open (open-chain)
  "Attach every open form as the last child of its parent form.

The tokenizer only enters children into the parent form when it closes.
Forms that are still open are therefore missing there — and those are
precisely the ones containing the cursor.  At \"(labels ((helper (acc) ac\"
the binding list would otherwise be empty and neither HELPER nor ACC
would come out as a candidate."
  (let ((reversed (reverse open-chain))
        (built '()))
    (dolist (form reversed built)
      (setf built (cons (if built (append form (list (first built))) form)
                        built)))))

(defun %completion-open-scope-names (open-chain)
  "Names of the forms containing the cursor — respecting the binding site.

Up to v81.14 every name of an enclosing binding form counted as visible,
even when the cursor was still inside the binding list itself.  In

  (let ((alpha 1) (beta al

ALPHA is precisely NOT visible under LET — the value of BETA is computed
in the outer scope.  Under LET* and under Incudine's WITH-SAMPLES it is.
This function tells the two apart."
  (let ((augmented (%completion-attach-open open-chain))
        (out '()))
    (loop for rest on open-chain
          for aug in augmented
          for raw = (first rest)
          for deeper = (second rest)
          do (let* ((head (and (consp raw) (%completion-atom-p (first raw))
                               (string-downcase (first raw))))
                    (rule (and head (cdr (assoc head *completion-binding-forms*
                                                :test #'string=))))
                    ;; At which argument position does the binding or
                    ;; lambda list stand?  For LET and LAMBDA at 1, for
                    ;; DEFUN and dsp! at 2 (the name comes first there).
                    ;; FLET, LABELS and LOOP are left out: there the cursor
                    ;; in the binding list is already in the body of a
                    ;; local function whose parameters are visible.
                    (binding-index (case rule
                                     ((:bindings :lambda-list :iteration) 1)
                                     (:named-lambda 2)
                                     (t nil)))
                    (in-binding-part (and deeper binding-index
                                          (= (length raw) binding-index))))
               (cond
                 ((null rule))
                 ((not in-binding-part)
                  (setf out (nconc out (copy-list (%completion-form-names aug)))))
                 ((and (eq rule :bindings)
                       (member head *completion-sequential-binders* :test #'string=))
                  ;; A sequential binder: the earlier bindings that are
                  ;; already complete are visible, the one currently being
                  ;; typed is not yet.
                  (setf out (nconc out (%completion-binding-list-names deeper))))
                 (t
                  ;; A parallel binder or a lambda list: nothing from this
                  ;; form is visible yet.
                  nil))))
    out))

(defun %completion-local-names (source)
  "Lexical names from SOURCE.

Returns: (values IN-SCOPE NEARBY).  IN-SCOPE comes from the forms the
cursor actually stands in, NEARBY from completed forms in the same
window.  The separation is the point: up to v81.13 both got the same
strong bonus, and a call head picked up by chance from a long-closed form
ranked above the right symbol."
  (multiple-value-bind (tree open-chain) (%completion-tokenize (or source ""))
    (let ((in-scope '()) (nearby '()))
      (setf in-scope (%completion-open-scope-names open-chain))
      ;; Completed subforms in the same body can bind as well, an earlier
      ;; LET in the same DEFUN for instance.
      (dolist (form (%completion-attach-open open-chain))
        (dolist (child form)
          (when (consp child)
            (setf nearby (nconc nearby (%completion-collect-names child))))))
      (dolist (form tree)
        (when (consp form)
          (setf nearby (nconc nearby (%completion-collect-names form)))))
      (values (remove-duplicates in-scope :test #'string=)
              (set-difference (remove-duplicates nearby :test #'string=)
                              in-scope :test #'string=)))))

(defun %completion-enclosing-head (open-chain)
  "The operator of the innermost open form, or nil."
  (let ((innermost (first (last open-chain))))
    (and (consp innermost)
         (%completion-atom-p (first innermost))
         (plusp (length (first innermost)))
         (first innermost))))

(defun %completion-head-position-p (open-chain)
  "T when the cursor stands at operator position.

This used to be found by searching backwards for the nearest opening
paren.  The parser knows better: operator position means that the
innermost open form contains nothing yet apart from the prefix currently
being typed."
  (let ((innermost (first (last open-chain))))
    (and innermost (<= (length innermost) 1))))

(defun %completion-find-symbol (name package)
  (handler-case
      (multiple-value-bind (sym status) (find-symbol (string-upcase name) package)
        (and status sym))
    (error () nil)))

(defun %completion-keyword-parameters (head package)
  "The &key parameter names of HEAD's lambda list, in lower case.

This is the difference between \":\" plus the entire KEYWORD package and
what actually makes sense at this place."
  (handler-case
      (let ((sym (and head (%completion-find-symbol head package)))
            (introspect (find-symbol "FUNCTION-LAMBDA-LIST" :sb-introspect)))
        (when (and sym introspect (fboundp sym))
          (let ((out '()) (in-key nil))
            (dolist (item (funcall introspect sym) (nreverse out))
              (cond
                ((and (symbolp item) (plusp (length (symbol-name item)))
                      (char= (char (symbol-name item) 0) #\&))
                 (setf in-key (string-equal (symbol-name item) "&KEY")))
                ((not in-key))
                (t
                 (let ((name (cond ((symbolp item) (symbol-name item))
                                   ;; ((:keyword var) default)
                                   ((and (consp item) (consp (first item))
                                         (symbolp (first (first item))))
                                    (symbol-name (first (first item))))
                                   ;; (var default)
                                   ((and (consp item) (symbolp (first item)))
                                    (symbol-name (first item))))))
                   (when name (push (string-downcase name) out)))))))))
    (error () nil)))

(defun %completion-candidate-kind (sym local-p)
  (cond (local-p 6) ; Variable
        (t (%sym-kind sym))))

(defun completions-for-repl (prefix package-name &optional context)
  "Fuzzy, package- and context-aware completion.
CONTEXT is the source before the cursor (bounded by the bridge).

With an empty symbol part, deliberately ONLY the &key parameters of the
enclosing form are returned.  Otherwise half the image would have to come
after every space, and the space trigger would be unusable."
  (handler-case
      (destructuring-bind (pkg-part sym-part internal-p) (%split-prefix prefix)
        (multiple-value-bind (tree open-chain) (%completion-tokenize (or context ""))
          (declare (ignore tree))
          (let* ((home (or (find-package (string-upcase package-name))
                           (find-package :common-lisp-user)))
                 (target (if pkg-part (find-package pkg-part) home))
                 (head-p (%completion-head-position-p open-chain))
                 (enclosing (%completion-enclosing-head open-chain))
                 (keyword-context-p (or (null pkg-part)
                                        (string= pkg-part "KEYWORD")))
                 (arg-keywords (and keyword-context-p (not head-p)
                                    (%completion-keyword-parameters enclosing home)))
                 (empty-p (zerop (length sym-part)))
                 (rows '()) (seen (make-hash-table :test 'equal)))
            (multiple-value-bind (in-scope nearby)
                (if pkg-part (values nil nil) (%completion-local-names context))
              (labels ((label-for (name)
                         (let ((n (string-downcase name)))
                           (cond ((string= pkg-part "KEYWORD") (concatenate 'string ":" n))
                                 (pkg-part (concatenate 'string (string-downcase pkg-part)
                                                        (if internal-p "::" ":") n))
                                 (t n))))
                       (push-row (label kind detail doc score &optional sort-bias)
                         (unless (gethash label seen)
                           (setf (gethash label seen) t)
                           (push (list label kind detail doc (+ score (or sort-bias 0))) rows)))
                       (consider-symbol (sym)
                         (let* ((name (symbol-name sym))
                                (score (%completion-subsequence-score sym-part name)))
                           (when score
                             (let* ((kind (%sym-kind sym))
                                    ;; In Kopfposition Funktionen/Makros/Klassen vorziehen;
                                    ;; in Argumentposition Variablen/Konstanten.
                                    (bias (if head-p
                                              (if (member kind '(2 3 7 4)) -40 30)
                                              (if (= kind 6) -35 0))))
                               (push-row (label-for name) kind
                                         (or (%arglist sym) "")
                                         (or (%short-doc sym) "") score bias))))))
                ;; 1. &key parameters of the enclosing form.  At this place
                ;;    they are the only keywords that certainly fit.
                (dolist (name arg-keywords)
                  (let ((score (%completion-subsequence-score sym-part name)))
                    (when score
                      (push-row (concatenate 'string ":" name) 14
                                (format nil "&key of ~(~A~)" enclosing)
                                "" score -200))))
                (unless empty-p
                  ;; 2. Lexical names: those in scope first, then those
                  ;;    from neighbouring closed forms.
                  (dolist (name in-scope)
                    (let ((score (%completion-subsequence-score sym-part name)))
                      (when score (push-row name 6 "lexical (in scope)" "" score -100))))
                  (dolist (name nearby)
                    (let ((score (%completion-subsequence-score sym-part name)))
                      (when score (push-row name 6 "lexikalisch (benachbart)" "" score -20))))
                  ;; 3. Symbols of the target package.
                  (when target
                    (if (and pkg-part (not internal-p) (not (string= pkg-part "KEYWORD")))
                        (do-external-symbols (sym target) (consider-symbol sym))
                        (do-symbols (sym target) (consider-symbol sym)))))
                (setf rows (sort rows (lambda (a b)
                                        (if (= (fifth a) (fifth b))
                                            (string< (first a) (first b))
                                            (< (fifth a) (fifth b))))))
                (let* ((truncated (or empty-p (> (length rows) *completion-fuzzy-limit*)))
                       (limited (subseq rows 0 (min (length rows) *completion-fuzzy-limit*))))
                  ;; With an empty symbol part the result is deliberately
                  ;; incomplete: the client has to ask again after the next
                  ;; character instead of filtering locally on this subset.
                  (list :ok truncated
                        (mapcar (lambda (r) (subseq r 0 4)) limited))))))))
    (error (e)
      (list :ok nil (list (list (format nil "; completion error: ~A" e) 1 "" ""))))))
