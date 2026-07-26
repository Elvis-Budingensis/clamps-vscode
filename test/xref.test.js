// test/xref.test.js
//
// Regressionstests für die Fehler, die in v76/v77 unbemerkt ausgeliefert
// wurden. Alle drei fielen nicht auf, weil kein Test sie berührte: die
// Suite kannte weder xref noch das rekursive Aufklappen.
//
// Aufruf: npx tsc -p ./ && node test/xref.test.js

require('./vscode-stub');

const { entryPosition } = require('../out/xrefBrowser.js');
const { ClampsInspector } = require('../out/inspector.js');

let failed = 0;
const check = (name, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++;
    console.log(`FEHLER ${name}\n  erwartet: ${JSON.stringify(expected)}\n  bekommen: ${JSON.stringify(actual)}`);
  }
};
const truthy = (name, actual) => check(name, !!actual, true);

// ---------------------------------------------------------------------
// Sprungziel: der Offset darf nicht von einer Zeile verdeckt werden
// ---------------------------------------------------------------------
// Attrappe eines Dokuments: Offset 4711 liegt auf Zeile 100, Spalte 7.
const doc = { positionAt: o => ({ line: 100, character: 7, _offset: o }) };
const pos = (entry) => entryPosition(entry, doc);

// Der eigentliche Fehler: SBCL liefert (:position N); rutscht daneben ein
// line=1 durch, landete jeder Sprung am Dateianfang.
check('Offset schlaegt Zeile',
  pos({ file: '/x.lisp', line: 1, character: 0, offset: 4711 })._offset, 4710);
check('Offset allein',
  pos({ file: '/x.lisp', offset: 4711 })._offset, 4710);
check('Zeile allein, einsbasiert -> nullbasiert',
  [pos({ file: '/x.lisp', line: 12, character: 3 }).line,
   pos({ file: '/x.lisp', line: 12, character: 3 }).character], [11, 3]);
check('null zaehlt nicht als Angabe',
  [pos({ file: '/x.lisp', line: null, character: null, offset: null }).line,
   pos({ file: '/x.lisp', line: null, offset: null }).character], [0, 0]);
check('gar keine Angabe',
  [pos({ file: '/x.lisp' }).line, pos({ file: '/x.lisp' }).character], [0, 0]);
// Offset 0 ist eine Angabe, keine Abwesenheit — und darf nicht negativ werden.
check('Offset 0 bleibt bei 0', pos({ file: '/x.lisp', offset: 0 })._offset, 0);
check('Zeile 0 wird nicht negativ', pos({ file: '/x.lisp', line: 0 }).line, 0);

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

// Anführungszeichen in Labels: prin1-to-string liefert String-Schlüssel
// einer Hashtable immer als "key" — das landet in data-label="…" und
// title="…" und brach dort das Attribut auf.
{
  resetI();
  const html = I.render(result({
    parts: [{ label: '"key"', index: 0, preview: '1', navigable: true }],
  }));
  truthy('Anfuehrungszeichen maskiert', html.includes('&quot;key&quot;'));
  check('kein rohes Anfuehrungszeichen im Label', /data-label="[^"]*"[^ >]/.test(html), false);
}
{
  resetI();
  const html = I.render(result({
    parts: [{ label: `" onmouseover="alert(1)`, index: 0, preview: 'x', navigable: true }],
  }));
  // Der Text 'onmouseover=' steht maskiert im Label und ist dort harmlos;
  // gefährlich wäre er nur mit einem echten Anführungszeichen dahinter.
  check('kein Ausbruch aus dem Attribut', html.includes('onmouseover="'), false);
  check('einfaches Anfuehrungszeichen maskiert',
    I.render(result({ parts: [{ label: "it's", index: 0, navigable: true }] })).includes('&#39;'), true);
}

// Aufklapp-Pfeil nur an Teilen, die selbst Teile haben.
{
  resetI();
  const html = I.render(result({
    parts: [
      { label: 'a', index: 0, preview: '42', navigable: true, expandable: false },
      { label: 'b', index: 1, preview: '(1 2)', navigable: true, expandable: true },
    ],
  }));
  check('genau ein Pfeil', (html.match(/data-expand-path=/g) || []).length, 1);
  truthy('Platzhalter fuer den Rest', html.includes('twisty spacer'));
}
{
  // Älteres Image ohne das Feld: Verhalten wie vorher, Pfeil an allem
  // Gebundenen — lieber ein Pfeil zu viel als ein fehlender.
  resetI();
  const html = I.render(result({
    parts: [{ label: 'a', index: 0, navigable: true },
            { label: 'b', index: 1, navigable: false }],
  }));
  check('ohne Feld: Pfeil am gebundenen Teil', (html.match(/data-expand-path=/g) || []).length, 1);
}

// Filter: eine id pro Ebene, nicht dieselbe mehrfach.
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
  check('keine doppelte id="filter"', (html.match(/id="filter"/g) || []).length, 0);
  // Nur die Treffer im Markup zählen — im <script> steht der Selektor
  // ebenfalls als Text.
  const lists = html.match(/<div class="recursive-list" data-filter-list="([^"]+)"/g) || [];
  check('jede Liste adressierbar', lists.length, 2);
  check('Listen passen zu den Feldern',
    lists.map(l => l.match(/data-filter-list="([^"]+)"/)[1]).sort(),
    inputs.map(i => i.match(/data-filter-input="([^"]+)"/)[1]).sort());
}

// Zyklus: das Image gibt für dasselbe Objekt dieselbe ID zurück, erst
// dadurch ist der Rückverweis überhaupt erkennbar.
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
  truthy('Zyklus wird gemeldet', html.includes('Zyklus zu Objekt #42'));
  // Auf das Markup prüfen, nicht auf den Klassennamen: der steht auch im
  // CSS-Block derselben Seite.
  check('Unterbaum nicht aufgeklappt', html.includes('class="recursive-head"'), false);
}
{
  // Kein Zyklus: fremde ID, Unterbaum wird gezeichnet.
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
  check('kein falscher Zyklus', html.includes('Zyklus'), false);
  truthy('Label des Enkels maskiert', html.includes('&quot;Hauptstr.&quot;'));
}
resetI();

if (failed === 0) console.log('ok — alle XREF- und Inspector-Tests bestanden');
process.exit(failed === 0 ? 0 : 1);
