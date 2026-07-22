;;;; bootstrap.lisp
;;;;
;;;; Startet ein SBCL-Image mit CLAMPS + Swank-Server für die
;;;; VS-Code-Extension. Wird per `sbcl --script bootstrap.lisp` gestartet
;;;; und läuft unabhängig vom Editor-Prozess weiter (detached).
;;;;
;;;; Kommunikation mit der Extension läuft NICHT über stdout/stdin,
;;;; sondern über eine Session-Datei, damit die Extension jederzeit
;;;; (auch nach eigenem Neustart) prüfen kann, ob ein CLAMPS-Prozess
;;;; bereits läuft und auf welchem Port er lauscht.

(require :asdf)
(require :sb-posix)

;;; ---------------------------------------------------------------------
;;; Session-Verzeichnis + Status-Datei
;;;
;;; Sicherheitshinweis: Swank hat kein eingebautes Auth-Verfahren.
;;; Die praktische Grenze ist deshalb (a) Bindung ausschließlich an
;;; 127.0.0.1 (siehe unten) und (b) Dateisystem-Rechte auf Verzeichnis
;;; und Session-Datei, damit auf Mehrbenutzer-Maschinen (z. B. geteilte
;;; Remote-Dev-Boxen) nicht jeder lokale User den Port auslesen und sich
;;; verbinden kann. Ein Secret-Handshake auf Swank-Protokollebene wäre
;;; brüchig (Swank kennt sowas nicht) – wer echte Mehrbenutzer-Isolation
;;; braucht, sollte stattdessen den Port nur per SSH-Tunnel/Port-Forward
;;; erreichbar machen, nie direkt exponieren.
;;; ---------------------------------------------------------------------

