// test/paredit.test.js
//
// Structural editing: the scanner and the target computation.
//
// Why this needs a gate of its own: this module is the only one that
// CHANGES THE SOURCE. A wrong indentation is cosmetics, a wrong barf eats
// a paren and only shows up at the next load. What is checked is
// therefore not "the command exists" but the computed ranges.
//
// Two bugs were in it:
//
// 1. formRanges captured ONLY parenthesised expressions. In
//    (mapcar #'car list) there is not a single one — forwardSexp,
//    backwardSexp, slurp and barf simply did nothing there.
// 2. selectParentSexp check(ed) `!r.parentStart`. parentStart === 0 is
//    falsy, so the command aborted on the first form of every file.
//
// Run: npx tsc -p ./ && node test/paredit.test.js

require('./vscode-stub');

const {
  formRanges, containing, containingList, slurpTarget, barfTarget,
} = require('../out/structuralEditing.js');

let failed = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) {
    failed++;
    console.log(`FAILED ${name}\n  expected: ${e}\n  got:      ${a}`);
  }
};

/** A range as a source excerpt, so that failure messages are readable. */
const txt = (text, r) => (r ? text.slice(r.start, r.end) : undefined);

// ---------------------------------------------------------------------
// The scanner: atoms AND lists
// ---------------------------------------------------------------------
{
  const t = '(foo bar)';
  const rs = formRanges(t);
  check('lists and atoms captured', rs.map(r => txt(t, r)).sort(),
    ['(foo bar)', 'bar', 'foo']);
}
{
  // The case from practice: no parenthesised subexpression.
  const t = "(mapcar #'car liste)";
  const rs = formRanges(t);
  check('Reader-Makro bleibt am Atom', rs.map(r => txt(t, r)).sort(),
    ["#'car", "(mapcar #'car liste)", 'liste', 'mapcar']);
}
{
  const t = '(a "b (c" d)';
  const rs = formRanges(t);
  check('a paren in a string is not a form', rs.filter(r => r.list).length, 1);
  check('a string is an atom', rs.map(r => txt(t, r)).includes('"b (c"'), true);
}
{
  const t = '(a ; (b\n c)';
  check('a comment produces no form',
    formRanges(t).map(r => txt(t, r)).sort(), ['(a ; (b\n c)', 'a', 'c']);
}
{
  const t = '(a #\\( b)';
  check('the character literal #\\( does not count as a paren',
    formRanges(t).filter(r => r.list).length, 1);
}

// ---------------------------------------------------------------------
// Parent assignment — the parentStart === 0 case
// ---------------------------------------------------------------------
{
  const t = '(defun foo (x)\n  (+ x 1))';
  const rs = formRanges(t);
  const inner = rs.find(r => txt(t, r) === '(+ x 1)');
  check('the parent of the inner form starts at 0', inner.parentStart, 0);
  // This is exactly where the bug sat: 0 is falsy.
  check('parentStart 0 is not undefined', inner.parentStart === undefined, false);
  const outer = rs.find(r => r.start === 0);
  check('the outer form has no parent', outer.parentStart, undefined);
}
{
  const t = '(a (b (c)))';
  const rs = formRanges(t);
  const c = rs.find(r => txt(t, r) === '(c)');
  check('the parent is the SMALLEST enclosing form', txt(t, { start: c.parentStart, end: c.parentEnd }), '(b (c))');
}

// ---------------------------------------------------------------------
// containing / containingList
// ---------------------------------------------------------------------
{
  const t = '(foo bar)';
  check('containing returns the atom at the cursor', txt(t, containing(formRanges(t), 6)), 'bar');
  check('containingList steps over the atom', txt(t, containingList(formRanges(t), 6)), '(foo bar)');
}

// ---------------------------------------------------------------------
// slurp: the neighbour at the SAME level
// ---------------------------------------------------------------------
{
  const t = '(a) (b)';
  const rs = formRanges(t);
  check('slurp pulls in the next form', txt(t, slurpTarget(rs, containingList(rs, 1))), '(b)');
}
{
  // Without atoms in the scanner there was nothing to get here.
  const t = '(a) b';
  const rs = formRanges(t);
  check('slurp pulls in an atom too', txt(t, slurpTarget(rs, containingList(rs, 1))), 'b');
}
{
  // No neighbour at the same level: do nothing, rather than reaching out
  // of the parent form.
  const t = '((a) )';
  const rs = formRanges(t);
  const inner = rs.find(r => txt(t, r) === '(a)');
  check('no neighbour -> no target', slurpTarget(rs, inner), undefined);
}

// ---------------------------------------------------------------------
// barf: letztes direktes Kind
// ---------------------------------------------------------------------
{
  const t = '(a b c)';
  const rs = formRanges(t);
  check('barf takes the last atom', txt(t, barfTarget(rs, containingList(rs, 1))), 'c');
}
{
  const t = '(a (b) (c))';
  const rs = formRanges(t);
  check('barf takes the last subform', txt(t, barfTarget(rs, containingList(rs, 1))), '(c)');
}
{
  const t = '(a (b c))';
  const rs = formRanges(t);
  // DIRECT children only: c is in (b c), not in the outer form.
  check('barf does not reach into grandchildren', txt(t, barfTarget(rs, containingList(rs, 1))), '(b c)');
}
{
  const t = '()';
  const rs = formRanges(t);
  check('an empty form has no child', barfTarget(rs, containingList(rs, 1)), undefined);
}

// ---------------------------------------------------------------------
// Unbalanced parens must not blow up
// ---------------------------------------------------------------------
for (const t of ['(((', ')))', '(a (b', '"unterminiert', '#| offen']) {
  try {
    formRanges(t);
  } catch (e) {
    failed++;
    console.log(`FAILED formRanges throws on ${JSON.stringify(t)}: ${e.message}`);
  }
}

if (failed > 0) {
  console.log(`\n${failed} Test(s) fehlgeschlagen.`);
  process.exit(1);
}
console.log('ok — the Paredit scanner captures atoms; parent assignment and slurp/barf targets are right');
