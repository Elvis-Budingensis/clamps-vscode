import * as vscode from 'vscode';
import { columnFrequency, frequencyFraction, noteName, dbFraction } from './freqScope';

/**
 * Live spectrogram — frequency over time, colour as level.
 *
 * The scope shows the present; this shows the recent past. Technically it
 * is the same FFT, and deliberately literally the same one: the Lisp side
 * factors the windowing, transform and column reduction into
 * %spectrum-of-samples, which both call. Two separate implementations of
 * one computation is the surest way to end up with a scope and a
 * spectrogram that place a partial in two different rows, and to do so
 * invisibly, because each picture is plausible on its own.
 *
 * What is NOT the same is the time handling, and that is the whole point
 * of this view.
 *
 * The obvious implementation asks for one spectrum per drawn frame. The
 * time resolution is then the poll interval — at 50 ms, twenty columns per
 * second, which is a slideshow rather than a spectrogram. Worse, the
 * spacing between columns would be however long each round trip happened
 * to take, so the time axis would carry no unit and could not be labelled.
 *
 * Instead the frames sit on an absolute grid: frame F covers the samples
 * [F*hop - fftSize, F*hop). Several frames arrive per request, the view
 * names the last index it received, and Lisp answers with what is missing.
 * Three things follow:
 *
 *   - One column is exactly hop/rate seconds, so the axis has a unit.
 *   - Frames cannot be duplicated or silently lost. What fell out of the
 *     ring is counted and shown, because a gap in a spectrogram misdates
 *     everything after it and the eye cannot detect it.
 *   - Time resolution and update rate are independent. Eight frames per
 *     request at 20 requests a second is 160 columns of axis per second
 *     over 20 messages.
 */

export interface SpectrogramFrames {
  available: boolean;
  error?: string;
  sampleRate: number;
  effectiveRate: number;
  fftSize: number;
  mode: string;
  fMin: number;
  fMax: number;
  floorDb: number;
  binWidth: number;
  hop: number;
  frame: number;
  secondsPerFrame: number;
  dropped: number;
  warnings: string[];
  frames: number[][];
}

export type SpectrogramRequest = (params: {
  key: string;
  fftSize: number;
  window: string;
  columns: number;
  mode: string;
  floorDb: number;
  since: number;
  hop: number;
  maxFrames: number;
}) => Promise<SpectrogramFrames | undefined>;

export type RingLister = () => Promise<
  { key: string; capacity: number; decimation: number; elementType: string }[]
>;

/**
 * The largest number of frames one request may carry.
 *
 * Mirrors the cap in sticker-spectrogram-for-repl. The two have to agree:
 * if the client asked for more, Lisp would quietly deliver fewer and the
 * view would fall behind by the difference on every request — visible
 * nowhere, because the picture keeps scrolling.
 */
export const MAX_FRAMES_PER_REQUEST = 64;

/**
 * How many frames to ask for in one request.
 *
 * The frame rate times the interval, doubled as a margin against a slow
 * round trip, and capped where Lisp caps.
 */
export function framesPerRequest(
  intervalMs: number,
  hop: number,
  sampleRate: number
): number {
  if (!(hop > 0) || !(sampleRate > 0)) return 8;
  const accruing = (intervalMs / 1000) * (sampleRate / hop);
  return Math.max(1, Math.min(MAX_FRAMES_PER_REQUEST, Math.ceil(accruing * 2)));
}

/**
 * The poll interval actually used, which may be shorter than configured.
 *
 * This is where a design mistake sat that the gate found rather than the
 * eye: the update rate cannot be chosen freely, it follows from the frame
 * rate. At a hop of 64 the analysis produces 750 frames a second; over a
 * configured 100 ms that is 75 frames per request, and Lisp delivers at
 * most 64. The remaining 11 would be dropped on EVERY request, so the view
 * would slide into the past by about a second a minute — and nothing in a
 * scrolling picture says that the right-hand edge is no longer the
 * present.
 *
 * So the interval is shortened until the backlog fits, with the same
 * factor-of-two margin. The configured value stays an upper bound: whoever
 * asks for a slower cycle gets it, as long as it is possible at all.
 */
