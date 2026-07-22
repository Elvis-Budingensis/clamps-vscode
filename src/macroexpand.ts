import * as vscode from 'vscode';
import { LanguageClient, State } from 'vscode-languageclient/node';

interface MacroexpandResult {
  output: string;
  package: string;
}

/**
 * Findet die Top-Level-Form, in der sich der Cursor befindet, indem von
 * der Cursor-Position aus rückwärts die umschließende öffnende Klammer
 * gesucht und dann bis zur passenden schließenden Klammer gelesen wird.
 *
 * Bewusst simpel gehalten: respektiert Strings, Zeichen-Literale (#\x)
 * und Zeilenkommentare (;), aber keine Block-Kommentare (#| |#). Für
 * typischen Lisp-Code am Cursor reicht das; der Rand-Fall Block-Kommentar
 * ist selten genug, um ihn hier nicht zu verkomplizieren.
 */
export function topLevelFormAt(
  document: vscode.TextDocument,
  position: vscode.Position
): string | undefined {
  const text = document.getText();
  const offset = document.offsetAt(position);

  // 1. Rückwärts die öffnende Klammer der Top-Level-Form finden:
  // die erste '(' auf Spaltentiefe 0, an oder vor dem Cursor.
  const start = findFormStart(text, offset);
  if (start < 0) return undefined;

  // 2. Von dort vorwärts bis zur passenden schließenden Klammer.
  const end = matchParen(text, start);
  if (end < 0) return undefined;

  return text.slice(start, end + 1);
}

/**
 * Findet die S-Expression, die unmittelbar vor der Cursor-Position endet
 * — das SLIME-Verhalten von C-x C-e (eval-last-expression). Sucht von
 * der Position aus rückwärts das erste ')' (überspringt Whitespace) und
 * dann die passende öffnende '('. Für ein Atom direkt vor dem Cursor
 * (z.B. eine Zahl oder ein Symbol) wird dieses Atom zurückgegeben.
 */
export function sexpBeforePoint(
  document: vscode.TextDocument,
  position: vscode.Position
): string | undefined {
  const text = document.getText();
  let offset = document.offsetAt(position);

  // Whitespace links vom Cursor überspringen.
  while (offset > 0 && /\s/.test(text[offset - 1])) offset--;
  if (offset === 0) return undefined;

  const prev = text[offset - 1];
  if (prev === ')') {
    // Klammerausdruck: von der schließenden Klammer zur passenden
    // öffnenden zurückbalancieren.
    let depth = 0;
    for (let i = offset - 1; i >= 0; i--) {
      const ch = text[i];
      // simple Version: Strings/Kommentare hier ignoriert, weil der
      // Cursor typischerweise direkt hinter einer echten Form steht.
      if (ch === ')') depth++;
      else if (ch === '(') {
        depth--;
        if (depth === 0) return text.slice(i, offset);
      }
    }
    return undefined;
  }
  // Atom: rückwärts bis zum Symbol-/Zahlanfang.
  let start = offset;
  while (start > 0 && /[a-zA-Z0-9\-+*/<>=!?_%&^~.:]/.test(text[start - 1])) {
    start--;
  }
  return start < offset ? text.slice(start, offset) : undefined;
}

function findFormStart(text: string, offset: number): number {
  // Wir scannen vom Dateianfang und merken uns den Beginn jeder
  // Top-Level-Form (depth 0 -> 1). Die letzte Form, die bei oder vor
  // dem Cursor beginnt und ihn noch enthält, ist die gesuchte.
  let depth = 0;
  let formStart = -1;
  let lastEnclosingStart = -1;
  const state = new ScanState();

  for (let i = 0; i < text.length; i++) {
    if (state.step(text, i)) continue; // in String/Kommentar/Char-Literal
    const ch = text[i];
    if (ch === '(') {
      if (depth === 0) formStart = i;
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0 && formStart >= 0) {
        // Form lief von formStart..i. Enthält sie den Cursor?
        if (formStart <= offset && offset <= i + 1) {
          lastEnclosingStart = formStart;
        }
        formStart = -1;
      }
    }
  }
  return lastEnclosingStart;
}

