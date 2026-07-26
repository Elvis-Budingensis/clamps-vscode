// test/indentation.test.js
//
// Einrueckung: welche Spalte bekommt eine Fortsetzungszeile?
//
// Anlass: die Regeltabelle wurde nachgeschlagen und dann verworfen —
//
//     spaces = top.col + (rule === 0 ? 2 : 2);
//
// Beide Zweige 2. Damit hatte die komplette rules-Map keine Wirkung,
// weder die Defaults noch die per clamps/indentationRules aus dem
// laufenden Image geholten Regeln. Jede Zeile landete auf top.col + 2.
//
// Der sichtbare Unterschied ist der Funktionsaufruf: dessen Argumente
// richten sich in Lisp unter dem ERSTEN Argument aus, nicht auf +2.
//
// Aufruf: npx tsc -p ./ && node test/indentation.test.js

require('./vscode-stub');

const { ImageIndentationProvider } = require('../out/imageIndentation.js');

let failed = 0;
const check = (name, actual, expected) => {
  if (actual !== expected) {
    failed++;
    console.log(`FEHLER ${name}\n  erwartet: ${expected}\n  bekommen: ${actual}`);
  }
};

/** Minimaler TextDocument-Ersatz auf Basis eines mehrzeiligen Strings. */
function doc(text) {
  const lines = text.split('\n');
  return {
    lineCount: lines.length,
    lineAt: i => ({ text: lines[i] }),
    getText: range => {
      if (!range) return text;
      // Nur der im Provider benutzte Fall: (0,0) bis (line,0).
      return lines.slice(0, range.end.line).map(l => l + '\n').join('');
    },
  };
}

const provider = new ImageIndentationProvider(() => undefined);
// refresh() ohne Client ist ein No-op; die Defaults bleiben stehen.

// lineEdit ist privat in TypeScript, zur Laufzeit aber erreichbar.
// Sollte sich das aendern, faellt der Test sofort auf.
if (typeof provider.lineEdit !== 'function') {
  console.log('FEHLER lineEdit nicht erreichbar — Test muss angepasst werden');
  process.exit(1);
}

/**
 * Spalte, auf der ZEILE nach der Formatierung steht.
 *
 * Kein Edit heisst nicht "kein Ergebnis", sondern "steht schon richtig" —
 * dann ist die vorhandene Einrueckung das Ergebnis. Die erste Fassung
 * dieses Helfers gab dort undefined zurueck und liess den Test bei einer
 * bereits korrekten Zeile fehlschlagen.
 */
function indentOf(text, line) {
  const d = doc(text);
  const edits = provider.lineEdit(d, line);
  if (edits.length === 0) {
    const t = d.lineAt(line).text;
    return t.length - t.trimStart().length;
  }
  return edits[0].newText.length;
}

// ---------------------------------------------------------------------
// Makro-/Sonderform-Koerper: 2 ab der oeffnenden Klammer
// ---------------------------------------------------------------------
check('defun-Koerper', indentOf('(defun foo (x)\nbody', 1), 2);
check('when-Koerper', indentOf('(when test\nbody', 1), 2);
check('let-Koerper', indentOf('(let ((a 1))\nbody', 1), 2);
check('progn-Koerper', indentOf('(progn\nbody', 1), 2);
check('verschachtelt', indentOf('(defun foo (x)\n  (when x\nbody', 2), 4);

// ---------------------------------------------------------------------
// Funktionsaufruf: unter dem ERSTEN Argument ausrichten
// Das ist der Fall, den die verworfene Regel kaputt machte.
// ---------------------------------------------------------------------
// (mapcar #'car
//         rest)      <- Spalte 8 = 0 + 1 + len("mapcar") + 1
check('Funktionsaufruf richtet aus', indentOf("(mapcar #'car\nrest", 1), 8);
// (format t "~A"
//         x)
check('format', indentOf('(format t "~A"\nx', 1), 8);
// (+ 1
//    2)
check('kurzer Operator', indentOf('(+ 1\n2', 1), 3);

// ---------------------------------------------------------------------
// Schliessende Klammer
// ---------------------------------------------------------------------
check('schliessende Klammer im Koerper', indentOf('(defun foo (x)\n)', 1), 0);

// ---------------------------------------------------------------------
// Strings und Kommentare duerfen die Klammerrechnung nicht stoeren
// ---------------------------------------------------------------------
check('Klammer im String', indentOf('(defun foo ()\n  (format t "(")\nbody', 2), 2);
check('Klammer im Kommentar', indentOf('(defun foo () ; (\nbody', 1), 2);

// ---------------------------------------------------------------------
// Regeln aus dem Image muessen wirken
// ---------------------------------------------------------------------
// Ein CLAMPS-Makro, das die Defaults nicht kennen: ohne Regel wird es
// als Funktionsaufruf ausgerichtet, mit Regel als Koerper eingerueckt.
// "(" + "my-own-macro" (12) + " " = Spalte 14, dort steht das a.
check('unbekanntes Makro gilt als Aufruf',
  indentOf('(my-own-macro a\nb', 1), 14);
provider.rules.set('my-own-macro', 1);
check('Regel gesetzt -> Koerper',
  indentOf('(my-own-macro a\nb', 1), 2);

if (failed > 0) {
  console.log(`\n${failed} Test(s) fehlgeschlagen.`);
  process.exit(1);
}
console.log('ok — Einrueckung unterscheidet Makro-Koerper und Funktionsaufruf');
