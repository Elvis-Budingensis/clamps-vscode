import * as vscode from 'vscode';

/**
 * ATS browser — tracked partials over time.
 *
 * The difference from the spectrogram is not the picture but what is
 * behind it. A spectrogram shows a grid of bins and leaves the partials
 * to the eye; an ATS analysis already knows them, each with its own
 * frequency and amplitude trajectory. So this view can do the one thing a
 * spectrogram cannot: single a partial out and follow it, alone, with its
 * own numbers.
 *
 * That is also why the drawing is deliberately not a spectrogram's. A
 * partial is a LINE, not a smear of bins, and drawing it as a line makes
 * visible what matters in a tracked analysis: where a partial begins and
 * ends, where the tracker lost it and picked it up again somewhere else,
 * whether a supposed glissando is one trajectory or two.
 *
 * Residual noise, where the file carries it, is drawn underneath in its
 * 25 critical bands — separately and dimmer, because it is a different
 * kind of thing. Mixing the two into one picture would suggest that a
 * noise band and a partial are comparable objects, which is precisely
 * what ATS separates.
 */

export interface AtsPartial {
  index: number;
  peak: number;
  meanFrequency: number;
  frequencies: number[];
  levels: number[];
}

export interface AtsOutline {
  available: boolean;
  error?: string;
  sampleRate: number;
  frameSize: number;
  windowSize: number;
  partialCount: number;
  frameCount: number;
  maxAmplitude: number;
  maxFrequency: number;
  duration: number;
  type: number;
  columns: number;
  shown: number;
  hasPhase: number;
  hasNoise: number;
  warnings: string[];
  partials: AtsPartial[];
  noise: number[][];
}

export type AtsRequest = (params: {
  path: string;
  columns: number;
  maxPartials: number;
  floorDb: number;
}) => Promise<AtsOutline | undefined>;

/** Playback goes through the image, never through the extension. */
export type AtsPlayer = (action: 'play' | 'stop', path: string)
  => Promise<{ ok: boolean; message: string } | undefined>;

/**
 * The upper edges of the 25 critical bands, in hertz.
 *
 * The standard Bark scale, which is what ATS uses for its residual noise.
 * Written out rather than approximated: an earlier version spaced the
 * bands logarithmically between 20 Hz and the maximum frequency, which is
 * close enough to look right and wrong everywhere in particular. The Bark
 * scale is near-linear below 500 Hz and only then turns logarithmic, so a
 * purely logarithmic guess squeezes the low bands and stretches the high
 * ones — and the noise would then be drawn beside the partials it belongs
 * to.
 */
export const BARK_EDGES = [
  100, 200, 300, 400, 510, 630, 770, 920, 1080, 1270, 1480, 1720, 2000,
  2320, 2700, 3150, 3700, 4400, 5300, 6400, 7700, 9500, 12000, 15500, 20000,
];

/** Lower and upper edge of critical band INDEX, in hertz. */
export function barkBand(index: number): { low: number; high: number } {
  const i = Math.max(0, Math.min(BARK_EDGES.length - 1, Math.round(index)));
  return { low: i === 0 ? 0 : BARK_EDGES[i - 1], high: BARK_EDGES[i] };
}

/**
 * Describes an ATS type in words.
 *
 * The numbers 1 to 4 say nothing to anyone who has not just read the
 * format description, and which of them a file is decides what can be
 * seen in it — noise or not, phase or not.
 */
export function atsTypeLabel(type: number): string {
  switch (type) {
    case 1: return 'type 1 — amplitude and frequency';
    case 2: return 'type 2 — amplitude, frequency and phase';
    case 3: return 'type 3 — amplitude and frequency, with residual noise';
    case 4: return 'type 4 — amplitude, frequency and phase, with residual noise';
    default: return `type ${type} — unknown`;
  }
}

