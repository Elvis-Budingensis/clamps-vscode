;;;; framingtest.lisp — a regression test for the LSP framing.
;;;;
;;;; Run: sbcl --script lisp/framingtest.lisp
;;;;
;;;; The occasion: Content-Length counts BYTES in UTF-8.
;;;; read-lsp-message created a string of that length and read that many
;;;; CHARACTERS. As soon as a message contained umlauts — the didOpen for
;;;; a file with German comments, say — reading ran past the end of the
;;;; message into the following one. After that the stream was out of
;;;; step, the next header unreadable, and the main loop ended: the bridge
;;;; process exited with code 0.
;;;;
;;;; This test therefore checks TWO messages in a row. With only one the
;;;; bug would have stayed invisible — the first message appears to arrive
;;;; intact despite the overreading.
;;;;
;;;; The test runs against a real file, not against a string stream:
;;;; bivalent streams (characters AND bytes) exist in ANSI CL only for
;;;; files, and that very bivalence is the heart of the matter here.

(require :sb-posix)

(defpackage :framingtest (:use :cl))
(in-package :framingtest)

(defvar *failed* 0)

(defun check (name actual expected)
  (unless (equal actual expected)
    (incf *failed*)
    (format t "~&FAILED ~A~%  expected: ~S~%  got:      ~S~%" name expected actual)))

;;; --- Load bridge-server.lisp partially --------------------------------
;;;
;;; The file needs Quicklisp and Bordeaux-Threads, which are missing here.
;;; Create replacement packages and evaluate only the definition forms:
;;; the bodies do not run, so missing foreign functions do not get in the
;;; way. That way the REAL read-lsp-message is checked and not a copy.

(defun token-chars-p (c)
  (or (alphanumericp c) (find c "+-*/=<>!?%&$_.")))

