// test/comments.test.js
//
// Guards the prose in the source.
//
// The occasion: a translation pass came back with every comment in the
// tree deleted — 2861 lines, 100 % — and 98 Lisp docstrings replaced by
// the placeholder "Internal documentation.". The whole gate chain stayed
// green, because comments do not execute. That is the blind spot this
// file closes.
//
// What is being protected is not decoration. The reasoning that lives in
// these comments is the only record of why terminateThreads is not
// offered, why `parentStart === 0` broke the first form of every file,
// and why %finite-db exists where %finite-sample would say the opposite.
// Losing it costs more than losing a feature, and unlike a feature nobody
// notices.
//
// Three rules, deliberately different in kind so that no single mistake
// can satisfy all of them:
//
//   1. SNAPSHOT     Per-file counts against test/comment-baseline.json.
//                   Catches a partial loss, file by file.
//   2. FLOOR        No sizeable file may end up with (almost) no prose.
//                   Needs no snapshot, so it still bites if somebody
//                   regenerates the snapshot to make rule 1 pass.
//   3. PLACEHOLDERS No docstring may be a content-free filler.
//                   Also snapshot-free.
//
// The snapshot is generated, never hand-written: `npm run comments:update`.
// It records numbers only — which files to look at comes from reading the
// directory. A list of file names would decay with the next new module,
// which is the mistake test/gatecoverage.test.js already guards against
// elsewhere.
//
// Run: node test/comments.test.js

const { measure, files, readSnapshot, withoutComments, MIN_LINES } =
  require('./commentdensity');
const fs = require('fs');
const path = require('path');

let failed = 0;
const fail = msg => { failed++; console.log(`FAILED ${msg}`); };

/**
 * How much prose may disappear before it counts as a loss.
 *
 * Not zero: rewording legitimately shortens things, and a gate that fires
 * on every edit gets switched off. Ten per cent or three lines, whichever
 * is larger, so that small files are not held to a percentage that a
 * single line would breach.
 */
const tolerance = before => Math.max(3, Math.floor(before * 0.1));

// ---------------------------------------------------------------------
// 1. Snapshot
// ---------------------------------------------------------------------
const snapshot = readSnapshot();
if (!snapshot) {
  fail('test/comment-baseline.json is missing — run `npm run comments:update`');
} else {
  const current = files();

  for (const relative of current) {
    const now = measure(relative);
    const before = snapshot[relative];
    if (!before) {
      // A new file is not a failure, but it has to enter the snapshot,
      // otherwise it is outside the guard from here on.
      fail(`${relative} is not in the snapshot — run \`npm run comments:update\``);
      continue;
    }

    const lost = before.comments - now.comments;
    if (lost > tolerance(before.comments)) {
      // A file that genuinely shrank loses prose in proportion. A strip
      // loses prose while the code stays.
      const codeBefore = before.lines - before.comments;
      const codeNow = now.lines - now.comments;
      const shrank = codeBefore - codeNow > tolerance(codeBefore);
      fail(
        `${relative}: ${before.comments} -> ${now.comments} comment lines `
        + `(-${lost})` + (shrank ? ', and the code shrank too — if that is '
          + 'intended, run `npm run comments:update`'
          : ` while the code stayed (${codeBefore} -> ${codeNow} lines). `
          + 'That is the shape of a strip, not of an edit.')
      );
    }

    const stringsLost = before.longStrings - now.longStrings;
    if (stringsLost > tolerance(before.longStrings)) {
      // Docstrings are ordinary strings in Lisp and invisible to a comment
      // counter. Replacing them with a short placeholder keeps the string
      // count and loses the length — which is what this measures.
      fail(
        `${relative}: ${before.longStrings} -> ${now.longStrings} long strings `
        + `(-${stringsLost}) — docstrings shortened or removed?`
      );
    }
  }

  // Files in the snapshot that no longer exist are stale entries, not a
  // failure of the source. Report them so the snapshot stays honest.
  const stale = Object.keys(snapshot).filter(f => !current.includes(f));
  if (stale.length > 0) {
    fail(`stale snapshot entries (deleted or shrunk below ${MIN_LINES} lines): `
      + `${stale.join(', ')} — run \`npm run comments:update\``);
  }
}

// ---------------------------------------------------------------------
// 2. Floor, without a snapshot
// ---------------------------------------------------------------------
// If somebody regenerates the snapshot on a stripped tree, rule 1 goes
// quiet. This one does not: a file of this size with almost no prose is
// wrong regardless of what any baseline says.
for (const relative of files()) {
  const now = measure(relative);
  if (now.lines >= 120 && now.comments < 3) {
    fail(`${relative}: ${now.lines} lines and only ${now.comments} comment `
      + 'line(s) — a file this size without reasoning is not reviewable');
  }
}

// ---------------------------------------------------------------------
// 3. No content-free docstrings
// ---------------------------------------------------------------------
// The exact failure mode observed: 98 docstrings replaced by
// "Internal documentation.". A docstring that says nothing is worse than
// none, because it looks like the question has been answered.
const PLACEHOLDERS = [
  /"Internal documentation\.?"/,
  /"Internal(?: use)? only\.?"/,
  /"(?:No|Not) documentation(?: available)?\.?"/,
  /"TBD\.?"/,
  /"TODO\.?"/,
  /"Documentation\.?"/,
  /"Helper(?: function)?\.?"/,
  /"See above\.?"/,
];
for (const relative of files()) {
  // Comments are stripped first: this very file quotes the placeholders
  // in order to explain the rule, and a guard that fires on its own
  // explanation is a guard that gets switched off.
  const source = withoutComments(
    fs.readFileSync(path.join(__dirname, '..', relative), 'utf8'),
    path.extname(relative));
  for (const pattern of PLACEHOLDERS) {
    const hit = source.match(pattern);
    if (hit) {
      fail(`${relative}: placeholder docstring ${hit[0]} — say what it does `
        + 'and why, or leave the docstring out entirely');
    }
  }
}

if (failed > 0) {
  console.log(`\n${failed} failure(s).`);
  process.exit(1);
}
const totals = files().reduce((acc, f) => {
  const m = measure(f);
  return { comments: acc.comments + m.comments, strings: acc.strings + m.longStrings };
}, { comments: 0, strings: 0 });
console.log(
  `ok — documentation intact: ${totals.comments} comment lines and `
  + `${totals.strings} docstrings across ${files().length} files, no placeholders`
);
