import * as vscode from 'vscode';
import { LanguageClient, State } from 'vscode-languageclient/node';

interface MacroexpandResult {
  output: string;
  package: string;
}

/**
 * Finds the top-level form the cursor is in, by searching backwards from
 * the cursor position for the enclosing opening paren and then reading
 * forward to the matching closing paren.
 *
 * Deliberately kept simple: respects strings, character literals (#\x)
 * and line comments (;), but not block comments (#| |#). That is enough
 * for typical Lisp code at the cursor; the block-comment edge case is
 * rare enough not to complicate matters here.
 */
export function topLevelFormAt(
  document: vscode.TextDocument,
  position: vscode.Position
): string | undefined {
  const text = document.getText();
  const offset = document.offsetAt(position);

  // 1. Search backwards for the opening paren of the top-level form:
  // the first '(' at depth 0, at or before the cursor.
  const start = findFormStart(text, offset);
  if (start < 0) {
    // No parenthesised expression at the cursor — but a bare atom at top
    // level IS a valid form. Wanting to evaluate `*presentation-test*`,
    // `6` or `t` on a line of its own is normal, and sexpBeforePoint
    // (evalLastExpression) has long been able to do it. Only evalTopLevel
    // reported "No top-level form found at the cursor" and did nothing.
    return topLevelAtomAt(text, offset);
  }

  // 2. From there forward to the matching closing paren.
  const end = matchParen(text, start);
  if (end < 0) return undefined;

  return text.slice(start, end + 1);
}

/** Characters that belong to a Lisp atom. As in sexpBeforePoint. */
const ATOM_CHAR = /[a-zA-Z0-9\-+*/<>=!?_%&^~.:#'@$[\]{}]/;

/**
 * The atom at or immediately before OFFSET, provided it really is at top
 * level (paren depth 0) and not inside a string or comment. Otherwise
 * undefined.
 */
function topLevelAtomAt(text: string, offset: number): string | undefined {
  if (!isTopLevelCode(text, offset)) return undefined;

  // If the cursor is behind the atom (typically at end of line), move
  // left — but only across spaces and tabs, NOT across newlines.
  // Otherwise at the start of an empty line the atom of the line above
  // would be evaluated without anyone seeing it.
  let probe = offset;
  while (probe > 0 && (text[probe - 1] === ' ' || text[probe - 1] === '\t')) probe--;

  let start = probe;
  while (start > 0 && ATOM_CHAR.test(text[start - 1])) start--;
  let end = probe;
  while (end < text.length && ATOM_CHAR.test(text[end])) end++;

  if (end <= start) return undefined;
  const atom = text.slice(start, end);
  // A bare dot or a single quotation mark is not a form.
  return /[a-zA-Z0-9*+\-/<>=!?_%&^~]/.test(atom) ? atom : undefined;
}

/**
 * Is OFFSET real code at paren depth 0 — that is, not inside a form, a
 * string or a comment?
 */
function isTopLevelCode(text: string, offset: number): boolean {
  let depth = 0;
  const state = new ScanState();
  const limit = Math.min(offset, text.length);
  for (let i = 0; i < limit; i++) {
    if (state.step(text, i)) continue;
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
  }
  if (depth !== 0) return false;
  // Additionally check that the position itself is not inside a string
  // or comment: state.step has carried the state along up to offset.
  return !state.inactive;
}

/**
 * Finds the s-expression that ends immediately before the cursor
 * position — the SLIME behaviour of C-x C-e (eval-last-expression).
 * Searches backwards from the position for the first ')' (skipping
 * whitespace) and then the matching opening '('. For an atom directly
 * before the cursor (a number or a symbol, say) that atom is returned.
 */
export function sexpBeforePoint(
  document: vscode.TextDocument,
  position: vscode.Position
): string | undefined {
  const text = document.getText();
  let offset = document.offsetAt(position);

  // Skip whitespace to the left of the cursor.
  while (offset > 0 && /\s/.test(text[offset - 1])) offset--;
  if (offset === 0) return undefined;

  const prev = text[offset - 1];
  if (prev === ')') {
    // Parenthesised expression: balance back from the closing paren to
    // the matching opening one.
    let depth = 0;
    for (let i = offset - 1; i >= 0; i--) {
      const ch = text[i];
      // simple version: strings/comments ignored here, because the
      // cursor typically sits directly behind a real form.
      if (ch === ')') depth++;
      else if (ch === '(') {
        depth--;
        if (depth === 0) return text.slice(i, offset);
      }
    }
    return undefined;
  }
  // Atom: backwards to the start of the symbol or number.
  let start = offset;
  while (start > 0 && /[a-zA-Z0-9\-+*/<>=!?_%&^~.:]/.test(text[start - 1])) {
    start--;
  }
  return start < offset ? text.slice(start, offset) : undefined;
}

function findFormStart(text: string, offset: number): number {
  // We scan from the start of the file and remember the beginning of
  // every top-level form (depth 0 -> 1). The last form that begins at or
  // before the cursor and still contains it is the one we want.
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
        // Form ran from formStart..i. Does it contain the cursor?
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
 * A small scanner state that recognises whether a character is
 * "inactive" because it sits inside a string, a line comment or a
 * character literal. step() returns true when the character at index i
 * should be skipped (not counted as a paren).
 */
class ScanState {
  private inString = false;
  private inComment = false;
  private escapeNext = false;
  private skipCount = 0; // skip characters after #\ (backslash + literal)

  /** Is the scanner currently inside a string, comment or character literal? */
  get inactive(): boolean {
    return this.inString || this.inComment || this.skipCount > 0;
  }

  step(text: string, i: number): boolean {
    const ch = text[i];

    // The two characters immediately after '#' in #\X (that is, '\' and
    // 'X', for example in #\( the '\' and the '(') count as a literal,
    // never as a paren.
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
    // not inside a string or comment
    if (ch === ';') {
      this.inComment = true;
      return true;
    }
    if (ch === '"') {
      this.inString = true;
      return true;
    }
    // Character literal #\X : this '#' is neutral, but the '\' and the
    // character following it must not count as a paren.
    if (ch === '#' && text[i + 1] === '\\') {
      this.skipCount = 2; // skips '\' and the literal character
      return true;
    }
    return false;
  }
}

/**
 * Determines the package in effect at the cursor position by reading the
 * last (in-package ...) form before or at the position from the
 * document. Falls back to COMMON-LISP-USER when none is found.
 *
 * Recognises the usual spellings:
 *   (in-package :foo)  (in-package #:foo)  (in-package "FOO")  (in-package foo)
 */
export function packageAt(
  document: vscode.TextDocument,
  position: vscode.Position
): string {
  const offset = document.offsetAt(position);
  const textBefore = document.getText().slice(0, offset + 1);
  // Find all in-package forms up to the cursor; the last one wins.
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
      'CLAMPS is not connected. Run "CLAMPS: Start".'
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
      ? ';; macroexpand (fully)\n'
      : ';; macroexpand-1 (one level)\n';
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
    outputChannel.appendLine(`Macroexpand error: ${message}`);
    vscode.window.showErrorMessage(`CLAMPS Macroexpand: ${message}`);
  }
}
