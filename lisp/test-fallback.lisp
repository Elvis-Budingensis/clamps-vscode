
;;;; test-fallback.lisp — the base completion from rpc.lisp ON ITS OWN.
;;;;
;;;; Deliberately a file of its own: test-completion.lisp loads
;;;; completion.lisp and thereby overrides exactly the function in
;;;; question here. The fallback was therefore never checked — and was
;;;; broken.
(load (merge-pathnames "rpc.lisp" (or *load-truename* *default-pathname-defaults*)))
(in-package :clamps-bridge-rpc)

(let ((r (completions-for-repl "map" "COMMON-LISP-USER" "(map")))
  (assert (eq :ok (first r)) ()
          "The base completion does not accept the bridge's three arguments: ~S" r)
  (assert (member "mapcar" (third r) :key #'first :test #'string=) ()
          "The base completion returns no mapcar for \"map\"."))

(let ((r (completions-for-repl "map" "COMMON-LISP-USER")))
  (assert (eq :ok (first r)) () "A call without context must still work: ~S" r))

(format t "fallback tests ok~%")