(defparameter *session-dir*
  (let ((env (sb-ext:posix-getenv "CLAMPS_SESSION_DIR")))
    (if env
        (pathname (concatenate 'string env "/"))
        (merge-pathnames ".clamps-vscode/" (user-homedir-pathname)))))

(ensure-directories-exist *session-dir*)

(defparameter *session-file* (merge-pathnames "session.json" *session-dir*))
(defparameter *log-file*     (merge-pathnames "bootstrap.log" *session-dir*))

(defun secure-permissions ()
  "Setzt Session-Verzeichnis auf 0700 und vorhandene Dateien darin auf
   0600, damit nur der eigene User lesen kann. Fehler hier sind nicht
   fatal (z. B. auf Dateisystemen ohne Unix-Rechte), werden aber geloggt."
  (handler-case
      (progn
        (sb-posix:chmod (namestring *session-dir*) #o700)
        (dolist (f (list *session-file* *log-file*))
          (when (probe-file f)
            (sb-posix:chmod (namestring f) #o600))))
    (error (e)
      (log-msg "WARNUNG: Konnte Dateirechte nicht setzen: ~A" e))))

(defun log-msg (fmt &rest args)
  (with-open-file (s *log-file*
                      :direction :output
                      :if-exists :append
                      :if-does-not-exist :create)
    (format s "~&[~A] " (get-universal-time))
    (apply #'format s fmt args)
    (terpri s)))

(defun write-session-file (&key port pid status detail)
  "Schreibt den aktuellen Zustand als JSON. Die Extension pollt/watched
   diese Datei statt stdout zu parsen."
  (with-open-file (s *session-file*
                      :direction :output
                      :if-exists :supersede
                      :if-does-not-exist :create)
    (format s "{~%")
    (format s "  \"port\": ~A,~%" (or port "null"))
    (format s "  \"pid\": ~A,~%" (or pid "null"))
    (format s "  \"status\": \"~A\",~%" status)
    (format s "  \"detail\": ~S~%" (or detail ""))
    (format s "}~%")))

(defparameter *pid* (sb-unix:unix-getpid))

(write-session-file :pid *pid* :status "starting" :detail "SBCL bootet")
(secure-permissions)
(log-msg "Bootstrap gestartet, PID ~A, Session-Dir ~A" *pid* *session-dir*)

;;; ---------------------------------------------------------------------
;;; Quicklisp laden
;;; ---------------------------------------------------------------------

(let ((ql-init (merge-pathnames "quicklisp/setup.lisp" (user-homedir-pathname))))
  (if (probe-file ql-init)
      (load ql-init)
      (progn
        (write-session-file :pid *pid* :status "error"
                             :detail "Quicklisp nicht gefunden")
        (log-msg "FEHLER: Quicklisp nicht gefunden unter ~A" ql-init)
        (sb-ext:exit :code 1))))

;;; ---------------------------------------------------------------------
;;; Swank, usocket, CLAMPS laden
;;; ---------------------------------------------------------------------

(handler-case
    (progn
      (write-session-file :pid *pid* :status "starting" :detail "Lade Swank + Slynk + usocket")
      ;; CLAMPS ist für Sly (nicht SLIME) gebaut und referenziert beim
      ;; Laden Slynk-Symbole. Wir starten den RPC-Server trotzdem über
      ;; Swank (stabiler dokumentiertes Protokoll für die Bridge),
      ;; aber Slynk muss geladen sein, damit das SLYNK-Paket existiert.
      (ql:quickload '(:swank :slynk :usocket) :silent t)
      (write-session-file :pid *pid* :status "starting" :detail "Lade CLAMPS")
      ;; cudere-clm (Teil des Incudine-Umfelds) proklamiert DOUBLE-FLOAT
      ;; als Funktion in COMMON-LISP und verletzt damit die Paketsperre.
      ;; Interaktiv (Emacs/SLIME) ist das ein fortsetzbarer Fehler, den
      ;; man meist nie bewusst wegklickt. Im --script-Modus gibt es
      ;; keinen Debugger, der den Restart anbietet, daher explizit hier
      ;; ausschalten statt auf interaktives Continue zu hoffen.
      (sb-ext:without-package-locks
        (ql:quickload :clamps :silent t)))
  (error (e)
    (log-msg "FEHLER beim Laden: ~A" e)
    (write-session-file :pid *pid* :status "error"
                         :detail (format nil "Ladefehler: ~A" e))
    (sb-ext:exit :code 1)))

(log-msg "CLAMPS + Swank geladen")

;;; ---------------------------------------------------------------------
;;; Slynk-Shim: eval-in-emacs bei fehlender Emacs-Connection abfangen
;;;
;;; CLAMPS ruft an mehreren Stellen (z.B. rts-start, rts-stop) direkt
;;; slynk:eval-in-emacs auf, um Emacs-Modeline-Labels wie "DSP ✓" zu
;;; setzen. Das setzt eine aktive Sly-Session voraus (slynk gebundenes
;;; *emacs-connection*). Über unsere Bridge gibt es die nicht, daher
;;; crasht eval-in-emacs mit "nil fell through etypecase" (es erwartet
;;; eine slynk::connection, bekommt nil).
;;;
;;; CLAMPS' eigener Code prüft an den neueren Stellen bereits
;;; slynk-api:*emacs-connection* (siehe init.lisp), aber rts-start und
;;; einige andere tun das nicht. Statt CLAMPS zu patchen, machen wir
;;; eval-in-emacs bei fehlender Connection zu einem stillen No-op — die
;;; Emacs-Kosmetik (Modeline-Labels) entfällt, was in VS Code ohnehin
;;; keinen Sinn ergibt; alles Übrige (rt-start, Webserver, ...) läuft.
;;;
;;; Wir überschreiben nur das Verhalten bei fehlender Connection und
;;; delegieren sonst an die Originalfunktion, damit bei einer echten
;;; Slynk-Session (falls je vorhanden) nichts kaputtgeht.
;;; ---------------------------------------------------------------------

(handler-case
    (when (find-package :slynk)
      (let* ((eval-sym (find-symbol "EVAL-IN-EMACS" :slynk))
             (conn-sym (or (find-symbol "*EMACS-CONNECTION*" :slynk-api)
                           (find-symbol "*EMACS-CONNECTION*" :slynk))))
        (if (and eval-sym conn-sym (fboundp eval-sym))
            (let ((original (fdefinition eval-sym)))
              (setf (fdefinition eval-sym)
                    (lambda (&rest args)
                      ;; Nur ausführen, wenn tatsächlich eine
                      ;; Emacs-Connection aktiv ist; sonst still ignorieren.
                      (if (and (boundp conn-sym) (symbol-value conn-sym))
                          (apply original args)
                          nil)))
              (log-msg "Slynk eval-in-emacs Shim installiert (No-op ohne Connection)"))
            (log-msg "Slynk-Shim übersprungen: Symbole nicht gefunden (eval=~A conn=~A)"
                     eval-sym conn-sym))))
  (error (e)
    (log-msg "WARNUNG: Slynk-Shim fehlgeschlagen: ~A" e)))

;;; ---------------------------------------------------------------------
;;; Eval-Kanal für die VS-Code-REPL
;;;
;;; Die Bridge ruft CLAMPS-BRIDGE-EVAL per Swank-RPC auf. Bewusst NICHT
;;; swank:listener-eval verwendet: das druckt REPL-Nebeneffekte auf einen
;;; an Emacs gebundenen Stream und ist von außen schwer sauber
;;; abzugreifen. Stattdessen fangen wir stdout/stderr in einen String,
;;; werten mehrere aufeinanderfolgende Forms aus (wie eine echte REPL-
;;; Eingabe mit mehreren Ausdrücken) und geben Werte + Ausgabe als EINEN
;;; String zurück. Die Funktion lebt im COMMON-LISP-USER-Paket, ist aber
;;; über ihren vollen Namen aufrufbar.
;;;
;;; Rückgabe: eine Liste (:ok "<ausgabe+werte>" "<paketname>") bzw.
;;; (:error "<fehlertext>" "<paketname>"). Die Bridge übersetzt das in
;;; das JSON {output, package}, das der TypeScript-Client erwartet.
;;; ---------------------------------------------------------------------

(defpackage :clamps-bridge-rpc
  (:use :cl)
  (:export #:eval-for-repl #:macroexpand-for-repl #:disassemble-for-repl
           #:find-definitions-for-repl #:inspect-for-repl
           #:trace-toggle-for-repl #:untrace-all-for-repl))
(in-package :clamps-bridge-rpc)

(defun %inspect-parts (obj)
  "Liefert die navigierbaren Teile von OBJ als Liste von
   (label . accessor-form-string). accessor-form-string ist ein
   Lisp-Ausdruck mit __OBJ__ als Platzhalter für das inspizierte Objekt;
   der Client/die Bridge ersetzt __OBJ__ durch den tatsächlichen
   Zugriffs-Ausdruck, um tiefer zu navigieren."
  (typecase obj
    (standard-object
     (let ((class (class-of obj)))
       (loop for slot in (%class-slot-names class)
             collect (cons (string-downcase (symbol-name slot))
                           (format nil "(slot-value __OBJ__ '~A)"
                                   (%package-qualified slot))))))
    (structure-object
     (loop for slot in (%struct-slot-names obj)
           collect (cons (string-downcase (symbol-name slot))
                         (format nil "(slot-value __OBJ__ '~A)"
                                 (%package-qualified slot)))))
    (cons
     ;; Liste: erste ~50 Elemente + Rest
     (let ((parts '()) (i 0))
       (dolist (el obj)
         (declare (ignore el))
         (when (>= i 50) (return))
         (push (cons (format nil "[~A]" i)
                     (format nil "(nth ~A __OBJ__)" i))
               parts)
         (incf i))
       (nreverse parts)))
    ((and vector (not string))
     (loop for i from 0 below (min 50 (length obj))
           collect (cons (format nil "[~A]" i)
                         (format nil "(aref __OBJ__ ~A)" i))))
    (hash-table
     (let ((parts '()) (i 0))
       (maphash (lambda (k v)
                  (declare (ignore v))
                  (when (< i 50)
                    (push (cons (format nil "~S" k)
                                (format nil "(gethash '~S __OBJ__)" k))
                          parts)
                    (incf i)))
                obj)
       (nreverse parts)))
    (t nil)))

(defun %class-slot-names (class)
  (handler-case
      (mapcar (lambda (s)
                (funcall (find-symbol "SLOT-DEFINITION-NAME" :sb-mop) s))
              (funcall (find-symbol "CLASS-SLOTS" :sb-mop) class))
    (error () nil)))

(defun %struct-slot-names (obj)
  (handler-case
      (mapcar (lambda (dsd)
                (funcall (find-symbol "DSD-NAME" :sb-kernel) dsd))
              (funcall (find-symbol "DD-SLOTS" :sb-kernel)
                       (funcall (find-symbol "LAYOUT-INFO" :sb-kernel)
                                (funcall (find-symbol "%INSTANCE-LAYOUT" :sb-kernel) obj))))
    (error () nil)))

(defun %package-qualified (sym)
  "Symbolname mit Paket, damit slot-value es im richtigen Paket findet."
  (let ((pkg (symbol-package sym)))
    (if pkg
        (format nil "~A::~A" (string-downcase (package-name pkg))
                (string-downcase (symbol-name sym)))
        (string-downcase (symbol-name sym)))))

(defun inspect-for-repl (expr-string package-name)
  "Wertet EXPR-STRING aus und beschreibt das Ergebnis-Objekt: Typ,
   Druckdarstellung und navigierbare Teile. Gibt zurück:
   (:ok type-string print-string ((label . accessor) ...) package)
   accessor enthält __OBJ__ als Platzhalter für EXPR-STRING."
  (let ((pkg (or (find-package (string-upcase package-name))
                 (find-package :common-lisp-user))))
    (handler-case
        (let* ((*package* pkg)
               (*read-eval* nil)
               (form (read-from-string expr-string))
               (obj (eval form))
               (type-str (let ((*print-case* :downcase))
                           (princ-to-string (type-of obj))))
               (print-str (let ((*print-length* 100)
                                (*print-level* 5)
                                (*print-circle* t))
                            (prin1-to-string obj)))
               (parts (%inspect-parts obj)))
          (list :ok type-str print-str
                (mapcar (lambda (p)
                          (list (car p)
                                ;; __OBJ__ durch den echten Ausdruck ersetzen
                                (%replace-obj (cdr p) expr-string)))
                        parts)
                (package-name pkg)))
      (error (e)
        (list :error (format nil "~A" e) "" nil (package-name pkg))))))

(defun %replace-obj (template expr-string)
  "Ersetzt jedes __OBJ__ im Template durch den geklammerten expr-string."
  (let ((wrapped (format nil "(progn ~A)" expr-string))
        (result (make-string-output-stream))
        (pos 0))
    (loop
      (let ((idx (search "__OBJ__" template :start2 pos)))
        (cond
          (idx
           (write-string (subseq template pos idx) result)
           (write-string wrapped result)
           (setf pos (+ idx 7)))
          (t
           (write-string (subseq template pos) result)
           (return)))))
    (get-output-stream-string result)))

(defun %offset->line-col (filepath offset)
  "Zählt Zeilen/Spalten bis OFFSET (0-indexiert für LSP). Läuft im
   Image, wo die Datei sicher lesbar ist."
  (handler-case
      (with-open-file (s filepath :direction :input
                                   :external-format :utf-8)
        (let ((line 0) (col 0) (count 0))
          (loop
            (let ((ch (read-char s nil nil)))
              (when (or (null ch) (>= count offset)) (return))
              (if (char= ch #\Newline)
                  (progn (incf line) (setf col 0))
                  (incf col))
              (incf count)))
          (list line col)))
    (error () (list 0 0))))

(defun %resolve-source-file (raw-file)
  "Übersetzt einen Datei-Eintrag aus einer Swank-Location in einen
   existierenden physischen Pfad. SBCL-interne Definitionen kommen als
   Logical Pathnames (SYS:SRC;CODE;LIST.LISP) — translate-logical-pathname
   macht daraus den echten Pfad der installierten SBCL-Quellen. Gibt
   NIL zurück, wenn die Datei nicht existiert (z.B. SBCL ohne Quellen
   installiert), damit der Client das ehrlich melden kann statt ins
   Leere zu springen."
  (handler-case
      (let* ((path (etypecase raw-file
                     (pathname raw-file)
                     (string (parse-namestring raw-file))))
             (physical (translate-logical-pathname path)))
        (when (probe-file physical)
          (namestring physical)))
    (error () nil)))

(defun resolve-symbol (symbol-string pkg)
  "Löst SYMBOL-STRING zu einem echten Symbol-Objekt auf. Behandelt
   qualifizierte Namen (incudine:rt-start, clamps::foo) direkt über den
   Reader; für nackte Namen (rt-start) wird zuerst im übergebenen Paket
   PKG gesucht, dann fällt es auf einen unqualifizierten Reader-Versuch
   zurück. Gibt NIL zurück, wenn nichts gefunden wird."
  (handler-case
      (let ((*package* pkg) (*read-eval* nil))
        (if (find #\: symbol-string)
            ;; Qualifizierter Name: Reader macht das korrekt.
            (let ((obj (read-from-string symbol-string)))
              (and (symbolp obj) obj))
            ;; Nackter Name: erst im Paket suchen (findet auch geerbte
            ;; und interne Symbole), dann bild-weit, dann Reader-Fallback.
            (let ((upcased (string-upcase symbol-string)))
              (multiple-value-bind (sym status) (find-symbol upcased pkg)
                (cond
                  (status sym)
                  ;; Nicht im aktuellen Paket sichtbar (z.B. rt-start ohne
                  ;; (in-package :incudine) in der Datei): über alle Pakete
                  ;; suchen. Bevorzugt ein Symbol, das tatsächlich fboundp
                  ;; oder boundp ist, damit wir nicht ein zufälliges
                  ;; gleichnamiges Keyword o.ä. erwischen.
                  (t (let ((candidates '()))
                       (dolist (p (list-all-packages))
                         (multiple-value-bind (s st) (find-symbol upcased p)
                           (when (and st (eq (symbol-package s) p))
                             (pushnew s candidates))))
                       (or (find-if (lambda (s) (or (fboundp s) (boundp s)
                                                    (find-class s nil)))
                                    candidates)
                           (first candidates)
                           (and (not (find #\: symbol-string))
                                (ignore-errors
                                  (let ((obj (read-from-string symbol-string)))
                                    (and (symbolp obj) obj))))))))))))
    (error () nil)))

(defun trace-toggle-for-repl (symbol-string package-name)
  "Schaltet Trace für die Funktion am Symbol an/aus (SLIME
   C-c C-t Verhalten). (trace) ohne Argumente liefert die Liste der
   aktuell getracten Funktionsnamen — darüber wird der Zustand geprüft.
   trace/untrace sind Makros, daher der Umweg über eval mit
   eingesetztem Symbol. Gibt (:ok STATUS-TEXT TRACED-P) zurück."
  (let ((pkg (or (find-package (string-upcase package-name))
                 (find-package :common-lisp-user))))
    (handler-case
        (let* ((*package* pkg)
               (sym (resolve-symbol symbol-string pkg)))
          (cond
            ((null sym)
             (list :error (format nil "Symbol ~A nicht gefunden." symbol-string) nil))
            ((not (fboundp sym))
             (list :error (format nil "~A ist keine Funktion." sym) nil))
            (t
             (let ((traced (member sym (eval '(trace)) :test #'eq)))
               (if traced
                   (progn
                     (eval `(untrace ,sym))
                     (list :ok (format nil "Trace AUS: ~A" sym) nil))
                   (progn
                     (eval `(trace ,sym))
                     (list :ok (format nil "Trace AN: ~A - Aufrufe erscheinen in der REPL" sym) t)))))))
      (error (e)
        (list :error (format nil "~A" e) nil)))))

(defun untrace-all-for-repl ()
  "Schaltet alle Traces aus. Gibt (:ok TEXT) zurück."
  (handler-case
      (let ((traced (eval '(trace))))
        (eval '(untrace))
        (list :ok (if traced
                      (format nil "Alle Traces aus (~A Funktion~:P)." (length traced))
                      "Es war nichts getraced.")))
    (error (e) (list :error (format nil "~A" e)))))

(defun find-definitions-for-repl (symbol-string package-name)
  "Findet alle Definitionsorte des Symbols — auch für eingebaute
   SBCL-Funktionen, Variablen, Makros, Klassen (das M-. Erlebnis).
   Gibt (:ok ((file line col label) ...)) zurück; Einträge, deren
   Quelldatei nicht auffindbar ist, kommen mit file=NIL und dem Label,
   damit der Client sie anzeigen kann (z.B. 'Quelle nicht installiert')."
  (let ((pkg (or (find-package (string-upcase package-name))
                 (find-package :common-lisp-user))))
    (handler-case
        (let* ((*package* pkg)
               ;; Symbol zu einem echten Symbol-Objekt auflösen, dann
               ;; Swank mit dem VOLLQUALIFIZIERTEN Namen füttern. Grund:
               ;; find-definitions-for-emacs findet "rt-start" NICHT,
               ;; wenn man nur das Paket INCUDINE mitgibt, aber
               ;; "incudine:rt-start" schon. Wir bestimmen also das
               ;; Home-Paket des Symbols und bauen den qualifizierten
               ;; Namen selbst.
               (sym (resolve-symbol symbol-string pkg))
               (query-name (if sym
                               (let ((*package* (find-package :keyword)))
                                 ;; prin1 mit keyword-package erzwingt volle
                                 ;; Paket-Qualifizierung im ausgegebenen Namen.
                                 (let ((*print-case* :downcase)
                                       (*print-readably* nil))
                                   (prin1-to-string sym)))
                               symbol-string))
               (defs (funcall (find-symbol "FIND-DEFINITIONS-FOR-EMACS" :swank)
                              query-name))
               (results '()))
          (dolist (def defs)
            (let* ((label (let ((*print-case* :downcase))
                            (princ-to-string (first def))))
                   (loc (second def)))
              (when (and (consp loc) (eq (first loc) :location))
                (let ((file nil) (position nil))
                  ;; Location-Teile einsammeln: (:file "...") (:position n)
                  ;; oder (:buffer ...) (:offset start n) je nach Quelle.
                  (dolist (part (rest loc))
                    (when (consp part)
                      (case (first part)
                        (:file (setf file (second part)))
                        (:buffer-and-file (setf file (third part)))
                        (:position (setf position (second part)))
                        (:offset (setf position (+ (or (second part) 0)
                                                   (or (third part) 0)))))))
                  (let ((resolved (and file (%resolve-source-file file))))
                    (if resolved
                        (destructuring-bind (line col)
                            (%offset->line-col resolved
                                               (max 0 (1- (or position 1))))
                          (push (list resolved line col label) results))
                        ;; Datei nicht auffindbar: Label trotzdem melden.
                        (push (list nil 0 0 label) results)))))))
          (list :ok (nreverse results)))
      (error (e)
        (list :error (format nil "~A" e))))))

(defun disassemble-for-repl (symbol-string package-name)
  "Disassembliert die Funktion, auf die SYMBOL-STRING im Paket
   PACKAGE-NAME zeigt, und gibt den nativen Maschinencode als Text
   zurück. Das ist genau das, was SBCLs (disassemble #'fn) auf
   *standard-output* schreibt — wir fangen es in einen String.
   Gibt (STATUS OUTPUT-STRING PACKAGE-STRING) zurück."
  (let ((pkg (or (find-package (string-upcase package-name))
                 (find-package :common-lisp-user))))
    (handler-case
        (let* ((*package* pkg)
               ;; Symbol aus dem String lesen (respektiert Paket-Prefixe
               ;; wie clamps::rts-start, weil *package* gebunden ist).
               (sym (let ((*read-eval* nil))
                      (read-from-string symbol-string))))
          (cond
            ((not (symbolp sym))
             (list :error
                   (format nil "~S ist kein Symbol." sym)
                   (package-name pkg)))
            ((not (fboundp sym))
             (list :error
                   (format nil "~A ist keine Funktion (fboundp = nil)." sym)
                   (package-name pkg)))
            ((macro-function sym)
             ;; disassemble auf ein Makro ist wenig sinnvoll — die
             ;; Expander-Funktion würde disassembliert, nicht das, was
             ;; der Nutzer erwartet. Ehrlich zurückmelden.
             (list :error
                   (format nil "~A ist ein Makro, kein disassemblierbarer Funktionsaufruf.~%~
                                Für Makros eignet sich Macroexpand." sym)
                   (package-name pkg)))
            (t
             (let ((out (make-string-output-stream)))
               (let ((*standard-output* out))
                 (disassemble (fdefinition sym)))
               (list :ok (get-output-stream-string out) (package-name pkg))))))
      (error (e)
        (list :error (format nil "~A" e) (package-name pkg))))))

(defun macroexpand-for-repl (code-string package-name full-p)
  "Liest die ERSTE Form aus CODE-STRING und expandiert sie im Paket
   PACKAGE-NAME. FULL-P nil = macroexpand-1 (nur eine Ebene, meist
   nützlicher beim interaktiven Arbeiten), FULL-P non-nil = macroexpand
   (vollständig). Gibt (STATUS OUTPUT-STRING PACKAGE-STRING) zurück.
   Die Ausgabe ist pretty-printed, damit der expandierte Code lesbar
   formatiert ist statt als eine lange Zeile."
  (let ((pkg (or (find-package (string-upcase package-name))
                 (find-package :common-lisp-user))))
    (handler-case
        (let* ((*package* pkg)
               (form (with-input-from-string (in code-string)
                       (read in nil :eof))))
          (if (eq form :eof)
              (list :ok "" (package-name pkg))
              (multiple-value-bind (expansion expanded-p)
                  (if full-p
                      (macroexpand form)
                      (macroexpand-1 form))
                (let ((text (if expanded-p
                                (let ((*print-pretty* t)
                                      (*print-right-margin* 80)
                                      (*print-case* :downcase))
                                  (prin1-to-string expansion))
                                ;; Kein Makro -> das ehrlich zurückmelden,
                                ;; statt die unveränderte Form als
                                ;; vermeintliche Expansion auszugeben.
                                (format nil ";; keine Makroexpansion (kein Makroaufruf)~%~A"
                                        (let ((*print-pretty* t)
                                              (*print-case* :downcase))
                                          (prin1-to-string expansion))))))
                  (list :ok text (package-name pkg))))))
      (error (e)
        (list :error (format nil "~A" e) (package-name pkg))))))

(defun eval-for-repl (code-string package-name)
  "Wertet CODE-STRING im Paket PACKAGE-NAME aus. Fängt Standard-Output
   und alle Rückgabewerte ein. Gibt (STATUS OUTPUT-STRING PACKAGE-STRING)
   zurück, STATUS ist :OK oder :ERROR."
  (let* ((pkg (or (find-package (string-upcase package-name))
                  (find-package :common-lisp-user)))
         (out (make-string-output-stream))
         ;; Ein Synonym-Stream, der auf out zeigt, damit alle Streams
         ;; wirklich denselben Puffer teilen.
         (two-way (make-two-way-stream (make-string-input-stream "") out)))
    (declare (ignorable two-way))
    (handler-case
        ;; ALLE Standard-Output-Streams auf out binden. Vorher waren nur
        ;; *standard-output*/*error-output*/*trace-output* gebunden; CLAMPS
        ;; (z.B. (clamps), describe) schreibt aber teils über *debug-io*,
        ;; *query-io* und *terminal-io*. Blieb einer davon an Swanks
        ;; Original-Stream gebunden, erschien die Ausgabe zusätzlich über
        ;; Swank und damit DOPPELT in der REPL. Jetzt teilen sich alle
        ;; denselben Puffer.
        (let* ((*package* pkg)
               (*standard-output* out)
               (*error-output* out)
               (*trace-output* out)
               (*debug-io* (make-two-way-stream (make-string-input-stream "") out))
               (*query-io* (make-two-way-stream (make-string-input-stream "") out))
               (*terminal-io* (make-two-way-stream (make-string-input-stream "") out))
               (values-strings '()))
          ;; Mehrere Forms nacheinander lesen und auswerten, damit eine
          ;; REPL-Zeile wie "(defparameter *x* 1) *x*" komplett läuft.
          (with-input-from-string (in code-string)
            (loop
              (let ((form (read in nil :eof)))
                (when (eq form :eof) (return))
                (let ((results (multiple-value-list (eval form))))
                  (setf values-strings
                        (append values-strings
                                (mapcar (lambda (v) (prin1-to-string v)) results)))))))
          (let* ((printed (get-output-stream-string out))
                 (value-text (format nil "~{~A~^~%~}" values-strings))
                 (combined (concatenate 'string
                                        printed
                                        (if (and (> (length printed) 0)
                                                 (> (length value-text) 0))
                                            (string #\Newline) "")
                                        value-text))
                 ;; *package* AUSLESEN, nicht pkg: wenn der Code ein
                 ;; (in-package ...) enthielt, hat sich *package* innerhalb
                 ;; dieser Bindung geändert. pkg zeigt weiter aufs alte
                 ;; Paket — deshalb blieb der REPL-Prompt hängen.
                 (current-pkg-name (package-name *package*)))
            (list :ok combined current-pkg-name)))
      (error (e)
        (let ((printed (get-output-stream-string out)))
          (list :error
                (concatenate 'string printed
                             (if (> (length printed) 0) (string #\Newline) "")
                             (format nil "~A" e))
                (package-name pkg)))))))

(in-package :cl-user)

(log-msg "Eval-Kanal (clamps-bridge-rpc:eval-for-repl) bereit")

;;; ---------------------------------------------------------------------
;;; Freien Port ermitteln (statt Port 0 an Swank zu übergeben und zu
;;; hoffen, dass der Rückgabewert stimmt: wir binden selbst kurz,
;;; lesen den Port aus, geben ihn wieder frei)
;;; ---------------------------------------------------------------------

(defun find-free-port ()
  (let* ((socket (usocket:socket-listen "127.0.0.1" 0 :reuse-address t))
         (port (usocket:get-local-port socket)))
    (usocket:socket-close socket)
    port))

(defparameter *swank-port* (find-free-port))

;;; ---------------------------------------------------------------------
;;; Swank-Server starten
;;; ---------------------------------------------------------------------

(handler-case
    (progn
      (setf swank:*communication-style* :spawn)
      (swank:create-server :port *swank-port*
                            :interface "127.0.0.1"
                            :dont-close t
                            :style :spawn)
      (log-msg "Swank läuft auf 127.0.0.1:~A" *swank-port*)
      (write-session-file :port *swank-port* :pid *pid* :status "ready"
                           :detail "Swank aktiv")
      (secure-permissions))
  (error (e)
    (log-msg "FEHLER beim Swank-Start: ~A" e)
    (write-session-file :pid *pid* :status "error"
                         :detail (format nil "Swank-Start fehlgeschlagen: ~A" e))
    (sb-ext:exit :code 1)))

;;; ---------------------------------------------------------------------
;;; Incudine-Realtime-Server sicherstellen
;;; (falls CLAMPS ihn beim Laden nicht schon selbst hochfährt)
;;; ---------------------------------------------------------------------

(handler-case
    (when (and (find-package :incudine)
               (fboundp (find-symbol "RT-RUNNING-P" :incudine))
               (not (funcall (find-symbol "RT-RUNNING-P" :incudine))))
      (funcall (find-symbol "RT-START" :incudine))
      (log-msg "Incudine RT-Server gestartet"))
  (error (e)
    (log-msg "WARNUNG: Incudine RT-Start fehlgeschlagen: ~A" e)))

;;; ---------------------------------------------------------------------
;;; Sauberes Herunterfahren bei SIGTERM (Extension beendet Prozess gezielt)
;;; ---------------------------------------------------------------------

(sb-sys:enable-interrupt
 sb-unix:sigterm
 (lambda (&rest _)
   (declare (ignore _))
   (log-msg "SIGTERM empfangen, fahre herunter")
   (write-session-file :port *swank-port* :pid *pid* :status "stopped"
                        :detail "Von Extension beendet")
   (sb-ext:exit :code 0 :abort t)))

;;; ---------------------------------------------------------------------
;;; Prozess am Leben halten. Swank läuft im eigenen Thread (:style :spawn),
;;; dieser Loop hält das Hauptimage nur offen.
;;; ---------------------------------------------------------------------

(log-msg "Bootstrap fertig. Warte auf Verbindungen auf Port ~A." *swank-port*)
(loop (sleep 3600))