export function pollIntervalFor(
  configuredMs: number,
  hop: number,
  sampleRate: number
): number {
  if (!(hop > 0) || !(sampleRate > 0)) return Math.max(20, configuredMs);
  const framesPerSecond = sampleRate / hop;
  // Half the cap, so that framesPerRequest's doubled margin still fits.
  const affordableMs = ((MAX_FRAMES_PER_REQUEST / 2) / framesPerSecond) * 1000;
  return Math.max(20, Math.min(configuredMs, Math.floor(affordableMs)));
}

/**
 * Colour for a dB value: a perceptual ramp from background through blue
 * and yellow to white.
 *
 * Deliberately not a grey ramp. In a spectrogram the interesting thing is
 * a partial a few dB above its surroundings, and the eye distinguishes hue
 * far better than brightness in the dark half of the range — which is
 * where almost all of a musical spectrum lives.
 */
export function levelColour(db: number, floorDb: number): string {
  const t = dbFraction(db, floorDb);
  if (t <= 0) return 'rgba(0,0,0,0)';
  // Four stops, interpolated in RGB. Enough for a readable ramp and
  // cheap enough to compute per pixel column.
  const stops: [number, number, number, number][] = [
    [0.0, 20, 24, 48],
    [0.45, 40, 90, 190],
    [0.75, 235, 200, 60],
    [1.0, 255, 255, 255],
  ];
  let a = stops[0];
  let b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) {
      a = stops[i];
      b = stops[i + 1];
      break;
    }
  }
  const span = b[0] - a[0] || 1;
  const f = (t - a[0]) / span;
  const mix = (i: number) => Math.round(a[i] + (b[i] - a[i]) * f);
  return `rgb(${mix(1)},${mix(2)},${mix(3)})`;
}

interface GramSettings {
  key: string;
  fftSize: number;
  window: string;
  mode: string;
  floorDb: number;
  columns: number;
  hop: number;
}

export class SpectrogramView {
  private static instance: SpectrogramView | undefined;

