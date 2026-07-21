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
   * Stellt sicher, dass eine CLAMPS-Session läuft. Wenn bereits eine
   * gültige Session-Datei mit lebendigem PID existiert, wird diese
   * wiederverwendet statt neu zu spawnen.
   */
  async ensureRunning(): Promise<SessionInfo> {
    fs.mkdirSync(this.sessionDir, { recursive: true });

    const existing = this.readSession();
    if (
      existing &&
      existing.status === 'ready' &&
      existing.pid !== null &&
      this.isPidAlive(existing.pid)
    ) {
      return existing;
    }

    // Verwaiste Session-Datei (Prozess tot, Status stopped/error) räumen
    // wir nicht weg, sondern überschreiben sie beim Neustart einfach –
    // das Bootstrap-Skript setzt status wieder auf "starting".
    return this.spawnFresh();
  }

  private spawnFresh(): Promise<SessionInfo> {
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        CLAMPS_SESSION_DIR: this.sessionDir,
      };

      const child = cp.spawn(this.sbclCommand, ['--script', this.bootstrapPath], {
        env,
        detached: true,
        stdio: 'ignore', // Kommunikation läuft über session.json, nicht stdout
        cwd: this.workspaceRoot,
      });

      // Löst die Eltern-Kind-Bindung: der Prozess überlebt, wenn der
      // Extension-Host beendet wird (Fenster zu, VS Code Neustart, ...).
      child.unref();

      child.once('error', (err) => {
        reject(new Error(`Konnte SBCL nicht starten (${this.sbclCommand}): ${err.message}`));
      });

      this.pollForReady(resolve, reject);
    });
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
