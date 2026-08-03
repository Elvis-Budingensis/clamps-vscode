;;;; test-midi.lisp — MIDI decoding and the event ring.
;;;;
;;;; The decoding is bit arithmetic on three bytes, defined by a
;;;; specification that has not changed since 1983 — so unlike anything
;;;; Incudine-facing, it can be checked exhaustively, and is: every status
;;;; byte from #x80 to #xFF, every channel, both fourteen-bit assemblies.
;;;;
;;;; Four things in that specification are traps, and all four produce
;;;; output that reads perfectly well while being wrong:
;;;;
;;;;   - Note-on with velocity 0 IS a note-off. Shown as "note on,
;;;;     velocity 0" it is technically honest and practically useless: the
;;;;     player let go of the key.
;;;;   - Channels are 0-15 on the wire and 1-16 everywhere a musician
;;;;     reads them. Off by one, and every channel in the window is wrong.
;;;;   - The fourteen-bit pairs put the LOW seven bits FIRST. Swapped, a
;;;;     bend of one semitone reads as a wild jump — and both orders yield
;;;;     numbers in range, so nothing looks broken.
;;;;   - Pitch bend centres on 8192, not 0. Raw, a centred wheel looks like
;;;;     a large positive value.
;;;;
;;;; Run: sbcl --script lisp/test-midi.lisp

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

(defun decode (status d1 d2) (clamps-bridge-rpc::%midi-decode status d1 d2))
(defun kind-of (status d1 d2) (getf (decode status d1 d2) :kind))
(defun channel-of (status d1 d2) (getf (decode status d1 d2) :channel))
(defun detail-of (status d1 d2) (getf (decode status d1 d2) :detail))
(defun value-of (status d1 d2) (getf (decode status d1 d2) :value))

