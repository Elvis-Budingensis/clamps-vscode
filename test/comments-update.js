// test/comments-update.js
//
// Writes test/comment-baseline.json from the current tree.
// Run: npm run comments:update
//
// Deliberately a separate entry point and not a flag on the gate: the
// snapshot should only ever move because somebody decided it should, and
// that decision then stands in the diff.

const { writeSnapshot, SNAPSHOT } = require('./commentdensity');

const data = writeSnapshot();
const totals = Object.values(data).reduce(
  (a, m) => ({ c: a.c + m.comments, s: a.s + m.longStrings }), { c: 0, s: 0 });
console.log(
  `${SNAPSHOT}: ${Object.keys(data).length} files, `
  + `${totals.c} comment lines, ${totals.s} docstrings`
);
