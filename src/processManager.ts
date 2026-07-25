// processManager.ts
//
// Verwaltet den Lebenszyklus des SBCL/CLAMPS-Bootstrap-Prozesses aus
// der VS-Code-Extension heraus. Kernidee: der Prozess wird detached
// gestartet und überlebt einen Neustart des Extension-Hosts. Beim
// nächsten Aktivieren prüft die Extension zuerst, ob schon eine
// laufende Session existiert, statt blind neu zu spawnen.

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
    // Session-Verzeichnis liegt im Workspace, nicht global unter $HOME –
    // damit hat jeder Workspace seine eigene CLAMPS-Instanz und mehrere
    // gleichzeitig offene VS-Code-Fenster kollidieren nicht.
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

  /** Aktueller Swank-Port der laufenden Session, oder null wenn keine läuft. */
  getPort(): number | null {
    const info = this.readSession();
    if (info && info.status === 'ready' && info.port !== null) {
      return info.port;
    }
    return null;
  }

  private isPidAlive(pid: number): boolean {
    try {
      // Signal 0 sendet nichts, prüft nur ob der Prozess existiert und
      // wir Zugriff darauf haben.
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Entscheidet, ob eine bestehende Session weiterbenutzt werden darf.
   *
   * Reine Funktion, damit die Logik ohne Prozess und ohne Socket geprüft
   * werden kann — sie ist der Grund, warum man bisher „bei jedem
   * Beenden den Cache leeren" musste.
   */
  static reuseDecision(args: {
    info: SessionInfo | null;
    pidAlive: boolean;
    portAnswers: boolean;
    fingerprintMatches: boolean;
  }): { reuse: boolean; reason: string } {
    const { info, pidAlive, portAnswers, fingerprintMatches } = args;
    if (!info) return { reuse: false, reason: 'keine Session-Datei' };
    if (info.status !== 'ready') return { reuse: false, reason: `Status ${info.status}` };
    if (info.pid === null || !pidAlive) return { reuse: false, reason: 'Prozess ist tot' };
    if (info.port === null) return { reuse: false, reason: 'kein Port vermerkt' };
    // Ein lebender PID heisst nicht, dass DIESES Image dort lebt: nach
    // einem Absturz kann die Nummer neu vergeben sein, und ein hängendes
    // Image antwortet nicht mehr auf dem Swank-Port.
    if (!portAnswers) {
      return { reuse: false, reason: `Port ${info.port} antwortet nicht` };
    }
    // Der wichtigste Fall. deactivate() lässt SBCL bewusst weiterlaufen,
    // damit es den Editor überlebt. Genau dadurch entwickelt man aber
    // gegen ein Image, in dem noch die ALTEN lisp/*.lisp geladen sind —
    // sichtbar erst als "eval-for-repl-debuggable ist nicht fbound" oder
    // als Verhalten, das zum Quelltext nicht passt.
    if (!fingerprintMatches) {
      return { reuse: false, reason: 'Lisp-Quellen haben sich geändert' };
    }
    return { reuse: true, reason: 'unverändert' };
  }

  /** Grund der letzten Start-Entscheidung — für das Ausgabefenster. */
  lastStartNote = '';

  /**
   * Stellt sicher, dass eine CLAMPS-Session läuft.
   *
   * Wiederverwendet wird nur, wenn der Prozess lebt, sein Swank-Port
   * antwortet UND die Lisp-Quellen unverändert sind. Sonst frischer
   * Start — ohne dass man erst von Hand session.json löschen muss.
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
      this.lastStartNote = `Laufende CLAMPS-Session auf Port ${info.port} weiterbenutzt.`;
      return info;
    }

    this.lastStartNote = `Frischer CLAMPS-Start (${decision.reason}).`;
    // Ein noch lebender, aber unbrauchbarer Prozess muss weg — sonst
    // hängen zwei Images am selben Session-Verzeichnis und das zweite
    // überschreibt die Datei des ersten.
    if (info?.pid != null && this.isPidAlive(info.pid)) {
      await this.stop();
    }
    return this.spawnFresh();
  }

  // --- Erkennung veralteter Images ------------------------------------

  private get fingerprintFile(): string {
    return path.join(this.sessionDir, 'image.fingerprint');
  }

  /**
   * Kennzeichen der Lisp-Quellen, mit denen ein Image gestartet wurde:
   * Name, Größe und Änderungszeit jeder .lisp-Datei neben bootstrap.lisp.
   *
   * Absichtlich kein Hash über den Inhalt — die Dateien sind zusammen
   * über 2500 Zeilen, und das hier läuft bei jedem Start. Größe plus
   * mtime reicht, um „ich habe gerade rpc.lisp geändert" zu erkennen.
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
      // Nicht lesbar: dann lieber frisch starten als falsch weiterbenutzen.
      return `unlesbar:${Date.now()}`;
    }
  }

  private readFingerprint(): string | undefined {
    try {
      return fs.readFileSync(this.fingerprintFile, 'utf8');
    } catch {
      // Fehlt die Datei, stammt das Image aus einer Fassung ohne diese
      // Prüfung — also aus unbekanntem Quellstand.
      return undefined;
    }
  }

  /** Antwortet auf dem Port überhaupt jemand? */
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

  /** Pfad der Protokolldatei mit SBCLs stdout und stderr. */
  get logFile(): string {
    return path.join(this.sessionDir, 'clamps.log');
  }

  private spawnFresh(): Promise<SessionInfo> {
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        CLAMPS_SESSION_DIR: this.sessionDir,
      };

      // stdout und stderr in eine Datei, NICHT verwerfen.
      //
      // Vorher stand hier stdio: 'ignore' mit der Begründung, die
      // Kommunikation laufe über session.json. Das stimmt für den
      // Normalbetrieb — aber wenn das Image stirbt, schreibt SBCL genau
      // dorthin: Ldb-Meldung, "fatal error encountered", Heap
      // Exhausted, unhandled condition beim Laden. Ohne diese Zeilen
      // steht am Ende nur "Pending response rejected since connection
      // got disposed" in drei Baumansichten, und die Ursache ist
      // unwiederbringlich weg.
      //
      // Datei, nicht OutputChannel: der Prozess ist detached und
      // überlebt einen Neustart des Extension-Hosts, ein Channel nicht.
      // Angehängt, nicht überschrieben, damit der vorige Absturz beim
      // Neustart nicht gerade dann verschwindet, wenn man ihn braucht.
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
        // Kein Protokoll ist schlechter als eins, aber kein Grund,
        // den Start zu verweigern.
      }

      // Quellstand festhalten, mit dem dieses Image startet. Ohne das
      // ist später nicht entscheidbar, ob der laufende Prozess noch zum
      // Quelltext auf der Platte passt.
      try {
        fs.writeFileSync(this.fingerprintFile, this.sourceFingerprint(), 'utf8');
      } catch {
        // Dann greift beim nächsten Start eben der Frisch-Start.
      }

      const child = cp.spawn(this.sbclCommand, ['--script', this.bootstrapPath], {
        env,
        detached: true,
        stdio: ['ignore', out, out],
        cwd: this.workspaceRoot,
      });

      // Den eigenen Deskriptor schliessen: das Kind hat seine eigene
      // Kopie, und ein offener fd im Extension-Host hält die Datei sonst
      // bis zum Fensterschluss.
      if (typeof out === 'number') {
        try { fs.closeSync(out); } catch { /* egal */ }
      }

      // Löst die Eltern-Kind-Bindung: der Prozess überlebt, wenn der
      // Extension-Host beendet wird (Fenster zu, VS Code Neustart, ...).
      child.unref();

      child.once('error', (err) => {
        reject(new Error(`Konnte SBCL nicht starten (${this.sbclCommand}): ${err.message}`));
      });

      this.pollForReady(resolve, reject);
    });
  }

  /** Letzte Zeilen des Protokolls — für Fehlermeldungen und den Befehl. */
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
        reject(new Error('Timeout beim Warten auf CLAMPS-Bootstrap (60s)'));
        return;
      }
      setTimeout(poll, pollIntervalMs);
    };

    setTimeout(poll, pollIntervalMs);
  }

  /**
   * Beendet die laufende Session per SIGTERM und WARTET, bis der Prozess
   * tatsächlich beendet ist. Ohne dieses Warten liest ein unmittelbar
   * folgendes ensureRunning() noch die alte session.json mit status
   * "ready" und dem gerade sterbenden PID (der kurz noch "alive"
   * erscheint) und startet keinen frischen Prozess — Ergebnis war das
   * Timeout-Chaos beim Restart.
   */
  async stop(): Promise<void> {
    const info = this.readSession();
    const pid = info?.pid;
    if (pid === null || pid === undefined || !this.isPidAlive(pid)) {
      this.invalidateSession();
      return;
    }

    process.kill(pid, 'SIGTERM');

    // Bis zu 5s auf sauberes Beenden warten.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!this.isPidAlive(pid)) break;
      await new Promise(res => setTimeout(res, 100));
    }

    // Falls SIGTERM nicht griff, hart nachsetzen.
    if (this.isPidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // schon weg
      }
    }

    this.invalidateSession();
  }

  /**
   * Überschreibt die Session-Datei mit status "stopped", damit ein
   * folgendes ensureRunning() sie garantiert nicht als "ready"
   * wiederverwendet und stattdessen frisch spawnt.
   */
  private invalidateSession(): void {
    // Auch den Fingerprint entwerten: sonst gilt ein spaeter von Hand
    // gestartetes Image als "passend", obwohl niemand weiss, womit es
    // geladen wurde.
    try { fs.unlinkSync(this.fingerprintFile); } catch { /* nicht da */ }
    try {
      fs.writeFileSync(
        this.sessionFile,
        JSON.stringify({ port: null, pid: null, status: 'stopped', detail: 'stopped by extension' }, null, 2)
      );
    } catch {
      // Datei evtl. nicht vorhanden — dann ist ohnehin nichts zu invalidieren.
    }
  }

  getSessionFilePath(): string {
    return this.sessionFile;
  }
}
