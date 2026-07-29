// test/xref.test.js
//
// Regression tests for the bugs shipped unnoticed in v76/v77. None of the
// three was noticed because no test touched them: the suite knew neither
// xref nor the recursive expansion.
//
// Run: npx tsc -p ./ && node test/xref.test.js

require('./vscode-stub');

const { entryPosition } = require('../out/xrefBrowser.js');
const { ClampsInspector } = require('../out/inspector.js');

let failed = 0;
const check = (name, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++;
    console.log(`FAILED ${name}\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(actual)}`);
  }
};
const truthy = (name, actual) => check(name, !!actual, true);

// ---------------------------------------------------------------------
// The jump target: the offset must not be masked by a line
// ---------------------------------------------------------------------
// A stand-in document: offset 4711 is on line 100, column 7.
const doc = { positionAt: o => ({ line: 100, character: 7, _offset: o }) };
const pos = (entry) => entryPosition(entry, doc);

// The actual bug: SBCL supplies (:position N); if a line=1 slips through
// next to it, every jump landed at the start of the file.
check('the offset beats the line',
  pos({ file: '/x.lisp', line: 1, character: 0, offset: 4711 })._offset, 4710);
check('Offset allein',
  pos({ file: '/x.lisp', offset: 4711 })._offset, 4710);
check('a line alone, one-based -> zero-based',
  [pos({ file: '/x.lisp', line: 12, character: 3 }).line,
   pos({ file: '/x.lisp', line: 12, character: 3 }).character], [11, 3]);
check('null does not count as a value',
  [pos({ file: '/x.lisp', line: null, character: null, offset: null }).line,
   pos({ file: '/x.lisp', line: null, offset: null }).character], [0, 0]);
check('no value at all',
  [pos({ file: '/x.lisp' }).line, pos({ file: '/x.lisp' }).character], [0, 0]);
// Offset 0 is a value, not an absence — and must not go negative.
check('offset 0 stays at 0', pos({ file: '/x.lisp', offset: 0 })._offset, 0);
check('line 0 does not go negative', pos({ file: '/x.lisp', line: 0 }).line, 0);

// ---------------------------------------------------------------------
// Inspector-Rendering
// ---------------------------------------------------------------------
const I = ClampsInspector;
const resetI = () => {
  I.history = []; I.historyIndex = -1; I.navigatingHistory = false;
  I.trail = []; I.rootExpr = '*x*';
  I.currentResult = undefined;
  I.recursiveChildren = new Map();
  I.recursiveExpanded = new Set();
  I.recursiveErrors = new Map();
};
const result = (over = {}) => Object.assign({
  id: 1, kind: 'hash-table', type: 'hash-table', print: '#<hash-table>',
  parts: [], meta: [], package: 'COMMON-LISP-USER',
}, over);

// Quotation marks in labels: prin1-to-string always delivers a string key
// of a hash table as "key" — that ends up in data-label="…" and title="…"
// and broke the attribute open there.
{
  resetI();
  const html = I.render(result({
    parts: [{ label: '"key"', index: 0, preview: '1', navigable: true }],
  }));
  truthy('Anfuehrungszeichen maskiert', html.includes('&quot;key&quot;'));
  check('no raw quotation mark in the label', /data-label="[^"]*"[^ >]/.test(html), false);
}
{
  resetI();
  const html = I.render(result({
    parts: [{ label: `" onmouseover="alert(1)`, index: 0, preview: 'x', navigable: true }],
  }));
  // The text 'onmouseover=' stands escaped in the label and is harmless
  // there; it would only be dangerous with a real quotation mark behind
  // it.
  check('no escape from the attribute', html.includes('onmouseover="'), false);
  check('einfaches Anfuehrungszeichen maskiert',
    I.render(result({ parts: [{ label: "it's", index: 0, navigable: true }] })).includes('&#39;'), true);
}

