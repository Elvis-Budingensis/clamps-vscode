import * as vscode from 'vscode';

/**
 * OSC monitor — what is arriving on a port, message by message.
 *
 * Built like the MIDI monitor, with one difference that runs through the
 * whole design: an OSC message carries its own TYPES, and they are half
 * the information.
 *
 * An integer 1 and a float 1.0 print alike and are not alike. A blob is
 * not a string. A receiver expecting "if" that gets "fi" fails without
 * saying so. So the type tag is shown next to the address and each value
 * carries its own type — a monitor that shows only the values answers the
 * easy half of the question and hides the half one opened it for.
 *
 * The address filter is a substring match rather than a channel picker,
 * because OSC namespaces are hierarchical: typing /synth narrows to a
 * subtree, which is how one actually looks for something in a patch that
 * sends on twenty addresses.
 */

export interface OscValue {
  type: string;
  text: string;
}

export interface OscEvent {
  time: number;
  address: string;
  typetag: string;
  values: OscValue[];
}

export interface OscBatch {
  available: boolean;
  error?: string;
  sequence: number;
  dropped: number;
  events: OscEvent[];
}

export type OscRequest = (since: number) => Promise<OscBatch | undefined>;
export type OscControl = (action: 'start' | 'stop', port: number)
  => Promise<{ ok: boolean; message: string } | undefined>;

/**
 * Colour for an OSC argument type.
 *
 * Numbers warm, text cool, blobs dim — the grouping follows what one scans
 * for. Integers and floats deliberately differ: telling them apart at a
 * glance is the single most useful thing this column does.
 */
export function typeColour(type: string): string {
  switch (type) {
    case 'int': return 'var(--vscode-charts-green)';
    case 'float': return 'var(--vscode-charts-orange)';
    case 'double': return 'var(--vscode-charts-red)';
    case 'string': return 'var(--vscode-charts-blue)';
    case 'blob': return 'var(--vscode-descriptionForeground)';
    default: return 'var(--vscode-foreground)';
  }
}

/**
 * Does an address match a filter?
 *
 * Case-insensitive substring, not a prefix: OSC namespaces are
 * hierarchical and one often remembers the leaf rather than the root.
 * Typing "freq" should find /synth/1/freq.
 */
export function addressMatches(address: string, filter: string): boolean {
  if (!filter) return true;
  return address.toLowerCase().includes(filter.toLowerCase());
}

/** A timestamp in seconds, or a dash. */
export function timeLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  return seconds.toFixed(3);
}

export class OscMonitorView {
  private static instance: OscMonitorView | undefined;
  private since = 0;
  private port: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight = false;
  private visible = true;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly request: OscRequest,
    private readonly control: OscControl,
    private readonly intervalMs: number,
    port: number
  ) {
    this.port = port;
    panel.webview.html = OscMonitorView.html(port);
    panel.webview.onDidReceiveMessage(m => this.onMessage(m));
    panel.onDidChangeViewState(e => { this.visible = e.webviewPanel.visible; });
    panel.onDidDispose(() => this.dispose());
    void this.begin();
  }

  static show(request: OscRequest, control: OscControl, intervalMs: number,
              port: number): OscMonitorView {
    if (this.instance) {
      this.instance.panel.reveal(vscode.ViewColumn.Beside, true);
      return this.instance;
    }
    const panel = vscode.window.createWebviewPanel(
      'clampsOscMonitor',
      'CLAMPS: OSC',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: false }
    );
    this.instance = new OscMonitorView(panel, request, control, intervalMs, port);
    return this.instance;
  }

  private async begin(): Promise<void> {
    const answer = await this.control('start', this.port);
    void this.panel.webview.postMessage({
      type: 'status',
      ok: answer?.ok ?? false,
      message: answer?.message ?? 'No answer from the image.',
    });
    if (this.timer === undefined) {
      this.timer = setInterval(() => void this.tick(), this.intervalMs);
    }
  }

  private onMessage(message: { type?: string; port?: number }): void {
    if (message.type === 'restart') {
      if (typeof message.port === 'number' && message.port > 0
          && message.port < 65536) {
        this.port = Math.round(message.port);
      }
      this.since = 0;
      void this.begin();
    }
  }

  private async tick(): Promise<void> {
    if (this.inFlight || !this.visible) return;
    this.inFlight = true;
    try {
      const batch = await this.request(this.since);
      if (!batch) return;
      if (batch.available) this.since = batch.sequence;
      void this.panel.webview.postMessage({ type: 'batch', batch });
    } catch {
      // A failed poll does not end the cycle.
    } finally {
      this.inFlight = false;
    }
  }

  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    void this.control('stop', this.port);
    OscMonitorView.instance = undefined;
  }

  private static html(port: number): string {
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family); font-size: 12px;
         padding: 8px; color: var(--vscode-foreground); }
  .bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
         margin-bottom: 6px; }
  button { background: var(--vscode-button-secondaryBackground);
           color: var(--vscode-button-secondaryForeground);
           border: none; padding: 2px 8px; cursor: pointer; font-size: 12px; }
  input { background: var(--vscode-input-background);
          color: var(--vscode-input-foreground);
          border: 1px solid var(--vscode-input-border, transparent);
          padding: 1px 5px; font-size: 12px; }
  input.port { width: 70px; }
  input.filter { width: 160px; }
  #log { font-family: var(--vscode-editor-font-family, monospace);
         font-variant-numeric: tabular-nums; font-size: 11px;
         height: 360px; overflow-y: auto;
         background: var(--vscode-input-background); border-radius: 3px;
         padding: 4px 6px; }
  .row { white-space: pre; }
  .t { color: var(--vscode-descriptionForeground); }
  .addr { color: var(--vscode-charts-purple); }
  .tag { color: var(--vscode-descriptionForeground); }
  .warn { color: var(--vscode-charts-red); margin-top: 4px; }
  .dim { opacity: .65; }
