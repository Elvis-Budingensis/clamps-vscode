;;;; bridge-server.lisp
;;;;
;;;; Übersetzt zwischen LSP (JSON-RPC über stdio, Richtung VS Code) und
;;;; dem Swank-Wire-Protokoll (Richtung SBCL-Prozess aus bootstrap.lisp).
;;;;
;;;; WICHTIG: *standard-output* ist der LSP-Nachrichtenkanal. Es darf
;;;; NICHTS außer über write-lsp-message dort landen – jedes stray
;;;; (format t ...) oder eine SBCL-Warnung auf stdout zerstört das
;;;; Framing. Logging geht deshalb konsequent in bridge.log, nie auf
;;;; stdout. stderr ist unkritisch (VS Code liest davon nicht für LSP).
;;;;
;;;; BEKANNTE EINSCHRÄNKUNGEN (bewusst nicht gelöst, für den nächsten
;;;; Ausbauschritt):
;;;;   - Positions-Handling ist naives Zeichen-Counting, kein UTF-16-
;;;;     Code-Unit-Offset wie es der LSP-Spec eigentlich verlangt.
;;;;     Bei Umlauten/Emoji in Kommentaren kann das um wenige Zeichen
;;;;     danebenliegen.
;;;;   - read-swank-message nutzt CL:READ-FROM-STRING auf der Antwort.
;;;;     Enthält die Antwort Symbole aus Paketen, die im Bridge-Prozess
;;;;     nicht existieren (z. B. interne CLAMPS-Symbole in Backtraces),
;;;;     schlägt das Lesen fehl. Aktuell: Fehler wird geloggt, Anfrage
;;;;     bekommt eine leere Antwort statt eines Absturzes. Für robustere
;;;;     Introspektion bräuchte es einen toleranten Reader.
;;;;   - DAP (Debugger) ist NICHT implementiert. :debug-Events von Swank
;;;;     werden nur geloggt. Siehe TODO bei handle-swank-message.

(require :asdf)

(let ((ql-init (merge-pathnames "quicklisp/setup.lisp" (user-homedir-pathname))))
  (when (probe-file ql-init) (load ql-init)))

