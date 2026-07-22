import * as vscode from 'vscode';
import { LanguageClient, State } from 'vscode-languageclient/node';
import { packageAt } from './macroexpand';

interface DisassembleResult {
  output: string;
  package: string;
}

/**
 * Ermittelt das Lisp-Symbol an der Cursor-Position. Anders als ein
 * normales Wort dürfen Lisp-Symbole Sonderzeichen (Minus, Plus, Stern,
 * Slash, Vergleichszeichen, und weitere) sowie Paket-Trenner (Doppel-
 * punkt) enthalten. getWordRangeAtPosition mit passender Regex greift
 * das sauber ab.
 */
export function symbolAt(
  document: vscode.TextDocument,
  position: vscode.Position
): string | undefined {
  const range = document.getWordRangeAtPosition(
    position,
    /[a-zA-Z0-9\-+*/<>=!?_%&^~.:]+/
  );
  if (!range) return undefined;
  const text = document.getText(range).trim();
  return text.length > 0 ? text : undefined;
}

export async function disassembleCommand(
  getClient: () => LanguageClient | undefined,
  outputChannel: vscode.OutputChannel
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('CLAMPS: Kein aktiver Editor.');
    return;
  }

  const symbol = symbolAt(editor.document, editor.selection.active);
  if (!symbol) {
    vscode.window.showWarningMessage(
      'CLAMPS: Kein Symbol am Cursor gefunden.'
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

  try {
    const result = await client.sendRequest<DisassembleResult>(
      'clamps/disassemble',
      { symbol, package: pkg }
    );

    const body = `;; disassemble: ${symbol}  (Paket ${pkg})\n\n${result.output}\n`;

    const doc = await vscode.workspace.openTextDocument({
      content: body,
      // Kein 'lisp' — der Assembler-Output ist kein Lisp; plaintext
      // vermeidet unpassende Syntaxfärbung.
      language: 'plaintext',
    });
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: true,
      preserveFocus: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`Disassemble-Fehler: ${message}`);
    vscode.window.showErrorMessage(`CLAMPS Disassemble: ${message}`);
  }
}
