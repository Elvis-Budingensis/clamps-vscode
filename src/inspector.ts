import * as vscode from 'vscode';
import { LanguageClient, State } from 'vscode-languageclient/node';
import { packageAt, topLevelFormAt } from './macroexpand';
import { symbolAt } from './disassemble';

interface InspectPart {
  label: string;
  accessor: string;
  /** Kurze Druckdarstellung des Wertes — spart einen Klick. */
  preview?: string;
}
interface InspectMeta {
  key: string;
  value: string;
}
interface InspectResult {
  /** Kategorie vom Lisp-Image: object, struct, list, vector, array,
   *  hash-table, string, symbol, function, number, character,
   *  pathname, package, atom, error. */
  kind?: string;
  type: string;
  print: string;
  parts: InspectPart[];
  meta?: InspectMeta[];
  package: string;
}

const esc = (s: string): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * Der Inspector ist zustandsbehaftet: ein einzelnes Webview-Panel, das
 * das aktuell inspizierte Objekt zeigt und eine Navigations-Historie
 * führt (zurück zu übergeordneten Objekten). Jeder Klick auf einen Slot
 * löst eine neue clamps/inspect-Anfrage mit dem Accessor-Ausdruck aus.
 *
 * Gerendert wird typspezifisch: eine Hash-Table sieht anders aus als ein
 * CLOS-Objekt oder ein Vektor. Die Kategorie liefert das Image als
 * `kind`; der Renderer wählt danach das Layout.
 */
export class ClampsInspector {
  private static panel: vscode.WebviewPanel | undefined;
  private static history: string[] = [];
  private static pkg = 'COMMON-LISP-USER';
  private static getClient: () => LanguageClient | undefined;

