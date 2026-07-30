// test/freqscope.test.js
//
// The computations of the freq scope.
//
// A spectrum is the most thankless display in the project: it always
// looks right. An axis that is off by a factor, a note name that has
// slipped an octave, a pointer readout that does not match the drawn
// curve — none of that produces a conspicuous picture, and nobody checks
// the arithmetic while composing.
//
// So what is checked here is above all one thing: that THE SAME
// computation is the same in all three places. The frequency axis exists
// three times — as %spectrum-edge in rpc.lisp (that is where the columns
// arise), as columnFrequency in freqScope.ts, and once more in the
// webview, which has to manage without a module system and therefore
// repeats the function verbatim. If the three drift apart the curve is
// still right — only the grid lines and the pointer readout are
// elsewhere.
//
// Run: npx tsc -p ./ && node test/freqscope.test.js

require('./vscode-stub');

const {
  FreqScopeView, noteName, applyFall, columnFrequency, frequencyFraction,
  dbFraction,
} = require('../out/freqScope.js');

let failed = 0;
const fail = msg => { failed++; console.error(`FAILED ${msg}`); };
const near = (name, actual, expected, tolerance) => {
  if (!(Math.abs(actual - expected) < tolerance)) {
    fail(`${name}: ${actual} instead of ${expected} (tolerance ${tolerance})`);
  }
};
const equal = (name, actual, expected) => {
  if (actual !== expected) fail(`${name}: ${JSON.stringify(actual)} instead of ${JSON.stringify(expected)}`);
};

// ---------------------------------------------------------------------
// 1. Notennamen
// ---------------------------------------------------------------------
equal('Kammerton', noteName(440), 'A4 ±0 ct');
equal('Oktave darunter', noteName(220), 'A3 ±0 ct');
equal('C4', noteName(261.6256), 'C4 ±0 ct');
equal('leicht zu hoch', noteName(442), 'A4 +8 ct');
equal('leicht zu tief', noteName(437), 'A4 −12 ct');
// Outside the MIDI range and for nonsensical input, nothing is returned
// rather than a note being invented.
equal('null Hertz', noteName(0), '');
equal('negativ', noteName(-100), '');
equal('unendlich', noteName(Infinity), '');
equal('sehr hoch', noteName(30000), '');

// ---------------------------------------------------------------------
// 2. Spitzenwert-Haltung
// ---------------------------------------------------------------------
equal('the first value', applyFall(undefined, -30, 24, 50, -96), -30);
// Louder than held: follow immediately, do not rise slowly.
equal('Anstieg sofort', applyFall(-40, -10, 24, 50, -96), -10);
// Quieter: the held value falls at a fixed rate.
near('Abfall', applyFall(-10, -60, 24, 1000, -96), -34, 1e-9);
near('halbe Sekunde', applyFall(-10, -60, 24, 500, -96), -22, 1e-9);
// The floor is never undercut — otherwise the value grows without bound
// into the negative and the curve disappears from the picture.
equal('Boden haelt', applyFall(-90, -96, 24, 10000, -96), -96);

// ---------------------------------------------------------------------
// 3. The frequency axis: edges and their inverse
// ---------------------------------------------------------------------
// Dieselben Zahlen stehen in lisp/test-spectrum.lisp.
near('log-Kante 0', columnFrequency(0, 256, 20, 24000, 'log'), 20, 1e-9);
near('log-Kante Ende', columnFrequency(256, 256, 20, 24000, 'log'), 24000, 1e-6);
near('log-Mitte', columnFrequency(128, 256, 20, 24000, 'log'),
     Math.sqrt(20 * 24000), 1e-6);
near('lin-Mitte', columnFrequency(50, 100, 0, 24000, 'lin'), 12000, 1e-9);

for (const mode of ['log', 'lin']) {
  const fMin = mode === 'log' ? 23.4375 : 0;
  for (const index of [0, 1, 37, 128, 255, 256]) {
    const f = columnFrequency(index, 256, fMin, 24000, mode);
    const back = frequencyFraction(f, fMin, 24000, mode) * 256;
    near(`Umkehrung ${mode}/${index}`, back, index, 1e-6);
  }
}

// Strictly rising — otherwise the display draws columns in swapped order,
// and that is not noticeable in a spectrum.
for (const mode of ['log', 'lin']) {
  let previous = -1;
  for (let c = 0; c <= 256; c++) {
    const edge = columnFrequency(c, 256, mode === 'log' ? 20 : 0, 24000, mode);
    if (!(edge > previous)) fail(`Edge ${c} (${mode}) falls: ${edge} after ${previous}`);
    previous = edge;
  }
}

// Nonsensical bounds must not produce a NaN: a NaN in the fraction turns
// an x coordinate into NaN, and the curve vanishes silently.
for (const [freq, fMin, fMax, mode] of [
  [0, 20, 24000, 'log'], [-5, 20, 24000, 'log'], [1000, 0, 24000, 'log'],
  [1000, 24000, 24000, 'log'], [1000, 0, 0, 'lin'],
]) {
  const value = frequencyFraction(freq, fMin, fMax, mode);
  if (!Number.isFinite(value)) fail(`frequencyFraction(${freq},${fMin},${fMax},${mode}) is ${value}`);
}

