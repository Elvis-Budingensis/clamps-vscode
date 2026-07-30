// test/buffer.test.js
//
// The buffer viewer's zoom arithmetic and time labels.
//
// The reduction itself is checked in lisp/test-buffer.lisp, against
// signals in which a wrong reduction is arithmetically detectable. What is
// left for here is the navigation, and it deserves a test for an unusual
// reason: zoom bugs are invisible in any single picture. A range that
// creeps sideways with every step, or one that cannot be left again, looks
// like a perfectly good waveform at every individual moment. Only the
// sequence is wrong.
//
// Run: npx tsc -p ./ && node test/buffer.test.js

require('./vscode-stub');

const { zoomRange, timeLabel } = require('../out/bufferView.js');

let failed = 0;
const fail = msg => { failed++; console.error(`FAILED ${msg}`); };
const equal = (name, actual, expected) => {
  if (actual !== expected) {
    fail(`${name}: ${JSON.stringify(actual)} instead of ${JSON.stringify(expected)}`);
  }
};

// ---------------------------------------------------------------------
// 1. Zoom stays inside the buffer
// ---------------------------------------------------------------------
const FRAMES = 100000;
{
  // Zooming out from the whole buffer must not reach past either end.
  const r = zoomRange(0, FRAMES, FRAMES, 0.5, 0.5);
  equal('zooming out from the whole buffer stays at the start', r.start, 0);
  equal('and at the end', r.end, FRAMES);

  // At the left edge, zooming out must not produce a negative start —
  // the request would then be clamped in Lisp and the view would jump.
  const left = zoomRange(0, 1000, FRAMES, 0.5, 0);
  if (left.start < 0) fail(`zooming out at the left edge yields ${left.start}`);
  const right = zoomRange(FRAMES - 1000, FRAMES, FRAMES, 0.5, 1);
  if (right.end > FRAMES) fail(`zooming out at the right edge yields ${right.end}`);
}

// ---------------------------------------------------------------------
// 2. Zooming in and out returns exactly to where it started
// ---------------------------------------------------------------------
// The invariant that catches a creeping range — and the reason the zoom
// levels are discrete. With a freely scaled span every step rounds to
// whole frames and the error accumulates; measured, ten steps in and ten
// out came back 479 frames away, with a span of 40960 where 40000 went in.
// A range that creeps is a perfectly good waveform at every single moment,
// so only the sequence is wrong and no picture shows it.
//
// The invariant holds from the grid onwards: the first zoom snaps an
// arbitrary span to the nearest level, and in practice the view starts at
// the whole buffer, which is level 0.
// The span returns exactly, because the levels are discrete. The start
// returns to within a few frames: at deep levels the span is odd, so
// halving it around a centre cannot land on a whole frame. What matters is
// that this error is BOUNDED and does not grow with the number of cycles —
// that is precisely the difference between rounding and creep, and the
// reason to run the loop twice with different counts rather than once.
{
  const cycle = (cycles) => {
    let range = zoomRange(20000, 60000, FRAMES, 1, 0.5);   // snap onto the grid
    const before = { ...range };
    for (let c = 0; c < cycles; c++) {
      for (let i = 0; i < 10; i++) {
        range = zoomRange(range.start, range.end, FRAMES, 2, 0.5);
      }
      for (let i = 0; i < 10; i++) {
        range = zoomRange(range.start, range.end, FRAMES, 0.5, 0.5);
      }
    }
    return { drift: Math.abs(range.start - before.start),
             span: range.end - range.start,
             wanted: before.end - before.start };
  };
  const one = cycle(1);
  const many = cycle(8);
  equal('the span returns exactly after one cycle', one.span, one.wanted);
  equal('and after eight', many.span, many.wanted);
  if (one.drift > 16) {
    fail(`one cycle drifts by ${one.drift} frames — more than rounding explains`);
  }
  if (many.drift > one.drift + 1) {
    fail(`eight cycles drift by ${many.drift} against ${one.drift} for one — `
       + 'the error accumulates, the range creeps');
  }
}

// Snapping is idempotent: a range already on the grid does not move when
// zoomed by a factor of one. Otherwise every redraw would shift it.
{
  let range = { start: 0, end: FRAMES };
  for (let i = 0; i < 6; i++) {
    range = zoomRange(range.start, range.end, FRAMES, 2, 0.5);
    const again = zoomRange(range.start, range.end, FRAMES, 1, 0.5);
    equal(`level ${i + 1} is stable in start`, again.start, range.start);
    equal(`level ${i + 1} is stable in span`,
          again.end - again.start, range.end - range.start);
  }
}

// ---------------------------------------------------------------------
// 3. The anchor decides what stays put
// ---------------------------------------------------------------------
// Zooming towards the pointer is the whole reason for the anchor: when
// looking for a click one has it under the cursor.
{
  const inLeft = zoomRange(0, 10000, FRAMES, 2, 0);
  equal('anchored left, the start stays', inLeft.start, 0);
  const inRight = zoomRange(0, 10000, FRAMES, 2, 1);
  equal('anchored right, the end stays', inRight.end, 10000);
  const inMiddle = zoomRange(0, 10000, FRAMES, 2, 0.5);
  equal('anchored in the middle, the centre stays',
        (inMiddle.start + inMiddle.end) / 2, 5000);
}

// ---------------------------------------------------------------------
// 4. A floor on the range
// ---------------------------------------------------------------------
// Below a handful of frames there is nothing left to reduce, and a range
// of zero would mean a request for columns that cannot be filled.
{
  let range = { start: 500, end: 600 };
  for (let i = 0; i < 20; i++) {
    range = zoomRange(range.start, range.end, FRAMES, 4, 0.5);
    const span = range.end - range.start;
    if (span < 1) fail(`the range collapsed to ${span} frames`);
    if (range.start < 0 || range.end > FRAMES) {
      fail(`the range left the buffer: ${range.start}..${range.end}`);
    }
  }
  if (range.end - range.start < 16) {
    fail(`the floor of 16 frames was undercut: ${range.end - range.start}`);
  }
}

// A buffer shorter than the floor must not produce an inverted range.
{
  const tiny = zoomRange(0, 8, 8, 4, 0.5);
  if (tiny.end <= tiny.start) fail(`a tiny buffer yields ${tiny.start}..${tiny.end}`);
}

// ---------------------------------------------------------------------
// 5. Time labels
// ---------------------------------------------------------------------
equal('milliseconds below a second', timeLabel(4410, 44100), '100.0 ms');
equal('seconds below a minute', timeLabel(44100, 44100), '1.000 s');
equal('minutes above', timeLabel(44100 * 90, 44100), '1:30.00');
// Without a rate the axis is in frames, and it says so by not pretending
// to be time.
equal('no rate means frames', timeLabel(4410, 0), '4410');
equal('a negative rate too', timeLabel(4410, -1), '4410');

if (failed > 0) {
  console.log(`\n${failed} failure(s).`);
  process.exit(1);
}
console.log(
  'ok — buffer viewer: zoom stays inside the buffer, does not creep, '
  + 'honours the anchor, and time labels degrade to frames without a rate'
);
