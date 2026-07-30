;;;; test-spectrum.lisp
;;;;
;;;; The FFT and the column reduction of the freq scope.
;;;;
;;;; Why this needs a gate of its own: a spectrum always looks plausible.
;;;; A bin shifted by one, a forgotten window factor, a bit reversal that
;;;; is right at N=64 and wrong at N=1024 — none of that produces a
;;;; conspicuous picture.  You see peaks where peaks belong, only in the
;;;; wrong place or at the wrong height, and you believe the picture.
;;;; That is why the checks here are against quantities that are known
;;;; independently: against a naive DFT, against the known frequency of a
;;;; generated sine and against its known level.
;;;;
;;;; Run: sbcl --script lisp/test-spectrum.lisp

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

;;; ---------------------------------------------------------------------
;;; 1. FFT against a naive DFT
;;; ---------------------------------------------------------------------
;;; The only test that really checks the butterfly loop independently.
;;; The DFT next to it is written out bluntly on purpose: it shares no
;;; code with the fast version, so no single mistake can sit in both.

(defun naive-dft (values)
  (let* ((n (length values))
         (re (make-array n :element-type 'double-float :initial-element 0.0d0))
         (im (make-array n :element-type 'double-float :initial-element 0.0d0)))
    (dotimes (k n (values re im))
      (dotimes (i n)
        (let ((angle (/ (* -2.0d0 (coerce pi 'double-float) k i) n)))
          (incf (aref re k) (* (aref values i) (cos angle)))
          (incf (aref im k) (* (aref values i) (sin angle))))))))

(let* ((n 64)
       (source (make-array n :element-type 'double-float :initial-element 0.0d0))
       (state 12345))
  ;; Fixed pseudo-randomness, so that a failure is reproducible.
  (dotimes (i n)
    (setf state (mod (+ (* state 1103515245) 12345) 2147483648))
    (setf (aref source i) (- (/ (float state 1.0d0) 1073741824.0d0) 1.0d0)))
  (multiple-value-bind (want-re want-im) (naive-dft source)
    (let ((re (copy-seq source))
          (im (make-array n :element-type 'double-float :initial-element 0.0d0)))
      (clamps-bridge-rpc::%fft-forward re im)
      (dotimes (k n)
        (check (format nil "DFT comparison re[~D]" k) (aref re k) (aref want-re k) 1.0d-9)
        (check (format nil "DFT comparison im[~D]" k) (aref im k) (aref want-im k) 1.0d-9)))))

;;; And once large, because the bit reversal is forgiving at small N.
(let* ((n 1024)
       (source (make-array n :element-type 'double-float :initial-element 0.0d0)))
  (dotimes (i n)
    (setf (aref source i)
          (+ (sin (/ (* 2.0d0 (coerce pi 'double-float) 37 i) n))
             (* 0.25d0 (cos (/ (* 2.0d0 (coerce pi 'double-float) 211 i) n))))))
  (let ((re (copy-seq source))
        (im (make-array n :element-type 'double-float :initial-element 0.0d0)))
    (clamps-bridge-rpc::%fft-forward re im)
    ;; Two pure tones on bin centres: exactly two bins (together with
    ;; their mirrors) may carry energy, all others must be numerically
    ;; zero.
    (dotimes (k (floor n 2))
      (let ((magnitude (sqrt (+ (* (aref re k) (aref re k))
                                (* (aref im k) (aref im k))))))
        (cond ((= k 37) (check "Bin 37" (/ magnitude n) 0.5d0 1.0d-9))
              ((= k 211) (check "Bin 211" (/ magnitude n) 0.125d0 1.0d-9))
              (t (when (> (/ magnitude n) 1.0d-9)
                   (fail "Bin ~D carries ~,12F, should be empty" k (/ magnitude n)))))))))

;;; ---------------------------------------------------------------------
;;; 2. Fenster
;;; ---------------------------------------------------------------------
(let ((hann (clamps-bridge-rpc::%fft-window "hann" 8))
      (rect (clamps-bridge-rpc::%fft-window "rect" 8))
      (bh (clamps-bridge-rpc::%fft-window "blackman-harris" 64)))
  (check "Hann starts at 0" (aref hann 0) 0.0d0 1.0d-12)
  ;; Periodic form: the maximum sits at index N/2 and is exactly 1.
  (check "Hann maximum" (aref hann 4) 1.0d0 1.0d-12)
  (dotimes (i 8) (check "rectangle" (aref rect i) 1.0d0 1.0d-12))
  (check "Blackman-Harris maximum" (aref bh 32) 1.0d0 1.0d-9)
  (when (> (aref bh 0) 1.0d-4)
    (fail "Blackman-Harris starts at ~,8F, expected close to 0" (aref bh 0)))
  ;; The cache returns the same array, not merely an equal one.
  (unless (eq hann (clamps-bridge-rpc::%fft-window "hann" 8))
    (fail "The window cache does not take effect")))

;;; ---------------------------------------------------------------------
;;; 3. Level accuracy: a sine of amplitude 1 on a bin centre gives 0 dB
;;; ---------------------------------------------------------------------
;;; This is the assurance that gives the display its point.  Without it
;;; the dB axis is only an ordering, not a measure — and then you cannot
;;; read off a spectrum whether it is about to clip.

(defun fill-ring (key capacity generator &key (decimation 1) (n capacity))
  (let ((state (clamps-bridge-rpc:make-sticker-sample-state-for-repl
                capacity decimation)))
    (clamps-bridge-rpc:register-sticker-state-for-repl key state)
    (dotimes (i n state)
      (clamps-bridge-rpc:sticker-state-record-sample-for-repl
       state (funcall generator i)))))

(defun sine-generator (amplitude bin size)
  (lambda (i)
    (* amplitude (sin (/ (* 2.0d0 (coerce pi 'double-float) bin i) size)))))

(defun header-of (result) (second result))
(defun values-of (result) (third result))
(defun peak-freq-of (result) (nth 7 (header-of result)))
(defun peak-db-of (result) (nth 8 (header-of result)))
(defun bin-width-of (result) (nth 9 (header-of result)))
(defun warnings-of (result) (nth 10 (header-of result)))

(dolist (window '("rect" "hann" "blackman-harris"))
  (clamps-bridge-rpc:sticker-clear-for-repl)
  (fill-ring "sine" 1024 (sine-generator 1.0d0 64 1024))
  (let ((result (clamps-bridge-rpc:sticker-spectrum-for-repl
                 "sine" 1024 window 256 "log" -96.0)))
    (unless (eq (first result) :ok)
      (fail "Spectrum (~A) failed: ~A" window (second result)))
    (when (eq (first result) :ok)
      ;; Bin 64 at a resolution of 48000/1024 = 46.875 Hz -> 3000 Hz.
      (check (format nil "peak frequency ~A" window)
             (peak-freq-of result) 3000.0d0 2.0d0)
      (check (format nil "peak level ~A" window)
             (peak-db-of result) 0.0d0 0.2d0))))

;;; Half the amplitude is a good six decibels less.
(clamps-bridge-rpc:sticker-clear-for-repl)
(fill-ring "sine" 1024 (sine-generator 0.5d0 64 1024))
(let ((result (clamps-bridge-rpc:sticker-spectrum-for-repl
               "sine" 1024 "hann" 256 "log" -96.0)))
  (check "half amplitude" (peak-db-of result) -6.0206d0 0.2d0))

;;; ---------------------------------------------------------------------
;;; 4. Frequency between two bins
;;; ---------------------------------------------------------------------
;;; Without the parabola through the neighbouring bins the display snaps
;;; to the bin grid: at a resolution of 46.875 Hz a concert A would then
;;; be either 421.9 or 468.8 Hz, and the display would look decisive all
;;; the same.
(clamps-bridge-rpc:sticker-clear-for-repl)
(fill-ring "between" 2048 (sine-generator 1.0d0 21.5d0 2048))
(let ((result (clamps-bridge-rpc:sticker-spectrum-for-repl
               "between" 2048 "hann" 256 "log" -96.0)))
  ;; 21.5 * 48000/2048 = 503.9 Hz.
  (check "interpolated peak frequency" (peak-freq-of result) 503.906d0 3.0d0)
  (check "bin width" (bin-width-of result) 23.4375d0 1.0d-9))

;;; Without interpolation the value would sit on a multiple of the bin
;;; width.  That is exactly what must NOT come out here.
(let* ((result (clamps-bridge-rpc:sticker-spectrum-for-repl
                "between" 2048 "hann" 256 "log" -96.0))
       (freq (peak-freq-of result))
       (width (bin-width-of result))
       (rest* (abs (- (/ freq width) (round (/ freq width))))))
  (when (< rest* 0.2d0)
    (fail "Peak frequency ~,3F snaps to the bin grid" freq)))

;;; ---------------------------------------------------------------------
;;; 5. Silence
;;; ---------------------------------------------------------------------
(clamps-bridge-rpc:sticker-clear-for-repl)
(fill-ring "silence" 1024 (lambda (i) (declare (ignore i)) 0.0d0))
(let ((result (clamps-bridge-rpc:sticker-spectrum-for-repl
               "silence" 1024 "hann" 128 "log" -96.0)))
  (unless (= 128 (length (values-of result)))
    (fail "Silence: ~D columns instead of 128" (length (values-of result))))
  (dolist (v (values-of result))
    (unless (near v -96.0d0 1.0d-9)
      (fail "Silence shows ~,3F dB instead of the floor" v)))
  (check "silence without a peak" (peak-db-of result) -96.0d0 1.0d-9))

;;; ---------------------------------------------------------------------
;;; 6. Non-finite samples
;;; ---------------------------------------------------------------------
;;; A feedback loop running away produces NaN — that is, exactly when
;;; one is looking.  A single NaN colours the whole FFT; without handling
;;; it the display would then show silence, and that would be the most
;;; dangerous of all false statements.
(clamps-bridge-rpc:sticker-clear-for-repl)
(let ((nan (clamps-bridge-rpc::%finite-sample
            (sb-kernel:make-double-float -524288 0))))
  (declare (ignorable nan)))
(let ((state (clamps-bridge-rpc:make-sticker-sample-state-for-repl 1024 1)))
  (clamps-bridge-rpc:register-sticker-state-for-repl "dirty" state)
  (dotimes (i 1024)
    (clamps-bridge-rpc:sticker-state-record-sample-for-repl
     state (sin (/ (* 2.0d0 (coerce pi 'double-float) 64 i) 1024))))
  ;; A single value is destroyed directly in the array.
  (setf (aref (clamps-bridge-rpc::sticker-state-samples state) 500)
        (sb-kernel:make-double-float 2146435072 0)) ; +Infinity
  (let ((result (clamps-bridge-rpc:sticker-spectrum-for-repl
                 "dirty" 1024 "hann" 128 "log" -96.0)))
    (unless (eq (first result) :ok)
      (fail "Spectrum with an infinity failed hard: ~A" (second result)))
    (when (eq (first result) :ok)
      (unless (some (lambda (w) (search "non-finite" w)) (warnings-of result))
        (fail "No warning about non-finite samples"))
      (unless (> (peak-db-of result) -20.0d0)
        (fail "After an infinity the spectrum shows ~,1F dB — looks like silence"
              (peak-db-of result))))))

;;; ---------------------------------------------------------------------
;;; 7. Error paths
;;; ---------------------------------------------------------------------
;;; The order of the checks is itself an assurance: the missing ring is
;;; reported first, otherwise a typo in the key would earn a message
;;; about the FFT length.
(clamps-bridge-rpc:sticker-clear-for-repl)
(fill-ring "ok-ring" 2048 (lambda (i) (declare (ignore i)) 0.0d0))
(dolist (case* (list (list "unknown" 1024 "No ring")
                     (list "ok-ring" 1000 "power of two")
                     (list "ok-ring" 32 "outside")
                     (list "ok-ring" 32768 "outside")))
  (destructuring-bind (key size fragment) case*
    (let ((result (clamps-bridge-rpc:sticker-spectrum-for-repl key size)))
      (unless (and (eq (first result) :error)
                   (search fragment (second result)))
        (fail "~S/~D: ~S does not contain ~S" key size result fragment)))))

;;; A ring that is too small and a ring that is not full yet are two
;;; different situations, and the display should be able to tell them
;;; apart: one is a configuration error, the other passes by itself.
(let ((state (clamps-bridge-rpc:make-sticker-sample-state-for-repl 256 1)))
  (clamps-bridge-rpc:register-sticker-state-for-repl "small" state)
  (let ((result (clamps-bridge-rpc:sticker-spectrum-for-repl "small" 1024)))
    (unless (search "holds" (second result))
      (fail "A ring that is too small reports ~S" result))))
(let ((state (clamps-bridge-rpc:make-sticker-sample-state-for-repl 1024 1)))
  (clamps-bridge-rpc:register-sticker-state-for-repl "young" state)
  (dotimes (i 100)
    (clamps-bridge-rpc:sticker-state-record-sample-for-repl state 0.0d0))
  (let ((result (clamps-bridge-rpc:sticker-spectrum-for-repl "young" 1024)))
    (unless (search "only 100" (second result))
      (fail "A half-filled ring reports ~S" result))))

;;; ---------------------------------------------------------------------
;;; 8. Axis and column reduction
;;; ---------------------------------------------------------------------
(clamps-bridge-rpc:sticker-clear-for-repl)
(fill-ring "axis" 2048 (sine-generator 1.0d0 128 2048))
(let* ((result (clamps-bridge-rpc:sticker-spectrum-for-repl
                "axis" 2048 "hann" 200 "log" -96.0))
       (header (header-of result))
       (f-min (nth 4 header))
       (f-max (nth 5 header))
       (values* (values-of result)))
  (unless (string= (nth 3 header) "log")
    (fail "Mode ~S instead of log" (nth 3 header)))
  (check "upper bound is Nyquist" f-max 24000.0d0 1.0d-9)
  (check "Lower bound is the bin width" f-min 23.4375d0 1.0d-9)
  (unless (= 200 (length values*))
    (fail "~D columns instead of 200" (length values*)))
  ;; The tone is at 3000 Hz.  The column standing there must be the
  ;; loudest — that is the real assurance of the column reduction, and it
  ;; is precisely the one that, with an off-by-one index error, would
  ;; still look like a clean picture.
  (let* ((loudest (position (reduce #'max values*) values*))
         (edge-lo (clamps-bridge-rpc::%spectrum-edge loudest 200 f-min f-max t))
         (edge-hi (clamps-bridge-rpc::%spectrum-edge (1+ loudest) 200 f-min f-max t)))
    (unless (and (<= edge-lo 3000.0d0) (>= edge-hi 2900.0d0))
      (fail "Loudest column covers ~,1F..~,1F Hz, the tone is at 3000 Hz"
            edge-lo edge-hi))))

;;; The linear axis starts at 0 and divides evenly.
(let* ((result (clamps-bridge-rpc:sticker-spectrum-for-repl
                "axis" 2048 "hann" 100 "lin" -96.0))
       (header (header-of result)))
  (unless (string= (nth 3 header) "lin")
    (fail "Mode ~S instead of lin" (nth 3 header)))
  (check "linear lower bound" (nth 4 header) 0.0d0 1.0d-12)
  (check "linear column edge"
         (clamps-bridge-rpc::%spectrum-edge 50 100 0.0d0 24000.0d0 nil)
         12000.0d0 1.0d-9))

;;; The edges must rise strictly in both modes — otherwise the display
;;; draws columns in swapped order without anything being missing.
(dolist (log-p (list t nil))
  (let ((previous -1.0d0))
    (dotimes (c 257)
      (let ((edge (clamps-bridge-rpc::%spectrum-edge
                   c 256 (if log-p 20.0d0 0.0d0) 24000.0d0 log-p)))
        (unless (> edge previous)
          (fail "Edge ~D (~A) falls: ~,4F after ~,4F"
                c (if log-p "log" "lin") edge previous))
        (setf previous edge)))))

;;; ---------------------------------------------------------------------
;;; 9. Decimated ring
;;; ---------------------------------------------------------------------
;;; A decimated ring is not a spectrum: without a pre-filter everything
;;; above half the effective rate folds down and looks like a genuine
;;; partial there.  That cannot be undone, so it has to be stated.
(clamps-bridge-rpc:sticker-clear-for-repl)
(fill-ring "slow" 1024 (sine-generator 1.0d0 64 1024) :decimation 4 :n 4096)
(let ((result (clamps-bridge-rpc:sticker-spectrum-for-repl
               "slow" 1024 "hann" 128 "log" -96.0)))
  (check "effective rate" (nth 1 (header-of result)) 12000.0d0 1.0d-9)
  (unless (some (lambda (w) (search "decimated" w)) (warnings-of result))
    (fail "No warning about the decimated ring: ~S" (warnings-of result))))

;;; ---------------------------------------------------------------------
;;; 10. Unknown sample rate
;;; ---------------------------------------------------------------------
;;; In the gate Incudine is not loaded, so the rate is a guess.  Exactly
;;; then the warning has to be there.
(clamps-bridge-rpc:sticker-clear-for-repl)
(fill-ring "guess" 1024 (sine-generator 1.0d0 64 1024))
(let ((result (clamps-bridge-rpc:sticker-spectrum-for-repl "guess" 1024)))
  (unless (some (lambda (w) (search "Sample rate unknown" w)) (warnings-of result))
    (fail "No warning about the guessed sample rate: ~S" (warnings-of result))))


;;; ---------------------------------------------------------------------
;;; 11. Spectrogram: the absolute frame grid
;;; ---------------------------------------------------------------------
;;; The assurance that makes a time axis possible at all. Frame F always
;;; covers the samples [F*HOP - FFT-SIZE, F*HOP), whoever asks and
;;; whenever — so two consecutive requests can neither return the same
;;; column twice nor leave a gap. Without it the column spacing would be
;;; however long the round trip took, and the axis would be unlabellable.
;;;
;;; None of this is visible in the picture. A spectrogram with a duplicated
;;; or missing column looks exactly like one without.

(defun spectro-header (result) (second result))
(defun spectro-frames (result) (third result))
(defun spectro-frame-index (result) (nth 9 (spectro-header result)))
(defun spectro-seconds (result) (nth 10 (spectro-header result)))
(defun spectro-dropped (result) (nth 11 (spectro-header result)))

(clamps-bridge-rpc:sticker-clear-for-repl)
(let ((state (clamps-bridge-rpc:make-sticker-sample-state-for-repl 8192 1)))
  (clamps-bridge-rpc:register-sticker-state-for-repl "gram" state)
  ;; 4096 samples: with hop 512 and a 1024-point window, frames 2..8 are
  ;; complete and inside the ring.
  (dotimes (i 4096)
    (clamps-bridge-rpc:sticker-state-record-sample-for-repl
     state (sin (/ (* 2.0d0 (coerce pi 'double-float) 64 i) 1024))))

  ;; First request: the NEWEST frames, not everything since the start.
  ;; On opening, the present is what matters.
  (let ((first (clamps-bridge-rpc:sticker-spectrogram-for-repl
                "gram" 1024 "hann" 64 "log" -96.0 0 512 4)))
    (unless (eq (first first) :ok)
      (fail "Spectrogram failed: ~A" (second first)))
    (check "four frames delivered" (length (spectro-frames first)) 4 0.5)
    (check "newest frame index" (spectro-frame-index first) 8 0.5)
    (check "seconds per frame" (spectro-seconds first) (/ 512.0d0 48000.0d0) 1.0d-12)
    (dolist (frame (spectro-frames first))
      (unless (= 64 (length frame))
        (fail "Frame has ~D columns instead of 64" (length frame))))

    ;; Nothing new: no frames, and the index must not move. Otherwise the
    ;; client would advance past frames it never received.
    (let ((again (clamps-bridge-rpc:sticker-spectrogram-for-repl
                  "gram" 1024 "hann" 64 "log" -96.0 8 512 4)))
      (check "no new frames" (length (spectro-frames again)) 0 0.5)
      (check "index stays" (spectro-frame-index again) 8 0.5)
      (check "nothing dropped" (spectro-dropped again) 0 0.5))

    ;; Exactly one hop further: exactly one new frame, and it is frame 9.
    (dotimes (i 512)
      (clamps-bridge-rpc:sticker-state-record-sample-for-repl
       state (sin (/ (* 2.0d0 (coerce pi 'double-float) 64 (+ 4096 i)) 1024))))
    (let ((next (clamps-bridge-rpc:sticker-spectrogram-for-repl
                 "gram" 1024 "hann" 64 "log" -96.0 8 512 4)))
      (check "one hop, one frame" (length (spectro-frames next)) 1 0.5)
      (check "and it is frame 9" (spectro-frame-index next) 9 0.5)
      (check "still nothing dropped" (spectro-dropped next) 0 0.5))

    ;; Half a hop further: NO new frame. The grid is absolute, not
    ;; "whatever has arrived since".
    (dotimes (i 256)
      (clamps-bridge-rpc:sticker-state-record-sample-for-repl state 0.0d0))
    (let ((half (clamps-bridge-rpc:sticker-spectrogram-for-repl
                 "gram" 1024 "hann" 64 "log" -96.0 9 512 4)))
      (check "half a hop yields nothing" (length (spectro-frames half)) 0 0.5)
      (check "index unmoved" (spectro-frame-index half) 9 0.5))))

;;; A frame that fell out of the ring is REPORTED, not passed over. This is
;;; the one failure the eye cannot catch: without the count, everything
;;; after the gap is misdated and the picture still looks continuous.
(clamps-bridge-rpc:sticker-clear-for-repl)
(let ((state (clamps-bridge-rpc:make-sticker-sample-state-for-repl 2048 1)))
  (clamps-bridge-rpc:register-sticker-state-for-repl "small" state)
  (dotimes (i 2048)
    (clamps-bridge-rpc:sticker-state-record-sample-for-repl state 0.1d0))
  (let ((start (clamps-bridge-rpc:sticker-spectrogram-for-repl
                "small" 1024 "hann" 32 "log" -96.0 0 256 2)))
    (check "starting index" (spectro-frame-index start) 8 0.5)
    ;; Overrun the ring completely: every frame between then and now is
    ;; gone.
    (dotimes (i 4096)
      (clamps-bridge-rpc:sticker-state-record-sample-for-repl state 0.2d0))
    (let ((late (clamps-bridge-rpc:sticker-spectrogram-for-repl
                 "small" 1024 "hann" 32 "log" -96.0 8 256 2)))
      (unless (> (spectro-dropped late) 0)
        (fail "Overrun ring reports ~D dropped frames" (spectro-dropped late)))
      (unless (> (spectro-frame-index late) 8)
        (fail "Index did not advance despite new data: ~D"
              (spectro-frame-index late))))))

;;; The hop is clamped into 16..FFT-SIZE. A hop larger than the window
;;; would leave holes in the analysis; 0 or a negative one would loop.
(clamps-bridge-rpc:sticker-clear-for-repl)
(fill-ring "clamp" 4096 (sine-generator 1.0d0 64 1024))
(dolist (case* (list (list 0 16) (list -5 16) (list 99999 1024) (list 256 256)))
  (destructuring-bind (given expected) case*
    (let ((result (clamps-bridge-rpc:sticker-spectrogram-for-repl
                   "clamp" 1024 "hann" 32 "log" -96.0 0 given 2)))
      (check (format nil "hop ~D clamped" given)
             (nth 8 (spectro-header result)) expected 0.5))))

;;; The spectrogram and the scope must agree about the frequency axis: the
;;; frame ending at the newest sample IS the scope's spectrum. Two separate
;;; computations of the same thing is exactly how a scope and a
;;; spectrogram come to place a partial in two different rows.
(let* ((scope (clamps-bridge-rpc:sticker-spectrum-for-repl
               "clamp" 1024 "hann" 32 "log" -96.0))
       (gram (clamps-bridge-rpc:sticker-spectrogram-for-repl
              "clamp" 1024 "hann" 32 "log" -96.0 0 1024 1))
       (scope-header (header-of scope))
       (gram-header (spectro-header gram)))
  (check "same lower bound" (nth 4 gram-header) (nth 4 scope-header) 1.0d-12)
  (check "same upper bound" (nth 5 gram-header) (nth 5 scope-header) 1.0d-12)
  (check "same bin width" (nth 7 gram-header) (nth 9 scope-header) 1.0d-12)
  (let ((frame (first (spectro-frames gram))))
    (unless frame (fail "Spectrogram delivered no frame for the comparison"))
    (when frame
      (loop for a in frame for b in (values-of scope) for c from 0
            do (check (format nil "column ~D identical" c) a b 1.0d-9)))))


;;; The assurance that actually pins the grid down: frame F has to CONTAIN
;;; the samples of frame F.
;;;
;;; The checks above compare indices and counts, and a first version of
;;; this file stopped there. It let a mutation through that read every
;;; window from the newest end of the ring instead of from the absolute
;;; position — because the test signal was a steady sine, so every window
;;; looked alike and no content check could tell them apart. That is the
;;; same class of mistake as a test that never asserts: it runs, it passes,
;;; it checks nothing.
;;;
;;; So the signal now changes with time. Each segment of 512 samples
;;; carries a different tone; with FFT-SIZE = HOP = 512, frame F covers
;;; exactly segment F-1, and its peak frequency says which one it saw.
(clamps-bridge-rpc:sticker-clear-for-repl)
(let ((state (clamps-bridge-rpc:make-sticker-sample-state-for-repl 8192 1))
      (bins #(8 16 32 64 96 128 160 192)))
  (clamps-bridge-rpc:register-sticker-state-for-repl "steps" state)
  (dotimes (segment (length bins))
    (let ((bin (aref bins segment)))
      (dotimes (i 512)
        (clamps-bridge-rpc:sticker-state-record-sample-for-repl
         state (sin (/ (* 2.0d0 (coerce pi 'double-float) bin i) 512))))))
  ;; Frames 1..8 exist; frame F saw segment F-1.
  (let* ((result (clamps-bridge-rpc:sticker-spectrogram-for-repl
                  "steps" 512 "rect" 256 "lin" -96.0 0 512 8))
         (frames (spectro-frames result))
         (bin-width (nth 7 (spectro-header result)))
         (f-max (nth 5 (spectro-header result)))
         (columns 256))
    (check "eight step frames" (length frames) 8 0.5)
    (loop for frame in frames
          for segment from 0
          do (let* ((loudest (position (reduce #'max frame) frame))
                    (lo (clamps-bridge-rpc::%spectrum-edge
                         loudest columns 0.0d0 f-max nil))
                    (hi (clamps-bridge-rpc::%spectrum-edge
                         (1+ loudest) columns 0.0d0 f-max nil))
                    (want (* (aref bins segment) bin-width)))
               ;; The loudest column of frame F+1 must cover the frequency
               ;; of segment F. If the windows were read from the wrong
               ;; place, the tones appear in the wrong frames — and the
               ;; picture still looks like a clean staircase.
               (unless (and (<= lo want) (>= hi want))
                 (fail "Frame ~D covers ~,1F..~,1F Hz, segment ~D is at ~,1F Hz"
                       (1+ segment) lo hi segment want))))))

;;; Error paths are the scope's, because both go through the same checks.
(let ((result (clamps-bridge-rpc:sticker-spectrogram-for-repl "nope" 1024)))
  (unless (and (eq (first result) :error) (search "No ring" (second result)))
    (fail "Unknown ring in the spectrogram reports ~S" result)))

(if (> *failed* 0)
    (progn (format t "~%~D test(s) failed.~%" *failed*)
           (sb-ext:exit :code 1))
    (format t "ok — FFT checked against the DFT, level and frequency true to scale, ~
column reduction hits the tone, NaN and decimation are visible, ~
spectrogram grid is absolute and gaps are reported~%"))
