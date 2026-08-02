import * as vscode from 'vscode';

/**
 * MIDI monitor — what is arriving, message by message.
 *
 * The one question this exists to answer is "is anything coming in, and
 * what". Everything about the design follows from that being a question
 * asked in a hurry, usually while something is not working.
 *
 * Hence a LOG, not a plot. When a controller misbehaves one wants the
 * messages themselves, in order, with their times — not a curve from which
 * the messages would have to be inferred. There is a thin activity strip
 * per channel above it, because "which of the sixteen channels is this
 * thing on" is the second question and a colour answers it faster than
 * reading.
 *
 * And hence the counter of dropped messages. A monitor that silently loses
 * events is worse than no monitor: it answers "nothing arrived" when the
 * truth is that sixty arrived and were discarded, and that answer sends the
 * user to check cables that are fine.
 */

export interface MidiEvent {
  time: number;
  status: number;
  kind: string;
  channel: number;
  label: string;
  detail: string;
  value: number;
}

export interface MidiBatch {
  available: boolean;
  error?: string;
  sequence: number;
  dropped: number;
  events: MidiEvent[];
}

export type MidiRequest = (since: number) => Promise<MidiBatch | undefined>;
export type MidiControl = (action: 'start' | 'stop')
  => Promise<{ ok: boolean; message: string } | undefined>;

/**
 * Colour for a message kind.
 *
 * Grouped by what one looks for: notes stand out, continuous controllers
 * are quieter, clock and active sensing are almost invisible. That last
 * point is not decoration — a running clock is 24 messages per beat, so at
 * 120 bpm it is 48 a second, and given equal weight it buries everything
 * else. The alternative would be to hide it, but then "is the clock
 * running" becomes unanswerable.
 */
export function kindColour(kind: string): string {
  switch (kind) {
    case 'note-on': return 'var(--vscode-charts-green)';
    case 'note-off': return 'var(--vscode-charts-blue)';
    case 'control-change': return 'var(--vscode-charts-orange)';
    case 'pitch-bend': return 'var(--vscode-charts-purple)';
    case 'program-change': return 'var(--vscode-charts-yellow)';
    case 'poly-pressure':
    case 'channel-pressure': return 'var(--vscode-charts-red)';
    case 'clock':
    case 'active-sensing': return 'var(--vscode-descriptionForeground)';
    default: return 'var(--vscode-foreground)';
  }
}

/**
 * Is this message noise for the purposes of a filter?
 *
 * Clock and active sensing arrive continuously and say nothing about what
 * a player did. They are hidden by default and shown on request, because
 * both questions are real: what is being played, and whether the clock is
 * running.
 */
export function isTransportNoise(kind: string): boolean {
  return kind === 'clock' || kind === 'active-sensing';
}

/** A timestamp as seconds since the monitor started, or a dash. */
export function timeLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  return seconds.toFixed(3);
}

export class MidiMonitorView {
  private static instance: MidiMonitorView | undefined;
  private since = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight = false;
  private visible = true;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly request: MidiRequest,
    private readonly control: MidiControl,
    private readonly intervalMs: number
  ) {
    panel.webview.html = MidiMonitorView.html();
    panel.webview.onDidReceiveMessage(m => this.onMessage(m));
    panel.onDidChangeViewState(e => { this.visible = e.webviewPanel.visible; });
    panel.onDidDispose(() => this.dispose());
    void this.begin();
  }

  static show(request: MidiRequest, control: MidiControl, intervalMs: number)
    : MidiMonitorView {
    if (this.instance) {
      this.instance.panel.reveal(vscode.ViewColumn.Beside, true);
      return this.instance;
    }
    const panel = vscode.window.createWebviewPanel(
      'clampsMidiMonitor',
      'CLAMPS: MIDI',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: false }
    );
    this.instance = new MidiMonitorView(panel, request, control, intervalMs);
    return this.instance;
  }

  private async begin(): Promise<void> {
    const answer = await this.control('start');
    void this.panel.webview.postMessage({
      type: 'status',
      ok: answer?.ok ?? false,
      message: answer?.message ?? 'No answer from the image.',
    });
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  private onMessage(message: { type?: string }): void {
    if (message.type === 'restart') {
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
      // A failed poll does not end the cycle; the session may be
      // restarting. `since` stays where it was, so nothing is skipped.
    } finally {
      this.inFlight = false;
    }
  }

  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    void this.control('stop');
    MidiMonitorView.instance = undefined;
  }

  private static html(): string {
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
  .channels { display: flex; gap: 2px; margin-bottom: 6px; }
  .ch { flex: 1; height: 14px; border-radius: 2px; text-align: center;
        font-size: 9px; line-height: 14px;
        background: var(--vscode-input-background);
        color: var(--vscode-descriptionForeground); }
  #log { font-family: var(--vscode-editor-font-family, monospace);
         font-variant-numeric: tabular-nums; font-size: 11px;
         height: 340px; overflow-y: auto;
         background: var(--vscode-input-background); border-radius: 3px;
         padding: 4px 6px; }
  .row { white-space: pre; }
  .t { color: var(--vscode-descriptionForeground); }
  .warn { color: var(--vscode-charts-red); margin-top: 4px; }
  .dim { opacity: .65; }
