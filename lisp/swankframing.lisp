;;;; swankframing.lisp — a regression test for the Swank framing.
;;;;
;;;; Run: sbcl --script lisp/swankframing.lisp
;;;;
;;;; The occasion: the six-digit hex header of the Swank protocol counts
;;;; the BYTES of the UTF-8 encoding. send-swank-text wrote (length text)
;;;; — the CHARACTER count — and read-swank-message read (make-string len)
;;;; plus read-sequence, that is, as many CHARACTERS as the announced
;;;; number of bytes. On pure ASCII the two happen to agree. As soon as an
;;;; umlaut, an em dash or a ° sat in the payload — a German docstring
;;;; from autodoc/describe-symbol, a completion context from a file with
;;;; German comments — the stream was out of step. The next header was
;;;; unreadable, swank-reader-loop ended, and from then on NO callback
;;;; from *pending-requests* fired any more: definition, completion,
;;;; signature help and hover simply never answered.
;;;;
;;;; This test therefore checks TWO messages in a row and both directions.
;;;; With only one message the bug would be invisible — the first appears
;;;; to arrive intact despite the overreading.
;;;;
;;;; The test runs against a real file with a byte element type, because
;;;; the element type of the stream was precisely the heart of the bug.

(require :sb-posix)

(defpackage :swankframing (:use :cl))
(in-package :swankframing)

(defvar *failed* 0)

(defun check (name actual expected)
  (if (equal actual expected)
      (format t "~&  ok  ~A~%" name)
      (progn
        (incf *failed*)
        (format t "~&FAILED ~A~%  expected: ~S~%  got:      ~S~%" name expected actual))))

;;; --- Load bridge-server.lisp partially (as in framingtest.lisp) ------

(defun token-chars-p (c) (or (alphanumericp c) (find c "+-*/=<>!?%&$_.")))

