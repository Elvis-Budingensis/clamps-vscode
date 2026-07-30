import * as vscode from 'vscode';

/**
 * Buffer viewer — the waveform of an Incudine buffer, with zoom.
 *
 * The reduction happens in the image (see buffer-outline-for-repl): three
 * numbers per drawn column, minimum, maximum and RMS. An eight-minute
 * recording is twenty million samples and this canvas is eight hundred
 * pixels wide; whatever were transferred, almost all of it would be thrown
 * away here.
 *
 * Two decisions about the drawing are worth stating, because both look
 * like details and neither is:
 *
 * MIN AND MAX, NOT MAX. Reducing a waveform by its maximum — the way the
 * spectrum reduces — loses the lower half, and a symmetric signal comes
 * out as a one-sided envelope. It still looks like a waveform, which is
 * what makes the mistake durable. With both, a DC offset is visible as an
 * envelope that does not straddle zero, and that is one of the few things
 * a waveform view is actually for.
 *
 * PEAK AND RMS TOGETHER. The envelope says how far the signal reaches, the
 * RMS says how loud it is, and the gap between them is the dynamic range.
 * A compressed passage and a loud one have the same envelope and different
 * bodies; with only the envelope drawn they are indistinguishable.
 *
 * Zooming re-requests rather than scaling the picture. Scaling would
 * enlarge the reduction, not the signal — and at some magnification one
 * would be looking at an interpolation of an envelope and believing it to
 * be samples.
 */

export interface BufferOutline {
  available: boolean;
  error?: string;
  frames: number;
  channels: number;
  sampleRate: number;
  duration: number;
  start: number;
  end: number;
  columns: number;
  channel: number;
  peak: number;
  rms: number;
  clipped: number;
  warnings: string[];
  values: number[][];
}

export type BufferRequest = (params: {
  expr: string;
  package: string;
  start: number;
  end: number;
  columns: number;
  channel: number;
}) => Promise<BufferOutline | undefined>;

/**
 * A new range after zooming by FACTOR around ANCHOR (0..1 of the visible
 * range). Works in fractional frames and does NOT round.
 *
 * The not-rounding is the fix, and it took two attempts to find. The creep
 * does not come from the zoom arithmetic but from feeding its rounded
 * result back into the next call: each step lands on a whole frame, the
 * error is small, and it accumulates. Measured with rounding inside: 479
 * frames adrift after ten steps in and ten out, and with discrete zoom
 * levels still 3 frames after one cycle growing to 24 after eight. Three
 * frames looks like rounding; that it GROWS is what makes it a bug.
 *
 * So the view keeps its range as fractional frames and rounds once, at the
 * moment of the request. Nothing rounded ever feeds back.
 *
 * A range that creeps sideways is a perfectly good waveform at every
 * single moment — only the sequence is wrong, and no screenshot shows it.
 * Found by the gate; there was no other way to find it.
 */
export function zoomRange(
  start: number,
  end: number,
  frames: number,
  factor: number,
  anchor: number
): { start: number; end: number } {
  const total = Math.max(1, frames);
  const span = Math.max(1e-9, Math.min(total, end - start));
  const focus = start + span * Math.max(0, Math.min(1, anchor));
  const relative = (focus - start) / span;

  // At least sixteen frames: below that there is nothing left to reduce,
  // and a request would ask for columns that cannot be filled.
  const wanted = Math.max(Math.min(16, total), Math.min(total, span / (factor || 1)));
  let from = focus - wanted * relative;
  from = Math.max(0, Math.min(total - wanted, from));
  return { start: from, end: from + wanted };
}

/** A frame position as a readable time, or as frames when no rate is known. */
export function timeLabel(frame: number, sampleRate: number): string {
  if (!(sampleRate > 0)) return `${Math.round(frame)}`;
  const seconds = frame / sampleRate;
  if (seconds < 1) return `${(seconds * 1000).toFixed(1)} ms`;
  if (seconds < 60) return `${seconds.toFixed(3)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds - minutes * 60).toFixed(2).padStart(5, '0')}`;
}