</style></head>
<body>
<div class="bar">
  <label class="dim"><input type="checkbox" id="transport"> Show clock and sensing</label>
  <label class="dim">Channel <select id="filter">
    <option value="0">all</option>
  </select></label>
  <button id="clear">Clear</button>
  <button id="restart">Restart</button>
  <span class="dim" id="count"></span>
</div>
<div class="channels" id="channels"></div>
<div id="log"></div>
<div class="warn" id="warn"></div>
<div class="dim" id="status"></div>
<script>
const vscode = acquireVsCodeApi();
const log = document.getElementById('log');
let showTransport = false;
let channelFilter = 0;
let total = 0;
let droppedTotal = 0;
const lastSeen = new Array(17).fill(0);

const kindColour = kind => {
  switch (kind) {
    case 'note-on': return 'var(--vscode-charts-green)';
    case 'note-off': return 'var(--vscode-charts-blue)';
    case 'control-change': return 'var(--vscode-charts-orange)';
    case 'pitch-bend': return 'var(--vscode-charts-purple)';
    case 'program-change': return 'var(--vscode-charts-yellow)';
    case 'poly-pressure':
    case 'channel-pressure': return 'var(--vscode-charts-red)';
    case 'clock':
    case 'active-sensing': return 'var(--vscode-descriptionForeground)';
    default: return 'var(--vscode-foreground)';
  }
};
const isTransportNoise = k => k === 'clock' || k === 'active-sensing';

const select = document.getElementById('filter');
for (let c = 1; c <= 16; c++) {
  const option = document.createElement('option');
  option.value = String(c);
  option.textContent = String(c);
  select.appendChild(option);
}
select.onchange = e => { channelFilter = Number(e.target.value); };
document.getElementById('transport').onchange = e => { showTransport = e.target.checked; };
document.getElementById('clear').onclick = () => {
  log.innerHTML = ''; total = 0; droppedTotal = 0; updateCount();
};
document.getElementById('restart').onclick = () => vscode.postMessage({ type: 'restart' });

const channels = document.getElementById('channels');
for (let c = 1; c <= 16; c++) {
  const box = document.createElement('div');
  box.className = 'ch';
  box.id = 'ch' + c;
  box.textContent = String(c);
  channels.appendChild(box);
}

function updateCount() {
  document.getElementById('count').textContent =
    total + ' message(s)' + (droppedTotal ? ', ' + droppedTotal + ' dropped' : '');
}

// The activity strip fades rather than blinking: a light that goes on and
// off at MIDI rates is a flicker, one that decays shows which channel was
// busy a moment ago.
setInterval(() => {
  const now = Date.now();
  for (let c = 1; c <= 16; c++) {
    const age = now - lastSeen[c];
    const box = document.getElementById('ch' + c);
    if (age > 1200) { box.style.background = ''; continue; }
    box.style.background = 'color-mix(in srgb, var(--vscode-charts-green) ' +
      Math.round(100 * (1 - age / 1200)) + '%, var(--vscode-input-background))';
  }
}, 100);

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
    // Named, not swallowed. A monitor that loses events silently answers
    // "nothing arrived" when the truth is that many arrived and were thrown
    // away — and sends the user to check cables that are fine.
    document.getElementById('warn').textContent =
      batch.dropped + ' message(s) dropped — the ring is too small or the ' +
      'poll interval too long';
  }
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 30;
  for (const e of batch.events || []) {
    total++;
    if (e.channel >= 1 && e.channel <= 16) lastSeen[e.channel] = Date.now();
    if (!showTransport && isTransportNoise(e.kind)) continue;
    if (channelFilter && e.channel !== channelFilter) continue;
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML =
      '<span class="t">' + e.time.toFixed(3) + '</span>  ' +
      '<span class="t">' + (e.channel ? ('ch' + String(e.channel).padStart(2, ' ')) : '  --') + '</span>  ' +
      '<span style="color:' + kindColour(e.kind) + '">' +
      e.label.padEnd(16, ' ') + '</span>' + e.detail;
    log.appendChild(row);
  }
  // Cap the log: a dense stream fills a browser's memory in minutes, and
  // nobody scrolls back through ten thousand clock ticks.
  while (log.childElementCount > 2000) log.removeChild(log.firstChild);
  // Follow only when already at the bottom, so that scrolling back to read
  // something is not undone by the next message.
  if (atBottom) log.scrollTop = log.scrollHeight;
  updateCount();
});
</script>
</body></html>`;
  }
}
