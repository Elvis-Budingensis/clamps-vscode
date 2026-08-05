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
;;;; Run: sbcl --script lisp/test-scheduler.lisp

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
  (dolist (needle '("incudine:now" "incudine.edf:heap-count"
                    "incudine.edf:next-time" "incudine.edf:last-time"
                    "incudine.edf:*heap-size*" "incudine:*sample-rate*"))
    (unless (search needle form)
      (fail "The probe does not use ~A: ~A" needle form)))
  ;; And nothing unqualified: every occurrence of these names must carry a
  ;; package prefix.
  (dolist (bare '("(now)" "(heap-count)" "(next-time)" "(last-time)"))
    (when (search bare form)
      (fail "The probe uses the unqualified ~A" bare)))

  ;; :RETURN-VALUE-P T is what makes rt-eval synchronous. Without it the
  ;; call returns before the body has run, and the answer is the state from
  ;; before the question.
  (unless (search ":return-value-p t" form)
    (fail "The probe does not read synchronously: ~A" form))

  ;; The form is built as a STRING and read at runtime. Written as literal
  ;; code it would be a READER error whenever INCUDINE.EDF does not exist —
  ;; and a reader error happens before anything runs, so no handler-case
  ;; could catch it. This gate is proof: it loads rpc.lisp without Incudine
  ;; present, which a literal incudine.edf:heap-count would prevent.
  (unless (stringp form)
    (fail "The probe form is not a string; loading without Incudine would fail")))

;;; ---------------------------------------------------------------------
;;; 3. A malformed answer is reported, not interpreted
;;; ---------------------------------------------------------------------
;;; If rt-eval ran asynchronously after all, it returns something other
;;; than the six values. Reading that as a scheduler state would put
;;; arbitrary numbers on a time axis.
(let ((clamps-bridge-rpc::*edf-symbols* clamps-bridge-rpc::*edf-symbols*))
  ;; Stand in for the packages so that the availability check passes and
  ;; the probe is actually evaluated.
  (defpackage #:incudine (:use #:cl) (:export #:now))
  (defpackage #:incudine.edf (:use #:cl) (:export #:heap-count))
  (let ((now (intern "NOW" :incudine))
        (count (intern "HEAP-COUNT" :incudine.edf)))
    (setf (fdefinition now) (lambda () 0)
          (fdefinition count) (lambda () 0))
    ;; The probe form names rt-eval, which does not exist here, so the
    ;; evaluation fails — and that must be reported rather than swallowed.
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
