const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');

const root = path.join(__dirname, '..');
const vsix = fs.readdirSync(root).filter(f => f.endsWith('.vsix')).sort().pop();
if (!vsix) { console.log('ok — package gate: kein .vsix vorhanden, übersprungen'); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vsixgate-'));
execFileSync('unzip', ['-q', path.join(root, vsix), '-d', tmp]);
const out = path.join(tmp, 'extension', 'out');

// jedes require() aus out/ muss aus dem Paket heraus auflösbar sein
const mods = new Set();
for (const f of fs.readdirSync(out).filter(f => f.endsWith('.js')))
  for (const m of fs.readFileSync(path.join(out, f), 'utf8').matchAll(/require\("([^".][^"]*)"\)/g))
    if (m[1] !== 'vscode') mods.add(m[1]);

const missing = [...mods].filter(m => {
  try { require.resolve(m, { paths: [out] }); return false; } catch { return true; }
});
fs.rmSync(tmp, { recursive: true, force: true });

if (missing.length) {
  console.error(`FEHLER — im .vsix nicht auflösbar: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`ok — package gate: ${mods.size} Laufzeitmodule im .vsix auflösbar`);