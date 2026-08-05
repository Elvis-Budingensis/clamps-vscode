import * as vscode from 'vscode';

/**
 * Scheduler status — how full the event queue is and how far ahead it
 * reaches.
 *
 * Not a timeline of individual events, and the reason belongs here rather
 * than in a commit message: Incudine exposes no synchronised way to
 * enumerate what is pending. Walking the heap would need four internal
 * symbols while the audio thread reorders it underneath, and the result
 * would place events at wrong times occasionally while looking entirely
 * convincing. A view that is right most of the time is worse than one that
 * shows less and is always right.
 *
 * What the exported functions do give is scalar and exact:
 *
 *   count / capacity  — how full the heap is. This is the figure that
 *                       decides whether a piece can be scheduled at all: a
 *                       MIDI file with more events than the heap holds
 *                       fails silently, and *rt-edf-heap-size* is where
 *                       that is raised.
 *   now               — the transport position in samples, and in seconds.
 *
 * NEXT-TIME and LAST-TIME are absent by measurement, not by caution.
 * Scheduling events changes HEAP-COUNT as expected while NEXT-TIME stays at
 * the same value, across new events and across FLUSH-PENDING; its magnitude
 * does not relate to NOW by the sample rate either. Reported anyway, it put
 * a countdown of "17579:24.3" beside an event due in five seconds.
 */

export interface SchedulerStatus {
  available: boolean;
  error?: string;
  now: number;
  count: number;
  capacity: number;
  sampleRate: number;
  warnings: string[];
}

export type SchedulerRequest = () => Promise<SchedulerStatus | undefined>;

/**
 * Seconds from a sample distance.
 *
 * Returns null rather than 0 when the rate is unknown: a duration of zero
 * and an unknown duration look alike on screen, and only one of them means
 * "about to happen".
 */
export function samplesToSeconds(samples: number, sampleRate: number)
  : number | null {
  if (!(sampleRate > 0) || !Number.isFinite(samples)) return null;
  return samples / sampleRate;
}

/**
 * A time distance as text.
 *
 * Milliseconds below a second, because the interesting range for "when
 * does the next event fire" is usually short.
 */
export function distanceLabel(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  if (seconds < 0) return '—';
  if (seconds < 1) return `${(seconds * 1000).toFixed(1)} ms`;
  if (seconds < 60) return `${seconds.toFixed(2)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds - minutes * 60).toFixed(1).padStart(4, '0')}`;
}

/**
 * Is a reported time a real time, or the zero that means "nothing there"?
 *
 * NEXT-TIME and LAST-TIME return 0 for an absent event. At the very start
 * of a session that is indistinguishable from a genuine time near zero, so
 * the count decides — and the display must not show "0.0 ms until the next
 * event" for an empty queue, which would read as "right now".
 */
export function hasPendingTime(count: number, time: number): boolean {
  return count > 0 && time > 0;
}

/** Fill fraction of the heap, 0..1. */
export function heapFraction(count: number, capacity: number): number {
  if (!(capacity > 0)) return 0;
  return Math.max(0, Math.min(1, count / capacity));
}

/**
 * Colour for the heap gauge.
 *
 * The threshold is not decoration. Beyond about four fifths a longer piece
 * is at risk of not fitting, and the failure mode is silent: events past
 * the end of the heap are simply not scheduled.
 */
export function gaugeColour(fraction: number): string {
  if (fraction >= 0.8) return 'var(--vscode-charts-red)';
  if (fraction >= 0.5) return 'var(--vscode-charts-orange)';
  return 'var(--vscode-charts-green)';
}

export class SchedulerView {
  private static instance: SchedulerView | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight = false;
  private visible = true;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly request: SchedulerRequest,
    private readonly intervalMs: number
  ) {
    panel.webview.html = SchedulerView.html();
    panel.onDidChangeViewState(e => { this.visible = e.webviewPanel.visible; });
    panel.onDidDispose(() => this.dispose());
    this.timer = setInterval(() => void this.tick(), intervalMs);
    void this.tick();
  }

  static show(request: SchedulerRequest, intervalMs: number): SchedulerView {
    if (this.instance) {
      this.instance.panel.reveal(vscode.ViewColumn.Beside, true);
      return this.instance;
    }
    const panel = vscode.window.createWebviewPanel(
      'clampsScheduler',
      'CLAMPS: Scheduler',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: false }
    );
    this.instance = new SchedulerView(panel, request, intervalMs);
    return this.instance;
  }

  private async tick(): Promise<void> {
    if (this.inFlight || !this.visible) return;
    this.inFlight = true;
    try {
      const status = await this.request();
      if (!status) return;
      void this.panel.webview.postMessage({ type: 'status', status });
    } catch {
      // A failed poll does not end the cycle; the session may be restarting.
    } finally {
      this.inFlight = false;
    }
  }

  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    SchedulerView.instance = undefined;
  }

  private static html(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family); font-size: 12px;
         padding: 8px; color: var(--vscode-foreground); }
  .figures { display: flex; gap: 24px; margin-bottom: 10px;
             font-variant-numeric: tabular-nums; }
  .figure .label { opacity: .6; font-size: 11px; }
  .figure .value { font-size: 20px;
                   font-family: var(--vscode-editor-font-family, monospace); }
  .gauge { height: 10px; border-radius: 2px; margin-bottom: 10px;
           background: var(--vscode-input-background); overflow: hidden; }
  .gauge div { height: 100%; width: 0; transition: width .2s; }
  canvas { width: 100%; height: 160px; display: block;
           background: var(--vscode-input-background); border-radius: 3px; }
  .dim { opacity: .65; margin-top: 6px; }
  .warn { color: var(--vscode-charts-red); margin-top: 4px; }
  .note { opacity: .55; margin-top: 10px; font-size: 11px; line-height: 1.5; }
