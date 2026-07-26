;;;; loadcheck.lisp — das Gate, das v72s Klammerfehler gefunden hätte.
;;;;
;;;; Aufruf: sbcl --script lisp/loadcheck.lisp
;;;;
;;;; Warum es das braucht: check.py zählt Zeichen, und eine fehlende
;;;; Klammer, die durch eine überzählige am Dateiende ausgeglichen wird,
;;;; ist für jeden Zähler unsichtbar. Der Reader war zufrieden, die
;;;; Klammerbilanz war null — und trotzdem stand ein handler-case ohne
;;;; Klausel da, wodurch (error (e) ...) zu einem Funktionsaufruf wurde:
;;;; "The function clamps-bridge-rpc::e is undefined", bei jedem Anhängen
;;;; des Debuggers.
;;;;
;;;; Drei Stufen:
;;;;   1. LESEN     — jede Datei Form für Form; findet echte Syntaxfehler
;;;;   2. GESTALT   — handler-case/handler-bind müssen Klauseln haben
;;;;   3. LADEN     — rpc.lisp gegen nacktes SBCL; jede WARNING ist ein
;;;;                  Fehlschlag, STYLE-WARNING wird gemeldet
;;;;
;;;; Nur rpc.lisp wird geladen: sie ist laut eigenem Kopfkommentar frei
;;;; von CLAMPS, Swank und Incudine. bridge-server.lisp braucht Swank und
;;;; kann hier nur gelesen und auf Gestalt geprüft werden.

(require :sb-posix)

(defpackage :loadcheck (:use :cl))
(in-package :loadcheck)

(defvar *problems* 0)

(defun problem (fmt &rest args)
  (incf *problems*)
  (format *error-output* "~&FEHLER: ~?~%" fmt args))

;;; --- Stufe 1: Lesen --------------------------------------------------

