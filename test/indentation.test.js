// test/indentation.test.js
//
// Indentation: which column does a continuation line get?
//
// The occasion: the rule table was looked up and then thrown away —
//
//     spaces = top.col + (rule === 0 ? 2 : 2);
//
// Both branches 2. That left the complete rules map without effect,
// neither the defaults nor the rules fetched from the running image via
// clamps/indentationRules. Every line ended up at top.col + 2.
//
// The visible difference is the function call: in Lisp its arguments align
// under the FIRST argument, not at +2.
//
// Run: npx tsc -p ./ && node test/indentation.test.js

require('./vscode-stub');

const { ImageIndentationProvider } = require('../out/imageIndentation.js');

let failed = 0;
const check = (name, actual, expected) => {
  if (actual !== expected) {
    failed++;
    console.log(`FAILED ${name}\n  expected: ${expected}\n  got:      ${actual}`);
  }
};

/** A minimal TextDocument substitute based on a multi-line string. */
function doc(text) {
  const lines = text.split('\n');
  return {
    lineCount: lines.length,
    lineAt: i => ({ text: lines[i] }),
    getText: range => {
      if (!range) return text;
      // Only the case used in the provider: (0,0) to (line,0).
      return lines.slice(0, range.end.line).map(l => l + '\n').join('');
    },
  };
}

const provider = new ImageIndentationProvider(() => undefined);
// refresh() without a client is a no-op; the defaults stay in place.

// lineEdit is private in TypeScript but reachable at runtime. Should that
// change, the test fails immediately.
if (typeof provider.lineEdit !== 'function') {
  console.log('FAILED lineEdit is not reachable — the test has to be adjusted');
  process.exit(1);
}

/**
 * The column LINE stands at after formatting.
 *
 * No edit does not mean "no result" but "already in the right place" —
 * then the existing indentation is the result. The first version of this
 * helper returned undefined there and let the test fail on an already
 * correct line.
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
// A macro/special form body: 2 from the opening paren
// ---------------------------------------------------------------------
check('defun-Koerper', indentOf('(defun foo (x)\nbody', 1), 2);
check('when-Koerper', indentOf('(when test\nbody', 1), 2);
check('let-Koerper', indentOf('(let ((a 1))\nbody', 1), 2);
check('progn-Koerper', indentOf('(progn\nbody', 1), 2);
check('verschachtelt', indentOf('(defun foo (x)\n  (when x\nbody', 2), 4);

// ---------------------------------------------------------------------
// A function call: align under the FIRST argument
// This is the case the discarded rule broke.
// ---------------------------------------------------------------------
// (mapcar #'car
//         rest)      <- column 8 = 0 + 1 + len("mapcar") + 1
check('a function call aligns', indentOf("(mapcar #'car\nrest", 1), 8);
// (format t "~A"
//         x)
check('format', indentOf('(format t "~A"\nx', 1), 8);
// (+ 1
//    2)
check('kurzer Operator', indentOf('(+ 1\n2', 1), 3);

// ---------------------------------------------------------------------
// A closing paren
// ---------------------------------------------------------------------
check('a closing paren in the body', indentOf('(defun foo (x)\n)', 1), 0);

// ---------------------------------------------------------------------
// Strings and comments must not disturb the paren arithmetic
// ---------------------------------------------------------------------
check('a paren inside a string', indentOf('(defun foo ()\n  (format t "(")\nbody', 2), 2);
check('a paren inside a comment', indentOf('(defun foo () ; (\nbody', 1), 2);

// ---------------------------------------------------------------------
// Rules from the image have to take effect
// ---------------------------------------------------------------------
// A CLAMPS macro the defaults do not know: without a rule it is aligned
// as a function call, with a rule indented as a body.
// "(" + "my-own-macro" (12) + " " = column 14, where the a stands.
check('an unknown macro counts as a call',
  indentOf('(my-own-macro a\nb', 1), 14);
provider.rules.set('my-own-macro', 1);
check('Regel gesetzt -> Koerper',
  indentOf('(my-own-macro a\nb', 1), 2);

if (failed > 0) {
  console.log(`\n${failed} Test(s) fehlgeschlagen.`);
  process.exit(1);
}
console.log('ok — indentation tells a macro body from a function call apart');
