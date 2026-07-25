import * as vscode from 'vscode';
import { LanguageClient, State } from 'vscode-languageclient/node';
import { packageAt } from './macroexpand';
import { symbolAt } from './disassemble';

interface ToolEntry {
  label: string;
  description?: string;
  detail?: string;
  file?: string;
  line?: number;
  character?: number;
  /** Zeichen-Offset, wenn das Backend keine Zeile liefert (SBCL-Normalfall). */
  offset?: number;
  inspect?: string;
}
interface ToolResult { available: boolean; error?: string; entries: ToolEntry[]; }

function currentSymbolAndPackage(): { symbol: string; packageName: string } | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  const symbol = symbolAt(editor.document, editor.selection.active);
  if (!symbol) return undefined;
  return { symbol, packageName: packageAt(editor.document, editor.selection.active) };
}

async function requireClient(getClient: () => LanguageClient | undefined): Promise<LanguageClient | undefined> {
  const client = getClient();
  if (!client || client.state !== State.Running) {
    void vscode.window.showErrorMessage('CLAMPS ist nicht verbunden.');
    return undefined;
  }
  return client;
}

async function showEntries(title: string, entries: ToolEntry[]): Promise<void> {
  if (!entries.length) {
    void vscode.window.showInformationMessage(`${title}: keine Treffer.`);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    entries.map((e, i) => ({ label: e.label, description: e.description, detail: e.detail, index: i })),
    { title, matchOnDescription: true, matchOnDetail: true }
  );
  if (!picked) return;
  const e = entries[picked.index];
  if (e.file) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(e.file));
    // Offset bevorzugen, wo keine Zeile kommt: SBCL liefert in
    // Quellorten (:position N) mit N als Zeichen-Offset. positionAt
    // rechnet das gegen das offene Dokument um — genauer als selbst
    // Zeilenumbrueche zaehlen, weil VS Code die Zeilenenden kennt.
    const pos = e.line !== undefined && e.line !== null
      ? new vscode.Position(Math.max(0, e.line - 1), Math.max(0, e.character ?? 0))
      : e.offset !== undefined && e.offset !== null
        ? doc.positionAt(Math.max(0, e.offset - 1))
        : new vscode.Position(0, 0);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  } else if (e.inspect) {
    await vscode.commands.executeCommand('clamps.inspect', e.inspect, 'COMMON-LISP-USER');
  }
}

export async function xrefCommand(
  getClient: () => LanguageClient | undefined,
  kind?: string
): Promise<void> {
  const client = await requireClient(getClient); if (!client) return;
  const at = currentSymbolAndPackage();
  const symbol = at?.symbol ?? await vscode.window.showInputBox({ title: 'CLAMPS XREF', prompt: 'Symbol' });
  if (!symbol) return;
  const selectedKind = kind ?? await vscode.window.showQuickPick(
    [
      // "Definitionen" fehlt bewusst: swank:xref kennt den Typ nicht.
      // Dafuer gibt es "Gehe zu Definition" der Sprachunterstuetzung.
      { label: 'Aufrufer', value: 'callers' },
      { label: 'Aufgerufene Funktionen', value: 'callees' },
      { label: 'Referenzen', value: 'references' },
      { label: 'Bindungen', value: 'bindings' },
      { label: 'Setzer', value: 'setters' },
      { label: 'Makroexpansionen', value: 'macroexpands' },
    ], { title: `XREF: ${symbol}` }
  ).then((x: { value: string } | undefined) => x?.value);
  if (!selectedKind) return;
  const r = await client.sendRequest<ToolResult>('clamps/xref', {
    symbol, package: at?.packageName ?? 'COMMON-LISP-USER', kind: selectedKind,
  });
  if (!r.available) { void vscode.window.showErrorMessage(r.error ?? 'XREF nicht verfügbar.'); return; }
  await showEntries(`XREF ${selectedKind}: ${symbol}`, r.entries ?? []);
}

export async function aproposCommand(getClient: () => LanguageClient | undefined): Promise<void> {
  const client = await requireClient(getClient); if (!client) return;
  const query = await vscode.window.showInputBox({ title: 'CLAMPS Apropos', prompt: 'Namensbestandteil', value: currentSymbolAndPackage()?.symbol ?? '' });
  if (!query) return;
  const allPackages = await vscode.window.showQuickPick(
    [{label:'Aktuelles Paket', value:false},{label:'Alle Pakete', value:true}],
    { title: 'Suchbereich' }
  );
  if (!allPackages) return;
  const at = currentSymbolAndPackage();
  const r = await client.sendRequest<ToolResult>('clamps/apropos', {
    query, package: at?.packageName ?? 'COMMON-LISP-USER', allPackages: allPackages.value,
  });
  if (!r.available) { void vscode.window.showErrorMessage(r.error ?? 'Apropos nicht verfügbar.'); return; }
  await showEntries(`Apropos: ${query}`, r.entries ?? []);
}

export async function breakOnSignalsCommand(getClient: () => LanguageClient | undefined): Promise<void> {
  const client = await requireClient(getClient); if (!client) return;
  const value = await vscode.window.showInputBox({
    title: 'CLAMPS: Break on Signals',
    prompt: 'Condition-Typen, durch Leerzeichen getrennt; leer = ausschalten',
    placeHolder: 'warning type-error arithmetic-error',
  });
  if (value === undefined) return;
  const conditions = value.trim() ? value.trim().split(/\s+/) : [];
  const r = await client.sendRequest<{available:boolean; error?:string; conditions:string[]}>('clamps/breakOnSignals', { conditions });
  if (!r.available) { void vscode.window.showErrorMessage(r.error ?? 'Break-on-Signals nicht verfügbar.'); return; }
  void vscode.window.showInformationMessage(r.conditions.length ? `Break on Signals: ${r.conditions.join(', ')}` : 'Break on Signals ausgeschaltet.');
}