  private settings: GramSettings;
  private since = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private keyTimer: ReturnType<typeof setInterval> | undefined;
  private inFlight = false;
  private effectiveIntervalMs = 60;
  /**
   * The rate reported by the image, used for the request arithmetic.
   *
   * 44100 as the starting assumption, not 48000: the screenshot from a
   * real session showed 44100, and a hardcoded 48000 makes the frame
   * accounting 9 % optimistic — enough to drop a frame per request at a
   * small hop. It is corrected from the first answer onwards, so the
   * initial value only matters for the very first cycle.
   */
  private rate = 44100;
  private visible = true;
  private lastKeys = '';

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly request: SpectrogramRequest,
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
      hop: Math.max(16, fftSize / 4),
    };

    panel.webview.html = SpectrogramView.html(this.settings);
    panel.webview.onDidReceiveMessage(m => this.onMessage(m));
    panel.onDidChangeViewState(e => {
      this.visible = e.webviewPanel.visible;
      // A hidden view stops asking, and on return it does NOT catch up:
      // `since` jumps to the present. Otherwise a panel hidden for two
      // minutes would first scroll two minutes of history past, which is
      // exactly what nobody wants from a live view.
      if (this.visible) this.since = 0;
    });
    panel.onDidDispose(() => this.dispose());

    void this.refreshKeys();
    this.keyTimer = setInterval(() => void this.refreshKeys(), 2000);
    this.retime();
  }

  /**
   * (Re)start the cycle at an interval the hop allows. Called at startup
   * and whenever the hop changes, because a smaller hop means more frames
   * per second and therefore a shorter cycle.
   */
  private retime(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.effectiveIntervalMs =
      pollIntervalFor(this.intervalMs, this.settings.hop, this.rate);
    this.timer = setInterval(() => void this.tick(), this.effectiveIntervalMs);
  }

  static show(
    request: SpectrogramRequest,
    listRings: RingLister,
    intervalMs: number,
    fftSize: number
  ): SpectrogramView {
    if (this.instance) {
      this.instance.panel.reveal(vscode.ViewColumn.Beside, true);
      return this.instance;
    }
    const panel = vscode.window.createWebviewPanel(
      'clampsSpectrogram',
      'CLAMPS: Spectrogram',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: false }
    );
    this.instance = new SpectrogramView(panel, request, listRings, intervalMs, fftSize);
    return this.instance;
  }

  /** Why a ring cannot carry a spectrogram, or undefined if it can. */
  static unusableBecause(
    ring: { capacity: number; decimation: number; elementType: string },
    fftSize: number
  ): string | undefined {
    if (ring.elementType !== 'double-float') return 'not a sample ring';
    if (ring.decimation > 1) return `decimated \u00d7${ring.decimation}`;
    // A spectrogram needs more headroom than the scope: between two
    // requests the ring must still hold the frames accrued in the
    // meantime, not just one window. Twice the FFT size is the smallest
    // size at which nothing is dropped in normal operation.
    if (ring.capacity < fftSize * 2) {
      return `holds ${ring.capacity}, wants ${fftSize * 2}`;
    }
    return undefined;
  }

  private onMessage(message: { type?: string; field?: string; value?: unknown }): void {
    if (message?.type !== 'set' || !message.field) return;
    const value = message.value;
    const reset = () => {
      // Any change to the analysis invalidates the picture drawn so far:
      // the rows no longer mean the same frequencies, or the columns no
      // longer the same span of time. Start afresh rather than splice two
      // different analyses into one image.
      this.since = 0;
      this.lastKeys = '';
      void this.panel.webview.postMessage({ type: 'clear' });
    };
    switch (message.field) {
      case 'key':
        if (typeof value === 'string') { this.settings.key = value; reset(); }
        break;
      case 'fftSize':
        if (typeof value === 'number') {
          this.settings.fftSize = value;
          this.settings.hop = Math.max(16, Math.min(value, this.settings.hop));
          reset();
          void this.refreshKeys();
        }
        break;
      case 'hop':
        if (typeof value === 'number') {
          this.settings.hop = Math.max(16, Math.min(this.settings.fftSize, value));
          this.retime();
          reset();
        }
        break;
      case 'window':
        if (typeof value === 'string') { this.settings.window = value; reset(); }
        break;
      case 'mode':
        if (typeof value === 'string') { this.settings.mode = value; reset(); }
        break;
      case 'floorDb':
        if (typeof value === 'number') { this.settings.floorDb = value; reset(); }
        break;
      case 'columns':
        // Rows, not columns, in this view: the canvas height decides how
        // many frequency bands are worth transferring.
        if (typeof value === 'number' && Number.isFinite(value)) {
          this.settings.columns = Math.max(16, Math.min(1024, Math.round(value)));
        }
        break;
    }
  }

  private async refreshKeys(): Promise<void> {
    let rings: Awaited<ReturnType<RingLister>>;
    try {
      rings = await this.listRings();
    } catch {
      return;
    }
    const classified = rings.map(r => ({
      ...r,
      unusable: SpectrogramView.unusableBecause(r, this.settings.fftSize),
    }));
    const serialised = JSON.stringify(classified);
    if (serialised === this.lastKeys) return;
    this.lastKeys = serialised;

    const usable = classified.filter(r => r.unusable === undefined);
    if (!classified.some(r => r.key === this.settings.key && !r.unusable)) {
      this.settings.key = (usable[0] ?? classified[0])?.key ?? '';
      this.since = 0;
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
      const maxFrames =
        framesPerRequest(this.effectiveIntervalMs, this.settings.hop, this.rate);
      const answer = await this.request({
        ...this.settings,
        since: this.since,
        maxFrames,
      });
      if (!answer) return;
      if (answer.available) {
        this.since = answer.frame;
        // Adopt the real rate. Guessing it wrongly makes the frame
        // accounting optimistic and drops a frame per request — invisibly,
        // because the picture keeps scrolling.
        if (answer.effectiveRate > 0 && answer.effectiveRate !== this.rate) {
          this.rate = answer.effectiveRate;
          this.retime();
        }
      }
      void this.panel.webview.postMessage({ type: 'frames', answer });
    } catch {
      // A failed request does not end the cycle — the session may be
      // restarting. `since` stays where it was, so nothing is skipped.
    } finally {
      this.inFlight = false;
    }
  }

  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    if (this.keyTimer !== undefined) clearInterval(this.keyTimer);
    this.timer = undefined;
    this.keyTimer = undefined;
    SpectrogramView.instance = undefined;
  }

  private static html(settings: GramSettings): string {
    return `<!DOCTYPE html>
<html lang="en">
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
  canvas { width: 100%; height: 340px; display: block;
           background: var(--vscode-input-background); border-radius: 3px; }
  .readout { margin-top: 5px; font-family: var(--vscode-editor-font-family, monospace);
             font-variant-numeric: tabular-nums; }
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
    <option>2048</option><option>4096</option>
  </select></label>
  <label>Hop <select id="hop">
    <option>64</option><option>128</option><option>256</option>
    <option>512</option><option>1024</option>
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
<canvas id="gram"></canvas>
<div class="readout" id="readout"></div>
<div class="warn" id="warn"></div>
<div class="empty" id="empty"></div>
<script>
const vscode = acquireVsCodeApi();
const canvas = document.getElementById('gram');
const context = canvas.getContext('2d');
let settings = ${JSON.stringify(settings)};
let header = null;
let cursor = null;
let drawnColumns = 0;

const dbFraction = (db, floorDb) =>
  Math.max(0, Math.min(1, (db - floorDb) / (0 - floorDb)));
const frequencyFraction = (freq, fMin, fMax, mode) => {
  if (mode === 'log') {
    if (fMin <= 0 || fMax <= fMin || freq <= 0) return 0;
    return Math.log(freq / fMin) / Math.log(fMax / fMin);
  }
  return fMax <= fMin ? 0 : (freq - fMin) / (fMax - fMin);
};
const columnFrequency = (index, columns, fMin, fMax, mode) => {
  const fraction = index / columns;
  return mode === 'log'
    ? fMin * Math.pow(fMax / fMin, fraction)
    : fMin + fraction * (fMax - fMin);
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
const levelColour = (db, floorDb) => {
  const t = dbFraction(db, floorDb);
  if (t <= 0) return 'rgba(0,0,0,0)';
  const stops = [[0,20,24,48],[0.45,40,90,190],[0.75,235,200,60],[1,255,255,255]];
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i+1][0]) { a = stops[i]; b = stops[i+1]; break; }
  }
  const span = (b[0] - a[0]) || 1, f = (t - a[0]) / span;
  const mix = i => Math.round(a[i] + (b[i] - a[i]) * f);
  return 'rgb(' + mix(1) + ',' + mix(2) + ',' + mix(3) + ')';
};

const send = (field, value) => { settings[field] = value;
  vscode.postMessage({ type: 'set', field, value }); };
for (const [id, cast] of [['key', String], ['fftSize', Number], ['hop', Number],
                          ['window', String], ['mode', String], ['floorDb', Number]]) {
  document.getElementById(id).addEventListener('change',
    e => send(id, cast(e.target.value)));
}
document.getElementById('fftSize').value = String(settings.fftSize);
document.getElementById('hop').value = String(settings.hop);
document.getElementById('window').value = settings.window;
document.getElementById('mode').value = settings.mode;
document.getElementById('floorDb').value = String(settings.floorDb);

function resize() {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 600;
  const height = canvas.clientHeight || 340;
  // Preserve what is already drawn across a resize: redrawing is
  // impossible, the history only exists on this canvas.
  const keep = canvas.width > 0
    ? context.getImageData(0, 0, canvas.width, canvas.height) : null;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  if (keep) context.putImageData(keep, 0, 0);
  // The canvas height decides how many frequency bands are worth having.
  vscode.postMessage({ type: 'set', field: 'columns',
                       value: Math.round(height * ratio) });
}
window.addEventListener('resize', resize);

canvas.addEventListener('mousemove', e => {
  const r = canvas.getBoundingClientRect();
  cursor = { x: e.clientX - r.left, y: e.clientY - r.top };
  readout();
});
canvas.addEventListener('mouseleave', () => { cursor = null; readout(); });

/** Scroll left by N pixel columns and draw the new ones on the right. */
function append(frames, floorDb) {
  const w = canvas.width, h = canvas.height;
  const n = frames.length;
  if (n === 0 || w === 0) return;
  const shift = Math.min(n, w);
  context.drawImage(canvas, -shift, 0);
  for (let i = 0; i < shift; i++) {
    const frame = frames[n - shift + i];
    const x = w - shift + i;
    const rows = frame.length;
    for (let r = 0; r < rows; r++) {
      // Row 0 is the lowest frequency and belongs at the BOTTOM.
      const y = h - 1 - Math.floor((r / rows) * h);
      const bandHeight = Math.max(1, Math.ceil(h / rows));
      context.fillStyle = levelColour(frame[r], floorDb);
      context.fillRect(x, y - bandHeight + 1, 1, bandHeight);
    }
  }
  drawnColumns += shift;
}

function readout() {
  const host = document.getElementById('readout');
  if (!header) { host.textContent = ''; return; }
  const parts = [];
  if (cursor) {
    const ratio = window.devicePixelRatio || 1;
    const h = canvas.clientHeight || 340;
    const fraction = 1 - Math.max(0, Math.min(1, cursor.y / h));
    const f = columnFrequency(fraction * 1000, 1000, header.fMin, header.fMax, header.mode);
    const note = noteName(f);
    const back = ((canvas.clientWidth - cursor.x) * ratio) * header.secondsPerFrame;
    parts.push('<span class="dim">cursor: ' + f.toFixed(1) + ' Hz' +
      (note ? ' \\u00B7 ' + note : '') +
      ' \\u00B7 ' + back.toFixed(2) + ' s ago</span>');
  }
  parts.push('<span class="dim">' + header.fftSize + ' points \\u00B7 hop ' +
    header.hop + ' \\u00B7 ' + (header.secondsPerFrame * 1000).toFixed(1) +
    ' ms per column \\u00B7 ' + header.binWidth.toFixed(2) + ' Hz per bin</span>');
  host.innerHTML = parts.join(' &nbsp; ');
}

window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'clear') {
    context.clearRect(0, 0, canvas.width, canvas.height);
    drawnColumns = 0;
    return;
  }
  if (message.type === 'rings') {
    const select = document.getElementById('key');
    select.innerHTML = message.rings.map(r =>
      '<option value="' + r.key + '"' + (r.key === message.selected ? ' selected' : '') +
      '>' + r.key + (r.unusable ? ' \\u2014 ' + r.unusable : '') +
      '</option>').join('');
    settings.key = message.selected;
    document.getElementById('empty').innerHTML = message.anyUsable
      ? ''
      : (message.rings.length === 0
          ? 'No ring registered. '
          : 'No registered ring can carry a spectrogram. ') +
        'It needs an UNDECIMATED ring holding at least twice the FFT length ' +
        '\\u2014 more than the scope, because between two requests the ring ' +
        'has to keep the frames accrued in the meantime:<br>' +
        '<code>(defparameter *scope* (clamps-bridge-rpc:make-sticker-sample-state-for-repl ' +
        Math.max(8192, message.fftSize * 4) + ' 1))</code><br>' +
        '<code>(clamps-bridge-rpc:register-sticker-state-for-repl "scope" *scope*)</code><br>' +
        'and unconditionally in the dsp! body:<br>' +
        '<code>(clamps-bridge-rpc:sticker-state-record-sample-for-repl *scope* in)</code>';
    return;
  }
  if (message.type !== 'frames') return;
  const answer = message.answer;
  if (!answer.available) {
    document.getElementById('warn').textContent = answer.error || '';
    return;
  }
  header = answer;
  const notes = (answer.warnings || []).map(w => '\\u26A0 ' + w);
  if (answer.dropped > 0) {
    // Named, not passed over: a gap misdates everything to the right of it
    // and is invisible in the picture.
    notes.push('\\u26A0 ' + answer.dropped + ' frame(s) dropped \\u2014 the ring ' +
      'is too small or the cycle too slow; the time axis has a gap here');
  }
  document.getElementById('warn').innerHTML = notes.join('<br>');
  append(answer.frames || [], answer.floorDb);
  readout();
});

resize();
</script>
</body></html>`;
  }
}
