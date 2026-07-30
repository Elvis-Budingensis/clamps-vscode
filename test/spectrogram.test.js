// test/spectrogram.test.js
//
// The spectrogram's pure computations.
//
// The Lisp gate (lisp/test-spectrum.lisp) covers the frame grid: that
// frame F really contains the samples of frame F, checked against a signal
// that changes with time. What is left for here is the client side, and
// above all the two places where a spectrogram lies without looking wrong:
//
//   - The ring requirement. A spectrogram needs MORE headroom than the
//     scope: between two requests the ring has to keep the frames accrued
//     in the meantime, not just one window. Too small and frames drop out
//     — invisibly, because the picture stays continuous while everything
//     to the right of the gap is misdated.
//   - The request size. Ask for fewer frames than accrue and the view
//     falls behind for good, a little more with every request. Nothing in
//     the picture says so; it just drifts into the past.
//
// Run: npx tsc -p ./ && node test/spectrogram.test.js

require('./vscode-stub');

const { SpectrogramView, framesPerRequest, pollIntervalFor, levelColour,
        MAX_FRAMES_PER_REQUEST } = require('../out/spectrogramView.js');

let failed = 0;
const fail = msg => { failed++; console.error(`FAILED ${msg}`); };
const equal = (name, actual, expected) => {
  if (actual !== expected) {
    fail(`${name}: ${JSON.stringify(actual)} instead of ${JSON.stringify(expected)}`);
  }
};
const truthy = (name, value) => { if (!value) fail(`${name}: expected truthy`); };

// ---------------------------------------------------------------------
// 1. Ring classification — stricter than the scope's
// ---------------------------------------------------------------------
const unusable = (ring, fft) => SpectrogramView.unusableBecause(ring, fft);
const sample = { capacity: 8192, decimation: 1, elementType: 'double-float' };

equal('a large sample ring is usable', unusable(sample, 2048), undefined);
// Exactly twice the FFT size is the boundary, and it has to be inclusive:
// otherwise the recipe printed in the panel would name a size the check
// then rejects.
equal('exactly twice is enough',
      unusable({ ...sample, capacity: 4096 }, 2048), undefined);
equal('one less is not',
      unusable({ ...sample, capacity: 4095 }, 2048), 'holds 4095, wants 4096');
// A ring the scope would accept can still be too small here. That
// difference is the whole reason this function exists separately.
equal('scope-sized is rejected',
      unusable({ ...sample, capacity: 2048 }, 2048), 'holds 2048, wants 4096');
equal('a level meter ring is rejected as decimated',
      unusable({ capacity: 256, decimation: 441, elementType: 'double-float' }, 2048),
      'decimated \u00d7441');
equal('a boxed ring is rejected',
      unusable({ ...sample, elementType: 't' }, 2048), 'not a sample ring');

// ---------------------------------------------------------------------
// 2. Frames per request must cover what accrues
// ---------------------------------------------------------------------
// The invariant: at least as many frames as accrue in one interval, or the
// view falls behind without end.
// The invariant holds for the interval ACTUALLY used, which pollIntervalFor
// may have shortened. That distinction is the point: at a hop of 64 the
// analysis produces 750 frames a second, so a configured 100 ms cannot be
// honoured — 75 frames would accrue and Lisp delivers at most 64.
for (const configured of [20, 50, 60, 100, 250, 1000]) {
  for (const hop of [16, 64, 128, 256, 512, 1024, 4096]) {
    const interval = pollIntervalFor(configured, hop, 48000);
    if (interval > configured && configured >= 20) {
      fail(`hop ${hop}: interval ${interval} exceeds the configured ${configured}`);
    }
    if (interval < 20) fail(`hop ${hop}: interval ${interval} is below the floor of 20 ms`);
    const accruing = (interval / 1000) * (48000 / hop);
    const asked = framesPerRequest(interval, hop, 48000);
    if (asked < accruing) {
      fail(`${configured} ms configured / hop ${hop}: interval ${interval}, `
         + `asks for ${asked}, ${accruing.toFixed(1)} accrue — the view falls `
         + 'further behind with every request');
    }
    if (asked > MAX_FRAMES_PER_REQUEST) {
      fail(`hop ${hop}: ${asked} exceeds the Lisp cap of ${MAX_FRAMES_PER_REQUEST}`);
    }
    if (!Number.isInteger(asked) || asked < 1) {
      fail(`hop ${hop}: ${asked} is not a usable count`);
    }
  }
}
// A large hop leaves the configured interval alone — the shortening is a
// remedy, not a policy.
equal('a large hop keeps the configured interval',
      pollIntervalFor(60, 4096, 48000), 60);
