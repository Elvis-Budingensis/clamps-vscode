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
;;; Die eigentlichen RPC-Funktionen liegen in rpc.lisp (Paket
;;; CLAMPS-BRIDGE-RPC). Ausgelagert, weil sie weder CLAMPS noch Swank
;;; brauchen und so gegen ein nacktes SBCL testbar bleiben.
;;; ---------------------------------------------------------------------

(handler-case
    (load (merge-pathnames "rpc.lisp"
                           (or *load-truename* *default-pathname-defaults*)))
  (error (e)
    (log-msg "FEHLER beim Laden von rpc.lisp: ~A" e)
    (write-session-file :pid *pid* :status "error"
                         :detail (format nil "rpc.lisp: ~A" e))
    (sb-ext:exit :code 1)))
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
;;;
;;; Die frühere Fassung prüfte fest auf incudine:rt-running-p. Den Namen
;;; gibt es in aktuellen Incudine-Versionen nicht — durch das fboundp
;;; davor gab es zwar keinen Fehler, der Block lief aber schlicht nie.
;;; Deshalb hier dieselbe Mehrfach-Prüfung wie in rt-status-for-repl.
;;; ---------------------------------------------------------------------

(handler-case
    (when (find-package :incudine)
      (let ((running (clamps-bridge-rpc:rt-status-for-repl)))
        ;; (:ok running-p info)
        (if (second running)
            (log-msg "Incudine RT-Server läuft bereits")
            (let ((start-sym (find-symbol "RT-START" :incudine)))
              (if (and start-sym (fboundp start-sym))
                  (progn (funcall start-sym)
                         (log-msg "Incudine RT-Server gestartet"))
                  (log-msg "WARNUNG: incudine:rt-start nicht gefunden"))))))
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

;; Ist CLAMPS_NO_KEEPALIVE gesetzt, kehren wir stattdessen zurück. Der
;; Swank-Thread läuft (:style :spawn) ohnehin eigenständig weiter; nur
;; das Hauptimage bleibt dann frei — nötig, um im selben Aufruf noch ein
;; Testskript per --load nachzuziehen oder am REPL zu arbeiten.
(if (sb-ext:posix-getenv "CLAMPS_NO_KEEPALIVE")
    (log-msg "CLAMPS_NO_KEEPALIVE gesetzt — Keep-Alive-Loop übersprungen.")
    (loop (sleep 3600)))
