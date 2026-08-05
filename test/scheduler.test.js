// test/scheduler.test.js
//
// The scheduler view's arithmetic.
//
// One distinction runs through all of it: NEXT-TIME and LAST-TIME return 0
// when nothing is pending. At the start of a session that is
// indistinguishable from a genuine time near zero — and "0.0 ms until the
// next event" reads as "right now", which is the opposite of "nothing is
// scheduled". The count is what tells them apart.
//
// Run: npx tsc -p ./ && node test/scheduler.test.js

require('./vscode-stub');

const { samplesToSeconds, distanceLabel, hasPendingTime, heapFraction,
        gaugeColour, SchedulerView } = require('../out/schedulerView.js');

let failed = 0;
const fail = msg => { failed++; console.error(`FAILED ${msg}`); };
const equal = (name, actual, expected) => {
  if (actual !== expected) {
    fail(`${name}: ${JSON.stringify(actual)} instead of ${JSON.stringify(expected)}`);
  }
};

// ---------------------------------------------------------------------
// 1. Samples to seconds
// ---------------------------------------------------------------------
equal('one second at 44100', samplesToSeconds(44100, 44100), 1);
equal('half a second', samplesToSeconds(22050, 44100), 0.5);
equal('one second at 48000', samplesToSeconds(48000, 48000), 1);
// Without a rate the answer is null, not 0. A duration of zero and an
// unknown duration look alike on screen, and only one of them means
// "about to happen".
equal('no rate yields null', samplesToSeconds(44100, 0), null);
equal('a negative rate too', samplesToSeconds(44100, -1), null);
equal('a non-finite distance', samplesToSeconds(NaN, 44100), null);

// ---------------------------------------------------------------------
// 2. Distances read as durations
// ---------------------------------------------------------------------
equal('milliseconds', distanceLabel(0.05), '50.0 ms');
equal('seconds', distanceLabel(2.5), '2.50 s');
equal('minutes', distanceLabel(90), '1:30.0');
equal('null is a dash', distanceLabel(null), '—');
equal('negative is a dash', distanceLabel(-1), '—');
equal('NaN is a dash', distanceLabel(NaN), '—');

// ---------------------------------------------------------------------
// 3. Zero means "nothing pending", not "now"
// ---------------------------------------------------------------------
// The distinction this view turns on. With an empty queue NEXT-TIME
// returns 0, and showing that as a time would say an event is imminent
// when none exists.
equal('empty queue, zero time', hasPendingTime(0, 0), false);
equal('empty queue, nonzero time', hasPendingTime(0, 12345), false);
equal('events pending, zero time', hasPendingTime(3, 0), false);
equal('events pending, real time', hasPendingTime(3, 12345), true);

// ---------------------------------------------------------------------
// 4. The heap gauge
// ---------------------------------------------------------------------
equal('empty', heapFraction(0, 1024), 0);
equal('half', heapFraction(512, 1024), 0.5);
equal('full', heapFraction(1024, 1024), 1);
// Over capacity is clamped rather than overflowing the bar.
equal('over capacity', heapFraction(2000, 1024), 1);
equal('no capacity', heapFraction(10, 0), 0);

// The colour changes before the heap is full, not when it is: a piece that
// needs more slots than remain fails silently, so the warning has to come
// while there is still room to react.
if (gaugeColour(0.85) === gaugeColour(0.3)) {
  fail('a nearly full heap looks like an empty one');
}
if (gaugeColour(0.85) !== 'var(--vscode-charts-red)') {
  fail(`85 per cent full is drawn as ${gaugeColour(0.85)}`);
}

// ---------------------------------------------------------------------
// 5. The view says what it does not show, and why
// ---------------------------------------------------------------------
// Individual pending events are absent by decision, not by omission. A
// user who expects a timeline and finds none should learn the reason from
// the window rather than assume the feature is unfinished.
{
  const html = SchedulerView.html();
  if (!/not listed|no synchronised way|enumerate/.test(html)) {
    fail('the window does not say why individual events are not listed');
  }
  // The queue-depth curve is scaled to the CAPACITY, not to its own peak: a
  // curve rescaled to what it has seen always looks alarming, and the
  // question it answers is how close the heap is to overflowing.
  if (!/point\.count \/ capacity/.test(html)) {
    fail('the history is not scaled to the heap capacity');
  }
  // Zero must not be shown as a time.
  if (!/s\.count > 0 && s\.nextTime > 0/.test(html)) {
    fail('an empty queue would show a next-event time');
  }
}

if (failed > 0) {
  console.log(`\n${failed} failure(s).`);
  process.exit(1);
}
console.log(
  'ok — scheduler view: samples converted with the reported rate, an empty '
  + 'queue distinguished from an imminent event, heap gauge warns before full'
);
