// processManager.ts
//
// Manages the life cycle of the SBCL/CLAMPS bootstrap process from
// within the VS Code extension. The core idea: the process is started
// detached and survives a restart of the extension host. On the next
// activation the extension first checks whether a running session
// already exists, instead of blindly spawning a new one.

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';

export type SessionStatus = 'starting' | 'ready' | 'error' | 'stopped';

export interface SessionInfo {
  port: number | null;
  pid: number | null;
  status: SessionStatus;
  detail: string;
}

export class ClampsProcessManager {
  private readonly sessionDir: string;
  private readonly sessionFile: string;

  constructor(
    private readonly workspaceRoot: string,
    private readonly bootstrapPath: string,
    private readonly sbclCommand: string = 'sbcl'
  ) {
    // The session directory lives in the workspace, not globally under
    // $HOME — so every workspace has its own CLAMPS instance and several
    // VS Code windows open at once do not collide.
    this.sessionDir = path.join(workspaceRoot, '.vscode', 'clamps');
    this.sessionFile = path.join(this.sessionDir, 'session.json');
  }

  private readSession(): SessionInfo | null {
    try {
      const raw = fs.readFileSync(this.sessionFile, 'utf8');
      return JSON.parse(raw) as SessionInfo;
    } catch {
      return null;
    }
  }

  /** Current Swank port of the running session, or null if none is running. */
  getPort(): number | null {
    const info = this.readSession();
    if (info && info.status === 'ready' && info.port !== null) {
      return info.port;
    }
    return null;
  }

  private isPidAlive(pid: number): boolean {
    try {
      // Signal 0 sends nothing, it only checks whether the process
      // exists and whether we have access to it.
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Decides whether an existing session may be carried on with.
   *
   * A pure function, so that the logic can be checked without a process
   * and without a socket — it is the reason why one previously had to
   * "clear the cache on every exit".
   */
  static reuseDecision(args: {
    info: SessionInfo | null;
    pidAlive: boolean;
    portAnswers: boolean;
    fingerprintMatches: boolean;
  }): { reuse: boolean; reason: string } {
    const { info, pidAlive, portAnswers, fingerprintMatches } = args;
    if (!info) return { reuse: false, reason: 'no session file' };
    if (info.status !== 'ready') return { reuse: false, reason: `status ${info.status}` };
    if (info.pid === null || !pidAlive) return { reuse: false, reason: 'process is dead' };
    if (info.port === null) return { reuse: false, reason: 'no port recorded' };
    // A live PID does not mean that THIS image is living there: after a
    // crash the number may have been reassigned, and a hung image no
    // longer answers on the Swank port.
    if (!portAnswers) {
      return { reuse: false, reason: `port ${info.port} does not answer` };
    }
    // The most important case. deactivate() deliberately lets SBCL carry
    // on so that it survives the editor. But that is exactly how you end
    // up developing against an image in which the OLD lisp/*.lisp are
    // still loaded — visible only as "eval-for-repl-debuggable is not
    // fbound" or as behaviour that does not match the source.
    if (!fingerprintMatches) {
      return { reuse: false, reason: 'Lisp sources have changed' };
    }
    return { reuse: true, reason: 'unchanged' };
  }

  /** Reason for the last start decision — for the output window. */
  lastStartNote = '';

  /**
   * Makes sure that a CLAMPS session is running.
   *
   * A session is reused only if the process is alive, its Swank port
   * answers AND the Lisp sources are unchanged. Otherwise a fresh start
   * — without having to delete session.json by hand first.
   */
  async ensureRunning(): Promise<SessionInfo> {
    fs.mkdirSync(this.sessionDir, { recursive: true });

    const info = this.readSession();
    const fingerprint = this.sourceFingerprint();
    const decision = ClampsProcessManager.reuseDecision({
      info,
      pidAlive: info?.pid != null && this.isPidAlive(info.pid),
      portAnswers:
        info?.port != null && info.status === 'ready'
          ? await this.probePort(info.port)
          : false,
      fingerprintMatches: this.readFingerprint() === fingerprint,
    });

    if (decision.reuse && info) {
      this.lastStartNote = `Reusing the running CLAMPS session on port ${info.port}.`;
      return info;
    }

    this.lastStartNote = `Fresh CLAMPS start (${decision.reason}).`;
    // A process that is still alive but unusable has to go — otherwise
    // two images hang off the same session directory and the second one
    // overwrites the file of the first.
    if (info?.pid != null && this.isPidAlive(info.pid)) {
      await this.stop();
    }
    return this.spawnFresh();
  }

  // --- Detection of stale images --------------------------------------

  private get fingerprintFile(): string {
    return path.join(this.sessionDir, 'image.fingerprint');
  }

  /**
   * Signature of the Lisp sources an image was started with: name, size
   * and modification time of every .lisp file next to bootstrap.lisp.
   *
   * Deliberately not a hash over the contents — together the files are
   * over 2500 lines, and this runs at every start. Size plus mtime is
   * enough to recognise "I have just changed rpc.lisp".
   */
  private sourceFingerprint(): string {
    try {
      const dir = path.dirname(this.bootstrapPath);
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.lisp')).sort();
      return files
        .map(f => {
          const s = fs.statSync(path.join(dir, f));
          return `${f}:${s.size}:${Math.floor(s.mtimeMs)}`;
        })
        .join('|');
    } catch {
      // Not readable: then better start fresh than carry on wrongly.
      return `unlesbar:${Date.now()}`;
    }
  }

  private readFingerprint(): string | undefined {
    try {
      return fs.readFileSync(this.fingerprintFile, 'utf8');
    } catch {
      // If the file is missing, the image comes from a version without
      // this check — so from an unknown source state.
      return undefined;
    }
  }

  /** Does anybody answer on the port at all? */
  private probePort(port: number, timeoutMs = 800): Promise<boolean> {
    return new Promise(resolve => {
      const socket = new net.Socket();
      const finish = (ok: boolean) => {
        socket.removeAllListeners();
        try { socket.destroy(); } catch { /* egal */ }
        resolve(ok);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
      socket.connect(port, '127.0.0.1');
    });
  }

  /** Path of the log file with SBCL's stdout and stderr. */
  get logFile(): string {
    return path.join(this.sessionDir, 'clamps.log');
  }

  private spawnFresh(): Promise<SessionInfo> {
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        CLAMPS_SESSION_DIR: this.sessionDir,
      };

      // stdout and stderr into a file, do NOT discard them.
      //
      // Previously this said stdio: 'ignore', on the grounds that
      // communication goes through session.json. That is true for normal
      // operation — but when the image dies, SBCL writes exactly there:
      // ldb message, "fatal error encountered", heap exhausted,
      // unhandled condition while loading. Without these lines all that
      // remains in the end is "Pending response rejected since
      // connection got disposed" in three tree views, and the cause is
      // irretrievably gone.
      //
      // A file, not an OutputChannel: the process is detached and
      // survives a restart of the extension host, a channel does not.
      // Appended, not overwritten, so that the previous crash does not
      // vanish on restart precisely when it is needed.
      let out: number | 'ignore' = 'ignore';
      try {
        fs.mkdirSync(this.sessionDir, { recursive: true });
        out = fs.openSync(this.logFile, 'a');
        fs.writeSync(
          out,
          `\n;;; ---- Start ${new Date().toISOString()} ` +
          `(${this.sbclCommand} --script ${this.bootstrapPath}) ----\n`
        );
      } catch {
        // No log is worse than a log, but no reason to refuse the
        // start.
      }

      // Record the source state this image starts with. Without it there
      // is no way to decide later whether the running process still
      // matches the source on disk.
      try {
        fs.writeFileSync(this.fingerprintFile, this.sourceFingerprint(), 'utf8');
      } catch {
        // Then the next start simply takes the fresh-start path.
      }

      const child = cp.spawn(this.sbclCommand, ['--script', this.bootstrapPath], {
        env,
        detached: true,
        stdio: ['ignore', out, out],
        cwd: this.workspaceRoot,
      });

      // Close our own descriptor: the child has its own copy, and an
      // open fd in the extension host would otherwise hold the file
      // until the window closes.
      if (typeof out === 'number') {
        try { fs.closeSync(out); } catch { /* egal */ }
      }

      // Severs the parent-child bond: the process survives when the
      // extension host ends (window closed, VS Code restart, ...).
      child.unref();

      child.once('error', (err) => {
        reject(new Error(`Could not start SBCL (${this.sbclCommand}): ${err.message}`));
      });

      this.pollForReady(resolve, reject);
    });
  }

