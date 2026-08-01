;;;; test-samples.lisp — the audio file header reader.
;;;;
;;;; Like the ATS gate, this writes its own files: WAV and AIFF are
;;;; defined binary formats, so the expected answer is known exactly.
;;;;
;;;; The centre of it is the 80-bit extended float. AIFF stores its sample
;;;; rate in a format nothing else uses and no Lisp reads natively, and a
;;;; sloppy decoder gets it ALMOST right — 44099.99 instead of 44100, or
;;;; half the value if the explicit leading mantissa bit is treated as
;;;; implied. Both print as something believable, both make every duration
;;;; slightly wrong, and neither is visible in a file listing. So the check
;;;; is against known bit patterns and demands exactness, not a tolerance.
;;;;
;;;; Run: sbcl --script lisp/test-samples.lisp

(load (merge-pathnames "rpc.lisp" *load-truename*))

(in-package :cl-user)

(defvar *failed* 0)

(defun fail (format &rest args)
  (incf *failed*)
  (format t "FAILED ~?~%" format args))

(defmacro check (name a b)
  `(let ((got ,a) (want ,b))
     (unless (equal got want)
       (fail "~A: ~S instead of ~S" ,name got want))))

(defmacro check-exact (name a b)
  "Numeric equality with NO tolerance. For the sample rate this is the
   whole point: a rate that is nearly right is a rate that is wrong."
  `(let ((got (float ,a 1.0d0)) (want (float ,b 1.0d0)))
     (unless (= got want)
       (fail "~A: ~,6F instead of ~,6F (exactly equal was required)"
             ,name got want))))

;;; --- Writing test files ------------------------------------------------

