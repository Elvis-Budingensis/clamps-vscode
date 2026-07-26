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

(format t "completion tests ok~%")