(defun collect-qualified-symbols (text)
  "Collects every PACKAGE:SYMBOL and PACKAGE::SYMBOL from TEXT.

Instead of guessing the foreign packages, they are read from the file.
New dependencies in bridge-server.lisp therefore do not break the test —
otherwise the test would be broken exactly when it is needed most."
  (let ((pairs '()) (i 0) (n (length text)))
    (loop while (< i n) do
      (let ((c (char text i)))
        (cond
          ((char= c #\;)
           (loop while (and (< i n) (char/= (char text i) #\Newline)) do (incf i)))
          ((and (char= c #\#) (< (1+ i) n) (char= (char text (1+ i)) #\\))
           (incf i 3))
          ((token-chars-p c)
           (let ((start i))
             (loop while (and (< i n) (token-chars-p (char text i))) do (incf i))
             (let ((name (subseq text start i)))
               ;; Exactly one or two colons, then characters again
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
    "KEYWORD" "FRAMINGTEST")
  "Packages that really exist in a bare SBCL — do not replace them.")

(defun ensure-stubs (text)
  "Creates a replacement package for every foreign PACKAGE:SYMBOL and
exports the symbol, so that the reader can read the file at all."
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
            (unless (eq status :external)
              (export (intern sym-name p) p))))))))

(defun load-definitions (path)
  "Evaluates from PATH only the forms that define something.

The bodies do not run in the process, so missing foreign functions do not
get in the way. That way the REAL read-lsp-message is checked and not a
copy."
  (let ((text (with-open-file (in path :external-format :utf-8)
                (let ((s (make-string (file-length in))))
                  (subseq s 0 (read-sequence s in))))))
    (ensure-stubs text)
    ;; with-lock-held is a macro: without a definition the compiler would
    ;; read it as a function call. Irrelevant for the functions checked
    ;; here, but it avoids noise.
    (let ((wlh (find-symbol "WITH-LOCK-HELD" (or (find-package "BORDEAUX-THREADS")
                                                 (find-package "FRAMINGTEST")))))
      (when (and wlh (not (macro-function wlh)))
        (eval `(defmacro ,wlh ((&rest ignored) &body body)
                 (declare (ignore ignored))
                 `(progn ,@body)))))
    (let ((count 0))
      (with-input-from-string (in text)
        (let ((*package* (find-package :framingtest)))
          (handler-bind ((warning #'muffle-warning))
            (loop for form = (read in nil :eof)
                  until (eq form :eof)
                  do (when (and (consp form)
                                (symbolp (first form))
                                (member (symbol-name (first form))
                                        '("DEFUN" "DEFVAR" "DEFPARAMETER"
                                          "DEFMACRO" "DEFCONSTANT")
                                        :test #'string=))
                       (handler-case (progn (eval form) (incf count))
                         (error () nil)))))))
      count)))

;;; --- Hilfsmittel -----------------------------------------------------

(defun lsp-frame (body-string)
  "Builds an LSP message with the CORRECT byte length."
  (let ((bytes (sb-ext:string-to-octets body-string :external-format :utf-8)))
    (values (format nil "Content-Length: ~D~C~C~C~C"
                    (length bytes) #\Return #\Newline #\Return #\Newline)
            bytes)))

(defun write-frames (path bodies)
  "Writes several messages into a file byte for byte."
  (with-open-file (out path :direction :output :element-type '(unsigned-byte 8)
                            :if-exists :supersede :if-does-not-exist :create)
    (dolist (b bodies)
      (multiple-value-bind (header bytes) (lsp-frame b)
        (write-sequence (sb-ext:string-to-octets header :external-format :utf-8) out)
        (write-sequence bytes out)))))

(defun read-frames (path n)
  "Reads N messages with the real read-lsp-message."
  (with-open-file (in path :element-type :default :external-format :utf-8)
    (loop repeat n collect (funcall (intern "READ-LSP-MESSAGE" :framingtest) in))))

;;; --- Test ------------------------------------------------------------

(let* ((here (directory-namestring *load-truename*))
       (bridge (merge-pathnames "bridge-server.lisp" here))
       (tmp (merge-pathnames "framingtest.tmp" #p"/tmp/")))
  (let ((n (load-definitions bridge)))
    (format t "~&~D definitions from bridge-server.lisp evaluated.~%" n)
    (when (< n 20)
      (incf *failed*)
      (format t "~&FAILED: too few definitions — the test checks nothing.~%")))

  (unless (fboundp (intern "READ-LSP-MESSAGE" :framingtest))
    (format t "~&FAILED: read-lsp-message was not defined.~%")
    (sb-ext:exit :code 1))

  ;; 1. Pure ASCII: must always work, even with the old bug.
  (write-frames tmp (list "{\"method\":\"eins\"}" "{\"method\":\"zwei\"}"))
  (let ((msgs (read-frames tmp 2)))
    (check "ASCII: erste Nachricht" (gethash "method" (first msgs)) "eins")
    (check "ASCII: zweite Nachricht" (gethash "method" (second msgs)) "zwei"))

  ;; 2. The actual case: umlauts in the FIRST message. Bytes >
  ;;    characters, so the old version read into the second one.
  (write-frames tmp (list "{\"text\":\"f\u00fcr \u00fcbersprungen \u2014 g\u00fcltig\"}"
                          "{\"method\":\"danach\"}"))
  (let ((msgs (read-frames tmp 2)))
    (check "Umlaute: erste Nachricht"
           (gethash "text" (first msgs)) "f\u00fcr \u00fcbersprungen \u2014 g\u00fcltig")
    ;; This is the line that would have found the bug: NIL before.
    (check "umlauts: the second message still arrives"
           (and (second msgs) (gethash "method" (second msgs))) "danach"))

  ;; 3. A realistic amount: as much non-ASCII as in rpc.lisp (a
  ;;    difference of 305 bytes), followed by a further message.
  (let ((big (with-output-to-string (s)
               (write-string "{\"text\":\"" s)
               (dotimes (i 200) (write-string "üöä—" s))
               (write-string "\"}" s))))
    (write-frames tmp (list big "{\"method\":\"letzte\"}"))
    (let ((msgs (read-frames tmp 2)))
      (check "grosse Nachricht gelesen"
             (and (first msgs) (> (length (gethash "text" (first msgs))) 700)) t)
      (check "Strom bleibt synchron"
             (and (second msgs) (gethash "method" (second msgs))) "letzte")))

  ;; 4. A truncated message: NIL, but without an error.
  (with-open-file (out tmp :direction :output :element-type '(unsigned-byte 8)
                           :if-exists :supersede)
    (write-sequence (sb-ext:string-to-octets
                     (format nil "Content-Length: 500~C~C~C~C{\"a\":1}"
                             #\Return #\Newline #\Return #\Newline)
                     :external-format :utf-8)
                    out))
  (check "abgeschnitten ergibt NIL" (first (read-frames tmp 1)) nil)

  ;; 5. Autodoc context. The occasion: bridge-server.lisp contained
  ;;    (find ch " \t\r\n") — in Common Lisp these escapes do not exist
  ;;    inside strings, so the character set was " trn". With that, every
  ;;    operator name broke off at a t, an r or an n: "concatenate" became
  ;;    "co", "list" became "lis". Signature help then showed nothing.
  (let ((ctx (intern "CALL-CONTEXT-BEFORE-POINT" :framingtest)))
    (if (not (fboundp ctx))
        (progn (incf *failed*)
               (format t "~&FAILED: call-context-before-point is missing.~%"))
        (flet ((op (text) (first (funcall ctx text 0 (length text)))))
          (check "Autodoc: einfacher Operator" (op "(mapcar #'car x") "mapcar")
          (check "autodoc: a name with t/r/n stays intact"
                 (op "(concatenate 'string ") "concatenate")
          (check "Autodoc: Tabulator trennt"
                 (op (format nil "(list~Ca" #\Tab)) "list")
          (check "Autodoc: Zeilenumbruch trennt"
                 (op (format nil "(print~C  x" #\Newline)) "print")
          (check "Autodoc: innerste Form gewinnt"
                 (op "(mapcar (truncate ") "truncate")
          (check "autodoc: a paren inside a string does not count"
                 (op "(format nil \"(nicht \" ") "format")
          (check "autodoc: a paren as a character literal does not count"
                 (op "(find ch #\\( ") "find")
          (check "autodoc: NIL without an open form" (op "abc ") nil)
          ;; The active parameter: a space is a trigger, so exactly there
          ;; the NEXT argument has to be marked.
          (flet ((active (text) (second (funcall ctx text 0 (length text)))))
            (check "active: directly after the operator" (active "(mapcar ") 0)
            (check "active: first argument being typed" (active "(mapcar #'c") 0)
            (check "active: after the first argument" (active "(mapcar #'car ") 1)
            (check "active: second argument being typed" (active "(mapcar #'car ls") 1)
            (check "active: after the second argument" (active "(mapcar #'car ls ") 2)
            (check "active: after a closed subform" (active "(mapcar (car x) ") 1)))))

  (ignore-errors (delete-file tmp))
  (if (zerop *failed*)
      (format t "~&ok — the LSP framing counts bytes, the stream stays in step.~%")
      (format t "~&~D failure(s).~%" *failed*))
  (sb-ext:exit :code (if (zerop *failed*) 0 1)))
