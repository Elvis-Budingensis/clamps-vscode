import * as vscode from 'vscode';

/**
 * Freq scope — real-time spectrum of a sticker ring.
 *
 * The model is SuperCollider's FreqScope: logarithmic frequency axis,
 * decibels vertically, one frame every few dozen milliseconds. The
 * difference lies underneath. SuperCollider puts the analysis buffer in
 * shared memory, which the display reads directly; here an LSP
 * connection sits in between, over which every number travels as text.
 *
 * From this follows the one decision that really matters here: the FFT
 * runs in Lisp (sticker-spectrum-for-repl), and what is transferred is
 * one number per drawn column. The counter-proposal — fetch samples and
 * compute in the webview — would need, at 1024 points and 20 frames per
 * second, 20480 values per second down the wire, and that regardless of
 * how fast the ring is filled, because the windows overlap. This way it
 * is 256 numbers per frame, whether the analysis uses 512 or 8192
 * points.
 *
 * The second difference from the level meter: here nothing is fetched
 * incrementally. A spectroscope does not want the increment but the
 * present state; every frame needs the same window again, only shifted
 * along a little. The StickerPoller with its sequence number is the
 * wrong tool for that, so this view drives its own cycle — with the same
 * discipline: only ever one query in flight, otherwise the requests pile
 * up and the picture runs further and further behind.
 */

export interface SpectrumFrame {
  available: boolean;
  error?: string;
  sampleRate: number;
  effectiveRate: number;
  fftSize: number;
  mode: string;
  fMin: number;
  fMax: number;
  floorDb: number;
  peakFreq: number;
  peakDb: number;
  binWidth: number;
  warnings: string[];
  values: number[];
}

export type SpectrumRequest = (params: {
  key: string;
  fftSize: number;
  window: string;
  columns: number;
  mode: string;
  floorDb: number;
}) => Promise<SpectrumFrame | undefined>;

export type RingLister = () => Promise<
  { key: string; capacity: number; decimation: number; elementType: string }[]
>;

/** Note name with cent deviation, e.g. "A4 +3 ct".
 *
 *  For a spectrum in a composition environment, hertz is half the
 *  answer: anyone checking whether a partial lies where it should would
 *  otherwise convert by hand every time. */
export function noteName(freq: number): string {
  if (!Number.isFinite(freq) || freq <= 0) return '';
  const midi = 69 + 12 * Math.log2(freq / 440);
  const nearest = Math.round(midi);
  if (nearest < 0 || nearest > 127) return '';
  const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const cents = Math.round((midi - nearest) * 100);
  const octave = Math.floor(nearest / 12) - 1;
  const sign = cents > 0 ? '+' : cents < 0 ? '−' : '±';
  return `${names[((nearest % 12) + 12) % 12]}${octave} ${sign}${Math.abs(cents)} ct`;
}

/**
 * Peak hold with fall.
 *
 * At 20 frames per second there are 50 ms between two pictures; a short
 * transient falls exactly in between and would otherwise never be seen.
 * The held value falls at a fixed rate so that after a minute the
 * display does not consist of nothing but all-time highs.
 */
export function applyFall(
  previousDb: number | undefined,
  nextDb: number,
  fallDbPerSecond: number,
  dtMs: number,
  floorDb: number
): number {
  if (previousDb === undefined || !Number.isFinite(previousDb)) {
    return Math.max(floorDb, nextDb);
  }
  const fallen = previousDb - fallDbPerSecond * (dtMs / 1000);
  return Math.max(floorDb, Math.max(nextDb, fallen));
}

/**
 * Frequency at column edge INDEX of COLUMNS.
 *
 * Must be character for character the same computation as
 * %spectrum-edge in rpc.lisp. If the two drift apart the picture is
 * still right — only the grid lines and the readout under the mouse
 * pointer end up in the wrong place, and that is not something you can
 * see in a spectrum.
 */
