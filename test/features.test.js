// test/features.test.js
//
// Inline values and the inspector history — the parts that are checkable
// without an editor and without an image.
//
// Run: npx tsc -p ./ && node test/features.test.js

require('./vscode-stub');

const { symbolTokens, matchLocals, shorten } = require('../out/inlineValues.js');
const { ClampsInspector } = require('../out/inspector.js');

let failed = 0;
const check = (name, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++;
    console.log(`FAILED ${name}\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(actual)}`);
  }
};
const names = line => symbolTokens(line).map(t => t.text);

// ---------------------------------------------------------------------
// symbolTokens: Lisp symbol names, not words
// ---------------------------------------------------------------------
check('einfache Form', names('(foo bar)'), ['foo', 'bar']);
// The reason we use InlineValueText rather than VariableLookup: VS Code
// cuts only "foo" out of *foo*.
check('Sternchen bleiben dran', names('(setf *foo* 1)'), ['setf', '*foo*', '1']);
check('Bindestriche', names('(rt-start)'), ['rt-start']);
check('a package prefix as one token', names('(incudine:node-id n)'), ['incudine:node-id', 'n']);
check('a predicate with a question mark', names('(evenp x?)'), ['evenp', 'x?']);
check('Vergleichsoperatoren', names('(<= a b)'), ['<=', 'a', 'b']);

// Strings and comments are left out: a local named N must not be marked
// inside "n times" or behind a ;.
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
check('no match', matchLocals('(rt-start)', locals), []);
check('not inside a string', matchLocals('(format t "n")', locals), []);

// Only ONE entry per local per line — at the last occurrence, because by
// then the assignment has usually already happened.
{
  const m = matchLocals('(setq n (+ n 1))', locals);
  check('only one entry for N', m.length, 1);
  check('letztes Vorkommen', m[0].start, '(setq n (+ '.length);
}

// A package-qualified name should match the bare local.
check('Paketpraefix ignoriert',
  matchLocals('(print cl-user::n)', locals).map(m => m.name), ['N']);

// ---------------------------------------------------------------------
// shorten
// ---------------------------------------------------------------------
check('kurz bleibt kurz', shorten('7'), '7');
check('Umbrueche zu Leerzeichen', shorten('(1\n 2)'), '(1 2)');
check('a long value is truncated', shorten('x'.repeat(80)).length, 60);
check('with an ellipsis', shorten('x'.repeat(80)).endsWith('…'), true);

// ---------------------------------------------------------------------
// The inspector history: a history, not a path
// ---------------------------------------------------------------------
{
  const I = ClampsInspector;
  const reset = () => { I.history = []; I.historyIndex = -1; I.navigatingHistory = false; };

  reset();
  I.recordHistory(1, 'a');
  I.recordHistory(2, 'b');
  I.recordHistory(3, 'c');
  check('three entries', I.history.map(h => h.label), ['a', 'b', 'c']);
  check('Index am Ende', I.historyIndex, 2);

  // Not the same page twice — refreshing and setting a part deliver the
  // same entry several times over.
  I.recordHistory(3, 'c');
  check('no duplicate', I.history.length, 3);

  // Back and then a new jump: the rest BEFORE the index falls away, as in
  // a browser.
  I.historyIndex = 1;
  I.recordHistory(9, 'z');
  check('Vorwaerts-Teil abgeschnitten', I.history.map(h => h.label), ['a', 'b', 'z']);
  check('the index is on the new one', I.historyIndex, 2);

  // Nothing may be written while going back/forward, otherwise the
  // history grows while paging through it.
  I.navigatingHistory = true;
  I.recordHistory(42, 'ignoriert');
  check('back/forward does not write', I.history.length, 3);
  I.navigatingHistory = false;

  // A cap: the history holds IDs of the object table in the image.
  reset();
  for (let i = 0; i < 60; i++) I.recordHistory(i, `o${i}`);
  check('capped at 50', I.history.length, 50);
  check('neueste behalten', I.history[I.history.length - 1].label, 'o59');
  check('Index innerhalb', I.historyIndex, 49);
  reset();
}

if (failed === 0) console.log('ok — all feature tests passed');
process.exit(failed === 0 ? 0 : 1);