  static async inspect(
    getClient: () => LanguageClient | undefined,
    expr: string,
    pkg: string
  ): Promise<void> {
    this.getClient = getClient;
    this.pkg = pkg;
    this.history = [expr];
    await this.ensurePanel();
    await this.load(expr);
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
      this.history = [];
    });
    this.panel.webview.onDidReceiveMessage(async msg => {
      if (msg.command === 'navigate' && typeof msg.accessor === 'string') {
        this.history.push(msg.accessor);
        await this.load(msg.accessor);
      } else if (msg.command === 'back') {
        if (this.history.length > 1) {
          this.history.pop();
          await this.load(this.history[this.history.length - 1]);
        }
      }
    });
  }

  private static async load(expr: string): Promise<void> {
    if (!this.panel) return;
    const client = this.getClient();
    if (!client || client.state !== State.Running) {
      this.panel.webview.html = this.renderError(
        'CLAMPS ist nicht verbunden. Führe „CLAMPS: Start" aus.'
      );
      return;
    }

    try {
      const result = await client.sendRequest<InspectResult>('clamps/inspect', {
        expr,
        package: this.pkg,
      });
      if (result.package) this.pkg = result.package;
      this.panel.webview.html = this.render(expr, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.panel.webview.html = this.renderError(message);
    }
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  private static render(expr: string, r: InspectResult): string {
    const kind = r.kind || 'atom';
    const parts = r.parts ?? [];
    const meta = r.meta ?? [];

    const body = this.renderBody(kind, parts);
    const canBack = this.history.length > 1;

    // Bei skalaren Typen ist die Meta-Tabelle die eigentliche Information,
    // die print-Zeile also redundant — dann sparen wir sie uns.
    const scalar = ['number', 'character', 'string', 'pathname', 'package'];
    const showPrint = !(scalar.includes(kind) && meta.length > 0);

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      ${this.css()}
    </style></head><body>
      <div class="bar">
        <button id="back" ${canBack ? '' : 'disabled'}>← Zurück</button>
        <span class="kind kind-${esc(kind)}">${esc(kind)}</span>
        <span class="type">${esc(r.type)}</span>
      </div>
      <div class="expr" title="Inspizierter Ausdruck">${esc(expr)}</div>
      ${this.renderMeta(meta)}
      ${showPrint ? `<div class="print">${esc(r.print)}</div>` : ''}
      ${body}
      <script>
        const vscode = acquireVsCodeApi();
        const back = document.getElementById('back');
        if (back) back.addEventListener('click', () =>
          vscode.postMessage({ command: 'back' }));
        for (const a of document.querySelectorAll('[data-accessor]')) {
          a.addEventListener('click', e => {
            e.preventDefault();
            vscode.postMessage({
              command: 'navigate',
              accessor: a.dataset.accessor
            });
          });
        }
        // Filterfeld für lange Slot-/Element-Listen.
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
        return parts.length > 0
          ? this.renderPairs(parts, 'Teil', 'Wert')
          : '';
      case 'pathname':
        return this.renderPairs(parts, 'Komponente', 'Wert');
      default:
        return parts.length > 0
          ? this.renderPairs(parts, 'Teil', 'Wert')
          : '<div class="empty">Atomarer Wert — keine navigierbaren Teile.</div>';
    }
  }

  /** Kopfzeilen-Infos als kompaktes Key/Value-Raster. */
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

  /** Zweispaltig: Name/Schlüssel links (klickbar), Vorschau rechts. */
  private static renderPairs(
    parts: InspectPart[],
    leftHead: string,
    rightHead: string
  ): string {
    if (parts.length === 0) {
      return '<div class="empty">Keine Teile.</div>';
    }
    const rows = parts
      .map(
        p =>
          `<div class="row">
             <a class="k" href="#" data-accessor="${esc(p.accessor)}"
                title="${esc(p.accessor)}">${esc(p.label)}</a>
             <span class="v">${esc(p.preview ?? '')}</span>
           </div>`
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

  /** Sequenzen: schmaler Index-Badge links, Wert rechts. */
  private static renderIndexed(parts: InspectPart[]): string {
    if (parts.length === 0) {
      return '<div class="empty">Leere Sequenz.</div>';
    }
    const rows = parts
      .map(
        p =>
          `<div class="row">
             <a class="idx" href="#" data-accessor="${esc(p.accessor)}"
                title="${esc(p.accessor)}">${esc(p.label)}</a>
             <span class="v">${esc(p.preview ?? '')}</span>
           </div>`
      )
      .join('');
    return `
      ${this.filterBar(parts.length)}
      <div class="indexed">${rows}</div>`;
  }

  /** Ab einer gewissen Länge wird Suchen wichtiger als Scrollen. */
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
             margin-bottom: 10px; }
      button { font: inherit; padding: 2px 10px; cursor: pointer;
               background: var(--vscode-button-background);
               color: var(--vscode-button-foreground);
               border: none; border-radius: 3px; }
      button:disabled { opacity: 0.4; cursor: default; }

      /* Kategorie-Badge: sofort sichtbar, womit man es zu tun hat. */
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
      .expr { color: var(--vscode-descriptionForeground);
              word-break: break-all; margin-bottom: 10px; }

      .meta { display: grid; grid-template-columns: max-content 1fr;
              gap: 2px 12px; margin-bottom: 12px;
              padding: 8px; border-radius: 4px;
              background: var(--vscode-textBlockQuote-background);
              border-left: 3px solid var(--vscode-textBlockQuote-border); }
      .meta-k { color: var(--vscode-descriptionForeground); }
      .meta-v { word-break: break-all; }

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
      .pairs .row .k, .pairs .row .v {
        padding: 3px 0; border-bottom: 1px solid var(--vscode-panel-border); }

      .indexed .row { display: flex; gap: 10px; align-items: baseline;
                      padding: 3px 0;
                      border-bottom: 1px solid var(--vscode-panel-border); }
      .idx { min-width: 3.2em; text-align: right; flex: none;
             color: var(--vscode-textLink-foreground);
             text-decoration: none; }

      a { color: var(--vscode-textLink-foreground); text-decoration: none; }
      a:hover { text-decoration: underline; }
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
