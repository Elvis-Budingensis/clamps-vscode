// test/session.test.js
//
// Checks when a running CLAMPS session is carried on with.
//
// The occasion: up to now "the PID is alive" was enough. Because
// deactivate() deliberately leaves the image alive, one thereby developed
// against an image in which the old lisp/*.lisp were still loaded — and
// the way out was to delete session.json by hand before every start.
//
// Run: npx tsc -p ./ && node test/session.test.js

require('./vscode-stub');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClampsProcessManager } = require('../out/processManager.js');

let failed = 0;
const check = (name, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++;
    console.log(`FAILED ${name}\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(actual)}`);
  }
};

const ready = { port: 4005, pid: 4242, status: 'ready', detail: '' };
const decide = over => ClampsProcessManager.reuseDecision({
  info: ready, pidAlive: true, portAnswers: true, fingerprintMatches: true, ...over,
});

// --- weiterbenutzen -------------------------------------------------
check('alles in Ordnung', decide({}).reuse, true);

// --- frisch starten -------------------------------------------------
check('no session', decide({ info: null }).reuse, false);
check('Status starting', decide({ info: { ...ready, status: 'starting' } }).reuse, false);
check('Status error', decide({ info: { ...ready, status: 'error' } }).reuse, false);
check('Status stopped', decide({ info: { ...ready, status: 'stopped' } }).reuse, false);
check('PID tot', decide({ pidAlive: false }).reuse, false);
check('no PID', decide({ info: { ...ready, pid: null } }).reuse, false);
check('no port', decide({ info: { ...ready, port: null } }).reuse, false);

// A live PID, but nobody answers: a hung image, or the process number was
// reassigned after a crash.
check('the port does not answer', decide({ portAnswers: false }).reuse, false);
check('the reason is named', /does not answer/.test(decide({ portAnswers: false }).reason), true);

// The actual case.
check('sources changed', decide({ fingerprintMatches: false }).reuse, false);
check('the reason is named', /sources/.test(decide({ fingerprintMatches: false }).reason), true);

// --- The fingerprint reacts to changes --------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clamps-fp-'));
  const lispDir = path.join(dir, 'lisp');
  fs.mkdirSync(lispDir);
  const bootstrap = path.join(lispDir, 'bootstrap.lisp');
  fs.writeFileSync(bootstrap, '(print :a)\n');
  fs.writeFileSync(path.join(lispDir, 'rpc.lisp'), '(defun f () 1)\n');

  const m = new ClampsProcessManager(dir, bootstrap);
  const first = m.sourceFingerprint();
  check('the fingerprint is not empty', first.length > 0, true);
  check('Fingerprint stabil', m.sourceFingerprint(), first);
  check('beide Dateien erfasst', /bootstrap\.lisp/.test(first) && /rpc\.lisp/.test(first), true);

  // Change rpc.lisp: mtime AND size move.
  fs.writeFileSync(path.join(lispDir, 'rpc.lisp'), '(defun f () 2) ; geaendert\n');
  check('the fingerprint changes', m.sourceFingerprint() !== first, true);

  fs.rmSync(dir, { recursive: true, force: true });
}

// --- Panel focus at startup (v81.17) ----------------------------------
//
// At startup the debugger attaches automatically. In doing so VS Code
// opens the debug console and pushes the REPL out of the panel — after
// every start one landed on a console one does not need and had to click
// "Terminal" first. Two things therefore have to be in the source, and
// both are easy to edit out again without it being noticed: the debug
// configuration needs internalConsoleOptions 'neverOpen', and the REPL has
// to be brought to the front again AFTER attaching.
{
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8'
  );

  const attachCount = (source.match(/request:\s*'attach'/g) || []).length;
  const neverOpenCount = (source.match(/internalConsoleOptions:\s*'neverOpen'/g) || []).length;
  check(
    'every attach configuration suppresses the debug console',
    neverOpenCount,
    attachCount
  );

  // The order matters: attach first, then show the REPL. If the showing
  // comes before it, the debug view wins.
  const attachAt = source.indexOf("name: 'CLAMPS: Attach Debugger',\n                internalConsoleOptions");
  const showAfter = source.indexOf('ClampsReplTerminal.show', attachAt);
  check('the REPL is shown again after attaching', showAfter > attachAt, true);
}

if (failed === 0) console.log('ok — all session tests passed');
process.exit(failed === 0 ? 0 : 1);
