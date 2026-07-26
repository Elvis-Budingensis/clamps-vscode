import * as vscode from 'vscode';
import { LanguageClient, State } from 'vscode-languageclient/node';

export interface XrefEntry {
  label: string;
  description?: string;
  detail?: string;
  file?: string;
  line?: number;
  character?: number;
  offset?: number;
  inspect?: string;
}

export interface XrefResult {
  available: boolean;
  error?: string;
  entries: XrefEntry[];
}

export interface XrefGroup {
  kind: string;
  label: string;
  entries: XrefEntry[];
  error?: string;
}

type XrefTreeNode =
  | { type: 'root'; symbol: string; packageName: string }
  | { type: 'group'; group: XrefGroup }
  | { type: 'entry'; entry: XrefEntry };

export const XREF_KINDS: ReadonlyArray<{ kind: string; label: string }> = [
  { kind: 'definitions', label: 'Definitionen' },
  { kind: 'callers', label: 'Aufrufer' },
  { kind: 'callees', label: 'Aufgerufene Funktionen' },
  { kind: 'references', label: 'Referenzen' },
  { kind: 'bindings', label: 'Bindungen' },
  { kind: 'setters', label: 'Setzer' },
  { kind: 'macroexpands', label: 'Makroexpansionen' },
];

/**
 * Sprungziel eines Treffers.
 *
 * Der OFFSET hat Vorrang, nicht die Zeile. Beide sind gesetzt nur, wenn
 * der Quellort tatsächlich (:line …) UND (:position …) enthält, und dann
 * bezeichnen sie dieselbe Stelle — die Reihenfolge kostet also nichts.
 * Sie schützt aber gegen den Fehler, der hier zweimal auftrat: sobald
 * irgendwo ein Vorgabewert line=1 durchrutscht, landet jeder Sprung am
 * Dateianfang, während der daneben stehende Offset korrekt wäre.
 * SBCL liefert in Quellorten fast immer nur (:position N).
 */
export function entryPosition(entry: XrefEntry, doc: vscode.TextDocument): vscode.Position {
  if (entry.offset !== undefined && entry.offset !== null) {
    return doc.positionAt(Math.max(0, entry.offset - 1));
  }
  if (entry.line !== undefined && entry.line !== null) {
    return new vscode.Position(Math.max(0, entry.line - 1), Math.max(0, entry.character ?? 0));
  }
  return new vscode.Position(0, 0);
}

export async function openXrefEntry(entry: XrefEntry): Promise<void> {
  if (entry.file) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(entry.file));
    const pos = entryPosition(entry, doc);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    return;
  }
  if (entry.inspect) {
    await vscode.commands.executeCommand('clamps.inspect', entry.inspect, 'COMMON-LISP-USER');
    return;
  }
  void vscode.window.showInformationMessage(entry.detail || `${entry.label}: keine Quelldatei verfügbar.`);
}

export class XrefBrowserProvider implements vscode.TreeDataProvider<XrefTreeNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<XrefTreeNode | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;
  private symbol = '';
  private packageName = 'COMMON-LISP-USER';
  private groups: XrefGroup[] = [];
  private loading = false;

  constructor(private readonly getClient: () => LanguageClient | undefined) {}
  dispose(): void { this.changed.dispose(); }

  async search(symbol: string, packageName: string, kinds = XREF_KINDS): Promise<void> {
    if (this.loading) {
      // Sieben Abfragen laufen parallel; ein zweiter Aufruf währenddessen
      // wurde bisher kommentarlos verworfen und sah wie ein Hänger aus.
      void vscode.window.showInformationMessage(
        `XREF läuft noch (${this.symbol}) — bitte abwarten.`
      );
      return;
    }
    const client = this.getClient();
    if (!client || client.state !== State.Running) {
      void vscode.window.showErrorMessage('CLAMPS ist nicht verbunden.');
      return;
    }
    this.loading = true;
    this.symbol = symbol;
    this.packageName = packageName;
    this.groups = kinds.map(k => ({ kind: k.kind, label: k.label, entries: [] }));
    this.changed.fire();
    try {
      const results = await Promise.all(kinds.map(async k => {
        try {
          const result = await client.sendRequest<XrefResult>('clamps/xref', {
            symbol, package: packageName, kind: k.kind,
          });
          return {
            kind: k.kind,
            label: k.label,
            entries: result.available && Array.isArray(result.entries) ? result.entries : [],
            error: result.available ? undefined : (result.error || 'Nicht verfügbar.'),
          } satisfies XrefGroup;
        } catch (error) {
          return {
            kind: k.kind,
            label: k.label,
            entries: [],
            error: error instanceof Error ? error.message : String(error),
          } satisfies XrefGroup;
        }
      }));
      this.groups = results;
    } finally {
      this.loading = false;
      this.changed.fire();
    }
  }

  async refresh(): Promise<void> {
    if (this.symbol) await this.search(this.symbol, this.packageName);
  }

  getTreeItem(node: XrefTreeNode): vscode.TreeItem {
    if (node.type === 'root') {
      const item = new vscode.TreeItem(
        `${node.packageName}::${node.symbol}`,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.iconPath = new vscode.ThemeIcon('symbol-key');
      item.tooltip = `XREF für ${node.symbol} im Paket ${node.packageName}`;
      return item;
    }
    if (node.type === 'group') {
      const count = node.group.entries.length;
      const item = new vscode.TreeItem(
        node.group.label,
        count ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
      );
      item.description = node.group.error ? node.group.error : String(count);
      item.iconPath = new vscode.ThemeIcon(node.group.error ? 'warning' : 'references');
      item.contextValue = 'clampsXrefGroup';
      return item;
    }
    const e = node.entry;
    const item = new vscode.TreeItem(e.label, vscode.TreeItemCollapsibleState.None);
    item.description = e.description;
    item.tooltip = e.detail || [e.label, e.description].filter(Boolean).join(' — ');
    item.iconPath = new vscode.ThemeIcon(e.file ? 'go-to-file' : 'symbol-misc');
    item.contextValue = 'clampsXrefEntry';
    item.command = { command: 'clamps.xrefOpen', title: 'XREF-Treffer öffnen', arguments: [e] };
    return item;
  }

  getChildren(node?: XrefTreeNode): XrefTreeNode[] {
    if (!node) {
      if (!this.symbol) return [];
      return [{ type: 'root', symbol: this.symbol, packageName: this.packageName }];
    }
    if (node.type === 'root') return this.groups.map(group => ({ type: 'group', group }));
    if (node.type === 'group') return node.group.entries.map(entry => ({ type: 'entry', entry }));
    return [];
  }
}
