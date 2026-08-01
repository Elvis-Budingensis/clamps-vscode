import * as vscode from 'vscode';

/**
 * Sample browser — what is in a directory of sound files.
 *
 * A table rather than a picture, and deliberately so. The other audio
 * views exist because their subject cannot be written down: a spectrum, a
 * waveform, a set of partials. What one wants from a sample folder is the
 * opposite — rate, channels, bit depth, duration, sorted and comparable at
 * a glance. A row of thumbnails would be prettier and would answer none of
 * the questions one actually opens a sample folder with, which are of the
 * form "which of these is the 96 kHz one" and "why is this take four
 * seconds shorter than that one".
 *
 * Only the headers are read (see sample-browse-for-repl). A directory of a
 * few hundred samples is gigabytes; everything shown here is in the first
 * few hundred bytes of each file.
 *
 * Clicking a row hands the file to the buffer viewer, which is the point
 * of having both: the table answers "which file", the waveform answers
 * "what is in it".
 */

export interface SampleEntry {
  name: string;
  path: string;
  format: string;
  channels: number;
  sampleRate: number;
  bitDepth: number;
  frames: number;
  duration: number;
  size: number;
}

export interface SampleListing {
  available: boolean;
  error?: string;
  entries: SampleEntry[];
}

export type SampleRequest = (params: { directory: string; recursive: boolean })
  => Promise<SampleListing | undefined>;

/** What the user asked to happen with a chosen file. */
export type SampleAction = (entry: SampleEntry, action: 'waveform' | 'load')
  => void;

