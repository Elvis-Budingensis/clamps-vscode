// test/commentdensity.js
//
// Counts documentation per source file. Shared by comments.test.js (the
// gate) and by `npm run comments:update` (which writes the snapshot), so
// that the two can never disagree about what a comment is.
//
// Why this exists: the gate chain reports "ok — every test runs" on a
// tree from which every single comment has been deleted. Comments are not
// executable, so nothing notices. That happened: a translation pass came
// back with all 2861 comment lines stripped and 98 docstrings replaced by
// the placeholder "Internal documentation.", and every gate stayed green.
//
// Three measures, deliberately different in kind:
//
//   comments     — comment lines. The bulk of the reasoning lives here.
//   longStrings  — string literals of 40 characters or more. This is the
//                  proxy for docstrings, which are ordinary strings in
//                  Lisp and therefore invisible to a comment counter.
//                  Replacing a docstring with a short placeholder shows up
//                  as a drop here even though the string count stays the
//                  same.
//   lines        — total lines, so that a genuine shrink (code actually
//                  removed) can be told apart from a strip.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SNAPSHOT = path.join(__dirname, 'comment-baseline.json');

/** Directories and extensions under measurement. */
const SCOPE = [
  { dir: 'src', ext: '.ts' },
  { dir: 'lisp', ext: '.lisp' },
  { dir: 'lisp', ext: '.py' },
  { dir: 'test', ext: '.js' },
];

/**
 * Files below this line count are not measured. Small modules legitimately
 * carry little prose, and a threshold avoids the gate nagging about a
 * twenty-line helper.
 */
const MIN_LINES = 40;

/** Does this line start a comment? */
function isCommentLine(line, ext) {
  const s = line.trim();
  if (ext === '.lisp') return s.startsWith(';');
  if (ext === '.py') return s.startsWith('#');
  return s.startsWith('//') || s.startsWith('*') || s.startsWith('/*');
}

/**
 * Counts string literals of MIN_STRING characters or more.
 *
 * A rough scanner, and deliberately so: it has to agree with itself
 * between two runs, not with the language standard. It respects escapes
 * and — for Lisp — the character literal #\" , which would otherwise open
 * a string that never closes and swallow the rest of the file.
 */
const MIN_STRING = 40;

function countLongStrings(source, ext) {
  const lisp = ext === '.lisp';
  let count = 0;
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    // Comments: a string inside a comment is prose, not a docstring, and
    // is already counted by the comment measure.
    if (lisp && c === ';') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (!lisp && c === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (!lisp && c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // #\" and #\\ in Lisp, and the same shape in TS char handling.
    if (c === '#' && source[i + 1] === '\\') { i += 3; continue; }
    if (c === '"' || (!lisp && (c === '\'' || c === '`'))) {
      const quote = c;
      let j = i + 1;
      let length = 0;
      while (j < n) {
        if (source[j] === '\\') { j += 2; length += 1; continue; }
        if (source[j] === quote) break;
        j++; length++;
      }
      if (length >= MIN_STRING) count++;
      i = j + 1;
      continue;
    }
    i++;
  }
  return count;
}

/** Measures one file. */
function measure(relative) {
  const ext = path.extname(relative);
  const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  const lines = source.split('\n');
  return {
    lines: lines.length,
    comments: lines.filter(l => isCommentLine(l, ext)).length,
    longStrings: countLongStrings(source, ext),
  };
}

/**
 * Every file in scope, read from disk rather than from a list.
 *
 * This is the point of the whole arrangement: a new module is measured
 * because it is in src/, not because somebody remembered to add it. The
 * snapshot below records numbers, never which files to look at.
 */
function files() {
  const out = [];
  for (const { dir, ext } of SCOPE) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full).sort()) {
      if (!name.endsWith(ext)) continue;
      const relative = `${dir}/${name}`;
      if (measure(relative).lines >= MIN_LINES) out.push(relative);
    }
  }
  return out;
}

function readSnapshot() {
  if (!fs.existsSync(SNAPSHOT)) return null;
  return JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
}

function writeSnapshot() {
  const data = {};
  for (const relative of files()) data[relative] = measure(relative);
  fs.writeFileSync(SNAPSHOT, JSON.stringify(data, null, 1) + '\n');
  return data;
}

/**
 * The source with comments removed.
 *
 * Needed by the placeholder check: a comment that quotes a placeholder in
 * order to explain the rule is prose, not a docstring. Without this the
 * guard fires on the guard's own explanation, which is the most annoying
 * kind of false positive — it teaches you to switch the check off.
 */
function withoutComments(source, ext) {
  if (ext === '.lisp' || ext === '.py') {
    const marker = ext === '.lisp' ? ';' : '#';
    return source
      .split('\n')
      .map(l => (l.trim().startsWith(marker) ? '' : l))
      .join('\n');
  }
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(l => (l.trim().startsWith('//') ? '' : l))
    .join('\n');
}

module.exports = {
  MIN_LINES, MIN_STRING, SNAPSHOT,
  measure, files, readSnapshot, writeSnapshot, withoutComments,
};
