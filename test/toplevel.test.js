// test/toplevel.test.js
//
// topLevelFormAt: which form is at the cursor?
//
// The occasion: the function searched exclusively for a '(' at paren
// depth 0. But a bare atom at top level — `*presentation-test*`, `6`, `t`
// on a line of its own — is a perfectly valid form. evalTopLevel reported
// "No top-level form found at the cursor" there and did nothing, while
// evalLastExpression (sexpBeforePoint) has always evaluated that same atom
// correctly. Two commands, two opinions.
//
// Run: npx tsc -p ./ && node test/toplevel.test.js

require('./vscode-stub');

const { topLevelFormAt } = require('../out/macroexpand.js');

let failed = 0;
const check = (name, actual, expected) => {
  if (actual !== expected) {
    failed++;
    console.log(`FAILED ${name}\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(actual)}`);
  }
};

/**
 * A minimal TextDocument substitute. The cursor is marked in the source
 * with |; the character is removed before the test. That way it is
 * visible in every case where the cursor sits.
 */
function docAt(markedText) {
  const offset = markedText.indexOf('|');
  if (offset < 0) throw new Error('test text without a | cursor marker');
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
// Parenthesised forms: unchanged behaviour
// ---------------------------------------------------------------------
check('cursor inside a parenthesised form', at('(defun foo (x)\n  (+ x |1))\n'), '(defun foo (x)\n  (+ x 1))');
check('cursor on the opening paren', at('|(foo 3)\n'), '(foo 3)');
check('the second of two forms', at('(foo 1)\n(bar |2)\n'), '(bar 2)');
check('a paren in a string does not count', at('(format t "(|" )\n'), '(format t "(" )');

// ---------------------------------------------------------------------
// An atom at top level: the repaired case
// ---------------------------------------------------------------------
check('a symbol with asterisks', at('(defparameter *pt* 1)\n*p|t*\n'), '*pt*');
check('Cursor am Atom-Ende', at('*pt*|\n'), '*pt*');
check('cursor behind an atom with spaces', at('*pt*  |\n'), '*pt*');
check('Zahl', at('6|\n'), '6');
check('a symbol with a package prefix', at('incudine:rt-|start\n'), 'incudine:rt-start');
check('a symbol with a hyphen', at('|rt-status\n'), 'rt-status');
check('an atom after a parenthesised form', at('(foo 1)\n\n*p|t*\n'), '*pt*');

// ---------------------------------------------------------------------
// What must NOT trigger
// ---------------------------------------------------------------------
// An empty line: otherwise the atom of the line above would be evaluated
// without the cursor being on it.
check('an empty line below an atom', at('*pt*\n|\n'), undefined);
check('an empty file', at('|'), undefined);
check('spaces only', at('   |   '), undefined);
// There is no code in a comment.
check('an atom in a comment', at('; *p|t*\n'), undefined);
// Nor in a string — here without a surrounding form, so that the string
// state really takes effect and not the paren logic.
check('an atom in a string', at('"*p|t*"\n'), undefined);
// An atom INSIDE a form must not count as top level: there the
// parenthesised form wins, not the atom.
check('an atom inside a form returns the form', at('(foo b|ar)\n'), '(foo bar)');

if (failed > 0) {
  console.log(`\n${failed} Test(s) fehlgeschlagen.`);
  process.exit(1);
}
console.log('ok — top-level form recognises parenthesised forms and atoms, ignores strings and comments');
