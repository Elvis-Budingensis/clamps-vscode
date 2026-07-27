(load (merge-pathnames "rpc.lisp" (or *load-truename* *default-pathname-defaults*)))
(load (merge-pathnames "completion.lisp" (or *load-truename* *default-pathname-defaults*)))
(in-package :clamps-bridge-rpc)
(flet ((labels-of (prefix context)
         (mapcar #'first (third (completions-for-repl prefix "COMMON-LISP-USER" context)))))
  (assert (member "mapcar" (labels-of "mc" "(mc") :test #'string=))
  (assert (member ":test" (labels-of ":te" "(:te") :test #'string=))
  (assert (member "my-value" (labels-of "mv" "(let ((my-value 1)) mv") :test #'string=)))
;; APROPOS teilt %SYM-KIND mit der Completion. Dort stand
;; (string-downcase (symbol-name kind)) — %SYM-KIND liefert aber eine
;; LSP-Zahl. APROPOS lieferte deshalb bei JEDER Anfrage nur
;; (:error "The value 3 is not of type SYMBOL"). Der handler-case hat den
;; Fehler geschluckt, also fiel es im Betrieb nur als leere Liste auf.
(let ((r (apropos-for-repl "mapcar" "COMMON-LISP-USER" nil)))
  (assert (eq :ok (first r)))
  (assert (second r))
  (let ((hit (find "common-lisp::mapcar" (second r)
                   :key (lambda (e) (getf e :label)) :test #'string=)))
    (assert hit)
    (assert (string= "function" (getf hit :description)))))
(assert (string= "macro" (%sym-kind-label (%sym-kind 'when))))
(assert (string= "kind-99" (%sym-kind-label 99)))

;; Signaturvertrag: handle-completion in bridge-server.lisp schickt IMMER
;; drei Argumente. Die Basisfassung in rpc.lisp nahm nur zwei, also
;; scheiterte jede Vervollstaendigung mit "invalid number of arguments: 3",
;; sobald completion.lisp nicht geladen war — ohne Fehlermeldung im Editor,
;; es kamen einfach keine Vorschlaege. Beide Fassungen muessen drei Argumente
;; annehmen, und "map" muss "mapcar" enthalten.
(let ((r (completions-for-repl "map" "COMMON-LISP-USER" "(map")))
  (assert (eq :ok (first r)))
  (assert (member "mapcar" (third r) :key #'first :test #'string=)))


;;; ------------------------------------------------------------------
;;; v81.14 — Parser, Scope, &key-Kontext, Rangfolge
;;; ------------------------------------------------------------------

(flet ((labels-of (prefix context)
         (mapcar #'first (third (completions-for-repl prefix "COMMON-LISP-USER" context))))
       (rank-of (label prefix context)
         (position label (mapcar #'first (third (completions-for-repl prefix "COMMON-LISP-USER" context)))
                   :test #'string=)))

  ;; Der Tokenizer darf sich von Strings, Kommentaren und Zeichenliteralen
  ;; keine Klammer unterschieben lassen.  Genau daran scheiterte die alte
  ;; Fenster-Heuristik.
  (multiple-value-bind (tree open) (%completion-tokenize "(foo \"( bar\" ; (baz
 #\\( qu")
    (declare (ignore tree))
    (assert (= 1 (length open)))
    (assert (string= "foo" (first (first open))))
    ;; foo, der String, das Zeichenliteral, "qu" — die Klammern darin zaehlen nicht.
    (assert (string= "qu" (first (last (first open))))))

  ;; Unabgeschlossene Formen sind der Normalfall und ergeben die Kette der
  ;; Formen, in denen der Cursor steht.
  (multiple-value-bind (tree open) (%completion-tokenize "(defun f (x) (let ((y 1)) (+ y ")
    (declare (ignore tree))
    (assert (= 3 (length open)))
    (assert (string= "defun" (first (first open))))
    (assert (string= "+" (first (third open)))))

  ;; Operatorposition kommt jetzt aus dem Parser, nicht aus einer
  ;; Rueckwaertssuche nach der naechsten Klammer.
  (assert (%completion-head-position-p (nth-value 1 (%completion-tokenize "(map"))))
  (assert (%completion-head-position-p (nth-value 1 (%completion-tokenize "(foo (bar"))))
  (assert (not (%completion-head-position-p (nth-value 1 (%completion-tokenize "(mapcar #'car li")))))

  ;; Incudine-Formen binden.  dsp!-Parameter und with-samples-Variablen
  ;; kannte der Scanner bis v81.13 ueberhaupt nicht.
  (let ((ctx "(dsp! simple (freq amp)
  (with-samples ((in (sine freq amp 0)))
    (out i"))
    (assert (member "in" (labels-of "i" ctx) :test #'string=))
    (assert (member "freq" (labels-of "f" ctx) :test #'string=))
    (assert (member "amp" (labels-of "a" ctx) :test #'string=)))

  ;; Weitere Binder.
  (assert (member "acc" (labels-of "ac" "(labels ((helper (acc) ac") :test #'string=))
  (assert (member "helper" (labels-of "he" "(labels ((helper (acc) 1)) (he") :test #'string=))
  (assert (member "item" (labels-of "it" "(dolist (item xs) it") :test #'string=))
  (assert (member "quotient" (labels-of "qu" "(multiple-value-bind (quotient rem) (floor 3 2) qu") :test #'string=))
  (assert (member "row" (labels-of "ro" "(loop for row in rows do (print ro") :test #'string=))

  ;; &-Marker und Keywords sind keine Variablennamen.
  (let ((found (labels-of "" "(defun f (a &optional b) ")))
    (assert (not (member "&optional" found :test #'string=))))

  ;; Namen aus dem Scope ranken vor Namen aus benachbarten Formen.
  (let ((ctx "(defun one (alpha) alpha)
(defun two (alphabet) alph"))
    (let ((in-scope (rank-of "alphabet" "alph" ctx))
          (nearby (rank-of "alpha" "alph" ctx)))
      (assert in-scope)
      (assert nearby)
      (assert (< in-scope nearby)
              () "Scope-Name rankte auf ~D, benachbarter auf ~D." in-scope nearby)))

  ;; &key-Parameter der umschliessenden Form stehen ganz oben und tragen
  ;; ein Detail, das sagt woher sie kommen.
  (let ((items (third (completions-for-repl ":el" "COMMON-LISP-USER" "(make-array 3 :el"))))
    (assert items)
    (assert (string= ":element-type" (first (first items))))
    (assert (search "make-array" (third (first items)))))

  ;; Bei leerem Symbolteil kommen ausschliesslich die &key-Namen — sonst
  ;; waere der Leerzeichen-Trigger unbrauchbar.
  (let ((result (completions-for-repl "" "COMMON-LISP-USER" "(make-array 3 ")))
    (assert (second result) () "Leeres Praefix muss isIncomplete melden.")
    (let ((found (mapcar #'first (third result))))
      (assert (member ":element-type" found :test #'string=))
      (assert (not (member "mapcar" found :test #'string=))
              () "Leeres Praefix darf keine Symbole schicken.")))

  ;; Ohne &key-Parameter bleibt der Leerzeichen-Trigger still.
  (assert (null (third (completions-for-repl "" "COMMON-LISP-USER" "(car "))))

  ;; In Operatorposition sind Keywords kein sinnvoller Vorschlag.
  (assert (null (third (completions-for-repl "" "COMMON-LISP-USER" "(make-array ("))))

  ;; Wortanfaenge zaehlen: "mvb" muss multiple-value-bind finden, und zwar
  ;; vor Symbolen, in denen m, v und b nur zufaellig vorkommen.
  (let ((rank (rank-of "multiple-value-bind" "mvb" "(mvb")))
    (assert rank () "mvb findet multiple-value-bind nicht.")
    (assert (< rank 5) () "multiple-value-bind rankte erst auf ~D." rank))

  ;; v81.15 — Sichtbarkeit an der Bindungsstelle.
  ;; Bei LET wird der Wert der zweiten Bindung im aeusseren Scope berechnet,
  ;; ALPHA ist dort also noch nicht sichtbar.
  (assert (not (member "alpha" (labels-of "al" "(let ((alpha 1) (beta al") :test #'string=))
          () "LET darf ALPHA in der Bindungsliste nicht anbieten.")
  ;; Bei LET* schon.
  (assert (member "alpha" (labels-of "al" "(let* ((alpha 1) (beta al") :test #'string=)
          () "LET* muss ALPHA in der Bindungsliste anbieten.")
  ;; Incudines WITH-SAMPLES bindet sequenziell wie LET*.
  (assert (member "car1" (labels-of "ca" "(with-samples ((car1 (sine 330)) (mod (* car1 ca") :test #'string=))
  ;; Im Rumpf sind bei beiden alle Namen sichtbar.
  (assert (member "alpha" (labels-of "al" "(let ((alpha 1) (beta 2)) al") :test #'string=))
  ;; In der eigenen Lambda-Liste ist noch nichts gebunden.
  (assert (not (member "alpha" (labels-of "al" "(defun f (alpha al") :test #'string=))
          () "Lambda-Liste darf ihre eigenen Namen noch nicht anbieten.")
  ;; Im Rumpf dann doch.
  (assert (member "alpha" (labels-of "al" "(defun f (alpha) al") :test #'string=))

  ;; Paketqualifizierte Praefixe unterscheiden extern und intern weiterhin.
  (assert (member "common-lisp:mapcar" (labels-of "common-lisp:mapc" "(common-lisp:mapc")
                  :test #'string=)))

(format t "completion tests ok~%")
