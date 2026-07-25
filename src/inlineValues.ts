// inlineValues.ts
//
// Zeigt die Werte der Frame-Locals direkt im Editor an, während Lisp
// angehalten ist — hinter der Zeile, in der die Variable vorkommt.
//
// Warum nicht VS Codes eingebaute Variante: die kennt nur
// InlineValueVariableLookup, wobei der Client den Namen aus dem Text
// schneidet und den Adapter fragt. Lisp-Symbolnamen enthalten Zeichen,
// die VS Code nicht als Wortbestandteil kennt (-, *, +, /, <, >, %),
// weshalb dabei aus *foo* nur "foo" wird und der Lookup fehlschlägt.
// Deshalb liest dieser Anbieter die Locals selbst und setzt fertigen
// Text (InlineValueText).

import * as vscode from 'vscode';

/**
 * Zeichen, die in einem Lisp-Symbolnamen vorkommen dürfen.
 *
 * Bewusst ohne Klammern, Anführungszeichen, Komma, Semikolon und
 * Backquote — das sind Trennzeichen. Doppelpunkt ist dabei, damit
 * paketqualifizierte Namen als EIN Token erkannt werden.
 */
const SYMBOL_CHARS = /[A-Za-z0-9\-*+/<>=!?%&$_.:^~@[\]{}]/;

/**
 * Findet die Symboltoken einer Zeile mit ihren Spaltenbereichen.
 *
 * Strings und Zeilenkommentare werden übersprungen: ein Local namens X
 * soll nicht in "text mit x" oder hinter einem ; markiert werden.
 * Zeichenliterale (#\() ebenfalls, sonst zählt die Klammer als Token.
 *
 * Reine Funktion, damit sie ohne Editor prüfbar ist.
 */
export function symbolTokens(line: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ';') break;                       // Kommentar bis Zeilenende
    if (c === '"') {                            // Zeichenkette überspringen
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
 * Ordnet Locals den Vorkommen in einer Zeile zu.
 *
 * Vergleich ohne Rücksicht auf Groß-/Kleinschreibung, weil der Reader
 * hochstellt: `n` im Quelltext ist das Local `N`. Paketpräfixe werden
 * beim Vergleich abgeschnitten, damit `foo:bar` auf das Local `BAR`
 * passt. Pro Zeile wird jedes Local nur EINMAL angezeigt — am letzten
 * Vorkommen, weil dort die Zuweisung meistens schon passiert ist.
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

/** Kürzt lange Werte, damit die Zeile nicht unlesbar wird. */
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
      // Nicht angehalten oder Verbindung weg — dann eben keine Werte.
      return [];
    }
    if (locals.length === 0) return [];

    const out: vscode.InlineValue[] = [];
    // Nur bis zur angehaltenen Zeile: weiter unten sind die Werte noch
    // nicht zugewiesen, und sie dort anzuzeigen wäre eine Lüge.
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
