// test/debugger.test.js
//
// Tests the state logic of the debug adapter against invented Swank
// messages — without SBCL, without a socket, without VS Code.
//
// The occasion: the version with ONE level stack looked right in every
// individual test and was wrong only against a running image, as soon as
// three threads stood in the debugger at once. That very scenario is in
// the messages below.
//
// Run: npx tsc -p ./ && node test/debugger.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

require('./vscode-stub');

const { ClampsDebugSession } = require('../out/debugSession.js');
const { parse } = require('../out/swank.js');

// --- Test scaffolding -------------------------------------------------
let failed = 0;
const check = (name, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++;
    console.log(`FAILED ${name}\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(actual)}`);
  }
};

function newSession() {
  const s = new ClampsDebugSession(4005, '/tmp');
  const sent = [];
  s.onDidSendMessage(m => sent.push(m));
  return { s, sent };
}

const events = (sent, name) => sent.filter(m => m.type === 'event' && m.event === name);
const responses = (sent, cmd) => sent.filter(m => m.type === 'response' && m.command === cmd);

/** A :debug message as Swank sends it. */
function debugMsg(thread, level, condition, type, restarts, frames) {
  const r = restarts.map(([n, d]) => `("${n}" "${d}")`).join(' ');
  const f = frames.map(([i, t]) => `(${i} "${t}")`).join(' ');
  return parse(
    `(:debug ${thread} ${level} ("${condition}" "${type}" nil) (${r}) (${f}) (4))`
  );
}
const returnMsg = (thread, level) => parse(`(:debug-return ${thread} ${level} nil)`);

const WITH_CONTINUE = [
  ['continue', 'Retry using X.'],
  ['use-value', 'Use specified value.'],
  ['*abort', "Return to SLIME's top level."],
  ['abort', 'abort thread'],
];
const NO_CONTINUE = [
  ['*abort', "Return to SLIME's top level."],
  ['abort', 'abort thread'],
];

// ---------------------------------------------------------------------
// 1. Three threads in the debugger at once — the case from picture 5
// ---------------------------------------------------------------------
{
  const { s, sent } = newSession();
  s.onDebug(debugMsg(26547, 1, 'The variable X is unbound.', 'unbound-variable',
    WITH_CONTINUE, [[0, '(FOO 1)'], [1, '(BAR)']]));
  s.onDebug(debugMsg(34067, 1, 'test', 'simple-error',
    NO_CONTINUE, [[0, '(BAZ)']]));
  s.onDebug(debugMsg(34067, 2, 'Not currently single-stepping', 'simple-error',
    NO_CONTINUE, [[0, '(QUUX)']]));
  s.onDebug(debugMsg(41059, 1, 'division-by-zero', 'division-by-zero',
    NO_CONTINUE, [[0, '(ERROR 7)']]));

  check('drei Stapel angelegt', s.stacks.size, 3);
  check('Thread 34067 hat zwei Ebenen', s.stacks.get('34067').length, 2);
  check('stopped-Ereignisse', events(sent, 'stopped').map(e => e.body.threadId),
    [26547, 34067, 34067, 41059]);

  // Thread 26547 leaves its level 1. The previous version searched for
  // the level number in a global stack and thereby also deleted level 1
  // of 34067 and 41059 — both of which count from 1 as well.
  s.onDebugReturn(returnMsg(26547, 1));
  check('26547 is gone', s.stacks.has('26547'), false);
  check('34067 unberuehrt', s.stacks.get('34067').length, 2);
  check('41059 unberuehrt', s.stacks.get('41059').length, 1);
  check('continued only for 26547',
    events(sent, 'continued').map(e => e.body.threadId), [26547]);

  // Leave the inner level of 34067: the outer one has to be reported as
  // halted again, not as running.
  const before = events(sent, 'stopped').length;
  s.onDebugReturn(returnMsg(34067, 2));
  check('34067 back at level 1', s.stacks.get('34067').length, 1);
  check('erneut stopped gemeldet', events(sent, 'stopped').length, before + 1);
  check('no additional continued',
    events(sent, 'continued').map(e => e.body.threadId), [26547]);
}