/** A duration as m:ss.mmm, or a dash when the header did not say. */
export function durationLabel(seconds: number): string {
  if (!(seconds > 0)) return '—';
  if (seconds < 60) return seconds.toFixed(3) + ' s';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds - minutes * 60).toFixed(2).padStart(5, '0')}`;
}

/** A file size in the largest unit that leaves a number above one. */
export function sizeLabel(bytes: number): string {
  if (!(bytes > 0)) return '—';
  const units = ['B', 'kB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * A rate as a number of kHz, without inventing precision.
 *
 * 44100 becomes "44.1 k", 48000 "48 k". The trailing zero is dropped
 * because a column of "44.1 k / 48.0 k / 96.0 k" is harder to scan than
 * one of "44.1 k / 48 k / 96 k", and the point of the column is
 * comparison.
 *
 * A rate that is not a whole number of hertz is shown in full, because
 * that is a fact about the file and almost always a sign that something
 * upstream resampled it.
 */
export function rateLabel(hertz: number): string {
  if (!(hertz > 0)) return '—';
  if (!Number.isInteger(hertz)) return hertz.toFixed(3) + ' Hz';
  const k = hertz / 1000;
  return (Number.isInteger(k) ? String(k) : k.toFixed(1)) + ' k';
}

/**
 * Sorts entries by one column.
 *
 * Text columns sort case-insensitively, numeric ones numerically — the
 * distinction matters because a numeric column sorted as text puts 100
 * before 20, which looks sorted and is not.
 */
export function sortEntries(
  entries: SampleEntry[],
  column: keyof SampleEntry,
  descending: boolean
): SampleEntry[] {
  const sorted = [...entries].sort((a, b) => {
    const left = a[column];
    const right = b[column];
    if (typeof left === 'number' && typeof right === 'number') {
      return left - right;
    }
    return String(left).toLowerCase().localeCompare(String(right).toLowerCase());
  });
  return descending ? sorted.reverse() : sorted;
}

export class SampleBrowserView {
  private static instance: SampleBrowserView | undefined;
  private directory: string;
  private recursive = false;
  private entries: SampleEntry[] = [];
  private inFlight = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly request: SampleRequest,
    private readonly act: SampleAction,
    directory: string
  ) {
    this.directory = directory;
    panel.webview.html = SampleBrowserView.html(directory);
    panel.webview.onDidReceiveMessage(m => this.onMessage(m));
    panel.onDidDispose(() => { SampleBrowserView.instance = undefined; });
    void this.refresh();
  }

  static show(request: SampleRequest, act: SampleAction, directory: string)
    : SampleBrowserView {
    if (this.instance) {
      this.instance.panel.reveal(vscode.ViewColumn.Beside, true);
      this.instance.directory = directory;
      void this.instance.panel.webview.postMessage({ type: 'directory', directory });
      void this.instance.refresh();
      return this.instance;
    }
    const panel = vscode.window.createWebviewPanel(
      'clampsSampleBrowser',
      'CLAMPS: Samples',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.instance = new SampleBrowserView(panel, request, act, directory);
    return this.instance;
  }

  private onMessage(message: {
    type?: string; path?: string; recursive?: boolean;
  }): void {
    if (message.type === 'recursive' && typeof message.recursive === 'boolean') {
      this.recursive = message.recursive;
      void this.refresh();
    } else if (message.type === 'refresh') {
      void this.refresh();
    } else if ((message.type === 'waveform' || message.type === 'load')
               && message.path) {
      const entry = this.entries.find(e => e.path === message.path);
      if (entry) this.act(entry, message.type);
    }
  }

  private async refresh(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const listing = await this.request({
        directory: this.directory,
        recursive: this.recursive,
      });
      if (!listing) return;
      this.entries = listing.entries ?? [];
      void this.panel.webview.postMessage({ type: 'listing', listing });
    } catch {
      // The session may be restarting; leave the table standing.
    } finally {
      this.inFlight = false;
    }
  }

  private static html(directory: string): string {
    const escaped = directory.replace(/[<>&"]/g, c =>
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
  table { border-collapse: collapse; width: 100%;
          font-variant-numeric: tabular-nums; }
  th { text-align: left; cursor: pointer; user-select: none;
       border-bottom: 1px solid var(--vscode-panel-border);
       padding: 3px 8px 3px 0; font-weight: 600; }
  th:hover { color: var(--vscode-textLink-foreground); }
  td { padding: 2px 8px 2px 0;
       border-bottom: 1px solid var(--vscode-panel-border); }
  tr.row:hover { background: var(--vscode-list-hoverBackground); }
  td.num { text-align: right; }
  .dim { opacity: .6; }
  .bad { color: var(--vscode-charts-red); }
  .empty { opacity: .75; margin-top: 10px; }
  .hint { opacity: .55; margin-top: 6px; font-size: 11px; }
</style></head>
<body>
<div class="bar">
  <code id="dir">${escaped}</code>
  <label class="dim"><input type="checkbox" id="recursive"> Include subfolders</label>
  <button id="refresh">Refresh</button>
</div>
<table id="table"><thead><tr id="head"></tr></thead><tbody id="body"></tbody></table>
<div class="empty" id="empty"></div>
<div class="hint">Click a row for its waveform.</div>
<script>
const vscode = acquireVsCodeApi();
let entries = [];
let sortColumn = 'name';
let descending = false;

const durationLabel = s => {
  if (!(s > 0)) return '\\u2014';
  if (s < 60) return s.toFixed(3) + ' s';
  const m = Math.floor(s / 60);
  return m + ':' + (s - m * 60).toFixed(2).padStart(5, '0');
};
const sizeLabel = b => {
  if (!(b > 0)) return '\\u2014';
  const units = ['B', 'kB', 'MB', 'GB'];
  let v = b, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return (v < 10 && u > 0 ? v.toFixed(1) : Math.round(v)) + ' ' + units[u];
};
const rateLabel = hz => {
  if (!(hz > 0)) return '\\u2014';
  if (!Number.isInteger(hz)) return hz.toFixed(3) + ' Hz';
  const k = hz / 1000;
  return (Number.isInteger(k) ? String(k) : k.toFixed(1)) + ' k';
};

const COLUMNS = [
  { key: 'name', label: 'Name', cell: e => e.name },
  { key: 'format', label: 'Format', cell: e => e.format, dim: e => e.format === '?' },
  { key: 'channels', label: 'Ch', num: true,
    cell: e => e.channels || '\\u2014' },
  { key: 'sampleRate', label: 'Rate', num: true,
    cell: e => rateLabel(e.sampleRate) },
  { key: 'bitDepth', label: 'Bits', num: true,
    cell: e => e.bitDepth || '\\u2014' },
  { key: 'duration', label: 'Duration', num: true,
    cell: e => durationLabel(e.duration) },
  { key: 'size', label: 'Size', num: true, cell: e => sizeLabel(e.size) },
];

function render() {
  const head = document.getElementById('head');
  head.innerHTML = COLUMNS.map(c =>
    '<th data-key="' + c.key + '">' + c.label +
    (c.key === sortColumn ? (descending ? ' \\u25BE' : ' \\u25B4') : '') +
    '</th>').join('');
  for (const th of head.querySelectorAll('th')) {
    th.onclick = () => {
      const key = th.dataset.key;
      if (key === sortColumn) descending = !descending;
      else { sortColumn = key; descending = false; }
      render();
    };
  }
  const sorted = [...entries].sort((a, b) => {
    const l = a[sortColumn], r = b[sortColumn];
    return typeof l === 'number' && typeof r === 'number'
      ? l - r
      : String(l).toLowerCase().localeCompare(String(r).toLowerCase());
  });
  if (descending) sorted.reverse();
  const body = document.getElementById('body');
  body.innerHTML = sorted.map(e =>
    '<tr class="row" data-path="' + e.path.replace(/"/g, '&quot;') + '">' +
    COLUMNS.map(c =>
      '<td class="' + (c.num ? 'num' : '') + (c.dim && c.dim(e) ? ' bad' : '') +
      '">' + c.cell(e) + '</td>').join('') +
    '</tr>').join('');
  for (const row of body.querySelectorAll('tr.row')) {
    row.onclick = () =>
      vscode.postMessage({ type: 'waveform', path: row.dataset.path });
  }
}

document.getElementById('recursive').onchange = e =>
  vscode.postMessage({ type: 'recursive', recursive: e.target.checked });
document.getElementById('refresh').onclick = () =>
  vscode.postMessage({ type: 'refresh' });

window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'directory') {
    document.getElementById('dir').textContent = message.directory;
    return;
  }
  if (message.type !== 'listing') return;
  const listing = message.listing;
  if (!listing.available) {
    document.getElementById('empty').innerHTML =
      '<span class="bad">' + (listing.error || '') + '</span>';
    entries = [];
    render();
    return;
  }
  entries = listing.entries || [];
  const unreadable = entries.filter(e => e.format === '?').length;
  document.getElementById('empty').innerHTML = entries.length === 0
    ? 'No sound files in this folder.'
    : '<span class="dim">' + entries.length + ' file(s)' +
      (unreadable ? ', ' + unreadable + ' with an unreadable header' : '') +
      '</span>';
  render();
});
</script>
</body></html>`;
  }
}
