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
// 3. No countdown is shown, and the reason is stated
// ---------------------------------------------------------------------
// NEXT-TIME and LAST-TIME are not reported. Measured against a running
// session: scheduling events changes HEAP-COUNT as expected — 2, then 4 —
// while NEXT-TIME stays at the same value, across new events and across
// FLUSH-PENDING. Its magnitude does not relate to NOW by the sample rate
// either; an event five seconds away read as some 46 billion against a NOW
// of 6 million, which the display duly rendered as a countdown of
// "17579:24.3".
//
// hasPendingTime remains exported because the distinction it makes is still
// the right one for any future countdown: a zero returned for an absent
// event must not be shown as a time.
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
  if (!/not shown|not listed/.test(html)) {
    fail('the window does not mention that individual events are absent');
  }
  // The queue-depth curve is scaled to the CAPACITY, not to its own peak: a
  // curve rescaled to what it has seen always looks alarming, and the
  // question it answers is how close the heap is to overflowing.
  if (!/point\.count \/ capacity/.test(html)) {
    fail('the history is not scaled to the heap capacity');
  }
  // No countdown is rendered at all, since the figure behind it cannot be
  // trusted. A field showing a number the extension cannot vouch for would
  // carry the same authority on screen as the ones it can.
  if (/nextTime|lastTime/.test(html)) {
    fail('the view still renders a countdown from next-time or last-time');
  }
  // And the window says that they are absent, so the gap is not read as an
  // unfinished feature. The REASON lives in the source and the changelog,
  // not in a paragraph the user re-reads on every glance: four lines about
  // what is missing beside two figures that are present is the wrong
  // proportion.
  if (!/not shown/.test(html)) {
    fail('the window does not mention that no countdown is shown');
  }
  if (html.length > 12000) {
    fail(`the window markup is ${html.length} characters — the explanation `
       + 'has outgrown what it explains');
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