// ---------------------------------------------------------------------
// 2. threads listet jeden angehaltenen Thread
// ---------------------------------------------------------------------
{
  const { s, sent } = newSession();
  s.onDebug(debugMsg(26547, 1, 'a', 'error', NO_CONTINUE, [[0, 'f']]));
  s.onDebug(debugMsg(41059, 1, 'b', 'error', NO_CONTINUE, [[0, 'g']]));
  s.handleMessage({ seq: 1, type: 'request', command: 'threads' });
  // list-threads fails without a socket; the completion has to deliver
  // both threads all the same, otherwise VS Code shows no call stack.
  setTimeout(() => {
    const r = responses(sent, 'threads')[0];
    check('beide Threads gemeldet',
      r.body.threads.map(t => t.id).sort((a, b) => a - b), [26547, 41059]);
  }, 0);
}

// ---------------------------------------------------------------------
// 3. Frame IDs are unique across threads and point back
// ---------------------------------------------------------------------
{
  const { s, sent } = newSession();
  s.onDebug(debugMsg(26547, 1, 'a', 'error', NO_CONTINUE, [[0, 'A0'], [1, 'A1']]));
  s.onDebug(debugMsg(41059, 1, 'b', 'error', NO_CONTINUE, [[0, 'B0'], [1, 'B1']]));

  s.handleMessage({
    seq: 1, type: 'request', command: 'stackTrace',
    arguments: { threadId: 26547, startFrame: 0, levels: 200 },
  });
  s.handleMessage({
    seq: 2, type: 'request', command: 'stackTrace',
    arguments: { threadId: 41059, startFrame: 0, levels: 200 },
  });

  setTimeout(() => {
    const [a, b] = responses(sent, 'stackTrace');
    check('frames of 26547', a.body.stackFrames.map(f => f.name), ['A0', 'A1']);
    check('frames of 41059', b.body.stackFrames.map(f => f.name), ['B0', 'B1']);
    const idsA = a.body.stackFrames.map(f => f.id);
    const idsB = b.body.stackFrames.map(f => f.id);
    check('IDs do not collide', idsA.some(i => idsB.includes(i)), false);
    // Decoding has to return the real Lisp number AND the thread.
    check('decode frame 1 of A', s.decodeFrame(idsA[1]), 1);
    check('decode fokussiert A', s.activeThread, '26547');
    check('decode frame 0 of B', s.decodeFrame(idsB[0]), 0);
    check('decode fokussiert B', s.activeThread, '41059');

    if (failed === 0) console.log('ok — all debugger tests passed');
    process.exit(failed === 0 ? 0 : 1);
  }, 10);
}

// ---------------------------------------------------------------------
// 4. The stepping gate hangs off the CONTINUE restart, not off the contrib
// ---------------------------------------------------------------------
{
  const { s } = newSession();
  s.onDebug(debugMsg(1, 1, 'unbound', 'unbound-variable', WITH_CONTINUE, [[0, 'f']]));
  check('steppable with continue', s.canStep(s.top), true);
  s.onDebug(debugMsg(2, 1, 'test', 'simple-error', NO_CONTINUE, [[0, 'f']]));
  check('not without continue', s.canStep(s.top), false);
}

// ---------------------------------------------------------------------
// 5. :position is a character offset, not a line
// ---------------------------------------------------------------------
{
  const { s } = newSession();
  const file = path.join(os.tmpdir(), `clamps-offset-${process.pid}.lisp`);
  //            Offsets 1-basiert:  1234567890 1234567 8901234
  fs.writeFileSync(file, 'first\nsecond\nthird line\n', 'utf8');
  check('offset 1 -> line 1', s.offsetToLineColumn(file, 1).line, 1);
  check('offset 7 -> line 2', s.offsetToLineColumn(file, 7).line, 2);
  check('offset 14 -> line 3', s.offsetToLineColumn(file, 14).line, 3);
  check('column on line 3', s.offsetToLineColumn(file, 16).column, 3);
  check('Offset hinter Dateiende', s.offsetToLineColumn(file, 99999).line, 3);
  check('a snippet finds the line', s.snippetToLine(file, 'third line'), 3);
  check('snippet not found', s.snippetToLine(file, 'does not exist'), undefined);
  // An unreadable file must not throw but return line 1.
  check('a missing file', s.offsetToLineColumn('/not/there.lisp', 42).line, 1);
  fs.unlinkSync(file);
}
