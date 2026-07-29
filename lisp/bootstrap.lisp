;;;; bootstrap.lisp
;;;;
;;;; Starts an SBCL image with CLAMPS + a Swank server for the VS Code
;;;; extension. It is started with `sbcl --script bootstrap.lisp` and
;;;; keeps running independently of the editor process (detached).
;;;;
;;;; Communication with the extension does NOT go over stdout/stdin but
;;;; over a session file, so that the extension can check at any time
;;;; (including after a restart of its own) whether a CLAMPS process is
;;;; already running and which port it is listening on.

(require :asdf)
(require :sb-posix)

;;; ---------------------------------------------------------------------
;;; Session directory + status file
;;;
;;; A note on security: Swank has no built-in authentication. The
;;; practical boundary is therefore (a) binding exclusively to 127.0.0.1
;;; (see below) and (b) file system permissions on the directory and the
;;; session file, so that on multi-user machines (shared remote dev boxes,
;;; say) not every local user can read the port and connect. A secret
;;; handshake at the Swank protocol level would be brittle (Swank knows
;;; nothing of the sort) – anyone needing real multi-user isolation should
;;; instead make the port reachable only through an SSH tunnel or port
;;; forward, never expose it directly.
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
  "Sets the session directory to 0700 and the files in it to 0600, so
   that only one's own user can read them. Errors here are not fatal (on
   file systems without Unix permissions, say), but they are logged."
  (handler-case
      (progn
        (sb-posix:chmod (namestring *session-dir*) #o700)
        (dolist (f (list *session-file* *log-file*))
          (when (probe-file f)
            (sb-posix:chmod (namestring f) #o600))))
    (error (e)
      (log-msg "WARNING: could not set the file permissions: ~A" e))))

(defun log-msg (fmt &rest args)
  (with-open-file (s *log-file*
                      :direction :output
                      :if-exists :append
                      :if-does-not-exist :create)
    (format s "~&[~A] " (get-universal-time))
    (apply #'format s fmt args)
    (terpri s)))

(defun write-session-file (&key port pid status detail)
  "Writes the current state as JSON. The extension polls/watches this
   file instead of parsing stdout."
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
                             :detail "Quicklisp not found")
        (log-msg "ERROR: Quicklisp not found at ~A" ql-init)
        (sb-ext:exit :code 1))))

;;; ---------------------------------------------------------------------
;;; Swank, usocket, CLAMPS laden
;;; ---------------------------------------------------------------------

(handler-case
    (progn
      (write-session-file :pid *pid* :status "starting" :detail "Lade Swank + Slynk + usocket")
      ;; CLAMPS is built for Sly (not SLIME) and references Slynk symbols
      ;; while loading. We start the RPC server over Swank all the same
      ;; (a better documented protocol for the bridge), but Slynk has to
      ;; be loaded so that the SLYNK package exists.
      (ql:quickload '(:swank :slynk :usocket) :silent t)
      (write-session-file :pid *pid* :status "starting" :detail "Lade CLAMPS")
      ;; cudere-clm (part of the Incudine environment) proclaims
      ;; DOUBLE-FLOAT to be a function in COMMON-LISP and thereby violates
      ;; the package lock. Interactively (Emacs/SLIME) that is a
      ;; continuable error which one mostly never consciously clicks away.
      ;; In --script mode there is no debugger to offer the restart, so it
      ;; is switched off explicitly here instead of hoping for an
      ;; interactive continue.
      (sb-ext:without-package-locks
        (ql:quickload :clamps :silent t)))
  (error (e)
    (log-msg "ERROR while loading: ~A" e)
    (write-session-file :pid *pid* :status "error"
                         :detail (format nil "Ladefehler: ~A" e))
    (sb-ext:exit :code 1)))

(log-msg "CLAMPS + Swank geladen")

;;; ---------------------------------------------------------------------
;;; Slynk shim: catch eval-in-emacs when there is no Emacs connection
;;;
;;; In several places (rts-start, rts-stop) CLAMPS calls
;;; slynk:eval-in-emacs directly, in order to set Emacs modeline labels
;;; such as "DSP ✓". That presupposes an active Sly session (a bound
;;; slynk *emacs-connection*). Over our bridge there is none, so
;;; eval-in-emacs crashes with "nil fell through etypecase" (it expects a
;;; slynk::connection and gets nil).
;;;
;;; CLAMPS's own code already checks slynk-api:*emacs-connection* in the
;;; newer places (see init.lisp), but rts-start and some others do not.
;;; Rather than patching CLAMPS, we make eval-in-emacs a silent no-op when
;;; there is no connection — the Emacs cosmetics (modeline labels) fall
;;; away, which makes no sense in VS Code anyway; everything else
;;; (rt-start, the web server, ...) runs.
;;;
;;; We override only the behaviour when there is no connection and
;;; otherwise delegate to the original function, so that nothing breaks in
;;; a real Slynk session (should there ever be one).
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
                      ;; Only execute it when an Emacs connection really
                      ;; is active; otherwise ignore it silently.
                      (if (and (boundp conn-sym) (symbol-value conn-sym))
                          (apply original args)
                          nil)))
              (log-msg "Slynk eval-in-emacs shim installed (a no-op without a connection)"))
            (log-msg "Slynk shim skipped: symbols not found (eval=~A conn=~A)"
                     eval-sym conn-sym))))
  (error (e)
    (log-msg "WARNUNG: Slynk-Shim fehlgeschlagen: ~A" e)))

