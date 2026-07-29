import * as vscode from 'vscode';
import { StickerPoller, StickerBatch, toDecibels } from './stickerPoll';

/**
 * Real-time levels.
 *
 * The first item on the roadmap that SLIME and SLY never had. It rests on
 * three parts that are all in place already: the allocation-free ring in
 * the audio thread (v81.11–v81.13), the RMS aggregation over a
 * decimation window (v81.13) and the incremental fetch cycle (v81.18).
 *
 * The display converts the peak value of a fetched block into dBFS. RMS
 * rings therefore show the louder edge of their course, which is the
 * right thing for a level meter: you want to see whether it is about to
 * clip, not the mean of the last second.
 */

interface MeterState {
  db: number;
  peakDb: number;
  peakAt: number;
  dropped: number;
  updatedAt: number;
}

export class MeterView {
  private static instance: MeterView | undefined;

  private readonly states = new Map<string, MeterState>();
  private readonly subscriptions: { dispose(): void }[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly poller: StickerPoller,
    private readonly listKeys: () => Promise<string[]>
  ) {
    panel.webview.html = MeterView.html();
    panel.onDidDispose(() => this.dispose());
    void this.refreshKeys();
    // The key list changes as soon as somebody registers a new ring.
    // Rare enough for a slow cycle.
    this.timer = setInterval(() => void this.refreshKeys(), 2000);
  }

  static show(
    poller: StickerPoller,
    listKeys: () => Promise<string[]>
  ): MeterView {
    if (this.instance) {
      this.instance.panel.reveal(vscode.ViewColumn.Beside, true);
      return this.instance;
    }
    const panel = vscode.window.createWebviewPanel(
      'clampsMeter',
      'CLAMPS: Pegel',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: false }
    );
    this.instance = new MeterView(panel, poller, listKeys);
    return this.instance;
  }

  /**
   * Subscribe to new rings, forget vanished ones. A ring that drops out
   * of the registry should not remain standing as a frozen bar — that
   * would look like a signal that is currently constant.
   */
  private async refreshKeys(): Promise<void> {
    let keys: string[];
    try {
      keys = await this.listKeys();
    } catch {
      return;
    }
    const known = new Set(this.poller.activeKeys());
    for (const key of keys) {
      if (known.has(key)) continue;
      this.subscriptions.push(
        this.poller.subscribe(key, (k, batch) => this.onBatch(k, batch))
      );
    }
    for (const key of [...this.states.keys()]) {
      if (!keys.includes(key)) this.states.delete(key);
    }
    this.render();
  }

  private onBatch(key: string, batch: StickerBatch): void {
    const now = Date.now();
    const previous = this.states.get(key);
    const peakSample = batch.values.reduce(
      (max, v) => Math.max(max, Math.abs(v)), 0
    );
    const db = toDecibels(peakSample);

    // The peak holds briefly and then falls, otherwise a short excursion
    // between two frames is never seen.
    let peakDb = db;
    let peakAt = now;
    if (previous && previous.peakDb > db && now - previous.peakAt < 1500) {
      peakDb = previous.peakDb;
      peakAt = previous.peakAt;
    }

    this.states.set(key, {
      db, peakDb, peakAt,
      dropped: (previous?.dropped ?? 0) + batch.dropped,
      updatedAt: now,
    });
    this.render();
  }

  private render(): void {
    const rows = [...this.states.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, state]) => ({
        key,
        db: state.db,
        peakDb: state.peakDb,
        dropped: state.dropped,
        stale: Date.now() - state.updatedAt > 2000,
      }));
    void this.panel.webview.postMessage({ rows });
  }

  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    for (const sub of this.subscriptions) sub.dispose();
    this.subscriptions.length = 0;
    this.states.clear();
    MeterView.instance = undefined;
  }

  private static html(): string {
    return `<!DOCTYPE html>
<html lang="de">
<head><meta charset="utf-8">
<style>
  body { font-family: var(--vscode-editor-font-family, monospace);
         font-size: 12px; padding: 10px;
         color: var(--vscode-foreground); }
  .row { margin-bottom: 10px; }
  .head { display: flex; justify-content: space-between; margin-bottom: 3px; }
  .key { font-weight: 600; }
  .value { opacity: .8; font-variant-numeric: tabular-nums; }
  .track { position: relative; height: 12px;
           background: var(--vscode-input-background); border-radius: 2px; }
  .bar { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 2px;
         background: var(--vscode-charts-green); }
  .bar.hot { background: var(--vscode-charts-red); }
  .peak { position: absolute; top: 0; bottom: 0; width: 2px;
          background: var(--vscode-foreground); opacity: .7; }
  .stale .bar { background: var(--vscode-descriptionForeground); }
  .warn { color: var(--vscode-charts-red); }
  .empty { opacity: .7; }
  code { background: var(--vscode-textCodeBlock-background); padding: 1px 4px; }
</style></head>
<body>
<div id="rows"></div>
<script>
  const FLOOR = -60;
  const fraction = db => Math.max(0, Math.min(1, (db - FLOOR) / -FLOOR));
  window.addEventListener('message', event => {
    const rows = event.data.rows || [];
    const host = document.getElementById('rows');
    if (rows.length === 0) {
      host.innerHTML =
        '<div class="empty">No ring registered.<br><br>' +
        '<code>(defparameter *meter-sticker* ' +
        '(clamps-bridge-rpc:make-sticker-sample-state-for-repl 256 441))</code><br>' +
        '<code>(clamps-bridge-rpc:register-sticker-state-for-repl "meter" *meter-sticker*)</code>' +
        '</div>';
      return;
    }
    host.innerHTML = rows.map(r => {
      const width = (fraction(r.db) * 100).toFixed(1);
      const peak = (fraction(r.peakDb) * 100).toFixed(1);
      const hot = r.db > -3 ? ' hot' : '';
      const stale = r.stale ? ' stale' : '';
      const drops = r.dropped > 0
        ? '<span class="warn"> · ' + r.dropped + ' verloren</span>' : '';
      const db = r.db <= FLOOR ? '−∞' : r.db.toFixed(1);
      return '<div class="row' + stale + '">' +
        '<div class="head"><span class="key">' + r.key + '</span>' +
        '<span class="value">' + db + ' dBFS' + drops + '</span></div>' +
        '<div class="track"><div class="bar' + hot + '" style="width:' + width + '%"></div>' +
        '<div class="peak" style="left:calc(' + peak + '% - 1px)"></div></div>' +
        '</div>';
    }).join('');
  });
</script>
</body></html>`;
  }
}