function matchParen(text: string, openIndex: number): number {
  let depth = 0;
  const state = new ScanState();
  for (let i = openIndex; i < text.length; i++) {
    if (state.step(text, i)) continue;
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Kleiner Scanner-Zustand, der erkennt, ob ein Zeichen "inaktiv" ist,
 * weil es in einem String, Zeilenkommentar oder Zeichen-Literal steht.
 * step() gibt true zurück, wenn das Zeichen an Index i übersprungen
 * werden soll (nicht als Klammer zählen).
 */
class ScanState {
  private inString = false;
  private inComment = false;
  private escapeNext = false;
  private skipCount = 0; // Zeichen nach #\ überspringen (Backslash + Literal)

  step(text: string, i: number): boolean {
    const ch = text[i];

    // Die zwei Zeichen unmittelbar nach '#' bei #\X (also '\' und 'X',
    // z. B. bei #\( das '\' und das '(') gelten als Literal, nie als
    // Klammer.
    if (this.skipCount > 0) {
      this.skipCount--;
      return true;
    }

    if (this.inComment) {
      if (ch === '\n') this.inComment = false;
      return true;
    }
    if (this.inString) {
      if (this.escapeNext) {
        this.escapeNext = false;
      } else if (ch === '\\') {
        this.escapeNext = true;
      } else if (ch === '"') {
        this.inString = false;
      }
      return true;
    }
    // nicht in String/Kommentar
    if (ch === ';') {
      this.inComment = true;
      return true;
    }
    if (ch === '"') {
      this.inString = true;
      return true;
    }
    // Zeichen-Literal #\X : dieses '#' ist neutral, aber das '\' und das
    // darauffolgende Zeichen sollen nicht als Klammer zählen.
    if (ch === '#' && text[i + 1] === '\\') {
      this.skipCount = 2; // überspringt '\' und das Literal-Zeichen
      return true;
    }
    return false;
  }
}

/**
 * Ermittelt das für die Cursor-Position gültige Paket, indem die letzte
 * (in-package ...)-Form vor oder an der Position aus dem Dokument gelesen
 * wird. Fällt auf COMMON-LISP-USER zurück, wenn keine gefunden wird.
 *
 * Erkennt die üblichen Schreibweisen:
 *   (in-package :foo)  (in-package #:foo)  (in-package "FOO")  (in-package foo)
 */
export function packageAt(
  document: vscode.TextDocument,
  position: vscode.Position
): string {
  const offset = document.offsetAt(position);
  const textBefore = document.getText().slice(0, offset + 1);
  // Alle in-package-Formen bis zum Cursor finden; die letzte gewinnt.
  const re = /\(\s*in-package\s+(?:#?:)?"?([a-zA-Z0-9\-+*/<>=!?_.%&^~]+)"?\s*\)/gi;
  let match: RegExpExecArray | null;
  let pkg = 'COMMON-LISP-USER';
  while ((match = re.exec(textBefore)) !== null) {
    pkg = match[1].toUpperCase();
  }
  return pkg;
}

export async function macroexpandCommand(
  getClient: () => LanguageClient | undefined,
  full: boolean,
  outputChannel: vscode.OutputChannel
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('CLAMPS: Kein aktiver Editor.');
    return;
  }

  const form = topLevelFormAt(editor.document, editor.selection.active);
  if (!form) {
    vscode.window.showWarningMessage(
      'CLAMPS: Keine Top-Level-Form am Cursor gefunden.'
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
    const result = await client.sendRequest<MacroexpandResult>(
      'clamps/macroexpand',
      { code: form, package: pkg, full }
    );

    const header = full
      ? ';; macroexpand (vollständig)\n'
      : ';; macroexpand-1 (eine Ebene)\n';
    const body = `${header};; Quelle:\n;; ${form.replace(/\n/g, '\n;; ')}\n\n${result.output}\n`;

    const doc = await vscode.workspace.openTextDocument({
      content: body,
      language: 'lisp',
    });
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: true,
      preserveFocus: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`Macroexpand-Fehler: ${message}`);
    vscode.window.showErrorMessage(`CLAMPS Macroexpand: ${message}`);
  }
}
