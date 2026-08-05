(load (merge-pathnames "rpc.lisp" *load-truename*))

(in-package :cl-user)

;;; 1. General path: bounding, overwriting, ordering.
(let ((state (clamps-bridge-rpc:make-sticker-state-for-repl 3)))
  (clamps-bridge-rpc:register-sticker-state-for-repl "rt" state)
  (assert (= 10 (clamps-bridge-rpc:sticker-state-record-for-repl state 10)))
  (clamps-bridge-rpc:sticker-state-record-for-repl state 20)
  (clamps-bridge-rpc:sticker-state-record-for-repl state 30)
  (clamps-bridge-rpc:sticker-state-record-for-repl state 40)
  (let* ((snapshot (clamps-bridge-rpc:sticker-snapshot-for-repl))
         (records (second (first (second snapshot))))
         (previews (mapcar #'third records)))
    (assert (equal previews '("20" "30" "40"))))
  (assert (equal (clamps-bridge-rpc:sticker-clear-for-repl) '(:ok))))

;;; 2. Sample path: unboxed ring, same ring semantics.
(let ((state (clamps-bridge-rpc:make-sticker-sample-state-for-repl 3)))
  (clamps-bridge-rpc:register-sticker-state-for-repl "meter" state)
  (assert (= 1.0d0 (clamps-bridge-rpc:sticker-state-record-sample-for-repl state 1.0d0)))
  (clamps-bridge-rpc:sticker-state-record-sample-for-repl state 2.0d0)
  (clamps-bridge-rpc:sticker-state-record-sample-for-repl state 3.0d0)
  (clamps-bridge-rpc:sticker-state-record-sample-for-repl state 4.0d0)
  (let* ((snapshot (clamps-bridge-rpc:sticker-snapshot-for-repl))
         (records (second (first (second snapshot))))
         (values* (mapcar (lambda (r) (read-from-string (third r))) records)))
    (assert (equal values* '(2.0d0 3.0d0 4.0d0))))
  (clamps-bridge-rpc:sticker-clear-for-repl))

;;; 3. Decimation: the caller calls unconditionally, the state thins out.
;;;    This is the point at which the Incudine VUG trap is avoided — a
;;;    (when ... ) in the dsp! body would drag the update of the VUG
;;;    variable into the branch.
(let ((state (clamps-bridge-rpc:make-sticker-sample-state-for-repl 8 4)))
  (clamps-bridge-rpc:register-sticker-state-for-repl "decimated" state)
  (dotimes (i 12)
    (clamps-bridge-rpc:sticker-state-record-sample-for-repl state (coerce i 'double-float)))
  (let* ((snapshot (clamps-bridge-rpc:sticker-snapshot-for-repl))
         (records (second (first (second snapshot))))
         (values* (mapcar (lambda (r) (read-from-string (third r))) records)))
    ;; i = 0, 4, 8 are kept.
    (assert (equal values* '(0.0d0 4.0d0 8.0d0))))
  (clamps-bridge-rpc:sticker-clear-for-repl))

;;; 4. Decimation 1 keeps every value.
(let ((state (clamps-bridge-rpc:make-sticker-sample-state-for-repl 8 1)))
  (dotimes (i 3)
    (clamps-bridge-rpc:sticker-state-record-sample-for-repl state (coerce i 'double-float)))
  (assert (= 3 (clamps-bridge-rpc::sticker-state-count state))))

;;; 5. The actual realtime gate: the sample path must not cons.  A boxed
;;;    double-float costs 16 bytes per call; the threshold below is far
;;;    beneath that and far above the measurement noise.
#+sbcl
(let ((state (clamps-bridge-rpc:make-sticker-sample-state-for-repl 64 441))
      (iterations 200000)
      (limit 65536))
  (declare (type fixnum iterations limit))
  ;; A warm-up run, so that one-off effects do not fall into the measurement.
  (dotimes (i 1000)
    (clamps-bridge-rpc:sticker-state-record-sample-for-repl state 0.5d0))
  (let* ((before (sb-ext:get-bytes-consed))
         (ignore (dotimes (i iterations)
                   (clamps-bridge-rpc:sticker-state-record-sample-for-repl state 0.5d0)))
         (consed (- (sb-ext:get-bytes-consed) before)))
    (declare (ignore ignore))
    (unless (< consed limit)
      (error "sticker-state-record-sample-for-repl conses ~D bytes over ~D calls ~
              (limit ~D). The DSP hot path is allocating again — probably the ~
              double-float is being boxed."
             consed iterations limit))
    (format t "sticker-state: ~D bytes over ~D sample calls~%" consed iterations)))

;;; 6. The general path stays usable for non-floating-point values.
(let ((state (clamps-bridge-rpc:make-sticker-state-for-repl 4 :decimation 2)))
  (dotimes (i 4)
    (clamps-bridge-rpc:sticker-state-record-for-repl state i))
  (assert (= 2 (clamps-bridge-rpc::sticker-state-count state))))

;;; 7. Faulty parameters are rejected, not silently swallowed.
(assert (nth-value 1 (ignore-errors (clamps-bridge-rpc:make-sticker-state-for-repl 0))))
(assert (nth-value 1 (ignore-errors (clamps-bridge-rpc:make-sticker-state-for-repl 4 :decimation 0))))
(assert (nth-value 1 (ignore-errors (clamps-bridge-rpc:make-sticker-state-for-repl 4 :element-type 'single-float))))


;;; 8. RMS path: one value per window, at the end of the window, no sample discarded.
(let ((state (clamps-bridge-rpc:make-sticker-sample-state-for-repl 8 4)))
  (clamps-bridge-rpc:register-sticker-state-for-repl "rms" state)
  ;; The first three calls only fill the accumulator.
  (dotimes (i 3) (clamps-bridge-rpc:sticker-state-record-rms-for-repl state 1.0d0))
  (assert (= 0 (clamps-bridge-rpc::sticker-state-count state)))
  ;; The fourth one closes the window: RMS of (1 1 1 1) = 1.
  (clamps-bridge-rpc:sticker-state-record-rms-for-repl state 1.0d0)
  (assert (= 1 (clamps-bridge-rpc::sticker-state-count state)))
  (assert (< (abs (- 1.0d0 (first (clamps-bridge-rpc::%sticker-state-values-oldest-first state))))
             1.0d-12))
  ;; The sign does not matter: the RMS of (1 -1 1 -1) is 1 as well.
  (dotimes (i 4)
    (clamps-bridge-rpc:sticker-state-record-rms-for-repl state (if (evenp i) 1.0d0 -1.0d0)))
  (assert (< (abs (- 1.0d0 (second (clamps-bridge-rpc::%sticker-state-values-oldest-first state))))
             1.0d-12))
  (clamps-bridge-rpc:sticker-clear-for-repl))

;;; 9. The RMS of a sine is amplitude/sqrt(2), independently of the
;;;    window position.  That is exactly what the sample path cannot do:
;;;    at 330 Hz with a window of 441 it only ever reads a single phase
;;;    point and therefore swings over the full amplitude.  The test
;;;    compares both paths on the same signal.
;;;
;;;    441 samples at 330 Hz are 3.3 periods, so not an integer multiple.
;;;    The RMS of a truncated window therefore deviates from the ideal
;;;    value by a few percent and varies slightly from window to window.
;;;    That is a property of the method, not a fault of the
;;;    implementation, and the tolerances below reflect it.
(let* ((amplitude 0.2d0)
       (window 441)
       (expected (/ amplitude (sqrt 2.0d0)))
       (rms-state (clamps-bridge-rpc:make-sticker-sample-state-for-repl 8 window))
       (raw-state (clamps-bridge-rpc:make-sticker-sample-state-for-repl 8 window))
       (increment (/ (* 2 pi 330.0d0) 44100.0d0)))
  (declare (type double-float amplitude expected increment))
  (let ((phase 0.0d0))
    (declare (type double-float phase))
    (dotimes (i (* 8 window))
      (let ((sample (* amplitude (sin phase))))
        (clamps-bridge-rpc:sticker-state-record-rms-for-repl rms-state sample)
        (clamps-bridge-rpc:sticker-state-record-sample-for-repl raw-state sample))
      (incf phase increment)))
  (let* ((rms-values (clamps-bridge-rpc::%sticker-state-values-oldest-first rms-state))
         (raw-values (clamps-bridge-rpc::%sticker-state-values-oldest-first raw-state))
         (rms-spread (- (reduce #'max rms-values) (reduce #'min rms-values)))
         (raw-spread (- (reduce #'max raw-values) (reduce #'min raw-values))))
    (assert (= 8 (length rms-values)))
    ;; Every RMS value lies within 5 % of the ideal value.
    (dolist (v rms-values)
      (assert (< (abs (- v expected)) (* 0.05d0 expected))
              () "RMS ~,6F deviates too far from ~,6F." v expected))
    ;; And the values vary hardly at all among themselves.
    (assert (< rms-spread (* 0.05d0 expected))
            () "RMS-Streuung ~,6F zu gross." rms-spread)
    ;; The sample path, by contrast, scatters over practically the whole amplitude.
    (assert (> raw-spread amplitude)
            () "Sample path only scatters by ~,6F — the comparison no longer holds."
            raw-spread)))

;;; 10. The RMS path must not cons either.
#+sbcl
(let ((state (clamps-bridge-rpc:make-sticker-sample-state-for-repl 64 441))
      (iterations 200000)
      (limit 65536))
  (declare (type fixnum iterations limit))
  (dotimes (i 1000)
    (clamps-bridge-rpc:sticker-state-record-rms-for-repl state 0.5d0))
  (let* ((before (sb-ext:get-bytes-consed))
         (ignore (dotimes (i iterations)
                   (clamps-bridge-rpc:sticker-state-record-rms-for-repl state 0.5d0)))
         (consed (- (sb-ext:get-bytes-consed) before)))
    (declare (ignore ignore))
    (unless (< consed limit)
      (error "sticker-state-record-rms-for-repl conses ~D bytes over ~D calls ~
              (Grenze ~D)."
             consed iterations limit))
    (format t "sticker-state: ~D bytes over ~D RMS calls~%" consed iterations)))


;;; 11. Incremental fetching: only what arrived since the last query.
(clamps-bridge-rpc:sticker-clear-for-repl)
(let ((state (clamps-bridge-rpc:make-sticker-sample-state-for-repl 8 1)))
  (clamps-bridge-rpc:register-sticker-state-for-repl "pull" state)
  ;; An empty ring: nothing there, sequence 0.
  (destructuring-bind (ok seq dropped values)
      (clamps-bridge-rpc:sticker-samples-since-for-repl "pull" 0)
    (declare (ignore ok))
    (assert (= 0 seq)) (assert (= 0 dropped)) (assert (null values)))
  ;; Three values, all new.
  (dotimes (i 3)
    (clamps-bridge-rpc:sticker-state-record-sample-for-repl state (coerce i 'double-float)))
  (destructuring-bind (ok seq dropped values)
      (clamps-bridge-rpc:sticker-samples-since-for-repl "pull" 0)
    (declare (ignore ok))
    (assert (= 3 seq)) (assert (= 0 dropped))
    (assert (equal values '(0.0d0 1.0d0 2.0d0))))
  ;; Nichts Neues seit Sequenz 3.
  (destructuring-bind (ok seq dropped values)
      (clamps-bridge-rpc:sticker-samples-since-for-repl "pull" 3)
    (declare (ignore ok seq dropped))
    (assert (null values)))
  ;; Two more: only those two arrive, not the whole ring.
  (dotimes (i 2)
    (clamps-bridge-rpc:sticker-state-record-sample-for-repl state (coerce (+ 3 i) 'double-float)))
  (destructuring-bind (ok seq dropped values)
      (clamps-bridge-rpc:sticker-samples-since-for-repl "pull" 3)
    (declare (ignore ok))
    (assert (= 5 seq)) (assert (= 0 dropped))
    (assert (equal values '(3.0d0 4.0d0)))))

;;; 12. Overflow is reported, not concealed. A display that draws lost
;;;     values as an unbroken course is lying.
(clamps-bridge-rpc:sticker-clear-for-repl)
(let ((state (clamps-bridge-rpc:make-sticker-sample-state-for-repl 4 1)))
  (clamps-bridge-rpc:register-sticker-state-for-repl "overflow" state)
  (dotimes (i 10)
    (clamps-bridge-rpc:sticker-state-record-sample-for-repl state (coerce i 'double-float)))
  (destructuring-bind (ok seq dropped values)
      (clamps-bridge-rpc:sticker-samples-since-for-repl "overflow" 0)
    (declare (ignore ok))
    (assert (= 10 seq))
    (assert (= 6 dropped) () "Lost values: ~D instead of 6." dropped)
    (assert (equal values '(6.0d0 7.0d0 8.0d0 9.0d0)))))

;;; 13. A ring that has been reset or newly created: SINCE is greater
;;;     than SEQUENCE. Then send everything present again instead of
;;;     computing a negative difference.
(clamps-bridge-rpc:sticker-clear-for-repl)
(let ((state (clamps-bridge-rpc:make-sticker-sample-state-for-repl 4 1)))
  (clamps-bridge-rpc:register-sticker-state-for-repl "restart" state)
  (clamps-bridge-rpc:sticker-state-record-sample-for-repl state 1.0d0)
  (destructuring-bind (ok seq dropped values)
      (clamps-bridge-rpc:sticker-samples-since-for-repl "restart" 999)
    (declare (ignore ok seq dropped))
    (assert (equal values '(1.0d0)))))

;;; 14. The limit caps the transfer and reports the rest as lost.
(clamps-bridge-rpc:sticker-clear-for-repl)
(let ((state (clamps-bridge-rpc:make-sticker-sample-state-for-repl 8 1)))
  (clamps-bridge-rpc:register-sticker-state-for-repl "limited" state)
  (dotimes (i 6)
    (clamps-bridge-rpc:sticker-state-record-sample-for-repl state (coerce i 'double-float)))
  (destructuring-bind (ok seq dropped values)
      (clamps-bridge-rpc:sticker-samples-since-for-repl "limited" 0 2)
    (declare (ignore ok seq))
    (assert (= 2 (length values)))
    (assert (= 4 dropped))
    ;; The newest, not the oldest: for a level meter the now matters more
    ;; than the back then.
    (assert (equal values '(4.0d0 5.0d0)))))

;;; 15. NaN and infinity must not go out as JSON.
(assert (= 0.0d0 (clamps-bridge-rpc::%finite-sample
                  (sb-kernel:make-double-float -524288 0))))   ; -Infinity-Bitmuster
(assert (= 0.5d0 (clamps-bridge-rpc::%finite-sample 0.5d0)))

;;; 16. Parameters without the values themselves.
(clamps-bridge-rpc:sticker-clear-for-repl)
(let ((state (clamps-bridge-rpc:make-sticker-sample-state-for-repl 16 441)))
  (clamps-bridge-rpc:register-sticker-state-for-repl "meter" state)
  (destructuring-bind (ok entries) (clamps-bridge-rpc:sticker-keys-for-repl)
    (declare (ignore ok))
    (assert (= 1 (length entries)))
    (destructuring-bind (key capacity decimation element-type sequence) (first entries)
      (assert (string= "meter" key))
      (assert (= 16 capacity))
      (assert (= 441 decimation))
      (assert (string= "double-float" element-type))
      (assert (= 0 sequence)))))

;;; 17. An unknown key returns emptiness rather than an error. The
;;;     display polls periodically; a ring that is not registered yet is
;;;     the normal case and no reason to rattle.
(destructuring-bind (ok seq dropped values)
    (clamps-bridge-rpc:sticker-samples-since-for-repl "gibtsnicht" 0)
  (declare (ignore ok))
  (assert (= 0 seq)) (assert (= 0 dropped)) (assert (null values)))


;;; A keyword passed positionally is refused, not accepted.
;;;
;;; The lambda list mixes &OPTIONAL and &KEY, which SBCL warns about with
;;; good reason: (make-sticker-state-for-repl :double-float) binds the
;;; keyword to CAPACITY. It stays that way because the positional CAPACITY
;;; is how the constructor is called throughout the documentation, and
;;; changing it would break code already written — so the CHECK-TYPE is what
;;; has to catch the mistake. Without this test the reasoning in the
;;; docstring would be a claim rather than a fact.
(dolist (wrong '(:double-float :element-type t nil))
  (assert (handler-case
              (progn (clamps-bridge-rpc:make-sticker-state-for-repl wrong) nil)
            (error () t))
          () "~S was accepted as a capacity" wrong))

;;; And a real capacity still works, positionally and with keywords.
(assert (clamps-bridge-rpc:make-sticker-state-for-repl 64))
(assert (clamps-bridge-rpc:make-sticker-state-for-repl
         64 :element-type 'double-float :decimation 2))

(format t "sticker-state: ok~%")
