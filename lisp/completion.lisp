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

(defun %completion-segment-hits (pattern name)
  "Wie viele Zeichen aus PATTERN treffen einen Wortanfang in NAME.

Wortanfang heisst: Position 0 oder direkt nach - / * / % / +."
  (let ((hits 0) (pidx 0) (len (length name)))
    (loop for i from 0 below len
          while (< pidx (length pattern))
          do (let ((boundary (or (zerop i) (find (char name (1- i)) "-*%+"))))
               (when (and boundary (char= (char name i) (char pattern pidx)))
                 (incf hits)
                 (incf pidx))))
    hits))

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
           ;; Treffer auf Segmentanfaengen zaehlen mehr: "mvb" soll
           ;; multiple-value-bind finden und nicht irgendein Symbol, in dem
           ;; m, v und b zufaellig in dieser Reihenfolge vorkommen.
           (let ((segment-hits (%completion-segment-hits p n)))
             (+ 100 (* 4 (or hit-first 0)) (* 3 gaps)
                (- (length n) (length p))
                (* -8 segment-hits)))))))))

(defun %completion-tokenize (source)
  "Zerlege SOURCE in einen Formenbaum, ohne den Reader zu bemuehen.

Rueckgabe: (values TREE OPEN-CHAIN).  TREE enthaelt die abgeschlossenen
Formen, OPEN-CHAIN die am Ende von SOURCE noch offenen Formen von aussen
nach innen.  Da SOURCE am Cursor endet, ist die letzte Kette genau der
Pfad der Formen, in denen der Cursor steht.

Ein Knoten ist entweder ein String (Atom) oder eine Liste (Form).
Strings, Zeilenkommentare und Zeichenliterale werden uebersprungen, damit
ein \"(\" im Text keine Form oeffnet.  Halbfertige Eingaben sind der
Normalfall und kein Fehler."
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
  "Formen, aus denen lexikalische Namen entnommen werden.

Die Incudine-Formen stehen hier gleichberechtigt: in einem dsp!-Koerper
sind FREQ, AMP und die with-samples-Variablen die Namen, die man
tatsaechlich tippt.  Bis v81.13 kannte der Scanner sie nicht.")

(defparameter *completion-sequential-binders*
  '("let*" "with-samples" "with" "do*" "prog*")
  "Binder, deren Namen schon in den folgenden Initialformen sichtbar sind.

Incudines WITH-SAMPLES und WITH binden sequenziell wie LET*, nicht
parallel wie LET.")

(defun %completion-atom-p (node) (stringp node))

(defun %completion-clean-name (token)
  "Nil fuer alles, was kein brauchbarer lexikalischer Name ist."
  (let ((s (string-downcase (or token ""))))
    (cond ((zerop (length s)) nil)
          ((char= (char s 0) #\&) nil)      ; &optional, &key, &rest
          ((find #\: s) nil)                ; Keywords und qualifizierte Symbole
          ((every #'digit-char-p s) nil)
          ((string= s "nil") nil)
          ((string= s "t") nil)
          (t s))))

(defun %completion-lambda-list-names (node)
  "Namen aus einer Lambda-Liste; &-Marker und Defaultwerte bleiben aussen vor."
  (when (listp node)
    (let ((out '()) (skip nil))
      (dolist (item node (nreverse out))
        (cond ((and (%completion-atom-p item)
                    (plusp (length item))
                    (char= (char item 0) #\&))
               ;; Nach &aux und &environment kommen keine Benutzernamen,
               ;; die man vervollstaendigen will.
               (setf skip (member (string-downcase item) '("&aux" "&environment")
                                  :test #'string=)))
              (skip nil)
              ((%completion-atom-p item)
               (let ((n (%completion-clean-name item))) (when n (push n out))))
              ;; (var default) oder ((:key var) default)
              ((and (consp item) (%completion-atom-p (first item)))
               (let ((n (%completion-clean-name (first item)))) (when n (push n out))))
              ((and (consp item) (consp (first item))
                    (%completion-atom-p (second (first item))))
               (let ((n (%completion-clean-name (second (first item)))))
                 (when n (push n out)))))))))

(defun %completion-binding-list-names (node)
  "Namen aus einer LET-artigen Bindungsliste."
  (when (listp node)
    (let ((out '()))
      (dolist (binding node (nreverse out))
        (let ((token (cond ((%completion-atom-p binding) binding)
                           ((and (consp binding) (%completion-atom-p (first binding)))
                            (first binding)))))
          (let ((n (and token (%completion-clean-name token))))
            (when n (push n out))))))))

(defun %completion-form-names (form)
  "Namen, die FORM selbst bindet.  FORM ist ein geparster Knoten."
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
       ;; LOOP hat keine Bindungsliste, sondern Schluesselwoerter.
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
  "Alle bindenden Namen im Teilbaum NODE."
  (let ((out (copy-list (%completion-form-names node))))
    (when (consp node)
      (dolist (child node)
        (when (consp child)
          (setf out (nconc out (%completion-collect-names child))))))
    out))

(defun %completion-attach-open (open-chain)
  "Haenge jede offene Form als letztes Kind ihrer Elternform an.

Der Tokenizer traegt Kinder erst beim Schliessen in die Elternform ein.
Noch offene Formen fehlen dort also — und genau die enthalten den Cursor.
Bei \"(labels ((helper (acc) ac\" waere die Bindungsliste sonst leer und
weder HELPER noch ACC kaemen als Kandidat heraus."
  (let ((reversed (reverse open-chain))
        (built '()))
    (dolist (form reversed built)
      (setf built (cons (if built (append form (list (first built))) form)
                        built)))))

(defun %completion-open-scope-names (open-chain)
  "Namen der Formen, die den Cursor enthalten — mit Beachtung der Bindungsstelle.

Bis v81.14 galt jeder Name einer umschliessenden Bindungsform als sichtbar,
auch wenn der Cursor noch in der Bindungsliste selbst stand.  In

  (let ((alpha 1) (beta al

ist ALPHA bei LET gerade NICHT sichtbar — der Wert von BETA wird im
aeusseren Scope berechnet.  Bei LET* und bei Incudines WITH-SAMPLES ist er
es.  Diese Funktion unterscheidet das."
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
                    ;; An welcher Argumentposition steht die Bindungs- bzw.
                    ;; Lambda-Liste?  Bei LET und LAMBDA an 1, bei DEFUN und
                    ;; dsp! an 2 (dort steht der Name davor).  FLET, LABELS
                    ;; und LOOP bleiben aussen vor: dort ist der Cursor in der
                    ;; Bindungsliste bereits im Rumpf einer lokalen Funktion,
                    ;; deren Parameter sichtbar sind.
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
                  ;; Sequenzieller Binder: die bereits abgeschlossenen
                  ;; frueheren Bindungen sind sichtbar, die gerade getippte
                  ;; noch nicht.
                  (setf out (nconc out (%completion-binding-list-names deeper))))
                 (t
                  ;; Paralleler Binder oder Lambda-Liste: hier ist noch
                  ;; nichts von dieser Form sichtbar.
                  nil))))
    out))

(defun %completion-local-names (source)
  "Lexikalische Namen aus SOURCE.

Rueckgabe: (values IN-SCOPE NEARBY).  IN-SCOPE stammt aus den Formen, in
denen der Cursor tatsaechlich steht, NEARBY aus abgeschlossenen Formen im
selben Fenster.  Die Trennung ist der Punkt: bis v81.13 bekam beides
denselben starken Bonus, und ein zufaellig aufgeschnappter Aufrufkopf aus
einem laengst geschlossenen Formular rankte ueber dem richtigen Symbol."
  (multiple-value-bind (tree open-chain) (%completion-tokenize (or source ""))
    (let ((in-scope '()) (nearby '()))
      (setf in-scope (%completion-open-scope-names open-chain))
      ;; Auch abgeschlossene Unterformen im selben Rumpf koennen binden,
      ;; etwa ein frueheres LET im selben DEFUN.
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
  "Der Operator der innersten offenen Form, oder nil."
  (let ((innermost (first (last open-chain))))
    (and (consp innermost)
         (%completion-atom-p (first innermost))
         (plusp (length (first innermost)))
         (first innermost))))

(defun %completion-head-position-p (open-chain)
  "T, wenn der Cursor an Operatorposition steht.

Frueher wurde dafuer rueckwaerts nach der naechsten oeffnenden Klammer
gesucht.  Der Parser weiss es genauer: Operatorposition heisst, dass die
innerste offene Form ausser dem gerade getippten Praefix noch nichts
enthaelt."
  (let ((innermost (first (last open-chain))))
    (and innermost (<= (length innermost) 1))))

(defun %completion-find-symbol (name package)
  (handler-case
      (multiple-value-bind (sym status) (find-symbol (string-upcase name) package)
        (and status sym))
    (error () nil)))

(defun %completion-keyword-parameters (head package)
  "Die &key-Parameternamen der Lambda-Liste von HEAD, klein geschrieben.

Das ist der Unterschied zwischen \":\" plus dem gesamten KEYWORD-Paket und
dem, was an dieser Stelle tatsaechlich sinnvoll ist."
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
  "Fuzzy, paket- und kontextbezogene Completion.
CONTEXT ist der Quelltext vor dem Cursor (begrenzt durch die Bridge).

Bei leerem Symbolteil werden bewusst NUR die &key-Parameter der
umschliessenden Form geliefert.  Sonst muesste hinter jedem Leerzeichen
das halbe Image kommen, und der Leerzeichen-Trigger waere unbrauchbar."
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
                ;; 1. &key-Parameter der umschliessenden Form.  Diese sind an
                ;;    dieser Stelle die einzigen Keywords, die sicher passen.
                (dolist (name arg-keywords)
                  (let ((score (%completion-subsequence-score sym-part name)))
                    (when score
                      (push-row (concatenate 'string ":" name) 14
                                (format nil "&key von ~(~A~)" enclosing)
                                "" score -200))))
                (unless empty-p
                  ;; 2. Lexikalische Namen: erst die im Scope, dann die aus
                  ;;    benachbarten geschlossenen Formen.
                  (dolist (name in-scope)
                    (let ((score (%completion-subsequence-score sym-part name)))
                      (when score (push-row name 6 "lexikalisch (im Scope)" "" score -100))))
                  (dolist (name nearby)
                    (let ((score (%completion-subsequence-score sym-part name)))
                      (when score (push-row name 6 "lexikalisch (benachbart)" "" score -20))))
                  ;; 3. Symbole des Zielpakets.
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
                  ;; Bei leerem Symbolteil ist das Ergebnis absichtlich
                  ;; unvollstaendig: der Client muss nach dem naechsten Zeichen
                  ;; erneut fragen, statt lokal auf dieser Teilmenge zu filtern.
                  (list :ok truncated
                        (mapcar (lambda (r) (subseq r 0 4)) limited))))))))
    (error (e)
      (list :ok nil (list (list (format nil "; Completion-Fehler: ~A" e) 1 "" ""))))))
