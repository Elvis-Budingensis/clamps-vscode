// test/lispstring.test.js
//
// Regressionstest für die Maskierung von Strings, die als LISP-QUELLTEXT
// über den Swank-Draht gehen.
//
// Der Fehler: JSON.stringify erzeugt \n, \t und \uXXXX. Der Lisp-Reader
// kennt in Strings nur \\ und \" — jedes andere \x liest er als das
// nackte Zeichen x. Aus einem Zeilenumbruch wurde damit der Buchstabe n,
// und eine mehrzeilige REPL-Eingabe
//
//     (dsp! simple (freq amp)
//       (with-samples ((in (sine freq amp 0)))
//         (out in in)))
//
// kam im Image als (dsp! simple (freq amp) n (with-samples … n …)) an.
// SBCL meldete "undefined variable: n" — an einem Symbol, das im
// Quelltext nirgends steht. Backslash und Anführungszeichen maskieren
// beide Schreibweisen gleich, deshalb fiel es bei einzeiligen Eingaben
// nie auf.
//
// Aufruf: npx tsc -p ./ && node test/lispstring.test.js

require('./vscode-stub');

const fs = require('fs');
const path = require('path');
const { lispString, printSexpr, Sym } = require('../out/swank.js');

let failed = 0;
const check = (name, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++;
    console.log(`FEHLER ${name}\n  erwartet: ${JSON.stringify(expected)}\n  bekommen: ${JSON.stringify(actual)}`);
  }
};

// ---------------------------------------------------------------------
// lispString: nur \\ und \" werden maskiert
// ---------------------------------------------------------------------
check('einfacher Text', lispString('abc'), '"abc"');
// Der Kern: ein echter Umbruch bleibt ein echter Umbruch. Er ist in einem
// Lisp-Stringliteral gültig, und der Swank-Rahmen zählt Bytes.
check('Umbruch bleibt Umbruch', lispString('a\nb'), '"a\nb"');
check('kein Backslash-n', lispString('a\nb').includes('\\n'), false);
check('Tabulator bleibt Tabulator', lispString('a\tb'), '"a\tb"');
check('Anfuehrungszeichen maskiert', lispString('sag "hallo"'), '"sag \\"hallo\\""');
check('Backslash maskiert', lispString('c:\\pfad'), '"c:\\\\pfad"');
// Umlaute gehen als UTF-8 durch; der Rahmen zählt Bytes, nicht Zeichen.
check('Umlaut unveraendert', lispString('grün'), '"grün"');

// Gegenprobe: genau hier weicht JSON.stringify ab.
check('JSON weicht bei Umbruch ab',
  JSON.stringify('a\nb') === lispString('a\nb'), false);
check('JSON und Lisp gleich bei Anfuehrungszeichen',
  JSON.stringify('sag "hallo"') === lispString('sag "hallo"'), true);

// ---------------------------------------------------------------------
// printSexpr benutzt dieselbe Maskierung
// ---------------------------------------------------------------------
check('printSexpr String', printSexpr('a\nb'), '"a\nb"');
check('printSexpr Liste',
  printSexpr([new Sym(':foo'), 'a\nb', 12]), '(:foo "a\nb" 12)');
check('printSexpr Symbol bleibt roh', printSexpr(new Sym('t')), 't');

// ---------------------------------------------------------------------
// Das erwartete Ergebnis am Beispiel der gemeldeten Eingabe
// ---------------------------------------------------------------------
{
  const code = '(dsp! simple (freq amp)\n  (with-samples ((in (sine freq amp 0)))\n    (out in in)))';
  const form = `(clamps-bridge-rpc:eval-for-repl-debuggable ${lispString(code)} ${lispString('CLAMPS')})`;
  check('Form enthaelt echte Umbrueche', (form.match(/\n/g) || []).length, 2);
  check('Form enthaelt kein Backslash-n', form.includes('\\n'), false);
  // Zeilenweise gelesen ist die Form unvollständig — genau deshalb zählt
  // der Swank-Rahmen Bytes und liest nicht bis zum Zeilenende.
  check('Form ist mehrzeilig', form.split('\n').length, 3);
}

// ---------------------------------------------------------------------
// Statische Sperre: kein JSON.stringify in Lisp-Quelltext
// ---------------------------------------------------------------------
// Der eigentliche Schutz. Die Regel ist nicht "lispString existiert",
// sondern "wer Lisp-Quelltext baut, benutzt es auch" — und die lässt sich
// nur an den Aufrufstellen prüfen.
{
  const lispish = ['(swank:', '(swank/', '(clamps-bridge-rpc:', ':emacs-rex',
                   ':emacs-return-string', '(setf ', '(intern '];
  const offenders = [];
  for (const file of ['swank.ts', 'debugSession.ts', 'replTerminal.ts',
                      'inspector.ts', 'macroexpand.ts', 'slimeTools.ts',
                      'disassemble.ts', 'nodeBrowser.ts', 'imageBrowsers.ts',
                      'xrefBrowser.ts', 'inlineValues.ts', 'rtStatus.ts',
                      'compilerDiagnostics.ts', 'extension.ts',
                      'processManager.ts']) {
    const full = path.join(__dirname, '..', 'src', file);
    if (!fs.existsSync(full)) continue;
    const lines = fs.readFileSync(full, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const code = line.replace(/^\s*(\/\/|\*).*/, '');
      if (code.includes('JSON.stringify') && lispish.some(m => code.includes(m))) {
        offenders.push(`${file}:${i + 1}`);
      }
    });
  }
  check('kein JSON.stringify in Lisp-Formen', offenders, []);
}

if (failed === 0) console.log('ok — Lisp-Maskierung stimmt, mehrzeilige Eingaben bleiben heil');
process.exit(failed === 0 ? 0 : 1);
