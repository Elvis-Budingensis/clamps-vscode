// rtStatus.ts
//
// Zeigt in der Statusleiste, ob der Incudine-Realtime-Server läuft.
//
// Warum das nötig ist: CLAMPS setzt in rts-start/rts-stop per
// slynk:eval-in-emacs ein Modeline-Label ("DSP ✓"). Ohne Emacs-Connection
// crasht dieser Aufruf, deshalb ist er in bootstrap.lisp ein No-op — mit
// der Folge, dass in VS Code jede Anzeige fehlt, ob DSP läuft. Statt auf
// Push aus dem Image zu warten (den es ohne Emacs nicht gibt), pollen wir
// den Zustand aktiv.

import * as vscode from 'vscode';
import { LanguageClient, State } from 'vscode-languageclient/node';

interface RtInfo {
  key: string;
  value: string;
}
interface RtStatusResult {
  running: boolean;
  info: RtInfo[];
}

export class ClampsRtStatus implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  // ReturnType statt NodeJS.Timeout: funktioniert auch ohne @types/node
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight = false;
  private getClient: () => LanguageClient | undefined;

  constructor(getClient: () => LanguageClient | undefined) {
    this.getClient = getClient;
    // Priorität knapp unter den Sprachanzeigen, damit es nicht ganz
    // rechts unter „ferner liefen" landet.
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.command = 'clamps.rtStatusDetails';
    this.setDisconnected();
    this.item.show();
  }

  /** Startet das Polling. Intervall über clamps.rtPollInterval (ms). */
  start(): void {
    this.stop();
    const interval = vscode.workspace
      .getConfiguration('clamps')
      .get<number>('rtPollInterval', 3000);
    if (interval <= 0) return; // 0 = Polling aus
    this.timer = setInterval(() => void this.refresh(), interval);
    void this.refresh();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async refresh(): Promise<void> {
    // Überlappende Anfragen vermeiden: hängt das Image (langer GC, RT
    // blockiert), würden sich sonst Requests stapeln.
    if (this.inFlight) return;

    const client = this.getClient();
    if (!client || client.state !== State.Running) {
      this.setDisconnected();
      return;
    }

    this.inFlight = true;
    try {
      const r = await client.sendRequest<RtStatusResult>('clamps/rtStatus', {});
      this.setStatus(r);
    } catch {
      // Ein fehlgeschlagener Poll ist kein Grund für eine Fehlermeldung —
      // beim Neustart passiert das regelmäßig.
      this.setDisconnected();
    } finally {
      this.inFlight = false;
    }
  }

  private lastResult: RtStatusResult | undefined;

  private setStatus(r: RtStatusResult): void {
    this.lastResult = r;
    if (r.running) {
      this.item.text = '$(pulse) DSP';
      this.item.backgroundColor = undefined;
      this.item.tooltip = this.buildTooltip('Realtime-Server läuft', r.info);
    } else {
      this.item.text = '$(circle-slash) DSP aus';
      this.item.backgroundColor = undefined;
      this.item.tooltip = this.buildTooltip('Realtime-Server gestoppt', r.info);
    }
  }

  private setDisconnected(): void {
    this.lastResult = undefined;
    this.item.text = '$(debug-disconnect) CLAMPS';
    this.item.backgroundColor = undefined;
    this.item.tooltip = 'CLAMPS nicht verbunden';
  }

  private buildTooltip(headline: string, info: RtInfo[]): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${headline}**\n\n`);
    for (const i of info) {
      md.appendMarkdown(`- ${i.key}: \`${i.value}\`\n`);
    }
    return md;
  }

  /** Details als Meldung — für Nutzer, die Tooltips nicht mögen. */
  async showDetails(): Promise<void> {
    await this.refresh();
    const r = this.lastResult;
    if (!r) {
      vscode.window.showInformationMessage('CLAMPS ist nicht verbunden.');
      return;
    }
    const lines = r.info.map(i => `${i.key}: ${i.value}`).join(', ');
    vscode.window.showInformationMessage(
      `DSP ${r.running ? 'läuft' : 'aus'}${lines ? ' — ' + lines : ''}`
    );
  }

  dispose(): void {
    this.stop();
    this.item.dispose();
  }
}
