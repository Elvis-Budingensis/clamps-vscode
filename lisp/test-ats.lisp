;;;; test-ats.lisp — the ATS reader.
;;;;
;;;; The reason this file can exist at all: ATS is a defined binary format,
;;;; so the test can WRITE files with known content and read them back. For
;;;; the audio views that was impossible — a spectrum can only be checked
;;;; against arithmetic, a node tree not at all without Incudine. Here the
;;;; expected answer is known exactly, down to the last double.
;;;;
;;;; What is checked, in order of how badly it would fail unnoticed:
;;;;
;;;;   - The layout. Every number after the header is a double at a
;;;;     computed offset. Get the stride wrong by one and the file still
;;;;     reads, still yields plausible frequencies and amplitudes, and
;;;;     draws a perfectly convincing analysis of a sound that is not in
;;;;     the file. The length check makes this impossible rather than
;;;;     unlikely.
;;;;   - Byte order. ATS files carry a magic number precisely because they
;;;;     travel between machines. Read big-endian data little-endian and
;;;;     everything becomes enormous or denormal — visible, but only if
;;;;     somebody looks.
;;;;   - The column reduction. A partial that dies and is reborn at another
;;;;     frequency must not be drawn through the middle.
;;;;
;;;; Run: sbcl --script lisp/test-ats.lisp

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

;;; --- Writing ATS files -------------------------------------------------
;;; Deliberately written out here rather than shared with the reader: a
;;; writer built from the reader's own idea of the layout would agree with
;;; it however wrong both were.