(defun bytes-be (value count)
  (let ((out (make-array count :element-type '(unsigned-byte 8))))
    (dotimes (i count out)
      (setf (aref out i) (ldb (byte 8 (* 8 (- count 1 i))) value)))))

(defun bytes-le (value count)
  (let ((out (make-array count :element-type '(unsigned-byte 8))))
    (dotimes (i count out)
      (setf (aref out i) (ldb (byte 8 (* 8 i)) value)))))

(defun ascii-bytes (text)
  (map '(vector (unsigned-byte 8)) #'char-code text))

(defun extended-bytes (x)
  "An 80-bit extended float. Written out independently of the reader, so
   that a shared misunderstanding cannot make both agree."
  (if (zerop x)
      (make-array 10 :element-type '(unsigned-byte 8) :initial-element 0)
      (multiple-value-bind (mantissa exponent) (decode-float (float x 1.0d0))
        (let ((bits (round (* mantissa (expt 2 64))))
              (e (+ exponent 16382)))
          (concatenate '(vector (unsigned-byte 8))
                       (bytes-be e 2) (bytes-be bits 8))))))

(defun write-wav (path &key (channels 2) (rate 44100) (bits 16) (frames 1000)
                            (junk-first nil) (odd-chunk nil))
  (let* ((block-align (* channels (ceiling bits 8)))
         (data-size (* frames block-align))
         (chunks '()))
    ;; An optional junk chunk before fmt: real files carry LIST or bext
    ;; there, and a reader that assumes fmt at offset 12 reads THAT as the
    ;; format.
    (when junk-first
      (push (concatenate '(vector (unsigned-byte 8))
                         (ascii-bytes "JUNK") (bytes-le 4 4) (bytes-le 0 4))
            chunks))
    ;; An optional chunk of odd length: the pad byte is not counted in the
    ;; size, so ignoring it shifts everything after it by one.
    (when odd-chunk
      (push (concatenate '(vector (unsigned-byte 8))
                         (ascii-bytes "note") (bytes-le 3 4)
                         (ascii-bytes "abc") (bytes-le 0 1))
            chunks))
    (push (concatenate '(vector (unsigned-byte 8))
                       (ascii-bytes "fmt ") (bytes-le 16 4)
                       (bytes-le 1 2) (bytes-le channels 2)
                       (bytes-le rate 4)
                       (bytes-le (* rate block-align) 4)
                       (bytes-le block-align 2) (bytes-le bits 2))
          chunks)
    (push (concatenate '(vector (unsigned-byte 8))
                       (ascii-bytes "data") (bytes-le data-size 4)
                       (make-array data-size :element-type '(unsigned-byte 8)
                                             :initial-element 0))
          chunks)
    (let ((body (apply #'concatenate '(vector (unsigned-byte 8))
                       (reverse chunks))))
      (with-open-file (out path :direction :output
                                :element-type '(unsigned-byte 8)
                                :if-exists :supersede)
        (write-sequence (ascii-bytes "RIFF") out)
        (write-sequence (bytes-le (+ 4 (length body)) 4) out)
        (write-sequence (ascii-bytes "WAVE") out)
        (write-sequence body out)))
    path))

(defun write-aiff (path &key (channels 1) (rate 44100.0) (bits 24)
                             (frames 500) (aifc nil))
  (let* ((comm (concatenate '(vector (unsigned-byte 8))
                            (ascii-bytes "COMM")
                            (bytes-be (if aifc 22 18) 4)
                            (bytes-be channels 2) (bytes-be frames 4)
                            (bytes-be bits 2) (extended-bytes rate)
                            (if aifc (ascii-bytes "NONE") #())))
         (data-size (+ 8 (* frames channels (ceiling bits 8))))
         (ssnd (concatenate '(vector (unsigned-byte 8))
                            (ascii-bytes "SSND") (bytes-be data-size 4)
                            (make-array data-size
                                        :element-type '(unsigned-byte 8)
                                        :initial-element 0)))
         (body (concatenate '(vector (unsigned-byte 8)) comm ssnd)))
    (with-open-file (out path :direction :output
                              :element-type '(unsigned-byte 8)
                              :if-exists :supersede)
      (write-sequence (ascii-bytes "FORM") out)
      (write-sequence (bytes-be (+ 4 (length body)) 4) out)
      (write-sequence (ascii-bytes (if aifc "AIFC" "AIFF")) out)
      (write-sequence body out))
    path))

(defparameter *dir*
  (pathname (concatenate 'string
                         (or (sb-ext:posix-getenv "TMPDIR") "/tmp")
                         "/clamps-sample-test/")))

(ensure-directories-exist *dir*)
(dolist (old (directory (merge-pathnames "*.*" *dir*)))
  (ignore-errors (delete-file old)))

;;; ---------------------------------------------------------------------
;;; 1. The 80-bit extended float, against known bit patterns
;;; ---------------------------------------------------------------------
;;; The patterns come from the format definition, not from this reader.
;;; Exactness is demanded: a rate of 44099.99 passes every eyeball test and
;;; makes every duration and every resampling ratio subtly wrong.
(dolist (case* (list (list #(#x40 #x0E #xAC #x44 #x00 #x00 #x00 #x00 #x00 #x00) 44100.0d0)
                     (list #(#x40 #x0E #xBB #x80 #x00 #x00 #x00 #x00 #x00 #x00) 48000.0d0)
                     (list #(#x40 #x0D #xAC #x44 #x00 #x00 #x00 #x00 #x00 #x00) 22050.0d0)
                     (list #(#x40 #x0F #xBB #x80 #x00 #x00 #x00 #x00 #x00 #x00) 96000.0d0)
                     (list #(#x00 #x00 #x00 #x00 #x00 #x00 #x00 #x00 #x00 #x00) 0.0d0)))
  (destructuring-bind (pattern expected) case*
    (let ((bytes (make-array 10 :element-type '(unsigned-byte 8)
                                :initial-contents (coerce pattern 'list))))
      (check-exact (format nil "extended float ~,1F" expected)
                   (clamps-bridge-rpc::%read-extended-float bytes 0)
                   expected))))

;;; The leading mantissa bit is EXPLICIT in this format, unlike in the 32-
;;; and 64-bit ones. Treating it as implied halves every value — 22050
;;; where 44100 belongs, which is wrong and entirely plausible.
(let ((bytes (make-array 10 :element-type '(unsigned-byte 8)
                            :initial-contents
                            '(#x40 #x0E #xAC #x44 0 0 0 0 0 0))))
  (let ((value (clamps-bridge-rpc::%read-extended-float bytes 0)))
    (when (< (abs (- value 22050.0d0)) 1.0d0)
      (fail "The extended float reads 22050 — the leading mantissa bit is ~
being treated as implied"))))

;;; ---------------------------------------------------------------------
;;; 2. WAV, written here and read back
;;; ---------------------------------------------------------------------
(let ((path (merge-pathnames "plain.wav" *dir*)))
  (write-wav path :channels 2 :rate 48000 :bits 24 :frames 2400)
  (let ((info (clamps-bridge-rpc::%sample-info path)))
    (check "WAV format" (getf info :format) "WAV")
    (check "WAV channels" (getf info :channels) 2)
    (check-exact "WAV rate" (getf info :sample-rate) 48000.0d0)
    (check "WAV bit depth" (getf info :bit-depth) 24)
    (check "WAV frames" (getf info :frames) 2400)))

;;; A chunk before fmt: real files carry LIST or bext there, and a reader
;;; that assumes fmt at offset 12 reads that chunk as the format — yielding
;;; a plausible channel count and a nonsensical rate.
(let ((path (merge-pathnames "junked.wav" *dir*)))
  (write-wav path :channels 1 :rate 22050 :bits 16 :frames 100
                  :junk-first t)
  (let ((info (clamps-bridge-rpc::%sample-info path)))
    (check "WAV after a junk chunk: channels" (getf info :channels) 1)
    (check-exact "WAV after a junk chunk: rate"
                 (getf info :sample-rate) 22050.0d0)))

;;; A chunk of odd length. The pad byte is not counted in the size, so
;;; ignoring it shifts every following chunk by one byte — and then the
;;; data chunk is not found, so the duration silently becomes 0.
(let ((path (merge-pathnames "odd.wav" *dir*)))
  (write-wav path :channels 2 :rate 44100 :bits 16 :frames 441
                  :odd-chunk t)
  (let ((info (clamps-bridge-rpc::%sample-info path)))
    (check "WAV after an odd chunk: frames" (getf info :frames) 441)
    (check-exact "WAV after an odd chunk: rate"
                 (getf info :sample-rate) 44100.0d0)))

;;; ---------------------------------------------------------------------
;;; 3. AIFF and AIFF-C
;;; ---------------------------------------------------------------------
(let ((path (merge-pathnames "mono.aiff" *dir*)))
  (write-aiff path :channels 1 :rate 44100.0 :bits 24 :frames 44100)
  (let ((info (clamps-bridge-rpc::%sample-info path)))
    (check "AIFF format" (getf info :format) "AIFF")
    (check "AIFF channels" (getf info :channels) 1)
    (check-exact "AIFF rate" (getf info :sample-rate) 44100.0d0)
    (check "AIFF bit depth" (getf info :bit-depth) 24)
    (check "AIFF frames" (getf info :frames) 44100)))

(let ((path (merge-pathnames "compressed.aifc" *dir*)))
  (write-aiff path :channels 2 :rate 96000.0 :bits 32 :frames 960 :aifc t)
  (let ((info (clamps-bridge-rpc::%sample-info path)))
    ;; The compression type belongs in the format label: an AIFC that is
    ;; not NONE cannot be read as raw samples, and the browser should say
    ;; which it is rather than looking like an ordinary AIFF.
    (unless (search "AIFC" (getf info :format))
      (fail "AIFC is labelled ~S" (getf info :format)))
    (check-exact "AIFC rate" (getf info :sample-rate) 96000.0d0)))

;;; ---------------------------------------------------------------------
;;; 4. Files that are not audio
;;; ---------------------------------------------------------------------
;;; Named, not omitted. A listing that silently drops what it cannot read
;;; is worse than one that shows the file with a question mark: the user
;;; knows the file is there and would look for a bug in the browser.
(let ((path (merge-pathnames "broken.wav" *dir*)))
  (with-open-file (out path :direction :output :element-type '(unsigned-byte 8)
                            :if-exists :supersede)
    (write-sequence (ascii-bytes "not audio at all") out))
  (let ((info (clamps-bridge-rpc::%sample-info path)))
    (check "an unreadable file is marked" (getf info :format) "?")
    (check "and claims no frames" (getf info :frames) 0)))

;;; A truncated header must not throw.
(let ((path (merge-pathnames "short.wav" *dir*)))
  (with-open-file (out path :direction :output :element-type '(unsigned-byte 8)
                            :if-exists :supersede)
    (write-sequence (ascii-bytes "RIFF") out))
  (let ((info (clamps-bridge-rpc::%sample-info path)))
    (check "a truncated file is marked" (getf info :format) "?")))

;;; ---------------------------------------------------------------------
;;; 5. The directory listing
;;; ---------------------------------------------------------------------
(let ((result (clamps-bridge-rpc:sample-browse-for-repl (namestring *dir*))))
  (unless (eq (first result) :ok)
    (fail "Browsing failed: ~A" (second result)))
  (when (eq (first result) :ok)
    (let* ((entries (second result))
           (names (mapcar #'first entries)))
      ;; Seven files were written — plain, junked, odd, mono, compressed,
      ;; broken, short — and all seven appear, the unreadable ones
      ;; included.
      (check "seven entries" (length entries) 7)
      (unless (equal names (sort (copy-list names) #'string<))
        (fail "The listing is not sorted: ~S" names))
      (let ((mono (find "mono.aiff" entries :key #'first :test #'string=)))
        (unless mono (fail "mono.aiff is missing from the listing"))
        (when mono
          ;; 44100 frames at 44100 Hz is exactly one second. A duration
          ;; that comes out as 0.99998 means the rate was decoded
          ;; approximately — which is the whole point of this file.
          (check-exact "duration of one second" (nth 7 mono) 1.0d0)))
      ;; A file whose header says nothing gets a duration of 0, not a
      ;; guess. A browser that invents durations is worse than one that
      ;; leaves the column empty.
      (let ((broken (find "broken.wav" entries :key #'first :test #'string=)))
        (when broken (check-exact "unknown duration" (nth 7 broken) 0.0d0))))))

;;; A directory that does not exist is reported rather than shown empty.
(let ((r (clamps-bridge-rpc:sample-browse-for-repl "/definitely/not/here")))
  (unless (eq (first r) :error)
    (fail "A missing directory returns ~S" (first r))))

(dolist (old (directory (merge-pathnames "*.*" *dir*)))
  (ignore-errors (delete-file old)))

(if (> *failed* 0)
    (progn (format t "~%~D test(s) failed.~%" *failed*)
           (sb-ext:exit :code 1))
    (format t "ok — sample browser: WAV and AIFF headers exact, 80-bit ~
extended float bit-for-bit, chunk walking survives junk and padding~%"))
