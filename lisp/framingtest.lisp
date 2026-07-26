;;;; framingtest.lisp — Regressionstest für die LSP-Rahmung.
;;;;
;;;; Aufruf: sbcl --script lisp/framingtest.lisp
;;;;
;;;; Der Anlass: Content-Length zählt BYTES in UTF-8. read-lsp-message
;;;; legte einen String dieser Länge an und las so viele ZEICHEN. Sobald
;;;; eine Nachricht Umlaute enthielt — etwa das didOpen für eine Datei
;;;; mit deutschen Kommentaren — wurde über das Nachrichtenende hinaus in
;;;; die folgende hineingelesen. Danach war der Strom verschoben, der
;;;; nächste Header unlesbar, und die Hauptschleife endete: der
;;;; Bridge-Prozess beendete sich mit Code 0.
;;;;
;;;; Deshalb prüft dieser Test ZWEI Nachrichten hintereinander. Mit nur
;;;; einer wäre der Fehler unsichtbar geblieben — die erste Nachricht
;;;; kommt trotz Überlesen scheinbar heil an.
;;;;
;;;; Getestet wird gegen eine echte Datei, nicht gegen einen String-
;;;; Strom: bivalente Ströme (Zeichen UND Bytes) gibt es in ANSI CL nur
;;;; für Dateien, und genau die Bivalenz ist hier der Kern.

(require :sb-posix)

(defpackage :framingtest (:use :cl))
(in-package :framingtest)

(defvar *failed* 0)

(defun check (name actual expected)
  (unless (equal actual expected)
    (incf *failed*)
    (format t "~&FEHLER ~A~%  erwartet: ~S~%  bekommen: ~S~%" name expected actual)))

;;; --- bridge-server.lisp teilweise laden ------------------------------
;;;
;;; Die Datei braucht Quicklisp und Bordeaux-Threads, die hier fehlen.
;;; Ersatzpakete anlegen und nur die Definitionsformen auswerten: die
;;; Rümpfe laufen dabei nicht, also stören fehlende Fremdfunktionen
;;; nicht. So wird die ECHTE read-lsp-message geprüft und keine Kopie.

(defun token-chars-p (c)
  (or (alphanumericp c) (find c "+-*/=<>!?%&$_.")))

(defun collect-qualified-symbols (text)
  "Sammelt alle PAKET:SYMBOL und PAKET::SYMBOL aus TEXT.

Statt die Fremdpakete zu erraten, werden sie aus der Datei gelesen. Neue
Abhängigkeiten in bridge-server.lisp brechen den Test damit nicht — sonst
wäre der Test genau dann kaputt, wenn man ihn am meisten braucht."
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
               ;; Genau ein oder zwei Doppelpunkte, dann wieder Zeichen
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
  "Pakete, die es im nackten SBCL wirklich gibt — nicht ersetzen.")

