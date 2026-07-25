// test/debugger.test.js
//
// Testet die Zustandslogik des Debug-Adapters gegen erfundene
// Swank-Nachrichten — ohne SBCL, ohne Socket, ohne VS Code.
//
// Der Anlass: die Fassung mit EINEM Ebenen-Stapel sah in jedem
// Einzeltest richtig aus und war erst am laufenden Image falsch, sobald
// drei Threads gleichzeitig im Debugger standen. Genau dieses Szenario
// steht unten als Nachricht drin.
//
// Aufruf: npx tsc -p ./ && node test/debugger.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

require('./vscode-stub');

const { ClampsDebugSession } = require('../out/debugSession.js');
const { parse } = require('../out/swank.js');

// --- Testgerüst ------------------------------------------------------
let failed = 0;
const check = (name, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++;
    console.log(`FEHLER ${name}\n  erwartet: ${JSON.stringify(expected)}\n  bekommen: ${JSON.stringify(actual)}`);
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

/** Eine :debug-Nachricht wie Swank sie schickt. */
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
// 1. Drei Threads gleichzeitig im Debugger — der Fall aus Bild 5
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
    NO_CONTINUE, [[0, '(FEHLER 7)']]));

  check('drei Stapel angelegt', s.stacks.size, 3);
  check('Thread 34067 hat zwei Ebenen', s.stacks.get('34067').length, 2);
  check('stopped-Ereignisse', events(sent, 'stopped').map(e => e.body.threadId),
    [26547, 34067, 34067, 41059]);

  // Thread 26547 verlässt seine Ebene 1. Die vorige Fassung suchte die
  // Ebenennummer in einem globalen Stapel und löschte damit auch die
  // Ebene 1 von 34067 und 41059 — beide zählen ebenfalls ab 1.
  s.onDebugReturn(returnMsg(26547, 1));
  check('26547 ist weg', s.stacks.has('26547'), false);
  check('34067 unberuehrt', s.stacks.get('34067').length, 2);
  check('41059 unberuehrt', s.stacks.get('41059').length, 1);
  check('continued nur fuer 26547',
    events(sent, 'continued').map(e => e.body.threadId), [26547]);

  // Innere Ebene von 34067 verlassen: die äußere muss erneut als
  // angehalten gemeldet werden, nicht als laufend.
  const before = events(sent, 'stopped').length;
  s.onDebugReturn(returnMsg(34067, 2));
  check('34067 wieder auf Ebene 1', s.stacks.get('34067').length, 1);
  check('erneut stopped gemeldet', events(sent, 'stopped').length, before + 1);
  check('kein zusaetzliches continued',
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
  // list-threads schlaegt ohne Socket fehl; die Ergaenzung muss trotzdem
  // beide Threads liefern, sonst zeigt VS Code keine Aufrufliste.
  setTimeout(() => {
    const r = responses(sent, 'threads')[0];
    check('beide Threads gemeldet',
      r.body.threads.map(t => t.id).sort((a, b) => a - b), [26547, 41059]);
  }, 0);
}

// ---------------------------------------------------------------------
// 3. Frame-IDs sind ueber Threads eindeutig und zeigen zurueck
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
    check('Frames von 26547', a.body.stackFrames.map(f => f.name), ['A0', 'A1']);
    check('Frames von 41059', b.body.stackFrames.map(f => f.name), ['B0', 'B1']);
    const idsA = a.body.stackFrames.map(f => f.id);
    const idsB = b.body.stackFrames.map(f => f.id);
    check('IDs kollidieren nicht', idsA.some(i => idsB.includes(i)), false);
    // Dekodieren muss die echte Lisp-Nummer UND den Thread zurueckgeben.
    check('decode Frame 1 von A', s.decodeFrame(idsA[1]), 1);
    check('decode fokussiert A', s.activeThread, '26547');
    check('decode Frame 0 von B', s.decodeFrame(idsB[0]), 0);
    check('decode fokussiert B', s.activeThread, '41059');

    if (failed === 0) console.log('ok — alle Debugger-Tests bestanden');
    process.exit(failed === 0 ? 0 : 1);
  }, 10);
}

// ---------------------------------------------------------------------
// 4. Stepping-Gate haengt am CONTINUE-Restart, nicht am Contrib
// ---------------------------------------------------------------------
{
  const { s } = newSession();
  s.onDebug(debugMsg(1, 1, 'unbound', 'unbound-variable', WITH_CONTINUE, [[0, 'f']]));
  check('mit continue schrittfaehig', s.canStep(s.top), true);
  s.onDebug(debugMsg(2, 1, 'test', 'simple-error', NO_CONTINUE, [[0, 'f']]));
  check('ohne continue nicht', s.canStep(s.top), false);
}

// ---------------------------------------------------------------------
// 5. :position ist ein Zeichen-Offset, keine Zeile
// ---------------------------------------------------------------------
{
  const { s } = newSession();
  const file = path.join(os.tmpdir(), `clamps-offset-${process.pid}.lisp`);
  //            Offsets 1-basiert:  1234567890 1234567 8901234
  fs.writeFileSync(file, 'erste\nzweite\ndritte zeile\n', 'utf8');
  check('Offset 1 -> Zeile 1', s.offsetToLineColumn(file, 1).line, 1);
  check('Offset 7 -> Zeile 2', s.offsetToLineColumn(file, 7).line, 2);
  check('Offset 14 -> Zeile 3', s.offsetToLineColumn(file, 14).line, 3);
  check('Spalte in Zeile 3', s.offsetToLineColumn(file, 16).column, 3);
  check('Offset hinter Dateiende', s.offsetToLineColumn(file, 99999).line, 3);
  check('Snippet findet Zeile', s.snippetToLine(file, 'dritte zeile'), 3);
  check('Snippet nicht gefunden', s.snippetToLine(file, 'gibt es nicht'), undefined);
  // Unlesbare Datei darf nicht werfen, sondern Zeile 1 liefern.
  check('fehlende Datei', s.offsetToLineColumn('/nicht/da.lisp', 42).line, 1);
  fs.unlinkSync(file);
}
