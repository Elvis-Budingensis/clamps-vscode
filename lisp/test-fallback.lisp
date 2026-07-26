
;;;; test-fallback.lisp — die Basis-Completion aus rpc.lisp ALLEIN.
;;;;
;;;; Bewusst eine eigene Datei: test-completion.lisp laedt completion.lisp
;;;; und ueberschreibt damit genau die Funktion, um die es hier geht. Der
;;;; Rueckfall wurde deshalb nie geprueft — und war kaputt.
(load (merge-pathnames "rpc.lisp" (or *load-truename* *default-pathname-defaults*)))
(in-package :clamps-bridge-rpc)

(let ((r (completions-for-repl "map" "COMMON-LISP-USER" "(map")))
  (assert (eq :ok (first r)) ()
          "Basis-Completion nimmt die drei Argumente der Bridge nicht an: ~S" r)
  (assert (member "mapcar" (third r) :key #'first :test #'string=) ()
          "Basis-Completion liefert fuer \"map\" kein mapcar."))

(let ((r (completions-for-repl "map" "COMMON-LISP-USER")))
  (assert (eq :ok (first r)) () "Aufruf ohne Kontext muss weiter gehen: ~S" r))

(format t "fallback tests ok~%")
