// test/lispstring.test.js
//
// A regression test for the escaping of strings that go over the Swank
// wire as LISP SOURCE.
//
// The bug: JSON.stringify produces \n, \t and \uXXXX. Inside strings the
// Lisp reader knows only \\ and \" — every other \x it reads as the bare
// character x. A newline thereby became the letter n, and a multi-line
// REPL input
//
//     (dsp! simple (freq amp)
//       (with-samples ((in (sine freq amp 0)))
//         (out in in)))
//
// arrived in the image as (dsp! simple (freq amp) n (with-samples … n …).
// SBCL reported "undefined variable: n" — on a symbol that appears nowhere
// in the source. Backslash and quotation mark are escaped the same way by
// both spellings, which is why it never showed up with single-line input.
//
// Run: npx tsc -p ./ && node test/lispstring.test.js

require('./vscode-stub');

const fs = require('fs');
const path = require('path');
const { lispString, printSexpr, Sym } = require('../out/swank.js');

let failed = 0;
const check = (name, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++;
    console.log(`FAILED ${name}\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(actual)}`);
  }
};

// ---------------------------------------------------------------------
// lispString: only \\ and \" are escaped
// ---------------------------------------------------------------------
check('einfacher Text', lispString('abc'), '"abc"');
// The core of it: a real newline stays a real newline. It is valid inside
// a Lisp string literal, and the Swank frame counts bytes.
check('Umbruch bleibt Umbruch', lispString('a\nb'), '"a\nb"');
check('no backslash-n', lispString('a\nb').includes('\\n'), false);
check('Tabulator bleibt Tabulator', lispString('a\tb'), '"a\tb"');
check('Anfuehrungszeichen maskiert', lispString('sag "hallo"'), '"sag \\"hallo\\""');
check('Backslash maskiert', lispString('c:\\pfad'), '"c:\\\\pfad"');
// Umlauts pass through as UTF-8; the frame counts bytes, not characters.
check('an umlaut is unchanged', lispString('grün'), '"grün"');

// The cross-check: this is exactly where JSON.stringify differs.
check('JSON differs on a newline',
  JSON.stringify('a\nb') === lispString('a\nb'), false);
check('JSON and Lisp agree on a quotation mark',
  JSON.stringify('sag "hallo"') === lispString('sag "hallo"'), true);

// ---------------------------------------------------------------------
// printSexpr benutzt dieselbe Maskierung
// ---------------------------------------------------------------------
check('printSexpr String', printSexpr('a\nb'), '"a\nb"');
check('printSexpr Liste',
  printSexpr([new Sym(':foo'), 'a\nb', 12]), '(:foo "a\nb" 12)');
check('printSexpr leaves a symbol raw', printSexpr(new Sym('t')), 't');

// ---------------------------------------------------------------------
// The expected result, using the reported input as the example
// ---------------------------------------------------------------------
{
  const code = '(dsp! simple (freq amp)\n  (with-samples ((in (sine freq amp 0)))\n    (out in in)))';
  const form = `(clamps-bridge-rpc:eval-for-repl-debuggable ${lispString(code)} ${lispString('CLAMPS')})`;
  check('Form enthaelt echte Umbrueche', (form.match(/\n/g) || []).length, 2);
  check('the form contains no backslash-n', form.includes('\\n'), false);
  // Read line by line the form is incomplete — which is exactly why the
  // Swank frame counts bytes and does not read to the end of the line.
  check('the form is multi-line', form.split('\n').length, 3);
}

// ---------------------------------------------------------------------
// A static guard: no JSON.stringify in Lisp source
// ---------------------------------------------------------------------
// The actual protection. The rule is not "lispString exists" but "whoever
// builds Lisp source uses it too" — and that can only be checked at the
// call sites.
{
  const lispish = ['(swank:', '(swank/', '(clamps-bridge-rpc:', ':emacs-rex',
                   ':emacs-return-string', '(setf ', '(intern '];
  const offenders = [];
  // Scan ALL .ts under src/, not a maintained list.
  //
  // The first version had 15 file names entered in it. When v81 added
  // three modules, those were not in it — and advancedTools.ts promptly
  // built a Lisp string with JSON.stringify again. The guard came through
  // green because it never read the file. A whitelist decays exactly when
  // it is needed most urgently: with new code.
  const srcDir = path.join(__dirname, '..', 'src');
  for (const file of fs.readdirSync(srcDir).filter(f => f.endsWith('.ts')).sort()) {
    const full = path.join(srcDir, file);
    const lines = fs.readFileSync(full, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const code = line.replace(/^\s*(\/\/|\*).*/, '');
      if (code.includes('JSON.stringify') && lispish.some(m => code.includes(m))) {
        offenders.push(`${file}:${i + 1}`);
      }
    });
  }
  check('no JSON.stringify in Lisp forms', offenders, []);
}

if (failed === 0) console.log('ok — Lisp escaping is right, multi-line input stays intact');
process.exit(failed === 0 ? 0 : 1);
