(load (merge-pathnames "rpc.lisp" *load-truename*))

(in-package :cl-user)

;;; 1. Allgemeiner Pfad: Begrenzung, Ueberschreiben, Reihenfolge.
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

;;; 2. Sample-Pfad: unboxed Ring, gleiche Ring-Semantik.
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

;;; 3. Dezimierung: der Aufrufer ruft bedingungslos, der State duennt aus.
;;;    Das ist der Punkt, an dem die Incudine-VUG-Falle vermieden wird —
;;;    ein (when ... ) im dsp!-Koerper wuerde das Update der VUG-Variablen
;;;    mit in den Zweig ziehen.
(let ((state (clamps-bridge-rpc:make-sticker-sample-state-for-repl 8 4)))
  (clamps-bridge-rpc:register-sticker-state-for-repl "decimated" state)
  (dotimes (i 12)
    (clamps-bridge-rpc:sticker-state-record-sample-for-repl state (coerce i 'double-float)))
  (let* ((snapshot (clamps-bridge-rpc:sticker-snapshot-for-repl))
         (records (second (first (second snapshot))))
         (values* (mapcar (lambda (r) (read-from-string (third r))) records)))
    ;; i = 0, 4, 8 werden behalten.
    (assert (equal values* '(0.0d0 4.0d0 8.0d0))))
  (clamps-bridge-rpc:sticker-clear-for-repl))

;;; 4. Dezimierung 1 behaelt jeden Wert.
(let ((state (clamps-bridge-rpc:make-sticker-sample-state-for-repl 8 1)))
  (dotimes (i 3)
    (clamps-bridge-rpc:sticker-state-record-sample-for-repl state (coerce i 'double-float)))
  (assert (= 3 (clamps-bridge-rpc::sticker-state-count state))))

;;; 5. Der eigentliche Realtime-Gate: der Sample-Pfad darf nicht konsen.
;;;    Ein geboxtes double-float kostet 16 Byte pro Aufruf; die Schwelle
;;;    unten liegt weit darunter und weit ueber dem Messrauschen.
#+sbcl
(let ((state (clamps-bridge-rpc:make-sticker-sample-state-for-repl 64 441))
      (iterations 200000)
      (limit 65536))
  (declare (type fixnum iterations limit))
  ;; Warmlauf, damit einmalige Effekte nicht in die Messung fallen.
  (dotimes (i 1000)
    (clamps-bridge-rpc:sticker-state-record-sample-for-repl state 0.5d0))
  (let* ((before (sb-ext:get-bytes-consed))
         (ignore (dotimes (i iterations)
                   (clamps-bridge-rpc:sticker-state-record-sample-for-repl state 0.5d0)))
         (consed (- (sb-ext:get-bytes-consed) before)))
    (declare (ignore ignore))
    (unless (< consed limit)
      (error "sticker-state-record-sample-for-repl konsiert ~D Byte bei ~D Aufrufen ~
              (Grenze ~D). Der DSP-Hot-Path alloziert wieder — vermutlich wird ~
              das double-float geboxt."
             consed iterations limit))
    (format t "sticker-state: ~D Byte bei ~D Sample-Aufrufen~%" consed iterations)))

;;; 6. Der allgemeine Pfad bleibt fuer Nicht-Fliesskommawerte nutzbar.
(let ((state (clamps-bridge-rpc:make-sticker-state-for-repl 4 :decimation 2)))
  (dotimes (i 4)
    (clamps-bridge-rpc:sticker-state-record-for-repl state i))
  (assert (= 2 (clamps-bridge-rpc::sticker-state-count state))))

;;; 7. Fehlerhafte Parameter werden abgewiesen, nicht stillschweigend geschluckt.
(assert (nth-value 1 (ignore-errors (clamps-bridge-rpc:make-sticker-state-for-repl 0))))
(assert (nth-value 1 (ignore-errors (clamps-bridge-rpc:make-sticker-state-for-repl 4 :decimation 0))))
(assert (nth-value 1 (ignore-errors (clamps-bridge-rpc:make-sticker-state-for-repl 4 :element-type 'single-float))))


;;; 8. RMS-Pfad: ein Wert pro Fenster, am Fensterende, kein Sample verworfen.
(let ((state (clamps-bridge-rpc:make-sticker-sample-state-for-repl 8 4)))
  (clamps-bridge-rpc:register-sticker-state-for-repl "rms" state)
  ;; Erste drei Aufrufe fuellen nur den Akkumulator.
  (dotimes (i 3) (clamps-bridge-rpc:sticker-state-record-rms-for-repl state 1.0d0))
  (assert (= 0 (clamps-bridge-rpc::sticker-state-count state)))
  ;; Der vierte schliesst das Fenster: RMS von (1 1 1 1) = 1.
  (clamps-bridge-rpc:sticker-state-record-rms-for-repl state 1.0d0)
  (assert (= 1 (clamps-bridge-rpc::sticker-state-count state)))
  (assert (< (abs (- 1.0d0 (first (clamps-bridge-rpc::%sticker-state-values-oldest-first state))))
             1.0d-12))
  ;; Vorzeichen spielt keine Rolle: RMS von (1 -1 1 -1) ist ebenfalls 1.
  (dotimes (i 4)
    (clamps-bridge-rpc:sticker-state-record-rms-for-repl state (if (evenp i) 1.0d0 -1.0d0)))
  (assert (< (abs (- 1.0d0 (second (clamps-bridge-rpc::%sticker-state-values-oldest-first state))))
             1.0d-12))
  (clamps-bridge-rpc:sticker-clear-for-repl))

;;; 9. RMS eines Sinus liegt bei Amplitude/sqrt(2), unabhaengig von der
;;;    Fensterlage.  Genau das kann der Sample-Pfad nicht: er liest bei 330 Hz
;;;    und Fenster 441 immer nur einen einzelnen Phasenpunkt und schwankt
;;;    daher ueber die volle Amplitude.  Der Test vergleicht beide Pfade am
;;;    selben Signal.
;;;
;;;    441 Samples bei 330 Hz sind 3,3 Perioden, also kein ganzzahliges
;;;    Vielfaches.  Der RMS eines angeschnittenen Fensters weicht deshalb um
;;;    wenige Prozent vom Idealwert ab und schwankt leicht von Fenster zu
;;;    Fenster.  Das ist Eigenschaft des Verfahrens, nicht Fehler der
;;;    Implementierung, und die Toleranzen unten bilden es ab.
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
    ;; Jeder RMS-Wert liegt innerhalb von 5 % am Idealwert.
    (dolist (v rms-values)
      (assert (< (abs (- v expected)) (* 0.05d0 expected))
              () "RMS ~,6F weicht zu weit von ~,6F ab." v expected))
    ;; Und die Werte untereinander schwanken kaum.
    (assert (< rms-spread (* 0.05d0 expected))
            () "RMS-Streuung ~,6F zu gross." rms-spread)
    ;; Der Sample-Pfad dagegen streut ueber praktisch die ganze Amplitude.
    (assert (> raw-spread amplitude)
            () "Sample-Pfad streut nur ~,6F — der Vergleich traegt nicht mehr."
            raw-spread)))

;;; 10. Auch der RMS-Pfad darf nicht konsen.
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
      (error "sticker-state-record-rms-for-repl konsiert ~D Byte bei ~D Aufrufen ~
              (Grenze ~D)."
             consed iterations limit))
    (format t "sticker-state: ~D Byte bei ~D RMS-Aufrufen~%" consed iterations)))

(format t "sticker-state: ok~%")
