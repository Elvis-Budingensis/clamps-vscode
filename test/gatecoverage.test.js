// test/gatecoverage.test.js
//
// Checks that every test file is EXECUTED at all.
//
// The occasion: this went wrong twice in one day, both times found by
// chance.
//
//   - lisp/test-inspect.lisp — the most thorough test in the project, 80
//     forms across 17 types, slot setting, circularity, the parts cache —
//     hung in NO npm chain. It never ran.
//   - test/lispstring.test.js had a whitelist of 15 file names. When v81
//     added three modules, those were not in it, and advancedTools.ts
//     promptly built a Lisp string with JSON.stringify again. It came
//     through green, because the file was never read.
//
// Both are the same mistake: a maintained list that decays with the next
// piece of new code. A test that does not run is worse than no test — it
// creates confidence that is not backed.
//
// Run: node test/gatecoverage.test.js

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const scripts = manifest.scripts || {};

let failed = 0;
const fail = msg => { failed++; console.log(`FAILED ${msg}`); };

/**
 * All the commands `npm run gates` ultimately executes — npm scripts are
 * resolved recursively, so that chains such as
 * "gates -> lisp -> sbcl --script …" are covered too.
 */
function expand(name, seen = new Set()) {
  if (seen.has(name)) return '';
  seen.add(name);
  let text = scripts[name] ?? '';
  // Both "npm run foo" and the short forms "npm test" and "npm start",
  // which npm accepts without "run". Without the short form,
  // "gates -> npm test" stayed unresolved and the gate reported every JS
  // test as not executed — a false alarm instead of a find.
  for (const ref of text.matchAll(/npm (?:run\s+)?([\w:-]+)/g)) {
    if (ref[1] === 'run') continue;
    text += '\n' + expand(ref[1], seen);
  }
  return text;
}

if (!scripts.gates) {
  fail('no npm script "gates" — the gate chain is the quality standard');
  console.log(`\n${failed} Test(s) fehlgeschlagen.`);
  process.exit(1);
}
const chain = expand('gates');

// ---------------------------------------------------------------------
// 1. Every test/*.test.js appears in the chain
// ---------------------------------------------------------------------
const jsTests = fs.readdirSync(path.join(root, 'test'))
  .filter(f => f.endsWith('.test.js')).sort();
for (const file of jsTests) {
  if (!chain.includes(file)) {
    fail(`test/${file} runs in no npm chain — the test exists but is never executed`);
  }
}

// ---------------------------------------------------------------------
// 2. Every lisp/test-*.lisp and the check runs appear in the chain
// ---------------------------------------------------------------------
const lispTests = fs.readdirSync(path.join(root, 'lisp'))
  .filter(f => /^(test-.*|loadcheck|framingtest|swankframing)\.lisp$/.test(f)).sort();
for (const file of lispTests) {
  if (!chain.includes(file)) {
    fail(`lisp/${file} runs in no npm chain — the test exists but is never executed`);
  }
}

// ---------------------------------------------------------------------
// 3. No early exit in the middle of a test file
// ---------------------------------------------------------------------
// test-inspect.lisp contains
//     (when (sb-ext:posix-getenv "TEST_EXIT") (sb-ext:exit :code 0))
// in the middle of the file. In the gates the variable is not set, so
// everything runs; but whoever sets it silently skips the rest — and does
// not notice, because the run ends with code 0. An exit in the LAST fifth
// is a conclusion, further forward it is a trap.
for (const file of lispTests) {
  const full = path.join(root, 'lisp', file);
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (/\(sb-ext:exit\s+:code\s+0\)/.test(line) && !/FAILED|failed/.test(line)) {
      const position = (i + 1) / lines.length;
      if (position < 0.8) {
        fail(`lisp/${file}:${i + 1} exits with code 0 at ${Math.round(position * 100)}% of the file — everything after it is silently skipped`);
      }
    }
  });
}

// ---------------------------------------------------------------------
// 4. No file whitelists in tests
// ---------------------------------------------------------------------
// The lispstring guard had 15 file names entered in it. Whoever wants to
// check src/ reads src/ — otherwise the list decays with the next new
// module.
for (const file of jsTests) {
  const src = fs.readFileSync(path.join(root, 'test', file), 'utf8');
  // An array literal with three or more .ts file names in it.
  const suspicious = src.match(/\[[^\]]*?(?:'[\w.]+\.ts'[^\]]*?){3,}\]/s);
  if (suspicious) {
    fail(`test/${file} contains a list of .ts file names — read src/ directly, otherwise it decays with new code`);
  }
}

// Dead code behind process.exit. Whoever appends a test at the bottom
// easily lands BEHIND the closing process.exit — the assertions then never
// run, and the file still reports "ok". That is exactly what happened with
// the panel focus test in session.test.js.
for (const file of jsTests) {
  const src = fs.readFileSync(path.join(root, 'test', file), 'utf8');
  // Only an UNCONDITIONAL exit counts, that is, one without indentation.
  // The usual pattern
  //   if (failed > 0) { ...; process.exit(1); }
  //   console.log('ok — ...');
  // is perfectly fine: the message runs precisely when there was no exit.
  const lines = src.split('\n');
  const exitLine = lines.reduce(
    (found, line, i) => (/^process\.exit\(/.test(line) ? i : found), -1
  );
  if (exitLine === -1) continue;
  const alive = lines
    .slice(exitLine + 1)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('//') && !/^[)}\];]*$/.test(line));
  if (alive.length > 0) {
    fail(`test/${file}: code after the unconditional process.exit never runs — e.g. "${alive[0].slice(0, 60)}"`);
  }
}

if (failed > 0) {
  console.log(`\n${failed} Test(s) fehlgeschlagen.`);
  process.exit(1);
}
console.log(
  `ok — every test runs: ${jsTests.length} JS, ${lispTests.length} Lisp, ` +
  'no early exits, no file whitelists'
);