</style></head>
<body>
<div class="figures">
  <div class="figure"><div class="label">Pending</div>
    <div class="value" id="count">—</div></div>
  <div class="figure"><div class="label">Heap</div>
    <div class="value" id="heap">—</div></div>
</div>
<div class="gauge"><div id="bar"></div></div>
<canvas id="history"></canvas>
<div class="dim" id="axis"></div>
<div class="warn" id="warn"></div>
<div class="note">
  Read inside the realtime thread. Individual pending events and a countdown
  to the next one are not shown — Incudine offers no dependable way to read
  either.
</div>
<script>
const vscode = acquireVsCodeApi();
const canvas = document.getElementById('history');
const context = canvas.getContext('2d');
const history = [];
const HISTORY = 300;

const distanceLabel = s => {
  if (s === null || !isFinite(s) || s < 0) return '\\u2014';
  if (s < 1) return (s * 1000).toFixed(1) + ' ms';
  if (s < 60) return s.toFixed(2) + ' s';
  const m = Math.floor(s / 60);
  return m + ':' + (s - m * 60).toFixed(1).padStart(4, '0');
};
const gaugeColour = f =>
  f >= 0.8 ? 'var(--vscode-charts-red)'
  : f >= 0.5 ? 'var(--vscode-charts-orange)'
  : 'var(--vscode-charts-green)';
const style = n =>
  getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function resize() {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round((canvas.clientWidth || 600) * ratio);
  canvas.height = Math.round((canvas.clientHeight || 160) * ratio);
  draw();
}
window.addEventListener('resize', resize);

function draw() {
  const w = canvas.width, h = canvas.height;
  context.clearRect(0, 0, w, h);
  if (history.length < 2) return;
  // The scale follows the capacity, not the maximum seen: the question the
  // curve answers is how close the queue is to overflowing, and a curve
  // rescaled to its own peak always looks alarming.
  const capacity = Math.max(1, history[history.length - 1].capacity);
  const step = w / HISTORY;
  context.strokeStyle = style('--vscode-panel-border') || '#8884';
  context.globalAlpha = .4;
  for (const level of [0.25, 0.5, 0.75, 1]) {
    const y = h - level * h;
    context.beginPath(); context.moveTo(0, y); context.lineTo(w, y); context.stroke();
  }
  context.globalAlpha = 1;
  context.strokeStyle = style('--vscode-charts-blue') || '#4aa3ff';
  context.lineWidth = 1.5 * (window.devicePixelRatio || 1);
  context.beginPath();
  history.forEach((point, i) => {
    const x = w - (history.length - 1 - i) * step;
    const y = h - Math.max(0, Math.min(1, point.count / capacity)) * h;
    i === 0 ? context.moveTo(x, y) : context.lineTo(x, y);
  });
  context.stroke();
}

window.addEventListener('message', event => {
  const message = event.data;
  if (message.type !== 'status') return;
  const s = message.status;
  if (!s.available) {
    document.getElementById('warn').textContent = s.error || '';
    for (const id of ['count', 'heap']) {
      document.getElementById(id).textContent = '\\u2014';
    }
    return;
  }
  const rate = s.sampleRate > 0 ? s.sampleRate : null;
  const toSeconds = samples => rate ? samples / rate : null;

  document.getElementById('count').textContent = s.count;
  document.getElementById('heap').textContent =
    s.count + ' / ' + s.capacity;

  const fraction = s.capacity > 0 ? Math.min(1, s.count / s.capacity) : 0;
  const bar = document.getElementById('bar');
  bar.style.width = (fraction * 100) + '%';
  bar.style.background = gaugeColour(fraction);

  document.getElementById('axis').textContent =
    rate ? Math.round(rate) + ' Hz \\u00B7 now ' + Math.round(s.now) + ' samples'
         : 'sample rate unknown';
  document.getElementById('warn').innerHTML =
    (s.warnings || []).map(x => '\\u26A0 ' + x).join('<br>');

  history.push({ count: s.count, capacity: s.capacity });
  while (history.length > HISTORY) history.shift();
  draw();
});

resize();
</script>
</body></html>`;
  }
}