</style></head>
<body>
<div class="bar">
  <label class="dim">Port <input class="port" id="port" type="number" value="${port}"></label>
  <button id="restart">Listen</button>
  <label class="dim">Address <input class="filter" id="filter" placeholder="/synth"></label>
  <button id="clear">Clear</button>
  <span class="dim" id="count"></span>
</div>
<div id="log"></div>
<div class="warn" id="warn"></div>
<div class="dim" id="status"></div>
<script>
const vscode = acquireVsCodeApi();
const log = document.getElementById('log');
let filter = '';
let total = 0;
let droppedTotal = 0;

const typeColour = t => {
  switch (t) {
    case 'int': return 'var(--vscode-charts-green)';
    case 'float': return 'var(--vscode-charts-orange)';
    case 'double': return 'var(--vscode-charts-red)';
    case 'string': return 'var(--vscode-charts-blue)';
    case 'blob': return 'var(--vscode-descriptionForeground)';
    default: return 'var(--vscode-foreground)';
  }
};
const addressMatches = (a, f) =>
  !f || a.toLowerCase().includes(f.toLowerCase());
const escape = s => String(s).replace(/[<>&]/g, c =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

document.getElementById('filter').oninput = e => { filter = e.target.value; };
document.getElementById('clear').onclick = () => {
  log.innerHTML = ''; total = 0; droppedTotal = 0; updateCount();
};
document.getElementById('restart').onclick = () => {
  log.innerHTML = ''; total = 0; droppedTotal = 0; updateCount();
  vscode.postMessage({ type: 'restart',
                       port: Number(document.getElementById('port').value) });
};

function updateCount() {
  document.getElementById('count').textContent =
    total + ' message(s)' + (droppedTotal ? ', ' + droppedTotal + ' dropped' : '');
}

window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'status') {
    const host = document.getElementById('status');
    host.textContent = message.message;
    host.className = message.ok ? 'dim' : 'warn';
    return;
  }
  if (message.type !== 'batch') return;
  const batch = message.batch;
  if (!batch.available) {
    document.getElementById('warn').textContent = batch.error || '';
    return;
  }
  if (batch.dropped > 0) {
    droppedTotal += batch.dropped;
    document.getElementById('warn').textContent =
      batch.dropped + ' message(s) dropped — the ring is too small or the ' +
      'poll interval too long';
  }
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 30;
  for (const e of batch.events || []) {
    total++;
    if (!addressMatches(e.address, filter)) continue;
    const row = document.createElement('div');
    row.className = 'row';
    // The type tag stands next to the address, and every value carries its
    // own type. Without them an int and a float are the same line.
    const values = (e.values || []).map(v =>
      '<span style="color:' + typeColour(v.type) + '">' + escape(v.text) +
      '</span>').join('  ');
    row.innerHTML =
      '<span class="t">' + e.time.toFixed(3) + '</span>  ' +
      '<span class="addr">' + escape(e.address) + '</span> ' +
      '<span class="tag">' + (e.typetag ? ',' + escape(e.typetag) : '') +
      '</span>  ' + values;
    log.appendChild(row);
  }
  while (log.childElementCount > 2000) log.removeChild(log.firstChild);
  if (atBottom) log.scrollTop = log.scrollHeight;
  updateCount();
});
</script>
</body></html>`;
  }
}
