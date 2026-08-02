// test/midi.test.js
//
// The MIDI monitor's display decisions.
//
// The decoding is checked in lisp/test-midi.lisp, exhaustively — every
// status byte, every channel, both fourteen-bit orders. What is left here
// is the window, and two of its decisions are worth pinning down because
// getting them wrong makes the monitor answer the wrong question.
//
// Run: npx tsc -p ./ && node test/midi.test.js

require('./vscode-stub');

const { kindColour, isTransportNoise, timeLabel, MidiMonitorView } =
  require('../out/midiMonitor.js');

let failed = 0;
const fail = msg => { failed++; console.error(`FAILED ${msg}`); };
const equal = (name, actual, expected) => {
  if (actual !== expected) {
    fail(`${name}: ${JSON.stringify(actual)} instead of ${JSON.stringify(expected)}`);
  }
};

// ---------------------------------------------------------------------
// 1. Clock and sensing are the only things treated as noise
// ---------------------------------------------------------------------
// They arrive continuously and say nothing about what a player did: a
// running clock is 24 messages per beat, so 48 a second at 120 bpm. Given
// equal weight they bury everything else. But hiding them outright would
// make "is the clock running" unanswerable, so they are hidden by default
// and shown on request.
equal('clock is noise', isTransportNoise('clock'), true);
equal('active sensing is noise', isTransportNoise('active-sensing'), true);
// Nothing a player does may be classed as noise. A note-on filtered out by
// default would make the monitor answer "nothing arrived" while somebody
// is playing — the worst failure this window has.
for (const kind of ['note-on', 'note-off', 'control-change', 'pitch-bend',
                    'program-change', 'poly-pressure', 'channel-pressure',
                    'sysex', 'start', 'stop', 'continue', 'song-position']) {
  equal(`${kind} is not noise`, isTransportNoise(kind), false);
}

// ---------------------------------------------------------------------
// 2. Colours separate what one looks for
// ---------------------------------------------------------------------
{
  const colours = new Map();
  for (const kind of ['note-on', 'note-off', 'control-change', 'pitch-bend',
                      'program-change']) {
    const colour = kindColour(kind);
    if (colours.has(colour)) {
      fail(`${kind} has the same colour as ${colours.get(colour)} — the two `
         + 'cannot be told apart at a glance');
    }
    colours.set(colour, kind);
  }
  // Notes on and off must differ: watching a phrase, the question is which
  // is which.
  if (kindColour('note-on') === kindColour('note-off')) {
    fail('note on and note off share a colour');
  }
  // Clock and sensing are deliberately dim, so that a running clock does
  // not bury the rest.
  equal('clock is dim', kindColour('clock'),
        'var(--vscode-descriptionForeground)');
  // An unknown kind still gets a colour rather than undefined, which would
  // reach the CSS as the string "undefined" and render as nothing.
  if (!kindColour('something-new').startsWith('var(')) {
    fail(`an unknown kind yields ${kindColour('something-new')}`);
  }
}

// ---------------------------------------------------------------------
// 3. Timestamps
// ---------------------------------------------------------------------
equal('three decimals', timeLabel(1.23456), '1.235');
equal('zero', timeLabel(0), '0.000');
equal('negative is a dash', timeLabel(-1), '—');
equal('NaN is a dash', timeLabel(NaN), '—');

// ---------------------------------------------------------------------
// 4. The window says what it dropped, and caps its log
// ---------------------------------------------------------------------
{
  const html = MidiMonitorView.html();
  // Dropped messages are named. A monitor that loses events silently
  // answers "nothing arrived" when the truth is that many arrived and were
  // thrown away — and sends the user to check cables that are fine.
  if (!/dropped/.test(html)) {
    fail('the monitor does not report dropped messages');
  }
  // The log is capped: a dense stream fills a browser's memory in minutes.
  if (!/childElementCount > \d+/.test(html)) {
    fail('the log is unbounded — a dense stream will fill memory');
  }
  // Following only when already at the bottom. Otherwise scrolling back to
  // read something is undone by the next message, which at MIDI rates
  // means it cannot be read at all.
  if (!/atBottom/.test(html)) {
    fail('the log scrolls unconditionally — reading back would be impossible');
  }
  // Sixteen channel indicators, because "which channel is this on" is the
  // second question after "is anything arriving".
  if (!/c <= 16/.test(html)) {
    fail('there is no per-channel activity display');
  }
}

if (failed > 0) {
  console.log(`\n${failed} failure(s).`);
  process.exit(1);
}
console.log(
  'ok — MIDI monitor: only clock and sensing filtered, kinds distinguishable '
  + 'by colour, dropped messages reported, log capped and scroll-aware'
);
