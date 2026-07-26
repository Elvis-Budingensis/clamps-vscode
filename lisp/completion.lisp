;;;; completion.lisp — additive, SLY-artige Completion-Erweiterung.
;;;;
;;;; Diese Datei überschreibt ausschließlich COMPLETIONS-FOR-REPL aus
;;;; rpc.lisp. Das Original bleibt unverändert und kann durch Entfernen
;;;; dieser LOAD-Zeile jederzeit wiederhergestellt werden.

(in-package :clamps-bridge-rpc)

(defparameter *completion-fuzzy-limit* 300)

;; In Common Lisp gibt es in Strings kein \t / \n / \r — "\t\r\n" waere
;; buchstaeblich "trn" und haette t, r und n als Trennzeichen behandelt.
;; Deshalb echte Zeichenobjekte.
(defparameter *completion-whitespace*
  (coerce (list #\Space #\Tab #\Return #\Newline #\Page) 'string))

(defun %completion-space-p (c)
  (and c (find c *completion-whitespace*)))

(defun %completion-subsequence-score (pattern name)
  "Fuzzy score; kleinere Werte sind besser, NIL bedeutet kein Treffer."
  (let ((p (string-downcase pattern)) (n (string-downcase name)))
    (cond
      ((zerop (length p)) 1000)
      ((%prefix-match-p n p) (- (length n) (length p)))
      (t
       ;; Keine Bindung von CL:PI / CL:FIRST / CL:LAST — PI ist eine
       ;; Konstante und das Paket COMMON-LISP ist gesperrt.
       (let ((pidx 0) (hit-first nil) (hit-last nil) (gaps 0))
         (loop for ni from 0 below (length n)
               while (< pidx (length p))
               when (char= (char p pidx) (char n ni))
                 do (unless hit-first (setf hit-first ni))
                    (when hit-last (incf gaps (max 0 (1- (- ni hit-last)))))
                    (setf hit-last ni)
                    (incf pidx))
         (when (= pidx (length p))
           (+ 100 (* 4 (or hit-first 0)) (* 3 gaps)
              (- (length n) (length p)))))))))

(defun %completion-local-names (source)
  "Konservative Extraktion lexikalischer Variablen aus LET/LAMBDA/DEFUN.
Keine Reader-Auswertung: fehlerhafte, halbfertige Formulare bleiben harmlos."
  (let ((out '()) (len (length (or source ""))))
    (labels ((delim-p (c) (or (null c) (%completion-space-p c)
                                     (find c "()[]{}'`,;\"")))
             (add-token (start end)
               (when (< start end)
                 (let ((s (subseq source start end)))
                   (unless (or (find #\: s) (every #'digit-char-p s))
                     (pushnew (string-downcase s) out :test #'string=))))))
      ;; Wir sammeln bewusst nur Symbole direkt nach öffnenden Klammern in
      ;; Bindungslisten sowie Lambda-Listen. Das liefert gute lokale Treffer,
      ;; ohne Common Lisp vollständig parsen zu müssen.
      (loop for i from 0 below len do
        (when (char= (char source i) #\()
          (let ((j (1+ i)))
            (loop while (and (< j len) (%completion-space-p (char source j))) do (incf j))
            (let ((start j))
              (loop while (and (< j len) (not (delim-p (char source j)))) do (incf j))
              (let ((head (string-downcase (subseq source start j))))
                (when (member head '("let" "let*" "lambda" "defun" "defmacro" "flet" "labels") :test #'string=)
                  (let ((limit (min len (+ j 600))))
                    (loop for k from j below limit do
                      (when (char= (char source k) #\()
                        (let ((a (1+ k)))
                          (loop while (and (< a limit)
                                            (or (%completion-space-p (char source a))
                                                (char= (char source a) #\())) do (incf a))
                          (let ((b a))
                            (loop while (and (< b limit) (not (delim-p (char source b)))) do (incf b))
                            (add-token a b)))))))))))))
    out))

(defun %completion-head-position-p (context)
  "T, wenn der Cursor wahrscheinlich an Funktions-/Makroposition steht."
  (let ((s (or context "")))
    (loop for i downfrom (1- (length s)) to 0
          for c = (char s i)
          when (char= c #\() do (return t)
          when (and (not (%completion-space-p c)) (not (char= c #\'))) do (return nil)
          finally (return nil))))

(defun %completion-candidate-kind (sym local-p)
  (cond (local-p 6) ; Variable
        (t (%sym-kind sym))))

(defun completions-for-repl (prefix package-name &optional context)
  "Fuzzy, paket- und kontextbezogene Completion.
CONTEXT ist der Quelltext vor dem Cursor (begrenzt durch die Bridge)."
  (handler-case
      (destructuring-bind (pkg-part sym-part internal-p) (%split-prefix prefix)
        (let* ((home (or (find-package (string-upcase package-name))
                         (find-package :common-lisp-user)))
               (target (if pkg-part (find-package pkg-part) home))
               (head-p (%completion-head-position-p context))
               (locals (if pkg-part nil (%completion-local-names context)))
               (rows '()) (seen (make-hash-table :test 'equal)))
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
            ;; Lokale Variablen sind kontextuell am wertvollsten.
            (dolist (name locals)
              (let ((score (%completion-subsequence-score sym-part name)))
                (when score (push-row name 6 "local variable" "" score -100))))
            (when target
              (if (and pkg-part (not internal-p) (not (string= pkg-part "KEYWORD")))
                  (do-external-symbols (sym target) (consider-symbol sym))
                  (do-symbols (sym target) (consider-symbol sym))))
            (setf rows (sort rows (lambda (a b)
                                    (if (= (fifth a) (fifth b))
                                        (string< (first a) (first b))
                                        (< (fifth a) (fifth b))))))
            (let* ((truncated (> (length rows) *completion-fuzzy-limit*))
                   (limited (subseq rows 0 (min (length rows) *completion-fuzzy-limit*))))
              (list :ok truncated
                    (mapcar (lambda (r) (subseq r 0 4)) limited))))))
    (error (e)
      (list :ok nil (list (list (format nil "; Completion-Fehler: ~A" e) 1 "" ""))))))
