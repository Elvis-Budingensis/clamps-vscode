;;;; swankframing.lisp — Regressionstest für die Swank-Rahmung.
;;;;
;;;; Aufruf: sbcl --script lisp/swankframing.lisp
;;;;
;;;; Der Anlass: der 6-stellige Hex-Header des Swank-Protokolls zählt
;;;; BYTES der UTF-8-Kodierung. send-swank-text schrieb (length text) —
;;;; die ZEICHENzahl — und read-swank-message las (make-string len) plus
;;;; read-sequence, also so viele ZEICHEN, wie Bytes angekündigt waren.
;;;; Auf reinem ASCII stimmt beides zufällig überein. Sobald ein Umlaut,
;;;; ein Gedankenstrich oder ein ° im Payload steckte — eine deutsche
;;;; Docstring aus autodoc/describe-symbol, ein Completion-Kontext aus
;;;; einer Datei mit deutschen Kommentaren — war der Strom verschoben.
;;;; Der nächste Header war unlesbar, swank-reader-loop endete, und ab da
;;;; feuerte KEIN Callback aus *pending-requests* mehr: Definition,
;;;; Completion, Signature Help und Hover antworteten schlicht nie.
;;;;
;;;; Deshalb prüft dieser Test ZWEI Nachrichten hintereinander und beide
;;;; Richtungen. Mit nur einer Nachricht wäre der Fehler unsichtbar — die
;;;; erste kommt trotz Überlesen scheinbar heil an.
;;;;
;;;; Getestet wird gegen eine echte Datei mit Byte-Element-Typ, weil
;;;; genau der Element-Typ des Stroms der Kern des Fehlers war.

(require :sb-posix)

(defpackage :swankframing (:use :cl))
(in-package :swankframing)

(defvar *failed* 0)

(defun check (name actual expected)
  (if (equal actual expected)
      (format t "~&  ok  ~A~%" name)
      (progn
        (incf *failed*)
        (format t "~&FEHLER ~A~%  erwartet: ~S~%  bekommen: ~S~%" name expected actual))))

;;; --- bridge-server.lisp teilweise laden (wie framingtest.lisp) -------

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
    ;; Die Datei schreibt bt:with-lock-held, das Ersatzpaket heisst also
    ;; "BT" — nicht "BORDEAUX-THREADS". Ohne diesen Stub wuerde
    ;; with-lock-held als Funktionsaufruf gelesen und (*swank-lock*)
    ;; als Funktion aufgerufen.
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

(format t "~&~D Definitionen aus bridge-server.lisp ausgewertet.~%"
        (load-definitions "lisp/bridge-server.lisp"))

;;; --- Nutzlasten mit Nicht-ASCII --------------------------------------
;;; Genau die Sorte, die im Betrieb wirklich vorkommt: eine deutsche
;;; Docstring als Antwort, ein Completion-Kontext mit Umlauten als Anfrage.

(defparameter *payload-1*
  "(:return (:ok (\"(rt-start &key gültig)\" (\"größe\" \"höhe\") \"Startet den Realtime-Server — prüft Übersteuerung.\")) 7)")

(defparameter *payload-2*
  "(:return (:ok (\"zweite Nachricht: ÄÖÜ ß — °C\")) 8)")

(defun safe-read (stream)
  "read-swank-message darf im Test nicht durchschlagen. Bei verschobenem
Strom ist der naechste Header Muell, parse-integer fliegt — und ein Gate,
das mit Backtrace abbricht, sagt weniger als eines, das den Fehler
benennt. Deshalb hier abfangen und :desync zurueckgeben."
  (handler-case (read-swank-message stream)
    (error (e) (declare (ignore e)) :desync)))

(defun req-id (msg)
  "Request-ID einer Swank-Antwort, oder NIL statt Absturz. Ohne das
scheiterte bei verschobenem Strom nicht die Pruefung, sondern (third
:desync) — und der Backtrace verdeckte die uebrigen Meldungen."
  (and (consp msg) (third msg)))

(defun swank-frame-bytes (text)
  "Baut eine Swank-Nachricht mit KORREKTER Byte-Länge."
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
      ;; Die erste Nachricht kommt auch mit dem alten Fehler scheinbar
      ;; heil an — nur verschoben. Die ZWEITE entlarvt ihn.
      (check "Lesen: erste Nachricht ist eine :return-Form"
             (and (consp m1) (first m1)) :return)
      (check "Lesen: zweite Nachricht intakt (Strom nicht verschoben)"
             (and (consp m2) (first m2)) :return)
      (check "Lesen: Umlaute korrekt dekodiert"
             (and (consp m2) (search "°C" (format nil "~S" m2)) t)
             t)
      (check "Lesen: zweite Nachricht ist nicht :unreadable"
             (eq m2 :unreadable) nil)
      (check "Lesen: Strom nicht verschoben (kein :desync)"
             (eq m2 :desync) nil)
      (check "Lesen: Request-ID der zweiten Nachricht"
             (req-id m2) 8))))

;;; --- Test 2: Schreibseite, Header zählt Bytes ------------------------

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
        (check "Schreiben: Header zählt Bytes, nicht Zeichen" announced actual)
        (check "Schreiben: Bytes > Zeichen bei Umlauten (Test greift wirklich)"
               (> announced (length text)) t)))))

;;; --- Test 3: Round-Trip über die echten Funktionen -------------------

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
      (check "Round-Trip: erste Nachricht" (req-id m1) 7)
      (check "Round-Trip: zweite Nachricht" (req-id m2) 8))))

(if (> *failed* 0)
    (progn (format t "~&~D Test(s) fehlgeschlagen.~%" *failed*)
           (sb-ext:exit :code 1))
    (format t "~&ok — Swank-Rahmung zählt Bytes, Strom bleibt synchron.~%"))
