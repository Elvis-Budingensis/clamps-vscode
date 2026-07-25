// test/features.test.js
//
// Inline Values und Inspector-Historie — die Teile, die ohne Editor und
// ohne Image prüfbar sind.
//
// Aufruf: npx tsc -p ./ && node test/features.test.js

require('./vscode-stub');

const { symbolTokens, matchLocals, shorten } = require('../out/inlineValues.js');
const { ClampsInspector } = require('../out/inspector.js');

let failed = 0;
const check = (name, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++;
    console.log(`FEHLER ${name}\n  erwartet: ${JSON.stringify(expected)}\n  bekommen: ${JSON.stringify(actual)}`);
  }
};
const names = line => symbolTokens(line).map(t => t.text);

// ---------------------------------------------------------------------
// symbolTokens: Lisp-Symbolnamen, nicht Wörter
// ---------------------------------------------------------------------
check('einfache Form', names('(foo bar)'), ['foo', 'bar']);
// Der Grund, warum wir InlineValueText statt VariableLookup benutzen:
// VS Code schneidet aus *foo* nur "foo" heraus.
check('Sternchen bleiben dran', names('(setf *foo* 1)'), ['setf', '*foo*', '1']);
check('Bindestriche', names('(rt-start)'), ['rt-start']);
check('Paketpraefix als ein Token', names('(incudine:node-id n)'), ['incudine:node-id', 'n']);
check('Praedikat mit Fragezeichen', names('(evenp x?)'), ['evenp', 'x?']);
check('Vergleichsoperatoren', names('(<= a b)'), ['<=', 'a', 'b']);

// Strings und Kommentare bleiben aussen vor: ein Local namens N darf
// nicht in "n mal" oder hinter einem ; markiert werden.
check('Zeichenkette uebersprungen', names('(format t "n mal ~A" n)'), ['format', 't', 'n']);
check('Kommentar abgeschnitten', names('(foo) ; bar baz'), ['foo']);
check('Zeichenliteral', names('(char= c #\\()'), ['char=', 'c']);
check('maskierte Anfuehrung', names('(f "a\\"n" n)'), ['f', 'n']);

// ---------------------------------------------------------------------
// matchLocals: Zuordnung Local -> Vorkommen
// ---------------------------------------------------------------------
const locals = [{ name: 'N', value: '7' }, { name: 'XS', value: '(1 2 3)' }];

check('Kleinschreibung trifft Local',
  matchLocals('(loop for x in xs repeat n)', locals).map(m => m.name).sort(), ['N', 'XS']);
check('kein Treffer', matchLocals('(rt-start)', locals), []);
check('nicht im String', matchLocals('(format t "n")', locals), []);

// Pro Zeile nur EIN Eintrag je Local — am letzten Vorkommen, weil dort
// die Zuweisung meistens schon passiert ist.
{
  const m = matchLocals('(setq n (+ n 1))', locals);
  check('nur ein Eintrag fuer N', m.length, 1);
  check('letztes Vorkommen', m[0].start, '(setq n (+ '.length);
}

// Paketqualifiziert soll auf das nackte Local passen.
check('Paketpraefix ignoriert',
  matchLocals('(print cl-user::n)', locals).map(m => m.name), ['N']);

// ---------------------------------------------------------------------
// shorten
// ---------------------------------------------------------------------
check('kurz bleibt kurz', shorten('7'), '7');
check('Umbrueche zu Leerzeichen', shorten('(1\n 2)'), '(1 2)');
check('lang wird gekuerzt', shorten('x'.repeat(80)).length, 60);
check('mit Auslassung', shorten('x'.repeat(80)).endsWith('…'), true);

// ---------------------------------------------------------------------
// Inspector-Historie: Verlauf, nicht Pfad
// ---------------------------------------------------------------------
{
  const I = ClampsInspector;
  const reset = () => { I.history = []; I.historyIndex = -1; I.navigatingHistory = false; };

  reset();
  I.recordHistory(1, 'a');
  I.recordHistory(2, 'b');
  I.recordHistory(3, 'c');
  check('drei Einträge', I.history.map(h => h.label), ['a', 'b', 'c']);
  check('Index am Ende', I.historyIndex, 2);

  // Dieselbe Ansicht nicht doppelt — Aktualisieren und Teil-Setzen
  // liefern denselben Eintrag mehrfach.
  I.recordHistory(3, 'c');
  check('kein Duplikat', I.history.length, 3);

  // Zurück und dann ein neuer Sprung: der Rest VOR dem Index fällt weg,
  // wie im Browser.
  I.historyIndex = 1;
  I.recordHistory(9, 'z');
  check('Vorwaerts-Teil abgeschnitten', I.history.map(h => h.label), ['a', 'b', 'z']);
  check('Index steht auf dem Neuen', I.historyIndex, 2);

  // Während Vor/Zurück darf nicht mitgeschrieben werden, sonst wächst
  // der Verlauf beim Durchblättern.
  I.navigatingHistory = true;
  I.recordHistory(42, 'ignoriert');
  check('Vor/Zurück schreibt nicht', I.history.length, 3);
  I.navigatingHistory = false;

  // Obergrenze: der Verlauf hält IDs der Objekt-Tabelle im Image fest.
  reset();
  for (let i = 0; i < 60; i++) I.recordHistory(i, `o${i}`);
  check('auf 50 begrenzt', I.history.length, 50);
  check('neueste behalten', I.history[I.history.length - 1].label, 'o59');
  check('Index innerhalb', I.historyIndex, 49);
  reset();
}

if (failed === 0) console.log('ok — alle Feature-Tests bestanden');
process.exit(failed === 0 ? 0 : 1);
