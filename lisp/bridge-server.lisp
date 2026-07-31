;;;; bridge-server.lisp
;;;;
;;;; Translates between LSP (JSON-RPC over stdio, towards VS Code) and
;;;; the Swank wire protocol (towards the SBCL process from
;;;; bootstrap.lisp).
;;;;
;;;; IMPORTANT: *standard-output* is the LSP message channel. NOTHING may
;;;; end up there except through write-lsp-message – any stray
;;;; (format t ...) or an SBCL warning on stdout destroys the framing.
;;;; Logging therefore consistently goes to bridge.log, never to stdout.
;;;; stderr is uncritical (VS Code does not read it for LSP).
;;;;
;;;; KNOWN LIMITATIONS (deliberately unsolved, for the next round of
;;;; work):
;;;;   - Position handling is naive character counting, not the UTF-16
;;;;     code unit offset the LSP spec actually demands. With umlauts or
;;;;     emoji in comments it can be off by a few characters.
;;;;   - read-swank-message uses CL:READ-FROM-STRING on the answer. If
;;;;     the answer contains symbols from packages that do not exist in
;;;;     the bridge process (internal CLAMPS symbols in backtraces, say),
;;;;     reading fails. Currently: the error is logged and the request
;;;;     gets an empty answer instead of a crash. More robust
;;;;     introspection would need a tolerant reader.
;;;;   - DAP (the debugger) is NOT implemented. :debug events from Swank
;;;;     are only logged. See the TODO at handle-swank-message.

(require :asdf)

(let ((ql-init (merge-pathnames "quicklisp/setup.lisp" (user-homedir-pathname))))
  (when (probe-file ql-init) (load ql-init)))

