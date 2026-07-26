// test/gatecoverage.test.js
//
// Prueft, dass jede Testdatei ueberhaupt AUSGEFUEHRT wird.
//
// Anlass: das ist heute zweimal schiefgegangen, beide Male zufaellig
// gefunden.
//
//   - lisp/test-inspect.lisp — der gruendlichste Test im Projekt, 80
//     Formen ueber 17 Typen, Slot-Setzen, Zirkularitaet, Teile-Cache —
//     hing in KEINER npm-Kette. Er lief nie.
//   - test/lispstring.test.js hatte eine Whitelist von 15 Dateinamen. Als
//     v81 drei Module hinzufuegte, standen die nicht darin, und
//     advancedTools.ts baute prompt wieder einen Lisp-String mit
//     JSON.stringify. Gruen durchgelaufen, weil die Datei nie gelesen
//     wurde.
//
// Beides derselbe Fehler: eine gepflegte Liste, die beim naechsten neuen
// Code verfaellt. Ein Test, der nicht laeuft, ist schlimmer als kein
// Test — er erzeugt Vertrauen, das nicht gedeckt ist.
//
// Aufruf: node test/gatecoverage.test.js

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const scripts = manifest.scripts || {};

let failed = 0;
const fail = msg => { failed++; console.log(`FEHLER ${msg}`); };

/**
 * Alle Befehle, die `npm run gates` letztlich ausfuehrt — npm-Skripte
 * rekursiv aufloesen, damit auch Ketten wie
 * "gates -> lisp -> sbcl --script …" erfasst werden.
 */
function expand(name, seen = new Set()) {
  if (seen.has(name)) return '';
  seen.add(name);
  let text = scripts[name] ?? '';
  // Sowohl "npm run foo" als auch die Kurzformen "npm test" und
  // "npm start", die npm ohne "run" akzeptiert. Ohne die Kurzform blieb
  // "gates -> npm test" unaufgeloest, und das Gate meldete jeden
  // JS-Test als nicht ausgefuehrt — falscher Alarm statt Fund.
  for (const ref of text.matchAll(/npm (?:run\s+)?([\w:-]+)/g)) {
    if (ref[1] === 'run') continue;
    text += '\n' + expand(ref[1], seen);
  }
  return text;
}

if (!scripts.gates) {
  fail('kein npm-Skript "gates" — die Gate-Kette ist der Qualitaetsmassstab');
  console.log(`\n${failed} Test(s) fehlgeschlagen.`);
  process.exit(1);
}
const chain = expand('gates');

// ---------------------------------------------------------------------
// 1. Jede test/*.test.js kommt in der Kette vor
// ---------------------------------------------------------------------
const jsTests = fs.readdirSync(path.join(root, 'test'))
  .filter(f => f.endsWith('.test.js')).sort();
for (const file of jsTests) {
  if (!chain.includes(file)) {
    fail(`test/${file} laeuft in keiner npm-Kette — der Test existiert, wird aber nie ausgefuehrt`);
  }
}

// ---------------------------------------------------------------------
// 2. Jede lisp/test-*.lisp und die Prueflaeufe kommen in der Kette vor
// ---------------------------------------------------------------------
const lispTests = fs.readdirSync(path.join(root, 'lisp'))
  .filter(f => /^(test-.*|loadcheck|framingtest|swankframing)\.lisp$/.test(f)).sort();
for (const file of lispTests) {
  if (!chain.includes(file)) {
    fail(`lisp/${file} laeuft in keiner npm-Kette — der Test existiert, wird aber nie ausgefuehrt`);
  }
}

// ---------------------------------------------------------------------
// 3. Kein Frueh-Ausstieg mitten in einer Testdatei
// ---------------------------------------------------------------------
// test-inspect.lisp enthaelt
//     (when (sb-ext:posix-getenv "TEST_EXIT") (sb-ext:exit :code 0))
// mitten in der Datei. In den Gates ist die Variable nicht gesetzt, also
// laeuft alles; wer sie aber setzt, ueberspringt still den Rest — und
// merkt es nicht, weil der Lauf mit Code 0 endet. Ein Ausstieg im
// LETZTEN Fuenftel ist Abschluss, weiter vorn ist eine Falle.
for (const file of lispTests) {
  const full = path.join(root, 'lisp', file);
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (/\(sb-ext:exit\s+:code\s+0\)/.test(line) && !/FEHLER|failed/.test(line)) {
      const position = (i + 1) / lines.length;
      if (position < 0.8) {
        fail(`lisp/${file}:${i + 1} steigt bei ${Math.round(position * 100)}% der Datei mit Code 0 aus — alles danach wird still uebersprungen`);
      }
    }
  });
}

// ---------------------------------------------------------------------
// 4. Keine Datei-Whitelists in Tests
// ---------------------------------------------------------------------
// Der lispstring-Waechter hatte 15 Dateinamen eingetragen. Wer src/
// pruefen will, liest src/ — sonst verfaellt die Liste beim naechsten
// neuen Modul.
for (const file of jsTests) {
  const src = fs.readFileSync(path.join(root, 'test', file), 'utf8');
  // Ein Array-Literal mit drei oder mehr .ts-Dateinamen darin.
  const suspicious = src.match(/\[[^\]]*?(?:'[\w.]+\.ts'[^\]]*?){3,}\]/s);
  if (suspicious) {
    fail(`test/${file} enthaelt eine Liste von .ts-Dateinamen — src/ direkt lesen, sonst verfaellt sie bei neuem Code`);
  }
}

if (failed > 0) {
  console.log(`\n${failed} Test(s) fehlgeschlagen.`);
  process.exit(1);
}
console.log(
  `ok — alle Tests laufen: ${jsTests.length} JS, ${lispTests.length} Lisp, ` +
  'keine Frueh-Ausstiege, keine Datei-Whitelists'
);
