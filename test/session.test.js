// test/session.test.js
//
// Prüft, wann eine laufende CLAMPS-Session weiterbenutzt wird.
//
// Der Anlass: bisher reichte "PID lebt". Weil deactivate() das Image
// absichtlich am Leben lässt, entwickelte man damit gegen ein Image, in
// dem noch die alten lisp/*.lisp geladen waren — und der Ausweg war,
// vor jedem Start von Hand session.json zu löschen.
//
// Aufruf: npx tsc -p ./ && node test/session.test.js

require('./vscode-stub');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClampsProcessManager } = require('../out/processManager.js');

let failed = 0;
const check = (name, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++;
    console.log(`FEHLER ${name}\n  erwartet: ${JSON.stringify(expected)}\n  bekommen: ${JSON.stringify(actual)}`);
  }
};

const ready = { port: 4005, pid: 4242, status: 'ready', detail: '' };
const decide = over => ClampsProcessManager.reuseDecision({
  info: ready, pidAlive: true, portAnswers: true, fingerprintMatches: true, ...over,
});

// --- weiterbenutzen -------------------------------------------------
check('alles in Ordnung', decide({}).reuse, true);

// --- frisch starten -------------------------------------------------
check('keine Session', decide({ info: null }).reuse, false);
check('Status starting', decide({ info: { ...ready, status: 'starting' } }).reuse, false);
check('Status error', decide({ info: { ...ready, status: 'error' } }).reuse, false);
check('Status stopped', decide({ info: { ...ready, status: 'stopped' } }).reuse, false);
check('PID tot', decide({ pidAlive: false }).reuse, false);
check('kein PID', decide({ info: { ...ready, pid: null } }).reuse, false);
check('kein Port', decide({ info: { ...ready, port: null } }).reuse, false);

// Lebender PID, aber niemand antwortet: haengendes Image oder die
// Prozessnummer wurde nach einem Absturz neu vergeben.
check('Port antwortet nicht', decide({ portAnswers: false }).reuse, false);
check('Grund genannt', /antwortet nicht/.test(decide({ portAnswers: false }).reason), true);

// Der eigentliche Fall.
check('Quellen geaendert', decide({ fingerprintMatches: false }).reuse, false);
check('Grund genannt', /Quellen/.test(decide({ fingerprintMatches: false }).reason), true);

// --- Fingerprint reagiert auf Änderungen ----------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clamps-fp-'));
  const lispDir = path.join(dir, 'lisp');
  fs.mkdirSync(lispDir);
  const bootstrap = path.join(lispDir, 'bootstrap.lisp');
  fs.writeFileSync(bootstrap, '(print :a)\n');
  fs.writeFileSync(path.join(lispDir, 'rpc.lisp'), '(defun f () 1)\n');

  const m = new ClampsProcessManager(dir, bootstrap);
  const first = m.sourceFingerprint();
  check('Fingerprint nicht leer', first.length > 0, true);
  check('Fingerprint stabil', m.sourceFingerprint(), first);
  check('beide Dateien erfasst', /bootstrap\.lisp/.test(first) && /rpc\.lisp/.test(first), true);

  // rpc.lisp ändern: mtime UND Größe wandern.
  fs.writeFileSync(path.join(lispDir, 'rpc.lisp'), '(defun f () 2) ; geaendert\n');
  check('Fingerprint aendert sich', m.sourceFingerprint() !== first, true);

  fs.rmSync(dir, { recursive: true, force: true });
}

if (failed === 0) console.log('ok — alle Session-Tests bestanden');
process.exit(failed === 0 ? 0 : 1);
