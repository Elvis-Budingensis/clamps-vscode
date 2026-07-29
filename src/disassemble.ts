import * as vscode from 'vscode';
import { LanguageClient, State } from 'vscode-languageclient/node';
import { packageAt } from './macroexpand';

interface DisassembleResult {
  output: string;
  package: string;
}

/**
 * Determines the Lisp symbol at the cursor position. Unlike an ordinary
 * word, Lisp symbols may contain special characters (minus, plus, star,
 * slash, comparison signs and others) as well as package separators
 * (colon). getWordRangeAtPosition with a suitable regex picks that up
 * cleanly.
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
      'CLAMPS: No symbol found at the cursor.'
    );
    return;
  }

  const client = getClient();
  if (!client || client.state !== State.Running) {
    vscode.window.showErrorMessage(
      'CLAMPS is not connected. Run "CLAMPS: Start".'
    );
    return;
  }

  const pkg = packageAt(editor.document, editor.selection.active);

  try {
    const result = await client.sendRequest<DisassembleResult>(
      'clamps/disassemble',
      { symbol, package: pkg }
    );

    const body = `;; disassemble: ${symbol}  (package ${pkg})\n\n${result.output}\n`;

    const doc = await vscode.workspace.openTextDocument({
      content: body,
      // Not 'lisp' — the assembler output is not Lisp; plaintext
      // avoids inappropriate syntax colouring.
      language: 'plaintext',
    });
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: true,
      preserveFocus: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`Disassemble error: ${message}`);
    vscode.window.showErrorMessage(`CLAMPS Disassemble: ${message}`);
  }
}
