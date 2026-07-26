// test/toplevel.test.js
//
// topLevelFormAt: welche Form liegt am Cursor?
//
// Anlass: die Funktion suchte ausschliesslich nach einer '(' auf
// Klammertiefe 0. Ein nacktes Atom auf Top-Level — `*presentation-test*`,
// `6`, `t` in einer eigenen Zeile — ist aber eine voellig gueltige Form.
// evalTopLevel meldete dort "Keine Top-Level-Form am Cursor gefunden" und
// tat nichts, waehrend evalLastExpression (sexpBeforePoint) dasselbe Atom
// seit immer korrekt auswertet. Zwei Befehle, zwei Meinungen.
//
// Aufruf: npx tsc -p ./ && node test/toplevel.test.js

require('./vscode-stub');

const { topLevelFormAt } = require('../out/macroexpand.js');

let failed = 0;
const check = (name, actual, expected) => {
  if (actual !== expected) {
    failed++;
    console.log(`FEHLER ${name}\n  erwartet: ${JSON.stringify(expected)}\n  bekommen: ${JSON.stringify(actual)}`);
  }
};

/**
 * Minimaler TextDocument-Ersatz. Der Cursor wird im Quelltext mit | 
 * markiert; das Zeichen wird vor dem Test entfernt. So steht in jedem
 * Fall sichtbar, wo der Cursor sitzt.
 */
function docAt(markedText) {
  const offset = markedText.indexOf('|');
  if (offset < 0) throw new Error('Testtext ohne | Cursor-Markierung');
  const text = markedText.slice(0, offset) + markedText.slice(offset + 1);
  return {
    document: {
      getText: () => text,
      offsetAt: () => offset,
    },
    position: {},
  };
}

const at = marked => {
  const { document, position } = docAt(marked);
  return topLevelFormAt(document, position);
};

// ---------------------------------------------------------------------
// Klammerformen: unveraendertes Verhalten
// ---------------------------------------------------------------------
check('Cursor in Klammerform', at('(defun foo (x)\n  (+ x |1))\n'), '(defun foo (x)\n  (+ x 1))');
check('Cursor auf oeffnender Klammer', at('|(foo 3)\n'), '(foo 3)');
check('zweite von zwei Formen', at('(foo 1)\n(bar |2)\n'), '(bar 2)');
check('Klammer im String zaehlt nicht', at('(format t "(|" )\n'), '(format t "(" )');

// ---------------------------------------------------------------------
// Atom-Toplevel: der reparierte Fall
// ---------------------------------------------------------------------
check('Symbol mit Sternchen', at('(defparameter *pt* 1)\n*p|t*\n'), '*pt*');
check('Cursor am Atom-Ende', at('*pt*|\n'), '*pt*');
check('Cursor hinter Atom mit Leerzeichen', at('*pt*  |\n'), '*pt*');
check('Zahl', at('6|\n'), '6');
check('Symbol mit Paketpraefix', at('incudine:rt-|start\n'), 'incudine:rt-start');
check('Symbol mit Bindestrich', at('|rt-status\n'), 'rt-status');
check('Atom nach einer Klammerform', at('(foo 1)\n\n*p|t*\n'), '*pt*');

// ---------------------------------------------------------------------
// Was NICHT ausloesen darf
// ---------------------------------------------------------------------
// Leere Zeile: sonst wuerde das Atom der Zeile darueber ausgewertet,
// ohne dass der Cursor darauf steht.
check('leere Zeile unter Atom', at('*pt*\n|\n'), undefined);
check('leere Datei', at('|'), undefined);
check('nur Leerzeichen', at('   |   '), undefined);
// Im Kommentar steht kein Code.
check('Atom im Kommentar', at('; *p|t*\n'), undefined);
// In einem String auch nicht — hier ohne umgebende Form, damit wirklich
// der String-Zustand greift und nicht die Klammerlogik.
check('Atom im String', at('"*p|t*"\n'), undefined);
// Ein Atom INNERHALB einer Form darf nicht als Toplevel gelten: dort
// gewinnt die Klammerform, nicht das Atom.
check('Atom in Form liefert die Form', at('(foo b|ar)\n'), '(foo bar)');

if (failed > 0) {
  console.log(`\n${failed} Test(s) fehlgeschlagen.`);
  process.exit(1);
}
console.log('ok — Top-Level-Form erkennt Klammerformen und Atome, ignoriert Strings und Kommentare');
