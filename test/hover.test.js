// test/hover.test.js
//
// Prüft die reinen Funktionen aus swank.js ohne laufendes Lisp-Image.
// Aufruf: npx tsc -p ./ && node test/hover.test.js
//
// Der Sinn: hoverCandidate entscheidet, ob eine Mausbewegung eine
// Debugger-Ebene öffnen kann. Ein Fehler darin ist erst am laufenden
// Image sichtbar — und dort teuer.

require('./vscode-stub');
const { hoverCandidate, lispString, splitTopLevelForms } = require('../out/swank.js');

let failed = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed++;
    console.log(`FEHLER ${name}\n  erwartet: ${JSON.stringify(expected)}\n  bekommen: ${JSON.stringify(actual)}`);
  }
};
const pass = (name, input, expected = input) => check(name, hoverCandidate(input), expected);
const reject = (name, input) => check(name, hoverCandidate(input), undefined);

// --- erlaubt ---------------------------------------------------------
pass('Symbol', 'foo');
pass('Symbol mit Paket', 'incudine:node');
pass('balancierte Form', '(node-id n)');
pass('geschachtelt', '(car (cdr xs))');
pass('Zeichenliteral mit Klammer', '#\\(');
pass('Zeichenkette mit Klammer', '"nicht (zu) zaehlen"');
pass('Zahl', '42');
pass('getrimmt', '  foo  ', 'foo');

// --- abgelehnt: das eigentliche Loch --------------------------------
reject('unlesbares Objekt', '#<unbound-variable rpc>');
reject('offene Klammer', '(car xs');
reject('ueberzaehlige Klammer', 'xs)');
reject('offene Zeichenkette', '"unfertig');
reject('Read-Eval', '#.(sb-ext:quit)');
reject('Blockkommentar', '#| weg |#');

// --- abgelehnt: kein Symbol unter der Maus --------------------------
reject('leer', '   ');
reject('mehrzeilig', 'foo\nbar');
reject('Tabulator', 'foo\tbar');
reject('zu lang', 'x'.repeat(121));
pass('Grenzlaenge', 'x'.repeat(120));

// --- lispString: nur \\ und " escapen ------------------------------
check('lispString einfach', lispString('foo'), '"foo"');
check('lispString Anfuehrung', lispString('a"b'), '"a\\"b"');
check('lispString Backslash', lispString('a\\b'), '"a\\\\b"');
// JSON.stringify wuerde hier \n erzeugen, was der Lisp-Reader als "n"
// liest. Steuerzeichen sind durch hoverCandidate bereits ausgeschlossen;
// dieser Test haelt die Erwartung fest.
check('lispString Umlaut unveraendert', lispString('grün'), '"grün"');

// --- splitTopLevelForms: Nachbarschaftsschutz -----------------------
check('zwei Formen', splitTopLevelForms('(+ 1 2) (+ 3 4)'), ['(+ 1 2)', '(+ 3 4)']);
check('Form mit Zeichenliteral', splitTopLevelForms('(char= c #\\()'), ['(char= c #\\()']);


// --- describeBrowserError: Tod des Images lesbar machen --------------
{
  const { describeBrowserError } = require('../out/imageBrowsers.js');
  const dead = describeBrowserError(
    new Error('Pending response rejected since connection got disposed'));
  check('Verbindungsabbruch erkannt', /Image gestorben/.test(dead), true);
  check('verweist aufs Protokoll', /Protokoll öffnen/.test(dead), true);
  check('unbekannter Fehler bleibt wörtlich',
    describeBrowserError(new Error('irgendwas anderes')), 'irgendwas anderes');
}

if (failed === 0) console.log('ok — alle Hover-Tests bestanden');
process.exit(failed === 0 ? 0 : 1);
