// test/ats.test.js
//
// The ATS browser's client-side computations.
//
// The reader is checked in lisp/test-ats.lisp, against files this project
// writes itself — the one place in the codebase where the expected answer
// is known down to the last double. What is left for here is the display,
// and two things about it are worth pinning down because both are wrong in
// ways that look right:
//
//   - The frequency axis has to be invertible. The readout under the
//     pointer comes from the inverse; if the two drift apart, the picture
//     stays correct and the numbers next to it lie.
//   - The analysis resolution has to be reported. Partials closer together
//     than the window allows cannot have been separated, so two lines that
//     nearly touch may be one partial the tracker split. Without the
//     figure next to the picture, there is no way to tell.
//
// Run: npx tsc -p ./ && node test/ats.test.js

require('./vscode-stub');

const { atsTypeLabel, analysisResolution, secondsPerColumn } =
  require('../out/atsView.js');

let failed = 0;
const fail = msg => { failed++; console.error(`FAILED ${msg}`); };
const equal = (name, actual, expected) => {
  if (actual !== expected) {
    fail(`${name}: ${JSON.stringify(actual)} instead of ${JSON.stringify(expected)}`);
  }
};
const near = (name, actual, expected, tolerance) => {
  if (!(Math.abs(actual - expected) < tolerance)) {
    fail(`${name}: ${actual} instead of ${expected}`);
  }
};

// ---------------------------------------------------------------------
// 1. The type says what can be seen in the file
// ---------------------------------------------------------------------
// The bare numbers 1 to 4 say nothing to anyone who has not just read the
// format description, and which of them a file is decides whether there is
// noise and phase in it at all.
for (const [type, needle] of [[1, 'amplitude and frequency'],
                              [2, 'phase'],
                              [3, 'residual noise'],
                              [4, 'phase']]) {
  if (!atsTypeLabel(type).includes(needle)) {
    fail(`type ${type} is described as "${atsTypeLabel(type)}" — "${needle}" missing`);
  }
}
// Types 1 and 2 carry no noise, and the label must not claim otherwise.
for (const type of [1, 2]) {
  if (atsTypeLabel(type).includes('noise')) {
    fail(`type ${type} is described as having noise: "${atsTypeLabel(type)}"`);
  }
}
// An unknown type is named as unknown rather than silently called type 1.
if (!atsTypeLabel(9).includes('unknown')) {
  fail(`an unknown type is described as "${atsTypeLabel(9)}"`);
}

// ---------------------------------------------------------------------
// 2. The analysis resolution
// ---------------------------------------------------------------------
// This is the figure that says which distinctions in the picture are real.
near('44100 over 1024', analysisResolution(44100, 1024), 43.066, 0.01);
near('44100 over 4096', analysisResolution(44100, 4096), 10.767, 0.01);
// A longer window resolves better; if this were the other way round the
// figure would be actively misleading.
if (!(analysisResolution(44100, 4096) < analysisResolution(44100, 1024))) {
  fail('a longer window is not reported as finer resolution');
}
// Nonsense yields 0 rather than Infinity or NaN: a resolution of NaN would
// end up in the caption as "NaN Hz resolution".
for (const [rate, window] of [[0, 1024], [44100, 0], [-1, -1]]) {
  const value = analysisResolution(rate, window);
  if (!Number.isFinite(value)) {
    fail(`analysisResolution(${rate}, ${window}) is ${value}`);
  }
}

// ---------------------------------------------------------------------
// 3. Time per column
// ---------------------------------------------------------------------
near('one second over 400 columns', secondsPerColumn(1, 400), 0.0025, 1e-12);
near('two seconds over 100 columns', secondsPerColumn(2, 100), 0.02, 1e-12);
equal('no columns yields 0', secondsPerColumn(1, 0), 0);

// ---------------------------------------------------------------------
// 4. The webview's frequency axis is invertible
// ---------------------------------------------------------------------
// The axis exists only inside the webview, which has no module system. If
// yOf and freqAt drift apart, the picture stays right and the readout
// under the pointer lies — the same class of error the freq scope's twin
// check guards against, and just as invisible.
const { AtsView } = require('../out/atsView.js');
const html = AtsView.html('/tmp/example.ats');
{
  const start = html.indexOf('const fMin =');
  const end = html.indexOf('const noteName =');
  if (start < 0 || end < 0 || end <= start) {
    fail('the axis functions are no longer findable in the webview HTML — '
       + 'the comparison then runs into the void');
  } else {
    const twin = new Function(
      'canvas', 'outline', 'axis',
      html.slice(start, end) + '\nreturn { yOf, freqAt, fMin, fMax };'
    )({ height: 320 }, { maxFrequency: 20000 }, 'log');

    for (const f of [20, 55, 110, 440, 1000, 4400, 19000]) {
      const back = twin.freqAt(twin.yOf(f));
      if (Math.abs(back / f - 1) > 1e-9) {
        fail(`log axis is not invertible at ${f} Hz: back as ${back}`);
      }
    }
    // Higher frequencies sit higher up, that is, at a smaller y.
    let previous = Infinity;
    for (const f of [20, 100, 1000, 10000, 20000]) {
      const y = twin.yOf(f);
      if (!(y < previous)) fail(`${f} Hz does not lie above the previous frequency`);
      previous = y;
    }
    // Zero and negative frequencies must not produce NaN: a NaN y makes
    // the whole line vanish without a trace.
    for (const f of [0, -100]) {
      if (!Number.isFinite(twin.yOf(f))) {
        fail(`yOf(${f}) is ${twin.yOf(f)}`);
      }
    }
  }
}

// ---------------------------------------------------------------------
// 5. Gaps in a partial are not bridged
// ---------------------------------------------------------------------
// Where the tracker had no partial, no line may be drawn. Joining across a
// gap invents a trajectory — and a straight line through a silence looks
// exactly like a partial that was there.
if (!/if \(drawing\) \{ context\.stroke\(\); drawing = false; \}/.test(html)) {
  fail('the drawing does not break the line at a gap — a silence would be '
     + 'bridged with a straight line that looks like a partial');
}

if (failed > 0) {
  console.log(`\n${failed} failure(s).`);
  process.exit(1);
}
console.log(
  'ok — ATS browser: types described, analysis resolution reported, '
  + 'frequency axis invertible, gaps in a partial not bridged'
);
