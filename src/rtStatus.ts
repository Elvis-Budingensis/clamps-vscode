// rtStatus.ts
//
// Shows in the status bar whether the Incudine realtime server is
// running.
//
// Why this is necessary: in rts-start/rts-stop CLAMPS sets a modeline
// label ("DSP ✓") via slynk:eval-in-emacs. Without an Emacs connection
// that call crashes, which is why it is a no-op in bootstrap.lisp — with
// the consequence that in VS Code there is no indication at all whether
// DSP is running. Instead of waiting for a push from the image (which
// does not exist without Emacs), we poll the state actively.

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
  // ReturnType rather than NodeJS.Timeout: works without @types/node too
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight = false;
  private getClient: () => LanguageClient | undefined;

  constructor(getClient: () => LanguageClient | undefined) {
    this.getClient = getClient;
    // Priority just below the language indicators so that it does not
    // end up far right among the also-rans.
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.command = 'clamps.rtStatusDetails';
    this.setDisconnected();
    this.item.show();
  }

  /** Starts polling. Interval via clamps.rtPollInterval (ms). */
  start(): void {
    this.stop();
    const interval = vscode.workspace
      .getConfiguration('clamps')
      .get<number>('rtPollInterval', 3000);
    if (interval <= 0) return; // 0 = polling off
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
    // Avoid overlapping requests: if the image hangs (long GC, RT
    // blocked), requests would otherwise pile up.
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
      // A failed poll is no reason for an error message — it happens
      // regularly during a restart.
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
      this.item.tooltip = this.buildTooltip('Realtime server running', r.info);
    } else {
      this.item.text = '$(circle-slash) DSP off';
      this.item.backgroundColor = undefined;
      this.item.tooltip = this.buildTooltip('Realtime-Server gestoppt', r.info);
    }
  }

  private setDisconnected(): void {
    this.lastResult = undefined;
    this.item.text = '$(debug-disconnect) CLAMPS';
    this.item.backgroundColor = undefined;
    this.item.tooltip = 'CLAMPS not connected';
  }

  private buildTooltip(headline: string, info: RtInfo[]): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${headline}**\n\n`);
    for (const i of info) {
      md.appendMarkdown(`- ${i.key}: \`${i.value}\`\n`);
    }
    return md;
  }

  /** Details as a message — for users who dislike tooltips. */
  async showDetails(): Promise<void> {
    await this.refresh();
    const r = this.lastResult;
    if (!r) {
      vscode.window.showInformationMessage('CLAMPS is not connected.');
      return;
    }
    const lines = r.info.map(i => `${i.key}: ${i.value}`).join(', ');
    vscode.window.showInformationMessage(
      `DSP ${r.running ? 'running' : 'off'}${lines ? ' — ' + lines : ''}`
    );
  }

  dispose(): void {
    this.stop();
    this.item.dispose();
  }
}