interface ViewState {
  expr: string;
  package: string;
  start: number;
  end: number;
  columns: number;
  channel: number;
}

export class BufferView {
  private static instance: BufferView | undefined;
  private state: ViewState;
  private inFlight = false;
  private frames = 0;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly request: BufferRequest,
    expr: string,
    pkg: string
  ) {
    this.state = { expr, package: pkg, start: 0, end: -1, columns: 800, channel: 0 };
    panel.webview.html = BufferView.html(expr);
    panel.webview.onDidReceiveMessage(m => this.onMessage(m));
    panel.onDidDispose(() => { BufferView.instance = undefined; });
    void this.refresh();
  }

  static show(request: BufferRequest, expr: string, pkg: string): BufferView {
    if (this.instance) {
      this.instance.panel.reveal(vscode.ViewColumn.Beside, true);
      this.instance.state = {
        expr, package: pkg, start: 0, end: -1,
        columns: this.instance.state.columns, channel: 0,
      };
      void this.instance.panel.webview.postMessage({ type: 'expr', expr });
      void this.instance.refresh();
      return this.instance;
    }
    const panel = vscode.window.createWebviewPanel(
      'clampsBufferView',
      'CLAMPS: Buffer',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.instance = new BufferView(panel, request, expr, pkg);
    return this.instance;
  }

  private onMessage(message: {
    type?: string; factor?: number; anchor?: number;
    columns?: number; channel?: number; by?: number;
  }): void {
    switch (message.type) {
      case 'zoom': {
        if (this.frames <= 0) return;
        const end = this.state.end < 0 ? this.frames : this.state.end;
        const next = zoomRange(this.state.start, end, this.frames,
                               message.factor ?? 2, message.anchor ?? 0.5);
        this.state.start = next.start;
        this.state.end = next.end;
        void this.refresh();
        break;
      }
      case 'pan': {
        if (this.frames <= 0) return;
        const end = this.state.end < 0 ? this.frames : this.state.end;
        const span = end - this.state.start;
        const shift = Math.round(span * (message.by ?? 0));
        const from = Math.max(0, Math.min(this.frames - span, this.state.start + shift));
        this.state.start = from;
        this.state.end = from + span;
        void this.refresh();
        break;
      }
      case 'all':
        this.state.start = 0;
        this.state.end = -1;
        void this.refresh();
        break;
      case 'channel':
        if (typeof message.channel === 'number') {
          this.state.channel = message.channel;
          void this.refresh();
        }
        break;
      case 'columns':
        if (typeof message.columns === 'number' && Number.isFinite(message.columns)) {
          const next = Math.max(16, Math.min(4096, Math.round(message.columns)));
          if (next !== this.state.columns) {
            this.state.columns = next;
            void this.refresh();
          }
        }
        break;
      case 'refresh':
        void this.refresh();
        break;
    }
  }

  /**
   * Fetch and draw.
   *
   * Single in flight, as everywhere: a buffer read is linear in the range,
   * so a zoom-out over a long recording is not instant, and queued
   * requests would leave the view drawing ranges the user has left behind.
   */
  private async refresh(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const outline = await this.request({
        ...this.state,
        // Rounded HERE and nowhere else. A rounded value that flows back
        // into the next zoom is what makes a range creep.
        start: Math.round(this.state.start),
        end: this.state.end < 0 ? -1 : Math.round(this.state.end),
      });
      if (!outline) return;
      if (outline.available) {
        this.frames = outline.frames;
        // Adopt the answer only where it says something the view did not
        // know: the very first request asks for the whole buffer without
        // knowing its length. Adopting it every time would feed the
        // rounded values back in through the other door.
        if (this.state.end < 0) {
          this.state.start = outline.start;
          this.state.end = outline.end;
        }
      }
      void this.panel.webview.postMessage({ type: 'outline', outline });
    } catch {
      // The session may be restarting; leave the picture standing.
    } finally {
      this.inFlight = false;
    }
  }

  private static html(expr: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family); font-size: 12px;
         padding: 8px; color: var(--vscode-foreground); }
  .bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
         margin-bottom: 6px; }
  button { background: var(--vscode-button-secondaryBackground);
           color: var(--vscode-button-secondaryForeground);
           border: none; padding: 2px 8px; cursor: pointer; font-size: 12px; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; }
  canvas { width: 100%; height: 260px; display: block;
           background: var(--vscode-input-background); border-radius: 3px; }
  .readout { margin-top: 5px; font-family: var(--vscode-editor-font-family, monospace);
             font-variant-numeric: tabular-nums; }
  .dim { opacity: .65; }
  .warn { color: var(--vscode-charts-red); margin-top: 4px; }
