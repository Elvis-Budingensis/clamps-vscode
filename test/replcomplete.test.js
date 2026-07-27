// test/replcomplete.test.js
//
// Tab-Completion im REPL-Terminal.
//
// Das Terminal hat keinen Dokumentenpuffer, also schneidet der Client das
// Praefix selbst ab und schickt es mit. Genau da liegt die Fehlerquelle:
// schneidet der Client anders als symbol-constituent-p in
// bridge-server.lisp, dann filtert der Server nach einem anderen Praefix
// als der Benutzer getippt hat — und zwar still, es kommen nur falsche
// Vorschlaege. Deshalb wird die Zeichenklasse hier festgenagelt.
//
// Aufruf: npx tsc -p ./ && node test/replcomplete.test.js

require('./vscode-stub');

const { ClampsReplTerminal } = require('../out/replTerminal.js');

let failed = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FEHLER ${name}: ${a} statt ${e}`);
    failed++;
  }
};
const ok = (name, condition) => {
  if (!condition) {
    console.error(`FEHLER ${name}`);
    failed++;
  }
};

// --- Ein Terminal ohne VS Code dahinter ------------------------------
//
// Der Konstruktor ist privat und open() braucht ein echtes Terminal.
// Fuer die Eingabelogik genuegt das Prototyp-Objekt mit gesetzten Feldern;
// die Ausgabe wird mitgeschrieben statt gesendet.
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

check('Symbolanfang', tokenOf('(map'), 'map');
check('nach Leerzeichen leer', tokenOf('(mapcar '), '');
check('Bindestriche gehoeren dazu', tokenOf('(rt-st'), 'rt-st');
check('Paketpraefix gehoert dazu', tokenOf('(incudine:rt-st'), 'incudine:rt-st');
check('Keyword gehoert dazu', tokenOf('(make-array 3 :el'), ':el');
check('Ausrufezeichen gehoert dazu', tokenOf('(dsp'), 'dsp');
check('Klammer trennt', tokenOf('(foo(bar'), 'bar');
check('Anfuehrungszeichen trennt', tokenOf('(foo "ba'), 'ba');
check('vor dem Cursor, nicht dahinter', tokenOf('(mapcar list)', 5), 'mapc');

// --- Gemeinsamer Anfang ----------------------------------------------

check('ein Kandidat', ClampsReplTerminal.commonPrefix(['mapcar']), 'mapcar');
check('gemeinsamer Anfang',
  ClampsReplTerminal.commonPrefix(['mapcar', 'mapcan', 'mapc']), 'mapc');
check('kein gemeinsamer Anfang',
  ClampsReplTerminal.commonPrefix(['mapcar', 'reduce']), '');
// Zeichengenau: die Bridge liefert immer Kleinschreibung, und ein
// gemischt geschriebener Einsatz waere schlimmer als ein kuerzerer.
check('zeichengenau verglichen',
  ClampsReplTerminal.commonPrefix(['mapCar', 'mapcan']), 'map');

// --- Verhalten von Tab -----------------------------------------------

(async () => {
  // Ein Kandidat wird eingesetzt.
  {
    const t = makeTerminal([item('mapcar')], '(mapc');
    await t.complete();
    check('ein Treffer wird eingesetzt', t.buffer, '(mapcar');
    check('Cursor hinter der Einsetzung', t.cursor, '(mapcar'.length);
  }

  // Der Server bekommt Praefix, Paket und Kontext.
  {
    const t = makeTerminal([item('mapcar')], '(mapc');
    await t.complete();
    check('Methode', t.requests[0].method, 'clamps/replComplete');
    check('Praefix', t.requests[0].params.prefix, 'mapc');
    check('Paket', t.requests[0].params.package, 'CLAMPS');
    check('Kontext', t.requests[0].params.context, '(mapc');
  }

  // Mehrere Kandidaten werden auf den gemeinsamen Anfang gekuerzt.
  {
    const t = makeTerminal([item('mapcar'), item('mapcan')], '(ma');
    await t.complete();
    check('gemeinsamer Anfang wird eingesetzt', t.buffer, '(mapca');
  }

  // Bringt der gemeinsame Anfang nichts, listet erst der ZWEITE Tab.
  {
    const t = makeTerminal([item('mapcar'), item('mapcan')], '(mapca');
    await t.complete();
    check('erster Tab schreibt nichts', t.written.length, 0);
    ok('erster Tab merkt sich den Puffer', t.lastCompletionAt === '(mapca');
    await t.complete();
    ok('zweiter Tab listet', t.written.join('').includes('mapcar'));
    ok('zweiter Tab listet beide', t.written.join('').includes('mapcan'));
    ok('Merkung ist zurueckgesetzt', t.lastCompletionAt === undefined);
  }

  // Tippen zwischen zwei Tabs setzt die Merkung zurueck: es soll nicht
  // ueberraschend eine Liste erscheinen, nur weil vorher mal Tab kam.
  {
    const t = makeTerminal([item('mapcar'), item('mapcan')], '(mapca');
    await t.complete();
    t.insert('r');
    ok('Tippen loescht die Merkung', t.lastCompletionAt === undefined);
  }

  // Keine Kandidaten: nichts einsetzen, nichts ausgeben.
  {
    const t = makeTerminal([], '(zzz');
    await t.complete();
    check('kein Treffer aendert nichts', t.buffer, '(zzz');
    check('kein Treffer schreibt nichts', t.written.length, 0);
  }

  // Ein Fehler in der Bridge darf die Eingabe nicht zerstoeren.
  {
    const t = makeTerminal([], '(map');
    t.getClient = () => ({
      state: 2,
      sendRequest: () => Promise.reject(new Error('weg')),
    });
    await t.complete();
    check('Fehler laesst den Puffer stehen', t.buffer, '(map');
    check('Fehler schreibt nichts', t.written.length, 0);
  }

  // Ohne laufenden Client passiert nichts.
  {
    const t = makeTerminal([item('mapcar')], '(mapc');
    t.getClient = () => undefined;
    await t.complete();
    check('ohne Client unveraendert', t.buffer, '(mapc');
  }

  // Waehrend einer laufenden Auswertung nicht dazwischenfunken.
  {
    const t = makeTerminal([item('mapcar')], '(mapc');
    t.busy = true;
    await t.complete();
    check('busy blockt', t.buffer, '(mapc');
  }

  if (failed > 0) {
    console.error(`\n${failed} Fehler.`);
    process.exit(1);
  }
  console.log('ok — REPL-Tab-Completion: Praefix, gemeinsamer Anfang, zweiter Tab listet');
})();
