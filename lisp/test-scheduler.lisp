;;;; test-scheduler.lisp — reading the EDF scheduler's scalar state.
;;;;
;;;; What can be checked without Incudine is the shape of the request and
;;;; the honesty of the answer. That is less than for the audio views, and
;;;; the reason is worth recording: Incudine exposes no synchronised
;;;; enumeration of pending events, so there is nothing here to check
;;;; against a known quantity the way an FFT can be checked against a DFT.
;;;;
;;;; Three findings from Incudine's source shape what this reads, and each
;;;; one is a way to get a plausible wrong answer:
;;;;
;;;;   - EDF times are absolute SAMPLE positions, and INCUDINE:NOW uses the
;;;;     same base. A second symbol named NOW is visible in the CLAMPS
;;;;     package — Common Music's, in seconds. Mixing them yields numbers
;;;;     that look like times and are not.
;;;;   - HEAP-COUNT and NEXT-TIME read whichever heap is currently bound.
;;;;     Outside the realtime thread that is not the heap AT writes to, so
;;;;     the answer describes a different heap.
;;;;   - RT-EVAL is asynchronous without :RETURN-VALUE-P T, and then
;;;;     returns before the body has run.
;;;;
;;;; NEXT-TIME and LAST-TIME are not read, and the probe must not start
;;; reading them again. Measured against a running session: HEAP-COUNT
;;; follows the events scheduled — 2, then 4 — while NEXT-TIME stays at one
;;; value across new events and across FLUSH-PENDING, and its magnitude does
;;; not relate to NOW by the sample rate. Reported anyway it produced a
;;; countdown of "17579:24.3" for an event due in five seconds.
;;;
;;; Run: sbcl --script lisp/test-scheduler.lisp

(load (merge-pathnames "rpc.lisp" *load-truename*))

(in-package :cl-user)

(defvar *failed* 0)

(defun fail (format &rest args)
  (incf *failed*)
  (format t "FAILED ~?~%" format args))

;;; ---------------------------------------------------------------------
;;; 1. Without Incudine, an error that names what is missing
;;; ---------------------------------------------------------------------
;;; This gate runs without Incudine, so it always exercises this path — and
;;; an editor that says "not available" without saying what it looked for
;;; leaves the user with nothing to act on.
(let ((r (clamps-bridge-rpc:scheduler-status-for-repl)))
  (unless (eq (first r) :error)
    (fail "Without Incudine the answer is ~S" (first r)))
  (when (eq (first r) :error)
    (dolist (needle '("INCUDINE" "EDF" "HEAP-COUNT"))
      (unless (search needle (second r))
        (fail "The message does not name ~A: ~A" needle (second r))))))

;;; ---------------------------------------------------------------------
;;; 2. Every symbol in the probe form is qualified
;;; ---------------------------------------------------------------------
;;; The heart of it. An unqualified NOW in a CLAMPS session is quite
;;; possibly Common Music's, counting seconds, while the heap counts
;;; samples — and the two mixed produce numbers that look like times and
;;; are not. The original diagnosis of this bug took several rounds
;;; precisely because both are called NOW.
(let ((form (clamps-bridge-rpc::%edf-probe-form)))
  ;; Every symbol carries a package prefix AND two colons.
  ;;
  ;; Two colons is a rule here, not the sum of individual findings. Which of
  ;; these names is exported is not something this file can know for a given
  ;; Incudine version — RT-EVAL and *SAMPLE-RATE* are internal despite being
  ;; documented, NOW is exported — and a single colon on an internal symbol
  ;; is a READER error. That happens before anything runs, so no
  ;; handler-case catches it: the view then reports a symbol problem instead
  ;; of a scheduler state. Two colons work for exported symbols too, so the
  ;; rule costs nothing and removes the question.
  (dolist (needle '("incudine::rt-eval" "incudine::now"
                    "incudine.edf::heap-count" "incudine.edf::*heap-size*"
                    "incudine::*sample-rate*"))
    (unless (search needle form)
      (fail "The probe does not use ~A: ~A" needle form)))

  ;; And no single-colon reference to these packages anywhere in the form.
  ;; Checked positionally rather than by listing the names again, so that a
  ;; symbol added later is covered without touching this test.
  (let ((position 0))
    (loop
      (let ((found (search "incudine" form :start2 position)))
        (unless found (return))
        (let* ((rest (subseq form found))
               (colon (position #\: rest)))
          (when colon
            (unless (and (< (1+ colon) (length rest))
                         (char= (char rest (1+ colon)) #\:))
              (fail "A single-colon reference at ~S"
                    (subseq rest 0 (min 40 (length rest)))))))
        (setf position (1+ found)))))

  ;; And the two figures that cannot be trusted stay out.
  (dolist (absent '("next-time" "last-time"))
    (when (search absent form)
      (fail "The probe reads ~A again, which does not describe the heap ~
HEAP-COUNT counts" absent)))

  ;; :RETURN-VALUE-P T is what makes rt-eval synchronous. Without it the
  ;; call returns before the body has run, and the answer is the state from
  ;; before the question.
  (unless (search ":return-value-p t" form)
    (fail "The probe does not read synchronously: ~A" form))

  ;; The form is built as a STRING and read at runtime. Written as literal
  ;; code it would be a READER error whenever INCUDINE.EDF does not exist —
  ;; and a reader error happens before anything runs, so no handler-case
  ;; could catch it. This gate is proof: it loads rpc.lisp without Incudine
  ;; present, which a literal incudine.edf::heap-count would prevent.
  (unless (stringp form)
    (fail "The probe form is not a string; loading without Incudine would fail")))

;;; ---------------------------------------------------------------------
;;; 3. A malformed answer is reported, not interpreted
;;; ---------------------------------------------------------------------
;;; If rt-eval ran asynchronously after all, or the realtime thread was not
;;; running, the call returns something other than the six values. Reading
;;; that as a scheduler state would put arbitrary numbers on a time axis.
;;;
;;; Checked by calling the probe with stand-in packages present but no
;;; rt-eval: the evaluation then fails, and the failure must reach the
;;; caller as an error rather than as a state.
;;;
;;; The stand-ins are built with MAKE-PACKAGE and INTERN at runtime rather
;;; than DEFPACKAGE, so that reading this file does not create the symbols
;;; the probe names. Written as literal code, SBCL would intern
;;; INCUDINE::RT-EVAL and the rest while compiling the test and then warn
;;; about them being undefined — warnings in a passing gate teach the reader
;;; to skip its output.
(let ((incudine (or (find-package "INCUDINE") (make-package "INCUDINE" :use '("COMMON-LISP"))))
      (edf (or (find-package "INCUDINE.EDF") (make-package "INCUDINE.EDF" :use '("COMMON-LISP")))))
  (let ((now (intern "NOW" incudine))
        (count (intern "HEAP-COUNT" edf)))
    (setf (fdefinition now) (lambda () 0)
          (fdefinition count) (lambda () 0))
    ;; rt-eval is deliberately absent, so evaluating the probe fails.
    (let ((r (clamps-bridge-rpc:scheduler-status-for-repl)))
      (unless (eq (first r) :error)
        (fail "A failing probe returns ~S instead of an error" (first r)))
      (when (eq (first r) :error)
        (unless (search "Reading the scheduler failed" (second r))
          (fail "The failure is not named as one: ~A" (second r)))))))

(if (> *failed* 0)
    (progn (format t "~%~D test(s) failed.~%" *failed*)
           (sb-ext:exit :code 1))
    (format t "ok — scheduler: every symbol qualified, rt-eval synchronous, ~
probe form readable without Incudine, failures reported~%"))