</style></head>
<body>
<div class="bar">
  <code id="expr">${expr.replace(/[<>&"]/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] || c))}</code>
  <button id="all">Whole buffer</button>
  <button id="out">Zoom out</button>
  <button id="in">Zoom in</button>
  <button id="left">&#8592;</button>
  <button id="right">&#8594;</button>
  <label class="dim">Channel <select id="channel"></select></label>
  <button id="reload">Reload</button>
</div>
<canvas id="wave"></canvas>
<div class="readout" id="readout"></div>
<div class="warn" id="warn"></div>
<script>
const vscode = acquireVsCodeApi();
const canvas = document.getElementById('wave');
const context = canvas.getContext('2d');
let outline = null;
let cursor = null;

const timeLabel = (frame, rate) => {
  if (!(rate > 0)) return String(Math.round(frame));
  const s = frame / rate;
  if (s < 1) return (s * 1000).toFixed(1) + ' ms';
  if (s < 60) return s.toFixed(3) + ' s';
  const m = Math.floor(s / 60);
  return m + ':' + (s - m * 60).toFixed(2).padStart(5, '0');
};
const style = name =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

document.getElementById('all').onclick = () => vscode.postMessage({ type: 'all' });
document.getElementById('in').onclick = () =>
  vscode.postMessage({ type: 'zoom', factor: 2, anchor: 0.5 });
document.getElementById('out').onclick = () =>
  vscode.postMessage({ type: 'zoom', factor: 0.5, anchor: 0.5 });
document.getElementById('left').onclick = () =>
  vscode.postMessage({ type: 'pan', by: -0.5 });
document.getElementById('right').onclick = () =>
  vscode.postMessage({ type: 'pan', by: 0.5 });
document.getElementById('reload').onclick = () => vscode.postMessage({ type: 'refresh' });
document.getElementById('channel').onchange = e =>
  vscode.postMessage({ type: 'channel', channel: Number(e.target.value) });

// Zooming towards the pointer, not towards the middle: when looking for a
// click one has it under the cursor, not in the centre.
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const anchor = (e.clientX - canvas.getBoundingClientRect().left)
               / (canvas.clientWidth || 1);
  vscode.postMessage({ type: 'zoom', factor: e.deltaY < 0 ? 1.6 : 1 / 1.6, anchor });
}, { passive: false });

canvas.addEventListener('mousemove', e => {
  cursor = e.clientX - canvas.getBoundingClientRect().left;
  readout();
});
canvas.addEventListener('mouseleave', () => { cursor = null; readout(); });

function resize() {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round((canvas.clientWidth || 600) * ratio);
  canvas.height = Math.round((canvas.clientHeight || 260) * ratio);
  vscode.postMessage({ type: 'columns', columns: canvas.width });
  draw();
}
window.addEventListener('resize', resize);

function draw() {
  const w = canvas.width, h = canvas.height;
  context.clearRect(0, 0, w, h);
  if (!outline || !outline.available) return;
  const values = outline.values || [];
  const n = values.length;
  if (n === 0) return;
  const mid = h / 2;
  const scale = mid * 0.95;

  // Zero line and the +-1 marks: without them the envelope has no scale
  // and a signal at half amplitude looks like one at full.
  context.strokeStyle = style('--vscode-panel-border') || '#8884';
  context.globalAlpha = .5;
  for (const level of [-1, -0.5, 0, 0.5, 1]) {
    const y = mid - level * scale;
    context.beginPath();
    context.moveTo(0, y + .5); context.lineTo(w, y + .5); context.stroke();
  }
  context.globalAlpha = 1;

  const colour = style('--vscode-charts-blue') || '#4aa3ff';
  const columnWidth = w / n;
  // Envelope first, RMS on top: the gap between them is the dynamic range.
  context.fillStyle = colour;
  context.globalAlpha = .5;
  for (let i = 0; i < n; i++) {
    const [lo, hi] = values[i];
    const y0 = mid - hi * scale, y1 = mid - lo * scale;
    context.fillRect(i * columnWidth, y0, Math.max(1, columnWidth),
                     Math.max(1, y1 - y0));
  }
  context.globalAlpha = 1;
  for (let i = 0; i < n; i++) {
    const rms = values[i][2];
    const y0 = mid - rms * scale, y1 = mid + rms * scale;
    context.fillRect(i * columnWidth, y0, Math.max(1, columnWidth),
                     Math.max(1, y1 - y0));
  }

  if (cursor !== null) {
    const x = cursor * (window.devicePixelRatio || 1);
    context.strokeStyle = style('--vscode-foreground') || '#fff';
    context.globalAlpha = .4;
    context.beginPath();
    context.moveTo(x + .5, 0); context.lineTo(x + .5, h); context.stroke();
    context.globalAlpha = 1;
  }
}

function readout() {
  const host = document.getElementById('readout');
  if (!outline || !outline.available) { host.textContent = ''; return; }
  const parts = [];
  const span = outline.end - outline.start;
  parts.push('<span class="dim">' +
    timeLabel(outline.start, outline.sampleRate) + ' \\u2013 ' +
    timeLabel(outline.end, outline.sampleRate) + ' of ' +
    timeLabel(outline.frames, outline.sampleRate) + '</span>');
  const dB = v => v > 0 ? (20 * Math.log10(v)).toFixed(1) + ' dBFS' : '-inf';
  parts.push('peak ' + dB(outline.peak) + ' \\u00B7 RMS ' + dB(outline.rms));
  if (cursor !== null && span > 0) {
    const fraction = cursor / (canvas.clientWidth || 1);
    const frame = outline.start + fraction * span;
    parts.push('<span class="dim">cursor: ' +
      timeLabel(frame, outline.sampleRate) + ' \\u00B7 frame ' +
      Math.round(frame) + '</span>');
  }
  host.innerHTML = parts.join(' &nbsp; ');
}

window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'expr') {
    document.getElementById('expr').textContent = message.expr;
    return;
  }
  if (message.type !== 'outline') return;
  outline = message.outline;
  if (!outline.available) {
    document.getElementById('warn').textContent = outline.error || '';
    context.clearRect(0, 0, canvas.width, canvas.height);
    document.getElementById('readout').textContent = '';
    return;
  }
  const select = document.getElementById('channel');
  if (select.options.length !== outline.channels) {
    select.innerHTML = Array.from({ length: outline.channels }, (_, i) =>
      '<option value="' + i + '">' + (i + 1) + '</option>').join('');
  }
  select.value = String(outline.channel);
  document.getElementById('warn').innerHTML =
    (outline.warnings || []).map(w => '\\u26A0 ' + w).join('<br>');
  draw();
  readout();
});

resize();
</script>
</body></html>`;
  }
}