/**
 * The frequency resolution the analysis had, in hertz.
 *
 * Worth stating next to the picture: partials closer together than this
 * cannot have been separated by the analysis, so two lines that nearly
 * touch may be one partial the tracker split, and a line that looks
 * isolated may be two it merged. The window length is what decides that,
 * and it is in the file.
 */
export function analysisResolution(sampleRate: number, windowSize: number): number {
  if (!(sampleRate > 0) || !(windowSize > 0)) return 0;
  return sampleRate / windowSize;
}

/** Seconds per drawn column. */
export function secondsPerColumn(duration: number, columns: number): number {
  if (!(columns > 0)) return 0;
  return duration / columns;
}

export class AtsView {
  private static instance: AtsView | undefined;
  private path: string;
  private columns = 400;
  private maxPartials = 128;
  private inFlight = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly request: AtsRequest,
    private readonly player: AtsPlayer,
    path: string
  ) {
    this.path = path;
    panel.webview.html = AtsView.html(path);
    panel.webview.onDidReceiveMessage(m => this.onMessage(m));
    panel.onDidDispose(() => { AtsView.instance = undefined; });
    void this.refresh();
  }

  static show(request: AtsRequest, player: AtsPlayer, path: string): AtsView {
    if (this.instance) {
      this.instance.panel.reveal(vscode.ViewColumn.Beside, true);
      this.instance.path = path;
      void this.instance.panel.webview.postMessage({ type: 'path', path });
      void this.instance.refresh();
      return this.instance;
    }
    const panel = vscode.window.createWebviewPanel(
      'clampsAtsView',
      'CLAMPS: ATS',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.instance = new AtsView(panel, request, player, path);
    return this.instance;
  }

  private onMessage(message: {
    type?: string; columns?: number; maxPartials?: number;
  }): void {
    if (message.type === 'columns' && typeof message.columns === 'number') {
      const next = Math.max(8, Math.min(2048, Math.round(message.columns)));
      if (next !== this.columns) { this.columns = next; void this.refresh(); }
    } else if (message.type === 'partials' && typeof message.maxPartials === 'number') {
      this.maxPartials = Math.max(1, Math.min(512, Math.round(message.maxPartials)));
      void this.refresh();
    } else if (message.type === 'refresh') {
      void this.refresh();
    } else if (message.type === 'play' || message.type === 'stop') {
      void this.transport(message.type);
    }
  }

  /**
   * Start or stop playback, and report the answer in the panel.
   *
   * The message is shown whether it succeeded or not. On failure it names
   * the functions that were searched for, which is the only thing that
   * helps: the resynthesis lives in ats-cuda or in CLAMPS's own wrappers
   * and its name differs between versions, so "not available" alone would
   * leave nothing to act on.
   */
  private async transport(action: 'play' | 'stop'): Promise<void> {
    try {
      const answer = await this.player(action, this.path);
      void this.panel.webview.postMessage({
        type: 'transport',
        ok: answer?.ok ?? false,
        message: answer?.message ?? 'No answer from the image.',
      });
    } catch (e) {
      void this.panel.webview.postMessage({
        type: 'transport', ok: false, message: String(e),
      });
    }
  }

  private async refresh(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const outline = await this.request({
        path: this.path,
        columns: this.columns,
        maxPartials: this.maxPartials,
        floorDb: -96,
      });
      if (!outline) return;
      void this.panel.webview.postMessage({ type: 'outline', outline });
    } catch {
      // The session may be restarting; leave the picture standing.
    } finally {
      this.inFlight = false;
    }
  }

  private static html(path: string): string {
    const escaped = path.replace(/[<>&"]/g, c =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] || c));
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family); font-size: 12px;
         padding: 8px; color: var(--vscode-foreground); }
  .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
         margin-bottom: 6px; }
  code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; }
  button { background: var(--vscode-button-secondaryBackground);
           color: var(--vscode-button-secondaryForeground);
           border: none; padding: 2px 8px; cursor: pointer; font-size: 12px; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .transport { margin-top: 4px; font-size: 11px; }
  .transport.bad { color: var(--vscode-charts-red); }
  select { background: var(--vscode-dropdown-background);
           color: var(--vscode-dropdown-foreground);
           border: 1px solid var(--vscode-dropdown-border); font-size: 12px; }
  canvas { width: 100%; height: 320px; display: block;
           background: var(--vscode-input-background); border-radius: 3px; }
  .readout { margin-top: 5px; font-family: var(--vscode-editor-font-family, monospace);
             font-variant-numeric: tabular-nums; }
  .dim { opacity: .65; }
  .warn { color: var(--vscode-charts-red); margin-top: 4px; }
</style></head>
<body>
<div class="bar">
  <code id="path">${escaped}</code>
  <label class="dim">Partials <select id="maxPartials">
    <option>16</option><option>32</option><option>64</option>
    <option selected>128</option><option>256</option><option>512</option>
  </select></label>
  <label class="dim">Axis <select id="axis">
    <option value="log">log</option><option value="lin">linear</option>
  </select></label>
  <label class="dim"><input type="checkbox" id="noise" checked> Residual noise</label>
  <button id="play">\u25B6 Play</button>
  <button id="stop">\u25A0 Stop</button>
</div>
<canvas id="ats"></canvas>
<div class="readout" id="readout"></div>
<div class="dim" id="info"></div>
<div class="warn" id="warn"></div>
<div class="transport" id="transport"></div>
<script>
const vscode = acquireVsCodeApi();
const canvas = document.getElementById('ats');
const context = canvas.getContext('2d');
let outline = null;
let axis = 'log';
let showNoise = true;
let cursor = null;
let selected = -1;
const BARK = [100,200,300,400,510,630,770,920,1080,1270,1480,1720,2000,2320,2700,3150,3700,4400,5300,6400,7700,9500,12000,15500,20000];

const style = n =>
  getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const fMin = () => 20;
const fMax = () => Math.max(100, outline ? outline.maxFrequency : 20000);
const yOf = freq => {
  const h = canvas.height;
  if (axis === 'log') {
    if (freq <= 0) return h;
    const t = Math.log(freq / fMin()) / Math.log(fMax() / fMin());
    return h - Math.max(0, Math.min(1, t)) * h;
  }
  return h - Math.max(0, Math.min(1, freq / fMax())) * h;
};
const freqAt = y => {
  const h = canvas.height;
  const t = Math.max(0, Math.min(1, 1 - y / h));
  return axis === 'log'
    ? fMin() * Math.pow(fMax() / fMin(), t)
    : t * fMax();
};
const noteName = freq => {
  if (!isFinite(freq) || freq <= 0) return '';
  const midi = 69 + 12 * Math.log2(freq / 440);
  const nearest = Math.round(midi);
  if (nearest < 0 || nearest > 127) return '';
  const names = ['C','C\\u266F','D','D\\u266F','E','F','F\\u266F','G','G\\u266F','A','A\\u266F','B'];
  const cents = Math.round((midi - nearest) * 100);
  const sign = cents > 0 ? '+' : cents < 0 ? '\\u2212' : '\\u00B1';
  return names[((nearest % 12) + 12) % 12] + (Math.floor(nearest / 12) - 1) +
    ' ' + sign + Math.abs(cents) + ' ct';
};

document.getElementById('maxPartials').onchange = e =>
  vscode.postMessage({ type: 'partials', maxPartials: Number(e.target.value) });
document.getElementById('axis').onchange = e => { axis = e.target.value; draw(); };
document.getElementById('noise').onchange = e => { showNoise = e.target.checked; draw(); };
document.getElementById('play').onclick = () => vscode.postMessage({ type: 'play' });
document.getElementById('stop').onclick = () => vscode.postMessage({ type: 'stop' });

canvas.addEventListener('mousemove', e => {
  const r = canvas.getBoundingClientRect();
  cursor = { x: e.clientX - r.left, y: e.clientY - r.top };
  pick();
  draw();
  readout();
});
canvas.addEventListener('mouseleave', () => { cursor = null; selected = -1; draw(); readout(); });

// The partial nearest the pointer, and only if it is genuinely near: a
// selection that snaps to something metres away would claim a reading the
// picture does not support.
function pick() {
  selected = -1;
  if (!outline || !cursor || !outline.partials.length) return;
  const ratio = window.devicePixelRatio || 1;
  const n = outline.columns;
  const column = Math.max(0, Math.min(n - 1,
    Math.floor((cursor.x / (canvas.clientWidth || 1)) * n)));
  const y = cursor.y * ratio;
  let best = -1, bestDistance = 24 * ratio;
  outline.partials.forEach((p, i) => {
    const level = p.levels[column];
    if (level <= -96) return;
    const distance = Math.abs(yOf(p.frequencies[column]) - y);
    if (distance < bestDistance) { bestDistance = distance; best = i; }
  });
  selected = best;
}

function resize() {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round((canvas.clientWidth || 600) * ratio);
  canvas.height = Math.round((canvas.clientHeight || 320) * ratio);
  vscode.postMessage({ type: 'columns', columns: Math.round(canvas.width / 2) });
  draw();
}
window.addEventListener('resize', resize);

function draw() {
  const w = canvas.width, h = canvas.height;
  context.clearRect(0, 0, w, h);
  if (!outline || !outline.available) return;
  const n = outline.columns;
  const columnWidth = w / n;

  // Frequency grid.
  context.strokeStyle = style('--vscode-panel-border') || '#8884';
  context.fillStyle = style('--vscode-descriptionForeground') || '#888';
  context.font = (10 * (window.devicePixelRatio || 1)) + 'px sans-serif';
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    if (f > fMax()) break;
    const y = yOf(f);
    context.globalAlpha = .3;
    context.beginPath(); context.moveTo(0, y); context.lineTo(w, y); context.stroke();
    context.globalAlpha = .8;
    context.fillText(f >= 1000 ? (f / 1000) + 'k' : String(f), 3, y - 2);
  }
  context.globalAlpha = 1;

  // Residual noise underneath, dimmer: it is a different kind of thing
  // from a partial, and the picture should not suggest otherwise.
  if (showNoise && outline.noise && outline.noise.length) {
    const bands = outline.noise.length;
    context.fillStyle = style('--vscode-charts-purple') || '#a06cd5';
    for (let b = 0; b < bands; b++) {
      const values = outline.noise[b];
      // The real Bark edges, not a logarithmic guess: the scale is
      // near-linear below 500 Hz and only then turns logarithmic, so a
      // guessed spacing draws the noise beside the partials it belongs to.
      const low = b === 0 ? 0 : BARK[b - 1];
      const high = BARK[b];
      // A band that lies entirely above the axis is SKIPPED, not squashed
      // against the top edge. yOf clamps, so without this every band from
      // the file's highest frequency up to 20 kHz collapsed onto the same
      // line, was inflated to a minimum height of one pixel, and stacked
      // its opacity there — a bright bar along the top of every picture,
      // made of bands the file says nothing about.
      if (low >= fMax()) continue;
      const y0 = yOf(Math.min(high, fMax()));
      const y1 = yOf(Math.max(low, fMin()));
      const height = y1 - y0;
      if (height <= 0) continue;
      for (let c = 0; c < n; c++) {
        const level = values[c];
        if (level <= -96) continue;
        const t = Math.max(0, Math.min(1, (level + 96) / 96));
        // Dimmer than before. The noise is context for the partials, not a
        // second subject: at 0.35 it washed them out, and the view that
        // exists to follow one partial could not show one.
        context.globalAlpha = 0.18 * t * t;
        context.fillRect(c * columnWidth, y0, Math.max(1, columnWidth), height);
      }
    }
    context.globalAlpha = 1;
  }

  // Partials as lines. Brightness follows the level, so a partial fading
  // out fades out rather than stopping abruptly.
  outline.partials.forEach((p, i) => {
    const isSelected = i === selected;
    context.strokeStyle = isSelected
      ? (style('--vscode-charts-orange') || '#e8a33d')
      : (style('--vscode-charts-blue') || '#4aa3ff');
    context.lineWidth = (isSelected ? 2.5 : 1.2) * (window.devicePixelRatio || 1);
    let drawing = false;
    for (let c = 0; c < n; c++) {
      const level = p.levels[c];
      const x = c * columnWidth + columnWidth / 2;
      if (level <= -96 || p.frequencies[c] <= 0) {
        // A gap is a gap: where the tracker had no partial, no line is
        // drawn. Joining across it would invent a trajectory.
        if (drawing) { context.stroke(); drawing = false; }
        continue;
      }
      context.globalAlpha = isSelected ? 1 : Math.max(0.15, (level + 96) / 96);
      if (!drawing) { context.beginPath(); context.moveTo(x, yOf(p.frequencies[c])); drawing = true; }
      else context.lineTo(x, yOf(p.frequencies[c]));
    }
    if (drawing) context.stroke();
  });
  context.globalAlpha = 1;

  if (cursor) {
    const x = cursor.x * (window.devicePixelRatio || 1);
    context.strokeStyle = style('--vscode-foreground') || '#fff';
    context.globalAlpha = .35; context.lineWidth = 1;
    context.beginPath(); context.moveTo(x, 0); context.lineTo(x, h); context.stroke();
    context.globalAlpha = 1;
  }
}