// Nonsense must not yield 0 or NaN either.
for (const [c, h, r] of [[60, 0, 48000], [60, 512, 0], [0, 512, 48000]]) {
  truthy(`pollIntervalFor(${c},${h},${r}) stays usable`,
         Number.isFinite(pollIntervalFor(c, h, r)) && pollIntervalFor(c, h, r) >= 20);
}
// Nonsensical input must not produce 0 or NaN: a request for zero frames
// would leave the view frozen with no error anywhere.
for (const [i, h, r] of [[50, 0, 48000], [50, 512, 0], [0, 512, 48000]]) {
  const asked = framesPerRequest(i, h, r);
  truthy(`framesPerRequest(${i},${h},${r}) stays usable`,
         Number.isInteger(asked) && asked >= 1);
}

// ---------------------------------------------------------------------
// 3. The colour ramp
// ---------------------------------------------------------------------
// Silence has to be transparent, not the darkest colour of the ramp:
// the canvas is scrolled with drawImage, so an opaque floor would repaint
// the whole history on every column.
equal('the floor is transparent', levelColour(-96, -96), 'rgba(0,0,0,0)');
equal('below the floor too', levelColour(-200, -96), 'rgba(0,0,0,0)');
truthy('full scale is opaque', /^rgb\(/.test(levelColour(0, -96)));
// Monotone in brightness, so that louder never looks quieter.
{
  const luma = db => {
    const m = levelColour(db, -96).match(/rgb\((\d+),(\d+),(\d+)\)/);
    return m ? Number(m[1]) * 0.3 + Number(m[2]) * 0.59 + Number(m[3]) * 0.11 : 0;
  };
  let previous = -1;
  for (let db = -95; db <= 0; db += 5) {
    const now = luma(db);
    if (now < previous - 1e-9) {
      fail(`the ramp darkens at ${db} dB: ${now.toFixed(1)} after ${previous.toFixed(1)}`);
    }
    previous = now;
  }
}

// ---------------------------------------------------------------------
// 4. The webview draws low frequencies at the bottom
// ---------------------------------------------------------------------
// Row 0 is the lowest frequency and belongs at the BOTTOM of the canvas.
// Upside down, a spectrogram still looks like a spectrogram — which is why
// this is worth pinning down rather than eyeballing.
const html = SpectrogramView.html(
  { key: 'x', fftSize: 2048, window: 'hann', mode: 'log', floorDb: -96,
    columns: 256, hop: 512 });
if (!/h - 1 - Math\.floor/.test(html)) {
  fail('The row-to-y mapping is no longer the inverted one — is the picture '
     + 'upside down?');
}
// The history exists only on the canvas, so a resize must preserve it.
if (!/getImageData/.test(html) || !/putImageData/.test(html)) {
  fail('A resize discards the drawn history — it cannot be recomputed');
}
// Dropped frames have to be stated in the panel.
if (!/dropped/.test(html)) {
  fail('The webview does not report dropped frames — an invisible gap in time');
}

if (failed > 0) {
  console.log(`\n${failed} failure(s).`);
  process.exit(1);
}
console.log(
  'ok — spectrogram: ring requirement stricter than the scope, request size '
  + 'covers what accrues, colour ramp monotone, low frequencies at the bottom'
);
