import * as vscode from 'vscode';
import { LanguageClient, State } from 'vscode-languageclient/node';
import { packageAt } from './macroexpand';
import { symbolAt } from './disassemble';
import { XREF_KINDS, XrefBrowserProvider, openXrefEntry } from './xrefBrowser';

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
  await openXrefEntry(entries[picked.index]);
}

export async function xrefCommand(
  getClient: () => LanguageClient | undefined,
  browser?: XrefBrowserProvider,
  kind?: string
): Promise<void> {
  const client = await requireClient(getClient); if (!client) return;
  const at = currentSymbolAndPackage();
  const symbol = at?.symbol ?? await vscode.window.showInputBox({ title: 'CLAMPS XREF', prompt: 'Symbol' });
  if (!symbol) return;
  const packageName = at?.packageName ?? 'COMMON-LISP-USER';

  if (!kind && browser) {
    await browser.search(symbol, packageName);
    await vscode.commands.executeCommand('clamps.xrefView.focus');
    return;
  }

  const selectedKind = kind ?? await vscode.window.showQuickPick(
    XREF_KINDS.map(k => ({ label: k.label, value: k.kind })),
    { title: `XREF: ${symbol}` }
  ).then((x: { value: string } | undefined) => x?.value);
  if (!selectedKind) return;
  const r = await client.sendRequest<ToolResult>('clamps/xref', {
    symbol, package: packageName, kind: selectedKind,
  });
  if (!r.available) { void vscode.window.showErrorMessage(r.error ?? 'XREF nicht verfügbar.'); return; }
  const title = XREF_KINDS.find(k => k.kind === selectedKind)?.label ?? selectedKind;
  await showEntries(`XREF ${title}: ${symbol}`, r.entries ?? []);
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