(defun ensure-stubs (text)
  "Legt für jedes fremde PAKET:SYMBOL ein Ersatzpaket an und exportiert
das Symbol, damit der Reader die Datei überhaupt lesen kann."
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
  "Wertet aus PATH nur die Formen aus, die etwas definieren.

Die Rümpfe laufen dabei nicht, fehlende Fremdfunktionen stören also
nicht. So wird die ECHTE read-lsp-message geprüft und keine Kopie."
  (let ((text (with-open-file (in path :external-format :utf-8)
                (let ((s (make-string (file-length in))))
                  (subseq s 0 (read-sequence s in))))))
    (ensure-stubs text)
    ;; with-lock-held ist ein Makro: ohne Definition würde der Compiler
    ;; es als Funktionsaufruf lesen. Für die geprüften Funktionen
    ;; belanglos, aber es vermeidet Rauschen.
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
  "Baut eine LSP-Nachricht mit KORREKTER Byte-Länge."
  (let ((bytes (sb-ext:string-to-octets body-string :external-format :utf-8)))
    (values (format nil "Content-Length: ~D~C~C~C~C"
                    (length bytes) #\Return #\Newline #\Return #\Newline)
            bytes)))

(defun write-frames (path bodies)
  "Schreibt mehrere Nachrichten byte-genau in eine Datei."
  (with-open-file (out path :direction :output :element-type '(unsigned-byte 8)
                            :if-exists :supersede :if-does-not-exist :create)
    (dolist (b bodies)
      (multiple-value-bind (header bytes) (lsp-frame b)
        (write-sequence (sb-ext:string-to-octets header :external-format :utf-8) out)
        (write-sequence bytes out)))))

(defun read-frames (path n)
  "Liest N Nachrichten mit der echten read-lsp-message."
  (with-open-file (in path :element-type :default :external-format :utf-8)
    (loop repeat n collect (funcall (intern "READ-LSP-MESSAGE" :framingtest) in))))

;;; --- Test ------------------------------------------------------------

(let* ((here (directory-namestring *load-truename*))
       (bridge (merge-pathnames "bridge-server.lisp" here))
       (tmp (merge-pathnames "framingtest.tmp" #p"/tmp/")))
  (let ((n (load-definitions bridge)))
    (format t "~&~D Definitionen aus bridge-server.lisp ausgewertet.~%" n)
    (when (< n 20)
      (incf *failed*)
      (format t "~&FEHLER: zu wenige Definitionen — der Test prüft nichts.~%")))

  (unless (fboundp (intern "READ-LSP-MESSAGE" :framingtest))
    (format t "~&FEHLER: read-lsp-message wurde nicht definiert.~%")
    (sb-ext:exit :code 1))

  ;; 1. Reines ASCII: muss immer funktionieren, auch mit dem alten Fehler.
  (write-frames tmp (list "{\"method\":\"eins\"}" "{\"method\":\"zwei\"}"))
  (let ((msgs (read-frames tmp 2)))
    (check "ASCII: erste Nachricht" (gethash "method" (first msgs)) "eins")
    (check "ASCII: zweite Nachricht" (gethash "method" (second msgs)) "zwei"))

  ;; 2. Der eigentliche Fall: Umlaute in der ERSTEN Nachricht. Bytes >
  ;;    Zeichen, also las die alte Fassung in die zweite hinein.
  (write-frames tmp (list "{\"text\":\"für übersprungen — gültig\"}"
                          "{\"method\":\"danach\"}"))
  (let ((msgs (read-frames tmp 2)))
    (check "Umlaute: erste Nachricht"
           (gethash "text" (first msgs)) "für übersprungen — gültig")
    ;; Das ist die Zeile, die den Fehler gefunden hätte: vorher NIL.
    (check "Umlaute: zweite Nachricht kommt noch an"
           (and (second msgs) (gethash "method" (second msgs))) "danach"))

  ;; 3. Realistischer Umfang: so viel Nicht-ASCII wie in rpc.lisp
  ;;    (305 Bytes Differenz), gefolgt von einer weiteren Nachricht.
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

  ;; 4. Abgeschnittene Nachricht: NIL, aber ohne Fehler.
  (with-open-file (out tmp :direction :output :element-type '(unsigned-byte 8)
                           :if-exists :supersede)
    (write-sequence (sb-ext:string-to-octets
                     (format nil "Content-Length: 500~C~C~C~C{\"a\":1}"
                             #\Return #\Newline #\Return #\Newline)
                     :external-format :utf-8)
                    out))
  (check "abgeschnitten ergibt NIL" (first (read-frames tmp 1)) nil)

  ;; 5. Autodoc-Kontext. Der Anlass: in bridge-server.lisp stand
  ;;    (find ch " \t\r\n") — in Common Lisp gibt es diese Escapes in
  ;;    Strings nicht, die Zeichenmenge war also " trn". Damit brach
  ;;    jeder Operatorname an einem t, r oder n ab: "concatenate" wurde
  ;;    zu "co", "list" zu "lis". Signature Help zeigte dann nichts.
  (let ((ctx (intern "CALL-CONTEXT-BEFORE-POINT" :framingtest)))
    (if (not (fboundp ctx))
        (progn (incf *failed*)
               (format t "~&FEHLER: call-context-before-point fehlt.~%"))
        (flet ((op (text) (first (funcall ctx text 0 (length text)))))
          (check "Autodoc: einfacher Operator" (op "(mapcar #'car x") "mapcar")
          (check "Autodoc: Name mit t/r/n bleibt heil"
                 (op "(concatenate 'string ") "concatenate")
          (check "Autodoc: Tabulator trennt"
                 (op (format nil "(list~Ca" #\Tab)) "list")
          (check "Autodoc: Zeilenumbruch trennt"
                 (op (format nil "(print~C  x" #\Newline)) "print")
          (check "Autodoc: innerste Form gewinnt"
                 (op "(mapcar (truncate ") "truncate")
          (check "Autodoc: Klammer im String zaehlt nicht"
                 (op "(format nil \"(nicht \" ") "format")
          (check "Autodoc: Klammer als Zeichenliteral zaehlt nicht"
                 (op "(find ch #\\( ") "find")
          (check "Autodoc: ohne offene Form NIL" (op "abc ") nil)
          ;; Aktiver Parameter: Leerzeichen ist ein Trigger, also muss
          ;; genau dort das NAECHSTE Argument markiert sein.
          (flet ((active (text) (second (funcall ctx text 0 (length text)))))
            (check "aktiv: direkt nach dem Operator" (active "(mapcar ") 0)
            (check "aktiv: erstes Argument im Tippen" (active "(mapcar #'c") 0)
            (check "aktiv: nach erstem Argument" (active "(mapcar #'car ") 1)
            (check "aktiv: zweites Argument im Tippen" (active "(mapcar #'car ls") 1)
            (check "aktiv: nach zweitem Argument" (active "(mapcar #'car ls ") 2)
            (check "aktiv: nach geschlossener Unterform" (active "(mapcar (car x) ") 1)))))

  (ignore-errors (delete-file tmp))
  (if (zerop *failed*)
      (format t "~&ok — LSP-Rahmung zählt Bytes, Strom bleibt synchron.~%")
      (format t "~&~D Fehler.~%" *failed*))
  (sb-ext:exit :code (if (zerop *failed*) 0 1)))
