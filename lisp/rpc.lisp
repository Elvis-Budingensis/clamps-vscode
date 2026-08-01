;;;; rpc.lisp — RPC functions for the VS Code bridge.
;;;;
;;;; Deliberately free of CLAMPS, Swank, Slynk and Incudine: what is in
;;;; here is only portable CL plus a few SBCL internals (sb-mop,
;;;; sb-kernel, sb-introspect). That makes it possible to load and test
;;;; the file against a bare SBCL without bringing up the whole audio
;;;; stack:
;;;;
;;;;   sbcl --load lisp/rpc.lisp
;;;;
;;;; bootstrap.lisp loads this file; the separation exists only so that
;;;; the tests do not depend on the process setup.

(in-package :cl-user)

;;; ---------------------------------------------------------------------
;;; Eval channel for the VS Code REPL
;;;
;;; The bridge calls CLAMPS-BRIDGE-EVAL over Swank RPC. Deliberately NOT
;;; using swank:listener-eval: that prints REPL side effects onto a
;;; stream bound to Emacs and is hard to tap cleanly from outside.
;;; Instead we capture stdout/stderr into a string, evaluate several
;;; consecutive forms (like a real REPL input with several expressions)
;;; and return values + output as ONE string. The function lives in the
;;; COMMON-LISP-USER package but is callable by its full name.
;;;
;;; Returns: a list (:ok \"<output+values>\" \"<package name>\") or
;;; (:error \"<error text>\" \"<package name>\"). The bridge translates
;;; that into the JSON {output, package} the TypeScript client expects.
;;; ---------------------------------------------------------------------

(defpackage :clamps-bridge-rpc
  (:use :cl)
  (:export #:eval-for-repl #:macroexpand-for-repl #:disassemble-for-repl
           #:find-definitions-for-repl #:inspect-for-repl
           #:trace-toggle-for-repl #:untrace-all-for-repl
           #:traced-for-repl #:untrace-one-for-repl
           #:rt-status-for-repl #:completions-for-repl
           #:inspect-id-for-repl #:inspect-part-for-repl
           #:inspect-release-for-repl #:inspect-set-part-for-repl
           #:eval-for-repl-debuggable #:incudine-node-tree-for-repl
           #:packages-for-repl #:classes-for-repl #:threads-for-repl
           #:xref-for-repl #:apropos-for-repl #:break-on-signals-for-repl
           #:set-function-breakpoints-for-repl
           #:indentation-rules-for-repl #:presentation-value
           #:asdf-operation-for-repl #:sticker-record-for-repl
           #:make-sticker-state-for-repl #:make-sticker-sample-state-for-repl
           #:register-sticker-state-for-repl
           #:sticker-state-record-for-repl #:sticker-state-record-sample-for-repl
           #:sticker-state-record-rms-for-repl
           #:sticker-samples-since-for-repl #:sticker-keys-for-repl
           #:sticker-spectrum-for-repl #:sticker-spectrogram-for-repl
           #:buffer-outline-for-repl #:ats-outline-for-repl
           #:ats-play-for-repl #:ats-stop-for-repl
           #:sample-browse-for-repl
           #:sticker-snapshot-for-repl #:sticker-clear-for-repl))
(in-package :clamps-bridge-rpc)

(defun %class-slot-names (class)
  (handler-case
      (mapcar (lambda (s)
                (funcall (find-symbol "SLOT-DEFINITION-NAME" :sb-mop) s))
              (funcall (find-symbol "CLASS-SLOTS" :sb-mop) class))
    (error () nil)))

(defun %struct-slot-names (obj)
  "Slot names of a structure instance.  (values NAMES NOTE).

The MOP first, SBCL internals only as a fallback.  Until 1.0.3 it was
the other way round and the chain went
%INSTANCE-LAYOUT -> LAYOUT-INFO -> DD-SLOTS -> DSD-NAME, wrapped in a
handler-case that returned NIL.  LAYOUT-INFO does not exist in SBCL
2.2.9 — it is called WRAPPER-INFO there — so find-symbol returned NIL,
funcall signalled, the handler swallowed it, and the inspector showed
every struct as having NO SLOTS.  Not an error message: an empty list of
parts, which looks exactly like a struct that really has no slots.  It
worked on the SBCL the code was written against and was wrong on the
next one, and nothing said so.

sb-mop:class-slots works for structure-class in SBCL and does not depend
on the internal naming.  The internal chain stays as a fallback, now
trying both spellings; and when everything fails, NOTE says so, so that
the display can report it instead of showing emptiness."
  (let ((mop (ignore-errors
               (let ((slots (funcall (find-symbol "CLASS-SLOTS" :sb-mop)
                                     (class-of obj))))
                 (mapcar (lambda (sd)
                           (funcall (find-symbol "SLOT-DEFINITION-NAME" :sb-mop)
                                    sd))
                         slots)))))
    (when mop (return-from %struct-slot-names (values mop nil))))
  ;; Fallback: the internal layout chain. LAYOUT-INFO up to about SBCL
  ;; 2.1, WRAPPER-INFO after it — try both rather than assume one.
  (dolist (info '("LAYOUT-INFO" "WRAPPER-INFO"))
    (dolist (layout '("%INSTANCE-LAYOUT" "%INSTANCE-WRAPPER"))
      (let ((names (ignore-errors
                     (let ((info-fn (find-symbol info :sb-kernel))
                           (layout-fn (find-symbol layout :sb-kernel))
                           (slots-fn (find-symbol "DD-SLOTS" :sb-kernel))
                           (name-fn (find-symbol "DSD-NAME" :sb-kernel)))
                       (when (and info-fn layout-fn slots-fn name-fn)
                         (mapcar (lambda (dsd) (funcall name-fn dsd))
                                 (funcall slots-fn
                                          (funcall info-fn
                                                   (funcall layout-fn obj)))))))))
        (when names (return-from %struct-slot-names (values names nil))))))
  (values nil (format nil "slot names not readable in SBCL ~A"
                      (lisp-implementation-version))))

(defun %package-qualified (sym)
  "Symbol name with package, so that slot-value finds it in the right package."
  (let ((pkg (symbol-package sym)))
    (if pkg
        (format nil "~A::~A" (string-downcase (package-name pkg))
                (string-downcase (symbol-name sym)))
        (string-downcase (symbol-name sym)))))

(defun %preview (val)
  "Short, single-line printed form for slot/element previews.
   Deliberately capped hard: the preview stands next to every entry in
   the list, so nothing there may wrap or print for minutes."
  (handler-case
      (let ((s (let ((*print-length* 6)
                     (*print-level* 2)
                     (*print-circle* t)
                     (*print-pretty* nil)
                     (*print-case* :downcase))
                 (prin1-to-string val))))
        (if (> (length s) 90)
            (concatenate 'string (subseq s 0 87) "...")
            s))
    (error () "#<not printable>")))

(defun %fn-name (fn)
  "Function name via SBCL internals. The candidates are version
   dependent: sb-impl::function-name no longer exists in newer SBCLs
   (>= 2.6), sb-kernel:%fun-name does. We try them in turn and return nil
   when none of them works — the meta line is then simply omitted."
  (dolist (cand '(("%FUN-NAME"    . :sb-kernel)
                  ("FUNCTION-NAME" . :sb-impl)
                  ("FUN-NAME"      . :sb-kernel))
           nil)
    (let ((r (handler-case
                 (let ((sym (find-symbol (car cand) (cdr cand))))
                   (when (and sym (fboundp sym))
                     (let ((n (funcall sym fn)))
                       (and n (let ((*print-case* :downcase))
                                (princ-to-string n))))))
               (error () nil))))
      (when r (return r)))))

;; sb-introspect is not in the image by default; without the require,
;; find-symbol does not even find the package and the lambda list is
;; silently missing.
(eval-when (:compile-toplevel :load-toplevel :execute)
  (handler-case (require :sb-introspect) (error () nil)))

(defun %fn-lambda-list (fn)
  (handler-case
      (let* ((sym (find-symbol "FUNCTION-LAMBDA-LIST" :sb-introspect))
             (ll (and sym (funcall sym fn))))
        (and ll (let ((*print-case* :downcase)) (princ-to-string ll))))
    (error () nil)))

(defvar +unbound+ (make-symbol "UNBOUND")
  "Unique marker for unbound slots. An uninterned symbol, so that it
   cannot be confused with any real value.")

(defun %inspect-describe (obj)
  "Describes OBJ per type. Returns (kind meta parts):

     kind  — category string for the client
     meta  — list of (key . value) strings, header information
     parts — list of (label value preview setter)

   VALUE is the real Lisp object, not an access expression; the
   inspector navigates over it without recomputing anything on a click.

   SETTER is a function (lambda (new-value) ...) or nil when the part is
   not writable. The alternative would have been to distinguish the
   setting by type once more in a second function — then there would be
   two typecase cascades that can drift apart. This way the mapping
   part -> write path lives in exactly one place.

   The order in the typecase matters: null before symbol/list, string
   before vector, vector before array, and package/pathname/random-state
   before structure-object (in SBCL those are defstructs)."
  (typecase obj
    (null
     (list "atom" (list (cons "note" "nil — the empty list and a symbol")) nil))

    (hash-table
     (let ((parts '()) (i 0) (truncated nil))
       (maphash (lambda (k v)
                  (if (< i 1000)
                      (progn
                        ;; k is bound freshly on each iteration, so the
                        ;; closure captures the right key.
                        (push (list (%preview k) v (%preview v)
                                    (lambda (new) (setf (gethash k obj) new)))
                              parts)
                        (incf i))
                      (setf truncated t)))
                obj)
       (list "hash-table"
             (append
              (list (cons "count" (princ-to-string (hash-table-count obj)))
                    (cons "test" (string-downcase
                                  (princ-to-string (hash-table-test obj)))))
              (when truncated (list (cons "showing" "first 1000"))))
             (nreverse parts))))

    (string
     (list "string"
           (list (cons "length" (princ-to-string (length obj)))
                 (cons "simple-p" (if (simple-string-p obj) "t" "nil")))
           nil))

    (package
     (list "package"
           (list (cons "name" (package-name obj))
                 (cons "nicknames"
                       (format nil "~{~A~^, ~}" (package-nicknames obj)))
                 (cons "use-list"
                       (format nil "~{~A~^, ~}"
                               (mapcar #'package-name (package-use-list obj)))))
           nil))

    (pathname
     ;; Pathnames are immutable — no setter.
     (list "pathname"
           (list (cons "namestring" (handler-case (namestring obj)
                                      (error () "—")))
                 (cons "name" (format nil "~A" (pathname-name obj)))
                 (cons "type" (format nil "~A" (pathname-type obj)))
                 (cons "exists-p" (if (probe-file obj) "t" "nil")))
           (list (list "directory" (pathname-directory obj)
                       (%preview (pathname-directory obj)) nil))))

    (random-state
     (list "atom" (list (cons "typ" "random-state")) nil))

    (standard-object
     (let* ((class (class-of obj))
            (slots (%class-slot-names class)))
       (list "object"
             (list (cons "class" (let ((*print-case* :downcase))
                                   (princ-to-string (class-name class))))
                   (cons "slots" (princ-to-string (length slots))))
             (loop for slot in slots
                   collect (let* ((sl slot)
                                  (bound (slot-boundp obj sl)))
                             (list (string-downcase (symbol-name sl))
                                   (if bound (slot-value obj sl) +unbound+)
                                   (if bound
                                       (%preview (slot-value obj sl))
                                       "#<unbound>")
                                   (lambda (new)
                                     (setf (slot-value obj sl) new))))))))

    (structure-object
     (multiple-value-bind (slots note) (%struct-slot-names obj)
       (list "struct"
             (append
              (list (cons "type" (let ((*print-case* :downcase))
                                   (princ-to-string (type-of obj))))
                    (cons "slots" (princ-to-string (length slots))))
              ;; A struct with no readable slots must say why. Without
              ;; this it is indistinguishable from a struct that has none.
              (when note (list (cons "warning" note))))
             (loop for slot in slots
                   collect (let ((sl slot))
                             (handler-case
                                 (let ((v (slot-value obj sl)))
                                   (list (string-downcase (symbol-name sl))
                                         v (%preview v)
                                         (lambda (new)
                                           (setf (slot-value obj sl) new))))
                               (error ()
                                 (list (string-downcase (symbol-name sl))
                                       +unbound+ "#<unbound>"
                                       (lambda (new)
                                         (setf (slot-value obj sl) new))))))))))

    (cons
     ;; Bounded traversal: tolerates dotted and circular lists.
     (let ((parts '()) (i 0) (tail obj))
       (loop while (and (consp tail) (< i 1000))
             do (let ((cell tail))   ; a fresh binding for the closure
                  (push (list (princ-to-string i) (car cell)
                              (%preview (car cell))
                              (lambda (new) (setf (car cell) new)))
                        parts))
                (incf i)
                (setf tail (cdr tail)))
       (when (and tail (not (consp tail)))
         (let ((lastcell (last obj)))
           (push (list "· cdr" tail (%preview tail)
                       (lambda (new) (setf (cdr lastcell) new)))
                 parts)))
       (list "list"
             (list (cons "length" (if (consp tail)
                                      (format nil "> ~A" i)
                                      (princ-to-string i)))
                   (cons "proper-p" (if (consp tail) "?" (if tail "nil" "t"))))
             (nreverse parts))))

    ((and vector (not string))
     (list "vector"
           (list (cons "length" (princ-to-string (length obj)))
                 (cons "element-type"
                       (let ((*print-case* :downcase))
                         (princ-to-string (array-element-type obj))))
                 (cons "fill-pointer"
                       (if (array-has-fill-pointer-p obj)
                           (princ-to-string (fill-pointer obj))
                           "—")))
           (loop for i from 0 below (min 1000 (length obj))
                 collect (let ((idx i))
                           (list (princ-to-string idx) (aref obj idx)
                                 (%preview (aref obj idx))
                                 (lambda (new) (setf (aref obj idx) new)))))))

    (array
     (list "array"
           (list (cons "dimensions" (format nil "~A" (array-dimensions obj)))
                 (cons "rank" (princ-to-string (array-rank obj)))
                 (cons "element-type"
                       (let ((*print-case* :downcase))
                         (princ-to-string (array-element-type obj)))))
           (loop for i from 0 below (min 1000 (array-total-size obj))
                 collect (let ((idx i))
                           (list (princ-to-string idx) (row-major-aref obj idx)
                                 (%preview (row-major-aref obj idx))
                                 (lambda (new)
                                   (setf (row-major-aref obj idx) new)))))))

    (symbol
     (list "symbol"
           (append
            (list (cons "name" (symbol-name obj))
                  (cons "package" (if (symbol-package obj)
                                      (package-name (symbol-package obj))
                                      "#:uninterned"))
                  (cons "boundp" (if (boundp obj) "t" "nil"))
                  (cons "fboundp" (if (fboundp obj) "t" "nil")))
            (let ((doc (or (documentation obj 'variable)
                           (documentation obj 'function))))
              (when doc (list (cons "documentation" doc)))))
           (append
            (when (boundp obj)
              (list (list "symbol-value" (symbol-value obj)
                          (%preview (symbol-value obj))
                          (lambda (new) (setf (symbol-value obj) new)))))
            (when (fboundp obj)
              ;; Deliberately no setter: overwriting a function definition
              ;; by accident through an input field would be too easy.
              (list (list "symbol-function" (symbol-function obj)
                          (%preview (symbol-function obj)) nil)))
            (when (symbol-plist obj)
              (list (list "symbol-plist" (symbol-plist obj)
                          (%preview (symbol-plist obj))
                          (lambda (new) (setf (symbol-plist obj) new))))))))

    (function
     (list "function"
           (append
            (let ((n (%fn-name obj))) (when n (list (cons "name" n))))
            (let ((ll (%fn-lambda-list obj)))
              (when ll (list (cons "lambda-list" ll))))
            (let ((doc (documentation obj 'function)))
              (when doc (list (cons "documentation" doc)))))
           nil))

    (integer
     (list "number"
           (list (cons "decimal" (format nil "~D" obj))
                 (cons "hex" (format nil "#x~X" obj))
                 (cons "octal" (format nil "#o~O" obj))
                 (cons "binary" (if (< (integer-length obj) 256)
                                    (format nil "#b~B" obj)
                                    "— too large —"))
                 (cons "integer-length"
                       (princ-to-string (integer-length obj))))
           nil))

    (ratio
     (list "number"
           (list (cons "numerator" (princ-to-string (numerator obj)))
                 (cons "denominator" (princ-to-string (denominator obj)))
                 (cons "float" (handler-case
                                   (princ-to-string (float obj 1.0d0))
                                 (error () "—"))))
           nil))

    (float
     (list "number"
           (append
            (list (cons "value" (princ-to-string obj))
                  (cons "type" (let ((*print-case* :downcase))
                                 (princ-to-string (type-of obj)))))
            (handler-case
                (multiple-value-bind (sig exp sign) (decode-float obj)
                  (list (cons "significand" (princ-to-string sig))
                        (cons "exponent" (princ-to-string exp))
                        (cons "sign" (princ-to-string sign))))
              (error () nil)))
           nil))

    (complex
     ;; Numbers are immutable — realpart and imagpart are read-only.
     (list "number"
           (list (cons "realpart" (%preview (realpart obj)))
                 (cons "imagpart" (%preview (imagpart obj))))
           (list (list "realpart" (realpart obj) (%preview (realpart obj)) nil)
                 (list "imagpart" (imagpart obj) (%preview (imagpart obj)) nil))))

    (character
     (list "character"
           (list (cons "char-code" (princ-to-string (char-code obj)))
                 (cons "hex" (format nil "#x~X" (char-code obj)))
                 (cons "name" (or (char-name obj) (string obj))))
           nil))

    (t (list "atom" nil nil))))

;;; ---------------------------------------------------------------------
;;; Object table
;;;
;;; The inspector navigates by IDs rather than by re-evaluable
;;; expressions. That way you really inspect the object that is there,
;;; instead of triggering a recomputation on every click that with side
;;; effects would yield a different object.
;;;
;;; Lifetime: entries hold strong references and therefore prevent GC.
;;; That is intended (a displayed object must not vanish behind your
;;; back), but delicate while audio is running — hence the FIFO limit and
;;; the explicit release when the panel is closed.
;;; ---------------------------------------------------------------------

(defvar *inspect-table* (make-hash-table :test 'eql)
  "id (fixnum) -> Objekt")
(defvar *inspect-ids* (make-hash-table :test 'eq)
  "object -> id, the inverse of *INSPECT-TABLE*.

   Without this table THE SAME object got a new number every time it was
   entered. The client recognises cycles by the ID of a subobject already
   appearing in the chain of ancestors — which could never be true that
   way, the cycle detection was ineffective, and a self-referential
   structure simply unfolded to the depth limit.

   The test is EQ, that is, identity: two lists that look alike are two
   objects and rightly get two numbers.")
(defvar *inspect-order* '()
  "IDs in insertion order, newest first — for the FIFO eviction.")
(defvar *inspect-counter* 0)

(defvar *inspect-parts-cache* (make-hash-table :test 'eql)
  "id -> (kind meta parts), the most recently computed description.

   Without the cache, inspect-part-for-repl recomputed all parts on EVERY
   click just to use one of them: for an ATS vector with a thousand
   partials that means a thousand prin1-to-string calls for previews, 999
   of which are thrown away.

   The original argument against it — that the parts would keep objects
   from the GC — was a mistake in reasoning: the parts of a vector are
   held by the vector anyway, and the vector already sits in
   *inspect-table*. The cache therefore costs no additional retention and
   is released together with the table.")

(defparameter *inspect-capacity* 500
  "Maximum number of retained objects. Beyond that the oldest ones fly
   out. Prevents a long inspection session from keeping audio buffers
   alive past the GC.")

(defun %inspect-register (obj)
  "Stores OBJ and returns its ID.

   If OBJ is already known, the EXISTING ID comes back — only that way
   can the client tell that it is going round in circles. The entry moves
   back to the front of the eviction order in the process: what is being
   looked at right now should not be the oldest thing to fly out."
  (let ((known (gethash obj *inspect-ids*)))
    (when known
      (setf *inspect-order* (cons known (remove known *inspect-order*)))
      (return-from %inspect-register known)))
  (let ((id (incf *inspect-counter*)))
    (setf (gethash id *inspect-table*) obj)
    (setf (gethash obj *inspect-ids*) id)
    (push id *inspect-order*)
    (when (> (hash-table-count *inspect-table*) *inspect-capacity*)
      (let ((keep (subseq *inspect-order* 0 *inspect-capacity*)))
        (dolist (old (nthcdr *inspect-capacity* *inspect-order*))
          (multiple-value-bind (victim found) (gethash old *inspect-table*)
            ;; Take the reverse table along, otherwise it points at
            ;; evicted IDs and inspect-part-for-repl reports "no longer
            ;; available" for an object that has just been registered
            ;; anew.
            (when (and found (eql (gethash victim *inspect-ids*) old))
              (remhash victim *inspect-ids*)))
          (remhash old *inspect-table*)
          (remhash old *inspect-parts-cache*))
        (setf *inspect-order* keep)))
    id))

(defun inspect-release-for-repl ()
  "Releases all retained objects. The client calls this when the inspector
   panel is closed.

   *INSPECT-IDS* MUST go too: the reverse table holds the objects
   themselves as keys, so it contains strong references to everything
   ever looked at — precisely what releasing is meant to prevent. And
   functionally worse: if it stayed, inspecting the same object again
   would return the old ID, for which there is no longer an entry in
   *INSPECT-TABLE*. The next click would then report 'object no longer
   available' for a freshly opened panel."
  (clrhash *inspect-table*)
  (clrhash *inspect-parts-cache*)
  (clrhash *inspect-ids*)
  (setf *inspect-order* '())
  (list :ok))

(defun %inspect-expandable-p (val)
  "Does VAL itself have parts, i.e. is an expand arrow worthwhile?

   The client cannot know this: it sees only label and preview and would
   have to load every part to find out. Without this information EVERY
   bound row gets an arrow — including fixnums and strings, which when
   expanded show only 'No navigable parts'.

   Deliberately a cheap type test and not a call to %inspect-describe:
   the prediction sits next to each of up to 1000 parts, and really
   describing them would be exactly the computation the parts cache
   avoids. The branches mirror %inspect-describe; in borderline cases (a
   symbol with neither value nor function) an arrow may lead nowhere,
   which is more harmless than a missing arrow on an enterable object."
  (when (eq val +unbound+)
    (return-from %inspect-expandable-p nil))
  (typecase val
    (null nil)
    ((or number character string package random-state) nil)
    (hash-table (plusp (hash-table-count val)))
    (pathname t)                        ; the directory part
    (cons t)
    ((and vector (not string)) (plusp (length val)))
    (array (plusp (array-total-size val)))
    ((or standard-object structure-object) t)
    (symbol t)
    (function t)
    (t nil)))

(defun %describe-registered (obj id)
  "Builds the answer for an already registered object."
  (let ((type-str (let ((*print-case* :downcase))
                    (princ-to-string (type-of obj))))
        (print-str (let ((*print-length* 100)
                         (*print-level* 5)
                         (*print-circle* t))
                     (prin1-to-string obj))))
    (destructuring-bind (kind meta parts) (%inspect-describe obj)
      ;; Keep it for the later navigation.
      (setf (gethash id *inspect-parts-cache*) parts)
      (list :ok id type-str print-str
            ;; (label index preview navigable-p writable-p expandable-p)
            (loop for p in parts
                  for i from 0
                  collect (list (first p) i (or (third p) "")
                                (if (eq (second p) +unbound+) nil t)
                                (if (fourth p) t nil)
                                (if (%inspect-expandable-p (second p)) t nil)))
            kind
            (mapcar (lambda (m) (list (car m) (cdr m))) meta)))))

(defun inspect-for-repl (expr-string package-name)
  "Evaluates EXPR-STRING, registers the result and describes it.
   Returns: (:ok id type print parts kind meta) or (:error msg ...)."
  (let ((pkg (or (find-package (string-upcase package-name))
                 (find-package :common-lisp-user))))
    (handler-case
        (let* ((*package* pkg)
               (*read-eval* nil)
               (form (read-from-string expr-string))
               (obj (eval form)))
          (%describe-registered obj (%inspect-register obj)))
      (error (e)
        (list :error (format nil "~A" e) "" nil "error" nil)))))

(defun inspect-id-for-repl (id)
  "Describes the object with ID anew — for refresh, when it has changed
   in the meantime."
  (handler-case
      (multiple-value-bind (obj found) (gethash id *inspect-table*)
        (if found
            ;; Discard the cache: refresh exists precisely because the
            ;; object may have changed in the meantime.
            (progn (remhash id *inspect-parts-cache*)
                   (%describe-registered obj id))
            (list :error "Object no longer available (reopen the panel)"
                  "" nil "error" nil)))
    (error (e) (list :error (format nil "~A" e) "" nil "error" nil))))

(defun inspect-part-for-repl (id index)
  "Navigates from object ID to its part INDEX.

   Uses the parts list stored while describing. If it is missing (cache
   evicted, image restarted) it is recomputed once — the result stays
   correct in both cases, only slower."
  (handler-case
      (multiple-value-bind (obj found) (gethash id *inspect-table*)
        (if (not found)
            (list :error "Object no longer available (reopen the panel)"
                  "" nil "error" nil)
            (let ((parts (or (gethash id *inspect-parts-cache*)
                             (let ((d (%inspect-describe obj)))
                               (setf (gethash id *inspect-parts-cache*)
                                     (third d))))))
              (let ((part (nth index parts)))
                (cond
                  ((null part)
                   (list :error "Part no longer exists" "" nil "error" nil))
                  ((eq (second part) +unbound+)
                   (list :error "Slot is unbound" "" nil "error" nil))
                  (t (let ((v (second part)))
                       (%describe-registered v (%inspect-register v)))))))))
    (error (e) (list :error (format nil "~A" e) "" nil "error" nil))))

(defun %sym-kind (sym)
  "LSP CompletionItemKind. The numbers are LSP constants; the choice only
   determines which icon VS Code shows. Macros deliberately get a
   different icon from functions — when reading somebody else's CLAMPS
   code the difference matters more than in most languages."
  (cond
    ((keywordp sym) 20)                                   ; EnumMember
    ((macro-function sym) 14)                             ; Keyword
    ((and (fboundp sym)
          (typep (ignore-errors (fdefinition sym))
                 'standard-generic-function)) 2)          ; Method
    ((fboundp sym) 3)                                     ; Function
    ((find-class sym nil)
     (if (subtypep sym 'structure-object) 22 7))          ; Struct / Class
    ((constantp sym) 21)                                  ; Constant
    ((boundp sym) 6)                                      ; Variable
    (t 12)))                                              ; Value

(defun %sym-kind-label (kind)
  "Lesbarer Name zu einer LSP-CompletionItemKind-Zahl.
Needed by APROPOS-FOR-REPL: there it said (symbol-name (%sym-kind sym)),
and %SYM-KIND returns a NUMBER. APROPOS therefore only ever returned
(:error \"The value 3 is not of type SYMBOL\")."
  (case kind
    (2 "method")
    (3 "function")
    (6 "variable")
    (7 "class")
    (12 "value")
    (14 "macro")
    (20 "keyword")
    (21 "constant")
    (22 "struct")
    (t (format nil "kind-~A" kind))))

(defun %arglist (sym)
  "Lambda list as a string, or nil. sb-introspect knows macros too."
  (handler-case
      (let ((f (find-symbol "FUNCTION-LAMBDA-LIST" :sb-introspect)))
        (when (and f (fboundp sym))
          (let ((ll (funcall f sym)))
            ;; For functions without parameters the lambda list is NIL;
            ;; princ-to-string turns that into "nil", which in the detail
            ;; column looks like a value rather than an empty list.
            (if (null ll)
                "()"
                (let ((*print-case* :downcase) (*print-pretty* nil))
                  (princ-to-string ll))))))
    (error () nil)))

(defun %short-doc (sym)
  "First line of the documentation, truncated — the completion list is no
   place for thirty-line docstrings."
  (handler-case
      (let ((d (or (documentation sym 'function)
                   (documentation sym 'variable)
                   (documentation sym 'type))))
        (when d
          (let* ((nl (position #\Newline d))
                 (line (if nl (subseq d 0 nl) d)))
            (if (> (length line) 120) (subseq line 0 117) line))))
    (error () nil)))

(defun %split-prefix (prefix)
  "Zerlegt PREFIX in (paketname symbolteil internal-p). Paketname nil
   means: search in the current package.
     \"rt-\"             -> (nil \"rt-\" nil)
     \"incudine:rt-\"    -> (\"INCUDINE\" \"rt-\" nil)
     \"incudine::rt-\"   -> (\"INCUDINE\" \"rt-\" t)
     \":foo\"            -> (\"KEYWORD\" \"foo\" nil)"
  (let ((c (position #\: prefix)))
    (cond
      ((null c) (list nil prefix nil))
      ((= c 0)  (list "KEYWORD" (string-left-trim ":" prefix) nil))
      ((and (< (1+ c) (length prefix)) (char= (char prefix (1+ c)) #\:))
       (list (string-upcase (subseq prefix 0 c)) (subseq prefix (+ c 2)) t))
      (t (list (string-upcase (subseq prefix 0 c)) (subseq prefix (1+ c)) nil)))))

(defun %prefix-match-p (name pattern)
  (and (<= (length pattern) (length name))
       (string-equal pattern name :end2 (length pattern))))

(defparameter *completion-limit* 300
  "Upper limit for candidates. When it is reached the bridge reports
   isIncomplete=t and VS Code asks again at the next character —
   otherwise we would have to send tens of thousands of symbols for an
   empty prefix.")

(defun completions-for-repl (prefix package-name &optional context)
  "Symbol completion for PREFIX in the context of PACKAGE-NAME.

   CONTEXT is NOT evaluated here, but it has to be accepted:
   handle-completion in bridge-server.lisp always sends three arguments,
   because completion.lisp needs the source before the cursor for local
   bindings and head position. Without this &optional EVERY completion
   attempt failed with \"invalid number of arguments: 3\" as soon as
   completion.lisp was not loaded — so the supposed fallback to the base
   completion was no fallback at all: no suggestions arrived any more.
   The signatures of the base and the extended version must stay
   congruent.

   Deliberately not swank:simple-completions: that returns names only.
   Here the kind (function/macro/variable/class), the lambda list and the
   first line of documentation come along in a single round trip — for
   Incudine DSP and CLAMPS functions the arglist while typing is the real
   benefit.

   Returns: (:ok truncated-p ((label kind detail doc) ...))"
  (declare (ignore context))
  (handler-case
      (destructuring-bind (pkg-part sym-part internal-p) (%split-prefix prefix)
        (let* ((home (or (find-package (string-upcase package-name))
                         (find-package :common-lisp-user)))
               (target (if pkg-part (find-package pkg-part) home))
               (seen (make-hash-table :test 'eq))
               (out '())
               (count 0)
               (truncated nil))
          (when target
            (flet ((consider (sym)
                     (unless (or (gethash sym seen)
                                 (>= count *completion-limit*))
                       (setf (gethash sym seen) t)
                       (let ((name (symbol-name sym)))
                         (when (%prefix-match-p name sym-part)
                           (incf count)
                           (push (list
                                  ;; Label with qualifier, if the user
                                  ;; typed one — otherwise VS Code does
                                  ;; not replace the package part along
                                  ;; with it.
                                  (let ((n (string-downcase name)))
                                    (cond ((string= pkg-part "KEYWORD")
                                           (concatenate 'string ":" n))
                                          (pkg-part
                                           (concatenate 'string
                                                        (string-downcase pkg-part)
                                                        (if internal-p "::" ":") n))
                                          (t n)))
                                  (%sym-kind sym)
                                  (or (%arglist sym) "")
                                  (or (%short-doc sym) ""))
                                 out))))))
              ;; Without a qualifier: everything visible in the current
              ;; package. With a single colon: external symbols only —
              ;; exactly those the package offers as its interface.
              (if (and pkg-part (not internal-p)
                       (not (string= pkg-part "KEYWORD")))
                  (do-external-symbols (sym target) (consider sym))
                  (do-symbols (sym target) (consider sym)))
              (when (>= count *completion-limit*) (setf truncated t))))
          (list :ok truncated
                (sort (nreverse out) #'string< :key #'first))))
    (error (e)
      (list :ok nil (list (list (format nil "; completion error: ~A" e)
                                1 "" ""))))))

(defparameter *rt-packages* '(:incudine :clamps :incudine.util)
  "Packages searched for the RT functions, in this order. rt-status lives
   in INCUDINE; CLAMPS is in the list in case wrappers of its own are
   added there.")

(defun %rt-sym (name)
  "First fbound symbol NAME from *rt-packages*. Returns (values symbol
   package-name) or nil."
  (dolist (pkg-name *rt-packages* nil)
    (let ((pkg (find-package pkg-name)))
      (when pkg
        (let ((sym (find-symbol (string-upcase name) pkg)))
          (when (and sym (fboundp sym))
            (return (values sym (package-name pkg)))))))))

(defun %incudine (name)
  "Backwards-compatible alias — by now it searches all of *rt-packages*."
  (%rt-sym name))

(defun %rt-symbols ()
  "All RT-* symbols from *rt-packages* — a diagnostic aid when none of the
   expected names works."
  (let ((out '()))
    (dolist (pkg-name *rt-packages*)
      (let ((pkg (find-package pkg-name)))
        (when pkg
          (do-symbols (sym pkg)
            (let ((n (symbol-name sym)))
              (when (and (> (length n) 3)
                         (string= "RT-" (subseq n 0 3))
                         (fboundp sym))
                (pushnew (format nil "~A:~A"
                                 (string-downcase
                                  (package-name (symbol-package sym)))
                                 (string-downcase n))
                         out :test #'string=)))))))
    (sort out #'string<)))

(defun rt-status-for-repl ()
  "State of the Incudine realtime server for the status bar.

   Background: in rts-start/rts-stop CLAMPS sets a modeline label
   (\"DSP ✓\") via slynk:eval-in-emacs. Without an Emacs connection that
   call is a no-op in the bootstrap, which is why in VS Code there is no
   indication at all whether DSP is running.

   Returns: (:ok running-p ((key . value) ...)), values as strings."
  (handler-case
      (if (notany #'find-package *rt-packages*)
          (list :ok nil (list (cons "packages" "neither incudine nor clamps loaded")))
          (let ((running :unbekannt)
                (info '()))

            ;; 1) rt-status — liefert typischerweise :started / :stopped
            (multiple-value-bind (sym where) (%rt-sym "RT-STATUS")
              (when sym
                (handler-case
                    (let ((v (funcall sym)))
                      (push (cons "rt-status"
                                  (format nil "~A (from ~A)"
                                          (string-downcase (princ-to-string v))
                                          (string-downcase where)))
                            info)
                      (setf running
                            (and (member v '(:started :running :on)) t)))
                  (error () nil))))

            ;; 2) Fallback: rt-running-p (older/other versions)
            (when (eq running :unbekannt)
              (multiple-value-bind (sym where) (%rt-sym "RT-RUNNING-P")
                (when sym
                  (handler-case
                      (progn
                        (setf running (and (funcall sym) t))
                        (push (cons "source"
                                    (format nil "rt-running-p from ~A"
                                            (string-downcase where)))
                              info))
                    (error () nil)))))

            ;; 3) Nothing found: do not guess, show what is there.
            (when (eq running :unbekannt)
              (setf running nil)
              (let ((syms (%rt-symbols)))
                (push (cons "note"
                            (if syms
                                (format nil "no rt-status/rt-running-p; present: ~{~A~^, ~}"
                                        (subseq syms 0 (min 8 (length syms))))
                                "no RT symbols found"))
                      info)))

            ;; Extra information for the tooltip; each one guarded on its own.
            (dolist (probe '(("sample-rate" . "RT-SAMPLE-RATE")
                             ("block-size"  . "BLOCK-SIZE")
                             ("client"      . "RT-CLIENT-NAME")
                             ("xruns"       . "RT-XRUNS")))
              (let ((sym (%rt-sym (cdr probe))))
                (when sym
                  (handler-case
                      (push (cons (car probe)
                                  (princ-to-string (funcall sym)))
                            info)
                    (error () nil)))))

            (list :ok running (nreverse info))))
    (error (e)
      (list :ok nil (list (cons "error" (princ-to-string e)))))))

(defun inspect-set-part-for-repl (id index value-string package-name)
  "Sets part INDEX of object ID to the result of VALUE-STRING.

   VALUE-STRING is read AND evaluated in the context of PACKAGE-NAME —
   one should be able to type \"(list 1 2)\" or \"*foo*\", not just
   literals. *read-eval* stays off so that #. does not take effect on top
   of that.

   Afterwards the object is described anew, because setting can also
   change header lines (hash-table count, for instance)."
  (handler-case
      (multiple-value-bind (obj found) (gethash id *inspect-table*)
        (if (not found)
            (list :error "Object no longer available (reopen the panel)"
                  "" nil "error" nil)
            (let* ((parts (or (gethash id *inspect-parts-cache*)
                              (third (%inspect-describe obj))))
                   (part (nth index parts))
                   (setter (and part (fourth part))))
              (cond
                ((null part)
                 (list :error "Part no longer exists" "" nil "error" nil))
                ((null setter)
                 (list :error "This part is not writable"
                       "" nil "error" nil))
                (t
                 (let* ((pkg (or (find-package (string-upcase package-name))
                                 (find-package :common-lisp-user)))
                        (new (let ((*package* pkg) (*read-eval* nil))
                               (eval (read-from-string value-string)))))
                   (funcall setter new)
                   ;; Discard the cache: previews and header lines are stale.
                   (remhash id *inspect-parts-cache*)
                   (%describe-registered obj id)))))))
    (error (e) (list :error (format nil "~A" e) "" nil "error" nil))))

(defun %offset->line-col (filepath offset)
  "Counts lines/columns up to OFFSET (0-indexed for LSP). Runs in the
   image, where the file is certain to be readable."
  (handler-case
      (with-open-file (s filepath :direction :input
                                   :external-format :utf-8)
        (let ((line 0) (col 0) (count 0))
          (loop
            (let ((ch (read-char s nil nil)))
              (when (or (null ch) (>= count offset)) (return))
              (if (char= ch #\Newline)
                  (progn (incf line) (setf col 0))
                  (incf col))
              (incf count)))
          (list line col)))
    (error () (list 0 0))))

(defun %resolve-source-file (raw-file)
  "Translates a file entry from a Swank location into an existing physical
   path. SBCL-internal definitions arrive as logical pathnames
   (SYS:SRC;CODE;LIST.LISP) — translate-logical-pathname turns that into
   the real path of the installed SBCL sources. Returns NIL when the file
   does not exist (SBCL installed without sources, say), so that the
   client can report that honestly instead of jumping into the void."
  (handler-case
      (let* ((path (etypecase raw-file
                     (pathname raw-file)
                     (string (parse-namestring raw-file))))
             (physical (translate-logical-pathname path)))
        (when (probe-file physical)
          (namestring physical)))
    (error () nil)))

(defun resolve-symbol (symbol-string pkg)
  "Resolves SYMBOL-STRING to a real symbol object. Handles qualified names
   (incudine:rt-start, clamps::foo) directly through the reader; for bare
   names (rt-start) it first searches in the given package PKG and then
   falls back to an unqualified reader attempt. Returns NIL when nothing
   is found."
  (handler-case
      (let ((*package* pkg) (*read-eval* nil))
        (if (find #\: symbol-string)
            ;; Qualified name: the reader gets this right.
            (let ((obj (read-from-string symbol-string)))
              (and (symbolp obj) obj))
            ;; Bare name: search in the package first (which also finds
            ;; inherited and internal symbols), then image-wide, then the
            ;; reader fallback.
            (let ((upcased (string-upcase symbol-string)))
              (multiple-value-bind (sym status) (find-symbol upcased pkg)
                (cond
                  (status sym)
                  ;; Not visible in the current package (rt-start without
                  ;; (in-package :incudine) in the file, say): search
                  ;; across all packages. A symbol that is actually
                  ;; fboundp or boundp is preferred, so that we do not
                  ;; catch some accidental keyword of the same name.
                  (t (let ((candidates '()))
                       (dolist (p (list-all-packages))
                         (multiple-value-bind (s st) (find-symbol upcased p)
                           (when (and st (eq (symbol-package s) p))
                             (pushnew s candidates))))
                       (or (find-if (lambda (s) (or (fboundp s) (boundp s)
                                                    (find-class s nil)))
                                    candidates)
                           (first candidates)
                           ;; The reader fallback only for escaped names
                           ;; (|foo bar|, a\.b): those are exactly the
                           ;; ones the find-symbol loop above cannot find,
                           ;; because it bluntly upcases.
                           ;;
                           ;; For anything else it would be harmful,
                           ;; because READ-FROM-STRING INTERNS: a typo in
                           ;; the XREF input used to create a new symbol
                           ;; in the package and return it as if it had
                           ;; been found. The package was polluted by
                           ;; every slip of the finger, and the caller got
                           ;; :ok with an empty hit list instead of
                           ;; "symbol not found".
                           (and (not (find #\: symbol-string))
                                (or (find #\| symbol-string)
                                    (find #\\ symbol-string))
                                (ignore-errors
                                  (let ((obj (read-from-string symbol-string)))
                                    (and (symbolp obj) obj))))))))))))
    (error () nil)))

(defun trace-toggle-for-repl (symbol-string package-name)
  "Toggles tracing for the function at the symbol (the SLIME C-c C-t
   behaviour). (trace) without arguments returns the list of currently
   traced function names — the state is checked through that.
   trace/untrace are macros, hence the detour through eval with the
   symbol substituted in. Returns (:ok STATUS-TEXT TRACED-P)."
  (let ((pkg (or (find-package (string-upcase package-name))
                 (find-package :common-lisp-user))))
    (handler-case
        (let* ((*package* pkg)
               (sym (resolve-symbol symbol-string pkg)))
          (cond
            ((null sym)
             (list :error (format nil "Symbol ~A not found." symbol-string) nil))
            ((not (fboundp sym))
             (list :error (format nil "~A is not a function." sym) nil))
            (t
             (let ((traced (member sym (eval '(trace)) :test #'eq)))
               (if traced
                   (progn
                     (eval `(untrace ,sym))
                     (list :ok (format nil "Trace OFF: ~A" sym) nil))
                   (progn
                     (eval `(trace ,sym))
                     (list :ok (format nil "Trace ON: ~A - calls appear in the REPL" sym) t)))))))
      (error (e)
        (list :error (format nil "~A" e) nil)))))

;;; State of the observation tools. Deliberately HERE, before the first
;;; use in traced-for-repl: placed further down, SBCL's compiler reports
;;; both as undefined variables, and those warnings now end up in
;;; clamps.log — the place where one looks for a crash.
(defvar *clamps-function-breakpoints* (make-hash-table :test #'equal))

(defvar *rt-breakpoint-notes* nil
  "Symbols for which a breakpoint in the realtime thread was skipped.")

(defun %restore-function-breakpoint (key)
  (let ((record (gethash key *clamps-function-breakpoints*)))
    (when record
      (let ((sym (getf record :symbol)) (original (getf record :original))
            (wrapper (getf record :wrapper)))
        (when (and (fboundp sym) (eq (fdefinition sym) wrapper))
          (setf (fdefinition sym) original))
        (remhash key *clamps-function-breakpoints*)))))

(defun traced-for-repl ()
  "List of the currently traced functions for the trace browser.

(TRACE) without arguments returns the traced names according to the
standard; that is more portable than reaching into SBCL's internals.
Names can also be compound ((SETF FOO), (METHOD BAR (T))), which is why
princ-to-string is used and not symbol-name.

The function breakpoints come along as well, so that the browser shows
both kinds of observation in one place — otherwise you look for the
reason why an image keeps halting in two places."
  (handler-case
      (let ((entries nil))
        (dolist (name (eval '(trace)))
          (push (list :label (princ-to-string name)
                      :description "TRACE"
                      :tooltip "Calls appear in the REPL. Click to inspect."
                      :icon "radio-tower"
                      :inspect (and (symbolp name) (%package-qualified name)))
                entries))
        (maphash
         (lambda (key record)
           (declare (ignore key))
           (let ((sym (getf record :symbol)))
             (let ((skipped (member sym *rt-breakpoint-notes*)))
               (push (list :label (princ-to-string sym)
                           ;; A note, in case the breakpoint was skipped
                           ;; in the realtime thread. Without this hint it
                           ;; looks broken.
                           :description (if skipped
                                            "BREAKPOINT (im RT-Thread uebersprungen)"
                                            "BREAKPOINT")
                           :tooltip (if skipped
                                        "Was called in the Incudine realtime thread and NOT halted there — a BREAK would have blocked the audio callback."
                                        "Halts on entry to the function.")
                           :icon (if skipped "warning" "debug-breakpoint")
                           :inspect (%package-qualified sym))
                     entries))))
         *clamps-function-breakpoints*)
        (list :ok (sort entries #'string< :key (lambda (e) (getf e :label)))))
    (error (e) (list :error (princ-to-string e)))))

(defun untrace-one-for-repl (label)
  "Removes exactly one entry — a trace or a function breakpoint.
LABEL is the string that traced-for-repl returned."
  (handler-case
      (let ((hit nil))
        ;; Breakpoints first: there the comparison is unambiguous.
        (maphash (lambda (key record)
                   (declare (ignore record))
                   (when (string-equal key label) (setf hit key)))
                 *clamps-function-breakpoints*)
        (when hit
          (%restore-function-breakpoint hit)
          (return-from untrace-one-for-repl
            (list :ok (format nil "Breakpoint entfernt: ~A" label))))
        (dolist (name (eval '(trace)))
          (when (string= (princ-to-string name) label)
            (eval `(untrace ,name))
            (return-from untrace-one-for-repl
              (list :ok (format nil "Trace off: ~A" label)))))
        (list :error (format nil "~A is not observed." label)))
    (error (e) (list :error (princ-to-string e)))))

(defun untrace-all-for-repl ()
  "Switches all traces off. Returns (:ok TEXT)."
  (handler-case
      (let ((traced (eval '(trace))))
        (eval '(untrace))
        (list :ok (if traced
                      (format nil "All traces off (~A function~:P)." (length traced))
                      "Nothing was traced.")))
    (error (e) (list :error (format nil "~A" e)))))

(defun find-definitions-for-repl (symbol-string package-name)
  "Finds all definition sites of the symbol — including for built-in SBCL
   functions, variables, macros and classes (the M-. experience).
   Returns (:ok ((file line col label) ...)); entries whose source file
   cannot be found come with file=NIL and the label, so that the client
   can display them (as 'source not installed', for instance)."
  (let ((pkg (or (find-package (string-upcase package-name))
                 (find-package :common-lisp-user))))
    (handler-case
        (let* ((*package* pkg)
               ;; Resolve the symbol to a real symbol object, then feed
               ;; Swank the FULLY QUALIFIED name. The reason:
               ;; find-definitions-for-emacs does NOT find "rt-start" when
               ;; you only pass the package INCUDINE, but it does find
               ;; "incudine:rt-start". So we determine the home package of
               ;; the symbol and build the qualified name ourselves.
               (sym (resolve-symbol symbol-string pkg))
               (query-name (if sym
                               (let ((*package* (find-package :keyword)))
                                 ;; prin1 with the keyword package forces full
                                 ;; Package qualification in the emitted name.
                                 (let ((*print-case* :downcase)
                                       (*print-readably* nil))
                                   (prin1-to-string sym)))
                               symbol-string))
               (defs (funcall (find-symbol "FIND-DEFINITIONS-FOR-EMACS" :swank)
                              query-name))
               (results '()))
          (dolist (def defs)
            (let* ((label (let ((*print-case* :downcase))
                            (princ-to-string (first def))))
                   (loc (second def)))
              (when (and (consp loc) (eq (first loc) :location))
                (let ((file nil) (position nil))
                  ;; Collect the location parts: (:file "...") (:position n)
                  ;; or (:buffer ...) (:offset start n), depending on the source.
                  (dolist (part (rest loc))
                    (when (consp part)
                      (case (first part)
                        (:file (setf file (second part)))
                        (:buffer-and-file (setf file (third part)))
                        (:position (setf position (second part)))
                        (:offset (setf position (+ (or (second part) 0)
                                                   (or (third part) 0)))))))
                  (let ((resolved (and file (%resolve-source-file file))))
                    (if resolved
                        (destructuring-bind (line col)
                            (%offset->line-col resolved
                                               (max 0 (1- (or position 1))))
                          (push (list resolved line col label) results))
                        ;; File not found: report the label anyway.
                        (push (list nil 0 0 label) results)))))))
          (list :ok (nreverse results)))
      (error (e)
        (list :error (format nil "~A" e))))))

(defun disassemble-for-repl (symbol-string package-name)
  "Disassembles the function that SYMBOL-STRING points to in package
   PACKAGE-NAME and returns the native machine code as text. That is
   exactly what SBCL's (disassemble #'fn) writes to *standard-output* —
   we capture it into a string. Returns
   (STATUS OUTPUT-STRING PACKAGE-STRING)."
  (let ((pkg (or (find-package (string-upcase package-name))
                 (find-package :common-lisp-user))))
    (handler-case
        (let* ((*package* pkg)
               ;; Read the symbol from the string (this respects package
               ;; prefixes such as clamps::rts-start, because *package* is
               ;; bound).
               (sym (let ((*read-eval* nil))
                      (read-from-string symbol-string))))
          (cond
            ((not (symbolp sym))
             (list :error
                   (format nil "~S is not a symbol." sym)
                   (package-name pkg)))
            ((not (fboundp sym))
             (list :error
                   (format nil "~A is not a function (fboundp = nil)." sym)
                   (package-name pkg)))
            ((macro-function sym)
             ;; disassemble on a macro makes little sense — the expander
             ;; function would be disassembled, not what the user expects.
             ;; Report that honestly.
             (list :error
                   (format nil "~A is a macro, not a disassemblable function call.~%~
                                For macros, use macroexpand instead." sym)
                   (package-name pkg)))
            (t
             (let ((out (make-string-output-stream)))
               (let ((*standard-output* out))
                 (disassemble (fdefinition sym)))
               (list :ok (get-output-stream-string out) (package-name pkg))))))
      (error (e)
        (list :error (format nil "~A" e) (package-name pkg))))))

(defun macroexpand-for-repl (code-string package-name full-p)
  "Reads the FIRST form from CODE-STRING and expands it in package
   PACKAGE-NAME. FULL-P nil = macroexpand-1 (one level only, usually more
   useful when working interactively), FULL-P non-nil = macroexpand
   (fully). Returns (STATUS OUTPUT-STRING PACKAGE-STRING). The output is
   pretty-printed so that the expanded code is formatted readably instead
   of as one long line."
  (let ((pkg (or (find-package (string-upcase package-name))
                 (find-package :common-lisp-user))))
    (handler-case
        (let* ((*package* pkg)
               (form (with-input-from-string (in code-string)
                       (read in nil :eof))))
          (if (eq form :eof)
              (list :ok "" (package-name pkg))
              (multiple-value-bind (expansion expanded-p)
                  (if full-p
                      (macroexpand form)
                      (macroexpand-1 form))
                (let ((text (if expanded-p
                                (let ((*print-pretty* t)
                                      (*print-right-margin* 80)
                                      (*print-case* :downcase))
                                  (prin1-to-string expansion))
                                ;; Not a macro -> report that honestly
                                ;; instead of emitting the unchanged form
                                ;; as a supposed expansion.
                                (format nil ";; no macro expansion (not a macro call)~%~A"
                                        (let ((*print-pretty* t)
                                              (*print-case* :downcase))
                                          (prin1-to-string expansion))))))
                  (list :ok text (package-name pkg))))))
      (error (e)
        (list :error (format nil "~A" e) (package-name pkg))))))



;;; ---------------------------------------------------------------------
;;; Additive tooling shared by the richer VS Code front-end.
;;; ---------------------------------------------------------------------

(defvar *presentation-table* (make-hash-table :test 'eql)
  "Presentation-ID -> live Lisp object. Kept separate from the Inspector table.")
(defvar *presentation-ids* (make-hash-table :test 'eq)
  "Live Lisp object -> Presentation-ID, for stable identity.")
(defvar *presentation-history* '())
(defvar *presentation-counter* 0)
(defparameter *presentation-capacity* 200)

(defun %presentation-register (value)
  "Keep VALUE in a presentation-specific bounded registry and return its stable id.

The presentation registry is deliberately independent from the Inspector registry:
closing an Inspector panel may release its navigation cache, but must not invalidate
REPL results that are still visible and reusable."
  (let ((known (gethash value *presentation-ids*)))
    (when known
      (setf *presentation-history* (cons known (remove known *presentation-history*)))
      (return-from %presentation-register known)))
  (let ((id (incf *presentation-counter*)))
    (setf (gethash id *presentation-table*) value
          (gethash value *presentation-ids*) id)
    (push id *presentation-history*)
    (when (> (length *presentation-history*) *presentation-capacity*)
      (dolist (old (nthcdr *presentation-capacity* *presentation-history*))
        (multiple-value-bind (victim found) (gethash old *presentation-table*)
          (when (and found (eql (gethash victim *presentation-ids*) old))
            (remhash victim *presentation-ids*)))
        (remhash old *presentation-table*))
      (setf *presentation-history*
            (subseq *presentation-history* 0 *presentation-capacity*)))
    id))

(defun %presentation-type-label (value)
  "A short, readable type label for the REPL line.

Not type-of: for numbers and sequences that yields the exact type
specifier instead of a name — 2 becomes
\"(integer 0 4611686018427387903)\", \"abc\" becomes \"(simple-array
character (3))\", #(1 2) becomes \"(simple-vector 2)\". In the line
\"[#4 (integer 0 4611686018427387903)] ,inspect 4\" that is useless.
class-of gives the class name, that is, fixnum or simple-vector.

For the rare cases without a class name (anonymous classes) type-of
remains the fallback — a label is better than none."
  (let ((*print-case* :downcase)
        (*print-pretty* nil))
    (or (ignore-errors
          (let ((name (class-name (class-of value))))
            (and (symbolp name) (princ-to-string name))))
        (ignore-errors (princ-to-string (type-of value)))
        "t")))

(defun presentation-value (id)
  "Return a live REPL result by id. Intended for explicit user actions only."
  (multiple-value-bind (value found) (gethash id *presentation-table*)
    (if found value (error "Presentation ~D is no longer available (the registry keeps the last ~D results)."
                   id *presentation-capacity*))))

(defun indentation-rules-for-repl ()
  "Return image-known macro indentation rules without requiring Swank internals.
The front-end merges these with conservative Common Lisp defaults."
  (let ((rules '()))
    (do-all-symbols (symbol)
      (when (macro-function symbol)
        (let* ((name (string-downcase (symbol-name symbol)))
               (pkg (symbol-package symbol))
               (qualified (and pkg (format nil "~A::~A"
                                           (string-downcase (package-name pkg)) name))))
          ;; Unknown macros default to one distinguished argument. This is
          ;; deliberately conservative; user/source declarations can override it.
          (push (list (or qualified name) 1) rules))))
    (list :ok (remove-duplicates rules :key #'first :test #'string=))))

(defun asdf-operation-for-repl (operation system)
  "Run a small, whitelisted ASDF operation.

ASDF symbols are resolved only after REQUIRE has loaded the package.  This
keeps RPC.LISP readable and compilable in a fresh Lisp image where ASDF does
not yet exist."
  (handler-case
      (progn
        (require :asdf)
        (let* ((asdf-package (or (find-package "ASDF")
                                 (error "ASDF was required but its package is unavailable")))
               (operate-symbol (or (find-symbol "OPERATE" asdf-package)
                                   (error "ASDF:OPERATE is unavailable")))
               (operation-name (ecase operation
                                 (:load "LOAD-OP")
                                 (:compile "COMPILE-OP")
                                 (:test "TEST-OP")))
               (operation-symbol (or (find-symbol operation-name asdf-package)
                                     (error "ASDF operation ~A is unavailable"
                                            operation-name))))
          (funcall operate-symbol operation-symbol system)
          (list :ok (format nil "~(~A~) completed for ~A" operation system))))
    (error (e) (list :error (format nil "~A" e)))))

(defvar *sticker-records* (make-hash-table :test 'equal))
(defparameter *sticker-capacity* 256)

;; Realtime stickers use an explicitly allocated state object.  The DSP hot
;; path only writes into a preallocated array and updates fixnum indices.  It
;; performs no consing, printing, hash lookup, clock access or inspector
;; registration.  Registration and presentation happen on the control/REPL
;; side.
;;
;; Two storage layouts exist because they have different allocation
;; behaviour:
;;
;;   :element-type t             VALUES is a SIMPLE-VECTOR.  Storing a
;;                               double-float into it boxes the float, i.e.
;;                               it allocates.  Fine for control-thread and
;;                               fixnum/symbol use, not for a DSP hot path.
;;
;;   :element-type 'double-float SAMPLES is a specialised
;;                               (SIMPLE-ARRAY DOUBLE-FLOAT (*)).  The store
;;                               is unboxed and allocates nothing.  This is
;;                               the layout for dsp! bodies.
;;
;; The unused array is allocated with length 0 so that both slots stay
;; monomorphic and the hot path needs no type dispatch.
;;
;; DECIMATION exists so that the caller never has to write a conditional in
;; the DSP body.  A form like
;;
;;   (when (zerop counter) (sticker-state-record-sample-for-repl s in))
;;
;; is not merely inelegant: it changes what the Incudine VUG compiler
;; produces.  The update code of a VUG variable is emitted at its first
;; textual reference, so putting that first reference inside WHEN moves the
;; oscillator update into the branch and the variable is only advanced when
;; the branch is taken.  Recording every 441st sample then turns a 330 Hz
;; sine into a 100 Hz sample-and-hold staircase — an audible pulse.  Calling
;; the recorder unconditionally and letting it drop samples internally keeps
;; the reference unconditional and the audio intact.
(defstruct (sticker-state
             (:constructor %make-sticker-state
                 (values samples capacity element-type decimation
                         window-scale)))
  (values #() :type simple-vector)
  (samples (make-array 0 :element-type 'double-float)
   :type (simple-array double-float (*)))
  (capacity 0 :type fixnum)
  (element-type t :type symbol)
  (decimation 1 :type fixnum)
  (phase 0 :type fixnum)
  ;; Aggregating recorders sum into ACCUMULATOR over one decimation window
  ;; and store once at its end.  WINDOW-SCALE is 1/DECIMATION, precomputed so
  ;; the hot path needs no division and no fixnum-to-float conversion.
  (accumulator 0.0d0 :type double-float)
  (window-scale 1.0d0 :type double-float)
  (write-index 0 :type fixnum)
  (count 0 :type fixnum)
  (sequence 0 :type fixnum))

(defun make-sticker-state-for-repl (&optional (capacity *sticker-capacity*)
                                    &key (element-type t) (decimation 1))
  "Allocate a bounded sticker ring once, outside the realtime thread.

ELEMENT-TYPE is T (any value, boxed) or DOUBLE-FLOAT (unboxed samples).
DECIMATION N keeps every Nth recorded value and discards the rest, so the
DSP body can call the recorder unconditionally."
  (check-type capacity (and fixnum (integer 1)))
  (check-type decimation (and fixnum (integer 1)))
  (unless (member element-type '(t double-float))
    (error "sticker element-type must be T or DOUBLE-FLOAT, not ~S."
           element-type))
  (let ((double-p (eq element-type 'double-float)))
    (%make-sticker-state
     (make-array (if double-p 0 capacity) :initial-element nil)
     (make-array (if double-p capacity 0)
                 :element-type 'double-float
                 :initial-element 0.0d0)
     capacity element-type decimation
     (/ 1.0d0 (float decimation 1.0d0)))))

(defun make-sticker-sample-state-for-repl
    (&optional (capacity *sticker-capacity*) (decimation 1))
  "Convenience constructor for the unboxed DSP layout."
  (make-sticker-state-for-repl capacity
                               :element-type 'double-float
                               :decimation decimation))

(defun register-sticker-state-for-repl (key state)
  "Expose preallocated STATE under KEY for later REPL snapshots.
Call this before starting DSP processing."
  (check-type key string)
  (check-type state sticker-state)
  (setf (gethash key *sticker-records*) state)
  state)

(declaim (inline %sticker-state-advance))
(defun %sticker-state-advance (state)
  "Advance ring indices after a store.  Fixnum arithmetic only."
  (declare (type sticker-state state)
           (optimize (speed 3) (safety 0) (debug 0)))
  (let ((index (sticker-state-write-index state))
        (capacity (sticker-state-capacity state)))
    (declare (type fixnum index capacity))
    (setf (sticker-state-write-index state)
          (let ((next (the fixnum (1+ index))))
            (if (= next capacity) 0 next)))
    (when (< (sticker-state-count state) capacity)
      (setf (sticker-state-count state)
            (the fixnum (1+ (sticker-state-count state)))))
    ;; Sequence is diagnostic only.  Wrap before fixnum overflow rather than
    ;; promoting to a bignum, which would allocate.
    (setf (sticker-state-sequence state)
          (if (= (sticker-state-sequence state) most-positive-fixnum)
              0
              (the fixnum (1+ (sticker-state-sequence state)))))
    (values)))

(declaim (inline %sticker-state-due-p))
(defun %sticker-state-due-p (state)
  "True when this call falls on a kept phase.  Always advances the phase."
  (declare (type sticker-state state)
           (optimize (speed 3) (safety 0) (debug 0)))
  (let ((phase (sticker-state-phase state)))
    (declare (type fixnum phase))
    (setf (sticker-state-phase state)
          (let ((next (the fixnum (1+ phase))))
            (if (>= next (sticker-state-decimation state)) 0 next)))
    (= phase 0)))

(declaim (inline %sticker-state-store-sample))
(defun %sticker-state-store-sample (state value)
  "Write VALUE into the unboxed ring and advance.  Allocates nothing."
  (declare (type sticker-state state)
           (type double-float value)
           (optimize (speed 3) (safety 0) (debug 0)))
  (setf (aref (sticker-state-samples state)
              (sticker-state-write-index state))
        value)
  (%sticker-state-advance state)
  (values))

(declaim (inline sticker-state-record-sample-for-repl))
(defun sticker-state-record-sample-for-repl (state value)
  "Store sample VALUE in preallocated STATE and return VALUE.

This is the dsp!-safe path: it allocates nothing.  STATE must have been made
with :ELEMENT-TYPE 'DOUBLE-FLOAT.  Call it unconditionally on every sample;
use the state's DECIMATION to thin the recording out."
  (declare (type sticker-state state)
           (type double-float value)
           (optimize (speed 3) (safety 0) (debug 0)))
  (when (%sticker-state-due-p state)
    (%sticker-state-store-sample state value))
  value)

(declaim (inline sticker-state-record-rms-for-repl))
(defun sticker-state-record-rms-for-repl (state value)
  "Accumulate VALUE and store one RMS figure per decimation window.

STICKER-STATE-RECORD-SAMPLE-FOR-REPL keeps one instantaneous sample per
window and throws the rest away.  For a periodic signal that is aliasing,
not metering: at 330 Hz with a window of 441 the kept samples land on ten
fixed phase points and say nothing about level, and at 300 Hz they would all
land on the same phase and read as a constant.

This recorder squares every sample, so no sample is discarded, and writes
sqrt(mean(x^2)) over the window.  It is the dsp!-safe path and allocates
nothing.  Call it unconditionally on every sample; STATE must have been made
with :ELEMENT-TYPE 'DOUBLE-FLOAT.

Unlike the sample path this stores at the *end* of a window, so the first
value appears after DECIMATION calls rather than on the first one."
  (declare (type sticker-state state)
           (type double-float value)
           (optimize (speed 3) (safety 0) (debug 0)))
  (let ((sum (+ (sticker-state-accumulator state)
                (* value value)))
        (phase (the fixnum (1+ (sticker-state-phase state))))
        (window (sticker-state-decimation state)))
    (declare (type double-float sum)
             (type fixnum phase window))
    (cond ((>= phase window)
           (%sticker-state-store-sample
            state
            (sqrt (* sum (sticker-state-window-scale state))))
           (setf (sticker-state-accumulator state) 0.0d0
                 (sticker-state-phase state) 0))
          (t
           (setf (sticker-state-accumulator state) sum
                 (sticker-state-phase state) phase))))
  value)

(declaim (inline sticker-state-record-for-repl))
(defun sticker-state-record-for-repl (state value)
  "Store VALUE in preallocated STATE and return VALUE.

General path for arbitrary values.  Storing a float here boxes it, so for
dsp! bodies use STICKER-STATE-RECORD-SAMPLE-FOR-REPL instead."
  (declare (type sticker-state state)
           (optimize (speed 3) (safety 0) (debug 0)))
  (when (%sticker-state-due-p state)
    (if (eq (sticker-state-element-type state) 'double-float)
        (setf (aref (sticker-state-samples state)
                    (sticker-state-write-index state))
              (float value 1.0d0))
        (setf (svref (sticker-state-values state)
                     (sticker-state-write-index state))
              value))
    (%sticker-state-advance state))
  value)

(defun sticker-record-for-repl (key value)
  "Legacy control-thread sticker.  This allocates and is not DSP-safe."
  (let ((items (gethash key *sticker-records*)))
    (when (typep items 'sticker-state)
      (return-from sticker-record-for-repl
        (sticker-state-record-for-repl items value)))
    (push (list (get-universal-time) (%inspect-register value) (prin1-to-string value)) items)
    (when (> (length items) *sticker-capacity*)
      (setf items (subseq items 0 *sticker-capacity*)))
    (setf (gethash key *sticker-records*) items))
  value)

(defun %sticker-state-values-oldest-first (state)
  "Copy live ring entries for control-thread presentation."
  (let* ((count (sticker-state-count state))
         (capacity (sticker-state-capacity state))
         (write-index (sticker-state-write-index state))
         (double-p (eq (sticker-state-element-type state) 'double-float))
         (start (if (= count capacity) write-index 0)))
    (loop for offset below count
          for index = (mod (+ start offset) capacity)
          collect (if double-p
                      (aref (sticker-state-samples state) index)
                      (svref (sticker-state-values state) index)))))

(defun %sticker-state-tail (state n)
  "The N newest values of the ring, oldest first."
  (let* ((count (sticker-state-count state))
         (n (max 0 (min n count)))
         (capacity (sticker-state-capacity state))
         (double-p (eq (sticker-state-element-type state) 'double-float))
         (start (mod (- (sticker-state-write-index state) n) capacity)))
    (loop for offset below n
          for index = (mod (+ start offset) capacity)
          collect (if double-p
                      (aref (sticker-state-samples state) index)
                      (svref (sticker-state-values state) index)))))

(defun %finite-sample (value)
  "Map NaN and infinity to 0.

The bridge's JSON writer prints floating-point numbers with ~F; a NaN or
an infinity produces invalid JSON there and paralyses the connection.
But those are exactly the values that arise when a feedback loop in the
DSP runs away — that is, precisely at the moment when one is looking at
the level."
  (handler-case
      (let ((x (float value 1.0d0)))
        (if (and (= x x) (< (abs x) 1.0d38)) x 0.0d0))
    (error () 0.0d0)))

(defun sticker-samples-since-for-repl (key since &optional (limit 4096))
  "New values of a registered ring since sequence number SINCE.

Returns: (:ok SEQUENCE DROPPED VALUES).  SEQUENCE is the new position,
which the caller sends along the next time.  DROPPED says how many values
fell out of the ring between two queries — the display must not conceal
that as a gap, otherwise an overflowing ring looks like an unbroken
course.

Without this scheme the whole ring would have to be transferred on every
query.  At 256 values that does not matter; for a spectrogram at 30
queries per second it does."
  (let ((state (gethash key *sticker-records*)))
    (if (not (typep state 'sticker-state))
        (list :ok 0 0 nil)
        (let* ((sequence (sticker-state-sequence state))
               (count (sticker-state-count state))
               ;; SINCE > SEQUENCE means: the ring was newly created or
               ;; the sequence overflowed.  Then send everything present
               ;; again instead of computing a negative difference.
               (pending (if (> since sequence) count (- sequence since)))
               (available (min pending count))
               (take (min available limit))
               (dropped (- pending take)))
          (list :ok sequence dropped
                (mapcar #'%finite-sample (%sticker-state-tail state take)))))))

(defun sticker-keys-for-repl ()
  "Registered rings with their parameters, without the values themselves."
  (list :ok
        (loop for key being the hash-keys of *sticker-records* using (hash-value state)
              when (typep state 'sticker-state)
                collect (list key
                              (sticker-state-capacity state)
                              (sticker-state-decimation state)
                              (string-downcase (symbol-name (sticker-state-element-type state)))
                              (sticker-state-sequence state)))))

;;; ---------------------------------------------------------------------
;;; Spectrum of a sticker ring
;;; ---------------------------------------------------------------------
;;;
;;; The FFT runs here, not in the display.  That is the only decision in
;;; this section that would really hurt if it had been taken the other
;;; way round:
;;;
;;; A spectroscope needs the newest N samples for every frame, and needs
;;; them overlapping — at 1024 points and 20 frames per second that is
;;; 20480 values per second down a wire that writes every number as text.
;;; This is independent of whether the ring is filled that fast; the
;;; windows simply overlap.  Compute here instead and send only the
;;; columns that get drawn, and the amount of data depends on the window
;;; width in pixels rather than on sample rate and FFT size: 256 numbers
;;; per frame, whether the analysis uses 512 or 8192 points.
;;;
;;; The second reason is the axis.  Plotted logarithmically, above a few
;;; kilohertz a large share of the bins falls into the same pixel column
;;; anyway.  Transfer the bins first and combine them afterwards, and you
;;; have transferred them for nothing.

(defparameter *two-pi* (* 2 (coerce pi 'double-float)))

(defun %power-of-two-p (n)
  (and (integerp n) (> n 0) (zerop (logand n (1- n)))))

(defvar *fft-window-cache* (make-hash-table :test 'equal)
  "Window functions by (kind . length).

Only the windows are cached, not the working arrays of the FFT.  A
window is only read after being created and is therefore safe to share;
a working array is written to, and two simultaneous queries — two rings,
two open displays — would overwrite each other's intermediate results.
The memory saved would not be worth the silently wrong reading.")

(defun %fft-window (kind size)
  "Window of length SIZE.  KIND is \"rect\", \"hann\" or \"blackman-harris\".

Blackman-Harris is included because the ATS analysis uses it: anyone who
looks at a spectrum in the editor and then analyses the same recording
should not have to compare two different side-lobe pictures."
  (let* ((name (string-downcase (string kind)))
         (key (cons name size)))
    (or (gethash key *fft-window-cache*)
        (setf (gethash key *fft-window-cache*)
              (let ((w (make-array size :element-type 'double-float
                                        :initial-element 1.0d0))
                    ;; The periodic form (divisor SIZE), not the
                    ;; symmetric one (SIZE-1).  Only with it is a sine
                    ;; falling exactly on a bin centre leak-free — with
                    ;; the symmetric form a small remainder stays in the
                    ;; neighbouring bins that looks like a sideband and is
                    ;; none.  For filter design it would be the other way
                    ;; round; here we are analysing.
                    (denominator (float (max 1 size) 1.0d0)))
                (cond
                  ((string= name "rect") w)
                  ((string= name "blackman-harris")
                   (dotimes (i size w)
                     (let ((x (/ (* *two-pi* i) denominator)))
                       (setf (aref w i)
                             (+ 0.35875d0
                                (- (* 0.48829d0 (cos x)))
                                (* 0.14128d0 (cos (* 2.0d0 x)))
                                (- (* 0.01168d0 (cos (* 3.0d0 x)))))))))
                  (t
                   (dotimes (i size w)
                     (let ((x (/ (* *two-pi* i) denominator)))
                       (setf (aref w i) (* 0.5d0 (- 1.0d0 (cos x))))))))))) ))

(defun %fft-forward (re im)
  "In-place radix-2 FFT.  RE and IM have the same length, a power of two.
The return values are those same two arrays.

Deliberately a complete complex FFT of our own rather than a variant
tailored to real input: halving the computation time would be
irrelevant here — a 2048-point pass twenty times a second is nothing —
while the additional packing arithmetic is exactly the sort of code in
which a bin shifted by one hides, the kind you cannot see in the
picture."
  (declare (type (simple-array double-float (*)) re im)
           (optimize (speed 3) (safety 1)))
  (let ((n (length re)))
    (declare (type fixnum n))
    ;; Bit-Umkehr-Vertauschung.
    (let ((j 0))
      (declare (type fixnum j))
      (dotimes (i (max 0 (1- n)))
        (declare (type fixnum i))
        (when (< i j)
          (rotatef (aref re i) (aref re j))
          (rotatef (aref im i) (aref im j)))
        (let ((m (ash n -1)))
          (declare (type fixnum m))
          (loop while (and (>= m 1) (>= j m))
                do (decf j m) (setf m (ash m -1)))
          (incf j m))))
    ;; Butterflies; the span doubles at each stage.
    (let ((span 1))
      (declare (type fixnum span))
      (loop while (< span n)
            do (let* ((jump (the fixnum (* 2 span)))
                      (delta (/ (- *two-pi*) (float jump 1.0d0))))
                 (declare (type fixnum jump) (type double-float delta))
                 (dotimes (group span)
                   (declare (type fixnum group))
                   (let* ((angle (* delta (float group 1.0d0)))
                          (wr (cos angle))
                          (wi (sin angle)))
                     (declare (type double-float angle wr wi))
                     (loop for pair of-type fixnum from group below n by jump
                           do (let* ((match (the fixnum (+ pair span)))
                                     (tr (- (* wr (aref re match))
                                            (* wi (aref im match))))
                                     (ti (+ (* wr (aref im match))
                                            (* wi (aref re match)))))
                                (declare (type double-float tr ti))
                                (setf (aref re match) (- (aref re pair) tr)
                                      (aref im match) (- (aref im pair) ti))
                                (incf (aref re pair) tr)
                                (incf (aref im pair) ti)))))
                 (setf span jump))))
    (values re im)))

(defun %sticker-state-tail-samples (state n)
  "The N newest values as a double-float array, oldest first."
  (let* ((count (sticker-state-count state))
         (n (max 0 (min n count)))
         (capacity (sticker-state-capacity state))
         (double-p (eq (sticker-state-element-type state) 'double-float))
         (start (if (zerop capacity)
                    0
                    (mod (- (sticker-state-write-index state) n) capacity)))
         (out (make-array n :element-type 'double-float
                            :initial-element 0.0d0)))
    (dotimes (offset n out)
      (let ((index (mod (+ start offset) (max 1 capacity))))
        (setf (aref out offset)
              (if double-p
                  (aref (sticker-state-samples state) index)
                  (%finite-sample (svref (sticker-state-values state) index))))))))

(defun %rt-value (name)
  "Value of a bound symbol NAME from *rt-packages*, otherwise NIL."
  (dolist (pkg-name *rt-packages* nil)
    (let ((pkg (find-package pkg-name)))
      (when pkg
        (let ((sym (find-symbol (string-upcase name) pkg)))
          (when (and sym (boundp sym))
            (return (ignore-errors (symbol-value sym)))))))))

(defun %spectrum-sample-rate ()
  "Sample rate for the frequency axis.  (values RATE KNOWN-P).

Without Incudine there is no real rate, and then every figure in hertz
is a guess.  48000 is therefore not a silent default value: KNOWN-P says
whether the value comes from the audio side, and the display labels the
axis accordingly.  A frequency axis that is scaled wrongly and does not
say that it might be is worse than none at all."
  (let ((from-function
          (let ((sym (%rt-sym "RT-SAMPLE-RATE")))
            (when sym (ignore-errors (funcall sym))))))
    (let ((raw (or (and (realp from-function) (plusp from-function)
                        from-function)
                   (let ((v (%rt-value "*SAMPLE-RATE*")))
                     (and (realp v) (plusp v) v)))))
      (if raw
          (values (float raw 1.0d0) t)
          (values 48000.0d0 nil)))))

(defun %finite-db (value floor-db)
  "Put non-finite dB values on the floor.

%finite-sample maps NaN to 0 — right for a sample, the opposite for a
decibel value: 0 dB is full scale.  A feedback loop that is producing
NaN right now would thereby look like a spectrum at full level across
all frequencies."
  (handler-case
      (let ((x (float value 1.0d0)))
        (if (and (= x x) (< (abs x) 1.0d38)) (max floor-db (min 0.0d0 x)) floor-db))
    (error () floor-db)))

(defun %spectrum-edge (index columns f-min f-max log-p)
  "Lower frequency of column INDEX (0..COLUMNS, i.e. edges, not centres)."
  (let ((fraction (/ (float index 1.0d0) (float columns 1.0d0))))
    (if log-p
        (* f-min (expt (/ f-max f-min) fraction))
        (+ f-min (* fraction (- f-max f-min))))))

(defun %sticker-state-window-samples (state end-sequence n)
  "The N samples ending at absolute position END-SEQUENCE, oldest first.

The ring holds the samples with absolute indices
[SEQUENCE - COUNT, SEQUENCE).  END-SEQUENCE is such an absolute index,
not an offset — that is what makes the spectrogram's frame grid stable:
frame F always covers the same samples, whoever asks and whenever, so two
requests cannot return the same column twice or leave a gap between them.

Returns NIL when the window has already fallen out of the ring.  NIL and
not a zero-filled array: silence and \"too late\" must not look alike."
  (let* ((sequence (sticker-state-sequence state))
         (count (sticker-state-count state))
         (capacity (sticker-state-capacity state))
         (start (- end-sequence n)))
    (when (or (< n 1) (zerop capacity)
              (> end-sequence sequence)
              (< start (- sequence count)))
      (return-from %sticker-state-window-samples nil))
    (let ((double-p (eq (sticker-state-element-type state) 'double-float))
          (write-index (sticker-state-write-index state))
          (out (make-array n :element-type 'double-float
                             :initial-element 0.0d0)))
      (dotimes (offset n out)
        (let ((index (mod (- write-index (- sequence (+ start offset))) capacity)))
          (setf (aref out offset)
                (if double-p
                    (aref (sticker-state-samples state) index)
                    (%finite-sample (svref (sticker-state-values state) index)))))))))

(defun %spectrum-of-samples (samples fft-size window columns mode floor-db
                             effective-rate)
  "One analysis frame.  Returns
  (values COLUMNS-LIST PEAK-FREQ PEAK-DB NONFINITE F-MIN F-MAX LOG-P).

Factored out of sticker-spectrum-for-repl so that the spectrogram uses
exactly the same computation.  Two copies of a windowed FFT plus column
reduction would be the most reliable way to end up with a scope and a
spectrogram that disagree about where a partial sits — and disagree
invisibly, because both pictures look plausible on their own."
  (declare (type (simple-array double-float (*)) samples))
  (let* ((bin-width (/ effective-rate (float fft-size 1.0d0)))
         (nyquist (* 0.5d0 effective-rate))
         (half (ash fft-size -1))
         (w (%fft-window window fft-size))
         (re (make-array fft-size :element-type 'double-float
                                  :initial-element 0.0d0))
         (im (make-array fft-size :element-type 'double-float
                                  :initial-element 0.0d0))
         (window-sum 0.0d0)
         (nonfinite 0))
    (declare (type double-float window-sum))
    ;; Windowing.  Non-finite samples become 0 — otherwise a single NaN
    ;; colours the whole spectrum and the picture shows silence although
    ;; the DSP is running away.
    (dotimes (i fft-size)
      (let ((x (aref samples i)))
        (unless (and (= x x) (< (abs x) 1.0d38))
          (incf nonfinite)
          (setf x 0.0d0))
        (incf window-sum (aref w i))
        (setf (aref re i) (* x (aref w i)))))
    (%fft-forward re im)
    (let* ((scale (/ 2.0d0 (max 1.0d-12 window-sum)))
           (db (make-array half :element-type 'double-float
                                :initial-element floor-db)))
      (dotimes (k half)
        (let* ((magnitude (* scale (sqrt (+ (* (aref re k) (aref re k))
                                            (* (aref im k) (aref im k))))))
               (value (if (> magnitude 1.0d-12)
                          (* 20.0d0 (log magnitude 10.0d0))
                          floor-db)))
          (setf (aref db k) (%finite-db value floor-db))))
      ;; Peak: bin 0 is left out, a DC offset is not a tone.  The parabola
      ;; through the three neighbours in dB gives the frequency between
      ;; the bins — the same computation with which the ATS analysis
      ;; places its partials.
      (let ((best 1) (peak-freq 0.0d0) (peak-db floor-db))
        (loop for k from 1 below half
              do (when (> (aref db k) (aref db best)) (setf best k)))
        (when (> (aref db best) floor-db)
          (let ((delta 0.0d0) (lift 0.0d0))
            (when (and (> best 0) (< best (1- half)))
              (let* ((left (aref db (1- best)))
                     (centre (aref db best))
                     (right (aref db (1+ best)))
                     (divisor (- (+ left right) (* 2.0d0 centre))))
                (unless (zerop divisor)
                  (setf delta (max -0.5d0
                                   (min 0.5d0
                                        (* 0.5d0 (/ (- left right) divisor)))))
                  ;; The SAME parabola also gives the level at its apex,
                  ;; and it has to be used. Up to 1.0.5 only the frequency
                  ;; was corrected and the level was read off the raw bin
                  ;; — but a tone between two bins falls into the flank of
                  ;; the window, so its bin is TOO QUIET: about 0.6 dB at
                  ;; a third of a bin, up to 1.4 dB at half a bin with
                  ;; Hann. The readout was therefore systematically low,
                  ;; and by an amount that depends on where the tone
                  ;; happens to fall relative to the grid — which is why
                  ;; it looked like measurement noise rather than a bug.
                  ;; A sine of amplitude 0.2 read -14.6 dBFS where -13.98
                  ;; is right.
                  (setf lift (* -0.25d0 (- left right) delta)))))
            (setf peak-freq (* (+ (float best 1.0d0) delta) bin-width)
                  ;; Never above 0 dB: the correction is an interpolation,
                  ;; not a licence to report more than full scale.
                  peak-db (min 0.0d0 (+ (aref db best) lift)))))
        ;; Column reduction.
        (let* ((log-p (and (string-equal (string mode) "log")
                           (< bin-width (* 0.5d0 nyquist))))
               (f-min (if log-p (max 20.0d0 bin-width) 0.0d0))
               (f-max nyquist)
               (values* '()))
          (loop for c from (1- columns) downto 0
                do (let* ((lo-freq (%spectrum-edge c columns f-min f-max log-p))
                          (hi-freq (%spectrum-edge (1+ c) columns f-min f-max log-p))
                          (lo (max (if log-p 1 0)
                                   (min (1- half) (round lo-freq bin-width))))
                          (hi (max (1+ lo)
                                   (min half (round hi-freq bin-width))))
                          (best-db floor-db))
                     (loop for k from lo below hi
                           do (when (> (aref db k) best-db)
                                (setf best-db (aref db k))))
                     (push best-db values*)))
          (values values* (%finite-sample peak-freq) (%finite-db peak-db floor-db)
                  nonfinite f-min f-max log-p))))))

(defun %spectrum-warnings (rate-known-p decimation effective-rate nonfinite)
  "The warnings shared by the spectrum and the spectrogram."
  (let ((warnings '()))
    (unless rate-known-p
      (push "Sample rate unknown (Incudine not loaded), axis computed with 48000 Hz"
            warnings))
    (when (> decimation 1)
      (push (format nil "Ring is decimated by ~D: effectively ~,1F Hz, everything above that is folded in"
                    decimation effective-rate)
            warnings))
    (when (> nonfinite 0)
      (push (format nil "~D non-finite samples counted as 0" nonfinite)
            warnings))
    (nreverse warnings)))

(defun %spectrum-preconditions (state key fft-size)
  "Shared argument checks.  Returns an (:error TEXT) list, or NIL if all is well."
  (cond
    ((not (typep state 'sticker-state))
     (list :error (format nil "No ring registered under ~S." key)))
    ((not (%power-of-two-p fft-size))
     (list :error (format nil "FFT length ~A is not a power of two." fft-size)))
    ((or (< fft-size 64) (> fft-size 16384))
     (list :error (format nil "FFT length ~A is outside 64..16384." fft-size)))
    ((< (sticker-state-capacity state) fft-size)
     (list :error (format nil "Ring ~S holds ~D values, the FFT needs ~D."
                          key (sticker-state-capacity state) fft-size)))
    ((< (sticker-state-count state) fft-size)
     (list :error (format nil "Ring ~S has only ~D of ~D values so far."
                          key (sticker-state-count state) fft-size)))
    (t nil)))

(defun sticker-spectrum-for-repl (key &optional (fft-size 1024) (window "hann")
                                            (columns 256) (mode "log")
                                            (floor-db -96.0))
  "Spectrum of the newest FFT-SIZE values of the ring KEY.

Returns: (:ok HEADER VALUES) or (:error TEXT).

HEADER is
  (SAMPLE-RATE EFFECTIVE-RATE FFT-SIZE MODE F-MIN F-MAX FLOOR-DB
   PEAK-FREQ PEAK-DB BIN-WIDTH WARNINGS)

VALUES are COLUMNS decibel values, lowest frequency first, each the
maximum of the bins of its column.  Maximum and not mean, because a
single partial would otherwise look the weaker the wider the column is —
and the columns get wider and wider towards high frequencies.

The scaling is chosen so that a sine of amplitude 1 on a bin centre
gives 0 dB, independently of window and window length."
  (let* ((state (gethash key *sticker-records*))
         (problem (%spectrum-preconditions state key fft-size)))
    (or problem
        (multiple-value-bind (sample-rate rate-known-p) (%spectrum-sample-rate)
          (let* ((columns (max 16 (min 1024 (truncate columns))))
                 (floor-db (min -6.0d0 (float floor-db 1.0d0)))
                 (decimation (sticker-state-decimation state))
                 (effective-rate (/ sample-rate (float (max 1 decimation) 1.0d0)))
                 (bin-width (/ effective-rate (float fft-size 1.0d0)))
                 (samples (%sticker-state-tail-samples state fft-size)))
            (multiple-value-bind (values* peak-freq peak-db nonfinite f-min f-max log-p)
                (%spectrum-of-samples samples fft-size window columns mode
                                      floor-db effective-rate)
              (list :ok
                    (list sample-rate effective-rate fft-size
                          (if log-p "log" "lin")
                          f-min f-max floor-db peak-freq peak-db bin-width
                          (%spectrum-warnings rate-known-p decimation
                                              effective-rate nonfinite))
                    values*)))))))

;;; ---------------------------------------------------------------------
;;; Spectrogram: several frames per request, on an absolute grid
;;; ---------------------------------------------------------------------
;;;
;;; The obvious implementation would be to call the spectrum once per
;;; drawn frame.  That gives a spectrogram whose time resolution is the
;;; POLL INTERVAL: at 50 ms, twenty columns per second, and the picture is
;;; a slideshow rather than a spectrogram.  Worse, the spacing between
;;; columns would be however long the round trip happened to take, so the
;;; time axis would be unlabelled and unlabellable.
;;;
;;; So the frames live on an absolute grid instead: frame F covers the
;;; samples [F*HOP - FFT-SIZE, F*HOP).  The consequences are the point of
;;; the whole arrangement:
;;;
;;;   - The time axis has a unit.  One column is HOP samples, that is
;;;     HOP/RATE seconds, regardless of network and load.
;;;   - Frames cannot be duplicated or lost silently.  The caller says
;;;     which frame index it last received; what is missing follows, and
;;;     what has fallen out of the ring in the meantime is REPORTED rather
;;;     than skipped.  A spectrogram with an invisible gap is a lie about
;;;     time, and the eye cannot detect it.
;;;   - Time resolution and update rate are decoupled.  At 20 requests a
;;;     second with 8 frames each and a hop of 256, the axis carries 160
;;;     columns per second while the wire sees 20 messages.

(defun sticker-spectrogram-for-repl (key &optional (fft-size 1024) (window "hann")
                                               (columns 256) (mode "log")
                                               (floor-db -96.0) (since 0)
                                               (hop 512) (max-frames 16))
  "Analysis frames of the ring KEY since frame index SINCE.

Returns: (:ok HEADER FRAMES) or (:error TEXT).

HEADER is
  (SAMPLE-RATE EFFECTIVE-RATE FFT-SIZE MODE F-MIN F-MAX FLOOR-DB
   BIN-WIDTH HOP FRAME SECONDS-PER-FRAME DROPPED WARNINGS)

FRAME is the index of the NEWEST frame returned; the caller sends it back
as SINCE next time.  DROPPED counts the frames that fell out of the ring
between two requests — they are named, not passed over, because a gap in
a spectrogram is invisible and would misdate everything after it.

FRAMES is a list of frames, oldest first, each a list of COLUMNS decibel
values.  At SINCE = 0 only the newest MAX-FRAMES are delivered: on
opening, the present matters and not the minutes before anyone looked."
  (let* ((state (gethash key *sticker-records*))
         (problem (%spectrum-preconditions state key fft-size)))
    (when problem (return-from sticker-spectrogram-for-repl problem))
    (let ((hop (max 16 (min fft-size (truncate hop)))))
      (multiple-value-bind (sample-rate rate-known-p) (%spectrum-sample-rate)
        (let* ((columns (max 16 (min 1024 (truncate columns))))
               (floor-db (min -6.0d0 (float floor-db 1.0d0)))
               (max-frames (max 1 (min 64 (truncate max-frames))))
               (decimation (sticker-state-decimation state))
               (effective-rate (/ sample-rate (float (max 1 decimation) 1.0d0)))
               (bin-width (/ effective-rate (float fft-size 1.0d0)))
               (sequence (sticker-state-sequence state))
               (count (sticker-state-count state))
               ;; The newest frame whose window is complete, and the
               ;; oldest one still inside the ring.
               (newest (floor sequence hop))
               (oldest (ceiling (+ (- sequence count) fft-size) hop))
               (wanted-from (max (1+ (truncate (max 0 since))) oldest))
               (first-frame (max wanted-from (- newest (1- max-frames))))
               (dropped (max 0 (- first-frame wanted-from)))
               (frames '())
               (nonfinite 0)
               (delivered since))
          (loop for f from first-frame to newest
                do (let ((samples (%sticker-state-window-samples
                                   state (* f hop) fft-size)))
                     ;; A window can fall out between the arithmetic above
                     ;; and reading it: the audio thread keeps writing. Not
                     ;; an error — count it as dropped and carry on.
                     (if (null samples)
                         (incf dropped)
                         (multiple-value-bind (values* peak-freq peak-db bad)
                             (%spectrum-of-samples samples fft-size window columns
                                                   mode floor-db effective-rate)
                           (declare (ignore peak-freq peak-db))
                           (incf nonfinite bad)
                           (push values* frames)
                           (setf delivered f)))))
          ;; f-min/f-max/log-p do not depend on the samples, so one probe
          ;; frame settles the axis even when nothing was delivered.
          (multiple-value-bind (ignored-values ignored-freq ignored-db ignored-bad
                                f-min f-max log-p)
              (%spectrum-of-samples (%sticker-state-tail-samples state fft-size)
                                    fft-size window columns mode floor-db
                                    effective-rate)
            (declare (ignore ignored-values ignored-freq ignored-db ignored-bad))
            (list :ok
                  (list sample-rate effective-rate fft-size
                        (if log-p "log" "lin")
                        f-min f-max floor-db bin-width hop
                        delivered
                        (/ (float hop 1.0d0) effective-rate)
                        dropped
                        (%spectrum-warnings rate-known-p decimation
                                            effective-rate nonfinite))
                  (nreverse frames))))))))

;;; ---------------------------------------------------------------------
;;; Buffer outline: a waveform reduced to the columns that get drawn
;;; ---------------------------------------------------------------------
;;;
;;; The same argument as for the spectrum, only more so.  An eight-minute
;;; recording at 44100 Hz is twenty million samples; a display is eight
;;; hundred pixels wide.  Whatever is transferred, 99.996 % of it would be
;;; thrown away at the far end.  So the reduction happens here.
;;;
;;; But it is NOT the spectrum's reduction, and that is the point of this
;;; section.  The spectrum takes the maximum per column, because a partial
;;; is a peak and the loudest bin is the honest answer.  A waveform reduced
;;; by maximum alone shows only its upper half: everything below zero
;;; vanishes, and a symmetric signal comes out looking like a
;;; one-sided envelope — plausible, wrong, and wrong in a way that looks
;;; like a plausible waveform.
;;;
;;; So each column carries THREE numbers: minimum, maximum and RMS.  The
;;; first two draw the envelope, which is what makes clipping and DC offset
;;; visible; the RMS drawn on top of it is the perceived body, which is
;;; what makes a compressed passage distinguishable from a loud one.  Peak
;;; and RMS in one picture is the difference between "this reaches full
;;; scale" and "this is loud".

(defun %buffer-access (obj)
  "How to read OBJ frame by frame.

Returns (values READER FRAMES CHANNELS SAMPLE-RATE NOTE), where READER is
a function (frame channel) -> double-float, or NIL when OBJ is nothing
that can be read as audio.

Two kinds are accepted, and the second one is not a convenience: an
Incudine buffer, and any ordinary Lisp vector of numbers.  The vector path
is what makes the whole reduction testable against a bare SBCL, without
Incudine, without an audio device and without a sound file — the same
reason rpc.lisp as a whole avoids depending on the audio stack.  A
reduction that can only be checked by looking at a picture is a reduction
nobody checks."
  (let ((frames-fn (%rt-sym "BUFFER-FRAMES"))
        (channels-fn (%rt-sym "BUFFER-CHANNELS"))
        (rate-fn (%rt-sym "BUFFER-SAMPLE-RATE"))
        (value-fn (%rt-sym "BUFFER-VALUE")))
    (when (and frames-fn value-fn)
      (let ((frames (ignore-errors (funcall frames-fn obj))))
        (when (and (integerp frames) (plusp frames))
          (let ((channels (or (and channels-fn
                                   (ignore-errors (funcall channels-fn obj)))
                              1))
                (rate (or (and rate-fn (ignore-errors (funcall rate-fn obj)))
                          0)))
            (return-from %buffer-access
              (values (lambda (frame channel)
                        ;; buffer-value indexes the flat, interleaved data.
                        (%finite-sample
                         (funcall value-fn obj (+ (* frame channels) channel))))
                      frames (max 1 channels) (float rate 1.0d0) nil)))))))
  (typecase obj
    ((and vector (not string))
     (values (lambda (frame channel)
               (declare (ignore channel))
               (%finite-sample (aref obj frame)))
             (length obj) 1 0.0d0
             "plain vector: no sample rate, the time axis is in frames"))
    (t (values nil 0 0 0.0d0 "not a buffer and not a vector of samples"))))

(defun %buffer-columns (reader frames channels channel start end columns)
  "Reduces the range [START, END) to COLUMNS triples (min max rms).

Every sample of the range is looked at, none is skipped.  Decimating by
stepping — reading every Nth sample — is the obvious shortcut and it is
wrong for exactly the case one wants a waveform for: a single clipped
sample between two steps is invisible, and a click is nothing but that.
The cost is linear in the range, but it is paid here, where the data
already is, and once per request rather than per pixel."
  (let* ((span (max 1 (- end start)))
         (per-column (/ (float span 1.0d0) (float columns 1.0d0)))
         (out '()))
    (loop for c from (1- columns) downto 0
          do (let* ((from (+ start (floor (* c per-column))))
                    (to (min end (max (1+ from)
                                      (+ start (floor (* (1+ c) per-column))))))
                    (lo 0.0d0) (hi 0.0d0) (sum 0.0d0) (n 0))
               (declare (type double-float lo hi sum))
               (loop for i from from below to
                     do (let ((v (funcall reader i channel)))
                          (when (zerop n) (setf lo v hi v))
                          (when (< v lo) (setf lo v))
                          (when (> v hi) (setf hi v))
                          (incf sum (* v v))
                          (incf n)))
               (push (list lo hi (if (plusp n) (sqrt (/ sum n)) 0.0d0)) out)))
    out))

(defun %display-eval (expr-string pkg)
  "Evaluates EXPR-STRING in PKG for a display.  (values OBJECT NOTE).

If the expression is a bare symbol that is unbound in PKG, all packages
are searched for a bound symbol of that name, and the one found is used —
with NOTE saying where it came from.

This is not convenience, it is the difference between a view that works
and one that is right but useless.  The REPL carries its own current
package; a file's package comes from its last (in-package ...) form, and a
scratch file usually has none, so it falls back to COMMON-LISP-USER.  Put
a buffer in *buf* at a CLAMPS> prompt, put the cursor on *buf* in that
file, and the display honestly reports \"unbound\" about a different
symbol of the same name.  Both sides are correct and the user is stuck.

Searching is only done for a BARE SYMBOL, and only after the lookup in the
named package has failed.  A qualified name means what it says, and an
expression with side effects must not be evaluated twice in two packages."
  (let ((form (let ((*package* pkg) (*read-eval* nil))
                (read-from-string expr-string))))
    (handler-case (values (let ((*package* pkg) (*read-eval* nil)) (eval form))
                          nil)
      (unbound-variable (e)
        ;; The test is on the TEXT, not on the form: reading
        ;; "cl-user::*x*" yields a symbol like any other, and by then
        ;; there is no telling whether a package was named. A colon in
        ;; the source means the user said where to look, and that is
        ;; where we look.
        (if (or (not (symbolp form)) (find #\: expr-string))
            (error e)
            (let ((name (symbol-name form))
                  (found '()))
              (dolist (other (list-all-packages))
                (multiple-value-bind (sym status) (find-symbol name other)
                  (declare (ignore status))
                  (when (and sym (boundp sym)
                             (not (member sym found))
                             (not (eq (symbol-package sym) pkg)))
                    (push sym found))))
              (if (null found)
                  (error e)
                  (let ((sym (first found)))
                    (values (symbol-value sym)
                            (format nil "~A is not bound in ~A; using ~A::~A~@[ (~A)~]"
                                    name (package-name pkg)
                                    (package-name (symbol-package sym))
                                    (symbol-name sym)
                                    "the file has no in-package form"))))))))))

(defun buffer-outline-for-repl (expr-string &optional (package-name "COMMON-LISP-USER")
                                              (start 0) (end -1) (columns 512)
                                              (channel 0))
  "Waveform outline of the buffer that EXPR-STRING evaluates to.

Returns (:ok HEADER COLUMNS) or (:error TEXT).

HEADER is
  (FRAMES CHANNELS SAMPLE-RATE DURATION START END COLUMNS CHANNEL
   PEAK RMS CLIPPED WARNINGS)

COLUMNS is a list of (MIN MAX RMS) triples, left to right.  END = -1 means
\"to the end of the buffer\", so that the common case needs no arithmetic
at the caller.

PEAK and CLIPPED are computed over the requested range, not over the drawn
columns: a single sample at full scale must be reported even when it is
one of fifty thousand behind one pixel.  That is the whole reason for
looking at a waveform.

*read-eval* stays off while reading the expression, as everywhere else
here: an inspector view must not be a way to run arbitrary code through a
display refresh."
  (let ((pkg (or (find-package (string-upcase package-name))
                 (find-package :common-lisp-user))))
    (handler-case
        (multiple-value-bind (obj package-note) (%display-eval expr-string pkg)
          (multiple-value-bind (reader frames channels rate note)
              (%buffer-access obj)
            (cond
              ((null reader)
               (list :error (format nil "~A is ~A." expr-string
                                    (or note "not readable as audio"))))
              (t
               (let* ((columns (max 16 (min 4096 (truncate columns))))
                      (channel (max 0 (min (1- channels) (truncate channel))))
                      (start (max 0 (min (1- frames) (truncate start))))
                      (end (if (minusp end)
                               frames
                               (max (1+ start) (min frames (truncate end)))))
                      ;; More columns than samples would give empty
                      ;; columns; the display then draws gaps that are not
                      ;; in the signal.
                      (columns (min columns (- end start)))
                      (values* (%buffer-columns reader frames channels channel
                                                start end columns))
                      (peak 0.0d0) (sum 0.0d0) (clipped 0))
                 (declare (type double-float peak sum))
                 (loop for i from start below end
                       do (let* ((v (funcall reader i channel))
                                 (a (abs v)))
                            (when (> a peak) (setf peak a))
                            (when (>= a 1.0d0) (incf clipped))
                            (incf sum (* v v))))
                 (list :ok
                       (list frames channels rate
                             (if (plusp rate) (/ (float frames 1.0d0) rate) 0.0d0)
                             start end columns channel
                             peak
                             (if (> end start)
                                 (sqrt (/ sum (- end start)))
                                 0.0d0)
                             clipped
                             (let ((warnings '()))
                               (when package-note (push package-note warnings))
                               (when note (push note warnings))
                               (when (zerop rate)
                                 (push "Sample rate unknown, the axis is in frames"
                                       warnings))
                               (when (> clipped 0)
                                 (push (format nil "~D sample(s) at or above full scale"
                                               clipped)
                                       warnings))
                               (nreverse warnings)))
                       values*))))))
      (error (e) (list :error (princ-to-string e))))))

;;; ---------------------------------------------------------------------
;;; ATS files: partials over time
;;; ---------------------------------------------------------------------
;;;
;;; ATS (Analysis-Transformation-Synthesis, Juan Pampin) stores what a
;;; spectrogram only shows: not a grid of bins, but tracked partials —
;;; each with its own frequency and amplitude trajectory — plus residual
;;; noise in critical bands.  A spectrogram makes you infer the partials;
;;; an ATS file already knows them, and the display can therefore let you
;;; pick one out and follow it.
;;;
;;; The file is a header of ten double-floats followed by frames.  The
;;; first of them is the magic number 123.0, which exists to reveal the
;;; byte order: read it little-endian, and if it is not 123.0, the file
;;; was written big-endian.
;;;
;;; What is read here is the format as documented by ATS; I have taken
;;; care to make the reader say when reality disagrees rather than
;;; interpret whatever it finds.  Hence %ats-expected-size below: the
;;; header determines exactly how long the file must be, and if it is not
;;; that long, something about the assumed layout is wrong.  Reporting
;;; that is worth more than a picture of misread doubles, which would look
;;; like a perfectly good analysis of a different sound.

(defparameter *ats-magic* 123.0d0
  "First double of an ATS file, present to reveal the byte order.")

(defparameter *ats-noise-bands* 25
  "Critical bands of residual noise in ATS types 3 and 4.")

(defun %ieee-double (bits)
  "The double-float for 64 raw IEEE-754 BITS.

Written out rather than taken from an SBCL internal: this runs on bytes
read from a file, and the one thing it must not do is depend on a
representation that changes between implementations. Infinities and NaN
become 0 — a display has no use for them, and a NaN in a frequency would
propagate into the axis."
  (let* ((sign (if (logbitp 63 bits) -1 1))
         (exponent (ldb (byte 11 52) bits))
         (mantissa (ldb (byte 52 0) bits)))
    (cond ((= exponent 2047) 0.0d0)
          ((zerop exponent) (* sign (scale-float (float mantissa 1.0d0) -1074)))
          (t (* sign (scale-float (float (logior mantissa (ash 1 52)) 1.0d0)
                                  (- exponent 1075)))))))

(defun %ats-double (bytes offset big-endian-p)
  "The double at byte OFFSET of BYTES."
  (let ((bits 0))
    (if big-endian-p
        (dotimes (i 8) (setf bits (logior (ash bits 8) (aref bytes (+ offset i)))))
        (loop for i from 7 downto 0
              do (setf bits (logior (ash bits 8) (aref bytes (+ offset i))))))
    (%ieee-double bits)))

(defun %ats-frame-doubles (partials type)
  "Doubles per frame for a file of TYPE with PARTIALS partials.

  1: time, then (amp frq) per partial
  2: time, then (amp frq pha) per partial
  3: like 1 plus 25 noise bands
  4: like 2 plus 25 noise bands"
  (+ 1
     (* partials (if (member type '(2 4)) 3 2))
     (if (member type '(3 4)) *ats-noise-bands* 0)))

(defun %ats-expected-size (partials frames type)
  "The exact length an ATS file with this header must have, in bytes."
  (* 8 (+ 10 (* frames (%ats-frame-doubles partials type)))))

(defun %ats-read-header (bytes)
  "Reads the ten header doubles.  (values PLIST BIG-ENDIAN-P) or NIL.

The magic number decides the byte order, and it is also the only check
that this is an ATS file at all."
  (when (< (length bytes) 80)
    (return-from %ats-read-header nil))
  (let ((big-endian-p nil))
    (cond ((= (%ats-double bytes 0 nil) *ats-magic*) (setf big-endian-p nil))
          ((= (%ats-double bytes 0 t) *ats-magic*) (setf big-endian-p t))
          (t (return-from %ats-read-header nil)))
    (flet ((d (i) (%ats-double bytes (* 8 i) big-endian-p)))
      (values (list :sample-rate (d 1)
                    :frame-size (d 2)
                    :window-size (d 3)
                    :partials (truncate (d 4))
                    :frames (truncate (d 5))
                    :max-amplitude (d 6)
                    :max-frequency (d 7)
                    :duration (d 8)
                    :type (truncate (d 9)))
              big-endian-p))))

(defun %ats-read-file (path)
  "The whole file as a byte vector, or NIL."
  (handler-case
      (with-open-file (in path :element-type '(unsigned-byte 8)
                               :if-does-not-exist nil)
        (when in
          (let ((bytes (make-array (file-length in)
                                   :element-type '(unsigned-byte 8))))
            (read-sequence bytes in)
            bytes)))
    (error () nil)))

(defun ats-outline-for-repl (path &optional (columns 400) (max-partials 128)
                                    (floor-db -96.0))
  "Partial trajectories of the ATS file at PATH, reduced to COLUMNS.

Returns (:ok HEADER PARTIALS NOISE) or (:error TEXT).

HEADER is
  (SAMPLE-RATE FRAME-SIZE WINDOW-SIZE PARTIAL-COUNT FRAME-COUNT MAX-AMPLITUDE
   MAX-FREQUENCY DURATION TYPE COLUMNS SHOWN-PARTIALS HAS-PHASE HAS-NOISE
   WARNINGS)

PARTIALS is a list, one entry per shown partial:
  (INDEX PEAK-AMPLITUDE MEAN-FREQUENCY (FREQ ...) (AMP-DB ...))
with COLUMNS values in each of the two trajectories.

Within a column the LOUDEST frame wins, for both frequency and amplitude
together. Averaging would be wrong in a way that is hard to see: where a
partial dies away and is reborn at another frequency, the mean lands
between the two and draws a line through a place the partial never was.

Partials are sorted by peak amplitude and cut off at MAX-PARTIALS, so that
a file with a thousand of them still yields a picture. Which ones were
dropped is stated in the warnings; silently showing the first 128 of a
thousand would misrepresent the analysis."
  (let ((bytes (%ats-read-file path)))
    (when (null bytes)
      (return-from ats-outline-for-repl
        (list :error (format nil "~A cannot be read." path))))
    (multiple-value-bind (header big-endian-p) (%ats-read-header bytes)
      (when (null header)
        (return-from ats-outline-for-repl
          (list :error (format nil "~A is not an ATS file (magic number missing)."
                               path))))
      (let* ((partials (getf header :partials))
             (frames (getf header :frames))
             (type (getf header :type))
             (warnings '()))
        (when (or (< partials 0) (< frames 0)
                  (not (member type '(1 2 3 4))))
          (return-from ats-outline-for-repl
            (list :error (format nil "Implausible ATS header: ~D partials, ~D frames, type ~D."
                                 partials frames type))))
        ;; The header determines the length exactly. A mismatch means the
        ;; assumed layout is wrong, and then every number after the header
        ;; is a misread double — which would draw a perfectly plausible
        ;; analysis of a sound that is not in the file.
        (let ((expected (%ats-expected-size partials frames type)))
          (unless (= expected (length bytes))
            (return-from ats-outline-for-repl
              (list :error
                    (format nil "~A: the header describes ~D bytes (~D partials, ~D frames, type ~D) but the file has ~D. The layout does not match; nothing is displayed rather than misread numbers."
                            path expected partials frames type (length bytes))))))
        (when (zerop frames)
          (return-from ats-outline-for-repl
            (list :error (format nil "~A contains no frames." path))))

        (let* ((columns (max 8 (min 2048 (truncate columns) frames)))
               (max-partials (max 1 (min 512 (truncate max-partials))))
               (floor-db (min -6.0d0 (float floor-db 1.0d0)))
               (per-frame (%ats-frame-doubles partials type))
               (stride (if (member type '(2 4)) 3 2))
               (has-noise (member type '(3 4)))
               (frame-bytes (* 8 per-frame))
               (base 80))
          (flet ((frame-double (frame index)
                   (%ats-double bytes (+ base (* frame frame-bytes) (* 8 index))
                                big-endian-p)))
            ;; Peak amplitude per partial, to decide what is worth showing.
            (let ((peaks (make-array partials :element-type 'double-float
                                              :initial-element 0.0d0)))
              (dotimes (f frames)
                (dotimes (p partials)
                  (let ((amp (abs (frame-double f (+ 1 (* p stride))))))
                    (when (> amp (aref peaks p)) (setf (aref peaks p) amp)))))
              (let* ((order (sort (loop for p from 0 below partials collect p)
                                  #'> :key (lambda (p) (aref peaks p))))
                     (shown (subseq order 0 (min max-partials partials)))
                     ;; Back into index order: a display that lists partials
                     ;; by loudness instead of by number is hard to compare
                     ;; against the analysis itself.
                     (shown (sort shown #'<))
                     (per-column (/ (float frames 1.0d0) (float columns 1.0d0)))
                     (result '()))
                (when (< (length shown) partials)
                  (push (format nil "~D of ~D partials shown, the quietest ~D omitted"
                                (length shown) partials (- partials (length shown)))
                        warnings))
                ;; Cross-check the header against the body.
                ;;
                ;; max-amplitude and max-frequency are stated in the header
                ;; AND derivable from the frames, so the two must agree. If
                ;; they do not, either the file is inconsistent or — far
                ;; more likely — this reader is walking the frames wrongly
                ;; and the numbers it computes come from the wrong offsets.
                ;; What it catches, tried against a real analysis: the
                ;; two fields swapped, a stride wrong within the frame, an
                ;; amplitude read from a frequency slot. What it does NOT
                ;; catch, equally tried: a frame offset wrong by one. In a
                ;; sustained sound the maximum barely moves between
                ;; neighbouring frames, so the check stays silent — it is a
                ;; cross-check, not a proof, and claiming otherwise here
                ;; would be the same kind of false confidence it is meant
                ;; to prevent.
                (let ((peak-amp 0.0d0) (peak-freq 0.0d0))
                  (declare (type double-float peak-amp peak-freq))
                  (dotimes (p partials)
                    (when (> (aref peaks p) peak-amp) (setf peak-amp (aref peaks p))))
                  (dolist (entry result)
                    (when (> (third entry) peak-freq) (setf peak-freq (third entry))))
                  (let ((stated-amp (getf header :max-amplitude))
                        (stated-freq (getf header :max-frequency)))
                    (when (and (> stated-amp 0.0d0)
                               (> (abs (- peak-amp stated-amp)) (* 0.02d0 stated-amp)))
                      (push (format nil "header says max amplitude ~,5F, the frames give ~,5F"
                                    stated-amp peak-amp)
                            warnings))
                    (when (and (> stated-freq 0.0d0) (> peak-freq 0.0d0)
                               (> (abs (- peak-freq stated-freq)) (* 0.05d0 stated-freq)))
                      (push (format nil "header says max frequency ~,1F Hz, the frames give ~,1F Hz"
                                    stated-freq peak-freq)
                            warnings))))
                (dolist (p shown)
                  (let ((freqs '()) (amps '()) (sum 0.0d0) (n 0))
                    (declare (type double-float sum))
                    (loop for c from (1- columns) downto 0
                          do (let ((from (floor (* c per-column)))
                                   (to (max (1+ (floor (* c per-column)))
                                            (min frames (floor (* (1+ c) per-column)))))
                                   (best-amp 0.0d0) (best-freq 0.0d0))
                               (loop for f from from below to
                                     do (let ((amp (abs (frame-double f (+ 1 (* p stride))))))
                                          (when (>= amp best-amp)
                                            (setf best-amp amp
                                                  best-freq (frame-double
                                                             f (+ 2 (* p stride)))))))
                               (push (%finite-sample best-freq) freqs)
                               (push (if (> best-amp 1.0d-9)
                                         (max floor-db (* 20.0d0 (log best-amp 10.0d0)))
                                         floor-db)
                                     amps)
                               (when (> best-amp 1.0d-9)
                                 (incf sum best-freq) (incf n))))
                    (push (list p (%finite-sample (aref peaks p))
                                (if (plusp n) (/ sum n) 0.0d0)
                                freqs amps)
                          result)))
                ;; Residual noise, reduced the same way: the loudest frame
                ;; of a column wins.
                (let ((noise '()))
                  (when has-noise
                    (let ((offset (+ 1 (* partials stride))))
                      (loop for band from (1- *ats-noise-bands*) downto 0
                            do (let ((values* '()))
                                 (loop for c from (1- columns) downto 0
                                       do (let ((from (floor (* c per-column)))
                                                (to (max (1+ (floor (* c per-column)))
                                                         (min frames (floor (* (1+ c) per-column)))))
                                                (best 0.0d0))
                                            (loop for f from from below to
                                                  do (let ((v (abs (frame-double
                                                                    f (+ offset band)))))
                                                       (when (> v best) (setf best v))))
                                            (push (if (> best 1.0d-9)
                                                      (max floor-db
                                                           (* 20.0d0 (log best 10.0d0)))
                                                      floor-db)
                                                  values*)))
                                 (push values* noise)))))
                  (unless has-noise
                    (push "Type ~D carries no residual noise" warnings)
                    (setf warnings (cons (format nil "Type ~D carries no residual noise"
                                                 type)
                                         (rest warnings))))
                  (list :ok
                        (list (getf header :sample-rate)
                              (getf header :frame-size)
                              (getf header :window-size)
                              partials frames
                              (getf header :max-amplitude)
                              (getf header :max-frequency)
                              (getf header :duration)
                              type columns (length shown)
                              (if (member type '(2 4)) 1 0)
                              (if has-noise 1 0)
                              (nreverse warnings))
                        (nreverse result)
                        noise))))))))))

;;; ---------------------------------------------------------------------
;;; Playing an ATS analysis
;;; ---------------------------------------------------------------------
;;;
;;; The resynthesis itself is NOT implemented here, and that is deliberate.
;;; Turning partials back into sound is Incudine's and ats-cuda's job; they
;;; do it in the audio thread, with their own oscillator banks and their
;;; own noise model. A second implementation inside an editor extension
;;; would be a worse one, and worse in a way nobody would notice until a
;;; piece sounded subtly different from the analysis it came from.
;;;
;;; So this looks for what the image already has. The names differ between
;;; versions and between ats-cuda and CLAMPS's own wrappers, hence the
;;; candidate list rather than one hard-wired symbol — and hence the error
;;; message that names every candidate it tried. An editor that says "not
;;; available" without saying what it looked for leaves the user with
;;; nothing to act on.

(defparameter *ats-packages*
  '(:ats-cuda :ats :clamps :incudine :cl-user)
  "Packages searched for the ATS loading and synthesis functions.")

(defparameter *ats-load-names* '("ATS-LOAD" "LOAD-ATS" "ATS-READ")
  "Candidate names for reading an ATS file into an object.")

(defparameter *ats-synth-names*
  '("SIN-NOI-SYNTH" "ATS-PLAY" "ATS-SYNTH" "SIN-SYNTH")
  "Candidate names for the resynthesis, in order of preference.

SIN-NOI-SYNTH first because it plays partials AND residual noise; the
purely sinusoidal variants leave out precisely the part an ATS analysis
separated out with some effort.")

(defun %ats-sym (names)
  "The first fbound symbol from NAMES in any of *ats-packages*.
Returns (values SYMBOL PACKAGE-NAME NAME) or NIL."
  (dolist (name names nil)
    (dolist (pkg-name *ats-packages*)
      (let ((pkg (find-package pkg-name)))
        (when pkg
          (let ((sym (find-symbol name pkg)))
            (when (and sym (fboundp sym))
              (return-from %ats-sym
                (values sym (package-name pkg) name)))))))))

(defun %ats-missing-report (what names)
  "Says what was searched for, so that the answer is actionable."
  (format nil "No ~A function found. Searched for ~{~A~^, ~} in ~{~A~^, ~}. ~
Packages present: ~{~A~^, ~}."
          what names
          (mapcar #'string *ats-packages*)
          (or (remove nil (mapcar (lambda (p)
                                    (let ((found (find-package p)))
                                      (and found (package-name found))))
                                  *ats-packages*))
              (list "none of them"))))

(defvar *ats-playing* nil
  "The symbol the last loaded analysis was bound to.")

(defvar *ats-play-counter* 0
  "Serial number for the binding symbols, so that two files do not collide.")

(defun %ats-try (label thunk failures)
  "Runs THUNK, or records why it could not be run.

Returns (values RESULT SUCCEEDED-P FAILURES). The point is the recording:
the argument lists of these functions differ between ats-cuda versions, so
several have to be tried — and when they all fail, the user needs to see
each attempt with its own error. The first version reported only the last
one, and it blamed the synthesis for an error the LOADER had signalled."
  (handler-case (values (funcall thunk) t failures)
    (error (e)
      (values nil nil (cons (format nil "~A: ~A" label e) failures)))))

(defun ats-play-for-repl (path &optional (amplitude 1.0))
  "Loads the ATS file at PATH and hands it to the image's resynthesis.

Returns (:ok TEXT) or (:error TEXT).

The call conventions come from ats-cuda as it actually is, read off a
working session:

  (ats-load \"/tmp/cl.ats\" 'cl-new)
  (sin-noi-synth 0.0 cl-new :amp-scale 0.2)

Two things about that were guessed wrongly the first time round. ATS-LOAD
takes the path AND a symbol to bind the loaded sound to — it returns the
symbol, not the sound. And the start time is a FLOAT: sin-noi-synth
schedules on it, and an integer 0 is not the same thing there.

Both are still tried in several forms rather than assumed, because this is
the one part of the extension that cannot be checked by a gate: there is
no Incudine in the environment it is written in. What a gate can check —
and does — is that every failure names what was attempted."
  (let ((bytes (%ats-read-file path)))
    (when (null bytes)
      (return-from ats-play-for-repl
        (list :error (format nil "~A cannot be read." path))))
    (when (null (%ats-read-header bytes))
      (return-from ats-play-for-repl
        (list :error (format nil "~A is not an ATS file (magic number missing)."
                             path)))))
  (multiple-value-bind (loader loader-package loader-name)
      (%ats-sym *ats-load-names*)
    (when (null loader)
      (return-from ats-play-for-repl
        (list :error (%ats-missing-report "ATS loading" *ats-load-names*))))
    (multiple-value-bind (synth synth-package synth-name)
        (%ats-sym *ats-synth-names*)
      (when (null synth)
        (return-from ats-play-for-repl
          (list :error (%ats-missing-report "ATS synthesis" *ats-synth-names*))))
      (let* ((failures '())
             (binding (intern (format nil "*ATS-PLAY-~D*"
                                      (incf *ats-play-counter*))
                              :cl-user))
             (sound nil)
             (loaded nil))
        ;; Loading. The two-argument form first, because that is the one
        ;; observed in a real session; the single-argument form after it,
        ;; in case another implementation returns the sound directly.
        (multiple-value-bind (result ok rest)
            (%ats-try (format nil "~A::~A path symbol" loader-package loader-name)
                      (lambda ()
                        (funcall loader path binding)
                        (if (boundp binding) (symbol-value binding) binding))
                      failures)
          (setf failures rest)
          (when ok (setf sound result loaded t)))
        (unless loaded
          (multiple-value-bind (result ok rest)
              (%ats-try (format nil "~A::~A path" loader-package loader-name)
                        (lambda () (funcall loader path))
                        failures)
            (setf failures rest)
            (when ok (setf sound result loaded t))))
        (unless loaded
          (return-from ats-play-for-repl
            (list :error (format nil "Loading failed. Attempts: ~{~A~^; ~}"
                                 (reverse failures)))))
        (setf *ats-playing* binding)
        ;; Synthesis. The start time is a float in every attempt.
        (let ((amp (float amplitude 1.0)))
          (dolist (attempt
                   (list (cons "start sound :amp-scale"
                               (lambda () (funcall synth 0.0 sound :amp-scale amp)))
                         (cons "start sound"
                               (lambda () (funcall synth 0.0 sound)))
                         (cons "sound :amp-scale"
                               (lambda () (funcall synth sound :amp-scale amp)))
                         (cons "sound"
                               (lambda () (funcall synth sound)))))
            (multiple-value-bind (result ok rest)
                (%ats-try (format nil "~A::~A ~A" synth-package synth-name
                                  (car attempt))
                          (cdr attempt) failures)
              (declare (ignore result))
              (setf failures rest)
              (when ok
                (return-from ats-play-for-repl
                  (list :ok (format nil "Playing ~A via ~A::~A (~A), loaded with ~A::~A into cl-user::~A."
                                    (file-namestring path)
                                    synth-package synth-name (car attempt)
                                    loader-package loader-name
                                    (symbol-name binding))))))))
        (list :error (format nil "Synthesis failed. Attempts: ~{~A~^; ~}"
                             (reverse failures)))))))

(defun ats-stop-for-repl ()
  "Stops the playback by freeing the root group, as (free 0) does.

Not a dedicated stop function: none of the candidate synthesis functions
reliably has one, and freeing the root group is what CLAMPS's own examples
do. That it stops OTHER nodes too is stated rather than hidden — a button
that silently kills a running piece would be worse than no button."
  (let ((free (%rt-sym "FREE")))
    (if (null free)
        (list :error "Incudine is not loaded; nothing to stop.")
        (handler-case
            (progn (funcall free 0)
                   (setf *ats-playing* nil)
                   (list :ok "Freed node 0 — this stops ALL running nodes, not only the ATS playback."))
          (error (e) (list :error (format nil "free failed: ~A" e)))))))

;;; ---------------------------------------------------------------------
;;; Sample browser: what is in a directory of sound files
;;; ---------------------------------------------------------------------
;;;
;;; Reads the HEADERS only.  A directory of a few hundred samples is
;;; gigabytes; their headers are a few hundred bytes each, and everything
;;; a browser shows — duration, rate, channels, bit depth — is in them.
;;; Reading the audio data to find out how long a file is would make
;;; opening a folder a minute-long operation for information that is
;;; written down at the front.
;;;
;;; Two formats, and they are opposites in every respect.  WAV is RIFF,
;;; little-endian, chunk sizes exclude the header.  AIFF is IFF,
;;; big-endian, and stores its sample rate as an 80-BIT IEEE-754 EXTENDED
;;; float — a format nothing else uses and no Lisp reads natively.
;;;
;;; That last point is where this can go wrong invisibly.  Decode the
;;; extended float sloppily and 44100 comes out as 44099.99 or 44100.0000001,
;;; which passes every eyeball test, prints as "44100" at one decimal, and
;;; then makes every duration slightly wrong and every resampling ratio
;;; irrational.  Hence %read-extended-float below is exact, and the gate
;;; checks it against bit patterns rather than against a tolerance.

(defun %bytes-be (bytes offset count)
  "COUNT bytes at OFFSET as a big-endian unsigned integer."
  (let ((value 0))
    (dotimes (i count value)
      (setf value (logior (ash value 8) (aref bytes (+ offset i)))))))

(defun %bytes-le (bytes offset count)
  "COUNT bytes at OFFSET as a little-endian unsigned integer."
  (let ((value 0))
    (dotimes (i count value)
      (setf value (logior value (ash (aref bytes (+ offset i)) (* 8 i)))))))

(defun %read-extended-float (bytes offset)
  "The IEEE-754 80-bit extended float at OFFSET.  AIFF's sample rate.

Exact by construction, not approximately right.  The layout is a sign bit,
a 15-bit exponent with bias 16383, and a 64-bit mantissa whose leading bit
is EXPLICIT — unlike the 32- and 64-bit formats, where it is implied.
Forgetting that is the usual mistake and yields a value off by a factor of
two, which for a sample rate reads as 22050 where 44100 belongs: wrong, and
entirely plausible.

scale-float rather than expt: the exponent range of this format exceeds a
double-float's, and computing 2^exponent first would overflow before the
mantissa ever divided it back down."
  (let* ((sign (if (logbitp 7 (aref bytes offset)) -1 1))
         (exponent (logand (%bytes-be bytes offset 2) #x7FFF))
         (mantissa (%bytes-be bytes (+ offset 2) 8)))
    (cond ((and (zerop exponent) (zerop mantissa)) 0.0d0)
          ((= exponent #x7FFF) 0.0d0)   ; infinity or NaN: no use here
          (t (* sign (scale-float (float mantissa 1.0d0) (- exponent 16383 63)))))))

(defun %read-file-head (path bytes)
  "The first BYTES bytes of PATH, or NIL."
  (handler-case
      (with-open-file (in path :element-type '(unsigned-byte 8)
                               :if-does-not-exist nil)
        (when in
          (let* ((n (min bytes (file-length in)))
                 (buffer (make-array n :element-type '(unsigned-byte 8))))
            (read-sequence buffer in)
            buffer)))
    (error () nil)))

(defun %ascii (bytes offset count)
  (let ((out (make-string count)))
    (dotimes (i count out)
      (setf (char out i) (code-char (aref bytes (+ offset i)))))))

(defun %read-wav-header (bytes)
  "Header data of a RIFF/WAVE file, or NIL.

Walks the chunk list rather than assuming fmt sits at offset 12.  Files
written by editors regularly carry LIST, bext or JUNK chunks first, and an
assumed offset reads those as the format — yielding a plausible number of
channels and a nonsensical rate."
  (when (or (< (length bytes) 12)
            (not (string= (%ascii bytes 0 4) "RIFF"))
            (not (string= (%ascii bytes 8 4) "WAVE")))
    (return-from %read-wav-header nil))
  (let ((position 12)
        (channels nil) (rate nil) (bits nil) (data-bytes nil)
        (limit (length bytes)))
    (loop while (<= (+ position 8) limit)
          do (let ((id (%ascii bytes position 4))
                   (size (%bytes-le bytes (+ position 4) 4)))
               (cond
                 ((and (string= id "fmt ") (<= (+ position 24) limit))
                  (setf channels (%bytes-le bytes (+ position 10) 2)
                        rate (float (%bytes-le bytes (+ position 12) 4) 1.0d0)
                        bits (%bytes-le bytes (+ position 22) 2)))
                 ((string= id "data")
                  (setf data-bytes size)))
               ;; Chunks are padded to an even length, and the pad byte is
               ;; not counted in the size. Ignoring it shifts everything
               ;; after an odd chunk by one byte.
               (incf position (+ 8 size (mod size 2)))))
    (when (and channels rate bits (plusp channels) (plusp bits))
      (list :format "WAV" :channels channels :sample-rate rate
            :bit-depth bits
            :frames (if data-bytes
                        (floor data-bytes (max 1 (* channels (ceiling bits 8))))
                        0)))))

(defun %read-aiff-header (bytes)
  "Header data of an AIFF or AIFF-C file, or NIL."
  (when (or (< (length bytes) 12)
            (not (string= (%ascii bytes 0 4) "FORM"))
            (not (member (%ascii bytes 8 4) '("AIFF" "AIFC") :test #'string=)))
    (return-from %read-aiff-header nil))
  (let ((position 12)
        (channels nil) (frames nil) (bits nil) (rate nil)
        (compression nil)
        (limit (length bytes)))
    (loop while (<= (+ position 8) limit)
          do (let ((id (%ascii bytes position 4))
                   (size (%bytes-be bytes (+ position 4) 4)))
               (when (and (string= id "COMM") (<= (+ position 26) limit))
                 (setf channels (%bytes-be bytes (+ position 8) 2)
                       frames (%bytes-be bytes (+ position 10) 4)
                       bits (%bytes-be bytes (+ position 14) 2)
                       rate (%read-extended-float bytes (+ position 16)))
                 (when (and (string= (%ascii bytes 8 4) "AIFC")
                            (<= (+ position 30) limit))
                   (setf compression (%ascii bytes (+ position 26) 4))))
               (incf position (+ 8 size (mod size 2)))))
    (when (and channels frames bits rate (plusp channels))
      (list :format (if compression
                        (format nil "AIFC/~A" (string-trim " " compression))
                        "AIFF")
            :channels channels :sample-rate rate :bit-depth bits
            :frames frames))))

(defun %sample-info (path)
  "Header data for PATH, or (:format \"?\" ...) when it is not readable.

Never NIL: a directory listing that silently omits what it cannot read is
worse than one that names it. A file that is there but unreadable is
something the user wants to see."
  (let ((bytes (%read-file-head path 4096)))
    (or (and bytes (or (%read-wav-header bytes) (%read-aiff-header bytes)))
        (list :format "?" :channels 0 :sample-rate 0.0d0 :bit-depth 0
              :frames 0))))

(defparameter *sample-extensions*
  '("wav" "aif" "aiff" "aifc" "wave")
  "Extensions the browser lists.")

(defun sample-browse-for-repl (directory &optional (recursive nil))
  "Sound files in DIRECTORY with their header data.

Returns (:ok ENTRIES) or (:error TEXT).  Each entry is
  (NAME PATH FORMAT CHANNELS SAMPLE-RATE BIT-DEPTH FRAMES DURATION SIZE)

DURATION is computed from frames and rate; where the header does not give
both, it is 0 rather than a guess.  A browser that invents a duration is
worse than one that leaves the column empty."
  (handler-case
      (let* ((path (merge-pathnames
                    (make-pathname :directory '(:relative))
                    (pathname (concatenate 'string
                                           (string-right-trim "/" directory)
                                           "/"))))
             (pattern (merge-pathnames (make-pathname :name :wild :type :wild)
                                       path))
             (entries '()))
        (unless (probe-file path)
          (return-from sample-browse-for-repl
            (list :error (format nil "~A does not exist." directory))))
        (dolist (file (directory pattern))
          (let ((type (pathname-type file)))
            (cond
              ;; A directory: recurse only when asked. A sample library can
              ;; be tens of thousands of files deep, and opening a folder
              ;; must not walk all of it.
              ((null (pathname-name file))
               (when recursive
                 (let ((sub (sample-browse-for-repl (namestring file) t)))
                   (when (eq (first sub) :ok)
                     (setf entries (append (second sub) entries))))))
              ((and type (member (string-downcase type) *sample-extensions*
                                 :test #'string=))
               (let* ((info (%sample-info file))
                      (frames (getf info :frames))
                      (rate (getf info :sample-rate))
                      (size (or (ignore-errors
                                  (with-open-file (in file :element-type
                                                           '(unsigned-byte 8))
                                    (file-length in)))
                                0)))
                 (push (list (file-namestring file)
                             (namestring file)
                             (getf info :format)
                             (getf info :channels)
                             rate
                             (getf info :bit-depth)
                             frames
                             (if (and (plusp rate) (plusp frames))
                                 (/ (float frames 1.0d0) rate)
                                 0.0d0)
                             size)
                       entries))))))
        (list :ok (sort entries #'string< :key #'first)))
    (error (e) (list :error (princ-to-string e)))))

(defun sticker-snapshot-for-repl ()
  (list :ok
        (loop for key being the hash-keys of *sticker-records* using (hash-value records)
              collect
              (list key
                    (if (typep records 'sticker-state)
                        (loop for value in (%sticker-state-values-oldest-first records)
                              for n from 1
                              collect (list n (%inspect-register value)
                                            (prin1-to-string value)))
                        (reverse records))))))

(defun sticker-clear-for-repl ()
  (loop for records being the hash-values of *sticker-records*
        when (typep records 'sticker-state)
          do (fill (sticker-state-values records) nil)
             (fill (sticker-state-samples records) 0.0d0)
             (setf (sticker-state-write-index records) 0
                   (sticker-state-count records) 0
                   (sticker-state-phase records) 0
                   (sticker-state-accumulator records) 0.0d0
                   (sticker-state-sequence records) 0))
  (clrhash *sticker-records*)
  (list :ok))

(defparameter *repl-print-length* 500
  "Elements per level that a REPL return value may show.")

(defparameter *repl-print-level* 8
  "Nesting depth that a REPL return value may show.")

(defun %repl-print (value)
  "Printed form of a REPL return value, bounded.

The bound is not cosmetic.  Evaluating (defparameter *buf* (make-array
100000 ...)) returns the array, and the REPL printed it in full: some 800
kilobytes through the bridge, into the terminal, and past the scrollback,
so that the input that caused it was gone.  A REPL that punishes you for
making a buffer is a REPL you stop using for buffers.

The binding is deliberately around the PRINTING of the result and not
around the evaluation.  Code that prints for itself — a (format t ...) in
a loop, a trace, a describe — is the user's own output and must not be
truncated behind their back.  Only the value the REPL adds is capped, and
Common Lisp marks the cut with \"...\", so nothing is silently missing."
  (let ((*print-length* *repl-print-length*)
        (*print-level* *repl-print-level*)
        (*print-circle* t))
    (prin1-to-string value)))

(defun eval-for-repl-debuggable (code-string package-name)
  "Like eval-for-repl, but WITHOUT handler-case.

   The difference is the whole point: eval-for-repl catches every
   condition and turns it into text. Swank therefore never enters its
   debugger, and the REPL cannot trigger one. This version lets the
   condition through, so that Swank sends a :debug event.

   It may therefore ONLY be called over the debug adapter's connection —
   that one can receive the event and send restarts back. Called over the
   bridge, the call would hang, because nobody answers there.

   *debug-io* and *query-io* deliberately stay UNBOUND here: Swank
   negotiates with the debugger over them. Only the output streams are
   redirected."
  (let* ((pkg (or (find-package (string-upcase package-name))
                  (find-package :common-lisp-user)))
         (out (make-string-output-stream)))
    (let* ((*package* pkg)
           (*standard-output* out)
           (*error-output* out)
           (*trace-output* out)
           (values-strings '())
           (presentations '()))
      (with-input-from-string (in code-string)
        (loop
          (let ((form (read in nil :eof)))
            (when (eq form :eof) (return))
            (let ((results (multiple-value-list (eval form))))
              (setf values-strings
                    (append values-strings
                            (mapcar #'%repl-print results)))
              (setf presentations
                    (append presentations
                            (mapcar (lambda (v)
                                      (list (%presentation-register v)
                                            (%repl-print v)
                                            (%presentation-type-label v)))
                                    results)))))))
      (let* ((printed (get-output-stream-string out))
             (value-text (format nil "~{~A~^~%~}" values-strings))
             (combined (concatenate 'string printed
                                    (if (and (> (length printed) 0)
                                             (> (length value-text) 0))
                                        (string #\Newline) "")
                                    value-text)))
        ;; Read out *package*, not pkg: an (in-package ...) in the code
        ;; has changed it inside this binding.
        (list :ok combined (package-name *package*) presentations)))))

(defun eval-for-repl (code-string package-name)
  "Evaluates CODE-STRING in package PACKAGE-NAME. Captures standard output
   and all return values. Returns (STATUS OUTPUT-STRING PACKAGE-STRING),
   where STATUS is :OK or :ERROR."
  (let* ((pkg (or (find-package (string-upcase package-name))
                  (find-package :common-lisp-user)))
         (out (make-string-output-stream))
         ;; A synonym stream pointing at out, so that all streams really
         ;; share the same buffer.
         (two-way (make-two-way-stream (make-string-input-stream "") out)))
    (declare (ignorable two-way))
    (handler-case
        ;; Bind ALL standard output streams to out. Previously only
        ;; *standard-output*/*error-output*/*trace-output* were bound; but
        ;; CLAMPS (e.g. (clamps), describe) partly writes through
        ;; *debug-io*, *query-io* and *terminal-io*. If one of those stayed
        ;; bound to Swank's original stream, the output additionally
        ;; appeared through Swank and therefore TWICE in the REPL. Now they
        ;; all share the same buffer.
        (let* ((*package* pkg)
               (*standard-output* out)
               (*error-output* out)
               (*trace-output* out)
               (*debug-io* (make-two-way-stream (make-string-input-stream "") out))
               (*query-io* (make-two-way-stream (make-string-input-stream "") out))
               (*terminal-io* (make-two-way-stream (make-string-input-stream "") out))
               (values-strings '())
               (presentations '()))
          ;; Read and evaluate several forms in sequence, so that a REPL
          ;; line like "(defparameter *x* 1) *x*" runs completely.
          (with-input-from-string (in code-string)
            (loop
              (let ((form (read in nil :eof)))
                (when (eq form :eof) (return))
                (let ((results (multiple-value-list (eval form))))
                  (setf values-strings
                        (append values-strings
                                (mapcar #'%repl-print results)))
                  (setf presentations
                        (append presentations
                                (mapcar (lambda (v)
                                          (list (%presentation-register v)
                                                (%repl-print v)
                                                (%presentation-type-label v)))
                                        results)))))))
          (let* ((printed (get-output-stream-string out))
                 (value-text (format nil "~{~A~^~%~}" values-strings))
                 (combined (concatenate 'string
                                        printed
                                        (if (and (> (length printed) 0)
                                                 (> (length value-text) 0))
                                            (string #\Newline) "")
                                        value-text))
                 ;; READ OUT *package*, not pkg: if the code contained an
                 ;; (in-package ...), *package* has changed inside this
                 ;; binding. pkg still points at the old package — which
                 ;; is why the REPL prompt used to get stuck.
                 (current-pkg-name (package-name *package*)))
            (list :ok combined current-pkg-name presentations)))
      (error (e)
        (let ((printed (get-output-stream-string out)))
          ;; Fourth value NIL: the same contract as in the success
          ;; branch. Previously the error branch had three elements and
          ;; the success branch four — every caller had to catch that
          ;; itself.
          (list :error
                (concatenate 'string printed
                             (if (> (length printed) 0) (string #\Newline) "")
                             (format nil "~A" e))
                (package-name pkg)
                nil))))))


;;; ---------------------------------------------------------------------
;;; Incudine node browser (read-only)
;;;
;;; Reads the running node tree without modifying Incudine. The Incudine
;;; symbols are only resolved at runtime, so that rpc.lisp stays loadable
;;; against a bare SBCL without Incudine.
;;; ---------------------------------------------------------------------

(defparameter *node-accessors*
  '("DOGRAPH" "NODE-ID" "NODE-NAME" "GROUP" "GROUP-P"
    "CONTROL-NAMES" "CONTROL-LIST" "PAUSE-P" "DONE-P" "NODE-UPTIME")
  "Incudine symbols that the snapshot uses. Which of them really exist in
   the installed version is not guaranteed — which is why that is
   reported instead of silently leading to gaps.")

(defun %node-accessor-report ()
  "List of the missing accessors, as strings. Empty means: all present.

   Necessary because a missing accessor would otherwise stay invisible:
   an unresolvable GROUP, for instance, yields parent=nil for every node,
   and the tree appears flat — which looks like an empty setup rather
   than a missing symbol."
  (let ((pkg (find-package :incudine))
        (missing '()))
    (when pkg
      (dolist (name *node-accessors*)
        (let ((sym (find-symbol name pkg)))
          (unless (and sym (or (fboundp sym) (macro-function sym)))
            (push (string-downcase name) missing)))))
    (nreverse missing)))

(defparameter *node-snapshot-source*
  "(let ((result '()))
     (incudine:dograph (n)
       (let* ((group-p (incudine:group-p n))
              (parent (ignore-errors (incudine:group n)))
              (names (unless group-p
                       (ignore-errors (incudine:control-names n))))
              (vals  (unless group-p
                       (ignore-errors (incudine:control-list n)))))
         (push
          (list :id (incudine:node-id n)
                :parent (and parent (ignore-errors (incudine:node-id parent)))
                :name (let ((name (ignore-errors (incudine:node-name n))))
                        (cond ((stringp name) name)
                              ((symbolp name) (if name (symbol-name name) \"\"))
                              (t (princ-to-string name))))
                :kind (if group-p :group :dsp)
                :paused (not (null (ignore-errors (incudine:pause-p n))))
                :done (and (not group-p)
                           (not (null (ignore-errors (incudine:done-p n)))))
                :uptime (if group-p
                            \"\"
                            (handler-case
                                (let* ((samples (round (incudine:node-uptime n)))
                                       (sr (ignore-errors
                                            (incudine:rt-sample-rate))))
                                  ;; Samples in seconds as well: the raw
                                  ;; sample count cannot be placed at a
                                  ;; glance.
                                  (if (and sr (> sr 0))
                                      (format nil \"~,1Fs (~D samples)\"
                                              (/ samples sr) samples)
                                      (format nil \"~D samples\" samples)))
                              (error () \"\")))
                :controls (loop for cn in names
                                for cv in vals
                                collect (list :name (if (symbolp cn)
                                                        (symbol-name cn)
                                                        (princ-to-string cn))
                                              :value (clamps-bridge-rpc::%preview cv))))
          result)))
     (nreverse result))"
  "Source text of the traversal as a string.

   The reason for the detour through read-from-string: incudine:dograph
   is a macro and the symbols do not necessarily exist when this file is
   loaded. While reading, *read-eval* is off, so nothing is executed at
   read time; what is evaluated is only this one fixed text.")

(defun incudine-node-tree-for-repl ()
  "Read-only snapshot of the Incudine node tree.

   Returns: (:ok note nodes) | (:unavailable reason nil)
            | (:error message nil)

   A NOTE ON CONCURRENCY: the graph is modified by the realtime thread
   and read here from a Swank worker. A snapshot taken while DSP is
   running can therefore show an intermediate state (node just removed,
   controls half set). For a display that is acceptable; the individual
   accesses are additionally wrapped in ignore-errors so that a node
   vanishing behind our back does not topple the whole snapshot."
  (let ((pkg (find-package :incudine)))
    (cond
      ((null pkg)
       (list :unavailable "Incudine is not loaded." nil))
      ((member "DOGRAPH" (%node-accessor-report) :test #'string-equal)
       (list :unavailable
             "This Incudine version does not know dograph — node tree not readable."
             nil))
      (t
       (handler-case
           (let* ((missing (%node-accessor-report))
                  ;; Pin *package* down: the string is read at runtime,
                  ;; and without this binding the caller's package decides
                  ;; where unqualified symbols point.
                  (nodes (let ((*read-eval* nil)
                               (*package* (find-package :clamps-bridge-rpc)))
                           (eval (read-from-string *node-snapshot-source*)))))
             (list :ok
                   (if missing
                       (format nil "Not available in this Incudine version: ~{~A~^, ~}"
                               missing)
                       "")
                   nodes))
         (error (e) (list :error (princ-to-string e) nil)))))))


;;; ---------------------------------------------------------------------
;;; Image browsers for VS Code
;;; ---------------------------------------------------------------------
(defun %down (x) (let ((*print-case* :downcase)) (princ-to-string x)))

(defun packages-for-repl ()
  (handler-case
      (list :ok
            (sort
             (mapcar (lambda (p)
                       (list :label (package-name p)
                             :description (format nil "~D extern · ~D intern"
                                                  (loop for s being the external-symbols of p count s)
                                                  (loop for s being the present-symbols of p
                                                        unless (eq (nth-value 1 (find-symbol (symbol-name s) p)) :external)
                                                        count s))
                             :tooltip (format nil "Nicknames: ~{~A~^, ~}~%Uses: ~{~A~^, ~}"
                                              (package-nicknames p)
                                              (mapcar #'package-name (package-use-list p)))
                             :icon "package"
                             :inspect (format nil "(find-package ~S)" (package-name p))))
                     (list-all-packages))
             #'string-lessp :key (lambda (x) (getf x :label))))
    (error (e) (list :error (format nil "~A" e) nil))))

(defun classes-for-repl ()
  (handler-case
      (let ((seen (make-hash-table :test #'eq)) (rows nil))
        (dolist (p (list-all-packages))
          (do-symbols (s p)
            (let ((c (ignore-errors (find-class s nil))))
              (when (and c (eq (symbol-package s) p) (not (gethash c seen)))
                (setf (gethash c seen) t)
                (push (list :label (%down s)
                            :description (%down (class-of c))
                            :tooltip (or (documentation s 'type) "")
                            :icon "symbol-class"
                            :inspect (format nil "(find-class '~S)" s)) rows)))))
        (list :ok (sort rows #'string-lessp :key (lambda (x) (getf x :label)))))
    (error (e) (list :error (format nil "~A" e) nil))))

(defun threads-for-repl ()
  (handler-case
      (let* ((pkg (find-package :bordeaux-threads))
             (all (and pkg (find-symbol "ALL-THREADS" pkg)))
             (name (and pkg (find-symbol "THREAD-NAME" pkg)))
             (alive (and pkg (find-symbol "THREAD-ALIVE-P" pkg))))
        (if (and all (fboundp all))
            (list :ok
                  (loop for th in (funcall all)
                        collect (list :label (or (and name (fboundp name) (funcall name th)) (%preview th))
                                      :description (if (and alive (fboundp alive) (funcall alive th)) "alive" "stopped")
                                      :tooltip (%preview th)
                                      :icon "debug-thread"
                                      :inspect (format nil "(find ~S (bordeaux-threads:all-threads) :key #'bordeaux-threads:thread-name :test #'equal)"
                                                       (and name (fboundp name) (funcall name th))))))
            (list :error "Bordeaux-Threads is not available." nil)))
    (error (e) (list :error (format nil "~A" e) nil))))


;;; ---------------------------------------------------------------------
;;; SLY/SLIME tools: isolated additions for v72
;;; ---------------------------------------------------------------------


(defun %tool-entry (label &key description detail file line character inspect offset)
  (list :label label :description (or description "") :detail (or detail "")
        :file file
        ;; Deliberately do NOT default line to 1. The client prefers an
        ;; existing line over the offset; an invented 1 rendered the
        ;; offset next to it useless and sent every hit to the start of
        ;; the file — exactly the bug that was supposed to be fixed. NIL
        ;; means: "no line known, take the offset".
        :line line :character (or character 0)
        ;; Pass the offset through AS WELL: in source locations SBCL
        ;; almost always supplies (:position N) instead of (:line N), and
        ;; N is a character offset. Without this field every jump lands on
        ;; line 1 — the same bug that was already fixed once in the
        ;; debugger. The conversion happens on the TS side, which opens
        ;; the file anyway.
        :offset offset
        :inspect inspect))

(defun %location-file-line (location)
  "Returns (values file line character offset) from a Swank source
location. line/character are set only when the backend supplies them
explicitly; otherwise the character offset is in offset."
  (let ((file nil) (line nil) (character nil) (offset nil))
    (labels ((walk (x)
               (when (consp x)
                 (case (car x)
                   (:file (when (stringp (second x)) (setf file (second x))))
                   (:line (when (numberp (second x)) (setf line (second x)))
                          (when (numberp (third x)) (setf character (third x))))
                   (:position (when (numberp (second x)) (setf offset (second x))))
                   (:offset
                    ;; (:offset START DELTA) — the two added give the place.
                    (when (numberp (second x))
                      (setf offset (+ (second x) (if (numberp (third x)) (third x) 0))))))
                 (dolist (e x) (walk e)))))
      (walk location))
    (values file line character offset)))

(defun %swank-symbol (name package-designator)
  "FIND-SYMBOL, but NIL instead of an error when the package does not
exist. An image without Swank loaded should get the intended message and
not a package type error."
  (let ((pkg (find-package package-designator)))
    (and pkg (find-symbol name pkg))))

(defun %xref-type (kind)
  (cdr (assoc (string-downcase kind)
              ;; "definitions" deliberately NOT included: swank:xref does
              ;; not know the type (definitions go through
              ;; find-definitions-for-emacs) and signals instead.
              '(("callers" . :calls)
                ("callees" . :calls-who)
                ("references" . :references)
                ("bindings" . :binds)
                ("setters" . :sets)
                ("macroexpands" . :macroexpands))
              :test #'string=)))

(defun %xref-inspect-expr (name pkg)
  "An expression with which the client can inspect the XREF hit.

NAME is usually a string (\"cl-user::bar\"), with some backends also a
symbol or a setf name (setf foo). Only simple symbols yield something
inspectable; everything else returns NIL so that the client honestly
reports 'no source file available' instead of jumping to a broken
expression."
  (handler-case
      (let ((sym (cond ((symbolp name) name)
                       ((stringp name) (resolve-symbol name pkg))
                       (t nil))))
        (and sym (symbolp sym) (%package-qualified sym)))
    (error () nil)))

(defun %definition-xref-entries (symbol-string package-name)
  "Converts FIND-DEFINITIONS-FOR-REPL into the same tool-entry format as XREF."
  (let ((result (find-definitions-for-repl symbol-string package-name))
        (out nil))
    (unless (and (consp result) (eq (first result) :ok))
      (return-from %definition-xref-entries result))
    (dolist (entry (second result))
      (destructuring-bind (file line character label) entry
        (push (%tool-entry label
                           :description "definition"
                           :detail (if file file "source file not available")
                           :file file
                           ;; find-definitions-for-repl already supplies
                           ;; zero-based LSP lines; ToolEntry, by
                           ;; contrast, expects a one-based line.
                           :line (and file (1+ line))
                           :character character)
              out)))
    (list :ok (nreverse out))))

(defun xref-for-repl (symbol-string package-name kind)
  "A complete SLIME XREF query including definitions.

KIND is one of definitions, callers, callees, references, bindings,
setters or macroexpands. The return value is (:ok TOOL-ENTRIES) or
(:error TEXT)."
  (handler-case
      (when (string-equal kind "definitions")
        (return-from xref-for-repl
          (%definition-xref-entries symbol-string package-name)))
    (error (e) (return-from xref-for-repl (list :error (princ-to-string e)))))
  (handler-case
      (let* ((pkg (or (find-package (string-upcase package-name))
                      (find-package :common-lisp-user)))
             ;; resolve-symbol binds *PACKAGE* to this argument. SBCL
             ;; declares *PACKAGE* to be of type PACKAGE, so a string
             ;; raises a type error there, which resolve-symbol silently
             ;; swallows into NIL. The result was: every XREF kind except
             ;; "definitions" reported "symbol not found" and swank:xref
             ;; was never called. Hence a package OBJECT here, as at every
             ;; other call site.
             (sym (resolve-symbol symbol-string pkg))
             (type (%xref-type kind))
             ;; find-symbol signals when the package is missing — that
             ;; would produce a type error instead of the intended
             ;; message.
             (fn (or (%swank-symbol "XREF" :swank)
                     (%swank-symbol "XREF" :swank/backend))))
        (unless sym
          (return-from xref-for-repl
            (list :error (format nil "Symbol ~A was not found in package ~A."
                                 symbol-string package-name))))
        (unless type
          (return-from xref-for-repl
            (list :error (format nil "Unknown XREF kind: ~A" kind))))
        (unless (and fn (fboundp fn))
          (return-from xref-for-repl
            (list :error "XREF is not offered by this Swank/image.")))
        (let ((raw (funcall fn type (%package-qualified sym))) (out nil))
          (dolist (entry raw)
            (let* ((name (if (consp entry) (first entry) entry))
                   (loc (and (consp entry) (second entry))))
              (multiple-value-bind (file line character offset) (%location-file-line loc)
                ;; Swank can supply logical pathnames or build paths that
                ;; do not exist. Use the same resolution as M-. does.
                (let ((resolved (and file (%resolve-source-file file))))
                  (push (%tool-entry (princ-to-string name)
                                     :description (string-downcase (symbol-name type))
                                     :detail (princ-to-string loc)
                                     :file resolved :line line :character character
                                     :offset offset
                                     ;; swank:xref sends the name through
                                     ;; xref>elisp, so a STRING arrives —
                                     ;; the old symbolp test was always
                                     ;; false and the inspect fallback was
                                     ;; therefore dead.
                                     :inspect (%xref-inspect-expr name pkg))
                        out)))))
          ;; Swank does not always remove duplicate hits from the same
          ;; source, especially for generic functions. Deduplicate stably.
          (let ((seen (make-hash-table :test #'equal)) (dedup nil))
            (dolist (entry (nreverse out))
              (let ((key (list (getf entry :label) (getf entry :file)
                               (getf entry :line) (getf entry :character)
                               (getf entry :offset))))
                (unless (gethash key seen)
                  (setf (gethash key seen) t)
                  (push entry dedup))))
            (list :ok (nreverse dedup)))))
    (error (e) (list :error (princ-to-string e)))))

(defun apropos-for-repl (query package-name all-packages-p)
  (handler-case
      (let ((symbols (apropos-list query (and (not all-packages-p) (find-package package-name))))
            (out nil))
        (dolist (sym (sort (copy-list symbols) #'string< :key #'%package-qualified))
          (let ((kind (%sym-kind sym)))
            (push (%tool-entry (%package-qualified sym)
                               :description (%sym-kind-label kind)
                               :detail (%short-doc sym)
                               :inspect (%package-qualified sym)) out)))
        (list :ok (nreverse out)))
    (error (e) (list :error (princ-to-string e)))))

(defun break-on-signals-for-repl (condition-names)
  "Sets *BREAK-ON-SIGNALS*. The value is a TYPE SPECIFIER, not a list.

This matters because SIGNAL tests this variable with TYPEP on EVERY
signalled condition: a list (WARNING TYPE-ERROR) is read as a compound
type specifier with head WARNING, which is invalid. TYPEP then signals
itself — on every signal, and therefore also while cleaning up the error
that causes. The image is unusable afterwards. Several types have to be
combined as (OR a b).

The target variable is CL:*BREAK-ON-SIGNALS* from the standard; only if
the image brings its own Swank variant is that preferred."
  (handler-case
      (let ((var (or (let ((s (find-symbol "*BREAK-ON-SIGNALS*" :swank)))
                       (and s (boundp s) s))
                     (find-symbol "*BREAK-ON-SIGNALS*" :common-lisp))))
        (unless var
          (return-from break-on-signals-for-repl
            (list :error "*BREAK-ON-SIGNALS* is not available in this image.")))
        (let ((types (loop for name in condition-names
                           for sym = (or (ignore-errors (resolve-symbol name "COMMON-LISP-USER"))
                                         (find-symbol (string-upcase name) :common-lisp))
                           when sym collect sym)))
          ;; Check each type individually BEFORE it is armed — a typo
          ;; must not lead to the next SIGNAL being the thing that
          ;; paralyses the image.
          (dolist (type types)
            (unless (ignore-errors (progn (typep nil type) t))
              (return-from break-on-signals-for-repl
                (list :error (format nil "~A is not a valid condition type." type)))))
          (let ((spec (cond ((null types) nil)
                            ((null (cdr types)) (first types))
                            (t (cons 'or types)))))
            ;; setf symbol-value rather than set: set has been removed
            ;; from the standard and says nothing about which binding is
            ;; hit.
            (setf (symbol-value var) spec)
            (list :ok (mapcar #'%package-qualified types)))))
    (error (e) (list :error (princ-to-string e)))))

(defun %generic-function-p (sym)
  (handler-case
      (let ((gf (find-symbol "GENERIC-FUNCTION" :common-lisp)))
        (and gf (fboundp sym) (typep (fdefinition sym) gf)))
    (error () nil)))


(defun %rt-breakpoint-note (sym)
  "In the realtime thread only record, do not halt. No printing: console
I/O from the audio callback is itself a deadline violation. The record
becomes visible at the next retrieval of the breakpoint list."
  (pushnew sym *rt-breakpoint-notes*)
  nil)

(defun %rt-thread-p ()
  "Is the current thread running as an Incudine realtime thread?

Not an error if Incudine is not loaded at all — then there is no
realtime thread either."
  (handler-case
      (let ((fn (find-symbol "RT-THREAD-P" :incudine))
            (var (find-symbol "*RT-THREAD*" :incudine)))
        (cond ((and fn (fboundp fn)) (and (funcall fn) t))
              ((and var (boundp var))
               (let ((bt (find-symbol "CURRENT-THREAD" :bordeaux-threads)))
                 (and bt (fboundp bt) (eq (funcall bt) (symbol-value var)))))
              (t nil)))
    (error () nil)))

(defun set-function-breakpoints-for-repl (names package-name)
  "Sets entry breakpoints for ordinary functions. Existing definitions are
preserved and restored exactly when the breakpoint is removed."
  (handler-case
      (progn
        (let ((wanted (mapcar #'string-upcase names)))
          (maphash (lambda (key value) (declare (ignore value))
                     (unless (member key wanted :test #'string=)
                       (%restore-function-breakpoint key)))
                   *clamps-function-breakpoints*)
          (let ((result nil))
            (dolist (name names)
              (let* ((sym (resolve-symbol name package-name))
                     (key (string-upcase name)))
                (cond
                  ((null sym) (push (list :name name :verified nil :message "Symbol not found.") result))
                  ((macro-function sym) (push (list :name name :verified nil :message "Macros are not wrapped.") result))
                  ((not (fboundp sym)) (push (list :name name :verified nil :message "No function definition.") result))
                  ;; Do NOT replace generic functions: fdefinition would
                  ;; swap the whole GF including dispatch for a lambda. A
                  ;; later defmethod on the same symbol would then hit
                  ;; nothing, and the methods would be gone.
                  ((%generic-function-p sym)
                   (push (list :name name :verified nil
                               :message "A generic function — dispatch would be lost. Use TRACE instead.")
                         result))
                  ((gethash key *clamps-function-breakpoints*)
                   (push (list :name name :verified t :message "Aktiv.") result))
                  (t
                   (let* ((original (fdefinition sym))
                          (wrapper (lambda (&rest args)
                                     ;; NEVER enter the debugger in the
                                     ;; realtime thread. Incudine's audio
                                     ;; callback has a hard deadline; a
                                     ;; BREAK there blocks it, and with it
                                     ;; the whole image — at best audible
                                     ;; as a dropout, at worst a crash
                                     ;; nobody can attribute afterwards.
                                     (if (%rt-thread-p)
                                         (%rt-breakpoint-note sym)
                                         (break "Funktions-Breakpoint: ~A~%Argumente: ~S" sym args))
                                     (apply original args))))
                     (setf (fdefinition sym) wrapper)
                     (setf (gethash key *clamps-function-breakpoints*)
                           (list :symbol sym :original original :wrapper wrapper))
                     (push (list :name name :verified t :message "Aktiv.") result))))))
            (list :ok (nreverse result)))))
    (error (e) (list :error (princ-to-string e)))))

