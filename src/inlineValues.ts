// inlineValues.ts
//
// Shows the values of the frame locals directly in the editor while Lisp
// is halted — behind the line in which the variable occurs.
//
// Why not VS Code's built-in variant: it only knows
// InlineValueVariableLookup, where the client cuts the name out of the
// text and asks the adapter. Lisp symbol names contain characters that
// VS Code does not recognise as part of a word (-, *, +, /, <, >, %),
// so *foo* becomes just "foo" and the lookup fails. This provider
// therefore reads the locals itself and supplies finished text
// (InlineValueText).

import * as vscode from 'vscode';

/**
 * Characters that may occur in a Lisp symbol name.
 *
 * Deliberately without parens, quotation marks, comma, semicolon and
 * backquote — those are separators. Colon is included so that
 * package-qualified names are recognised as ONE token.
 */
const SYMBOL_CHARS = /[A-Za-z0-9\-*+/<>=!?%&$_.:^~@[\]{}]/;

/**
 * Finds the symbol tokens of a line together with their column ranges.
 *
 * Strings and line comments are skipped: a local named X should not be
 * marked inside "text with x" or behind a ;. Character literals (#\()
 * likewise, otherwise the paren counts as a token.
 *
 * A pure function, so that it can be checked without an editor.
 */
export function symbolTokens(line: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ';') break;                       // Kommentar bis Zeilenende
    if (c === '"') {                            // skip a string
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === '#' && line[i + 1] === '\\') {    // Zeichenliteral
      i += 3;
      continue;
    }
    if (SYMBOL_CHARS.test(c)) {
      const start = i;
      while (i < line.length && SYMBOL_CHARS.test(line[i])) i++;
      out.push({ text: line.slice(start, i), start, end: i });
      continue;
    }
    i++;
  }
  return out;
}

/**
 * Maps locals to their occurrences in a line.
 *
 * Comparison is case-insensitive because the reader upcases: `n` in the
 * source is the local `N`. Package prefixes are cut off for the
 * comparison so that `foo:bar` matches the local `BAR`. Each local is
 * shown only ONCE per line — at the last occurrence, because by then the
 * assignment has usually already happened.
 */
export function matchLocals(
  line: string,
  locals: { name: string; value: string }[]
): { name: string; value: string; start: number; end: number }[] {
  const byName = new Map<string, { name: string; value: string }>();
  for (const l of locals) {
    const bare = l.name.replace(/^[^:]*::?/, '') || l.name;
    byName.set(bare.toUpperCase(), l);
  }
  const found = new Map<string, { name: string; value: string; start: number; end: number }>();
  for (const tok of symbolTokens(line)) {
    const bare = tok.text.replace(/^[^:]*::?/, '') || tok.text;
    const hit = byName.get(bare.toUpperCase());
    if (hit) {
      found.set(hit.name, { name: hit.name, value: hit.value, start: tok.start, end: tok.end });
    }
  }
  return [...found.values()];
}

/** Truncates long values so that the line stays readable. */
export function shorten(value: string, max = 60): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + '…';
}

export class ClampsInlineValuesProvider implements vscode.InlineValuesProvider {
  async provideInlineValues(
    document: vscode.TextDocument,
    viewPort: vscode.Range,
    context: vscode.InlineValueContext
  ): Promise<vscode.InlineValue[]> {
    const session = vscode.debug.activeDebugSession;
    if (!session || session.type !== 'clamps') return [];

    let locals: { name: string; value: string }[] = [];
    try {
      const r = await session.customRequest('clamps/frameLocals', {
        frameId: context.frameId,
      });
      locals = Array.isArray(r?.locals) ? r.locals : [];
    } catch {
      // Not halted, or the connection is gone — then simply no values.
      return [];
    }
    if (locals.length === 0) return [];

    const out: vscode.InlineValue[] = [];
    // Only down to the halted line: further down the values have not
    // been assigned yet, and showing them there would be a lie.
    const last = Math.min(viewPort.end.line, context.stoppedLocation.end.line);
    for (let line = viewPort.start.line; line <= last; line++) {
      const textLine = document.lineAt(line);
      for (const m of matchLocals(textLine.text, locals)) {
        out.push(
          new vscode.InlineValueText(
            new vscode.Range(line, m.start, line, m.end),
            `${m.name} = ${shorten(m.value)}`
          )
        );
      }
    }
    return out;
  }
}
