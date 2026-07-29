import * as vscode from 'vscode';
import { LanguageClient, State } from 'vscode-languageclient/node';
import { xrefNavigationHistory } from './xrefNavigation';

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
  { kind: 'definitions', label: 'Definitions' },
  { kind: 'callers', label: 'Callers' },
  { kind: 'callees', label: 'Callees' },
  { kind: 'references', label: 'References' },
  { kind: 'bindings', label: 'Bindings' },
  { kind: 'setters', label: 'Setters' },
  { kind: 'macroexpands', label: 'Macroexpansions' },
];

/**
 * Jump target of a hit.
 *
 * The OFFSET takes precedence, not the line. Both are set only when the
 * source location actually contains (:line …) AND (:position …), and
 * then they denote the same place — so the ordering costs nothing. But
 * it guards against the bug that occurred here twice: as soon as a
 * default of line=1 slips through anywhere, every jump lands at the
 * start of the file while the offset next to it would have been correct.
 * In source locations SBCL almost always supplies only (:position N).
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
    xrefNavigationHistory.captureCurrent();
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
  void vscode.window.showInformationMessage(entry.detail || `${entry.label}: no source file available.`);
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
      // Seven queries run in parallel; a second call in the meantime was
      // previously discarded without comment and looked like a hang.
      void vscode.window.showInformationMessage(
        `XREF is still running (${this.symbol}) — please wait.`
      );
      return;
    }
    const client = this.getClient();
    if (!client || client.state !== State.Running) {
      void vscode.window.showErrorMessage('CLAMPS is not connected.');
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
            error: result.available ? undefined : (result.error || 'Not available.'),
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
      item.tooltip = `XREF for ${node.symbol} in package ${node.packageName}`;
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
    item.command = { command: 'clamps.xrefOpen', title: 'Open XREF hit', arguments: [e] };
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