export function columnFrequency(
  index: number,
  columns: number,
  fMin: number,
  fMax: number,
  mode: string
): number {
  const fraction = index / columns;
  return mode === 'log'
    ? fMin * Math.pow(fMax / fMin, fraction)
    : fMin + fraction * (fMax - fMin);
}

/** The inverse of columnFrequency: horizontal fraction 0..1. */
export function frequencyFraction(
  freq: number,
  fMin: number,
  fMax: number,
  mode: string
): number {
  if (mode === 'log') {
    if (fMin <= 0 || fMax <= fMin || freq <= 0) return 0;
    return Math.log(freq / fMin) / Math.log(fMax / fMin);
  }
  if (fMax <= fMin) return 0;
  return (freq - fMin) / (fMax - fMin);
}

/** Vertical fraction 0..1 from a dB value; 0 dB at the top, FLOOR at the bottom. */
export function dbFraction(db: number, floorDb: number, ceilDb = 0): number {
  if (ceilDb <= floorDb) return 0;
  if (!Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(1, (db - floorDb) / (ceilDb - floorDb)));
}

interface ScopeSettings {
  key: string;
  fftSize: number;
  window: string;
  mode: string;
  floorDb: number;
  columns: number;
}

export class FreqScopeView {
  private static instance: FreqScopeView | undefined;