(defun double-bytes (x big-endian-p)
  (let ((bits (ldb (byte 64 0) (sb-kernel:double-float-bits (float x 1.0d0))))
        (out (make-array 8 :element-type '(unsigned-byte 8))))
    (dotimes (i 8 out)
      (setf (aref out (if big-endian-p i (- 7 i)))
            (ldb (byte 8 (* 8 (- 7 i))) bits)))))

(defun write-ats (path &key (sample-rate 44100.0d0) (frame-size 128.0d0)
                            (window-size 512.0d0) (type 1)
                            partials-data (noise-data nil)
                            (duration 1.0d0) big-endian-p)
  "PARTIALS-DATA is a list of partials, each a list of frames, each frame
   a list (amp freq [phase]). NOISE-DATA is a list of frames, each a list
   of 25 values."
  (let* ((partials (length partials-data))
         (frames (length (first partials-data)))
         (stride (if (member type '(2 4)) 3 2))
         (has-noise (member type '(3 4))))
    (with-open-file (out path :direction :output :element-type '(unsigned-byte 8)
                              :if-exists :supersede)
      (flet ((emit (x) (write-sequence (double-bytes x big-endian-p) out)))
        (emit 123.0d0) (emit sample-rate) (emit frame-size) (emit window-size)
        (emit (float partials 1.0d0)) (emit (float frames 1.0d0))
        ;; max-amplitude and max-frequency are COMPUTED, not filled in with
        ;; a round number. Written flat as 1.0 and 20000.0, every file
        ;; produced here would contradict its own header, and the reader's
        ;; cross-check would rightly complain about all of them.
        (emit (reduce #'max (mapcar (lambda (p) (reduce #'max (mapcar #'first p)))
                                    partials-data)
                      :initial-value 0.0d0))
        (emit (reduce #'max (mapcar (lambda (p) (reduce #'max (mapcar #'second p)))
                                    partials-data)
                      :initial-value 0.0d0))
        (emit duration) (emit (float type 1.0d0))
        (dotimes (f frames)
          (emit (* duration (/ f (max 1 frames))))
          (dotimes (p partials)
            (let ((frame (nth f (nth p partials-data))))
              (emit (first frame))
              (emit (second frame))
              (when (= stride 3) (emit (or (third frame) 0.0d0)))))
          (when has-noise
            (let ((bands (nth f noise-data)))
              (dotimes (b 25) (emit (or (nth b bands) 0.0d0))))))))
    path))

(defun header-of (r) (second r))
(defun partials-of (r) (third r))
(defun noise-of (r) (fourth r))
(defun warnings-of (r) (nth 13 (header-of r)))

(defparameter *tmp*
  (merge-pathnames "clamps-ats-test.ats"
                   (pathname (concatenate 'string
                                          (or (sb-ext:posix-getenv "TMPDIR") "/tmp")
                                          "/"))))

;;; ---------------------------------------------------------------------
;;; 1. A file written here reads back exactly
;;; ---------------------------------------------------------------------
;;; Two partials, constant and unmistakably different. If the stride were
;;; wrong, partial 0 would carry partial 1's numbers or a mixture.
(let ((data (list (loop repeat 40 collect (list 0.8d0 440.0d0))
                  (loop repeat 40 collect (list 0.2d0 880.0d0)))))
  (write-ats *tmp* :type 1 :partials-data data)
  (let* ((r (clamps-bridge-rpc:ats-outline-for-repl (namestring *tmp*) 10 128))
         (h (header-of r)))
    (unless (eq (first r) :ok) (fail "Reading failed: ~A" (second r)))
    (when (eq (first r) :ok)
      (check "sample rate" (nth 0 h) 44100.0d0 1.0d-9)
      (check "partial count" (nth 3 h) 2 0.5)
      (check "frame count" (nth 4 h) 40 0.5)
      (check "type" (nth 8 h) 1 0.5)
      (check "columns" (nth 9 h) 10 0.5)
      (check "no phase" (nth 11 h) 0 0.5)
      (check "no noise" (nth 12 h) 0 0.5)
      (let ((first-partial (first (partials-of r)))
            (second-partial (second (partials-of r))))
        (check "partial 0 index" (first first-partial) 0 0.5)
        (check "partial 0 peak" (second first-partial) 0.8d0 1.0d-9)
        (check "partial 0 mean frequency" (third first-partial) 440.0d0 1.0d-6)
        (check "partial 1 mean frequency" (third second-partial) 880.0d0 1.0d-6)
        ;; 20*log10(0.8) = -1.938, 20*log10(0.2) = -13.979
        (dolist (a (fifth first-partial))
          (check "partial 0 level" a -1.938d0 0.01d0))
        (dolist (a (fifth second-partial))
          (check "partial 1 level" a -13.979d0 0.01d0))
        (dolist (f (fourth first-partial))
          (check "partial 0 frequency" f 440.0d0 1.0d-6))))))

;;; ---------------------------------------------------------------------
;;; 2. All four types, with phase and with noise
;;; ---------------------------------------------------------------------
;;; The stride depends on the type. Reading a type-2 file as type 1 shifts
;;; every partial after the first by one double — and the result is still
;;; a file full of plausible numbers.
(dolist (type '(1 2 3 4))
  (let* ((stride-3 (member type '(2 4)))
         (data (list (loop repeat 20 collect
                           (if stride-3 (list 0.5d0 330.0d0 1.23d0)
                               (list 0.5d0 330.0d0)))
                     (loop repeat 20 collect
                           (if stride-3 (list 0.25d0 660.0d0 2.34d0)
                               (list 0.25d0 660.0d0)))))
         (noise (loop repeat 20 collect (loop for b from 0 below 25
                                              collect (/ (1+ b) 100.0d0)))))
    (write-ats *tmp* :type type :partials-data data :noise-data noise)
    (let* ((r (clamps-bridge-rpc:ats-outline-for-repl (namestring *tmp*) 5 128))
           (h (header-of r)))
      (unless (eq (first r) :ok)
        (fail "Type ~D fails: ~A" type (second r)))
      (when (eq (first r) :ok)
        (check (format nil "type ~D: has phase" type)
               (nth 11 h) (if stride-3 1 0) 0.5)
        (check (format nil "type ~D: has noise" type)
               (nth 12 h) (if (member type '(3 4)) 1 0) 0.5)
        ;; The decisive check: despite the differing stride, both partials
        ;; keep THEIR frequencies. With a wrong stride the second one would
        ;; pick up phase values or a neighbour's amplitude.
        (check (format nil "type ~D: partial 0" type)
               (third (first (partials-of r))) 330.0d0 1.0d-6)
        (check (format nil "type ~D: partial 1" type)
               (third (second (partials-of r))) 660.0d0 1.0d-6)
        (when (member type '(3 4))
          (check (format nil "type ~D: 25 noise bands" type)
                 (length (noise-of r)) 25 0.5)
          ;; Band 24 carries 0.25, band 0 carries 0.01.
          (check (format nil "type ~D: loudest band" type)
                 (first (nth 24 (noise-of r))) -12.041d0 0.01d0)
          (check (format nil "type ~D: quietest band" type)
                 (first (nth 0 (noise-of r))) -40.0d0 0.01d0))))))

;;; ---------------------------------------------------------------------
;;; 3. Byte order
;;; ---------------------------------------------------------------------
;;; The magic number exists for this. A big-endian file read little-endian
;;; yields enormous or denormal numbers — plausible-looking nonsense.
(let ((data (list (loop repeat 10 collect (list 0.5d0 1000.0d0)))))
  (write-ats *tmp* :type 1 :partials-data data :big-endian-p t)
  (let ((r (clamps-bridge-rpc:ats-outline-for-repl (namestring *tmp*) 4 128)))
    (unless (eq (first r) :ok) (fail "Big-endian file fails: ~A" (second r)))
    (when (eq (first r) :ok)
      (check "big-endian: sample rate" (nth 0 (header-of r)) 44100.0d0 1.0d-9)
      (check "big-endian: frequency" (third (first (partials-of r)))
             1000.0d0 1.0d-6))))

;;; ---------------------------------------------------------------------
;;; 4. A wrong layout is reported, not interpreted
;;; ---------------------------------------------------------------------
;;; This is the assurance that matters most. Every number after the header
;;; sits at a computed offset; get the stride wrong and the file still
;;; reads and still draws a convincing analysis of a sound that is not in
;;; it. The header determines the length exactly, so a mismatch is
;;; detectable — and is refused rather than shown.
(let ((data (list (loop repeat 10 collect (list 0.5d0 1000.0d0)))))
  (write-ats *tmp* :type 1 :partials-data data)
  ;; Append eight bytes: the file no longer matches its own header.
  (with-open-file (out *tmp* :direction :output :element-type '(unsigned-byte 8)
                             :if-exists :append)
    (write-sequence (make-array 8 :element-type '(unsigned-byte 8)
                                  :initial-element 0)
                    out))
  (let ((r (clamps-bridge-rpc:ats-outline-for-repl (namestring *tmp*) 4 128)))
    (unless (eq (first r) :error)
      (fail "A file that is too long is read anyway: ~S" (first r)))
    (when (eq (first r) :error)
      (unless (search "layout" (second r))
        (fail "The message does not name the layout: ~A" (second r))))))

;;; Something that is not an ATS file at all.
(with-open-file (out *tmp* :direction :output :element-type '(unsigned-byte 8)
                           :if-exists :supersede)
  (write-sequence (make-array 200 :element-type '(unsigned-byte 8)
                                  :initial-element 65)
                  out))
(let ((r (clamps-bridge-rpc:ats-outline-for-repl (namestring *tmp*) 4 128)))
  (unless (and (eq (first r) :error) (search "magic" (second r)))
    (fail "A foreign file reports ~S" r)))

;;; A file that does not exist.
(let ((r (clamps-bridge-rpc:ats-outline-for-repl "/definitely/not/here.ats")))
  (unless (eq (first r) :error)
    (fail "A missing file reports ~S" r)))

;;; ---------------------------------------------------------------------
;;; 5. The reduction takes the loudest frame, not the mean
;;; ---------------------------------------------------------------------
;;; A partial that dies away and is reborn at another frequency: the mean
;;; would put it between the two, in a place it never was, and the line
;;; drawn there would look like a glissando that did not happen.
(let ((data (list (append (loop repeat 10 collect (list 0.9d0 200.0d0))
                          (loop repeat 10 collect (list 0.1d0 4000.0d0))))))
  (write-ats *tmp* :type 1 :partials-data data)
  ;; One single column over all 20 frames: the loudest frame decides.
  (let* ((r (clamps-bridge-rpc:ats-outline-for-repl (namestring *tmp*) 8 128))
         (freqs (fourth (first (partials-of r)))))
    ;; The first half must say 200, the second 4000 — and nothing in
    ;; between, because between them the partial never was.
    (dolist (f freqs)
      (unless (or (near f 200.0d0 1.0d-6) (near f 4000.0d0 1.0d-6))
        (fail "The reduction invented ~,1F Hz — neither 200 nor 4000" f)))))

;;; ---------------------------------------------------------------------
;;; 6. Many partials are cut off by loudness, and it is stated
;;; ---------------------------------------------------------------------
(let ((data (loop for p from 0 below 60
                  collect (loop repeat 10
                                collect (list (/ (1+ p) 60.0d0)
                                              (* 100.0d0 (1+ p)))))))
  (write-ats *tmp* :type 1 :partials-data data)
  (let ((r (clamps-bridge-rpc:ats-outline-for-repl (namestring *tmp*) 8 10)))
    (check "ten partials shown" (length (partials-of r)) 10 0.5)
    (check "sixty in the header" (nth 3 (header-of r)) 60 0.5)
    (unless (some (lambda (w) (search "omitted" w)) (warnings-of r))
      (fail "The cut-off is not stated: ~S" (warnings-of r)))
    ;; The LOUDEST are kept — here the highest indices — and they come back
    ;; in index order, not in order of loudness.
    (let ((indices (mapcar #'first (partials-of r))))
      (unless (equal indices (sort (copy-list indices) #'<))
        (fail "Partials are not in index order: ~S" indices))
      (unless (= (first (car (last (partials-of r)))) 59)
        (fail "The loudest partial (59) is missing: ~S" indices)))))

;;; ---------------------------------------------------------------------
;;; 7. Header and frames are cross-checked
;;; ---------------------------------------------------------------------
;;; max-amplitude and max-frequency stand in the header AND follow from the
;;; frames, so the two must agree. Where they do not, either the file is
;;; inconsistent or — far more likely — the reader is walking the frames
;;; wrongly. Verified against a real clarinet analysis: the header's
;;; 0.19513 and 4712.83 are exactly the peak of partial 6 and the mean
;;; frequency of partial 17.
;;;
;;; The limits of the check are stated as plainly as its use: swapping
;;; amplitude and frequency is caught, a frame offset wrong by one is not,
;;; because in a sustained sound the maximum barely moves between
;;; neighbouring frames. It is a cross-check, not a proof.
(let ((data (list (loop repeat 20 collect (list 0.5d0 440.0d0)))))
  (write-ats *tmp* :type 1 :partials-data data)
  ;; Written with a header claiming a maximum amplitude of 1.0 while the
  ;; frames hold 0.5.
  (let ((bytes (with-open-file (in *tmp* :element-type '(unsigned-byte 8))
                 (let ((b (make-array (file-length in)
                                      :element-type '(unsigned-byte 8))))
                   (read-sequence b in) b))))
    ;; Header field 6 is max-amplitude; overwrite it with 1.0.
    (replace bytes (double-bytes 1.0d0 nil) :start1 48)
    (with-open-file (out *tmp* :direction :output :element-type '(unsigned-byte 8)
                               :if-exists :supersede)
      (write-sequence bytes out)))
  (let ((r (clamps-bridge-rpc:ats-outline-for-repl (namestring *tmp*) 4 128)))
    (unless (eq (first r) :ok)
      (fail "A disagreeing header is refused outright: ~A" (second r)))
    (when (eq (first r) :ok)
      ;; Shown, not refused: the frames are readable, only the header lies.
      ;; Refusing would withhold a picture that is correct.
      (unless (some (lambda (w) (search "max amplitude" w)) (warnings-of r))
        (fail "The disagreement between header and frames is not stated: ~S"
              (warnings-of r))))))

;;; And a consistent file draws no such warning — otherwise the message
;;; would stand next to every analysis and mean nothing.
(let ((data (list (loop repeat 20 collect (list 0.5d0 440.0d0)))))
  (write-ats *tmp* :type 1 :partials-data data)
  (let ((r (clamps-bridge-rpc:ats-outline-for-repl (namestring *tmp*) 4 128)))
    (when (some (lambda (w) (search "header says" w)) (warnings-of r))
      (fail "A consistent file is flagged all the same: ~S" (warnings-of r)))))

;;; ---------------------------------------------------------------------
;;; 8. Playback without Incudine says what it looked for
;;; ---------------------------------------------------------------------
;;; The resynthesis is NOT implemented in this extension — it belongs to
;;; ats-cuda and Incudine, which do it in the audio thread with their own
;;; oscillator banks. A second implementation inside an editor would be a
;;; worse one, and worse in a way nobody would notice until a piece sounded
;;; subtly different from the analysis it came from.
;;;
;;; So all that is testable here is the part that runs without an audio
;;; stack: the file check, and the message when nothing is there. That
;;; message is the whole point of this test. The names differ between
;;; ats-cuda versions and CLAMPS's own wrappers, so "not available" without
;;; a list of what was searched for would leave the user with nothing to
;;; act on — and this gate runs without ats-cuda present, so it always
;;; exercises that path.
(let ((data (list (loop repeat 10 collect (list 0.5d0 440.0d0)))))
  (write-ats *tmp* :type 1 :partials-data data)
  (let ((r (clamps-bridge-rpc:ats-play-for-repl (namestring *tmp*))))
    (unless (eq (first r) :error)
      (fail "Playback without Incudine reports ~S" (first r)))
    (when (eq (first r) :error)
      (dolist (needle '("ATS-LOAD" "ATS-CUDA" "Packages present"))
        (unless (search needle (second r))
          (fail "The message does not mention ~A: ~A" needle (second r)))))))

;;; Every attempt is named, and the failure is attributed to the function
;;; that actually signalled.
;;;
;;; ATS-LOAD takes a path AND a symbol to bind the sound to. Called with
;;; the path alone it signals "invalid number of arguments: 1", and an
;;; outer handler around both calls would report that as "SIN-NOI-SYNTH
;;; failed" — naming a function that is perfectly fine. A message pointing
;;; at the wrong function is worse than no message.
;;;
;;; A stand-in whose loader and synthesis both refuse in known ways: the
;;; report must contain BOTH names, so that neither can be blamed for the
;;; other's error.
(defpackage #:ats-play-probe (:use #:cl)
  (:export #:ats-load #:sin-noi-synth #:sin-synth))
(in-package #:ats-play-probe)
(defun ats-load (path symbol)
  (declare (ignore path symbol))
  (error "loader refuses on purpose"))
(defun sin-noi-synth (&rest args) (declare (ignore args)) (error "noise synth"))
(defun sin-synth (&rest args) (declare (ignore args)) (error "sine synth"))
(in-package :cl-user)

(let ((clamps-bridge-rpc::*ats-packages* '(:ats-play-probe))
      (data (list (loop repeat 10 collect (list 0.5d0 440.0d0)))))
  (write-ats *tmp* :type 1 :partials-data data)
  (let ((r (clamps-bridge-rpc:ats-play-for-repl (namestring *tmp*))))
    (unless (eq (first r) :error)
      (fail "A refusing loader is reported as success: ~S" r))
    (when (eq (first r) :error)
      ;; The loader failed, so the loader is what is named — and the
      ;; synthesis, which never ran, must NOT be blamed.
      (unless (search "Loading failed" (second r))
        (fail "A loader failure is not reported as one: ~A" (second r)))
      (unless (search "ATS-LOAD" (second r))
        (fail "The loader is not named: ~A" (second r)))
      (unless (search "loader refuses on purpose" (second r))
        (fail "The loader's own error is swallowed: ~A" (second r)))
      (when (search "SIN-NOI-SYNTH" (second r))
        (fail "The synthesis is blamed for the loader's failure: ~A"
              (second r))))))

;;; And when the loader works but the synthesis does not, every argument
;;; list that was tried appears — the conventions differ between versions,
;;; so which ones were attempted is the useful part of the message.
(defpackage #:ats-synth-probe (:use #:cl)
  (:export #:ats-load #:sin-noi-synth #:sin-synth))
(in-package #:ats-synth-probe)
(defun ats-load (path symbol)
  (declare (ignore path))
  (setf (symbol-value symbol) :a-sound)
  symbol)
(defun sin-noi-synth (&rest args) (declare (ignore args)) (error "noise synth"))
(defun sin-synth (&rest args) (declare (ignore args))
  (error "synthesis refuses on purpose"))
(in-package :cl-user)

(let ((clamps-bridge-rpc::*ats-packages* '(:ats-synth-probe))
      (data (list (loop repeat 10 collect (list 0.5d0 440.0d0)))))
  (write-ats *tmp* :type 1 :partials-data data)
  (let ((r (clamps-bridge-rpc:ats-play-for-repl (namestring *tmp*))))
    (when (eq (first r) :error)
      (unless (search "Synthesis failed" (second r))
        (fail "A synthesis failure is not reported as one: ~A" (second r)))
      (dolist (needle '("start sound :amp-scale" "start sound" "sound"))
        (unless (search needle (second r))
          (fail "The attempt ~S is not named: ~A" needle (second r)))))))

;;; A loader that works and a synthesis that works: the message says which
;;; convention succeeded, so that a working setup can be reproduced.
(defpackage #:ats-ok-probe (:use #:cl)
  (:export #:ats-load #:sin-noi-synth #:sin-synth))
(in-package #:ats-ok-probe)
(defun ats-load (path symbol)
  (declare (ignore path))
  (setf (symbol-value symbol) :a-sound)
  symbol)
(defun sin-noi-synth (start sound &key amp-scale)
  (declare (ignore sound amp-scale))
  (unless (floatp start) (error "start time must be a float"))
  :playing)
(defun sin-synth (start sound &key amp-scale)
  (declare (ignore sound amp-scale))
  (unless (floatp start) (error "start time must be a float"))
  :playing)
(in-package :cl-user)

(let ((clamps-bridge-rpc::*ats-packages* '(:ats-ok-probe))
      (data (list (loop repeat 10 collect (list 0.5d0 440.0d0)))))
  (write-ats *tmp* :type 1 :partials-data data)
  (let ((r (clamps-bridge-rpc:ats-play-for-repl (namestring *tmp*))))
    (unless (eq (first r) :ok)
      (fail "A working setup is reported as a failure: ~S" r))
    (when (eq (first r) :ok)
      (unless (search "amp-scale" (second r))
        (fail "The successful convention is not named: ~A" (second r)))
      ;; The start time must be a float. sin-noi-synth schedules on it, and
      ;; an integer 0 is not the same thing there — the probe above rejects
      ;; an integer, so this passing at all is the check.
      ;; A type 1 file: the SINE synthesis is the right one, and the
      ;; message says which was used.
      (unless (search "SIN-SYNTH" (second r))
        (fail "The function used is not named: ~A" (second r)))
      (unless (search "type 1" (second r))
        (fail "The file type is not named: ~A" (second r))))))

;;; ---------------------------------------------------------------------
;;; 9. The synthesis is chosen by the file's TYPE
;;; ---------------------------------------------------------------------
;;; SIN-NOI-SYNTH reads the residual noise bands, and types 1 and 2 have
;;; none — so on those it fails, or worse, reads whatever lies at that
;;; offset as noise. A type 4 analysis then plays and a type 2 one from the
;;; same source does not.
;;;
;;; The type is in the header, so the choice is decidable rather than a
;;; matter of trying and seeing. That is what this guards.
(defpackage #:ats-type-probe (:use #:cl)
  (:export #:ats-load #:sin-noi-synth #:sin-synth))
(in-package #:ats-type-probe)
(defvar *called* nil)
(defun ats-load (path symbol)
  (declare (ignore path))
  (setf (symbol-value symbol) :a-sound)
  symbol)
(defun sin-noi-synth (start sound &key amp-scale)
  (declare (ignore start sound amp-scale))
  (setf *called* :noise) :playing)
(defun sin-synth (start sound &key amp-scale)
  (declare (ignore start sound amp-scale))
  (setf *called* :sine) :playing)
(in-package :cl-user)

(let ((clamps-bridge-rpc::*ats-packages* '(:ats-type-probe)))
  ;; Type 1 and 2: no noise in the file, so the sine synthesis.
  (dolist (type '(1 2))
    (setf ats-type-probe::*called* nil)
    (let ((data (list (loop repeat 10 collect
                            (if (= type 2) (list 0.5d0 440.0d0 0.0d0)
                                (list 0.5d0 440.0d0))))))
      (write-ats *tmp* :type type :partials-data data)
      (clamps-bridge-rpc:ats-play-for-repl (namestring *tmp*))
      (unless (eq ats-type-probe::*called* :sine)
        (fail "Type ~D used ~S instead of the sine synthesis"
              type ats-type-probe::*called*))))
  ;; Type 3 and 4: noise is present, so the noise synthesis.
  (dolist (type '(3 4))
    (setf ats-type-probe::*called* nil)
    (let ((data (list (loop repeat 10 collect
                            (if (= type 4) (list 0.5d0 440.0d0 0.0d0)
                                (list 0.5d0 440.0d0)))))
          (noise (loop repeat 10 collect (loop repeat 25 collect 0.1d0))))
      (write-ats *tmp* :type type :partials-data data :noise-data noise)
      (clamps-bridge-rpc:ats-play-for-repl (namestring *tmp*))
      (unless (eq ats-type-probe::*called* :noise)
        (fail "Type ~D used ~S instead of the noise synthesis"
              type ats-type-probe::*called*)))))

;;; A file that is not ATS is refused BEFORE the search for the synthesis:
;;; otherwise the user gets a message about missing packages when the real
;;; problem is the file they picked.
(with-open-file (out *tmp* :direction :output :element-type '(unsigned-byte 8)
                           :if-exists :supersede)
  (write-sequence (make-array 100 :element-type '(unsigned-byte 8)
                                  :initial-element 65)
                  out))
(let ((r (clamps-bridge-rpc:ats-play-for-repl (namestring *tmp*))))
  (unless (and (eq (first r) :error) (search "magic" (second r)))
    (fail "A foreign file reports ~S instead of naming the file" r)))
(let ((r (clamps-bridge-rpc:ats-play-for-repl "/definitely/not/here.ats")))
  (unless (and (eq (first r) :error) (search "cannot be read" (second r)))
    (fail "A missing file reports ~S" r)))

;;; Stopping without Incudine likewise says so instead of pretending.
(let ((r (clamps-bridge-rpc:ats-stop-for-repl)))
  (unless (and (eq (first r) :error) (search "Incudine" (second r)))
    (fail "Stopping without Incudine reports ~S" r)))

;;; The candidate list prefers the variant that plays the noise too: the
;;; purely sinusoidal ones leave out exactly the part an ATS analysis
;;; separated out with some effort.
(unless (string= (first clamps-bridge-rpc::*ats-synth-names*) "SIN-NOI-SYNTH")
  (fail "The first synthesis candidate is ~A, not the one with noise"
        (first clamps-bridge-rpc::*ats-synth-names*)))

(ignore-errors (delete-file *tmp*))

(if (> *failed* 0)
    (progn (format t "~%~D test(s) failed.~%" *failed*)
           (sb-ext:exit :code 1))
    (format t "ok — ATS reader: all four types, both byte orders, a wrong ~
layout refused rather than interpreted~%"))
