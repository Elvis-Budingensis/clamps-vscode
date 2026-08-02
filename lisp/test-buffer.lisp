;;;; test-buffer.lisp — the waveform reduction.
;;;;
;;;; What is checked here is one thing above all: that the reduction does
;;;; not LOSE anything it is meant to show.
;;;;
;;;; A waveform view exists to make visible what a level meter cannot: a
;;;; single clipped sample, a click, a DC offset, the difference between a
;;;; loud passage and a compressed one. Every one of those is destroyed by
;;;; the two obvious shortcuts:
;;;;
;;;;   - Reducing by MAXIMUM per column, as the spectrum does. Then the
;;;;     lower half of the signal disappears and a symmetric waveform comes
;;;;     out as a one-sided envelope. It still looks like a waveform.
;;;;   - Decimating by STEPPING — reading every Nth sample. Then a single
;;;;     clipped sample between two steps is invisible, and a click is
;;;;     nothing but that.
;;;;
;;;; Both mistakes produce a picture that looks right. So the tests below
;;;; use signals in which a wrong reduction is arithmetically detectable:
;;;; an asymmetric waveform, a single spike, a DC offset.
;;;;
;;;; Run: sbcl --script lisp/test-buffer.lisp

(load (merge-pathnames "rpc.lisp" *load-truename*))

(in-package :cl-user)

(defvar *failed* 0)

(defun fail (format &rest args)
  (incf *failed*)
  (format t "FAILED ~?~%" format args))

(defun near (a b tolerance)
  (< (abs (- (float a 1.0d0) (float b 1.0d0))) tolerance))