(handler-case
    (ql:quickload '(:usocket :bordeaux-threads) :silent t)
  (error (e)
    (format *error-output* "~&[clamps-bridge] FATAL beim Laden von usocket/bordeaux-threads: ~A~%" e)
    (force-output *error-output*)
    (sb-ext:exit :code 1)))

(defpackage :clamps-bridge
  (:use :cl))
(in-package :clamps-bridge)

;;; ---------------------------------------------------------------------
;;; Logging (niemals auf *standard-output* – siehe Kommentar oben)
;;; ---------------------------------------------------------------------

(defvar *log-file* nil)
(defparameter *fallback-log-file* #P"/tmp/clamps-bridge-fallback.log")

(defun init-logging (session-dir)
  (setf *log-file* (merge-pathnames "bridge.log" session-dir)))

(defun log-msg (fmt &rest args)
  ;; Schreibt IMMER irgendwohin, auch bevor init-logging lief (Fehler
  ;; ganz am Anfang landeten vorher im Nichts, weil *log-file* noch nil
  ;; war und die alte Version dann einfach gar nichts tat).
  (let ((target (or *log-file* *fallback-log-file*)))
    (ignore-errors
      (with-open-file (s target :direction :output
                                 :if-exists :append
                                 :if-does-not-exist :create)
        (format s "~&[~A] " (get-universal-time))
        (apply #'format s fmt args)
        (terpri s))))
  ;; Zusätzlich auf stderr: bei manuellem Start im Terminal sofort
  ;; sichtbar, unabhängig davon ob das Log-File-Schreiben klappt.
  (ignore-errors
    (format *error-output* "~&[clamps-bridge] ")
    (apply #'format *error-output* fmt args)
    (terpri *error-output*)
    (force-output *error-output*)))

;;; ---------------------------------------------------------------------
;;; Minimaler JSON-Reader/-Writer (bewusst ohne yason/jzon-Abhängigkeit,
;;; um explizite Kontrolle über true/false/null zu haben)
;;; ---------------------------------------------------------------------

(defun make-jobj (&rest plist)
  (let ((h (make-hash-table :test 'equal)))
    (loop for (k v) on plist by #'cddr do (setf (gethash k h) v))
    h))

(defun json-read (string)
  (let ((pos 0) (len (length string)))
    (labels ((peek () (if (< pos len) (char string pos) nil))
             (advance () (prog1 (peek) (incf pos)))
             (skip-ws ()
               (loop while (and (< pos len)
                                 (member (peek) '(#\Space #\Tab #\Newline #\Return)))
                     do (incf pos)))
             (parse-value ()
               (skip-ws)
               (case (peek)
                 (#\{ (parse-object))
                 (#\[ (parse-array))
                 (#\" (parse-string))
                 (t (cond
                      ((and (<= (+ pos 4) len) (string= string "true" :start1 pos :end1 (+ pos 4)))
                       (incf pos 4) :true)
                      ((and (<= (+ pos 5) len) (string= string "false" :start1 pos :end1 (+ pos 5)))
                       (incf pos 5) :false)
                      ((and (<= (+ pos 4) len) (string= string "null" :start1 pos :end1 (+ pos 4)))
                       (incf pos 4) :null)
                      (t (parse-number))))))
             (parse-object ()
               (let ((h (make-hash-table :test 'equal)))
                 (advance) ; {
                 (skip-ws)
                 (unless (eql (peek) #\})
                   (loop
                     (skip-ws)
                     (let ((key (parse-string)))
                       (skip-ws) (advance) ; :
                       (setf (gethash key h) (parse-value)))
                     (skip-ws)
                     (if (eql (peek) #\,) (advance) (return))))
                 (skip-ws) (advance) ; }
                 h))
             (parse-array ()
               (let ((items '()))
                 (advance) ; [
                 (skip-ws)
                 (unless (eql (peek) #\])
                   (loop
                     (push (parse-value) items)
                     (skip-ws)
                     (if (eql (peek) #\,) (advance) (return))))
                 (skip-ws) (advance) ; ]
                 (coerce (nreverse items) 'vector)))
             (parse-string ()
               (advance) ; "
               (with-output-to-string (s)
                 (loop
                   (let ((ch (advance)))
                     (cond
                       ((eql ch #\") (return))
                       ((eql ch #\\)
                        (let ((esc (advance)))
                          (case esc
                            (#\n (write-char #\Newline s))
                            (#\t (write-char #\Tab s))
                            (#\r (write-char #\Return s))
                            (#\u (let ((hex (subseq string pos (+ pos 4))))
                                   (incf pos 4)
                                   (write-char (code-char (parse-integer hex :radix 16)) s)))
                            (t (write-char esc s)))))
                       (t (write-char ch s)))))))
             (parse-number ()
               (let ((start pos))
                 (loop while (and (< pos len) (find (peek) "-+0123456789.eE")) do (advance))
                 (let ((token (subseq string start pos)))
                   (if (find-if (lambda (c) (find c ".eE")) token)
                       (let ((*read-default-float-format* 'double-float))
                         (read-from-string token))
                       (parse-integer token))))))
      (parse-value))))

(defun json-write-string (s stream)
  (write-char #\" stream)
  (loop for ch across s do
    (case ch
      (#\" (write-string "\\\"" stream))
      (#\\ (write-string "\\\\" stream))
      (#\Newline (write-string "\\n" stream))
      (#\Tab (write-string "\\t" stream))
      (#\Return (write-string "\\r" stream))
      (t (write-char ch stream))))
  (write-char #\" stream))

(defun json-write (obj stream)
  (etypecase obj
    (hash-table
     (write-char #\{ stream)
     (let ((first t))
       (maphash (lambda (k v)
                  (unless first (write-char #\, stream))
                  (setf first nil)
                  (json-write-string k stream)
                  (write-char #\: stream)
                  (json-write v stream))
                obj))
     (write-char #\} stream))
    ;; STRING must precede VECTOR: Common Lisp strings are vectors of characters.
    (string (json-write-string obj stream))
    (vector
     (write-char #\[ stream)
     (loop for i from 0 below (length obj)
           do (when (> i 0) (write-char #\, stream))
              (json-write (aref obj i) stream))
     (write-char #\] stream))
    (integer (format stream "~D" obj))
    (float (format stream "~F" obj))
    (symbol
     (cond
       ((eq obj :true) (write-string "true" stream))
       ((eq obj :false) (write-string "false" stream))
       ((or (eq obj :null) (null obj)) (write-string "null" stream))
       (t (json-write-string (string-downcase (symbol-name obj)) stream))))))

;;; ---------------------------------------------------------------------
;;; LSP-Transport (Content-Length-Framing über stdio)
;;; ---------------------------------------------------------------------

(defvar *stdout-lock* (bt:make-lock))

(defun read-lsp-message (stream)
  (let ((content-length nil))
    (loop
      (let ((line (read-line stream nil nil)))
        (when (null line) (return-from read-lsp-message nil))
        (setf line (string-right-trim '(#\Return) line))
        (when (string= line "") (return))
        (let ((idx (position #\: line)))
          (when (and idx (string-equal (subseq line 0 idx) "Content-Length"))
            (setf content-length (parse-integer (string-trim " " (subseq line (1+ idx)))))))))
    (unless content-length (return-from read-lsp-message nil))
    (let ((buf (make-string content-length)))
      (read-sequence buf stream)
      (json-read buf))))

(defun write-lsp-message (obj)
  (bt:with-lock-held (*stdout-lock*)
    (let* ((body (with-output-to-string (s) (json-write obj s)))
           ;; LSP verlangt Content-Length in BYTES (UTF-8), nicht in
           ;; Zeichen. Ein Umlaut oder Em-Dash ist 1 Zeichen, aber 2-3
           ;; Bytes — (length body) war zu klein, der Client las eine
           ;; abgeschnittene Nachricht, der JSON-Parser brach ab
           ;; ("Expected ',' or '}'"). Byte-Länge über die Oktette.
           (byte-length (length (sb-ext:string-to-octets body :external-format :utf-8))))
      (format *standard-output* "Content-Length: ~D~C~C~C~C"
              byte-length #\Return #\Newline #\Return #\Newline)
      (write-string body *standard-output*)
      (force-output *standard-output*))))

(defun send-response (id result)
  (write-lsp-message (make-jobj "jsonrpc" "2.0" "id" id "result" result)))

(defun send-error (id code message)
  (write-lsp-message
   (make-jobj "jsonrpc" "2.0" "id" id
              "error" (make-jobj "code" code "message" message))))

;;; ---------------------------------------------------------------------
;;; Swank-Client (Wire-Protokoll: 6-Hex-Zeichen Länge + gedruckte Form)
;;; ---------------------------------------------------------------------

(defvar *swank-stream*)
(defvar *swank-lock* (bt:make-lock))
(defvar *pending-requests* (make-hash-table))
(defvar *swank-request-id* 0)
(defvar *swank-package* "COMMON-LISP-USER")

(defun next-swank-id ()
  (bt:with-lock-held (*swank-lock*) (incf *swank-request-id*)))

(defun connect-swank (host port)
  (usocket:socket-stream (usocket:socket-connect host port :element-type 'character)))

(defun send-swank-text (text)
  (bt:with-lock-held (*swank-lock*)
    (write-string (format nil "~6,'0X" (length text)) *swank-stream*)
    (write-string text *swank-stream*)
    (force-output *swank-stream*)))

(defun swank-rex (form-string &key (package *swank-package*) callback)
  "FORM-STRING ist ein fertig formatierter Lisp-Form-String, z.B.
   (format nil \"(swank:simple-completions ~S ~S)\" prefix package).
   Bewusst String statt Lisp-Datenstruktur: so muss das Bridge-Image
   die Symbole (swank:..., clamps:...) nicht selbst kennen."
  (let ((id (next-swank-id)))
    (when callback (setf (gethash id *pending-requests*) callback))
    (send-swank-text (format nil "(:emacs-rex ~A ~S t ~D)" form-string package id))
    id))

(defpackage :clamps-bridge-swank-read
  (:use)
  (:documentation
   "Auffangpaket fürs Lesen von Swank-Nachrichten. Alle Symbole aus der
    Nachricht werden hier interniert, damit unbekannte Quellpakete (etwa
    cffi-features) den Reader nicht sprengen."))

(defvar *swank-readtable*
  (let ((rt (copy-readtable nil)))
    ;; Den Doppelpunkt zu einem gewöhnlichen Konstituenten machen. Damit
    ;; behandelt der Reader "cffi-features:foo" als EIN Token und schlägt
    ;; nicht mehr fehl, weil das Paket cffi-features nicht existiert. Die
    ;; Nachricht wird zwar leicht verfälscht (das Symbol heisst dann
    ;; |cffi-features:foo| statt cffi-features::foo), aber für den
    ;; Dispatch zählen nur die führenden Keywords, und die verarbeiten wir
    ;; separat über read-keyword unten.
    (set-syntax-from-char #\: #\a rt)
    rt)
  "Readtable, der Paket-Doppelpunkte als normale Zeichen liest.")

(defun read-swank-message (stream)
  (let ((len-str (make-string 6)))
    (let ((n (read-sequence len-str stream)))
      (when (< n 6) (return-from read-swank-message nil)))
    (let* ((len (parse-integer len-str :radix 16))
           (buf (make-string len)))
      (read-sequence buf stream)
      (handler-case
          ;; Erst der normale, korrekte Reader. Der versteht Keywords
          ;; richtig und ist für die allermeisten Nachrichten der Fall.
          (let ((*read-eval* nil))
            (read-from-string buf))
        (error ()
          ;; Nur wenn der normale Reader scheitert (unbekanntes Paket in
          ;; einer Notification), der nachsichtige Zweite Versuch: mit
          ;; entwertetem Doppelpunkt und im Auffangpaket. Das verfälscht
          ;; Nicht-Keyword-Symbole, aber solche Nachrichten (new-features,
          ;; indentation-update) werten wir ohnehin nicht aus — es geht
          ;; nur darum, den Stream nicht zu verlieren.
          (handler-case
              (let ((*read-eval* nil)
                    (*readtable* *swank-readtable*)
                    (*package* (find-package :clamps-bridge-swank-read)))
                (%fixup-leading-keyword (read-from-string buf)))
            (error (e)
              (log-msg "Konnte Swank-Antwort nicht lesen (~A): ~A" e
                        (subseq buf 0 (min 200 (length buf))))
              :unreadable)))))))

(defun %fixup-leading-keyword (form)
  "Der nachsichtige Reader liest das führende :return/:debug/… als
   normales Symbol |:return| im Auffangpaket. Für den Dispatch machen wir
   daraus wieder ein echtes Keyword, sofern der Name mit : beginnt."
  (if (and (consp form) (symbolp (first form)))
      (let ((name (symbol-name (first form))))
        (if (and (> (length name) 0) (char= (char name 0) #\:))
            (cons (intern (string-upcase (subseq name 1)) :keyword)
                  (rest form))
            form))
      form))

(defun handle-swank-message (msg)
  (cond
    ((eq msg :unreadable) nil)
    ((not (consp msg)) (log-msg "Unerwartete Swank-Nachricht: ~S" msg))
    ((eq (first msg) :return)
     (let* ((result (second msg))
            (id (third msg))
            (cb (gethash id *pending-requests*)))
       (remhash id *pending-requests*)
       (when cb
         (if (and (consp result) (eq (first result) :ok))
             (funcall cb :ok (second result))
             (funcall cb :abort result)))))
    ((eq (first msg) :debug)
     ;; TODO: hier setzt die DAP-Anbindung an. Ein :debug-Event heißt,
     ;; SBCL ist in den Debugger gefallen (Condition + Restarts). Für
     ;; DAP müsste das zu einem StoppedEvent + StackTraceResponse
     ;; werden, siehe swank:debugger-info-for-emacs für die Struktur.
     (log-msg "Debug-Event empfangen (DAP noch nicht angebunden): ~S" msg))
    (t (log-msg "Unbehandeltes Swank-Event: ~S" (first msg)))))

(defun swank-reader-loop ()
  (loop
    (let ((msg (handler-case (read-swank-message *swank-stream*)
                 (error (e) (log-msg "Swank-Leseschleife-Fehler: ~A" e) nil))))
      (unless msg (return))
      (handle-swank-message msg))))

;;; ---------------------------------------------------------------------
;;; Dokument-Store + Symbol-Erkennung an Cursor-Position
;;; ---------------------------------------------------------------------

(defvar *documents* (make-hash-table :test 'equal))

(defun nth-line (text line-number)
  (let ((start 0) (current 0))
    (loop
      (let ((nl (position #\Newline text :start start)))
        (when (= current line-number)
          (return-from nth-line (subseq text start (or nl (length text)))))
        (unless nl (return-from nth-line ""))
        (setf start (1+ nl))
        (incf current)))))

(defun symbol-constituent-p (ch)
  (or (alphanumericp ch) (find ch "-+*/<>=!?_%&^~.:@")))

(defun symbol-at (text line character)
  (let ((line-text (nth-line text line)))
    (when (and line-text (<= character (length line-text)))
      (let ((start character) (end character))
        (loop while (and (> start 0) (symbol-constituent-p (char line-text (1- start))))
              do (decf start))
        (loop while (and (< end (length line-text)) (symbol-constituent-p (char line-text end)))
              do (incf end))
        (when (> end start) (subseq line-text start end))))))

;;; ---------------------------------------------------------------------
;;; LSP-Request-Handler
;;; ---------------------------------------------------------------------

(defun handle-initialize (id)
  (send-response id
    (make-jobj
     "capabilities" (make-jobj
                     "textDocumentSync" 1 ; Full-Sync, einfachste Variante
                     "hoverProvider" :true
                     ;; ":" als Trigger, damit "incudine:" sofort die
                     ;; externen Symbole des Pakets anbietet, ohne dass
                     ;; man erst einen Buchstaben tippen muss.
                     "completionProvider" (make-jobj
                                           "triggerCharacters" (vector ":"))
                     "definitionProvider" :true)
     "serverInfo" (make-jobj "name" "clamps-bridge" "version" "0.1.0"))))

(defun handle-did-open (params)
  (let* ((doc (gethash "textDocument" params)))
    (setf (gethash (gethash "uri" doc) *documents*) (gethash "text" doc))))

(defun handle-did-change (params)
  (let* ((doc (gethash "textDocument" params))
         (changes (gethash "contentChanges" params)))
    (when (> (length changes) 0)
      (setf (gethash (gethash "uri" doc) *documents*)
            (gethash "text" (aref changes 0))))))

(defun position-symbol (params)
  (let* ((doc (gethash "textDocument" params))
         (pos (gethash "position" params))
         (text (gethash (gethash "uri" doc) *documents*)))
    (and text (symbol-at text (gethash "line" pos) (gethash "character" pos)))))

(defun handle-hover (id params)
  (let ((sym (position-symbol params)))
    (if (null sym)
        (send-response id :null)
        (swank-rex
         (format nil "(swank:describe-symbol ~S)" sym)
         :callback
         (lambda (status value)
           (if (eq status :ok)
               (send-response id (make-jobj "contents" (make-jobj "kind" "markdown" "value" (or value ""))))
               (send-response id :null)))))))

(defun prefix-before-point (text line character)
  "Nur die Zeichen VOR dem Cursor. symbol-at liest in beide Richtungen —
   bei \"rt-st|art\" käme dort \"rt-start\" heraus und die Completion
   würde nach dem vollständigen Namen filtern statt nach dem Getippten."
  (let ((line-text (nth-line text line)))
    (when line-text
      (let* ((end (min character (length line-text)))
             (start end))
        (loop while (and (> start 0)
                         (symbol-constituent-p (char line-text (1- start))))
              do (decf start))
        (subseq line-text start end)))))

(defun handle-completion (id params)
  "textDocument/completion — Symbolvervollständigung.

   Zwei Dinge, die die frühere Fassung falsch machte: sie nahm
   *swank-package* (das Paket der REPL) statt des in der Datei gültigen
   in-package, und sie schickte auch die Zeichen hinter dem Cursor mit."
  (let* ((doc (gethash "textDocument" params))
         (pos (gethash "position" params))
         (text (and doc (gethash (gethash "uri" doc) *documents*)))
         (line (and pos (gethash "line" pos)))
         (character (and pos (gethash "character" pos)))
         (prefix (or (and text (prefix-before-point text line character)) ""))
         (pkg (if text
                  (package-at-position text line character)
                  *swank-package*)))
    (if (string= prefix "")
        ;; Ohne Präfix nicht das ganze Image schicken.
        (send-response id (make-jobj "isIncomplete" :true "items" (vector)))
        (swank-rex
         (format nil "(clamps-bridge-rpc:completions-for-repl ~S ~S)" prefix pkg)
         :callback
         (lambda (status value)
           (if (and (eq status :ok) (consp value) (eq (first value) :ok))
               (destructuring-bind (ok truncated items) value
                 (declare (ignore ok))
                 (send-response id
                   (make-jobj
                    "isIncomplete" (if truncated :true :false)
                    "items"
                    (coerce
                     (mapcar
                      (lambda (it)
                        (destructuring-bind (label kind detail docu) it
                          (let ((obj (make-jobj "label" label "kind" kind)))
                            ;; Leere Felder weglassen: VS Code zeigt sonst
                            ;; eine leere Detailzeile neben jedem Eintrag.
                            (when (and detail (string/= detail ""))
                              (setf (gethash "detail" obj) detail))
                            (when (and docu (string/= docu ""))
                              (setf (gethash "documentation" obj) docu))
                            obj)))
                      items)
                     'vector))))
               (send-response id
                 (make-jobj "isIncomplete" :false "items" (vector)))))))))

(defun package-at-position (text line character)
  "Findet das für die Position gültige Paket: die letzte
   (in-package ...)-Form im Text VOR der Position. Kennt die üblichen
   Schreibweisen :foo, #:foo, \"FOO\", foo. Fallback COMMON-LISP-USER."
  (let ((offset 0) (current-line 0))
    ;; Zeichen-Offset der Position bestimmen
    (loop for i from 0 below (length text)
          while (< current-line line)
          do (when (char= (char text i) #\Newline) (incf current-line))
             (incf offset))
    (incf offset character)
    (setf offset (min offset (length text)))
    (let ((pkg "COMMON-LISP-USER")
          (search-region (subseq text 0 offset))
          (start 0))
      (loop
        (let ((idx (search "(in-package" search-region :start2 start
                            :test #'char-equal)))
          (unless idx (return))
          ;; Namen hinter "(in-package" extrahieren
          (let* ((rest-start (+ idx (length "(in-package")))
                 (end (position #\) search-region :start rest-start)))
            (when end
              (let ((name (string-trim '(#\Space #\Tab #\Newline #\Return #\: #\# #\")
                                        (subseq search-region rest-start end))))
                (when (> (length name) 0)
                  (setf pkg (string-upcase name)))))
            (setf start (1+ idx)))))
      pkg)))

(defun handle-definition (id params)
  "textDocument/definition — das M-. Erlebnis: springt zur Definition
   jedes Symbols, auch in SBCLs eigene Quellen. Die eigentliche Suche
   inkl. Logical-Pathname-Übersetzung läuft im CLAMPS-Image
   (find-definitions-for-repl), hier wird nur noch auf LSP gemappt."
  (let* ((sym (position-symbol params))
         (doc (gethash "textDocument" params))
         (pos (gethash "position" params))
         (text (and doc (gethash (gethash "uri" doc) *documents*)))
         (pkg (if text
                  (package-at-position text
                                       (gethash "line" pos)
                                       (gethash "character" pos))
                  "COMMON-LISP-USER")))
    (if (null sym)
        (send-response id (vector))
        (swank-rex
         (format nil "(clamps-bridge-rpc:find-definitions-for-repl ~S ~S)" sym pkg)
         :callback
         (lambda (status value)
           (if (and (eq status :ok) (consp value) (eq (first value) :ok))
               (let ((locations '()))
                 (dolist (entry (second value))
                   (destructuring-bind (file line col label) entry
                     (declare (ignore label))
                     ;; Einträge ohne auffindbare Datei (SBCL ohne
                     ;; installierte Quellen) überspringen — LSP kann
                     ;; nur echte Orte anspringen.
                     (when file
                       (push (make-jobj
                              "uri" (format nil "file://~A" file)
                              "range" (make-jobj
                                       "start" (make-jobj "line" line "character" col)
                                       "end" (make-jobj "line" line "character" col)))
                             locations))))
                 (send-response id (coerce (nreverse locations) 'vector)))
               (progn
                 (log-msg "definition: nichts gefunden für ~S in ~S" sym pkg)
                 (send-response id (vector)))))))))

(defun lisp-escape-string (s)
  "Escaped einen String für das Einbetten in eine Lisp-Form via ~S.
   Prin1 macht das korrekt inkl. Quotes und Backslashes."
  (prin1-to-string s))

(defun handle-eval (id params)
  "clamps/eval — wertet Code in der laufenden CLAMPS-Session aus.
   Client schickt {code, package}, erwartet {output, package}."
  (let* ((code (gethash "code" params))
         (pkg (or (gethash "package" params) *swank-package*)))
    (if (or (null code) (string= (string-trim '(#\Space #\Tab #\Newline #\Return) code) ""))
        (send-response id (make-jobj "output" "" "package" pkg))
        ;; eval-for-repl gibt (STATUS OUTPUT PACKAGE) zurück. Wir bauen
        ;; die Form als String, code und pkg werden via ~S sauber
        ;; escaped (prin1-Repräsentation), damit Anführungszeichen,
        ;; Backslashes und Zeilenumbrüche im Code nicht die Form zerlegen.
        (swank-rex
         (format nil "(clamps-bridge-rpc:eval-for-repl ~S ~S)" code pkg)
         :callback
         (lambda (status value)
           (if (and (eq status :ok) (consp value))
               (let* ((eval-status (first value))
                      (output (or (second value) ""))
                      (result-pkg (or (third value) pkg)))
                 (declare (ignore eval-status))
                 ;; Wichtig: das TS-Terminal rendert output einfach als
                 ;; Text, Fehler und Werte kommen beide über denselben
                 ;; Kanal. Der eval-status (:ok/:error) ist im String
                 ;; bereits enthalten (Fehlertext), daher hier egal.
                 (when result-pkg (setf *swank-package* result-pkg))
                 (send-response id (make-jobj "output" output "package" result-pkg)))
               ;; Swank selbst hat den Aufruf abgebrochen (z.B. Funktion
               ;; nicht gefunden, Reader-Fehler in der RPC-Form).
               (send-response id
                 (make-jobj "output"
                            (format nil "Bridge-Eval fehlgeschlagen: ~A" value)
                            "package" pkg))))))))

(defun handle-macroexpand (id params)
  "clamps/macroexpand — expandiert die Form im Code-String.
   Client schickt {code, package, full}, erwartet {output, package}."
  (let* ((code (gethash "code" params))
         (pkg (or (gethash "package" params) *swank-package*))
         (full (gethash "full" params)))
    (if (or (null code) (string= (string-trim '(#\Space #\Tab #\Newline #\Return) code) ""))
        (send-response id (make-jobj "output" "" "package" pkg))
        ;; full ist :true/:false (aus json-read) oder nil. Für die Lisp-
        ;; Seite in t/nil übersetzen: nur :true zählt als voll.
        (swank-rex
         (format nil "(clamps-bridge-rpc:macroexpand-for-repl ~S ~S ~A)"
                 code pkg (if (eq full :true) "t" "nil"))
         :callback
         (lambda (status value)
           (if (and (eq status :ok) (consp value))
               (let ((output (or (second value) ""))
                     (result-pkg (or (third value) pkg)))
                 (send-response id (make-jobj "output" output "package" result-pkg)))
               (send-response id
                 (make-jobj "output"
                            (format nil "Bridge-Macroexpand fehlgeschlagen: ~A" value)
                            "package" pkg))))))))

(defun handle-disassemble (id params)
  "clamps/disassemble — disassembliert die Funktion am Symbol.
   Client schickt {symbol, package}, erwartet {output, package}."
  (let* ((symbol (gethash "symbol" params))
         (pkg (or (gethash "package" params) *swank-package*)))
    (if (or (null symbol) (string= (string-trim '(#\Space #\Tab #\Newline #\Return) symbol) ""))
        (send-response id (make-jobj "output" "" "package" pkg))
        (swank-rex
         (format nil "(clamps-bridge-rpc:disassemble-for-repl ~S ~S)" symbol pkg)
         :callback
         (lambda (status value)
           (if (and (eq status :ok) (consp value))
               (let ((output (or (second value) ""))
                     (result-pkg (or (third value) pkg)))
                 (send-response id (make-jobj "output" output "package" result-pkg)))
               (send-response id
                 (make-jobj "output"
                            (format nil "Bridge-Disassemble fehlgeschlagen: ~A" value)
                            "package" pkg))))))))

(defun send-inspect-result (id value fallback-pkg)
  "Gemeinsame Antwortformung für alle drei Inspect-Methoden.
   Erwartet (:ok obj-id type print parts kind meta) oder (:error msg ...)."
  (if (and (consp value) (eq (first value) :ok))
      (destructuring-bind (ok obj-id type print parts kind meta) value
        (declare (ignore ok))
        (send-response id
          (make-jobj
           "id" obj-id
           "kind" (or kind "atom")
           "type" (or type "")
           "print" (or print "")
           "meta" (coerce (mapcar (lambda (m)
                                    (make-jobj "key" (first m)
                                               "value" (second m)))
                                  meta)
                          'vector)
           ;; parts: (label index preview navigierbar-p schreibbar-p)
           "parts" (coerce (mapcar (lambda (p)
                                     (make-jobj "label" (first p)
                                                "index" (second p)
                                                "preview" (or (third p) "")
                                                "navigable"
                                                (if (fourth p) :true :false)
                                                "settable"
                                                (if (fifth p) :true :false)))
                                   parts)
                           'vector)
           "package" fallback-pkg)))
      (let ((errmsg (if (and (consp value) (stringp (second value)))
                        (second value)
                        (format nil "~A" value))))
        (send-response id
          (make-jobj "id" 0 "kind" "error" "type" "error" "print" errmsg
                     "meta" (vector) "parts" (vector)
                     "package" fallback-pkg)))))

(defun handle-inspect (id params)
  "clamps/inspect — wertet einen Ausdruck aus und inspiziert das Ergebnis.
   Client schickt {expr, package}, bekommt eine Objekt-ID zurück, über
   die weiter navigiert wird."
  (let* ((expr (gethash "expr" params))
         (pkg (or (gethash "package" params) *swank-package*)))
    (if (or (null expr)
            (string= (string-trim '(#\Space #\Tab #\Newline #\Return) expr) ""))
        (send-response id (make-jobj "id" 0 "kind" "atom" "type" "" "print" ""
                                     "meta" (vector) "parts" (vector)
                                     "package" pkg))
        (swank-rex
         (format nil "(clamps-bridge-rpc:inspect-for-repl ~S ~S)" expr pkg)
         :callback
         (lambda (status value)
           (send-inspect-result id (if (eq status :ok) value nil) pkg))))))

(defun handle-inspect-part (id params)
  "clamps/inspectPart — navigiert von einem Objekt zu dessen n-tem Teil.
   Ersetzt die frühere Navigation über re-evaluierbare Ausdrücke."
  (let ((obj-id (gethash "id" params))
        (index (gethash "index" params))
        (pkg *swank-package*))
    (swank-rex
     (format nil "(clamps-bridge-rpc:inspect-part-for-repl ~D ~D)"
             (or obj-id 0) (or index 0))
     :callback
     (lambda (status value)
       (send-inspect-result id (if (eq status :ok) value nil) pkg)))))

(defun handle-inspect-refresh (id params)
  "clamps/inspectRefresh — beschreibt dasselbe Objekt neu. Nötig, weil
   sich Objekte bei laufendem DSP unter der Anzeige verändern."
  (let ((obj-id (gethash "id" params))
        (pkg *swank-package*))
    (swank-rex
     (format nil "(clamps-bridge-rpc:inspect-id-for-repl ~D)" (or obj-id 0))
     :callback
     (lambda (status value)
       (send-inspect-result id (if (eq status :ok) value nil) pkg)))))

(defun handle-inspect-release (id params)
  "clamps/inspectRelease — gibt die Objekt-Tabelle frei. Der Client ruft
   das beim Schließen des Panels; ohne das hielten wir Objekte am GC
   vorbei fest, was bei Audio-Buffern teuer wird."
  (declare (ignore params))
  (swank-rex
   "(clamps-bridge-rpc:inspect-release-for-repl)"
   :callback
   (lambda (status value)
     (declare (ignore status value))
     (send-response id (make-jobj "ok" :true)))))

(defun handle-inspect-set (id params)
  "clamps/inspectSet — setzt einen Teil des Objekts auf einen neuen Wert.
   Client schickt {id, index, value, package}."
  (let ((obj-id (gethash "id" params))
        (index (gethash "index" params))
        (value (gethash "value" params))
        (pkg (or (gethash "package" params) *swank-package*)))
    (if (or (null value) (string= value ""))
        (send-response id (make-jobj "id" (or obj-id 0) "kind" "error"
                                     "type" "error"
                                     "print" "Leere Eingabe"
                                     "meta" (vector) "parts" (vector)
                                     "package" pkg))
        (swank-rex
         (format nil "(clamps-bridge-rpc:inspect-set-part-for-repl ~D ~D ~S ~S)"
                 (or obj-id 0) (or index 0) value pkg)
         :callback
         (lambda (status value2)
           (send-inspect-result id (if (eq status :ok) value2 nil) pkg))))))



(defun handle-incudine-nodes (id params)
  "clamps/incudineNodes — read-only Snapshot des laufenden Node-Baums."
  (declare (ignore params))
  (swank-rex
   "(clamps-bridge-rpc:incudine-node-tree-for-repl)"
   :callback
   (lambda (status value)
     (if (and (eq status :ok) (consp value))
         (let* ((state (first value))
                (message (or (second value) ""))
                (nodes (or (third value) nil))
                (available (eq state :ok)))
           (send-response id
             (make-jobj
              "available" (if available :true :false)
              "error" message
              "nodes"
              (coerce
               (mapcar
                (lambda (node)
                  (let ((controls (or (getf node :controls) nil)))
                    (make-jobj
                     "id" (or (getf node :id) -1)
                     "parent" (or (getf node :parent) :null)
                     "name" (or (getf node :name) "")
                     "kind" (if (eq (getf node :kind) :group) "group" "dsp")
                     "paused" (if (getf node :paused) :true :false)
                     "done" (if (getf node :done) :true :false)
                     "uptime" (or (getf node :uptime) "")
                     "controls"
                     (coerce
                      (mapcar (lambda (control)
                                (make-jobj "name" (or (getf control :name) "")
                                           "value" (or (getf control :value) "")))
                              controls)
                      'vector))))
                nodes)
               'vector))))
         (send-response id
           (make-jobj "available" :false
                      "error" (format nil "Node-Snapshot fehlgeschlagen: ~A" value)
                      "nodes" (vector)))))))

(defun handle-rt-status (id params)
  "clamps/rtStatus — Zustand des Incudine-Realtime-Servers.
   Erwartet keine Parameter, liefert {running, info: [{key,value}]}.
   Wird von der Statusleiste gepollt, muss also billig und robust sein:
   im Fehlerfall lieber running=false melden als die Bridge blockieren."
  (declare (ignore params))
  (swank-rex
   "(clamps-bridge-rpc:rt-status-for-repl)"
   :callback
   (lambda (status value)
     (if (and (eq status :ok) (consp value) (eq (first value) :ok))
         (destructuring-bind (ok running info) value
           (declare (ignore ok))
           (send-response id
             (make-jobj
              "running" (if running :true :false)
              "info" (coerce
                      (mapcar (lambda (p)
                                (make-jobj "key" (car p) "value" (cdr p)))
                              info)
                      'vector))))
         (send-response id
           (make-jobj "running" :false
                      "info" (vector
                              (make-jobj "key" "fehler"
                                         "value" (format nil "~A" value)))))))))

(defun handle-trace-toggle (id params)
  "clamps/toggleTrace — Trace für Funktion an/aus.
   Client schickt {symbol, package}, erwartet {output, traced}."
  (let* ((symbol (gethash "symbol" params))
         (pkg (or (gethash "package" params) *swank-package*)))
    (if (null symbol)
        (send-response id (make-jobj "output" "Kein Symbol." "traced" :false))
        (swank-rex
         (format nil "(clamps-bridge-rpc:trace-toggle-for-repl ~S ~S)" symbol pkg)
         :callback
         (lambda (status value)
           (if (and (eq status :ok) (consp value))
               (destructuring-bind (st text traced) value
                 (declare (ignore st))
                 (send-response id (make-jobj "output" (or text "")
                                             "traced" (if traced :true :false))))
               (send-response id (make-jobj
                                  "output" (format nil "Trace fehlgeschlagen: ~A" value)
                                  "traced" :false))))))))

(defun handle-untrace-all (id params)
  "clamps/untraceAll — alle Traces aus."
  (declare (ignore params))
  (swank-rex
   "(clamps-bridge-rpc:untrace-all-for-repl)"
   :callback
   (lambda (status value)
     (if (and (eq status :ok) (consp value))
         (send-response id (make-jobj "output" (or (second value) "")))
         (send-response id (make-jobj
                            "output" (format nil "Untrace fehlgeschlagen: ~A" value)))))))



(defun browser-entry-json (entry)
  (make-jobj "label" (or (getf entry :label) "")
             "description" (or (getf entry :description) "")
             "tooltip" (or (getf entry :tooltip) "")
             "icon" (or (getf entry :icon) "symbol-misc")
             "inspect" (or (getf entry :inspect) "")
             "children" (coerce (mapcar #'browser-entry-json (or (getf entry :children) nil)) 'vector)))

(defun handle-image-browser (id form)
  (swank-rex form :callback
    (lambda (status value)
      (if (and (eq status :ok) (consp value))
          (let ((ok (eq (first value) :ok))
                (payload (second value)))
            (send-response id
              (make-jobj "available" (if ok :true :false)
                         "error" (if ok "" (or payload "Nicht verfügbar."))
                         "entries" (if ok
                                       (coerce (mapcar #'browser-entry-json (or payload nil)) 'vector)
                                       (vector)))))
          (send-response id (make-jobj "available" :false "error" (format nil "~A" value) "entries" (vector)))))))

(defun handle-packages (id params) (declare (ignore params))
  (handle-image-browser id "(clamps-bridge-rpc:packages-for-repl)"))
(defun handle-classes (id params) (declare (ignore params))
  (handle-image-browser id "(clamps-bridge-rpc:classes-for-repl)"))
(defun handle-threads-browser (id params) (declare (ignore params))
  (handle-image-browser id "(clamps-bridge-rpc:threads-for-repl)"))

(defun plist-value (plist key &optional default)
  (let ((tail (member key plist :test #'eq))) (if tail (second tail) default)))

(defun location-line-character (location)
  "Best effort für Swank-Locations. Unbekannte Formen bleiben bei 0:0."
  (let ((line 0) (character 0))
    (labels ((walk (x)
               (when (consp x)
                 (cond
                   ((eq (car x) :line)
                    (let ((v (cdr x)))
                      (when (numberp (first v)) (setf line (max 0 (1- (first v)))))
                      (when (numberp (second v)) (setf character (max 0 (second v))))))
                   ((eq (car x) :position)
                    ;; Positionsangaben sind Zeichenoffsets; ohne Textbezug
                    ;; ist 0:0 ehrlicher als eine falsche Zeile.
                    nil))
                 (dolist (e x) (walk e)))))
      (walk location))
    (values line character)))

(defun handle-compiler-notes (id params)
  (let* ((text (or (gethash "text" params) ""))
         (file (or (gethash "file" params) "buffer.lisp"))
         (uri (or (gethash "uri" params) file))
         (pkg "COMMON-LISP-USER")
         (form (format nil
                       "(let ((*package* (or (find-package :common-lisp-user) *package*))) (swank:compile-string-for-emacs ~S ~S '((:position 0) (:line 1 0)) ~S nil))"
                       text uri file)))
    (swank-rex form :package pkg :callback
      (lambda (status value)
        (if (and (eq status :ok) (consp value))
            (let* ((notes (or (plist-value value :notes) nil))
                   (success (plist-value value :successp))
                   (duration (or (plist-value value :duration) 0.0)))
              (send-response id
                (make-jobj "success" (if success :true :false)
                           "duration" duration
                           "notes"
                           (coerce
                            (mapcar
                             (lambda (note)
                               (multiple-value-bind (line character)
                                   (location-line-character (plist-value note :location))
                                 (make-jobj "message" (or (plist-value note :message) "Compiler-Hinweis")
                                            "severity" (string-downcase (string (or (plist-value note :severity) :note)))
                                            "line" line "character" character)))
                             notes)
                            'vector))))
            (send-response id
              (make-jobj "success" :false "duration" 0 "notes" (vector)
                         "error" (format nil "~A" value))))))))

(defun handle-request (msg)
  (let ((method (gethash "method" msg))
        (id (gethash "id" msg))
        (params (gethash "params" msg)))
    (handler-case
        (cond
          ((string= method "initialize") (handle-initialize id))
          ((string= method "shutdown") (send-response id :null))
          ((string= method "exit") (finish-output) (sb-ext:exit :code 0))
          ((string= method "textDocument/didOpen") (handle-did-open params))
          ((string= method "textDocument/didChange") (handle-did-change params))
          ((string= method "textDocument/hover") (handle-hover id params))
          ((string= method "textDocument/completion") (handle-completion id params))
          ((string= method "textDocument/definition") (handle-definition id params))
          ((string= method "clamps/eval") (handle-eval id params))
          ((string= method "clamps/macroexpand") (handle-macroexpand id params))
          ((string= method "clamps/disassemble") (handle-disassemble id params))
          ((string= method "clamps/inspect") (handle-inspect id params))
          ((string= method "clamps/inspectPart") (handle-inspect-part id params))
          ((string= method "clamps/inspectRefresh") (handle-inspect-refresh id params))
          ((string= method "clamps/inspectSet") (handle-inspect-set id params))
          ((string= method "clamps/inspectRelease") (handle-inspect-release id params))
          ((string= method "clamps/rtStatus") (handle-rt-status id params))
          ((string= method "clamps/incudineNodes") (handle-incudine-nodes id params))
          ((string= method "clamps/packages") (handle-packages id params))
          ((string= method "clamps/classes") (handle-classes id params))
          ((string= method "clamps/threads") (handle-threads-browser id params))
          ((string= method "clamps/compilerNotes") (handle-compiler-notes id params))
          ((string= method "clamps/toggleTrace") (handle-trace-toggle id params))
          ((string= method "clamps/untraceAll") (handle-untrace-all id params))
          (id (send-error id -32601 (format nil "Nicht implementiert: ~A" method)))
          (t (log-msg "Unbehandelte Notification: ~A" method)))
      (error (e)
        (log-msg "Fehler beim Behandeln von ~A: ~A" method e)
        (when id (send-error id -32603 (format nil "Interner Fehler: ~A" e)))))))

;;; ---------------------------------------------------------------------
;;; Session-Datei lesen/abwarten (geschrieben von bootstrap.lisp)
;;; ---------------------------------------------------------------------

(defun read-stream-to-string (stream)
  (with-output-to-string (out)
    (loop for line = (read-line stream nil nil) while line do (write-line line out))))

(defun wait-for-ready (session-file &optional (timeout-seconds 60))
  (let ((start (get-universal-time)))
    (loop
      (let ((info (ignore-errors
                    (with-open-file (s session-file :direction :input)
                      (json-read (read-stream-to-string s))))))
        (when (and info (equal (gethash "status" info) "ready"))
          (return-from wait-for-ready info))
        (when (and info (equal (gethash "status" info) "error"))
          (error "CLAMPS-Bootstrap meldet Fehler: ~A" (gethash "detail" info))))
      (when (> (- (get-universal-time) start) timeout-seconds)
        (error "Timeout: Session in ~A nicht bereit nach ~As" session-file timeout-seconds))
      (sleep 0.3))))

;;; ---------------------------------------------------------------------
;;; Einstiegspunkt
;;; ---------------------------------------------------------------------

(defun main ()
  ;; stdout explizit als UTF-8-Stream neu anlegen, damit die tatsächlich
  ;; geschriebenen Bytes exakt zur in write-lsp-message berechneten
  ;; Byte-Content-Length passen. Sonst richtet sich die Kodierung nach
  ;; der Locale und kann abweichen -> abgeschnittene Nachrichten, JSON-
  ;; Parse-Fehler beim Client.
  (setf sb-impl::*default-external-format* :utf-8)
  (ignore-errors
    (setf *standard-output*
          (sb-sys:make-fd-stream 1 :output t :external-format :utf-8
                                   :buffering :full)))
  (let* ((session-dir-str (or (sb-ext:posix-getenv "CLAMPS_SESSION_DIR")
                               (error "CLAMPS_SESSION_DIR nicht gesetzt")))
         ;; Trailing slash erzwingen, sonst behandelt merge-pathnames
         ;; den letzten Pfadteil als Dateinamen statt als Verzeichnis.
         (session-dir (pathname (concatenate 'string session-dir-str "/")))
         (session-file (merge-pathnames "session.json" session-dir)))
    (init-logging session-dir)
    (log-msg "Bridge-Server startet, warte auf ~A" session-file)
    (let* ((info (wait-for-ready session-file))
           (port (gethash "port" info)))
      (log-msg "Session bereit, verbinde zu Swank auf Port ~A" port)
      (setf *swank-stream* (connect-swank "127.0.0.1" port))
      (bt:make-thread #'swank-reader-loop :name "swank-reader")
      (log-msg "Verbunden. Starte LSP-Loop auf stdio.")
      (loop
        (let ((msg (read-lsp-message *standard-input*)))
          (unless msg (return))
          (handle-request msg))))))

(handler-case (main)
  (error (e)
    (log-msg "Fataler Fehler: ~A" e)
    (sb-ext:exit :code 1)))
