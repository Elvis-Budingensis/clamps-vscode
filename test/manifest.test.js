// test/manifest.test.js
//
// Check package.json against the rules VS Code itself complains about.
//
// The occasion: the development workspace showed 27 warnings, all from
// package.json. Since VS Code 1.74.0 contributed commands, views and
// languages activate the extension implicitly; the corresponding
// onCommand/onView/onLanguage entries are then redundant and are each
// complained about individually. 21 + 5 + 1 = exactly those 27.
//
// The special case is what matters: onLanguage:commonlisp stays valid,
// because "commonlisp" is NOT contributed by this extension but by a
// second Lisp extension. Whoever removes all onLanguage entries wholesale
// silently undoes the v80 fix.
//
// Run: node test/manifest.test.js

const fs = require('fs');
const path = require('path');

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
);

let failed = 0;
const fail = msg => {
  failed++;
  console.log(`FAILED ${msg}`);
};

const contributes = manifest.contributes || {};
const commands = new Set((contributes.commands || []).map(c => c.command));
const views = new Set(
  Object.values(contributes.views || {}).flat().map(v => v.id)
);
const languages = new Set((contributes.languages || []).map(l => l.id));
const events = manifest.activationEvents || [];

// ---------------------------------------------------------------------
// 1. No redundant activation events
// ---------------------------------------------------------------------
const engine = String(manifest.engines?.vscode ?? '');
const major = Number(engine.replace(/[^0-9.]/g, '').split('.')[0] ?? 0);
const minor = Number(engine.replace(/[^0-9.]/g, '').split('.')[1] ?? 0);
const implicitSupported = major > 1 || (major === 1 && minor >= 74);

if (!implicitSupported) {
  console.log(`  Note: engines.vscode is ${engine} — before 1.74 the`);
  console.log('  Eintraege NOETIG. Pruefung uebersprungen.');
} else {
  for (const ev of events) {
    const [kind, id] = [ev.slice(0, ev.indexOf(':')), ev.slice(ev.indexOf(':') + 1)];
    if (kind === 'onCommand' && commands.has(id)) {
      fail(`redundant since 1.74 (the command is contributed): ${ev}`);
    }
    if (kind === 'onView' && views.has(id)) {
      fail(`redundant since 1.74 (the view is contributed): ${ev}`);
    }
    if (kind === 'onLanguage' && languages.has(id)) {
      fail(`redundant since 1.74 (the language is contributed): ${ev}`);
    }
  }
}

// ---------------------------------------------------------------------
// 2. A foreign language ID MUST stay explicit
// ---------------------------------------------------------------------
// commonlisp belongs to another extension. Without this entry CLAMPS does
// not activate when .lisp is assigned there — and then definition,
// completion and signature help are silently dead (see v80).
if (!languages.has('commonlisp') && !events.includes('onLanguage:commonlisp')) {
  fail('onLanguage:commonlisp is missing although commonlisp is not contributed by us');
}

// ---------------------------------------------------------------------
// 3. No references to undeclared IDs
// ---------------------------------------------------------------------
for (const kb of contributes.keybindings || []) {
  if (kb.command && !commands.has(kb.command)) {
    fail(`keybinding points at an unknown command: ${kb.command}`);
  }
}
for (const [menu, items] of Object.entries(contributes.menus || {})) {
  for (const item of items) {
    if (item.command && !commands.has(item.command)) {
      fail(`menu ${menu} points at an unknown command: ${item.command}`);
    }
  }
}
for (const ev of events) {
  if (ev.startsWith('onCommand:') && !commands.has(ev.slice(10))) {
    fail(`activationEvent for an undeclared command: ${ev}`);
  }
}

// ---------------------------------------------------------------------
// 4. The documentSelector fix from v80 must not disappear
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
    fail(`the LanguageClient's documentSelector lacks ${needed}`);
  }
}

// ---------------------------------------------------------------------
// 5. formatOnType has to be preset
// ---------------------------------------------------------------------
// The indentation provider hangs off OnTypeFormatting. If
// editor.formatOnType is off — and that is the VS Code default — it never
// fires, and the whole indentation is without effect for the user without
// anything looking broken. configurationDefaults is the way provided for
// this; the user can still override it.
const cfgDefaults = contributes.configurationDefaults || {};
for (const lang of ['[lisp]', '[commonlisp]']) {
  if (cfgDefaults[lang]?.['editor.formatOnType'] !== true) {
    fail(`configurationDefaults ${lang} without editor.formatOnType: true — OnTypeFormatting never fires`);
  }
}

if (failed > 0) {
  console.log(`\n${failed} Test(s) fehlgeschlagen.`);
  process.exit(1);
}
console.log(
  `ok — manifest clean: ${events.length} activation events, ` +
  `${commands.size} commands, no redundant or dead references`
);