  private settings: ScopeSettings;
  private timer: ReturnType<typeof setInterval> | undefined;
  private keyTimer: ReturnType<typeof setInterval> | undefined;
  private inFlight = false;
  private visible = true;
  private lastKeys = '';

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly request: SpectrumRequest,
    private readonly listRings: RingLister,
    private readonly intervalMs: number,
    fftSize: number
  ) {
    this.settings = {
      key: '',
      fftSize,
      window: 'hann',
      mode: 'log',
      floorDb: -96,
      columns: 256,
    };

    panel.webview.html = FreqScopeView.html(this.settings, intervalMs);
    panel.webview.onDidReceiveMessage(message => this.onMessage(message));
    panel.onDidChangeViewState(event => {
      // A hidden window does not need 20 FFTs per second. This is not
      // polish: the computation runs in the Lisp image, that is, exactly
      // where the composing is happening.
      this.visible = event.webviewPanel.visible;
    });
    panel.onDidDispose(() => this.dispose());

    void this.refreshKeys();
    this.keyTimer = setInterval(() => void this.refreshKeys(), 2000);
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  static show(
    request: SpectrumRequest,
    listRings: RingLister,
    intervalMs: number,
    fftSize: number
  ): FreqScopeView {
    if (this.instance) {
      this.instance.panel.reveal(vscode.ViewColumn.Beside, true);
      return this.instance;
    }
    const panel = vscode.window.createWebviewPanel(
      'clampsFreqScope',
      'CLAMPS: Spektrum',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: false }
    );
    this.instance = new FreqScopeView(panel, request, listRings, intervalMs, fftSize);
    return this.instance;
  }

  private onMessage(message: { type?: string; field?: string; value?: unknown }): void {
    if (message?.type !== 'set' || !message.field) return;
    const value = message.value;
    switch (message.field) {
      case 'key':
        if (typeof value === 'string') this.settings.key = value;
        break;
      case 'fftSize':
        if (typeof value === 'number') {
          this.settings.fftSize = value;
          // A ring that was big enough for 1024 is not for 4096, so the
          // list has to be judged again. Clearing lastKeys forces it.
          this.lastKeys = '';
          void this.refreshKeys();
        }
        break;
      case 'window':
        if (typeof value === 'string') this.settings.window = value;
        break;
      case 'mode':
        if (typeof value === 'string') this.settings.mode = value;
        break;
      case 'floorDb':
        if (typeof value === 'number') this.settings.floorDb = value;
        break;
      case 'columns':
        // The display says how wide it is and gets exactly that many
        // values. The amount of data therefore depends on the window
        // width in pixels — not on sample rate or FFT length.
        if (typeof value === 'number' && Number.isFinite(value)) {
          this.settings.columns = Math.max(16, Math.min(1024, Math.round(value)));
        }
        break;
    }
  }

  /**
   * Why a ring cannot carry a spectrum, or undefined if it can.
   *
   * A decimated ring is the trap worth naming: without a pre-filter,
   * decimation folds everything above half the effective rate back down,
   * where it stands like a genuine partial. That cannot be undone, so it
   * must be visible rather than silently accepted. And a level meter ring
   * — decimation 441, capacity 256 — is exactly what is already lying
   * around in a session, so it is also the ring somebody will try first.
   */
  private static unusableBecause(
    ring: { capacity: number; decimation: number; elementType: string },
    fftSize: number
  ): string | undefined {
    if (ring.elementType !== 'double-float') return 'not a sample ring';
    if (ring.decimation > 1) return `decimated \u00d7${ring.decimation}`;
    if (ring.capacity < fftSize) return `holds ${ring.capacity}, needs ${fftSize}`;
    return undefined;
  }

  /**
   * Refresh the ring list.
   *
   * Unusable rings stay in the list, marked with the reason. Hiding them
   * would be worse: the ring is there, the user registered it, and an
   * empty list would say "nothing found" where the truth is "found, but
   * it cannot do this". The reason belongs next to the name, because it
   * also says what to change.
   */
  private async refreshKeys(): Promise<void> {
    let rings: Awaited<ReturnType<RingLister>>;
    try {
      rings = await this.listRings();
    } catch {
      return;
    }
    const classified = rings.map(r => ({
      ...r,
      unusable: FreqScopeView.unusableBecause(r, this.settings.fftSize),
    }));
    const serialised = JSON.stringify(classified);
    if (serialised === this.lastKeys) return;
    this.lastKeys = serialised;

    const usable = classified.filter(r => r.unusable === undefined);
    if (!classified.some(r => r.key === this.settings.key && !r.unusable)) {
      // A usable ring is preferred over one that only exists. Falling
      // back to any ring at all is deliberate: the resulting error names
      // the reason, which is more useful than an empty selector.
      this.settings.key = (usable[0] ?? classified[0])?.key ?? '';
    }
    void this.panel.webview.postMessage({
      type: 'rings',
      rings: classified,
      selected: this.settings.key,
      anyUsable: usable.length > 0,
      fftSize: this.settings.fftSize,
    });
  }

  private async tick(): Promise<void> {
    if (this.inFlight || !this.visible || !this.settings.key) return;
    this.inFlight = true;
    try {
      const frame = await this.request({ ...this.settings });
      if (!frame) return;
      void this.panel.webview.postMessage({ type: 'frame', frame });
    } catch {
      // A failed query does not end the cycle — the session may be
      // restarting.
    } finally {
      this.inFlight = false;
    }
  }

  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    if (this.keyTimer !== undefined) clearInterval(this.keyTimer);
    this.timer = undefined;
    this.keyTimer = undefined;
    FreqScopeView.instance = undefined;
  }

  private static html(settings: ScopeSettings, intervalMs: number): string {
    return `<!DOCTYPE html>
<html lang="de">
<head><meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family); font-size: 12px;
         padding: 8px; color: var(--vscode-foreground); }
  .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
         margin-bottom: 6px; }
  label { opacity: .8; }
  select { background: var(--vscode-dropdown-background);
           color: var(--vscode-dropdown-foreground);
           border: 1px solid var(--vscode-dropdown-border);
           font-size: 12px; padding: 1px 3px; }
  #canvasHost { position: relative; }
  canvas { width: 100%; height: 300px; display: block;
           background: var(--vscode-input-background); border-radius: 3px; }
  .readout { margin-top: 5px; font-family: var(--vscode-editor-font-family, monospace);
             font-variant-numeric: tabular-nums; }
  .peak { font-weight: 600; }
  .dim { opacity: .65; }
  .warn { color: var(--vscode-charts-red); margin-top: 4px; }
  .empty { opacity: .75; margin-top: 10px; line-height: 1.7; }
  code { background: var(--vscode-textCodeBlock-background); padding: 1px 4px; }
</style></head>
<body>
<div class="bar">
  <label>Ring <select id="key"></select></label>
  <label>FFT <select id="fftSize">
    <option>256</option><option>512</option><option>1024</option>
    <option>2048</option><option>4096</option><option>8192</option>
  </select></label>
  <label>Window <select id="window">
    <option value="hann">Hann</option>
    <option value="blackman-harris">Blackman-Harris</option>
    <option value="rect">Rectangular</option>
  </select></label>
  <label>Axis <select id="mode">
    <option value="log">log</option><option value="lin">linear</option>
  </select></label>
  <label>Range <select id="floorDb">
    <option value="-48">48 dB</option><option value="-72">72 dB</option>
    <option value="-96">96 dB</option><option value="-120">120 dB</option>
  </select></label>
</div>
<div id="canvasHost"><canvas id="scope"></canvas></div>
<div class="readout" id="readout"></div>
<div class="warn" id="warn"></div>
<div class="empty" id="empty"></div>
<script>
const vscode = acquireVsCodeApi();
const canvas = document.getElementById('scope');
const context = canvas.getContext('2d');
const FALL_DB_PER_SECOND = 24;
const INTERVAL = ${intervalMs};

let frame = null;
let hold = [];
let lastFrameAt = 0;
let cursorX = null;
let settings = ${JSON.stringify(settings)};

// --- Helper computations, identical to freqScope.ts and rpc.lisp -----
const columnFrequency = (index, columns, fMin, fMax, mode) => {
  const fraction = index / columns;
  return mode === 'log'
    ? fMin * Math.pow(fMax / fMin, fraction)
    : fMin + fraction * (fMax - fMin);
};
const frequencyFraction = (freq, fMin, fMax, mode) => {
  if (mode === 'log') {
    if (fMin <= 0 || fMax <= fMin || freq <= 0) return 0;
    return Math.log(freq / fMin) / Math.log(fMax / fMin);
  }
  return fMax <= fMin ? 0 : (freq - fMin) / (fMax - fMin);
};
const dbFraction = (db, floorDb) =>
  Math.max(0, Math.min(1, (db - floorDb) / (0 - floorDb)));
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
const style = name =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// --- Steuerelemente ---------------------------------------------------
const send = (field, value) => {
  settings[field] = value;
  hold = [];
  vscode.postMessage({ type: 'set', field, value });
};
document.getElementById('key').addEventListener('change', e => send('key', e.target.value));
document.getElementById('fftSize').addEventListener('change', e => send('fftSize', Number(e.target.value)));
document.getElementById('window').addEventListener('change', e => send('window', e.target.value));
document.getElementById('mode').addEventListener('change', e => send('mode', e.target.value));
document.getElementById('floorDb').addEventListener('change', e => send('floorDb', Number(e.target.value)));
document.getElementById('fftSize').value = String(settings.fftSize);
document.getElementById('window').value = settings.window;
document.getElementById('mode').value = settings.mode;
document.getElementById('floorDb').value = String(settings.floorDb);

canvas.addEventListener('mousemove', e => {
  cursorX = e.clientX - canvas.getBoundingClientRect().left;
  draw();
});
canvas.addEventListener('mouseleave', () => { cursorX = null; draw(); });

// --- Groesse ----------------------------------------------------------
function resize() {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 600;
  const height = canvas.clientHeight || 300;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  // As many columns as pixels: more would be invisible, fewer visibly
  // coarse.
  vscode.postMessage({ type: 'set', field: 'columns', value: Math.round(width) });
  draw();
}
window.addEventListener('resize', resize);

// --- Zeichnen ---------------------------------------------------------
function gridFrequencies(fMin, fMax, mode) {
  const out = [];
  if (mode === 'log') {
    for (const decade of [10, 100, 1000, 10000]) {
      for (const step of [1, 2, 5]) {
        const f = decade * step;
        if (f >= fMin && f <= fMax) out.push({ f, label: f >= 1000 ? (f / 1000) + 'k' : String(f) });
      }
    }
  } else {
    const stepHz = fMax > 20000 ? 5000 : 2000;
    for (let f = stepHz; f <= fMax; f += stepHz) {
      out.push({ f, label: (f / 1000) + 'k' });
    }
  }
  return out;
}

function draw() {
  const width = canvas.clientWidth || 600;
  const height = canvas.clientHeight || 300;
  context.clearRect(0, 0, width, height);
  if (!frame || !frame.available) return;

  const floorDb = frame.floorDb;
  const values = frame.values || [];
  const count = values.length;
  if (count === 0) return;

  // Gitter
  context.strokeStyle = style('--vscode-panel-border') || '#8884';
  context.fillStyle = style('--vscode-descriptionForeground') || '#8888';
  context.lineWidth = 1;
  context.font = '10px var(--vscode-font-family)';
  for (let db = 0; db >= floorDb; db -= 12) {
    const y = height - dbFraction(db, floorDb) * height;
    context.globalAlpha = .35;
    context.beginPath();
    context.moveTo(0, y + .5); context.lineTo(width, y + .5); context.stroke();
    context.globalAlpha = .8;
    if (db < 0) context.fillText(db + ' dB', 3, y - 2);
  }
  for (const line of gridFrequencies(frame.fMin, frame.fMax, frame.mode)) {
    const x = frequencyFraction(line.f, frame.fMin, frame.fMax, frame.mode) * width;
    context.globalAlpha = .35;
    context.beginPath();
    context.moveTo(x + .5, 0); context.lineTo(x + .5, height); context.stroke();
    context.globalAlpha = .8;
    context.fillText(line.label, x + 3, height - 3);
  }
  context.globalAlpha = 1;

  const xOf = index => (index / (count - 1 || 1)) * width;
  const yOf = db => height - dbFraction(db, floorDb) * height;

  // Held peaks first, so that the curve lies on top of them.
  if (hold.length === count) {
    context.strokeStyle = style('--vscode-descriptionForeground') || '#999';
    context.globalAlpha = .55;
    context.beginPath();
    for (let i = 0; i < count; i++) {
      const x = xOf(i), y = yOf(hold[i]);
      i === 0 ? context.moveTo(x, y) : context.lineTo(x, y);
    }
    context.stroke();
    context.globalAlpha = 1;
  }

  // The spectrum as a filled curve.
  const colour = style('--vscode-charts-blue') || '#4aa3ff';
  context.beginPath();
  context.moveTo(0, height);
  for (let i = 0; i < count; i++) context.lineTo(xOf(i), yOf(values[i]));
  context.lineTo(width, height);
  context.closePath();
  context.globalAlpha = .28;
  context.fillStyle = colour;
  context.fill();
  context.globalAlpha = 1;
  context.strokeStyle = colour;
  context.lineWidth = 1.2;
  context.beginPath();
  for (let i = 0; i < count; i++) {
    const x = xOf(i), y = yOf(values[i]);
    i === 0 ? context.moveTo(x, y) : context.lineTo(x, y);
  }
  context.stroke();

  // Mauszeiger
  if (cursorX !== null && cursorX >= 0 && cursorX <= width) {
    context.strokeStyle = style('--vscode-foreground') || '#fff';
    context.globalAlpha = .4;
    context.beginPath();
    context.moveTo(cursorX + .5, 0); context.lineTo(cursorX + .5, height);
    context.stroke();
    context.globalAlpha = 1;
  }
}

function readout() {
  const host = document.getElementById('readout');
  if (!frame || !frame.available) { host.textContent = ''; return; }
  const parts = [];
  if (frame.peakDb > frame.floorDb) {
    const note = noteName(frame.peakFreq);
    parts.push('<span class="peak">' + frame.peakFreq.toFixed(1) + ' Hz' +
      (note ? ' \\u00B7 ' + note : '') + ' \\u00B7 ' + frame.peakDb.toFixed(1) + ' dBFS</span>');
  } else {
    parts.push('<span class="dim">no peak above the floor</span>');
  }
  if (cursorX !== null) {
    const width = canvas.clientWidth || 600;
    const f = columnFrequency(Math.max(0, Math.min(width, cursorX)), width,
                              frame.fMin, frame.fMax, frame.mode);
    const note = noteName(f);
    parts.push('<span class="dim">cursor: ' + f.toFixed(1) + ' Hz' +
      (note ? ' \\u00B7 ' + note : '') + '</span>');
  }
  parts.push('<span class="dim">' + frame.fftSize + ' points \\u00B7 ' +
    frame.binWidth.toFixed(2) + ' Hz per bin \\u00B7 ' +
    Math.round(frame.effectiveRate) + ' Hz</span>');
  host.innerHTML = parts.join(' &nbsp; ');
}

// --- Nachrichten ------------------------------------------------------
window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'rings') {
    const select = document.getElementById('key');
    const options = message.rings.map(r =>
      '<option value="' + r.key + '"' + (r.key === message.selected ? ' selected' : '') +
      '>' + r.key + (r.unusable ? ' \\u2014 ' + r.unusable : '') +
      '</option>').join('');
    select.innerHTML = options;
    settings.key = message.selected;
    // The recipe is shown whenever no ring can carry a spectrum — not
    // only when the list is empty. The common case is a session that
    // already has a level meter ring (decimation 441, capacity 256):
    // there IS a ring, it just cannot do this, and a bare error message
    // leaves the user without a next step.
    // Two different situations, two different messages. With no ring at
    // all, the recipe is what is needed and the reasoning is ballast; with
    // a ring present that cannot carry a spectrum, the REASON is the point,
    // because the selector already lists it and the user is looking at a
    // name that seems perfectly good.
    const size = Math.max(4096, message.fftSize);
    const recipe =
      '<code>(defparameter *scope* (clamps-bridge-rpc:make-sticker-sample-state-for-repl ' +
      size + ' 1))</code><br>' +
      '<code>(clamps-bridge-rpc:register-sticker-state-for-repl "scope" *scope*)</code><br>' +
      'and in the dsp! body:<br>' +
      '<code>(clamps-bridge-rpc:sticker-state-record-sample-for-repl *scope* in)</code>';
    document.getElementById('empty').innerHTML = message.anyUsable
      ? ''
      : message.rings.length === 0
        ? 'No ring registered:<br>' + recipe
        : 'None of the registered rings can carry a spectrum. One is needed ' +
          'that is undecimated and holds at least ' + message.fftSize +
          ' values; a level meter ring is decimated and too small.<br>' + recipe;
    return;
  }
  if (message.type !== 'frame') return;
  frame = message.frame;
  if (!frame.available) {
    document.getElementById('warn').textContent = frame.error || '';
    document.getElementById('readout').textContent = '';
    hold = [];
    context.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    return;
  }
  const now = Date.now();
  const dt = lastFrameAt ? now - lastFrameAt : INTERVAL;
  lastFrameAt = now;
  const values = frame.values || [];
  if (hold.length !== values.length) hold = values.slice();
  else {
    for (let i = 0; i < values.length; i++) {
      const fallen = hold[i] - FALL_DB_PER_SECOND * (dt / 1000);
      hold[i] = Math.max(frame.floorDb, Math.max(values[i], fallen));
    }
  }
  document.getElementById('warn').innerHTML =
    (frame.warnings || []).map(w => '\\u26A0 ' + w).join('<br>');
  draw();
  readout();
});

resize();
</script>
</body></html>`;
  }
}