;;; ---------------------------------------------------------------------
;;; 1. Every channel message, on every channel
;;; ---------------------------------------------------------------------
(dolist (case* (list (list #x80 :note-off) (list #x90 :note-on)
                     (list #xA0 :poly-pressure) (list #xB0 :control-change)
                     (list #xC0 :program-change) (list #xD0 :channel-pressure)
                     (list #xE0 :pitch-bend)))
  (destructuring-bind (high kind) case*
    (dotimes (channel 16)
      (let ((status (logior high channel)))
        ;; Velocity 64 throughout, so that the note-on case is a real
        ;; note-on rather than the velocity-0 special case.
        (check (format nil "~2,'0X kind" status) (kind-of status 60 64) kind)
        ;; Channels are numbered from ONE, as a musician reads them. Off by
        ;; one and every channel in the window is wrong — readably wrong.
        (check (format nil "~2,'0X channel" status)
               (channel-of status 60 64) (1+ channel))))))

;;; ---------------------------------------------------------------------
;;; 2. Note-on with velocity 0 is a note-off
;;; ---------------------------------------------------------------------
;;; The specification says so and most keyboards send it that way. A
;;; monitor that reports "note on, velocity 0" is honest and useless: the
;;; player let go of the key.
(check "velocity 0 is a note off" (kind-of #x90 60 0) :note-off)
(check "velocity 1 is a note on" (kind-of #x90 60 1) :note-on)
;; And it says where it came from, so that a genuine note-off can still be
;; told from a note-on that means one.
(unless (search "note on" (detail-of #x90 60 0))
  (fail "The velocity-0 note-off does not say it arrived as a note on: ~A"
        (detail-of #x90 60 0)))
(when (search "note on" (detail-of #x80 60 0))
  (fail "A real note-off claims to have arrived as a note on"))

;;; ---------------------------------------------------------------------
;;; 3. Note names, with C4 = 60
;;; ---------------------------------------------------------------------
;;; The octave convention is Incudine's and CLAMPS's. Pick another and
;;; every name is off by an octave — wrong, and entirely readable.
(dolist (case* (list (list 60 "C4") (list 61 "C#4") (list 69 "A4")
                     (list 72 "C5") (list 48 "C3") (list 0 "C-1")
                     (list 127 "G9")))
  (destructuring-bind (number name) case*
    (check (format nil "note ~D" number)
           (clamps-bridge-rpc::%midi-note-name number) name)))
;; A4 = 69 is the tuning reference; if that is not A4, the convention is
;; the wrong one.
(check "the tuning reference is A4" (clamps-bridge-rpc::%midi-note-name 69) "A4")

;;; ---------------------------------------------------------------------
;;; 4. Fourteen-bit values: low seven bits FIRST
;;; ---------------------------------------------------------------------
;;; Swapped, both orders still yield numbers in range, so nothing looks
;;; broken — a bend of one semitone simply reads as a wild jump.
(check "lsb first" (clamps-bridge-rpc::%midi-14bit 0 64) 8192)
(check "lsb alone" (clamps-bridge-rpc::%midi-14bit 1 0) 1)
(check "msb alone" (clamps-bridge-rpc::%midi-14bit 0 1) 128)
(check "maximum" (clamps-bridge-rpc::%midi-14bit 127 127) 16383)
(check "centre" (clamps-bridge-rpc::%midi-14bit 0 64) 8192)
;; The bytes are distinguishable, which is what makes the order testable:
;; with equal bytes a swap would be invisible.
(check "asymmetric pair" (clamps-bridge-rpc::%midi-14bit 3 5) 643)

;;; The bend centre is 8192, not 0.
(check "centred bend" (value-of #xE0 0 64) 8192)
(unless (search "+0" (detail-of #xE0 0 64))
  ;; A centred wheel must read as zero deviation, whatever the raw value.
  (unless (search "0 (raw 8192)" (detail-of #xE0 0 64))
    (fail "A centred bend reads as ~A" (detail-of #xE0 0 64))))
(unless (search "-8192" (detail-of #xE0 0 0))
  (fail "A fully down bend reads as ~A" (detail-of #xE0 0 0)))
(unless (search "+8191" (detail-of #xE0 127 127))
  (fail "A fully up bend reads as ~A" (detail-of #xE0 127 127)))

;;; ---------------------------------------------------------------------
;;; 5. System messages carry no channel
;;; ---------------------------------------------------------------------
;;; #xF8 is not "channel 9". The low nibble of a system message is part of
;;; the message, and reading it as a channel invents one.
(dolist (case* (list (list #xF0 :sysex) (list #xF1 :time-code)
                     (list #xF2 :song-position) (list #xF3 :song-select)
                     (list #xF8 :clock) (list #xFA :start) (list #xFB :continue)
                     (list #xFC :stop) (list #xFE :active-sensing)
                     (list #xFF :reset)))
  (destructuring-bind (status kind) case*
    (check (format nil "~2,'0X kind" status) (kind-of status 0 0) kind)
    (check (format nil "~2,'0X has no channel" status)
           (channel-of status 0 0) nil)))

;;; Song position is fourteen-bit as well, and in the same order.
(check "song position" (value-of #xF2 0 1) 128)

;;; ---------------------------------------------------------------------
;;; 6. Running status is named as such
;;; ---------------------------------------------------------------------
;;; A byte below #x80 is not a status byte: it is data belonging to the
;;; previous message. Reported as "unknown", a perfectly ordinary dense
;;; stream sends the user looking for a fault that is not there.
(dolist (byte '(0 60 100 127))
  (check (format nil "~D is running status" byte)
         (kind-of byte 0 0) :running-status))

;;; ---------------------------------------------------------------------
;;; 7. Named controllers
;;; ---------------------------------------------------------------------
(dolist (case* (list (list 1 "modulation") (list 7 "volume")
                     (list 64 "sustain") (list 11 "expression")))
  (destructuring-bind (number name) case*
    (unless (search name (detail-of #xB0 number 100))
      (fail "CC ~D is not named ~A: ~A" number name (detail-of #xB0 number 100)))))
;; An unnamed controller shows its number without an invented name.
(let ((text (detail-of #xB0 42 100)))
  (unless (search "CC 42 = 100" text)
    (fail "An unnamed controller reads as ~A" text))
  (when (search "(" text)
    (fail "An unnamed controller was given a name: ~A" text)))

;;; ---------------------------------------------------------------------
;;; 8. Nothing throws, over the whole input space
;;; ---------------------------------------------------------------------
;;; Every status byte with every data pair a wire can carry. A monitor that
;;; throws on one message in a thousand takes the whole window with it, and
;;; the message that did it is exactly the one worth seeing.
(let ((tested 0))
  (loop for status from 0 to 255
        do (dolist (d1 '(0 1 63 64 127 200 255))
             (dolist (d2 '(0 1 63 64 127 200 255))
               (handler-case (progn (decode status d1 d2) (incf tested))
                 (error (e)
                   (fail "decode ~2,'0X ~D ~D threw: ~A" status d1 d2 e))))))
  (unless (> tested 12000)
    (fail "Only ~D combinations were exercised" tested)))

;;; Data bytes above 127 are masked rather than passed through: the wire
;;; cannot carry them, so their appearance means a byte was misread, and a
;;; note number of 200 would fall outside every table downstream.
(check "a data byte is masked" (value-of #x90 200 64) 72)

;;; ---------------------------------------------------------------------
;;; 9. The ring
;;; ---------------------------------------------------------------------
;; 16 is the smallest ring make-midi-ring-for-repl will build; asking for
;; 8 silently gets 16. The test asks for the real minimum and reads the
;; capacity back rather than assuming it — an assumed size is how the first
;; version of this test came to accuse the code of serving 16 events from a
;; ring of 8 that was never a ring of 8.
(clamps-bridge-rpc:midi-monitor-start-for-repl 16)
(let* ((ring clamps-bridge-rpc::*midi-ring*)
       (capacity (clamps-bridge-rpc::midi-ring-capacity ring)))
  (check "the smallest ring is 16" capacity 16)
  ;; Three messages, then fetch: exactly those three, decoded.
  (clamps-bridge-rpc:midi-ring-record-for-repl ring #x90 60 100 0.0d0)
  (clamps-bridge-rpc:midi-ring-record-for-repl ring #xB0 7 127 0.1d0)
  (clamps-bridge-rpc:midi-ring-record-for-repl ring #xE0 0 64 0.2d0)
  (let ((r (clamps-bridge-rpc:midi-events-since-for-repl 0)))
    (check "three events" (length (fourth r)) 3)
    (check "sequence" (second r) 3)
    (check "nothing dropped" (third r) 0)
    (check "first is a note on" (getf (first (fourth r)) :kind) :note-on)
    (check "last is a bend" (getf (third (fourth r)) :kind) :pitch-bend)
    ;; The timestamp travels with the message: a monitor without times
    ;; cannot answer "how long between these two".
    (check "the timestamp is kept" (getf (first (fourth r)) :time) 0.0d0))

  ;; Incremental: only what arrived since.
  (clamps-bridge-rpc:midi-ring-record-for-repl ring #x80 60 0 0.3d0)
  (let ((r (clamps-bridge-rpc:midi-events-since-for-repl 3)))
    (check "one new event" (length (fourth r)) 1)
    (check "and it is the note off" (getf (first (fourth r)) :kind) :note-off))

  ;; Overrun: twice the capacity in messages. What fell out is counted and
  ;; said. A monitor that silently drops events is worse than none — the
  ;; question it exists to answer is whether something arrived.
  (dotimes (i (* 2 capacity))
    (clamps-bridge-rpc:midi-ring-record-for-repl ring #x90 (+ 40 (mod i 80)) 64
                                                 (float i 1.0d0)))
  (let ((r (clamps-bridge-rpc:midi-events-since-for-repl 4)))
    (unless (> (third r) 0)
      (fail "An overrun ring reports ~D dropped" (third r)))
    ;; Never more than the ring holds. Reading twice round the buffer would
    ;; serve the same slots again as fresh messages, and a note played once
    ;; would appear twice — worse than losing it, because the monitor is
    ;; the only witness.
    (unless (<= (length (fourth r)) capacity)
      (fail "~D events from a ring of ~D" (length (fourth r)) capacity))
    ;; And the count adds up: what was delivered plus what was dropped is
    ;; everything that arrived since.
    (let ((total (+ (length (fourth r)) (third r)))
          (expected (- (second r) 4)))
      (unless (= total expected)
        (fail "~D delivered plus ~D dropped is ~D, but ~D arrived since"
              (length (fourth r)) (third r) total expected)))))

;;; Without a running monitor the answer is an error, not an empty list: an
;;; empty window is indistinguishable from one that works and receives
;;; nothing, which is the worst possible answer to the question of whether a
;;; controller is sending at all.
(clamps-bridge-rpc:midi-monitor-stop-for-repl)
(let ((r (clamps-bridge-rpc:midi-events-since-for-repl 0)))
  (unless (eq (first r) :error)
    (fail "A stopped monitor returns ~S instead of an error" (first r))))

;;; Recording returns the sequence number, not the ring.
;;;
;;; This ring holds four unboxed arrays of the full capacity — 8192 numbers
;;; for a ring of 2048 — so returning the structure buries the result when
;;; the function is called by hand in the REPL. The sequence number is also
;;; the cursor for the next fetch.
(clamps-bridge-rpc:midi-monitor-start-for-repl 64)
(let ((ring clamps-bridge-rpc::*midi-ring*))
  (check "the first record returns 1"
         (clamps-bridge-rpc:midi-ring-record-for-repl ring #x90 60 100 0.0d0) 1)
  (check "the second returns 2"
         (clamps-bridge-rpc:midi-ring-record-for-repl ring #x80 60 0 0.1d0) 2))
(clamps-bridge-rpc:midi-monitor-stop-for-repl)

;;; ---------------------------------------------------------------------
;;; 10. Recording does not cons
;;; ---------------------------------------------------------------------
;;; MIDI arrives in a callback that must not allocate. A pitch-bend sweep
;;; is a thousand messages a second, and the editor must not be the reason
;;; the timing slips.
(clamps-bridge-rpc:midi-monitor-start-for-repl 1024)
(let ((ring clamps-bridge-rpc::*midi-ring*)
      (iterations 100000))
  (dotimes (i 1000)
    (clamps-bridge-rpc:midi-ring-record-for-repl ring #x90 60 64 0.0d0))
  (let ((before (sb-ext:get-bytes-consed)))
    (dotimes (i iterations)
      (clamps-bridge-rpc:midi-ring-record-for-repl ring #x90 60 64 0.0d0))
    (let ((consed (- (sb-ext:get-bytes-consed) before)))
      (when (> consed 16384)
        (fail "midi-ring-record-for-repl conses ~D bytes over ~D calls — ~
the MIDI callback is allocating" consed iterations))
      (format t "midi ring: ~D bytes over ~D calls~%" consed iterations))))
(clamps-bridge-rpc:midi-monitor-stop-for-repl)

;;; ---------------------------------------------------------------------
;;; 11. Attaching leaves other responders alone
;;; ---------------------------------------------------------------------
;;; The monitor listens on the same stream cl-midictl uses, and CLAMPS
;;; starts that receiver during startup — its registered controllers depend
;;; on it. Two things must therefore hold, and neither is visible from the
;;; window:
;;;
;;;   - Only the monitor's OWN responder is removed on stopping. Clearing
;;;     the list would disable every controller in the session, silently,
;;;     and the user would look for the fault in their patch.
;;;   - A receiver that was already running is not stopped. Stopping it
;;;     would have the same effect by another route.
;;;
;;; A stand-in package supplies the Incudine surface and records what was
;;; done to it, so this is checkable without an interface.
(defpackage #:midi-recv-probe (:use #:cl)
  (:export #:make-responder #:remove-responder #:recv-start #:recv-stop
           #:recv-status #:recv-functions #:now #:rt-sample-rate))
(in-package #:midi-recv-probe)
(defvar *responders* '())
(defvar *status* :running)
(defvar *started* 0)
(defvar *stopped* 0)
(defun make-responder (stream function)
  (declare (ignore stream))
  (push function *responders*)
  function)
(defun remove-responder (responder)
  (setf *responders* (remove responder *responders*)))
(defun recv-start (stream) (declare (ignore stream)) (incf *started*) :started)
(defun recv-stop (stream) (declare (ignore stream)) (incf *stopped*) :stopped)
(defun recv-status (stream) (declare (ignore stream)) *status*)
(defun recv-functions (stream) (declare (ignore stream)) *responders*)
(defun now () 0)
(defun rt-sample-rate () 44100)
(in-package :cl-user)

(defpackage #:midi-stream-probe (:use #:cl))
(let ((sym (intern "*MIDI-IN1*" '#:midi-stream-probe)))
  (proclaim (list 'special sym))
  (setf (symbol-value sym) :a-stream))

;;; The receiver is already running: attach, do not start.
(let ((clamps-bridge-rpc::*rt-packages* '(:midi-recv-probe))
      (clamps-bridge-rpc::*midi-stream-packages* '(:midi-stream-probe)))
  (setf midi-recv-probe::*responders* (list :a-foreign-responder)
        midi-recv-probe::*status* :running
        midi-recv-probe::*started* 0
        midi-recv-probe::*stopped* 0)
  (let ((r (clamps-bridge-rpc:midi-monitor-start-for-repl 64)))
    (unless (eq (first r) :ok)
      (fail "Attaching reports ~S" r))
    (unless (search "already running" (second r))
      (fail "The message does not say the receiver was already running: ~A"
            (second r)))
    (check "the receiver was not started again" midi-recv-probe::*started* 0)
    (check "two responders now" (length midi-recv-probe::*responders*) 2))

  ;; The responder really records: a message pushed through it must arrive
  ;; in the ring, decoded.
  (let ((ours (find-if #'functionp midi-recv-probe::*responders*)))
    (unless ours (fail "The monitor registered no function"))
    (when ours
      (funcall ours #x90 60 100 :ignored)
      (funcall ours #xE0 0 64 :ignored)
      (let ((events (fourth (clamps-bridge-rpc:midi-events-since-for-repl 0))))
        (check "two events arrived" (length events) 2)
        (check "the first is a note on" (getf (first events) :kind) :note-on)
        (check "the second is a bend" (getf (second events) :kind) :pitch-bend))))

  ;; Stopping removes OUR responder and leaves the foreign one.
  (clamps-bridge-rpc:midi-monitor-stop-for-repl)
  (check "the foreign responder survives"
         midi-recv-probe::*responders* (list :a-foreign-responder))
  ;; And a receiver that was already running is not stopped: CLAMPS's own
  ;; controllers depend on it.
  (check "the running receiver was not stopped" midi-recv-probe::*stopped* 0))

;;; The receiver is NOT running: start it, and stop it again on closing.
(let ((clamps-bridge-rpc::*rt-packages* '(:midi-recv-probe))
      (clamps-bridge-rpc::*midi-stream-packages* '(:midi-stream-probe)))
  (setf midi-recv-probe::*responders* '()
        midi-recv-probe::*status* :stopped
        midi-recv-probe::*started* 0
        midi-recv-probe::*stopped* 0)
  (let ((r (clamps-bridge-rpc:midi-monitor-start-for-repl 64)))
    (unless (search "started by the monitor" (second r))
      (fail "The message does not say the monitor started the receiver: ~A"
            (second r))))
  (check "the receiver was started" midi-recv-probe::*started* 1)
  (clamps-bridge-rpc:midi-monitor-stop-for-repl)
  (check "and stopped again" midi-recv-probe::*stopped* 1))

;;; No stream at all: the ring is still built, and the message says what was
;;; looked for. Without an interface this is the normal case, and an empty
;;; window with no explanation would be the worst answer.
(let ((clamps-bridge-rpc::*midi-stream-packages* '(:no-such-package-here)))
  (let ((r (clamps-bridge-rpc:midi-monitor-start-for-repl 64)))
    (unless (eq (first r) :ok)
      (fail "A missing stream reports ~S" r))
    (unless (search "*MIDI-IN1*" (second r))
      (fail "The message does not name what was looked for: ~A" (second r))))
  ;; And the ring works, so the window can be exercised by hand.
  (clamps-bridge-rpc:midi-ring-record-for-repl clamps-bridge-rpc::*midi-ring*
                                               #x90 60 100 0.0d0)
  (check "recording by hand still works"
         (length (fourth (clamps-bridge-rpc:midi-events-since-for-repl 0))) 1))
(clamps-bridge-rpc:midi-monitor-stop-for-repl)

(if (> *failed* 0)
    (progn (format t "~%~D test(s) failed.~%" *failed*)
           (sb-ext:exit :code 1))
    (format t "ok — MIDI: every status byte decoded, velocity-0 note-offs, ~
channels from one, 14-bit order, running status named, ring allocation-free~%"))