function readout() {
  const host = document.getElementById('readout');
  if (!outline || !outline.available) { host.textContent = ''; return; }
  const parts = [];
  if (cursor) {
    const n = outline.columns;
    const column = Math.max(0, Math.min(n - 1,
      Math.floor((cursor.x / (canvas.clientWidth || 1)) * n)));
    const time = column * (outline.duration / n);
    parts.push('<span class="dim">' + time.toFixed(3) + ' s</span>');
    if (selected >= 0) {
      const p = outline.partials[selected];
      const f = p.frequencies[column];
      const note = noteName(f);
      parts.push('<b>partial ' + p.index + '</b>: ' + f.toFixed(1) + ' Hz' +
        (note ? ' \\u00B7 ' + note : '') + ' \\u00B7 ' +
        p.levels[column].toFixed(1) + ' dB');
    } else {
      const f = freqAt(cursor.y * (window.devicePixelRatio || 1));
      parts.push('<span class="dim">' + f.toFixed(1) + ' Hz</span>');
    }
  }
  host.innerHTML = parts.join(' &nbsp; ');
}

window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'path') {
    document.getElementById('path').textContent = message.path;
    return;
  }
  if (message.type === 'transport') {
    const host = document.getElementById('transport');
    host.textContent = message.message;
    host.className = 'transport' + (message.ok ? ' dim' : ' bad');
    return;
  }
  if (message.type !== 'outline') return;
  outline = message.outline;
  if (!outline.available) {
    document.getElementById('warn').textContent = outline.error || '';
    document.getElementById('info').textContent = '';
    context.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const resolution = outline.windowSize > 0
    ? outline.sampleRate / outline.windowSize : 0;
  document.getElementById('info').innerHTML =
    outline.shown + ' of ' + outline.partialCount + ' partials \\u00B7 ' +
    outline.frameCount + ' frames \\u00B7 ' + outline.duration.toFixed(3) + ' s \\u00B7 ' +
    (outline.duration / outline.columns * 1000).toFixed(1) + ' ms per column \\u00B7 ' +
    'analysis window ' + outline.windowSize + ' samples' +
    (resolution ? ' (' + resolution.toFixed(1) + ' Hz resolution)' : '');
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