// The expand arrow only on parts that have parts themselves.
{
  resetI();
  const html = I.render(result({
    parts: [
      { label: 'a', index: 0, preview: '42', navigable: true, expandable: false },
      { label: 'b', index: 1, preview: '(1 2)', navigable: true, expandable: true },
    ],
  }));
  check('exactly one arrow', (html.match(/data-expand-path=/g) || []).length, 1);
  truthy('a placeholder for the rest', html.includes('twisty spacer'));
}
{
  // An older image without the field: behaviour as before, an arrow on
  // everything bound — better one arrow too many than a missing one.
  resetI();
  const html = I.render(result({
    parts: [{ label: 'a', index: 0, navigable: true },
            { label: 'b', index: 1, navigable: false }],
  }));
  check('without the field: an arrow on the bound part', (html.match(/data-expand-path=/g) || []).length, 1);
}

// Filters: one id per level, not the same one several times.
{
  resetI();
  const many = n => Array.from({ length: n }, (_, i) => ({
    label: `k${i}`, index: i, preview: String(i), navigable: true, expandable: true,
  }));
  I.recursiveExpanded = new Set(['0']);
  I.recursiveChildren = new Map([['0', {
    id: 2, kind: 'vector', type: 'simple-vector', print: '#(…)',
    parts: many(20), meta: [], package: 'COMMON-LISP-USER',
  }]]);
  const html = I.render(result({ kind: 'vector', parts: many(20) }));
  const inputs = html.match(/data-filter-input="([^"]+)"/g) || [];
  check('zwei Filter, zwei Namensraeume', inputs.length, 2);
  check('Namensraeume verschieden', new Set(inputs).size, 2);
  check('no duplicate id="filter"', (html.match(/id="filter"/g) || []).length, 0);
  // Count only the hits in the markup — the selector also appears as text
  // in the <script>.
  const lists = html.match(/<div class="recursive-list" data-filter-list="([^"]+)"/g) || [];
  check('jede Liste adressierbar', lists.length, 2);
  check('the lists match the fields',
    lists.map(l => l.match(/data-filter-list="([^"]+)"/)[1]).sort(),
    inputs.map(i => i.match(/data-filter-input="([^"]+)"/)[1]).sort());
}

// A cycle: the image returns the same ID for the same object, and only
// that makes the back reference recognisable at all.
{
  resetI();
  I.recursiveExpanded = new Set(['0']);
  I.recursiveChildren = new Map([['0', {
    id: 42, kind: 'object', type: 'person', print: '#<person>',
    parts: [], meta: [], package: 'COMMON-LISP-USER',
  }]]);
  const html = I.render(result({
    id: 42, kind: 'object', type: 'person',
    parts: [{ label: 'owner', index: 0, preview: '#<person>', navigable: true, expandable: true }],
  }));
  truthy('the cycle is reported', html.includes('cycle back to object #42'));
  // Check against the markup, not against the class name: that also
  // appears in the CSS block of the same page.
  check('the subtree is not expanded', html.includes('class="recursive-head"'), false);
}
{
  // No cycle: a foreign ID, the subtree is drawn.
  resetI();
  I.recursiveExpanded = new Set(['0']);
  I.recursiveChildren = new Map([['0', {
    id: 51, kind: 'object', type: 'address', print: '#<address>',
    parts: [{ label: 'street', index: 0, preview: '"Hauptstr."', navigable: true, expandable: false }],
    meta: [], package: 'COMMON-LISP-USER',
  }]]);
  const html = I.render(result({
    id: 42, kind: 'object', type: 'person',
    parts: [{ label: 'address', index: 0, preview: '#<address>', navigable: true, expandable: true }],
  }));
  truthy('Unterbaum inline', html.includes('class="recursive-head"'));
  check('no false cycle', html.includes('cycle back to object'), false);
  truthy('Label des Enkels maskiert', html.includes('&quot;Hauptstr.&quot;'));
}
resetI();

if (failed === 0) console.log('ok — all XREF and inspector tests passed');
process.exit(failed === 0 ? 0 : 1);
