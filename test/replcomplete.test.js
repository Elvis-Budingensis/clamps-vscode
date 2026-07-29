// test/replcomplete.test.js
//
// Tab completion in the REPL terminal.
//
// The terminal has no document buffer, so the client cuts the prefix
// itself and sends it along. That is exactly where the source of error
// lies: if the client cuts differently from symbol-constituent-p in
// bridge-server.lisp, then the server filters by a different prefix from
// the one the user typed — and does so silently, only wrong suggestions
// arrive. Hence the character class is pinned down here.
//
// Run: npx tsc -p ./ && node test/replcomplete.test.js

require('./vscode-stub');

const { ClampsReplTerminal } = require('../out/replTerminal.js');

let failed = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAILED ${name}: ${a} instead of ${e}`);
    failed++;
  }
};
const ok = (name, condition) => {
  if (!condition) {
    console.error(`FAILED ${name}`);
    failed++;
  }
};

// --- A terminal without VS Code behind it -----------------------------
//
// The constructor is private and open() needs a real terminal. For the
// input logic the prototype object with the fields set is enough; the
// output is recorded instead of sent.
function makeTerminal(items, buffer, cursor) {
  const term = Object.create(ClampsReplTerminal.prototype);
  const written = [];
  const requests = [];
  term.buffer = buffer;
  term.cursor = cursor === undefined ? buffer.length : cursor;
  term.packageName = 'CLAMPS';
  term.busy = false;
  term.cols = 80;
  term.renderedRows = 1;
  term.history = [];
  term.historyIndex = 0;
  term.lastCompletionAt = undefined;
  term.getClient = () => ({
    state: 2, // State.Running
    sendRequest: (method, params) => {
      requests.push({ method, params });
      return Promise.resolve({ items });
    },
  });
  term.write = value => written.push(value);
  term.clearInputLine = () => {};
  term.renderInput = () => {};
  term.written = written;
  term.requests = requests;
  return term;
}

const item = label => ({ label });

// --- Praefix abschneiden ---------------------------------------------

const tokenOf = (buffer, cursor) => makeTerminal([], buffer, cursor).currentToken();

check('the start of a symbol', tokenOf('(map'), 'map');
check('empty after a space', tokenOf('(mapcar '), '');
check('Bindestriche gehoeren dazu', tokenOf('(rt-st'), 'rt-st');
check('Paketpraefix gehoert dazu', tokenOf('(incudine:rt-st'), 'incudine:rt-st');
check('Keyword gehoert dazu', tokenOf('(make-array 3 :el'), ':el');
check('Ausrufezeichen gehoert dazu', tokenOf('(dsp'), 'dsp');
check('a paren separates', tokenOf('(foo(bar'), 'bar');
check('Anfuehrungszeichen trennt', tokenOf('(foo "ba'), 'ba');
check('before the cursor, not behind it', tokenOf('(mapcar list)', 5), 'mapc');

// --- Gemeinsamer Anfang ----------------------------------------------

check('a single candidate', ClampsReplTerminal.commonPrefix(['mapcar']), 'mapcar');
check('gemeinsamer Anfang',
  ClampsReplTerminal.commonPrefix(['mapcar', 'mapcan', 'mapc']), 'mapc');
check('no common prefix',
  ClampsReplTerminal.commonPrefix(['mapcar', 'reduce']), '');
// Character for character: the bridge always delivers lower case, and a
// mixed-case insertion would be worse than a shorter one.
check('zeichengenau verglichen',
  ClampsReplTerminal.commonPrefix(['mapCar', 'mapcan']), 'map');

// --- The behaviour of Tab --------------------------------------------

(async () => {
  // A single candidate is inserted.
  {
    const t = makeTerminal([item('mapcar')], '(mapc');
    await t.complete();
    check('a single match is inserted', t.buffer, '(mapcar');
    check('the cursor is behind the insertion', t.cursor, '(mapcar'.length);
  }

  // The server gets the prefix, the package and the context.
  {
    const t = makeTerminal([item('mapcar')], '(mapc');
    await t.complete();
    check('Methode', t.requests[0].method, 'clamps/replComplete');
    check('Praefix', t.requests[0].params.prefix, 'mapc');
    check('the package', t.requests[0].params.package, 'CLAMPS');
    check('Kontext', t.requests[0].params.context, '(mapc');
  }

  // Several candidates are shortened to their common prefix.
  {
    const t = makeTerminal([item('mapcar'), item('mapcan')], '(ma');
    await t.complete();
    check('the common prefix is inserted', t.buffer, '(mapca');
  }

  // If the common prefix gains nothing, only the SECOND Tab lists.
  {
    const t = makeTerminal([item('mapcar'), item('mapcan')], '(mapca');
    await t.complete();
    check('erster Tab schreibt nichts', t.written.length, 0);
    ok('the first Tab remembers the buffer', t.lastCompletionAt === '(mapca');
    await t.complete();
    ok('zweiter Tab listet', t.written.join('').includes('mapcar'));
    ok('zweiter Tab listet beide', t.written.join('').includes('mapcan'));
    ok('the record has been reset', t.lastCompletionAt === undefined);
  }

  // Typing between two Tabs resets the record: a list should not appear
  // surprisingly just because a Tab came earlier.
  {
    const t = makeTerminal([item('mapcar'), item('mapcan')], '(mapca');
    await t.complete();
    t.insert('r');
    ok('typing clears the record', t.lastCompletionAt === undefined);
  }

  // No candidates: insert nothing, print nothing.
  {
    const t = makeTerminal([], '(zzz');
    await t.complete();
    check('no match changes nothing', t.buffer, '(zzz');
    check('no match prints nothing', t.written.length, 0);
  }

  // An error in the bridge must not destroy the input.
  {
    const t = makeTerminal([], '(map');
    t.getClient = () => ({
      state: 2,
      sendRequest: () => Promise.reject(new Error('weg')),
    });
    await t.complete();
    check('an error leaves the buffer standing', t.buffer, '(map');
    check('an error prints nothing', t.written.length, 0);
  }

  // Without a running client nothing happens.
  {
    const t = makeTerminal([item('mapcar')], '(mapc');
    t.getClient = () => undefined;
    await t.complete();
    check('unchanged without a client', t.buffer, '(mapc');
  }

  // Do not interfere during a running evaluation.
  {
    const t = makeTerminal([item('mapcar')], '(mapc');
    t.busy = true;
    await t.complete();
    check('busy blockt', t.buffer, '(mapc');
  }

  if (failed > 0) {
    console.error(`\n${failed} failure(s).`);
    process.exit(1);
  }
  console.log('ok — REPL tab completion: prefix, common start, the second Tab lists');
})();
