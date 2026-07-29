// test/hover.test.js
//
// Checks the pure functions from swank.js without a running Lisp image.
// Run: npx tsc -p ./ && node test/hover.test.js
//
// The point: hoverCandidate decides whether a mouse movement can open a
// debugger level. A bug in it is visible only against a running image —
// and expensive there.

require('./vscode-stub');
const { hoverCandidate, lispString, splitTopLevelForms } = require('../out/swank.js');

let failed = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed++;
    console.log(`FAILED ${name}\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(actual)}`);
  }
};
const pass = (name, input, expected = input) => check(name, hoverCandidate(input), expected);
const reject = (name, input) => check(name, hoverCandidate(input), undefined);

// --- erlaubt ---------------------------------------------------------
pass('Symbol', 'foo');
pass('a symbol with a package', 'incudine:node');
pass('balancierte Form', '(node-id n)');
pass('geschachtelt', '(car (cdr xs))');
pass('a character literal with a paren', '#\\(');
pass('a string with a paren', '"do (not) count"');
pass('Zahl', '42');
pass('getrimmt', '  foo  ', 'foo');

// --- rejected: the actual hole ---------------------------------------
reject('unlesbares Objekt', '#<unbound-variable rpc>');
reject('an unclosed paren', '(car xs');
reject('a surplus paren', 'xs)');
reject('offene Zeichenkette', '"unfertig');
reject('Read-Eval', '#.(sb-ext:quit)');
reject('Blockkommentar', '#| weg |#');

// --- rejected: no symbol under the mouse -----------------------------
reject('leer', '   ');
reject('mehrzeilig', 'foo\nbar');
reject('Tabulator', 'foo\tbar');
reject('zu lang', 'x'.repeat(121));
pass('Grenzlaenge', 'x'.repeat(120));

// --- lispString: escape only \\ and " ------------------------------
check('lispString einfach', lispString('foo'), '"foo"');
check('lispString Anfuehrung', lispString('a"b'), '"a\\"b"');
check('lispString Backslash', lispString('a\\b'), '"a\\\\b"');
// JSON.stringify would produce \n here, which the Lisp reader reads as
// "n". Control characters are already excluded by hoverCandidate; this
// test pins the expectation down.
check('lispString leaves an umlaut unchanged', lispString('grün'), '"grün"');

// --- splitTopLevelForms: Nachbarschaftsschutz -----------------------
check('zwei Formen', splitTopLevelForms('(+ 1 2) (+ 3 4)'), ['(+ 1 2)', '(+ 3 4)']);
check('a form with a character literal', splitTopLevelForms('(char= c #\\()'), ['(char= c #\\()']);


// --- describeBrowserError: make the death of the image readable ------
{
  const { describeBrowserError } = require('../out/imageBrowsers.js');
  const dead = describeBrowserError(
    new Error('Pending response rejected since connection got disposed'));
  check('lost connection recognised', /image has probably died/.test(dead), true);
  check('points at the log', /Open Log/.test(dead), true);
  check('unknown error stays verbatim',
    describeBrowserError(new Error('something else')), 'something else');
}

if (failed === 0) console.log('ok — all hover tests passed');
process.exit(failed === 0 ? 0 : 1);