  /** Last lines of the log — for error messages and for the command. */
  readLogTail(lines = 40): string {
    try {
      const all = fs.readFileSync(this.logFile, 'utf8').split('\n');
      return all.slice(-lines).join('\n').trim();
    } catch {
      return '';
    }
  }

  private pollForReady(
    resolve: (info: SessionInfo) => void,
    reject: (err: Error) => void
  ): void {
    const timeoutMs = 60_000;
    const pollIntervalMs = 300;
    const start = Date.now();

    const poll = () => {
      const info = this.readSession();

      if (info?.status === 'ready') {
        resolve(info);
        return;
      }
      if (info?.status === 'error') {
        reject(new Error(`CLAMPS-Bootstrap fehlgeschlagen: ${info.detail}`));
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('Timeout waiting for the CLAMPS bootstrap (60s)'));
        return;
      }
      setTimeout(poll, pollIntervalMs);
    };

    setTimeout(poll, pollIntervalMs);
  }

  /**
   * Terminates the running session with SIGTERM and WAITS until the
   * process has actually ended. Without that wait, an ensureRunning()
   * immediately afterwards still reads the old session.json with status
   * "ready" and the PID that is just dying (and briefly still appears
   * "alive") and starts no fresh process — the result was the timeout
   * chaos on restart.
   */
  async stop(): Promise<void> {
    const info = this.readSession();
    const pid = info?.pid;
    if (pid === null || pid === undefined || !this.isPidAlive(pid)) {
      this.invalidateSession();
      return;
    }

    process.kill(pid, 'SIGTERM');

    // Wait up to 5 s for a clean exit.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!this.isPidAlive(pid)) break;
      await new Promise(res => setTimeout(res, 100));
    }

    // If SIGTERM did not take, follow up hard.
    if (this.isPidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }

    this.invalidateSession();
  }

  /**
   * Overwrites the session file with status "stopped", so that a
   * following ensureRunning() is guaranteed not to reuse it as "ready"
   * and spawns freshly instead.
   */
  private invalidateSession(): void {
    // Invalidate the fingerprint as well: otherwise an image started by
    // hand later counts as "matching" although nobody knows what it was
    // loaded with.
    try { fs.unlinkSync(this.fingerprintFile); } catch { /* not there */ }
    try {
      fs.writeFileSync(
        this.sessionFile,
        JSON.stringify({ port: null, pid: null, status: 'stopped', detail: 'stopped by extension' }, null, 2)
      );
    } catch {
      // File may not exist — then there is nothing to invalidate anyway.
    }
  }

  getSessionFilePath(): string {
    return this.sessionFile;
  }
}