(defun strip-package-markers (text)
  "Ersetzt Paketpräfixe (foo:bar -> foo-bar) AUSSERHALB von Zeichenketten,
Kommentaren und Zeichenliteralen.

Für die Gestaltprüfung ist gleichgültig, in welchem Paket ein Symbol
steht — es geht um Listenstruktur und um Köpfe wie HANDLER-CASE. Dieser
Rückfall macht Dateien prüfbar, die Fremdpakete nennen (ql:quickload,
sb-posix:getpid) und deshalb im nackten SBCL nicht lesbar sind. Ohne ihn
bliebe bridge-server.lisp ungeprüft — also gerade die Datei, die sich
nicht laden lässt und die deshalb am dringendsten eine Prüfung braucht."
  (let ((out (make-string-output-stream))
        (i 0) (n (length text)))
    (loop while (< i n) do
      (let ((c (char text i)))
        (cond
          ;; Zeichenkette unverändert übernehmen
          ((char= c #\")
           (write-char c out) (incf i)
           (loop while (and (< i n) (char/= (char text i) #\"))
                 do (when (and (char= (char text i) #\\) (< (1+ i) n))
                      (write-char (char text i) out) (incf i))
                    (write-char (char text i) out) (incf i))
           (when (< i n) (write-char (char text i) out) (incf i)))
          ;; Zeilenkommentar
          ((char= c #\;)
           (loop while (and (< i n) (char/= (char text i) #\Newline))
                 do (write-char (char text i) out) (incf i)))
          ;; Zeichenliteral: #\: darf keine Paketmarke sein
          ((and (char= c #\#) (< (1+ i) n) (char= (char text (1+ i)) #\\))
           (write-char c out) (write-char #\\ out) (incf i 2)
           (when (< i n) (write-char (char text i) out) (incf i)))
          ;; Doppelpunkt: durch Bindestrich ersetzen, damit foo:bar ein
          ;; einziges Token FOO-BAR bleibt. Ein Schlüsselwort am
          ;; Tokenanfang (:ok) bleibt ein Schlüsselwort.
          ((char= c #\:)
           (let ((prev (and (> i 0) (char text (1- i)))))
             (cond
               ;; Führender Doppelpunkt = Schlüsselwort, unverändert.
               ;;
               ;; #\# MUSS in dieser Liste stehen: #:foo ist ein
               ;; nicht-internierter Symbolname, kein Paketpräfix. Wurde
               ;; der Doppelpunkt dort zu einem Bindestrich, entstand
               ;; #-foo — eine Leseklausel, die die nächste Form
               ;; stillschweigend überspringt. In einer defpackage-Form
               ;; verschluckte das die halbe Exportliste und meldete am
               ;; Dateiende eine überzählige Klammer.
               ((or (null prev)
                    (member prev '(#\Space #\Tab #\Newline #\( #\) #\' #\#)))
                (write-char c out) (incf i))
               (t
                (if (and (< (1+ i) n) (char= (char text (1+ i)) #\:))
                    (incf i 2)
                    (incf i))
                (write-char #\- out)))))
          (t (write-char c out) (incf i)))))
    (get-output-stream-string out)))

(defun read-forms-from-string (text)
  (with-input-from-string (in text)
    ;; Eigenes Paket, damit die Symbole der Datei nichts überschreiben,
    ;; und *read-eval* aus: #. darf beim Prüfen nichts ausführen.
    (let ((*package* (make-package (gensym "LC") :use '(:cl)))
          (*read-eval* nil)
          (forms '()))
      (loop for form = (read in nil :eof)
            until (eq form :eof)
            do (push form forms))
      (nreverse forms))))

(defun file-text (path)
  (with-open-file (in path :external-format :utf-8)
    (let ((s (make-string (file-length in))))
      (subseq s 0 (read-sequence s in)))))

(defun read-all (path)
  "Liest PATH Form für Form. Erst direkt; scheitert das an fremden
Paketen, dann aus einer Kopie ohne Paketpräfixe."
  (let ((text (handler-case (file-text path)
                (error (e)
                  (problem "~A nicht lesbar: ~A" (file-namestring path) e)
                  nil))))
    (when text
      (handler-case (read-forms-from-string text)
        (error ()
          (handler-case (read-forms-from-string (strip-package-markers text))
            (error (e)
              (problem "~A ist nicht lesbar: ~A" (file-namestring path) e)
              nil)))))))

;;; --- Stufe 2: Gestalt ------------------------------------------------

(defun head-name (form)
  (and (consp form) (symbolp (first form)) (symbol-name (first form))))

(defun clause-p (c)
  "Sieht C wie eine handler-case-Klausel aus? (TYP (VAR) ...) oder (TYP () ...)"
  (and (consp c) (symbolp (first c)) (listp (second c))))

(defun check-shape (form path)
  "Prüft handler-case/handler-bind auf vorhandene Klauseln und steigt
weiter ab. Die Klauseln selbst werden NICHT als Aufrufe gewertet — sonst
meldet jede korrekte Klausel einen Fehler."
  (when (consp form)
    (let ((head (head-name form)))
      (cond
        ((and head (string= head "HANDLER-CASE"))
         (let ((clauses (cddr form)))
           (if (null clauses)
               ;; Genau der Fehler aus v72.
               (problem "~A: handler-case ohne Klausel — eine Klammer zu ~
                         viel? Die Klausel ist in die geschützte Form gerutscht ~
                         und wird dort zum Funktionsaufruf." path)
               (dolist (c clauses)
                 (unless (clause-p c)
                   (problem "~A: unbrauchbare handler-case-Klausel: ~S" path c))))
           ;; Geschützte Form prüfen, Klauselköpfe überspringen.
           (check-shape (second form) (format nil "~A/geschützt" path))
           (loop for c in clauses for i from 0
                 do (dolist (body-form (cddr c))
                      (check-shape body-form (format nil "~A/klausel~D" path i))))))
        ((and head (string= head "HANDLER-BIND"))
         (let ((bindings (second form)))
           (unless (and (listp bindings) bindings)
             (problem "~A: handler-bind ohne Bindung" path)))
         (dolist (x (cddr form)) (check-shape x path)))
        (t
         ;; Verdächtig: (ERROR (X) ...) als gewöhnlicher Aufruf. So sieht
         ;; eine verrutschte Klausel aus, wenn sie im Rumpf landet.
         (when (and head (string= head "ERROR")
                    (consp (second form))
                    (= 1 (length (second form)))
                    (symbolp (first (second form)))
                    (not (keywordp (first (second form)))))
           (problem "~A: (error (~A) ...) steht als Aufruf, nicht als Klausel"
                    path (first (second form))))
         (when (listp (cdr (last form)))   ; nur echte Listen begehen
           (loop for x in form for i from 0
                 do (check-shape x (format nil "~A/~D" path i)))))))))

(defun check-file-shape (path)
  (let ((forms (read-all path)))
    (loop for form in forms for i from 1
          do (check-shape
              form
              (format nil "~A Form~D~@[ ~A~]"
                      (file-namestring path) i
                      (and (consp form) (symbolp (second form)) (second form)))))
    (format t "~&  ~A: ~D Formen gelesen.~%" (file-namestring path) (length forms))))

;;; --- Stufe 3: Laden --------------------------------------------------

;;; --- Stufe 4: Übersetzen ---------------------------------------------
;;;
;;; LOAD einer Quelldatei fängt Kompilierfehler selbst ab: der Compiler
;;; meldet "caught ERROR" auf den Strom, ersetzt die Form durch einen
;;; Stummel, der erst beim AUFRUF knallt — und LOAD kehrt erfolgreich
;;; zurück. Genau so ist (let ((pi 0)) ...) durch Stufe 3 gelaufen:
;;; PI ist eine Konstante, die Datei war lesbar, formschön und
;;; "geladen", und trotzdem lieferte jede Completion nur noch
;;; "Execution of a form compiled with errors".
;;;
;;; COMPILE-FILE gibt FAILURE-P zurück und ist deshalb das ehrliche Gate.
;;; STYLE-WARNINGs setzen es nicht — die beabsichtigte Neudefinition von
;;; COMPLETIONS-FOR-REPL bleibt also erlaubt.

(defun check-compile (path)
  (let ((out (merge-pathnames (format nil "loadcheck-~A.fasl" (pathname-name path))
                              #p"/tmp/")))
    (multiple-value-bind (fasl warnings-p failure-p)
        (handler-bind ((style-warning #'muffle-warning))
          (handler-case (compile-file path :output-file out :verbose nil :print nil)
            (error (e)
              (problem "~A lässt sich nicht übersetzen: ~A" (file-namestring path) e)
              (values nil t t))))
      (declare (ignore warnings-p))
      (when failure-p
        (problem "~A übersetzt mit Fehler oder ernster Warnung"
                 (file-namestring path)))
      (unless failure-p
        (format t "~&  ~A übersetzt sauber.~%" (file-namestring path)))
      (when fasl (ignore-errors (delete-file fasl))))))

(defun check-load (path)
  (let ((styles 0))
    (handler-bind
        ((style-warning (lambda (c)
                          (incf styles)
                          (format t "~&  Stilwarnung: ~A~%" c)
                          (muffle-warning c)))
         ;; WARNING ohne STYLE- ist ernst: undefinierte Variable,
         ;; Typfehler, widersprüchliche Deklaration. Genau hier hätte
         ;; "undefined variable: E" zugeschlagen.
         (warning (lambda (c)
                    (problem "~A lädt mit Warnung: ~A" (file-namestring path) c)
                    (muffle-warning c))))
      (handler-case (load path)
        (error (e) (problem "~A lässt sich nicht laden: ~A"
                            (file-namestring path) e))))
    (format t "~&  ~A geladen, ~D Stilwarnung(en).~%" (file-namestring path) styles)))

;;; --- Hauptteil -------------------------------------------------------

(let* ((here (directory-namestring *load-truename*))
       (rpc (merge-pathnames "rpc.lisp" here))
       (others (remove-if (lambda (p) (equal (pathname-name p) "rpc"))
                          (directory (merge-pathnames "*.lisp" here)))))
  (format t "~&Gestalt prüfen …~%")
  (check-file-shape rpc)
  (dolist (p others) (check-file-shape p))
  ;; completion.lisp und autodoc.lisp sind wie rpc.lisp frei von CLAMPS,
  ;; Swank und Incudine und bauen nur auf rpc.lisp auf. Sie MUESSEN hier
  ;; mitgeprueft werden: (let ((pi 0)) ...) ist lesbar und formschoen, aber
  ;; ein Kompilierfehler — Stufe 1 und 2 sehen davon nichts.
  ;;
  ;; Uebersetzen kommt VOR dem Laden. Umgekehrt hat autodoc.lisp beim
  ;; Laden (export '(autodoc-for-repl)) ausgefuehrt, und die spaetere
  ;; Uebersetzung von rpc.lisp meldete dann eine Paketabweichung gegen
  ;; das eigene DEFPACKAGE — eine Warnung, die nur die Pruefreihenfolge
  ;; erzeugt hat und nichts ueber die Dateien sagt.
  (let ((extras (remove nil
                        (mapcar (lambda (name)
                                  (let ((p (merge-pathnames
                                            (concatenate 'string name ".lisp") here)))
                                    (and (probe-file p) p)))
                                '("completion" "autodoc")))))
    (format t "~&Übersetzen prüfen …~%")
    (check-compile rpc)
    (dolist (p extras) (check-compile p))
    (format t "~&Laden prüfen …~%")
    (check-load rpc)
    (dolist (p extras) (check-load p)))
  (if (zerop *problems*)
      (format t "~&ok — Lisp lädt sauber und ohne verrutschte Klauseln.~%")
      (format t "~&~D Problem(e).~%" *problems*))
  (sb-ext:exit :code (if (zerop *problems*) 0 1)))
