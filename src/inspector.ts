import * as vscode from 'vscode';
import { LanguageClient, State } from 'vscode-languageclient/node';
import { packageAt, topLevelFormAt } from './macroexpand';
import { symbolAt } from './disassemble';

interface InspectPart {
  label: string;
  accessor: string;
}
interface InspectResult {
  type: string;
  print: string;
  parts: InspectPart[];
  package: string;
}

/**
 * Der Inspector ist zustandsbehaftet: ein einzelnes Webview-Panel, das
 * das aktuell inspizierte Objekt zeigt und eine Navigations-Historie
 * führt (zurück zu übergeordneten Objekten). Anders als Macroexpand/
 * Disassemble (einmalige Textausgabe) klickt man sich hier durch
 * Objekt-Slots — jeder Klick löst eine neue clamps/inspect-Anfrage mit
 * dem Accessor-Ausdruck des Slots aus.
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
    // Sofort sichtbarer Inhalt — vorher blieb das Panel leer, wenn der
    // erste load() früh abbrach, und man sah nur eine weiße Fläche.
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

  private static render(expr: string, r: InspectResult): string {
    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const canBack = this.history.length > 1;

    const partsHtml =
      r.parts.length > 0
        ? r.parts
            .map(
              p =>
                `<li><a href="#" data-accessor="${esc(p.accessor)}">${esc(
                  p.label
                )}</a></li>`
            )
            .join('')
        : '<li class="empty">Keine navigierbaren Teile (atomarer Wert).</li>';

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body { font-family: var(--vscode-editor-font-family, monospace);
             font-size: 13px; padding: 12px;
             color: var(--vscode-foreground); }
      .bar { margin-bottom: 12px; }
      button { font: inherit; padding: 2px 10px; cursor: pointer;
               background: var(--vscode-button-background);
               color: var(--vscode-button-foreground);
               border: none; border-radius: 3px; }
      button:disabled { opacity: 0.4; cursor: default; }
      .expr { color: var(--vscode-descriptionForeground); word-break: break-all; }
      .type { font-weight: bold; margin: 8px 0 2px; }
      .print { white-space: pre-wrap; word-break: break-all;
               background: var(--vscode-textCodeBlock-background);
               padding: 8px; border-radius: 4px; margin-bottom: 12px; }
      ul { list-style: none; padding: 0; margin: 0; }
      li { padding: 3px 0; border-bottom: 1px solid var(--vscode-panel-border); }
      li a { color: var(--vscode-textLink-foreground); text-decoration: none; }
      li a:hover { text-decoration: underline; }
      li.empty { color: var(--vscode-descriptionForeground); border: none; }
    </style></head><body>
      <div class="bar"><button id="back" ${canBack ? '' : 'disabled'}>← Zurück</button></div>
      <div class="expr">${esc(expr)}</div>
      <div class="type">${esc(r.type)}</div>
      <div class="print">${esc(r.print)}</div>
      <ul>${partsHtml}</ul>
      <script>
        const vscode = acquireVsCodeApi();
        document.getElementById('back').addEventListener('click', () =>
          vscode.postMessage({ command: 'back' }));
        for (const a of document.querySelectorAll('a[data-accessor]')) {
          a.addEventListener('click', e => {
            e.preventDefault();
            vscode.postMessage({ command: 'navigate', accessor: a.dataset.accessor });
          });
        }
      </script>
    </body></html>`;
  }

  private static renderError(message: string): string {
    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  // Top-Level-Form. So kann man ein *var*, einen Ausdruck oder eine
  // markierte Region inspizieren.
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