// ---------------------------------------------------------------------
// 4. Dezibelachse
// ---------------------------------------------------------------------
equal('0 dB ganz oben', dbFraction(0, -96), 1);
equal('Boden ganz unten', dbFraction(-96, -96), 0);
near('halber Bereich', dbFraction(-48, -96), 0.5, 1e-12);
equal('below the floor', dbFraction(-200, -96), 0);
equal('ueber null', dbFraction(6, -96), 1);
equal('NaN', dbFraction(NaN, -96), 0);

// ---------------------------------------------------------------------
// 5. The webview and the module compute alike
// ---------------------------------------------------------------------
// The webview has no module system; it repeats columnFrequency,
// frequencyFraction and noteName verbatim. Twins of exactly that kind
// drift apart as soon as one of them is touched — and the bug would be a
// pointer readout that does not match the drawn curve. So the twin is cut
// out of the generated HTML here and computed against the module.
const html = FreqScopeView.html(
  { key: 'x', fftSize: 2048, window: 'hann', mode: 'log', floorDb: -96, columns: 256 },
  50
);
const start = html.indexOf('const columnFrequency');
const end = html.indexOf('const style =');
if (start < 0 || end < 0 || end <= start) {
  fail('The helper computations are no longer findable in the webview HTML — '
     + 'the comparison between module and webview then runs into the void');
} else {
  const twin = new Function(
    html.slice(start, end) +
    '\nreturn { columnFrequency, frequencyFraction, noteName, dbFraction };'
  )();

  for (const mode of ['log', 'lin']) {
    const fMin = mode === 'log' ? 23.4375 : 0;
    for (const index of [0, 1, 17, 128, 255, 256]) {
      near(`Zwilling columnFrequency ${mode}/${index}`,
           twin.columnFrequency(index, 256, fMin, 24000, mode),
           columnFrequency(index, 256, fMin, 24000, mode), 1e-9);
    }
    for (const f of [25, 100, 440, 3000, 12000, 23999]) {
      near(`Zwilling frequencyFraction ${mode}/${f}`,
           twin.frequencyFraction(f, fMin, 24000, mode),
           frequencyFraction(f, fMin, 24000, mode), 1e-12);
    }
  }
  for (const f of [110, 261.6256, 440, 442, 437, 0, -1, 30000]) {
    equal(`Zwilling noteName ${f}`, twin.noteName(f), noteName(f));
  }
  for (const db of [0, -12, -48, -96, -200]) {
    near(`Zwilling dbFraction ${db}`,
         twin.dbFraction(db, -96), dbFraction(db, -96), 1e-12);
  }
}

// ---------------------------------------------------------------------
// 6. The recipe appears whenever no ring can carry a spectrum
// ---------------------------------------------------------------------
// Not only when the list is empty. The common case is a session that
// already holds a level meter ring — decimation 441, capacity 256: there
// IS a ring, it simply cannot do this, and a bare error message leaves
// the user without a next step. That was the state shipped in 1.0.2.
if (!/anyUsable/.test(html)) {
  fail('The webview does not distinguish "no ring" from "no usable ring" — '
     + 'a level meter ring then yields a bare error with no recipe');
}
if (!html.includes('No registered ring can carry a spectrum.')) {
  fail('There is no recipe for the case of a registered but unusable ring');
}
// The recipe must not contain a decimation factor: a decimated ring folds
// high frequencies down where they look like real partials, so an
// instruction that produces one is worse than no instruction.
if (!html.includes('make-sticker-sample-state-for-repl')) {
  fail('The recipe does not name the ring constructor');
}
if (!html.includes("' 1))")) {
  fail('The recipe does not pass decimation 1 — it would produce an '
     + 'aliased ring that looks like it works');
}
if (!html.includes('sticker-state-record-sample-for-repl')) {
  fail('The recipe does not name the allocation-free recorder');
}
if (!/UNDECIMATED/.test(html)) {
  fail('The recipe does not stress that the ring must be undecimated');
}

// The classification itself, which is what decides all of the above.
{
  const unusable = (ring, fft) => FreqScopeView.unusableBecause(ring, fft);
  const sample = { capacity: 4096, decimation: 1, elementType: 'double-float' };
  equal('a proper scope ring is usable', unusable(sample, 2048), undefined);
  // Exactly the ring from the field report: the level meter's.
  equal('a level meter ring is rejected as decimated',
        unusable({ capacity: 256, decimation: 441, elementType: 'double-float' }, 2048),
        'decimated \u00d7441');
  equal('too small is reported with both numbers',
        unusable({ ...sample, capacity: 512 }, 2048), 'holds 512, needs 2048');
  equal('a boxed ring is rejected',
        unusable({ ...sample, elementType: 't' }, 2048), 'not a sample ring');
  // Decimation is checked before capacity: a decimated ring stays wrong
  // however large it is, so that is the reason worth showing.
  equal('decimation outranks capacity',
        unusable({ capacity: 8, decimation: 4, elementType: 'double-float' }, 2048),
        'decimated \u00d74');
  // The same ring changes verdict with the FFT size, which is why
  // changing the size has to re-judge the list.
  equal('usable at 2048', unusable({ ...sample, capacity: 2048 }, 2048), undefined);
  equal('unusable at 4096', unusable({ ...sample, capacity: 2048 }, 4096),
        'holds 2048, needs 4096');
}

if (failed > 0) {
  console.log(`\n${failed} Test(s) fehlgeschlagen.`);
  process.exit(1);
}
console.log(
  'ok — freq scope: note names and peak hold are right, the frequency axis '
  + 'is invertible and strictly rising, the webview computes like the module'
);
