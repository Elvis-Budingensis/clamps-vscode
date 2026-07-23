import * as vscode from 'vscode';
import { LanguageClient, State } from 'vscode-languageclient/node';
import { packageAt, topLevelFormAt } from './macroexpand';
import { symbolAt } from './disassemble';

interface InspectPart {
  label: string;
  /** Position in der Teileliste des Objekts — damit wird navigiert. */
  index: number;
  /** Kurze Druckdarstellung des Wertes — spart einen Klick. */
  preview?: string;
  /** Nicht gebundene Slots lassen sich nicht betreten. */
  navigable?: boolean;
}
interface InspectMeta {
  key: string;
  value: string;
}
interface InspectResult {
  /** ID des Objekts in der Tabelle des Images. */
  id: number;
  /** object, struct, list, vector, array, hash-table, string, symbol,
   *  function, number, character, pathname, package, atom, error. */
  kind?: string;
  type: string;
  print: string;
  parts: InspectPart[];
  meta?: InspectMeta[];
  package: string;
}

/** Ein Schritt in der Navigationshistorie. */
interface Crumb {
  id: number;
  label: string;
}

const esc = (s: string): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * Der Inspector navigiert über Objekt-IDs, nicht über Ausdrücke.
 *
 * Die frühere Fassung setzte für jeden Klick einen Zugriffs-Ausdruck
 * zusammen ("(slot-value (progn <expr>) 'x)") und liess ihn neu
 * auswerten. Das hatte drei Fehler: bei Seiteneffekten entstand ein
 * NEUES Objekt statt in das vorhandene zu navigieren, die Ausdrücke
 * wuchsen mit jeder Ebene, und Werte ohne lesbare Druckdarstellung
 * (etwa CLOS-Instanzen als Hash-Schlüssel) brachen die Navigation ganz.
 *
 * Jetzt hält das Image eine Objekt-Tabelle; der Client kennt nur IDs.
 * Beim Schließen des Panels wird sie freigegeben, damit keine Objekte
 * am Garbage Collector vorbei festgehalten werden.
 */
export class ClampsInspector {
  private static panel: vscode.WebviewPanel | undefined;
  private static trail: Crumb[] = [];
  private static rootExpr = '';
  private static pkg = 'COMMON-LISP-USER';
  private static getClient: () => LanguageClient | undefined;

  static async inspect(
    getClient: () => LanguageClient | undefined,
    expr: string,
    pkg: string
  ): Promise<void> {
    this.getClient = getClient;
    this.pkg = pkg;
    this.rootExpr = expr;
    this.trail = [];
    await this.ensurePanel();
    await this.request('clamps/inspect', { expr, package: pkg }, expr);
  }

