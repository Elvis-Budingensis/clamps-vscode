;;;; test-osc.lisp — the OSC monitor.
;;;;
;;;; The decoding of an OSC message happens in Incudine — OSC:VALUE hands
;;;; back a value already converted to the type its tag names. What this
;;;; file checks is everything around it, and the centre of that is the
;;;; TYPE INFORMATION.
;;;;
;;;; In OSC an integer 1 and a float 1.0 print alike and are not alike; a
;;;; blob is not a string; and a receiver expecting "if" that gets "fi"
;;;; fails without saying so. A monitor that shows values without their
;;;; types therefore answers the easy half of the question and hides the
;;;; half one opened it for.
;;;;
;;;; Run: sbcl --script lisp/test-osc.lisp

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

;;; ---------------------------------------------------------------------
;;; 1. Types are named, and named apart
;;; ---------------------------------------------------------------------
;;; The distinction that matters. 1 and 1.0 must not look alike.
(check "an integer" (clamps-bridge-rpc::%osc-value-label 1) "int")
(check "a single float" (clamps-bridge-rpc::%osc-value-label 1.0) "float")
(check "a double" (clamps-bridge-rpc::%osc-value-label 1.0d0) "double")
(check "a string" (clamps-bridge-rpc::%osc-value-label "x") "string")
(check "a blob" (clamps-bridge-rpc::%osc-value-label
                 (make-array 4 :element-type '(unsigned-byte 8)))
       "blob")
;; The three numeric labels must differ from one another: telling an int
;; from a float is the whole reason for showing the type.
(let ((labels (list (clamps-bridge-rpc::%osc-value-label 1)
                    (clamps-bridge-rpc::%osc-value-label 1.0)
                    (clamps-bridge-rpc::%osc-value-label 1.0d0))))
  (unless (= 3 (length (remove-duplicates labels :test #'string=)))
    (fail "The numeric types are not distinguishable: ~S" labels)))
;; An unknown type still gets a name rather than breaking the line.
(let ((label (clamps-bridge-rpc::%osc-value-label #\a)))
  (when (or (null label) (string= label ""))
    (fail "An unexpected type yields no label")))

;;; ---------------------------------------------------------------------
;;; 2. Values are printed, bounded
;;; ---------------------------------------------------------------------
;;; A blob can be a megabyte. Printing it fills the window with hex for a
;;; message whose interesting part is its length.
(let ((text (clamps-bridge-rpc::%osc-format-value
             (make-array 1048576 :element-type '(unsigned-byte 8)))))
  (unless (search "1048576" text)
    (fail "A blob does not report its length: ~A" text))
  (when (> (length text) 40)
    (fail "A blob is printed at ~D characters" (length text))))
;; A long string is truncated, and says so.
(let ((text (clamps-bridge-rpc::%osc-format-value (make-string 500 :initial-element #\x))))
  (when (> (length text) 80)
    (fail "A long string is printed at ~D characters" (length text))))
;; A short string keeps its quotes: without them "1" and 1 look alike
;; again, and that is exactly the confusion the type column exists to
;; prevent.
(let ((text (clamps-bridge-rpc::%osc-format-value "1")))
  (unless (find #\" text)
    (fail "A string is printed without quotes: ~A" text)))

;;; ---------------------------------------------------------------------
;;; 3. The ring
;;; ---------------------------------------------------------------------
(let ((ring (clamps-bridge-rpc:make-osc-ring-for-repl 16)))
  (setf clamps-bridge-rpc::*osc-ring* ring)
  (clamps-bridge-rpc:osc-ring-record-for-repl
   ring "/synth/freq" "if" (list 1 440.0) 0.0d0)
  (clamps-bridge-rpc:osc-ring-record-for-repl
   ring "/synth/gate" "i" (list 0) 0.1d0)
  (let ((r (clamps-bridge-rpc:osc-events-since-for-repl 0)))
    (check "two events" (length (fourth r)) 2)
    (check "sequence" (second r) 2)
    (check "nothing dropped" (third r) 0)
    (let ((first-event (first (fourth r))))
      (check "the address" (second first-event) "/synth/freq")
      (check "the type tag" (third first-event) "if")
      ;; Two values, each with its own type — this is the shape the display
      ;; needs, and getting it wrong means either the types or the values
      ;; are lost.
      (check "two values" (length (fourth first-event)) 2)
      (check "the first is an int" (first (first (fourth first-event))) "int")
      (check "the second is a float" (first (second (fourth first-event))) "float")))

  ;; Incremental: only what arrived since.
  (clamps-bridge-rpc:osc-ring-record-for-repl ring "/x" "" '() 0.2d0)
  (let ((r (clamps-bridge-rpc:osc-events-since-for-repl 2)))
    (check "one new event" (length (fourth r)) 1)
    (check "and it is /x" (second (first (fourth r))) "/x"))

  ;; Overrun is counted, and never more than the ring holds is returned.
  ;;
  ;; The limit argument has to be LARGER than the ring for this to test
  ;; anything: with the default limit the fetch is capped by the limit
  ;; before the ring size ever matters, and a reader that walks twice round
  ;; the buffer — serving the same slots again as fresh messages — passes
  ;; unnoticed. Duplicated events in a monitor are worse than lost ones: a
  ;; message sent once appears twice, and the monitor is the only witness.
  (dotimes (i 40)
    (clamps-bridge-rpc:osc-ring-record-for-repl
     ring (format nil "/n/~D" i) "i" (list i) (float i 1.0d0)))
  (let ((r (clamps-bridge-rpc:osc-events-since-for-repl 3 1000)))
    (unless (> (third r) 0)
      (fail "An overrun ring reports ~D dropped" (third r)))
    (unless (<= (length (fourth r)) 16)
      (fail "~D events from a ring of 16" (length (fourth r))))
    (let ((total (+ (length (fourth r)) (third r)))
          (expected (- (second r) 3)))
      (unless (= total expected)
        (fail "~D delivered plus ~D dropped is ~D, but ~D arrived"
              (length (fourth r)) (third r) total expected)))))

;;; A message with no arguments is still a message: /clear or /stop carry
;;; their meaning in the address alone.
(let ((ring (clamps-bridge-rpc:make-osc-ring-for-repl 16)))
  (setf clamps-bridge-rpc::*osc-ring* ring)
  (clamps-bridge-rpc:osc-ring-record-for-repl ring "/stop" "" '() 0.0d0)
  (let ((event (first (fourth (clamps-bridge-rpc:osc-events-since-for-repl 0)))))
    (check "an address without values" (second event) "/stop")
    (check "and no values" (length (fourth event)) 0)))

;;; Without a running monitor the answer is an error, not an empty list: an
;;; empty window cannot be told from one that works and receives nothing.
(setf clamps-bridge-rpc::*osc-ring* nil)
(let ((r (clamps-bridge-rpc:osc-events-since-for-repl 0)))
  (unless (eq (first r) :error)
    (fail "A stopped monitor returns ~S instead of an error" (first r))))

;;; Recording without a ring says what to do.
;;;
;;; The ring exists only while the monitor runs, so recording by hand
;;; before opening the window is the ordinary mistake. "The value nil is
;;; not of type osc-ring" is true and useless; the message has to name the
;;; way out.
(setf clamps-bridge-rpc::*osc-ring* nil)
(handler-case
    (progn
      (clamps-bridge-rpc:osc-ring-record-for-repl nil "/x" "i" (list 1) 0.0d0)
      (fail "Recording without a ring did not signal"))
  (error (e)
    (let ((text (princ-to-string e)))
      (unless (search "osc-monitor-start-for-repl" text)
        (fail "The message does not name the way out: ~A" text))
      (unless (search "Show OSC Monitor" text)
        (fail "The message does not name the command: ~A" text)))))

;;; Recording returns the sequence number, not the ring.
;;;
;;; A ring of 512 prints as 509 NILs around the entries one wanted to see,
;;; so returning the structure buries the result in the REPL. The sequence
;;; number is also the more useful value: it is the cursor for the next
;;; fetch.
(let ((ring (clamps-bridge-rpc:make-osc-ring-for-repl 16)))
  (setf clamps-bridge-rpc::*osc-ring* ring)
  (check "the first record returns 1"
         (clamps-bridge-rpc:osc-ring-record-for-repl ring "/a" "i" (list 1) 0.0d0)
         1)
  (check "the second returns 2"
         (clamps-bridge-rpc:osc-ring-record-for-repl ring "/b" "i" (list 2) 0.0d0)
         2))

;;; ---------------------------------------------------------------------
;;; 4. Starting without Incudine says what it looked for
;;; ---------------------------------------------------------------------
;;; The ring is created either way, so the window can be exercised by hand
;;; where no OSC is configured.
(let ((r (clamps-bridge-rpc:osc-monitor-start-for-repl 32126 64)))
  (unless (eq (first r) :ok)
    (fail "Starting reports ~S" r))
  (unless (or (search "OSC functions were not found" (second r))
              (search "Listening on OSC port" (second r))
              (search "Could not open" (second r)))
    (fail "The message says none of the three possible things: ~A" (second r))))
;; And recording by hand works regardless.
(clamps-bridge-rpc:osc-ring-record-for-repl
 clamps-bridge-rpc::*osc-ring* "/by/hand" "s" (list "test") 0.0d0)
(check "recording by hand"
       (length (fourth (clamps-bridge-rpc:osc-events-since-for-repl 0))) 1)
(clamps-bridge-rpc:osc-monitor-stop-for-repl)

;;; Stopping twice must not throw: the window may close after the session
;;; has already gone.
(clamps-bridge-rpc:osc-monitor-stop-for-repl)

(if (> *failed* 0)
    (progn (format t "~%~D test(s) failed.~%" *failed*)
           (sb-ext:exit :code 1))
    (format t "ok — OSC: types named and distinguishable, blobs and long ~
strings bounded, ring incremental with overflow reported~%"))