(handler-case
    (ql:quickload '(:usocket :bordeaux-threads) :silent t)
  (error (e)
    (format *error-output* "~&[clamps-bridge] FATAL while loading usocket/bordeaux-threads: ~A~%" e)
    (force-output *error-output*)
    (sb-ext:exit :code 1)))

(defpackage :clamps-bridge
  (:use :cl))
(in-package :clamps-bridge)

;;; ---------------------------------------------------------------------
;;; Logging (never onto *standard-output* – see the comment above)
;;; ---------------------------------------------------------------------

(defvar *log-file* nil)
(defparameter *fallback-log-file* #P"/tmp/clamps-bridge-fallback.log")

(defun init-logging (session-dir)
  (setf *log-file* (merge-pathnames "bridge.log" session-dir)))

(defun log-msg (fmt &rest args)
  ;; ALWAYS writes somewhere, even before init-logging has run (errors
  ;; right at the start previously vanished, because *log-file* was still
  ;; nil and the old version then simply did nothing at all).
  (let ((target (or *log-file* *fallback-log-file*)))
    (ignore-errors
      (with-open-file (s target :direction :output
                                 :if-exists :append
                                 :if-does-not-exist :create)
        (format s "~&[~A] " (get-universal-time))
        (apply #'format s fmt args)
        (terpri s))))
  ;; Additionally on stderr: immediately visible when started manually in
  ;; a terminal, regardless of whether writing the log file works.
  (ignore-errors
    (format *error-output* "~&[clamps-bridge] ")
    (apply #'format *error-output* fmt args)
    (terpri *error-output*)
    (force-output *error-output*)))

;;; ---------------------------------------------------------------------
;;; Minimal JSON reader/writer (deliberately without a yason/jzon
;;; dependency, in order to keep explicit control over true/false/null)
;;; ---------------------------------------------------------------------

(defun make-jobj (&rest plist)
  (let ((h (make-hash-table :test 'equal)))
    (loop for (k v) on plist by #'cddr do (setf (gethash k h) v))
    h))

(defun json-read (string)
  (let ((pos 0) (len (length string)))
    (labels ((peek () (if (< pos len) (char string pos) nil))
             (advance () (prog1 (peek) (incf pos)))
             (skip-ws ()
               (loop while (and (< pos len)
                                 (member (peek) '(#\Space #\Tab #\Newline #\Return)))
                     do (incf pos)))
             (parse-value ()
               (skip-ws)
               (case (peek)
                 (#\{ (parse-object))
                 (#\[ (parse-array))
                 (#\" (parse-string))
                 (t (cond
                      ((and (<= (+ pos 4) len) (string= string "true" :start1 pos :end1 (+ pos 4)))
                       (incf pos 4) :true)
                      ((and (<= (+ pos 5) len) (string= string "false" :start1 pos :end1 (+ pos 5)))
                       (incf pos 5) :false)
                      ((and (<= (+ pos 4) len) (string= string "null" :start1 pos :end1 (+ pos 4)))
                       (incf pos 4) :null)
                      (t (parse-number))))))
             (parse-object ()
               (let ((h (make-hash-table :test 'equal)))
                 (advance) ; {
                 (skip-ws)
                 (unless (eql (peek) #\})
                   (loop
                     (skip-ws)
                     (let ((key (parse-string)))
                       (skip-ws) (advance) ; :
                       (setf (gethash key h) (parse-value)))
                     (skip-ws)
                     (if (eql (peek) #\,) (advance) (return))))
                 (skip-ws) (advance) ; }
                 h))
             (parse-array ()
               (let ((items '()))
                 (advance) ; [
                 (skip-ws)
                 (unless (eql (peek) #\])
                   (loop
                     (push (parse-value) items)
                     (skip-ws)
                     (if (eql (peek) #\,) (advance) (return))))
                 (skip-ws) (advance) ; ]
                 (coerce (nreverse items) 'vector)))
             (parse-string ()
               (advance) ; "
               (with-output-to-string (s)
                 (loop
                   (let ((ch (advance)))
                     (cond
                       ((eql ch #\") (return))
                       ((eql ch #\\)
                        (let ((esc (advance)))
                          (case esc
                            (#\n (write-char #\Newline s))
                            (#\t (write-char #\Tab s))
                            (#\r (write-char #\Return s))
                            (#\u (let ((hex (subseq string pos (+ pos 4))))
                                   (incf pos 4)
                                   (write-char (code-char (parse-integer hex :radix 16)) s)))
                            (t (write-char esc s)))))
                       (t (write-char ch s)))))))
             (parse-number ()
               (let ((start pos))
                 (loop while (and (< pos len) (find (peek) "-+0123456789.eE")) do (advance))
                 (let ((token (subseq string start pos)))
                   (if (find-if (lambda (c) (find c ".eE")) token)
                       (let ((*read-default-float-format* 'double-float))
                         (read-from-string token))
                       (parse-integer token))))))
      (parse-value))))

(defun json-write-string (s stream)
  (write-char #\" stream)
  (loop for ch across s do
    (case ch
      (#\" (write-string "\\\"" stream))
      (#\\ (write-string "\\\\" stream))
      (#\Newline (write-string "\\n" stream))
      (#\Tab (write-string "\\t" stream))
      (#\Return (write-string "\\r" stream))
      (t (write-char ch stream))))
  (write-char #\" stream))

(defun json-write (obj stream)
  (etypecase obj
    (hash-table
     (write-char #\{ stream)
     (let ((first t))
       (maphash (lambda (k v)
                  (unless first (write-char #\, stream))
                  (setf first nil)
                  (json-write-string k stream)
                  (write-char #\: stream)
                  (json-write v stream))
                obj))
     (write-char #\} stream))
    ;; STRING must precede VECTOR: Common Lisp strings are vectors of characters.
    (string (json-write-string obj stream))
    (vector
     (write-char #\[ stream)
     (loop for i from 0 below (length obj)
           do (when (> i 0) (write-char #\, stream))
              (json-write (aref obj i) stream))
     (write-char #\] stream))
    (integer (format stream "~D" obj))
    (float (format stream "~F" obj))
    (symbol
     (cond
       ((eq obj :true) (write-string "true" stream))
       ((eq obj :false) (write-string "false" stream))
       ((or (eq obj :null) (null obj)) (write-string "null" stream))
       (t (json-write-string (string-downcase (symbol-name obj)) stream))))))

;;; ---------------------------------------------------------------------
;;; LSP transport (Content-Length framing over stdio)
;;; ---------------------------------------------------------------------

(defvar *stdout-lock* (bt:make-lock))

(defun read-lsp-message (stream)
  "Reads an LSP message. STREAM must be BIVALENT (see main).

Content-Length counts BYTES in UTF-8, not characters. This very bug had
already been fixed on the writing side (see write-lsp-message); here it
was still present: (make-string content-length) plus read-sequence read
that many CHARACTERS. In a message containing umlauts — the didOpen for a
file with German comments, say — bytes > characters, so reading ran past
the end into the following message. After that the stream was out of
step, the next header unreadable, this function returned NIL and the main
loop ended: the bridge process exited with code 0, and all VS Code
reported was \"Connection to server got closed\"."
  (let ((content-length nil))
    (loop
      (let ((line (read-line stream nil nil)))
        (when (null line) (return-from read-lsp-message nil))
        (setf line (string-right-trim '(#\Return) line))
        (when (string= line "") (return))
        (let ((idx (position #\: line)))
          (when (and idx (string-equal (subseq line 0 idx) "Content-Length"))
            (setf content-length (parse-integer (string-trim " " (subseq line (1+ idx)))))))))
    (unless content-length (return-from read-lsp-message nil))
    ;; Read bytes, then decode them ourselves.
    (let* ((bytes (make-array content-length :element-type '(unsigned-byte 8)))
           (got (read-sequence bytes stream)))
      (when (< got content-length)
        ;; Truncated message: do not carry on guessing, stop.
        (log-msg "Message incomplete: ~D of ~D bytes" got content-length)
        (return-from read-lsp-message nil))
      (json-read (sb-ext:octets-to-string bytes :external-format :utf-8)))))

(defun write-lsp-message (obj)
  (bt:with-lock-held (*stdout-lock*)
    (let* ((body (with-output-to-string (s) (json-write obj s)))
           ;; LSP requires Content-Length in BYTES (UTF-8), not in
           ;; characters. An umlaut or an em dash is 1 character but 2-3
           ;; bytes — (length body) was too small, the client read a
           ;; truncated message and the JSON parser aborted ("Expected
           ;; ',' or '}'"). Byte length via the octets.
           (byte-length (length (sb-ext:string-to-octets body :external-format :utf-8))))
      (format *standard-output* "Content-Length: ~D~C~C~C~C"
              byte-length #\Return #\Newline #\Return #\Newline)
      (write-string body *standard-output*)
      (force-output *standard-output*))))

(defun send-response (id result)
  (write-lsp-message (make-jobj "jsonrpc" "2.0" "id" id "result" result)))

(defun send-notification (method params)
  (write-lsp-message (make-jobj "jsonrpc" "2.0" "method" method "params" params)))

(defun show-message (text &optional (type 3))
  "window/showMessage. TYPE: 1 error, 2 warning, 3 info.
So that an F12 that came to nothing becomes visible instead of fizzling
out silently — a jump that does nothing is worse than a message."
  (send-notification "window/showMessage"
                     (make-jobj "type" type "message" text)))

(defun send-error (id code message)
  (write-lsp-message
   (make-jobj "jsonrpc" "2.0" "id" id
              "error" (make-jobj "code" code "message" message))))

;;; ---------------------------------------------------------------------
;;; Swank client (wire protocol: six hex characters of length + printed form)
;;; ---------------------------------------------------------------------

(defvar *swank-stream*)
(defvar *swank-lock* (bt:make-lock))
(defvar *pending-requests* (make-hash-table))
(defvar *swank-request-id* 0)
(defvar *swank-package* "COMMON-LISP-USER")

(defun next-swank-id ()
  (bt:with-lock-held (*swank-lock*) (incf *swank-request-id*)))

(defun connect-swank (host port)
  "The Swank stream is BYTE oriented, not character oriented.

The six-digit hex header of the Swank protocol counts the BYTES of the
UTF-8 encoding — exactly like Content-Length in LSP. On a character
stream (length text) was the CHARACTER count: with every umlaut, every
em dash, every ° in the payload, bytes > characters. Swank then read too
little, the rest of the form was read as the beginning of the next
message, and the connection was out of step. Symmetrically,
read-swank-message read as many CHARACTERS as the announced number of
bytes.

The consequence: as soon as a German docstring came back (autodoc,
describe-symbol in CLAMPS) or a completion request sent along a file
window containing an umlaut, the read loop ended — from then on NO
callback from *pending-requests* fired any more. Definition, completion,
signature help and hover never answered, without an error message. Hence
reading/writing bytes here and encoding UTF-8 ourselves, as in
write-lsp-message/read-lsp-message."
  (usocket:socket-stream
   (usocket:socket-connect host port :element-type '(unsigned-byte 8))))

(defun send-swank-text (text)
  (bt:with-lock-held (*swank-lock*)
    (let* ((body (sb-ext:string-to-octets text :external-format :utf-8))
           (header (sb-ext:string-to-octets (format nil "~6,'0X" (length body))
                                            :external-format :utf-8)))
      (write-sequence header *swank-stream*)
      (write-sequence body *swank-stream*)
      (force-output *swank-stream*))))

(defun swank-rex (form-string &key (package *swank-package*) callback)
  "FORM-STRING is a ready-formatted Lisp form string, e.g.
   (format nil \"(swank:simple-completions ~S ~S)\" prefix package).
   Deliberately a string rather than a Lisp data structure: that way the
   bridge image does not have to know the symbols (swank:..., clamps:...)
   itself."
  (let ((id (next-swank-id)))
    (when callback (setf (gethash id *pending-requests*) callback))
    (send-swank-text (format nil "(:emacs-rex ~A ~S t ~D)" form-string package id))
    id))

(defpackage :clamps-bridge-swank-read
  (:use)
  (:documentation
   "Catch-all package for reading Swank messages. All symbols from the
    message are interned here, so that unknown source packages (such as
    cffi-features) do not blow up the reader."))

(defvar *swank-readtable*
  (let ((rt (copy-readtable nil)))
    ;; Make the colon an ordinary constituent. With that the reader
    ;; treats "cffi-features:foo" as ONE token and no longer fails
    ;; because the package cffi-features does not exist. The message is
    ;; slightly falsified (the symbol is then called |cffi-features:foo|
    ;; instead of cffi-features::foo), but only the leading keywords
    ;; matter for the dispatch, and we handle those separately via
    ;; read-keyword below.
    (set-syntax-from-char #\: #\a rt)
    rt)
  "A readtable that reads package colons as ordinary characters.")

(defun read-swank-message (stream)
  "STREAM is byte oriented (see connect-swank). The header counts BYTES,
so bytes are read and afterwards decoded as UTF-8."
  (let ((header (make-array 6 :element-type '(unsigned-byte 8))))
    (let ((n (read-sequence header stream)))
      (when (< n 6) (return-from read-swank-message nil)))
    (let* ((len (parse-integer (sb-ext:octets-to-string header :external-format :utf-8)
                               :radix 16))
           (bytes (make-array len :element-type '(unsigned-byte 8)))
           (got (read-sequence bytes stream)))
      (when (< got len)
        (log-msg "Swank message incomplete: ~D of ~D bytes" got len)
        (return-from read-swank-message nil))
      (let ((buf (sb-ext:octets-to-string bytes :external-format :utf-8)))
      (handler-case
          ;; The normal, correct reader first. It understands keywords
          ;; properly and is the case for the vast majority of messages.
          (let ((*read-eval* nil))
            (read-from-string buf))
        (error ()
          ;; Only if the normal reader fails (unknown package in a
          ;; notification), the lenient second attempt: with the colon
          ;; disarmed and in the catch-all package. That falsifies
          ;; non-keyword symbols, but we do not evaluate such messages
          ;; anyway (new-features, indentation-update) — the point is
          ;; merely not to lose the stream.
          (handler-case
              (let ((*read-eval* nil)
                    (*readtable* *swank-readtable*)
                    (*package* (find-package :clamps-bridge-swank-read)))
                (%fixup-leading-keyword (read-from-string buf)))
            (error (e)
              (log-msg "Could not read the Swank answer (~A): ~A" e
                        (subseq buf 0 (min 200 (length buf))))
              :unreadable))))))))

(defun %fixup-leading-keyword (form)
  "The lenient reader reads the leading :return/:debug/… as an ordinary
   symbol |:return| in the catch-all package. For the dispatch we turn it
   back into a real keyword, provided the name begins with :."
  (if (and (consp form) (symbolp (first form)))
      (let ((name (symbol-name (first form))))
        (if (and (> (length name) 0) (char= (char name 0) #\:))
            (cons (intern (string-upcase (subseq name 1)) :keyword)
                  (rest form))
            form))
      form))

(defun handle-swank-message (msg)
  (cond
    ((eq msg :unreadable) nil)
    ((not (consp msg)) (log-msg "Unerwartete Swank-Nachricht: ~S" msg))
    ((eq (first msg) :return)
     (let* ((result (second msg))
            (id (third msg))
            (cb (gethash id *pending-requests*)))
       (remhash id *pending-requests*)
       (when cb
         (if (and (consp result) (eq (first result) :ok))
             (funcall cb :ok (second result))
             (funcall cb :abort result)))))
    ((eq (first msg) :debug)
     ;; TODO: this is where the DAP binding starts. A :debug event means
     ;; SBCL has fallen into the debugger (condition + restarts). For DAP
     ;; that would have to become a StoppedEvent + StackTraceResponse;
     ;; see swank:debugger-info-for-emacs for the structure.
     (log-msg "Debug event received (DAP not connected yet): ~S" msg))
    (t (log-msg "Unbehandeltes Swank-Event: ~S" (first msg)))))

(defun swank-reader-loop ()
  (loop
    (let ((msg (handler-case (read-swank-message *swank-stream*)
                 (error (e) (log-msg "Swank reader loop error: ~A" e) nil))))
      (unless msg (return))
      (handle-swank-message msg))))

;;; ---------------------------------------------------------------------
;;; Document store + symbol detection at the cursor position
;;; ---------------------------------------------------------------------

(defvar *documents* (make-hash-table :test 'equal))

(defun nth-line (text line-number)
  (let ((start 0) (current 0))
    (loop
      (let ((nl (position #\Newline text :start start)))
        (when (= current line-number)
          (return-from nth-line (subseq text start (or nl (length text)))))
        (unless nl (return-from nth-line ""))
        (setf start (1+ nl))
        (incf current)))))

(defun symbol-constituent-p (ch)
  (or (alphanumericp ch) (find ch "-+*/<>=!?_%&^~.:@")))

(defun symbol-at (text line character)
  (let ((line-text (nth-line text line)))
    (when (and line-text (<= character (length line-text)))
      (let ((start character) (end character))
        (loop while (and (> start 0) (symbol-constituent-p (char line-text (1- start))))
              do (decf start))
        (loop while (and (< end (length line-text)) (symbol-constituent-p (char line-text end)))
              do (incf end))
        (when (> end start) (subseq line-text start end))))))

;;; ---------------------------------------------------------------------
;;; LSP-Request-Handler
;;; ---------------------------------------------------------------------

(defun handle-initialize (id)
  (send-response id
    (make-jobj
     "capabilities" (make-jobj
                     "textDocumentSync" 1 ; Full-Sync, einfachste Variante
                     "hoverProvider" :true
                     ;; ":" as a trigger, so that "incudine:" immediately
                     ;; offers the external symbols of the package without
                     ;; having to type a letter first.  " " is added so
                     ;; that after an argument the &key names of the
                     ;; enclosing form appear; for an empty prefix the
                     ;; bridge returns exclusively those and nothing else,
                     ;; so the trigger otherwise stays quiet.
                     "completionProvider" (make-jobj
                                           "triggerCharacters" (vector ":" " "))
                     "signatureHelpProvider" (make-jobj
                                               "triggerCharacters" (vector " " "("))
                     "definitionProvider" :true
                     "referencesProvider" :true)
     "serverInfo" (make-jobj "name" "clamps-bridge" "version" "0.1.0"))))

(defun handle-did-open (params)
  (let* ((doc (gethash "textDocument" params)))
    (setf (gethash (gethash "uri" doc) *documents*) (gethash "text" doc))))

(defun handle-did-change (params)
  (let* ((doc (gethash "textDocument" params))
         (changes (gethash "contentChanges" params)))
    (when (> (length changes) 0)
      (setf (gethash (gethash "uri" doc) *documents*)
            (gethash "text" (aref changes 0))))))

(defun position-symbol (params)
  (let* ((doc (gethash "textDocument" params))
         (pos (gethash "position" params))
         (text (gethash (gethash "uri" doc) *documents*)))
    (and text (symbol-at text (gethash "line" pos) (gethash "character" pos)))))

(defun handle-hover (id params)
  (let ((sym (position-symbol params)))
    (if (null sym)
        (send-response id :null)
        (swank-rex
         (format nil "(swank:describe-symbol ~S)" sym)
         :callback
         (lambda (status value)
           (if (eq status :ok)
               (send-response id (make-jobj "contents" (make-jobj "kind" "markdown" "value" (or value ""))))
               (send-response id :null)))))))

(defun prefix-before-point (text line character)
  "Only the characters BEFORE the cursor. symbol-at reads in both
   directions — at \"rt-st|art\" that would yield \"rt-start\", and the
   completion would filter by the complete name instead of by what was
   typed."
  (let ((line-text (nth-line text line)))
    (when line-text
      (let* ((end (min character (length line-text)))
             (start end))
        (loop while (and (> start 0)
                         (symbol-constituent-p (char line-text (1- start))))
              do (decf start))
        (subseq line-text start end)))))

(defparameter *completion-context-max-lines* 500
  "Fallback cap for the completion's context window.

Normally the context reaches back to the start of the enclosing top-level
form.  When there is none — in a file without a paren in column 0, or
while one is still typing — this limit takes effect, so that a whole file
does not go through the bridge on every keystroke.")

(defun completion-context-start-line (text line)
  "Line number of the start of the enclosing top-level form.

The convention is the same as in Emacs: an opening paren in column 0
begins a top-level form.  Up to v81.14 a fixed window of 120 lines was
used instead; with a longer DEFUN its parameters thereby fell out of the
context and were no longer completed."
  (let ((floor-line (max 0 (- line *completion-context-max-lines*))))
    (loop for ln downfrom line to floor-line
          for text-line = (nth-line text ln)
          when (and text-line (plusp (length text-line))
                    (char= (char text-line 0) #\())
            do (return ln)
          finally (return floor-line))))

(defun completion-context (text line character)
  "Source text from the start of the enclosing top-level form to the cursor."
  (let ((start (completion-context-start-line text line)))
    (with-output-to-string (out)
      (loop for ln from start to line
            for l = (or (nth-line text ln) "")
            do (if (= ln line)
                   (write-string (subseq l 0 (min character (length l))) out)
                   (progn (write-string l out) (terpri out)))))))

(defun handle-completion (id params)
  "textDocument/completion — symbol completion.

   Two things the earlier version got wrong: it took *swank-package* (the
   REPL's package) instead of the in-package in effect in the file, and it
   also sent the characters after the cursor along."
  (let* ((doc (gethash "textDocument" params))
         (pos (gethash "position" params))
         (text (and doc (gethash (gethash "uri" doc) *documents*)))
         (line (and pos (gethash "line" pos)))
         (character (and pos (gethash "character" pos)))
         (prefix (or (and text (prefix-before-point text line character)) ""))
         (pkg (if text
                  (package-at-position text line character)
                  *swank-package*)))
    (if (null text)
        ;; Without known buffer text there is no context, and therefore
        ;; nichts Sinnvolles anzubieten.
        (send-response id (make-jobj "isIncomplete" :true "items" (vector)))
        (swank-rex
         (format nil "(clamps-bridge-rpc:completions-for-repl ~S ~S ~S)"
                 prefix pkg
                 (completion-context text line character))
         :callback
         (lambda (status value)
           (if (and (eq status :ok) (consp value) (eq (first value) :ok)
                    ;; Check the arity too: an unexpectedly shaped answer
                    ;; made destructuring-bind throw, and the handler
                    ;; answered with -32603 instead of an empty list.
                    (= (length value) 3))
               (destructuring-bind (ok truncated items) value
                 (declare (ignore ok))
                 (send-response id
                   (make-jobj
                    "isIncomplete" (if truncated :true :false)
                    "items"
                    (coerce
                     (mapcar
                      (let ((rank -1))
                        (lambda (it)
                          (destructuring-bind (label kind detail docu) it
                            (let ((obj (make-jobj "label" label "kind" kind)))
                              ;; sortText is not optional.  Without this
                              ;; field VS Code re-sorts the list with its own
                              ;; matcher, and the entire ranking from
                              ;; completion.lisp — Scope, Kopfposition,
                              ;; &key context and fuzzy score is discarded.
                              (setf (gethash "sortText" obj)
                                    (format nil "~5,'0D" (incf rank)))
                              ;; Leave empty fields out: otherwise VS Code
                              ;; shows an empty detail line next to every
                              ;; entry.
                              (when (and detail (string/= detail ""))
                                (setf (gethash "detail" obj) detail))
                              (when (and docu (string/= docu ""))
                                (setf (gethash "documentation" obj) docu))
                              obj))))
                      items)
                     'vector))))
               (send-response id
                 (make-jobj "isIncomplete" :false "items" (vector)))))))))

(defun package-at-position (text line character)
  "Finds the package in effect at the position: the last (in-package ...)
   form in the text BEFORE the position. Knows the usual spellings :foo,
   #:foo, \"FOO\", foo. Falls back to COMMON-LISP-USER."
  (let ((offset 0) (current-line 0))
    ;; Determine the character offset of the position
    (loop for i from 0 below (length text)
          while (< current-line line)
          do (when (char= (char text i) #\Newline) (incf current-line))
             (incf offset))
    (incf offset character)
    (setf offset (min offset (length text)))
    (let ((pkg "COMMON-LISP-USER")
          (search-region (subseq text 0 offset))
          (start 0))
      (loop
        (let ((idx (search "(in-package" search-region :start2 start
                            :test #'char-equal)))
          (unless idx (return))
          ;; Namen hinter "(in-package" extrahieren
          (let* ((rest-start (+ idx (length "(in-package")))
                 (end (position #\) search-region :start rest-start)))
            (when end
              (let ((name (string-trim '(#\Space #\Tab #\Newline #\Return #\: #\# #\")
                                        (subseq search-region rest-start end))))
                (when (> (length name) 0)
                  (setf pkg (string-upcase name)))))
            (setf start (1+ idx)))))
      pkg)))


(defun text-before-position (text line character)
  (with-output-to-string (out)
    (loop for ln from 0 to line
          for value = (or (nth-line text ln) "")
          do (if (= ln line)
                 (write-string (subseq value 0 (min character (length value))) out)
                 (progn (write-string value out) (terpri out))))))

(defun call-context-before-point (text line character)
  "Returns (operator active-parameter) for the innermost open form.
Strings and line comments are ignored; nested forms each count as one
argument of the outer form."
  (let* ((source (text-before-position text line character))
         (stack nil) (token "") (in-string nil) (escape nil) (comment nil))
    (labels ((flush-token ()
               (when (> (length token) 0)
                 (when stack
                   (let ((frame (first stack)))
                     (if (null (first frame))
                         (setf (first frame) token)
                         (incf (second frame)))))
                 (setf token ""))))
      (loop for ch across source do
        (cond
          (comment (when (char= ch #\Newline) (setf comment nil)))
          (in-string
           (cond (escape (setf escape nil))
                 ((char= ch #\\) (setf escape t))
                 ((char= ch #\") (setf in-string nil))))
          ;; Character literal: after #\ the next character belongs to
          ;; the token, even if it is a paren. Otherwise the nesting slips
          ;; at (foo #\( ...).
          ((and (>= (length token) 2)
                (string= "#\\" (subseq token (- (length token) 2))))
           (setf token (concatenate 'string token (string ch))))
          ((char= ch #\;) (flush-token) (setf comment t))
          ((char= ch #\") (flush-token) (setf in-string t))
          ((char= ch #\() (flush-token) (push (list nil 0) stack))
          ((char= ch #\))
           (flush-token)
           (when stack
             (pop stack)
             (when stack (incf (second (first stack))))))
          ;; No C escapes in CL strings: " \t\r\n" would have been " trn".
          ((member ch '(#\Space #\Tab #\Return #\Newline #\Page)) (flush-token))
          (t (setf token (concatenate 'string token (string ch))))))
      ;; If the cursor sits in the middle of a token, that argument is
      ;; still being typed and is therefore the active one. If it sits
      ;; behind a separator, the next argument is meant. Without this
      ;; distinction signature help marked the previous parameter after
      ;; every space — that is, exactly at the trigger.
      (let ((in-token (> (length token) 0)))
        (flush-token)
        (when (and stack (first (first stack)))
          (let ((count (second (first stack))))
            (list (first (first stack))
                  (if in-token (max 0 (1- count)) count))))))))

(defun handle-signature-help (id params)
  (let* ((doc (gethash "textDocument" params))
         (pos (gethash "position" params))
         (text (and doc (gethash (gethash "uri" doc) *documents*)))
         (line (and pos (gethash "line" pos)))
         (character (and pos (gethash "character" pos)))
         (ctx (and text (call-context-before-point text line character)))
         (pkg (if text (package-at-position text line character) *swank-package*)))
    (if (null ctx)
        (send-response id :null)
        (destructuring-bind (operator active) ctx
          (swank-rex
           (format nil "(clamps-bridge-rpc:autodoc-for-repl ~S ~S)" operator pkg)
           :callback
           (lambda (status value)
             (if (and (eq status :ok) (consp value) (eq (first value) :ok)
                      (= (length value) 4))
                 (destructuring-bind (ok label params-list docu) value
                   (declare (ignore ok))
                   (let ((signature (make-jobj
                                     "label" label
                                     "parameters"
                                     (coerce (mapcar (lambda (x) (make-jobj "label" x)) params-list)
                                             'vector))))
                     (when (and docu (string/= docu ""))
                       (setf (gethash "documentation" signature)
                             (make-jobj "kind" "markdown" "value" docu)))
                     (send-response id
                       (make-jobj "signatures" (vector signature)
                                  "activeSignature" 0
                                  "activeParameter" active))))
                 (send-response id :null))))))))

(defun xref-locations-for-lsp (entries)
  (let ((locations nil))
    (dolist (entry entries)
      ;; A tool entry is a plist.
      (let* ((file (getf entry :file))
             (line (or (getf entry :line) 1))
             (character (or (getf entry :character) 0)))
        (when file
          (push (make-jobj
                 "uri" (format nil "file://~A" file)
                 "range" (make-jobj
                          "start" (make-jobj "line" (max 0 (1- line)) "character" character)
                          "end" (make-jobj "line" (max 0 (1- line)) "character" character)))
                locations))))
    (coerce (nreverse locations) 'vector)))

(defun handle-references (id params)
  (let* ((sym (position-symbol params))
         (doc (gethash "textDocument" params))
         (pos (gethash "position" params))
         (text (and doc (gethash (gethash "uri" doc) *documents*)))
         (pkg (if text (package-at-position text (gethash "line" pos)
                                             (gethash "character" pos))
                  "COMMON-LISP-USER")))
    (if (null sym)
        (send-response id (vector))
        (swank-rex
         (format nil "(clamps-bridge-rpc:xref-for-repl ~S ~S \"references\")" sym pkg)
         :callback
         (lambda (status value)
           (if (and (eq status :ok) (consp value) (eq (first value) :ok))
               (send-response id (xref-locations-for-lsp (second value)))
               (send-response id (vector))))))))

(defun handle-definition (id params)
  "textDocument/definition — the M-. experience: jumps to the definition
   of any symbol, including into SBCL's own sources. The actual search,
   including logical pathname translation, runs in the CLAMPS image
   (find-definitions-for-repl); here it is only mapped onto LSP."
  (let* ((sym (position-symbol params))
         (doc (gethash "textDocument" params))
         (pos (gethash "position" params))
         (text (and doc (gethash (gethash "uri" doc) *documents*)))
         (pkg (if text
                  (package-at-position text
                                       (gethash "line" pos)
                                       (gethash "character" pos))
                  "COMMON-LISP-USER")))
    (if (null sym)
        (send-response id (vector))
        (swank-rex
         (format nil "(clamps-bridge-rpc:find-definitions-for-repl ~S ~S)" sym pkg)
         :callback
         (lambda (status value)
           (if (and (eq status :ok) (consp value) (eq (first value) :ok))
               (let ((locations '()) (fileless '()))
                 (dolist (entry (second value))
                   (destructuring-bind (file line col label) entry
                     ;; LSP can only jump to real places. Entries without
                     ;; a findable file — functions defined in the REPL,
                     ;; SBCL without installed sources — are reported
                     ;; rather than swallowed: an F12 that does nothing
                     ;; and says nothing is worse than a message.
                     (if file
                         (push (make-jobj
                                "uri" (format nil "file://~A" file)
                                "range" (make-jobj
                                         "start" (make-jobj "line" line "character" col)
                                         "end" (make-jobj "line" line "character" col)))
                               locations)
                         (push (or label "?") fileless))))
                 (when (and (null locations) fileless)
                   (show-message
                    (format nil "~A: definition known (~{~A~^, ~}), but no source file — defined in the REPL, or the SBCL sources are not installed."
                            sym (nreverse fileless))
                    2))
                 (send-response id (coerce (nreverse locations) 'vector)))
               (progn
                 (log-msg "definition: nothing found for ~S in ~S" sym pkg)
                 (show-message (format nil "No definition found for ~A in ~A." sym pkg) 2)
                 (send-response id (vector)))))))))

(defun lisp-escape-string (s)
  "Escapes a string for embedding into a Lisp form via ~S.
   Prin1 does that correctly, including quotes and backslashes."
  (prin1-to-string s))

(defun handle-eval (id params)
  "clamps/eval — evaluates code in the running CLAMPS session.
   The client sends {code, package} and expects {output, package}."
  (let* ((code (gethash "code" params))
         (pkg (or (gethash "package" params) *swank-package*)))
    (if (or (null code) (string= (string-trim '(#\Space #\Tab #\Newline #\Return) code) ""))
        (send-response id (make-jobj "output" "" "package" pkg))
        ;; eval-for-repl returns (STATUS OUTPUT PACKAGE). We build the
        ;; form as a string; code and pkg are escaped cleanly via ~S (the
        ;; prin1 representation), so that quotation marks, backslashes
        ;; and newlines in the code do not take the form apart.
        (swank-rex
         (format nil "(clamps-bridge-rpc:eval-for-repl ~S ~S)" code pkg)
         :callback
         (lambda (status value)
           (if (and (eq status :ok) (consp value))
               (let* ((eval-status (first value))
                      (output (or (second value) ""))
                      (result-pkg (or (third value) pkg)))
                 (declare (ignore eval-status))
                 ;; Important: the TS terminal simply renders output as
                 ;; text, errors and values both come over the same
                 ;; channel. The eval status (:ok/:error) is already
                 ;; contained in the string (the error text), so it does
                 ;; not matter here.
                 (when result-pkg (setf *swank-package* result-pkg))
                 (let ((presentations (fourth value)))
                   (send-response id
                     (make-jobj "output" output
                                "package" result-pkg
                                "presentations"
                                (coerce
                                 (mapcar (lambda (p)
                                           (make-jobj "id" (first p)
                                                      "preview" (or (second p) "")
                                                      "type" (or (third p) "")))
                                         presentations)
                                 'vector)))))
               ;; Swank itself aborted the call (function not found,
               ;; reader error in the RPC form, and so on).
               (send-response id
                 (make-jobj "output"
                            (format nil "Bridge-Eval fehlgeschlagen: ~A" value)
                            "package" pkg))))))))



(defun handle-indentation-rules (id params)
  (declare (ignore params))
  (swank-rex
   "(clamps-bridge-rpc:indentation-rules-for-repl)"
   :callback
   (lambda (status value)
     (if (and (eq status :ok) (consp value) (eq (first value) :ok))
         (send-response id
           (make-jobj "rules"
             (coerce (mapcar (lambda (rule)
                               (make-jobj "name" (first rule) "body" (second rule)))
                             (second value))
                     'vector)))
         (send-response id (make-jobj "rules" (vector)))))))

(defun handle-asdf-operation (id params)
  (let ((operation (string-downcase (or (gethash "operation" params) "load")))
        (system (or (gethash "system" params) "")))
    (if (string= system "")
        (send-response id (make-jobj "ok" :false "message" "No ASDF system supplied"))
        (swank-rex
         (format nil "(clamps-bridge-rpc:asdf-operation-for-repl :~A ~S)" operation system)
         :callback
         (lambda (status value)
           (if (and (eq status :ok) (consp value))
               (send-response id (make-jobj "ok" (if (eq (first value) :ok) :true :false)
                                            "message" (or (second value) "")))
               (send-response id (make-jobj "ok" :false "message" (format nil "~A" value)))))))))

(defun handle-stickers (id params)
  (declare (ignore params))
  (swank-rex
   "(clamps-bridge-rpc:sticker-snapshot-for-repl)"
   :callback
   (lambda (status value)
     (if (and (eq status :ok) (consp value))
         (send-response id
           (make-jobj "entries"
             (coerce
              (mapcar (lambda (entry)
                        (make-jobj "key" (first entry)
                                   "records"
                                   (coerce
                                    (mapcar (lambda (record)
                                              (make-jobj "time" (first record)
                                                         "id" (second record)
                                                         "preview" (third record)))
                                            (second entry))
                                    'vector)))
                      (second value))
              'vector)))
         (send-response id (make-jobj "entries" (vector)))))))

(defun handle-stickers-clear (id params)
  (declare (ignore params))
  (swank-rex "(clamps-bridge-rpc:sticker-clear-for-repl)"
             :callback (lambda (status value)
                         (declare (ignore value))
                         (send-response id (make-jobj "ok" (if (eq status :ok) :true :false))))))

(defun handle-macroexpand (id params)
  "clamps/macroexpand — expands the form in the code string.
   The client sends {code, package, full} and expects {output, package}."
  (let* ((code (gethash "code" params))
         (pkg (or (gethash "package" params) *swank-package*))
         (full (gethash "full" params)))
    (if (or (null code) (string= (string-trim '(#\Space #\Tab #\Newline #\Return) code) ""))
        (send-response id (make-jobj "output" "" "package" pkg))
        ;; full is :true/:false (from json-read) or nil. Translate it to
        ;; t/nil for the Lisp side: only :true counts as full.
        (swank-rex
         (format nil "(clamps-bridge-rpc:macroexpand-for-repl ~S ~S ~A)"
                 code pkg (if (eq full :true) "t" "nil"))
         :callback
         (lambda (status value)
           (if (and (eq status :ok) (consp value))
               (let ((output (or (second value) ""))
                     (result-pkg (or (third value) pkg)))
                 (send-response id (make-jobj "output" output "package" result-pkg)))
               (send-response id
                 (make-jobj "output"
                            (format nil "Bridge-Macroexpand fehlgeschlagen: ~A" value)
                            "package" pkg))))))))

(defun handle-disassemble (id params)
  "clamps/disassemble — disassembles the function at the symbol.
   The client sends {symbol, package} and expects {output, package}."
  (let* ((symbol (gethash "symbol" params))
         (pkg (or (gethash "package" params) *swank-package*)))
    (if (or (null symbol) (string= (string-trim '(#\Space #\Tab #\Newline #\Return) symbol) ""))
        (send-response id (make-jobj "output" "" "package" pkg))
        (swank-rex
         (format nil "(clamps-bridge-rpc:disassemble-for-repl ~S ~S)" symbol pkg)
         :callback
         (lambda (status value)
           (if (and (eq status :ok) (consp value))
               (let ((output (or (second value) ""))
                     (result-pkg (or (third value) pkg)))
                 (send-response id (make-jobj "output" output "package" result-pkg)))
               (send-response id
                 (make-jobj "output"
                            (format nil "Bridge-Disassemble fehlgeschlagen: ~A" value)
                            "package" pkg))))))))

(defun send-inspect-result (id value fallback-pkg)
  "Shared answer shaping for all three inspect methods.
   Expects (:ok obj-id type print parts kind meta) or (:error msg ...)."
  (if (and (consp value) (eq (first value) :ok))
      (destructuring-bind (ok obj-id type print parts kind meta) value
        (declare (ignore ok))
        (send-response id
          (make-jobj
           "id" obj-id
           "kind" (or kind "atom")
           "type" (or type "")
           "print" (or print "")
           "meta" (coerce (mapcar (lambda (m)
                                    (make-jobj "key" (first m)
                                               "value" (second m)))
                                  meta)
                          'vector)
           ;; parts: (label index preview navigierbar-p schreibbar-p)
           "parts" (coerce (mapcar (lambda (p)
                                     (make-jobj "label" (first p)
                                                "index" (second p)
                                                "preview" (or (third p) "")
                                                "navigable"
                                                (if (fourth p) :true :false)
                                                "settable"
                                                (if (fifth p) :true :false)
                                                ;; Sixth field: does the part
                                                ;; have parts itself? It decides
                                                ;; on the expand arrow. If it is
                                                ;; missing (an older image) it
                                                ;; is NIL -> the client falls
                                                ;; back to navigable.
                                                "expandable"
                                                (cond ((null (nthcdr 5 p)) :null)
                                                      ((sixth p) :true)
                                                      (t :false))))
                                   parts)
                           'vector)
           "package" fallback-pkg)))
      (let ((errmsg (if (and (consp value) (stringp (second value)))
                        (second value)
                        (format nil "~A" value))))
        (send-response id
          (make-jobj "id" 0 "kind" "error" "type" "error" "print" errmsg
                     "meta" (vector) "parts" (vector)
                     "package" fallback-pkg)))))

(defun handle-inspect (id params)
  "clamps/inspect — evaluates an expression and inspects the result. The
   client sends {expr, package} and gets an object ID back, over which
   navigation continues."
  (let* ((expr (gethash "expr" params))
         (pkg (or (gethash "package" params) *swank-package*)))
    (if (or (null expr)
            (string= (string-trim '(#\Space #\Tab #\Newline #\Return) expr) ""))
        (send-response id (make-jobj "id" 0 "kind" "atom" "type" "" "print" ""
                                     "meta" (vector) "parts" (vector)
                                     "package" pkg))
        (swank-rex
         (format nil "(clamps-bridge-rpc:inspect-for-repl ~S ~S)" expr pkg)
         :callback
         (lambda (status value)
           (send-inspect-result id (if (eq status :ok) value nil) pkg))))))

(defun handle-inspect-part (id params)
  "clamps/inspectPart — navigates from an object to its nth part. Replaces
   the earlier navigation over re-evaluable expressions."
  (let ((obj-id (gethash "id" params))
        (index (gethash "index" params))
        (pkg *swank-package*))
    (swank-rex
     (format nil "(clamps-bridge-rpc:inspect-part-for-repl ~D ~D)"
             (or obj-id 0) (or index 0))
     :callback
     (lambda (status value)
       (send-inspect-result id (if (eq status :ok) value nil) pkg)))))

(defun handle-inspect-refresh (id params)
  "clamps/inspectRefresh — describes the same object anew. Necessary
   because objects change underneath the display while DSP is running."
  (let ((obj-id (gethash "id" params))
        (pkg *swank-package*))
    (swank-rex
     (format nil "(clamps-bridge-rpc:inspect-id-for-repl ~D)" (or obj-id 0))
     :callback
     (lambda (status value)
       (send-inspect-result id (if (eq status :ok) value nil) pkg)))))

(defun handle-inspect-release (id params)
  "clamps/inspectRelease — releases the object table. The client calls
   this when the panel is closed; without it we would hold objects past
   the GC, which gets expensive with audio buffers."
  (declare (ignore params))
  (swank-rex
   "(clamps-bridge-rpc:inspect-release-for-repl)"
   :callback
   (lambda (status value)
     (declare (ignore status value))
     (send-response id (make-jobj "ok" :true)))))

(defun handle-inspect-set (id params)
  "clamps/inspectSet — sets a part of the object to a new value. The
   client sends {id, index, value, package}."
  (let ((obj-id (gethash "id" params))
        (index (gethash "index" params))
        (value (gethash "value" params))
        (pkg (or (gethash "package" params) *swank-package*)))
    (if (or (null value) (string= value ""))
        (send-response id (make-jobj "id" (or obj-id 0) "kind" "error"
                                     "type" "error"
                                     "print" "Leere Eingabe"
                                     "meta" (vector) "parts" (vector)
                                     "package" pkg))
        (swank-rex
         (format nil "(clamps-bridge-rpc:inspect-set-part-for-repl ~D ~D ~S ~S)"
                 (or obj-id 0) (or index 0) value pkg)
         :callback
         (lambda (status value2)
           (send-inspect-result id (if (eq status :ok) value2 nil) pkg))))))



(defun handle-incudine-nodes (id params)
  "clamps/incudineNodes — read-only Snapshot des laufenden Node-Baums."
  (declare (ignore params))
  (swank-rex
   "(clamps-bridge-rpc:incudine-node-tree-for-repl)"
   :callback
   (lambda (status value)
     (if (and (eq status :ok) (consp value))
         (let* ((state (first value))
                (message (or (second value) ""))
                (nodes (or (third value) nil))
                (available (eq state :ok)))
           (send-response id
             (make-jobj
              "available" (if available :true :false)
              "error" message
              "nodes"
              (coerce
               (mapcar
                (lambda (node)
                  (let ((controls (or (getf node :controls) nil)))
                    (make-jobj
                     "id" (or (getf node :id) -1)
                     "parent" (or (getf node :parent) :null)
                     "name" (or (getf node :name) "")
                     "kind" (if (eq (getf node :kind) :group) "group" "dsp")
                     "paused" (if (getf node :paused) :true :false)
                     "done" (if (getf node :done) :true :false)
                     "uptime" (or (getf node :uptime) "")
                     "controls"
                     (coerce
                      (mapcar (lambda (control)
                                (make-jobj "name" (or (getf control :name) "")
                                           "value" (or (getf control :value) "")))
                              controls)
                      'vector))))
                nodes)
               'vector))))
         (send-response id
           (make-jobj "available" :false
                      "error" (format nil "Node-Snapshot fehlgeschlagen: ~A" value)
                      "nodes" (vector)))))))

(defun handle-rt-status (id params)
  "clamps/rtStatus — state of the Incudine realtime server.
   Expects no parameters, returns {running, info: [{key,value}]}.
   It is polled by the status bar and must therefore be cheap and robust:
   on an error, better report running=false than block the bridge."
  (declare (ignore params))
  (swank-rex
   "(clamps-bridge-rpc:rt-status-for-repl)"
   :callback
   (lambda (status value)
     (if (and (eq status :ok) (consp value) (eq (first value) :ok))
         (destructuring-bind (ok running info) value
           (declare (ignore ok))
           (send-response id
             (make-jobj
              "running" (if running :true :false)
              "info" (coerce
                      (mapcar (lambda (p)
                                (make-jobj "key" (car p) "value" (cdr p)))
                              info)
                      'vector))))
         (send-response id
           (make-jobj "running" :false
                      "info" (vector
                              (make-jobj "key" "fehler"
                                         "value" (format nil "~A" value)))))))))

(defun handle-trace-toggle (id params)
  "clamps/toggleTrace — tracing for a function on/off.
   The client sends {symbol, package} and expects {output, traced}."
  (let* ((symbol (gethash "symbol" params))
         (pkg (or (gethash "package" params) *swank-package*)))
    (if (null symbol)
        (send-response id (make-jobj "output" "No symbol." "traced" :false))
        (swank-rex
         (format nil "(clamps-bridge-rpc:trace-toggle-for-repl ~S ~S)" symbol pkg)
         :callback
         (lambda (status value)
           (if (and (eq status :ok) (consp value))
               (destructuring-bind (st text traced) value
                 (declare (ignore st))
                 (send-response id (make-jobj "output" (or text "")
                                             "traced" (if traced :true :false))))
               (send-response id (make-jobj
                                  "output" (format nil "Trace fehlgeschlagen: ~A" value)
                                  "traced" :false))))))))

(defun handle-untrace-all (id params)
  "clamps/untraceAll — all traces off."
  (declare (ignore params))
  (swank-rex
   "(clamps-bridge-rpc:untrace-all-for-repl)"
   :callback
   (lambda (status value)
     (if (and (eq status :ok) (consp value))
         (send-response id (make-jobj "output" (or (second value) "")))
         (send-response id (make-jobj
                            "output" (format nil "Untrace fehlgeschlagen: ~A" value)))))))



(defun browser-entry-json (entry)
  (make-jobj "label" (or (getf entry :label) "")
             "description" (or (getf entry :description) "")
             "tooltip" (or (getf entry :tooltip) "")
             "icon" (or (getf entry :icon) "symbol-misc")
             "inspect" (or (getf entry :inspect) "")
             "children" (coerce (mapcar #'browser-entry-json (or (getf entry :children) nil)) 'vector)))

(defun handle-image-browser (id form)
  (swank-rex form :callback
    (lambda (status value)
      (if (and (eq status :ok) (consp value))
          (let ((ok (eq (first value) :ok))
                (payload (second value)))
            (send-response id
              (make-jobj "available" (if ok :true :false)
                         "error" (if ok "" (or payload "Not available."))
                         "entries" (if ok
                                       (coerce (mapcar #'browser-entry-json (or payload nil)) 'vector)
                                       (vector)))))
          (send-response id (make-jobj "available" :false "error" (format nil "~A" value) "entries" (vector)))))))

(defun handle-packages (id params) (declare (ignore params))
  (handle-image-browser id "(clamps-bridge-rpc:packages-for-repl)"))
(defun handle-classes (id params) (declare (ignore params))
  (handle-image-browser id "(clamps-bridge-rpc:classes-for-repl)"))
(defun handle-threads-browser (id params) (declare (ignore params))
  (handle-image-browser id "(clamps-bridge-rpc:threads-for-repl)"))
(defun handle-traced-browser (id params) (declare (ignore params))
  (handle-image-browser id "(clamps-bridge-rpc:traced-for-repl)"))

(defun handle-untrace-one (id params)
  (let ((label (or (gethash "label" params) "")))
    (swank-rex (format nil "(clamps-bridge-rpc:untrace-one-for-repl ~S)" label)
      :callback
      (lambda (status value)
        (if (and (eq status :ok) (consp value) (eq (first value) :ok))
            (send-response id (make-jobj "ok" :true "message" (or (second value) "")))
            (send-response id (make-jobj "ok" :false
                                         "message" (format nil "~A"
                                                           (if (consp value) (second value) value)))))))))

(defun plist-value (plist key &optional default)
  (let ((tail (member key plist :test #'eq))) (if tail (second tail) default)))

(defun location-line-character (location)
  "Best effort for Swank locations. Unknown forms stay at 0:0."
  (let ((line 0) (character 0))
    (labels ((walk (x)
               (when (consp x)
                 (cond
                   ((eq (car x) :line)
                    (let ((v (cdr x)))
                      (when (numberp (first v)) (setf line (max 0 (1- (first v)))))
                      (when (numberp (second v)) (setf character (max 0 (second v))))))
                   ((eq (car x) :position)
                    ;; Position information consists of character
                    ;; offsets; without a text reference 0:0 is more
                    ;; honest than a wrong line.
                    nil))
                 (dolist (e x) (walk e)))))
      (walk location))
    (values line character)))

(defun handle-compiler-notes (id params)
  (let* ((text (or (gethash "text" params) ""))
         (file (or (gethash "file" params) "buffer.lisp"))
         (uri (or (gethash "uri" params) file))
         (pkg "COMMON-LISP-USER")
         (form (format nil
                       "(let ((*package* (or (find-package :common-lisp-user) *package*))) (swank:compile-string-for-emacs ~S ~S '((:position 0) (:line 1 0)) ~S nil))"
                       text uri file)))
    (swank-rex form :package pkg :callback
      (lambda (status value)
        (if (and (eq status :ok) (consp value))
            (let* ((notes (or (plist-value value :notes) nil))
                   (success (plist-value value :successp))
                   (duration (or (plist-value value :duration) 0.0)))
              (send-response id
                (make-jobj "success" (if success :true :false)
                           "duration" duration
                           "notes"
                           (coerce
                            (mapcar
                             (lambda (note)
                               (multiple-value-bind (line character)
                                   (location-line-character (plist-value note :location))
                                 (make-jobj "message" (or (plist-value note :message) "Compiler-Hinweis")
                                            "severity" (string-downcase (string (or (plist-value note :severity) :note)))
                                            "line" line "character" character)))
                             notes)
                            'vector))))
            (send-response id
              (make-jobj "success" :false "duration" 0 "notes" (vector)
                         "error" (format nil "~A" value))))))))



(defun tool-entry-json (entry)
  (make-jobj "label" (or (getf entry :label) "")
             "description" (or (getf entry :description) "")
             "detail" (or (getf entry :detail) "")
             "file" (or (getf entry :file) "")
             "line" (getf entry :line)
             "character" (getf entry :character)
             "offset" (getf entry :offset)
             "inspect" (or (getf entry :inspect) "")))

(defun handle-tool-result (id form)
  (swank-rex form :callback
    (lambda (status value)
      (if (and (eq status :ok) (consp value))
          (let ((ok (eq (first value) :ok)) (payload (second value)))
            (send-response id
              (make-jobj "available" (if ok :true :false)
                         "error" (if ok "" (or payload "Not available."))
                         "entries" (if ok (coerce (mapcar #'tool-entry-json (or payload nil)) 'vector) (vector)))))
          (send-response id (make-jobj "available" :false "error" (format nil "~A" value) "entries" (vector)))))))

(defun handle-xref (id params)
  (handle-tool-result id
    (format nil "(clamps-bridge-rpc:xref-for-repl ~S ~S ~S)"
            (or (gethash "symbol" params) "")
            (or (gethash "package" params) "COMMON-LISP-USER")
            (or (gethash "kind" params) "definitions"))))

(defun handle-sticker-samples (id params)
  "clamps/stickerSamples — new values of a sticker ring since SINCE.

The caller holds the last sequence number it saw and receives only the
increment.  DROPPED names the values that fell out of the ring between
two queries; the display has to make that visible instead of drawing a
gap as an unbroken course."
  (let ((key (or (gethash "key" params) ""))
        (since (or (gethash "since" params) 0))
        (limit (or (gethash "limit" params) 4096)))
    (swank-rex
     (format nil "(clamps-bridge-rpc:sticker-samples-since-for-repl ~S ~D ~D)"
             key (truncate since) (truncate limit))
     :callback
     (lambda (status value)
       (if (and (eq status :ok) (consp value) (eq (first value) :ok)
                (= (length value) 4))
           (destructuring-bind (ok sequence dropped values) value
             (declare (ignore ok))
             (send-response id
               (make-jobj "sequence" sequence
                          "dropped" dropped
                          "values" (coerce values 'vector))))
           (send-response id
             (make-jobj "sequence" 0 "dropped" 0 "values" (vector))))))))

(defun handle-sticker-keys (id params)
  "clamps/stickerKeys — registered rings with their parameters, without the values."
  (declare (ignore params))
  (swank-rex "(clamps-bridge-rpc:sticker-keys-for-repl)"
    :callback
    (lambda (status value)
      (if (and (eq status :ok) (consp value) (eq (first value) :ok))
          (send-response id
            (make-jobj "entries"
                       (coerce (mapcar (lambda (e)
                                         (destructuring-bind (key capacity decimation
                                                              element-type sequence) e
                                           (make-jobj "key" key
                                                      "capacity" capacity
                                                      "decimation" decimation
                                                      "elementType" element-type
                                                      "sequence" sequence)))
                                       (second value))
                               'vector)))
          (send-response id (make-jobj "entries" (vector)))))))

(defun handle-sticker-spectrum (id params)
  "clamps/stickerSpectrum — spectrum of the newest values of a ring.

Unlike clamps/stickerSamples, nothing is fetched incrementally here.  A
spectroscope does not want to know what arrived since the last frame but
what the signal looks like right now — and for that every frame needs the
same window again, only shifted along a little.  A sequence number would
therefore save nothing here; it would just be a number nobody reads.

The FFT runs on the Lisp side (see sticker-spectrum-for-repl): what is
transferred is one number per drawn column, not one per bin and certainly
not one per sample."
  (let ((key (or (gethash "key" params) ""))
        (fft-size (or (gethash "fftSize" params) 1024))
        (window (or (gethash "window" params) "hann"))
        (columns (or (gethash "columns" params) 256))
        (mode (or (gethash "mode" params) "log"))
        (floor-db (or (gethash "floorDb" params) -96.0)))
    (swank-rex
     (format nil "(clamps-bridge-rpc:sticker-spectrum-for-repl ~S ~D ~S ~D ~S ~F)"
             key (truncate fft-size) window (truncate columns) mode
             (float floor-db 1.0d0))
     :callback
     (lambda (status value)
       (if (and (eq status :ok) (consp value) (eq (first value) :ok)
                (= (length value) 3))
           (destructuring-bind (ok header values) value
             (declare (ignore ok))
             (destructuring-bind (sample-rate effective-rate fft-size mode
                                  f-min f-max floor-db peak-freq peak-db
                                  bin-width warnings)
                 header
               (send-response id
                 (make-jobj "available" :true
                            "error" ""
                            "sampleRate" sample-rate
                            "effectiveRate" effective-rate
                            "fftSize" fft-size
                            "mode" mode
                            "fMin" f-min
                            "fMax" f-max
                            "floorDb" floor-db
                            "peakFreq" peak-freq
                            "peakDb" peak-db
                            "binWidth" bin-width
                            "warnings" (coerce warnings 'vector)
                            "values" (coerce values 'vector)))))
           (send-response id
             (make-jobj "available" :false
                        "error" (if (and (consp value) (eq (first value) :error))
                                    (or (second value) "Spectrum not available.")
                                    (format nil "~A" value))
                        "warnings" (vector)
                        "values" (vector))))))))

(defun handle-sticker-spectrogram (id params)
  "clamps/stickerSpectrogram — several analysis frames per request.

Unlike clamps/stickerSpectrum this IS incremental, and for the opposite
reason to the sticker samples: not to save bandwidth, but so that the time
axis has a unit. The frames sit on an absolute grid of HOP samples, the
caller names the last frame index it received, and what fell out of the
ring in between is reported rather than skipped. A gap in a spectrogram
misdates everything after it and cannot be seen."
  (let ((key (or (gethash "key" params) ""))
        (fft-size (or (gethash "fftSize" params) 1024))
        (window (or (gethash "window" params) "hann"))
        (columns (or (gethash "columns" params) 256))
        (mode (or (gethash "mode" params) "log"))
        (floor-db (or (gethash "floorDb" params) -96.0))
        (since (or (gethash "since" params) 0))
        (hop (or (gethash "hop" params) 512))
        (max-frames (or (gethash "maxFrames" params) 16)))
    (swank-rex
     (format nil "(clamps-bridge-rpc:sticker-spectrogram-for-repl ~S ~D ~S ~D ~S ~F ~D ~D ~D)"
             key (truncate fft-size) window (truncate columns) mode
             (float floor-db 1.0d0) (truncate since) (truncate hop)
             (truncate max-frames))
     :callback
     (lambda (status value)
       (if (and (eq status :ok) (consp value) (eq (first value) :ok)
                (= (length value) 3))
           (destructuring-bind (ok header frames) value
             (declare (ignore ok))
             (destructuring-bind (sample-rate effective-rate fft-size mode
                                  f-min f-max floor-db bin-width hop frame
                                  seconds-per-frame dropped warnings)
                 header
               (send-response id
                 (make-jobj "available" :true
                            "error" ""
                            "sampleRate" sample-rate
                            "effectiveRate" effective-rate
                            "fftSize" fft-size
                            "mode" mode
                            "fMin" f-min
                            "fMax" f-max
                            "floorDb" floor-db
                            "binWidth" bin-width
                            "hop" hop
                            "frame" frame
                            "secondsPerFrame" seconds-per-frame
                            "dropped" dropped
                            "warnings" (coerce warnings 'vector)
                            "frames" (coerce (mapcar (lambda (f) (coerce f 'vector))
                                                     frames)
                                             'vector)))))
           (send-response id
             (make-jobj "available" :false
                        "error" (if (and (consp value) (eq (first value) :error))
                                    (or (second value) "Spectrogram not available.")
                                    (format nil "~A" value))
                        "warnings" (vector)
                        "frames" (vector))))))))

(defun handle-buffer-outline (id params)
  "clamps/bufferOutline — waveform outline of a buffer.

The reduction happens in the image, for the same reason as the FFT: an
eight-minute recording is twenty million samples and a display is eight
hundred pixels wide. What is transferred is three numbers per drawn
column — minimum, maximum and RMS — and that is independent of how long
the buffer is."
  (let ((expr (or (gethash "expr" params) ""))
        (pkg (or (gethash "package" params) "COMMON-LISP-USER"))
        (start (or (gethash "start" params) 0))
        (end (or (gethash "end" params) -1))
        (columns (or (gethash "columns" params) 512))
        (channel (or (gethash "channel" params) 0)))
    (swank-rex
     (format nil "(clamps-bridge-rpc:buffer-outline-for-repl ~S ~S ~D ~D ~D ~D)"
             expr pkg (truncate start) (truncate end) (truncate columns)
             (truncate channel))
     :callback
     (lambda (status value)
       (if (and (eq status :ok) (consp value) (eq (first value) :ok)
                (= (length value) 3))
           (destructuring-bind (ok header columns*) value
             (declare (ignore ok))
             (destructuring-bind (frames channels rate duration start end
                                  column-count channel peak rms clipped warnings)
                 header
               (send-response id
                 (make-jobj "available" :true
                            "error" ""
                            "frames" frames
                            "channels" channels
                            "sampleRate" rate
                            "duration" duration
                            "start" start
                            "end" end
                            "columns" column-count
                            "channel" channel
                            "peak" peak
                            "rms" rms
                            "clipped" clipped
                            "warnings" (coerce warnings 'vector)
                            "values" (coerce (mapcar (lambda (c) (coerce c 'vector))
                                                     columns*)
                                             'vector)))))
           (send-response id
             (make-jobj "available" :false
                        "error" (if (and (consp value) (eq (first value) :error))
                                    (or (second value) "Buffer not readable.")
                                    (format nil "~A" value))
                        "warnings" (vector)
                        "values" (vector))))))))

(defun handle-ats-outline (id params)
  "clamps/atsOutline — partial trajectories of an ATS file.

One request per file, not a cycle: an analysis on disk does not change
while it is being looked at. The reduction still happens in the image,
because a file with a thousand partials over ten thousand frames is
twenty million doubles and the display has a few hundred columns."
  (let ((path (or (gethash "path" params) ""))
        (columns (or (gethash "columns" params) 400))
        (max-partials (or (gethash "maxPartials" params) 128))
        (floor-db (or (gethash "floorDb" params) -96.0)))
    (swank-rex
     (format nil "(clamps-bridge-rpc:ats-outline-for-repl ~S ~D ~D ~F)"
             path (truncate columns) (truncate max-partials)
             (float floor-db 1.0d0))
     :callback
     (lambda (status value)
       (if (and (eq status :ok) (consp value) (eq (first value) :ok)
                (= (length value) 4))
           (destructuring-bind (ok header partials noise) value
             (declare (ignore ok))
             (destructuring-bind (sample-rate frame-size window-size partial-count
                                  frame-count max-amplitude max-frequency duration
                                  type columns shown has-phase has-noise warnings)
                 header
               (send-response id
                 (make-jobj "available" :true
                            "error" ""
                            "sampleRate" sample-rate
                            "frameSize" frame-size
                            "windowSize" window-size
                            "partialCount" partial-count
                            "frameCount" frame-count
                            "maxAmplitude" max-amplitude
                            "maxFrequency" max-frequency
                            "duration" duration
                            "type" type
                            "columns" columns
                            "shown" shown
                            "hasPhase" has-phase
                            "hasNoise" has-noise
                            "warnings" (coerce warnings 'vector)
                            "partials"
                            (coerce (mapcar
                                     (lambda (p)
                                       (make-jobj "index" (first p)
                                                  "peak" (second p)
                                                  "meanFrequency" (third p)
                                                  "frequencies" (coerce (fourth p) 'vector)
                                                  "levels" (coerce (fifth p) 'vector)))
                                     partials)
                                    'vector)
                            "noise"
                            (coerce (mapcar (lambda (b) (coerce b 'vector)) noise)
                                    'vector)))))
           (send-response id
             (make-jobj "available" :false
                        "error" (if (and (consp value) (eq (first value) :error))
                                    (or (second value) "ATS file not readable.")
                                    (format nil "~A" value))
                        "warnings" (vector)
                        "partials" (vector)
                        "noise" (vector))))))))

(defun handle-ats-play (id params)
  "clamps/atsPlay — hands an ATS file to the image's resynthesis.

The extension does not synthesise; it finds what the image already has.
See ats-play-for-repl for why."
  (let ((path (or (gethash "path" params) ""))
        (amplitude (or (gethash "amplitude" params) 1.0)))
    (swank-rex
     (format nil "(clamps-bridge-rpc:ats-play-for-repl ~S ~F)"
             path (float amplitude 1.0d0))
     :callback
     (lambda (status value)
       (send-response id
         (if (and (eq status :ok) (consp value) (eq (first value) :ok))
             (make-jobj "ok" :true "message" (or (second value) ""))
             (make-jobj "ok" :false
                        "message" (if (consp value)
                                      (or (second value) "Playback failed.")
                                      (format nil "~A" value)))))))))

(defun handle-ats-stop (id params)
  "clamps/atsStop — stops the playback."
  (declare (ignore params))
  (swank-rex
   "(clamps-bridge-rpc:ats-stop-for-repl)"
   :callback
   (lambda (status value)
     (send-response id
       (if (and (eq status :ok) (consp value) (eq (first value) :ok))
           (make-jobj "ok" :true "message" (or (second value) ""))
           (make-jobj "ok" :false
                      "message" (if (consp value)
                                    (or (second value) "Stopping failed.")
                                    (format nil "~A" value))))))))

(defun handle-repl-complete (id params)
  "clamps/replComplete — completion for the REPL terminal.

   The terminal has no document buffer from which prefix, package and
   context could be derived; it sends all three itself.  The source is
   deliberately the same as for the editor completion, so that the
   suggestions do not drift apart: the same fuzzy scoring, the same
   ranking, the same &key parameters of the enclosing form.  The order of
   the list IS the result — unlike in the editor there is no sortText here
   that could re-sort anything."
  (let ((prefix (or (gethash "prefix" params) ""))
        (pkg (or (gethash "package" params) "COMMON-LISP-USER"))
        (context (or (gethash "context" params) "")))
    (swank-rex
     (format nil "(clamps-bridge-rpc:completions-for-repl ~S ~S ~S)"
             prefix pkg context)
     :callback
     (lambda (status value)
       (if (and (eq status :ok) (consp value) (eq (first value) :ok)
                (= (length value) 3))
           (destructuring-bind (ok truncated items) value
             (declare (ignore ok))
             (send-response id
               (make-jobj
                "truncated" (if truncated :true :false)
                "items"
                (coerce
                 (mapcar (lambda (it)
                           (make-jobj "label" (or (first it) "")
                                      "detail" (or (third it) "")))
                         items)
                 'vector))))
           (send-response id (make-jobj "truncated" :false "items" (vector))))))))

(defun handle-apropos (id params)
  (handle-tool-result id
    (format nil "(clamps-bridge-rpc:apropos-for-repl ~S ~S ~A)"
            (or (gethash "query" params) "")
            (or (gethash "package" params) "COMMON-LISP-USER")
            (if (gethash "allPackages" params) "t" "nil"))))

(defun handle-break-on-signals (id params)
  (let* ((raw (gethash "conditions" params))
         (conditions (if (vectorp raw) (coerce raw 'list) nil))
         (form (format nil "(clamps-bridge-rpc:break-on-signals-for-repl '~S)" conditions)))
    (swank-rex form :callback
      (lambda (status value)
        (if (and (eq status :ok) (consp value))
            (let ((ok (eq (first value) :ok)) (payload (second value)))
              (send-response id
                (make-jobj "available" (if ok :true :false)
                           "error" (if ok "" (or payload "Not available."))
                           "conditions" (if ok (coerce (or payload nil) 'vector) (vector)))))
            (send-response id (make-jobj "available" :false "error" (format nil "~A" value) "conditions" (vector))))))))

(defun handle-request (msg)
  (let ((method (gethash "method" msg))
        (id (gethash "id" msg))
        (params (gethash "params" msg)))
    (handler-case
        (cond
          ((string= method "initialize") (handle-initialize id))
          ((string= method "shutdown") (send-response id :null))
          ((string= method "exit") (finish-output) (sb-ext:exit :code 0))
          ((string= method "textDocument/didOpen") (handle-did-open params))
          ((string= method "textDocument/didChange") (handle-did-change params))
          ((string= method "textDocument/hover") (handle-hover id params))
          ((string= method "textDocument/completion") (handle-completion id params))
          ((string= method "textDocument/signatureHelp") (handle-signature-help id params))
          ((string= method "textDocument/definition") (handle-definition id params))
          ((string= method "textDocument/references") (handle-references id params))
          ((string= method "clamps/eval") (handle-eval id params))
          ((string= method "clamps/indentationRules") (handle-indentation-rules id params))
          ((string= method "clamps/asdfOperation") (handle-asdf-operation id params))
          ((string= method "clamps/stickers") (handle-stickers id params))
          ((string= method "clamps/stickersClear") (handle-stickers-clear id params))
          ((string= method "clamps/macroexpand") (handle-macroexpand id params))
          ((string= method "clamps/disassemble") (handle-disassemble id params))
          ((string= method "clamps/inspect") (handle-inspect id params))
          ((string= method "clamps/inspectPart") (handle-inspect-part id params))
          ((string= method "clamps/inspectRefresh") (handle-inspect-refresh id params))
          ((string= method "clamps/inspectSet") (handle-inspect-set id params))
          ((string= method "clamps/inspectRelease") (handle-inspect-release id params))
          ((string= method "clamps/rtStatus") (handle-rt-status id params))
          ((string= method "clamps/incudineNodes") (handle-incudine-nodes id params))
          ((string= method "clamps/packages") (handle-packages id params))
          ((string= method "clamps/classes") (handle-classes id params))
          ((string= method "clamps/threads") (handle-threads-browser id params))
          ((string= method "clamps/traced") (handle-traced-browser id params))
          ((string= method "clamps/untraceOne") (handle-untrace-one id params))
          ((string= method "clamps/compilerNotes") (handle-compiler-notes id params))
          ((string= method "clamps/toggleTrace") (handle-trace-toggle id params))
          ((string= method "clamps/untraceAll") (handle-untrace-all id params))
          ((string= method "clamps/xref") (handle-xref id params))
          ((string= method "clamps/apropos") (handle-apropos id params))
          ((string= method "clamps/replComplete") (handle-repl-complete id params))
          ((string= method "clamps/stickerSamples") (handle-sticker-samples id params))
          ((string= method "clamps/stickerKeys") (handle-sticker-keys id params))
          ((string= method "clamps/stickerSpectrum") (handle-sticker-spectrum id params))
          ((string= method "clamps/stickerSpectrogram") (handle-sticker-spectrogram id params))
          ((string= method "clamps/bufferOutline") (handle-buffer-outline id params))
          ((string= method "clamps/atsOutline") (handle-ats-outline id params))
          ((string= method "clamps/atsPlay") (handle-ats-play id params))
          ((string= method "clamps/atsStop") (handle-ats-stop id params))
          ((string= method "clamps/breakOnSignals") (handle-break-on-signals id params))
          (id (send-error id -32601 (format nil "Not implemented: ~A" method)))
          (t (log-msg "Unbehandelte Notification: ~A" method)))
      (error (e)
        (log-msg "Error while handling ~A: ~A" method e)
        (when id (send-error id -32603 (format nil "Internal error: ~A" e)))))))

;;; ---------------------------------------------------------------------
;;; Read/await the session file (written by bootstrap.lisp)
;;; ---------------------------------------------------------------------

(defun read-stream-to-string (stream)
  (with-output-to-string (out)
    (loop for line = (read-line stream nil nil) while line do (write-line line out))))

(defun wait-for-ready (session-file &optional (timeout-seconds 60))
  (let ((start (get-universal-time)))
    (loop
      (let ((info (ignore-errors
                    (with-open-file (s session-file :direction :input)
                      (json-read (read-stream-to-string s))))))
        (when (and info (equal (gethash "status" info) "ready"))
          (return-from wait-for-ready info))
        (when (and info (equal (gethash "status" info) "error"))
          (error "The CLAMPS bootstrap reports an error: ~A" (gethash "detail" info))))
      (when (> (- (get-universal-time) start) timeout-seconds)
        (error "Timeout: session in ~A not ready after ~As" session-file timeout-seconds))
      (sleep 0.3))))

;;; ---------------------------------------------------------------------
;;; Einstiegspunkt
;;; ---------------------------------------------------------------------

(defun main ()
  ;; Create stdout explicitly as a UTF-8 stream, so that the bytes
  ;; actually written match exactly the byte Content-Length computed in
  ;; write-lsp-message. Otherwise the encoding follows the locale and can
  ;; differ -> truncated messages, JSON parse errors at the client.
  (setf sb-impl::*default-external-format* :utf-8)
  (ignore-errors
    (setf *standard-output*
          (sb-sys:make-fd-stream 1 :output t :external-format :utf-8
                                   :buffering :full)))
  (let* ((session-dir-str (or (sb-ext:posix-getenv "CLAMPS_SESSION_DIR")
                               (error "CLAMPS_SESSION_DIR is not set")))
         ;; Force a trailing slash, otherwise merge-pathnames treats the
         ;; last path component as a file name rather than a directory.
         (session-dir (pathname (concatenate 'string session-dir-str "/")))
         (session-file (merge-pathnames "session.json" session-dir)))
    (init-logging session-dir)
    (log-msg "Bridge server starting, waiting for ~A" session-file)
    (let* ((info (wait-for-ready session-file))
           (port (gethash "port" info)))
      (log-msg "Session ready, connecting to Swank on port ~A" port)
      (setf *swank-stream* (connect-swank "127.0.0.1" port))
      (bt:make-thread #'swank-reader-loop :name "swank-reader")
      (log-msg "Connected. Starting the LSP loop on stdio.")
      ;; Our own BIVALENT stream on file descriptor 0: the headers are
      ;; text (read-line), the body is read as bytes and decoded by us,
      ;; because Content-Length counts bytes. A purely character-oriented
      ;; stream cannot do that.
      (let ((in (sb-sys:make-fd-stream 0
                                       :input t
                                       :element-type :default
                                       :external-format :utf-8)))
        (loop
          (let ((msg (read-lsp-message in)))
            (unless msg
              (log-msg "Input stream ended or message unreadable — exiting.")
              (return))
            (handle-request msg)))))))

(handler-case (main)
  (error (e)
    (log-msg "Fatal error: ~A" e)
    (sb-ext:exit :code 1)))