  private static async ensurePanel(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'clampsInspector',
      'CLAMPS Inspector',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = this.renderError('Lade …');

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.trail = [];
      // Objekt-Tabelle im Image freigeben. Ohne das hielten wir alles
      // fest, was je angeschaut wurde — bei Audio-Buffern schnell teuer.
      void this.release();
    });

    this.panel.webview.onDidReceiveMessage(async msg => {
      switch (msg.command) {
        case 'navigate':
          await this.navigate(Number(msg.index), String(msg.label ?? '?'));
          break;
        case 'back':
          await this.back();
          break;
        case 'jump':
          await this.jump(Number(msg.depth));
          break;
        case 'refresh':
          await this.refresh();
          break;
      }
    });
  }

  private static get current(): Crumb | undefined {
    return this.trail[this.trail.length - 1];
  }

  private static async navigate(index: number, label: string): Promise<void> {
    const cur = this.current;
    if (!cur) return;
    await this.request(
      'clamps/inspectPart',
      { id: cur.id, index },
      label,
      'push'
    );
  }

  private static async back(): Promise<void> {
    if (this.trail.length < 2) return;
    this.trail.pop();
    const target = this.current;
    if (!target) return;
    await this.request(
      'clamps/inspectRefresh',
      { id: target.id },
      target.label,
      'replace'
    );
  }

  /** Sprung im Breadcrumb auf eine frühere Ebene. */
  private static async jump(depth: number): Promise<void> {
    if (depth < 0 || depth >= this.trail.length - 1) return;
    this.trail = this.trail.slice(0, depth + 1);
    const target = this.current;
    if (!target) return;
    await this.request(
      'clamps/inspectRefresh',
      { id: target.id },
      target.label,
      'replace'
    );
  }

  private static async refresh(): Promise<void> {
    const cur = this.current;
    if (!cur) return;
    await this.request(
      'clamps/inspectRefresh',
      { id: cur.id },
      cur.label,
      'replace'
    );
  }

  private static async release(): Promise<void> {
    const client = this.getClient?.();
    if (!client || client.state !== State.Running) return;
    try {
      await client.sendRequest('clamps/inspectRelease', {});
    } catch {
      // Beim Herunterfahren normal — nicht der Rede wert.
    }
  }

  private static async request(
    method: string,
    params: object,
    label: string,
    mode: 'push' | 'replace' | 'root' = 'root'
  ): Promise<void> {
    if (!this.panel) return;
    const client = this.getClient();
    if (!client || client.state !== State.Running) {
      this.panel.webview.html = this.renderError(
        'CLAMPS ist nicht verbunden. Führe „CLAMPS: Start" aus.'
      );
      return;
    }

    try {
      const r = await client.sendRequest<InspectResult>(method, params);
      if (r.package) this.pkg = r.package;
      if (r.kind === 'error') {
        this.panel.webview.html = this.renderError(r.print || 'Unbekannter Fehler');
        return;
      }
      if (mode === 'root') this.trail = [{ id: r.id, label }];
      else if (mode === 'push') this.trail.push({ id: r.id, label });
      else if (this.current) this.current.id = r.id;
      this.panel.webview.html = this.render(r);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.panel.webview.html = this.renderError(message);
    }
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  private static render(r: InspectResult): string {
    const kind = r.kind || 'atom';
    const parts = r.parts ?? [];
    const meta = r.meta ?? [];
    const body = this.renderBody(kind, parts);
    const canBack = this.trail.length > 1;

    // Bei skalaren Typen ist die Meta-Tabelle die eigentliche Information,
    // die print-Zeile also redundant.
    const scalar = ['number', 'character', 'string', 'pathname', 'package'];
    const showPrint = !(scalar.includes(kind) && meta.length > 0);

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      ${this.css()}
    </style></head><body>
      <div class="bar">
        <button id="back" ${canBack ? '' : 'disabled'}>← Zurück</button>
        <button id="refresh" title="Objekt neu einlesen">↻</button>
        <span class="kind kind-${esc(kind)}">${esc(kind)}</span>
        <span class="type">${esc(r.type)}</span>
        <span class="oid" title="ID in der Objekt-Tabelle">#${r.id}</span>
      </div>
      ${this.renderTrail()}
      ${this.renderMeta(meta)}
      ${showPrint ? `<div class="print">${esc(r.print)}</div>` : ''}
      ${body}
      <script>
        const vscode = acquireVsCodeApi();
        document.getElementById('back')?.addEventListener('click', () =>
          vscode.postMessage({ command: 'back' }));
        document.getElementById('refresh')?.addEventListener('click', () =>
          vscode.postMessage({ command: 'refresh' }));
        for (const c of document.querySelectorAll('[data-depth]')) {
          c.addEventListener('click', e => {
            e.preventDefault();
            vscode.postMessage({ command: 'jump', depth: Number(c.dataset.depth) });
          });
        }
        for (const a of document.querySelectorAll('[data-index]')) {
          a.addEventListener('click', e => {
            e.preventDefault();
            vscode.postMessage({
              command: 'navigate',
              index: Number(a.dataset.index),
              label: a.dataset.label
            });
          });
        }
        const filter = document.getElementById('filter');
        if (filter) {
          filter.addEventListener('input', () => {
            const q = filter.value.toLowerCase();
            let shown = 0;
            for (const row of document.querySelectorAll('.row')) {
              const hit = row.textContent.toLowerCase().includes(q);
              row.style.display = hit ? '' : 'none';
              if (hit) shown++;
            }
            const c = document.getElementById('filter-count');
            if (c) c.textContent = shown + ' sichtbar';
          });
        }
      </script>
    </body></html>`;
  }

  /**
   * Pfad vom Wurzelausdruck bis hierher, jede Ebene anklickbar.
   *
   * Zwei Kürzungen, weil die Leiste sonst unbenutzbar wird: lange
   * Labels (ein Wurzelausdruck kann eine ganze defparameter-Form sein)
   * werden gestutzt, und ab einer gewissen Tiefe fallen die mittleren
   * Ebenen zu einem "…" zusammen. Der vollständige Text steht jeweils
   * im title-Attribut.
   */
  private static renderTrail(): string {
    if (this.trail.length === 0) return '';

    const MAX_LABEL = 28;
    const HEAD = 1; // Wurzel immer zeigen
    const TAIL = 3; // die letzten Ebenen immer zeigen

    const shorten = (t: string): string =>
      t.length <= MAX_LABEL ? t : t.slice(0, MAX_LABEL - 1) + '…';

    const full = (i: number): string =>
      i === 0 ? this.rootExpr : this.trail[i].label;

    const crumb = (i: number): string => {
      const last = i === this.trail.length - 1;
      const text = esc(shorten(full(i)));
      const title = esc(full(i));
      return last
        ? `<span class="crumb here" title="${title}">${text}</span>`
        : `<a class="crumb" href="#" data-depth="${i}" title="${title}">${text}</a>`;
    };

    const n = this.trail.length;
    let items: string[];
    if (n <= HEAD + TAIL + 1) {
      items = this.trail.map((_, i) => crumb(i));
    } else {
      const hidden = n - HEAD - TAIL;
      items = [
        ...Array.from({ length: HEAD }, (_, i) => crumb(i)),
        `<span class="crumb ellipsis" title="${hidden} Ebenen ausgeblendet">…</span>`,
        ...Array.from({ length: TAIL }, (_, k) => crumb(n - TAIL + k)),
      ];
    }
    return `<div class="trail">${items.join('<span class="sep">›</span>')}</div>`;
  }

  /** Wählt das Layout anhand der Objekt-Kategorie. */
  private static renderBody(kind: string, parts: InspectPart[]): string {
    switch (kind) {
      case 'hash-table':
        return this.renderPairs(parts, 'Schlüssel', 'Wert');
      case 'object':
      case 'struct':
        return this.renderPairs(parts, 'Slot', 'Wert');
      case 'symbol':
        return this.renderPairs(parts, 'Zelle', 'Inhalt');
      case 'list':
      case 'vector':
      case 'array':
        return this.renderIndexed(parts);
      case 'string':
      case 'number':
      case 'character':
      case 'function':
      case 'package':
        // Meist steht alles Wesentliche in der Meta-Tabelle. Ausnahme:
        // Komplexzahlen kommen ebenfalls als kind "number", haben aber
        // real- und imagpart als navigierbare Teile.
        return parts.length > 0 ? this.renderPairs(parts, 'Teil', 'Wert') : '';
      case 'pathname':
        return this.renderPairs(parts, 'Komponente', 'Wert');
      default:
        return parts.length > 0
          ? this.renderPairs(parts, 'Teil', 'Wert')
          : '<div class="empty">Atomarer Wert — keine navigierbaren Teile.</div>';
    }
  }

  private static renderMeta(meta: InspectMeta[]): string {
    if (meta.length === 0) return '';
    const cells = meta
      .map(
        m =>
          `<div class="meta-k">${esc(m.key)}</div>` +
          `<div class="meta-v">${esc(m.value)}</div>`
      )
      .join('');
    return `<div class="meta">${cells}</div>`;
  }

  /** Klickbares Label, sofern der Teil betretbar ist. */
  private static link(p: InspectPart, cls: string): string {
    const label = esc(p.label);
    if (p.navigable === false) {
      return `<span class="${cls} dead" title="nicht gebunden">${label}</span>`;
    }
    return `<a class="${cls}" href="#" data-index="${p.index}" data-label="${label}">${label}</a>`;
  }

  private static renderPairs(
    parts: InspectPart[],
    leftHead: string,
    rightHead: string
  ): string {
    if (parts.length === 0) return '<div class="empty">Keine Teile.</div>';
    const rows = parts
      .map(
        p =>
          `<div class="row">${this.link(p, 'k')}<span class="v">${esc(
            p.preview ?? ''
          )}</span></div>`
      )
      .join('');
    return `
      ${this.filterBar(parts.length)}
      <div class="pairs">
        <div class="head">${esc(leftHead)}</div>
        <div class="head">${esc(rightHead)}</div>
        ${rows}
      </div>`;
  }

  private static renderIndexed(parts: InspectPart[]): string {
    if (parts.length === 0) return '<div class="empty">Leere Sequenz.</div>';
    const rows = parts
      .map(
        p =>
          `<div class="row">${this.link(p, 'idx')}<span class="v">${esc(
            p.preview ?? ''
          )}</span></div>`
      )
      .join('');
    return `
      ${this.filterBar(parts.length)}
      <div class="indexed">${rows}</div>`;
  }

  private static filterBar(count: number): string {
    if (count < 12) return '';
    return `<div class="filterbar">
      <input id="filter" type="text" placeholder="filtern …">
      <span id="filter-count">${count} Einträge</span>
    </div>`;
  }

  private static css(): string {
    return `
      body { font-family: var(--vscode-editor-font-family, monospace);
             font-size: 13px; padding: 12px;
             color: var(--vscode-foreground); }
      .bar { display: flex; align-items: center; gap: 8px;
             margin-bottom: 8px; }
      button { font: inherit; padding: 2px 10px; cursor: pointer;
               background: var(--vscode-button-background);
               color: var(--vscode-button-foreground);
               border: none; border-radius: 3px; }
      button:disabled { opacity: 0.4; cursor: default; }

      .kind { font-size: 11px; text-transform: uppercase;
              letter-spacing: 0.5px; padding: 1px 7px; border-radius: 9px;
              background: var(--vscode-badge-background);
              color: var(--vscode-badge-foreground); }
      .kind-hash-table { background: #7b5ea7; color: #fff; }
      .kind-object     { background: #2b6cb0; color: #fff; }
      .kind-struct     { background: #2c7a7b; color: #fff; }
      .kind-list       { background: #975a16; color: #fff; }
      .kind-vector     { background: #9c4221; color: #fff; }
      .kind-array      { background: #9c4221; color: #fff; }
      .kind-symbol     { background: #4a5568; color: #fff; }
      .kind-function   { background: #276749; color: #fff; }
      .kind-number     { background: #285e61; color: #fff; }
      .kind-string     { background: #744210; color: #fff; }
      .kind-error      { background: var(--vscode-errorForeground); color: #fff; }

      .type { color: var(--vscode-descriptionForeground); }
      .oid  { color: var(--vscode-descriptionForeground); opacity: 0.6;
              margin-left: auto; font-size: 11px; }

      .trail { margin-bottom: 10px; }
      .crumb { color: var(--vscode-textLink-foreground); text-decoration: none; }
      .crumb.here { color: var(--vscode-descriptionForeground); }
      .crumb.ellipsis { color: var(--vscode-descriptionForeground);
                        opacity: 0.7; cursor: default; }
      .trail { white-space: nowrap; overflow-x: auto; }
      .sep { opacity: 0.5; margin: 0 5px; }

      .meta { display: grid; grid-template-columns: max-content 1fr;
              gap: 2px 12px; margin-bottom: 12px;
              padding: 8px; border-radius: 4px;
              background: var(--vscode-textBlockQuote-background);
              border-left: 3px solid var(--vscode-textBlockQuote-border); }
      .meta-k { color: var(--vscode-descriptionForeground); }
      .meta-v { word-break: break-all; white-space: pre-wrap; }

      .print { white-space: pre-wrap; word-break: break-all;
               background: var(--vscode-textCodeBlock-background);
               padding: 8px; border-radius: 4px; margin-bottom: 12px; }

      .filterbar { display: flex; align-items: center; gap: 8px;
                   margin-bottom: 6px; }
      .filterbar input { font: inherit; flex: 1; padding: 3px 6px;
                         background: var(--vscode-input-background);
                         color: var(--vscode-input-foreground);
                         border: 1px solid var(--vscode-input-border, transparent);
                         border-radius: 3px; }
      #filter-count { color: var(--vscode-descriptionForeground);
                      font-size: 11px; white-space: nowrap; }

      .pairs { display: grid; grid-template-columns: max-content 1fr;
               gap: 0 14px; }
      .pairs .head { font-size: 11px; text-transform: uppercase;
                     color: var(--vscode-descriptionForeground);
                     border-bottom: 1px solid var(--vscode-panel-border);
                     padding-bottom: 3px; margin-bottom: 3px; }
      .pairs .row { display: contents; }
      .pairs .row > * {
        padding: 3px 0; border-bottom: 1px solid var(--vscode-panel-border); }

      .indexed .row { display: flex; gap: 10px; align-items: baseline;
                      padding: 3px 0;
                      border-bottom: 1px solid var(--vscode-panel-border); }
      .idx { min-width: 3.2em; text-align: right; flex: none;
             color: var(--vscode-textLink-foreground);
             text-decoration: none; }

      a { color: var(--vscode-textLink-foreground); text-decoration: none; }
      a:hover { text-decoration: underline; }
      .dead { color: var(--vscode-descriptionForeground); opacity: 0.6; }
      .v { white-space: pre-wrap; word-break: break-all; }
      .empty { color: var(--vscode-descriptionForeground); }
    `;
  }

  private static renderError(message: string): string {
    return `<!DOCTYPE html><html><body style="font-family:monospace;padding:12px;color:var(--vscode-errorForeground)">
      <b>Inspect-Fehler:</b><pre>${esc(message)}</pre></body></html>`;
  }
}

export async function inspectCommand(
  getClient: () => LanguageClient | undefined
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('CLAMPS: Kein aktiver Editor.');
    return;
  }

  // Bevorzugt die Auswahl; sonst das Symbol am Cursor; sonst die
  // Top-Level-Form.
  const selection = editor.document.getText(editor.selection).trim();
  const expr =
    selection.length > 0
      ? selection
      : symbolAt(editor.document, editor.selection.active) ??
        topLevelFormAt(editor.document, editor.selection.active);

  if (!expr) {
    vscode.window.showWarningMessage(
      'CLAMPS: Nichts zum Inspizieren am Cursor gefunden.'
    );
    return;
  }

  const client = getClient();
  if (!client || client.state !== State.Running) {
    vscode.window.showErrorMessage(
      'CLAMPS ist nicht verbunden. Führe „CLAMPS: Start“ aus.'
    );
    return;
  }

  const pkg = packageAt(editor.document, editor.selection.active);
  await ClampsInspector.inspect(getClient, expr, pkg);
}