;;; ---------------------------------------------------------------------
;;; Eval channel for the VS Code REPL
;;;
;;; The actual RPC functions live in rpc.lisp (package CLAMPS-BRIDGE-RPC).
;;; They were moved out because they need neither CLAMPS nor Swank and so
;;; stay testable against a bare SBCL.
;;; ---------------------------------------------------------------------

(handler-case
    (load (merge-pathnames "rpc.lisp"
                           (or *load-truename* *default-pathname-defaults*)))
  (error (e)
    (log-msg "ERROR while loading rpc.lisp: ~A" e)
    (write-session-file :pid *pid* :status "error"
                         :detail (format nil "rpc.lisp: ~A" e))
    (sb-ext:exit :code 1)))

;; An additive completion extension. rpc.lisp stays unchanged; on an
;; error the extension falls back safely to the prefix completion there.
(handler-case
    (load (merge-pathnames "completion.lisp"
                           (or *load-truename* *default-pathname-defaults*)))
  (error (e)
    (log-msg "WARNING: completion.lisp not loaded; using the base completion: ~A" e)))

;; An additive autodoc extension; an error must not stop the existing server.
(handler-case
    (load (merge-pathnames "autodoc.lisp"
                           (or *load-truename* *default-pathname-defaults*)))
  (error (e)
    (log-msg "WARNING: autodoc.lisp not loaded: ~A" e)))
(in-package :cl-user)

(log-msg "Eval-Kanal (clamps-bridge-rpc:eval-for-repl) bereit")

;;; ---------------------------------------------------------------------
;;; Find a free port (rather than passing port 0 to Swank and hoping the
;;; return value is right: we bind briefly ourselves, read the port out
;;; and release it again)
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
      (log-msg "Swank is running on 127.0.0.1:~A" *swank-port*)
      (write-session-file :port *swank-port* :pid *pid* :status "ready"
                           :detail "Swank aktiv")
      (secure-permissions))
  (error (e)
    (log-msg "ERROR while starting Swank: ~A" e)
    (write-session-file :pid *pid* :status "error"
                         :detail (format nil "Swank-Start fehlgeschlagen: ~A" e))
    (sb-ext:exit :code 1)))

;;; ---------------------------------------------------------------------
;;; Make sure the Incudine realtime server is up
;;; (in case CLAMPS has not already brought it up itself while loading)
;;;
;;; The earlier version checked rigidly for incudine:rt-running-p. That
;;; name does not exist in current Incudine versions — thanks to the
;;; fboundp in front of it there was no error, but the block simply never
;;; ran. Hence the same multiple check here as in rt-status-for-repl.
;;; ---------------------------------------------------------------------

(handler-case
    (when (or (find-package :incudine) (find-package :clamps))
      (let ((running (clamps-bridge-rpc:rt-status-for-repl)))
        ;; (:ok running-p info)
        (if (second running)
            (log-msg "Incudine RT server is already running")
            (let ((start-sym (clamps-bridge-rpc::%rt-sym "RT-START")))
              (if start-sym
                  (progn (funcall start-sym)
                         (log-msg "Incudine RT-Server gestartet"))
                  (log-msg "WARNING: incudine:rt-start not found"))))))
  (error (e)
    (log-msg "WARNUNG: Incudine RT-Start fehlgeschlagen: ~A" e)))

;;; ---------------------------------------------------------------------
;;; A clean shutdown on SIGTERM (the extension ends the process deliberately)
;;; ---------------------------------------------------------------------

(sb-sys:enable-interrupt
 sb-unix:sigterm
 (lambda (&rest _)
   (declare (ignore _))
   (log-msg "SIGTERM empfangen, fahre herunter")
   (write-session-file :port *swank-port* :pid *pid* :status "stopped"
                        :detail "Ended by the extension")
   (sb-ext:exit :code 0 :abort t)))

;;; ---------------------------------------------------------------------
;;; Keep the process alive. Swank runs in a thread of its own
;;; (:style :spawn); this loop only keeps the main image open.
;;; ---------------------------------------------------------------------

(log-msg "Bootstrap finished. Waiting for connections on port ~A." *swank-port*)

;; If CLAMPS_NO_KEEPALIVE is set we return instead. The Swank thread
;; (:style :spawn) carries on independently anyway; only the main image is
;; then free — necessary in order to pull in a test script with --load in
;; the same invocation, or to work at the REPL.
(if (sb-ext:posix-getenv "CLAMPS_NO_KEEPALIVE")
    (log-msg "CLAMPS_NO_KEEPALIVE is set — keep-alive loop skipped.")
    (loop (sleep 3600)))
