// test/paredit.test.js
//
// Strukturelles Editieren: Scanner und Zielberechnung.
//
// Warum das ein eigenes Gate braucht: dieses Modul ist das einzige, das
// den QUELLTEXT VERAENDERT. Eine falsche Einrueckung ist Kosmetik, ein
// falsches barf frisst eine Klammer und faellt erst beim naechsten Laden
// auf. Geprueft wird deshalb nicht "der Befehl existiert", sondern die
// berechneten Bereiche.
//
// Zwei Fehler waren drin:
//
// 1. formRanges erfasste NUR Klammerausdruecke. In (mapcar #'car liste)
//    gibt es keinen einzigen — forwardSexp, backwardSexp, slurp und barf
//    taten dort schlicht nichts.
// 2. selectParentSexp prueft(e) `!r.parentStart`. parentStart === 0 ist
//    falsy, also brach der Befehl bei der ersten Form jeder Datei ab.
//
// Aufruf: npx tsc -p ./ && node test/paredit.test.js

require('./vscode-stub');

const {
  formRanges, containing, containingList, slurpTarget, barfTarget,
} = require('../out/structuralEditing.js');

let failed = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) {
    failed++;
    console.log(`FEHLER ${name}\n  erwartet: ${e}\n  bekommen: ${a}`);
  }
};

/** Bereich als Quelltext-Ausschnitt, damit Fehlermeldungen lesbar sind. */
const txt = (text, r) => (r ? text.slice(r.start, r.end) : undefined);

// ---------------------------------------------------------------------
// Scanner: Atome UND Listen
// ---------------------------------------------------------------------
{
  const t = '(foo bar)';
  const rs = formRanges(t);
  check('Listen und Atome erfasst', rs.map(r => txt(t, r)).sort(),
    ['(foo bar)', 'bar', 'foo']);
}
{
  // Der Fall aus der Praxis: kein Unterausdruck in Klammern.
  const t = "(mapcar #'car liste)";
  const rs = formRanges(t);
  check('Reader-Makro bleibt am Atom', rs.map(r => txt(t, r)).sort(),
    ["#'car", "(mapcar #'car liste)", 'liste', 'mapcar']);
}
{
  const t = '(a "b (c" d)';
  const rs = formRanges(t);
  check('Klammer im String ist keine Form', rs.filter(r => r.list).length, 1);
  check('String ist ein Atom', rs.map(r => txt(t, r)).includes('"b (c"'), true);
}
{
  const t = '(a ; (b\n c)';
  check('Kommentar erzeugt keine Form',
    formRanges(t).map(r => txt(t, r)).sort(), ['(a ; (b\n c)', 'a', 'c']);
}
{
  const t = '(a #\\( b)';
  check('Zeichenliteral #\\( zaehlt nicht als Klammer',
    formRanges(t).filter(r => r.list).length, 1);
}

// ---------------------------------------------------------------------
// Elternzuordnung — der parentStart === 0 Fall
// ---------------------------------------------------------------------
{
  const t = '(defun foo (x)\n  (+ x 1))';
  const rs = formRanges(t);
  const inner = rs.find(r => txt(t, r) === '(+ x 1)');
  check('Eltern der inneren Form beginnen bei 0', inner.parentStart, 0);
  // Genau hier lag der Fehler: 0 ist falsy.
  check('parentStart 0 ist nicht undefined', inner.parentStart === undefined, false);
  const outer = rs.find(r => r.start === 0);
  check('aeussere Form hat keine Eltern', outer.parentStart, undefined);
}
{
  const t = '(a (b (c)))';
  const rs = formRanges(t);
  const c = rs.find(r => txt(t, r) === '(c)');
  check('Eltern sind die KLEINSTE umschliessende Form', txt(t, { start: c.parentStart, end: c.parentEnd }), '(b (c))');
}

// ---------------------------------------------------------------------
// containing / containingList
// ---------------------------------------------------------------------
{
  const t = '(foo bar)';
  check('containing liefert das Atom am Cursor', txt(t, containing(formRanges(t), 6)), 'bar');
  check('containingList ueberspringt das Atom', txt(t, containingList(formRanges(t), 6)), '(foo bar)');
}

// ---------------------------------------------------------------------
// slurp: Nachbar auf DERSELBEN Ebene
// ---------------------------------------------------------------------
{
  const t = '(a) (b)';
  const rs = formRanges(t);
  check('slurp zieht die naechste Form', txt(t, slurpTarget(rs, containingList(rs, 1))), '(b)');
}
{
  // Ohne Atome im Scanner war hier nichts zu holen.
  const t = '(a) b';
  const rs = formRanges(t);
  check('slurp zieht auch ein Atom', txt(t, slurpTarget(rs, containingList(rs, 1))), 'b');
}
{
  // Kein Nachbar auf gleicher Ebene: nichts tun, statt aus der
  // Elternform herauszugreifen.
  const t = '((a) )';
  const rs = formRanges(t);
  const inner = rs.find(r => txt(t, r) === '(a)');
  check('kein Nachbar -> kein Ziel', slurpTarget(rs, inner), undefined);
}

// ---------------------------------------------------------------------
// barf: letztes direktes Kind
// ---------------------------------------------------------------------
{
  const t = '(a b c)';
  const rs = formRanges(t);
  check('barf nimmt das letzte Atom', txt(t, barfTarget(rs, containingList(rs, 1))), 'c');
}
{
  const t = '(a (b) (c))';
  const rs = formRanges(t);
  check('barf nimmt die letzte Unterform', txt(t, barfTarget(rs, containingList(rs, 1))), '(c)');
}
{
  const t = '(a (b c))';
  const rs = formRanges(t);
  // Nur DIREKTE Kinder: c liegt in (b c), nicht in der aeusseren Form.
  check('barf greift nicht in Enkel', txt(t, barfTarget(rs, containingList(rs, 1))), '(b c)');
}
{
  const t = '()';
  const rs = formRanges(t);
  check('leere Form hat kein Kind', barfTarget(rs, containingList(rs, 1)), undefined);
}

// ---------------------------------------------------------------------
// Unbalancierte Klammern duerfen nicht knallen
// ---------------------------------------------------------------------
for (const t of ['(((', ')))', '(a (b', '"unterminiert', '#| offen']) {
  try {
    formRanges(t);
  } catch (e) {
    failed++;
    console.log(`FEHLER formRanges wirft bei ${JSON.stringify(t)}: ${e.message}`);
  }
}

if (failed > 0) {
  console.log(`\n${failed} Test(s) fehlgeschlagen.`);
  process.exit(1);
}
console.log('ok — Paredit-Scanner erfasst Atome, Elternzuordnung und slurp/barf-Ziele stimmen');
