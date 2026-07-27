;;;; test-bridge-context.lisp — Kontextfenster der Completion.
;;;;
;;;; bridge-server.lisp laesst sich hier nicht laden: es braucht usocket,
;;;; bordeaux-threads und eine Swank-Verbindung. Der Test holt sich deshalb
;;;; genau die Funktionen aus der ausgelieferten Datei, um die es geht, und
;;;; wertet nur diese aus. Damit wird der echte Quelltext geprueft und nicht
;;;; eine Kopie, die auseinanderlaufen kann.

(defpackage :bridge-context-test (:use :cl))
(in-package :bridge-context-test)

(defparameter *source-path*
  (merge-pathnames "bridge-server.lisp"
                   (or *load-truename* *default-pathname-defaults*)))

(defun file-text (path)
  (with-open-file (in path :external-format :utf-8)
    (let ((s (make-string (file-length in))))
      (subseq s 0 (read-sequence s in)))))

(defun form-source (text name)
  "Quelltext der Top-Level-Form, die mit NAME beginnt.

Sucht die Zeichenfolge in Spalte 0 und zaehlt Klammern bis zum Ende der
Form. Strings und Kommentare zaehlen nicht mit."
  (let ((start (search name text)))
    (unless start
      (error "~A steht nicht in bridge-server.lisp." name))
    (let ((depth 0) (i start) (n (length text)))
      (loop while (< i n) do
        (let ((c (char text i)))
          (cond ((char= c #\;)
                 (loop while (and (< i n) (char/= (char text i) #\Newline)) do (incf i)))
                ((char= c #\")
                 (incf i)
                 (loop while (< i n)
                       do (cond ((char= (char text i) #\\) (incf i 2))
                                ((char= (char text i) #\") (incf i) (return))
                                (t (incf i)))))
                ((and (char= c #\#) (< (1+ i) n) (char= (char text (1+ i)) #\\))
                 (incf i 3))
                ((char= c #\() (incf depth) (incf i))
                ((char= c #\))
                 (decf depth) (incf i)
                 (when (zerop depth) (return-from form-source (subseq text start i))))
                (t (incf i)))))
      (error "~A ist in bridge-server.lisp nicht abgeschlossen." name))))

(let ((text (file-text *source-path*)))
  (dolist (name '("(defparameter *completion-context-max-lines*"
                  "(defun nth-line"
                  "(defun completion-context-start-line"
                  ;; Mit Argumentliste, sonst trifft SEARCH zuerst
                  ;; COMPLETION-CONTEXT-START-LINE und COMPLETION-CONTEXT
                  ;; bliebe undefiniert.
                  "(defun completion-context (text"))
    (eval (read-from-string (form-source text name)))))

;;; --- Verhalten -------------------------------------------------------

(defparameter *doc*
  (format nil "~{~A~^~%~}"
          '("(in-package :clamps)"
            ""
            "(defun helper (x) x)"
            ""
            "(dsp! simple (freq amp)"
            "  (with-samples ((in (sine freq amp 0)))"
            "    (out in in)))")))

;; Der Kontext beginnt am Anfang der umschliessenden Top-Level-Form, nicht
;; 120 Zeilen davor und nicht am Dateianfang.
(let ((ctx (completion-context *doc* 6 10)))
  (assert (eql 0 (search "(dsp! simple" ctx))
          () "Kontext beginnt nicht bei der dsp!-Form: ~S" ctx)
  (assert (not (search "helper" ctx))
          () "Kontext reicht in die vorige Top-Level-Form: ~S" ctx))

;; Der Cursor schneidet die letzte Zeile ab; nichts dahinter kommt mit.
(let ((ctx (completion-context *doc* 6 10)))
  (assert (string= "    (out i" (subseq ctx (- (length ctx) 10)))
          () "Cursorzeile falsch abgeschnitten: ~S" ctx))

;; Steht der Cursor selbst in der Zeile mit der Klammer in Spalte 0, ist
;; das der Anfang.
(assert (= 4 (completion-context-start-line *doc* 4)))
(assert (= 4 (completion-context-start-line *doc* 6)))
(assert (= 2 (completion-context-start-line *doc* 3)))

;; Eine lange Form verliert ihren Anfang nicht mehr. Das war der Punkt:
;; mit dem alten Fenster von 120 Zeilen fielen die Parameter eines
;; laengeren DEFUN heraus und wurden nicht mehr vervollstaendigt.
(let* ((filler (with-output-to-string (out)
                 (dotimes (i 300) (format out "  (progn ~D)~%" i))))
       (long (format nil "(defun big (alpha beta)~%~A  al" filler)))
  (let ((ctx (completion-context long 302 5)))
    (assert (search "alpha beta" ctx)
            () "Parameter der langen Form fehlen im Kontext.")))

;; Ohne Klammer in Spalte 0 greift der Rueckfalldeckel, statt die ganze
;; Datei zu schicken.
(let* ((lines (with-output-to-string (out)
                (dotimes (i 900) (format out "  x~D~%" i))))
       (start (completion-context-start-line lines 899)))
  (assert (= start (- 899 *completion-context-max-lines*))
          () "Rueckfalldeckel greift nicht: ~D" start))

;; Leere Zeilen und Zeilen jenseits des Textes duerfen nicht fliegen.
(assert (stringp (completion-context "" 0 0)))
(assert (stringp (completion-context *doc* 99 5)))

(format t "bridge-context tests ok~%")