(defmacro check (name a b tolerance)
  `(let ((got ,a) (want ,b))
     (unless (near got want ,tolerance)
       (fail "~A: ~,6F instead of ~,6F (tolerance ~,6F)" ,name got want ,tolerance))))

(defvar *probe* nil)

(defun outline (obj &rest args)
  "Runs the RPC against OBJ, which it binds to a variable the expression
names. The detour through an expression is deliberate: that is how the
client calls it, so the test exercises the reading and evaluation too, not
only the reduction."
  (setf *probe* obj)
  (apply #'clamps-bridge-rpc:buffer-outline-for-repl "cl-user::*probe*" args))

(defun header-of (r) (second r))
(defun columns-of (r) (third r))
(defun frames-of (r) (nth 0 (header-of r)))
(defun peak-of (r) (nth 8 (header-of r)))
(defun rms-of (r) (nth 9 (header-of r)))
(defun clipped-of (r) (nth 10 (header-of r)))
(defun warnings-of (r) (nth 11 (header-of r)))

;;; ---------------------------------------------------------------------
;;; 1. Minimum AND maximum — the lower half must not vanish
;;; ---------------------------------------------------------------------
;;; A sine reduced by maximum alone yields columns whose minimum is 0.
;;; With min/max the envelope is symmetric. This is the assurance that
;;; separates a waveform from an envelope follower.
;; 128 periods over 4096 samples and 64 columns: 64 samples per column,
;; two full periods each. Fewer periods and a column would cover less than
;; one, so it could not reach +-1 and the expectation below would be wrong
;; rather than the code.
(let* ((n 4096)
       (v (make-array n :element-type 'double-float)))
  (dotimes (i n)
    (setf (aref v i) (sin (/ (* 2.0d0 (coerce pi 'double-float) 128 i) n))))
  (let* ((r (outline v "CL-USER" 0 -1 64))
         (cols (columns-of r)))
    (unless (eq (first r) :ok) (fail "Sine outline failed: ~A" (second r)))
    (check "column count" (length cols) 64 0.5)
    ;; Every column of a full-scale sine reaches close to +1 and -1.
    (loop for (lo hi rms) in cols
          for c from 0
          do (progn
               (unless (< lo -0.9d0)
                 (fail "Column ~D has a minimum of ~,4F — the lower half is missing"
                       c lo))
               (unless (> hi 0.9d0)
                 (fail "Column ~D has a maximum of only ~,4F" c hi))
               ;; RMS of a sine is 1/sqrt(2).
               (check (format nil "RMS of column ~D" c) rms 0.7071d0 0.05d0)))))

;;; ---------------------------------------------------------------------
;;; 2. A single spike survives the reduction
;;; ---------------------------------------------------------------------
;;; The actual reason for a waveform view. One sample at full scale among
;;; a hundred thousand quiet ones has to be visible — in the column, in the
;;; peak and in the clipping count. Stepping decimation would lose all
;;; three and the picture would look clean.
(let* ((n 100000)
       (v (make-array n :element-type 'double-float :initial-element 0.01d0)))
  (setf (aref v 54321) 1.0d0)
  (let* ((r (outline v "CL-USER" 0 -1 100))
         (cols (columns-of r))
         (column (floor (* 54321 100) n)))
    (check "peak found" (peak-of r) 1.0d0 1.0d-9)
    (check "one clipped sample" (clipped-of r) 1 0.5)
    (unless (some (lambda (w) (search "full scale" w)) (warnings-of r))
      (fail "No warning about the clipped sample: ~S" (warnings-of r)))
    (let ((hi (second (nth column cols))))
      (unless (> hi 0.99d0)
        (fail "The spike is not in its column: maximum ~,4F in column ~D"
              hi column)))
    ;; And it is in EXACTLY one column, not smeared across several.
    (let ((loud (count-if (lambda (c) (> (second c) 0.5d0)) cols)))
      (check "the spike occupies one column" loud 1 0.5))))

;;; ---------------------------------------------------------------------
;;; 3. A DC offset is visible as an asymmetric envelope
;;; ---------------------------------------------------------------------
;;; With min/max the whole envelope sits above zero, which is exactly what
;;; one wants to see. Reduced by absolute value it would be indistinguishable
;;; from a symmetric signal of the same amplitude.
(let* ((n 2048)
       (v (make-array n :element-type 'double-float)))
  ;; 64 periods over 2048 samples with 32 columns: two periods per column.
  (dotimes (i n)
    (setf (aref v i) (+ 0.5d0 (* 0.2d0 (sin (/ (* 2.0d0 (coerce pi 'double-float) 64 i) n))))))
  (let ((cols (columns-of (outline v "CL-USER" 0 -1 32))))
    (loop for (lo hi) in cols
          for c from 0
          do (progn
               (unless (> lo 0.2d0)
                 (fail "Column ~D reaches down to ~,4F — the offset is lost" c lo))
               (unless (< hi 0.8d0)
                 (fail "Column ~D reaches up to ~,4F" c hi))))))

;;; ---------------------------------------------------------------------
;;; 4. Peak and RMS say different things
;;; ---------------------------------------------------------------------
;;; The point of drawing both. A square wave and a sine of the same peak
;;; have clearly different RMS; a picture showing only the envelope would
;;; make them look alike.
(let* ((n 4096)
       (sine (make-array n :element-type 'double-float))
       (square (make-array n :element-type 'double-float)))
  (dotimes (i n)
    (let ((phase (sin (/ (* 2.0d0 (coerce pi 'double-float) 256 i) n))))
      (setf (aref sine i) phase
            (aref square i) (if (>= phase 0) 1.0d0 -1.0d0))))
  (let ((sine-r (outline sine "CL-USER" 0 -1 32))
        (square-r (outline square "CL-USER" 0 -1 32)))
    (check "peak of the sine" (peak-of sine-r) 1.0d0 0.01d0)
    (check "peak of the square" (peak-of square-r) 1.0d0 0.01d0)
    (check "RMS of the sine" (rms-of sine-r) 0.7071d0 0.01d0)
    (check "RMS of the square" (rms-of square-r) 1.0d0 0.01d0)
    (unless (> (rms-of square-r) (+ 0.2d0 (rms-of sine-r)))
      (fail "Square and sine are not distinguishable by RMS: ~,4F vs ~,4F"
            (rms-of square-r) (rms-of sine-r)))))

;;; ---------------------------------------------------------------------
;;; 5. Ranges, clamping and edge cases
;;; ---------------------------------------------------------------------
(let* ((n 1000)
       (v (make-array n :element-type 'double-float :initial-element 0.0d0)))
  ;; The second half is loud, the first is silent: a range request has to
  ;; be able to tell them apart, otherwise zooming shows the wrong place.
  (loop for i from 500 below n do (setf (aref v i) 0.8d0))
  (check "silent half" (peak-of (outline v "CL-USER" 0 500 32)) 0.0d0 1.0d-9)
  (check "loud half" (peak-of (outline v "CL-USER" 500 1000 32)) 0.8d0 1.0d-9)
  ;; END = -1 means to the end.
  (check "minus one is the end" (nth 5 (header-of (outline v "CL-USER" 0 -1 32)))
         1000 0.5)
  ;; More columns than samples must not produce empty ones: the display
  ;; would draw gaps that are not in the signal.
  (let* ((r (outline v "CL-USER" 0 10 512))
         (cols (columns-of r)))
    (unless (<= (length cols) 10)
      (fail "~D columns for 10 samples" (length cols)))
    (check "columns capped" (nth 6 (header-of r)) (length cols) 0.5))
  ;; Nonsensical ranges are clamped rather than signalled.
  (dolist (case* (list (list -50 -1) (list 0 999999) (list 900 100)))
    (destructuring-bind (from to) case*
      (let ((r (outline v "CL-USER" from to 16)))
        (unless (eq (first r) :ok)
          (fail "Range ~D..~D fails instead of clamping: ~A" from to (second r)))))))

;;; ---------------------------------------------------------------------
;;; 7. The package of the file is not the package of the REPL
;;; ---------------------------------------------------------------------
;;; The kind of failure where both sides are right and neither can
;;; proceed: at a CLAMPS> prompt, (defparameter *buf* ...) makes
;;; clamps::*buf*. A display taking its package from a file without an
;;; (in-package ...) form falls back to COMMON-LISP-USER and reports
;;; "*buf* is unbound" — truthfully, about a different symbol of the same
;;; name.
;;;
;;; A bare symbol that is unbound in the named package is now looked for in
;;; the others, and where it was found is stated rather than assumed.
(defpackage #:buffer-test-elsewhere (:use #:cl))
(let ((sym (intern "*OTHER-PROBE*" '#:buffer-test-elsewhere)))
  (proclaim (list 'special sym))
  (setf (symbol-value sym)
        (let ((v (make-array 200 :element-type 'double-float
                                 :initial-element 0.5d0)))
          (setf (aref v 10) 1.0d0)
          v))
  (let ((r (clamps-bridge-rpc:buffer-outline-for-repl
            "*other-probe*" "COMMON-LISP-USER" 0 -1 16)))
    (unless (eq (first r) :ok)
      (fail "A symbol from another package is not found: ~A" (second r)))
    (when (eq (first r) :ok)
      (check "the values come from the other package" (peak-of r) 1.0d0 1.0d-9)
      ;; And it SAYS so. Silently reaching into another package would be
      ;; worse than the error: two variables of the same name in two
      ;; packages are a normal situation, and which one is on screen must
      ;; not be a guess.
      (unless (some (lambda (w) (search "BUFFER-TEST-ELSEWHERE" w))
                    (warnings-of r))
        (fail "The display does not say which package it took: ~S"
              (warnings-of r))))))

;;; A name that exists nowhere still fails, and says so.
(let ((r (clamps-bridge-rpc:buffer-outline-for-repl
          "*definitely-nowhere*" "COMMON-LISP-USER")))
  (unless (eq (first r) :error)
    (fail "An unknown name yields ~S instead of an error" r)))

;;; A QUALIFIED name is not searched for elsewhere: it says what it means.
(let ((r (clamps-bridge-rpc:buffer-outline-for-repl
          "cl-user::*other-probe*" "COMMON-LISP-USER")))
  (unless (eq (first r) :error)
    (fail "A qualified name was resolved in another package: ~S" r)))

;;; ---------------------------------------------------------------------
;;; 6. Things that are not buffers
;;; ---------------------------------------------------------------------
(dolist (case* (list (list "42" "not a buffer")
                     (list "\"text\"" "not a buffer")
                     (list "'sym" "not a buffer")))
  (destructuring-bind (expr fragment) case*
    (let ((r (clamps-bridge-rpc:buffer-outline-for-repl expr "CL-USER")))
      (unless (and (eq (first r) :error) (search fragment (second r)))
        (fail "~A reports ~S instead of ~S" expr r fragment)))))

;;; A syntax error is reported, not crashed on.
(let ((r (clamps-bridge-rpc:buffer-outline-for-repl "(((" "CL-USER")))
  (unless (eq (first r) :error)
    (fail "A syntax error yields ~S" r)))

;;; And #. must not run: a display refresh is not a way to execute code.
(defparameter *ran* nil)
(let ((r (clamps-bridge-rpc:buffer-outline-for-repl
          "#.(setf cl-user::*ran* t)" "CL-USER")))
  (declare (ignore r))
  (when *ran*
    (fail "read-eval ran during a buffer outline — a display refresh must not ~
execute code")))

;;; A plain vector says that its time axis is in frames, rather than
;;; inventing a sample rate.
(let ((r (outline (make-array 100 :element-type 'double-float
                                 :initial-element 0.0d0)
                  "CL-USER" 0 -1 16)))
  (unless (some (lambda (w) (search "frames" w)) (warnings-of r))
    (fail "No note about the missing sample rate: ~S" (warnings-of r))))

(if (> *failed* 0)
    (progn (format t "~%~D test(s) failed.~%" *failed*)
           (sb-ext:exit :code 1))
    (format t "ok — waveform reduction keeps both halves, a single spike ~
survives, peak and RMS stay distinguishable~%"))
