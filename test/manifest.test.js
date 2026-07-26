// test/manifest.test.js
//
// package.json gegen die Regeln pruefen, die VS Code selbst anmahnt.
//
// Anlass: der Entwicklungs-Workspace zeigte 27 Warnungen, alle aus
// package.json. Seit VS Code 1.74.0 aktivieren beigesteuerte Befehle,
// Views und Sprachen die Extension implizit; die zugehoerigen
// onCommand-/onView-/onLanguage-Eintraege sind dann redundant und werden
// je einzeln angemahnt. 21 + 5 + 1 = genau die 27.
//
// Wichtig ist der Sonderfall: onLanguage:commonlisp bleibt gueltig, weil
// "commonlisp" NICHT von dieser Extension beigesteuert wird, sondern von
// einer zweiten Lisp-Extension. Wer hier pauschal alle onLanguage-
// Eintraege entfernt, macht den v80-Fix still rueckgaengig.
//
// Aufruf: node test/manifest.test.js

const fs = require('fs');
const path = require('path');

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
);

let failed = 0;
const fail = msg => {
  failed++;
  console.log(`FEHLER ${msg}`);
};

const contributes = manifest.contributes || {};
const commands = new Set((contributes.commands || []).map(c => c.command));
const views = new Set(
  Object.values(contributes.views || {}).flat().map(v => v.id)
);
const languages = new Set((contributes.languages || []).map(l => l.id));
const events = manifest.activationEvents || [];

// ---------------------------------------------------------------------
// 1. Keine redundanten Aktivierungsereignisse
// ---------------------------------------------------------------------
const engine = String(manifest.engines?.vscode ?? '');
const major = Number(engine.replace(/[^0-9.]/g, '').split('.')[0] ?? 0);
const minor = Number(engine.replace(/[^0-9.]/g, '').split('.')[1] ?? 0);
const implicitSupported = major > 1 || (major === 1 && minor >= 74);

if (!implicitSupported) {
  console.log(`  Hinweis: engines.vscode ist ${engine} — vor 1.74 sind die`);
  console.log('  Eintraege NOETIG. Pruefung uebersprungen.');
} else {
  for (const ev of events) {
    const [kind, id] = [ev.slice(0, ev.indexOf(':')), ev.slice(ev.indexOf(':') + 1)];
    if (kind === 'onCommand' && commands.has(id)) {
      fail(`redundant seit 1.74 (Befehl wird beigesteuert): ${ev}`);
    }
    if (kind === 'onView' && views.has(id)) {
      fail(`redundant seit 1.74 (View wird beigesteuert): ${ev}`);
    }
    if (kind === 'onLanguage' && languages.has(id)) {
      fail(`redundant seit 1.74 (Sprache wird beigesteuert): ${ev}`);
    }
  }
}

// ---------------------------------------------------------------------
// 2. Fremde Sprach-ID MUSS explizit bleiben
// ---------------------------------------------------------------------
// commonlisp gehoert einer anderen Extension. Ohne diesen Eintrag
// aktiviert CLAMPS nicht, wenn .lisp dort zugeordnet ist — und dann sind
// Definition, Completion und Signature Help still tot (siehe v80).
if (!languages.has('commonlisp') && !events.includes('onLanguage:commonlisp')) {
  fail('onLanguage:commonlisp fehlt, obwohl commonlisp nicht selbst beigesteuert wird');
}

// ---------------------------------------------------------------------
// 3. Keine Verweise auf nicht deklarierte IDs
// ---------------------------------------------------------------------
for (const kb of contributes.keybindings || []) {
  if (kb.command && !commands.has(kb.command)) {
    fail(`keybinding zeigt auf unbekannten Befehl: ${kb.command}`);
  }
}
for (const [menu, items] of Object.entries(contributes.menus || {})) {
  for (const item of items) {
    if (item.command && !commands.has(item.command)) {
      fail(`menu ${menu} zeigt auf unbekannten Befehl: ${item.command}`);
    }
  }
}
for (const ev of events) {
  if (ev.startsWith('onCommand:') && !commands.has(ev.slice(10))) {
    fail(`activationEvent fuer nicht deklarierten Befehl: ${ev}`);
  }
}

// ---------------------------------------------------------------------
// 4. Der documentSelector-Fix aus v80 darf nicht verschwinden
// ---------------------------------------------------------------------
const extSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8'
);
const selectorBlock = extSrc.slice(
  extSrc.indexOf('documentSelector'),
  extSrc.indexOf('documentSelector') + 400
);
for (const needed of ["language: 'lisp'", "language: 'commonlisp'"]) {
  if (!selectorBlock.includes(needed)) {
    fail(`documentSelector des LanguageClient ohne ${needed}`);
  }
}

// ---------------------------------------------------------------------
// 5. formatOnType muss vorbelegt sein
// ---------------------------------------------------------------------
// Der Einrueckungs-Provider haengt an OnTypeFormatting. Ist
// editor.formatOnType aus — und das ist die VS-Code-Voreinstellung —
// feuert er nie, und die ganze Einrueckung ist beim Nutzer wirkungslos,
// ohne dass etwas kaputt aussieht. configurationDefaults ist der dafuer
// vorgesehene Weg; ueberschreiben kann der Nutzer weiterhin.
const cfgDefaults = contributes.configurationDefaults || {};
for (const lang of ['[lisp]', '[commonlisp]']) {
  if (cfgDefaults[lang]?.['editor.formatOnType'] !== true) {
    fail(`configurationDefaults ${lang} ohne editor.formatOnType: true — OnTypeFormatting feuert nie`);
  }
}

if (failed > 0) {
  console.log(`\n${failed} Test(s) fehlgeschlagen.`);
  process.exit(1);
}
console.log(
  `ok — Manifest sauber: ${events.length} Aktivierungsereignisse, ` +
  `${commands.size} Befehle, keine redundanten oder toten Verweise`
);