(defun collect-qualified-symbols (text)
  (let ((pairs '()) (i 0) (n (length text)))
    (loop while (< i n) do
      (let ((c (char text i)))
        (cond
          ((char= c #\;)
           (loop while (and (< i n) (char/= (char text i) #\Newline)) do (incf i)))
          ((and (char= c #\#) (< (1+ i) n) (char= (char text (1+ i)) #\\)) (incf i 3))
          ((token-chars-p c)
           (let ((start i))
             (loop while (and (< i n) (token-chars-p (char text i))) do (incf i))
             (let ((name (subseq text start i)))
               (when (and (< i n) (char= (char text i) #\:))
                 (let ((colons (if (and (< (1+ i) n) (char= (char text (1+ i)) #\:)) 2 1)))
                   (incf i colons)
                   (let ((s2 i))
                     (loop while (and (< i n) (token-chars-p (char text i))) do (incf i))
                     (when (> i s2)
                       (push (cons (string-upcase name)
                                   (string-upcase (subseq text s2 i)))
                             pairs))))))))
          (t (incf i)))))
    (remove-duplicates pairs :test #'equal)))

(defparameter *known-packages*
  '("CL" "COMMON-LISP" "SB-EXT" "SB-SYS" "SB-INT" "SB-POSIX" "SB-THREAD"
    "SB-KERNEL" "SB-MOP" "SB-DEBUG" "SB-IMPL" "SB-UNIX" "SB-BSD-SOCKETS"
    "KEYWORD" "SWANKFRAMING"))

(defun ensure-stubs (text)
  (dolist (pair (collect-qualified-symbols text))
    (let ((pkg-name (car pair)) (sym-name (cdr pair)))
      (unless (member pkg-name *known-packages* :test #'string=)
        (let ((p (or (find-package pkg-name)
                     (make-package pkg-name
                                   :nicknames (when (string= pkg-name "BORDEAUX-THREADS")
                                                '("BT"))
                                   :use '()))))
          (multiple-value-bind (sym status) (find-symbol sym-name p)
            (declare (ignore sym))
            (unless (eq status :external) (export (intern sym-name p) p))))))))

(defun load-definitions (path)
  (let ((text (with-open-file (in path :external-format :utf-8)
                (let ((s (make-string (file-length in))))
                  (subseq s 0 (read-sequence s in))))))
    (ensure-stubs text)
    ;; The file writes bt:with-lock-held, so the replacement package is
    ;; called "BT" — not "BORDEAUX-THREADS". Without this stub,
    ;; with-lock-held would be read as a function call and (*swank-lock*)
    ;; called as a function.
    (let ((wlh (or (find-symbol "WITH-LOCK-HELD" (or (find-package "BT")
                                                     (find-package "SWANKFRAMING")))
                   (find-symbol "WITH-LOCK-HELD" (or (find-package "BORDEAUX-THREADS")
                                                     (find-package "SWANKFRAMING"))))))
      (when (and wlh (not (macro-function wlh)))
        (eval `(defmacro ,wlh ((&rest ignored) &body body)
                 (declare (ignore ignored))
                 `(progn ,@body)))))
    (let ((count 0))
      (with-input-from-string (in text)
        (let ((*package* (find-package :swankframing)))
          (handler-bind ((warning #'muffle-warning))
            (loop for form = (read in nil :eof)
                  until (eq form :eof)
                  do (when (and (consp form) (symbolp (first form))
                                (member (symbol-name (first form))
                                        '("DEFUN" "DEFVAR" "DEFPARAMETER"
                                          "DEFMACRO" "DEFCONSTANT")
                                        :test #'string=))
                       (handler-case (progn (eval form) (incf count))
                         (error () nil)))))))
      count)))

(format t "~&~D definitions from bridge-server.lisp evaluated.~%"
        (load-definitions "lisp/bridge-server.lisp"))

;;; --- Payloads with non-ASCII ------------------------------------------
;;; Exactly the sort that really occurs in operation: a German docstring
;;; as an answer, a completion context with umlauts as a request.

(defparameter *payload-1*
  "(:return (:ok (\"(rt-start &key gültig)\" (\"größe\" \"höhe\") \"Startet den Realtime-Server — prüft Übersteuerung.\")) 7)")

(defparameter *payload-2*
  "(:return (:ok (\"zweite Nachricht: ÄÖÜ ß — °C\")) 8)")

(defun safe-read (stream)
  "read-swank-message must not blow through in the test. With the stream
out of step the next header is junk and parse-integer throws — and a gate
that aborts with a backtrace says less than one that names the failure.
Hence catch it here and return :desync."
  (handler-case (read-swank-message stream)
    (error (e) (declare (ignore e)) :desync)))

(defun req-id (msg)
  "The request ID of a Swank answer, or NIL rather than a crash. Without
this, with the stream out of step it was not the check that failed but
(third :desync) — and the backtrace obscured the remaining messages."
  (and (consp msg) (third msg)))

(defun swank-frame-bytes (text)
  "Builds a Swank message with the CORRECT byte length."
  (let ((body (sb-ext:string-to-octets text :external-format :utf-8)))
    (concatenate '(vector (unsigned-byte 8))
                 (sb-ext:string-to-octets (format nil "~6,'0X" (length body))
                                          :external-format :utf-8)
                 body)))

;;; --- Test 1: Leseseite, zwei Nachrichten hintereinander --------------

(let ((path "/tmp/swankframing-in.bin"))
  (with-open-file (out path :direction :output :element-type '(unsigned-byte 8)
                            :if-exists :supersede :if-does-not-exist :create)
    (write-sequence (swank-frame-bytes *payload-1*) out)
    (write-sequence (swank-frame-bytes *payload-2*) out))
  (with-open-file (in path :element-type '(unsigned-byte 8))
    (let ((m1 (safe-read in))
          (m2 (safe-read in)))
      ;; The first message appears to arrive intact even with the old bug
      ;; — only out of step. The SECOND one exposes it.
      (check "reading: the first message is a :return form"
             (and (consp m1) (first m1)) :return)
      (check "reading: the second message is intact (stream in step)"
             (and (consp m2) (first m2)) :return)
      (check "reading: umlauts decoded correctly"
             (and (consp m2) (search "°C" (format nil "~S" m2)) t)
             t)
      (check "reading: the second message is not :unreadable"
             (eq m2 :unreadable) nil)
      (check "reading: the stream is in step (no :desync)"
             (eq m2 :desync) nil)
      (check "reading: the request ID of the second message"
             (req-id m2) 8))))

;;; --- Test 2: the writing side, the header counts bytes ----------------

(let* ((path "/tmp/swankframing-out.bin")
       (text "(:emacs-rex (clamps-bridge-rpc:completions-for-repl \"grö\" \"CL-USER\" \";; Prüft Übersteuerung\") \"CL-USER\" t 1)"))
  (with-open-file (out path :direction :output :element-type '(unsigned-byte 8)
                            :if-exists :supersede :if-does-not-exist :create)
    (let ((*swank-stream* out))
      (send-swank-text text)))
  (with-open-file (in path :element-type '(unsigned-byte 8))
    (let ((header (make-array 6 :element-type '(unsigned-byte 8))))
      (read-sequence header in)
      (let ((announced (parse-integer (sb-ext:octets-to-string
                                       header :external-format :utf-8)
                                      :radix 16))
            (actual (- (with-open-file (f path :element-type '(unsigned-byte 8))
                         (file-length f))
                       6)))
        (check "writing: the header counts bytes, not characters" announced actual)
        (check "writing: bytes > characters with umlauts (the test really bites)"
               (> announced (length text)) t)))))

;;; --- Test 3: a round trip over the real functions ---------------------

(let ((path "/tmp/swankframing-rt.bin")
      (text *payload-1*))
  (with-open-file (out path :direction :output :element-type '(unsigned-byte 8)
                            :if-exists :supersede :if-does-not-exist :create)
    (let ((*swank-stream* out))
      (send-swank-text text)
      (send-swank-text *payload-2*)))
  (with-open-file (in path :element-type '(unsigned-byte 8))
    (let ((m1 (safe-read in))
          (m2 (safe-read in)))
      (check "round trip: the first message" (req-id m1) 7)
      (check "round trip: the second message" (req-id m2) 8))))

(if (> *failed* 0)
    (progn (format t "~&~D Test(s) fehlgeschlagen.~%" *failed*)
           (sb-ext:exit :code 1))
    (format t "~&ok — the Swank framing counts bytes, the stream stays in step.~%"))
