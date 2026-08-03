// test/osc.test.js
//
// The OSC monitor's display decisions.
//
// The decoding is checked in lisp/test-osc.lisp. What is left here is the
// window, and the point of it is the same as in the Lisp gate: an OSC
// message carries its own types, and they are half the information.
//
// Run: npx tsc -p ./ && node test/osc.test.js

require('./vscode-stub');

const { typeColour, addressMatches, timeLabel, OscMonitorView } =
  require('../out/oscMonitor.js');

let failed = 0;
const fail = msg => { failed++; console.error(`FAILED ${msg}`); };
const equal = (name, actual, expected) => {
  if (actual !== expected) {
    fail(`${name}: ${JSON.stringify(actual)} instead of ${JSON.stringify(expected)}`);
  }
};

// ---------------------------------------------------------------------
// 1. Types are distinguishable by colour
// ---------------------------------------------------------------------
// Telling an int from a float at a glance is the single most useful thing
// the type column does: 1 and 1.0 print alike and are not alike, and a
// receiver expecting one that gets the other fails without saying so.
{
  const colours = new Map();
  for (const type of ['int', 'float', 'double', 'string', 'blob']) {
    const colour = typeColour(type);
    if (colours.has(colour)) {
      fail(`${type} shares a colour with ${colours.get(colour)}`);
    }
    colours.set(colour, type);
  }
  if (typeColour('int') === typeColour('float')) {
    fail('int and float share a colour — the one distinction that matters most');
  }
  // An unknown type still gets a colour rather than undefined, which would
  // reach the CSS as the string "undefined" and render as nothing.
  if (!typeColour('something-new').startsWith('var(')) {
    fail(`an unknown type yields ${typeColour('something-new')}`);
  }
}

// ---------------------------------------------------------------------
// 2. The address filter is a substring, not a prefix
// ---------------------------------------------------------------------
// OSC namespaces are hierarchical and one often remembers the leaf rather
// than the root. Typing "freq" must find /synth/1/freq.
equal('an empty filter matches', addressMatches('/synth/freq', ''), true);
equal('a prefix matches', addressMatches('/synth/freq', '/synth'), true);
equal('a leaf matches', addressMatches('/synth/1/freq', 'freq'), true);
equal('the middle matches', addressMatches('/synth/1/freq', '/1/'), true);
equal('case is ignored', addressMatches('/Synth/Freq', 'synth'), true);
equal('a non-match is a non-match', addressMatches('/synth/freq', 'gate'), false);

// ---------------------------------------------------------------------
// 3. Timestamps
// ---------------------------------------------------------------------
equal('three decimals', timeLabel(1.23456), '1.235');
equal('zero', timeLabel(0), '0.000');
equal('negative is a dash', timeLabel(-1), '—');
equal('NaN is a dash', timeLabel(NaN), '—');

// ---------------------------------------------------------------------
// 4. The window shows types, escapes text and bounds its log
// ---------------------------------------------------------------------
{
  const html = OscMonitorView.html(32126);
  // Every value carries its own colour, i.e. its own type. Without this the
  // column is decorative rather than informative.
  if (!/typeColour\(v\.type\)/.test(html)) {
    fail('values are not coloured by their type');
  }
  // The type tag stands next to the address.
  if (!/typetag/.test(html)) {
    fail('the type tag is not shown');
  }
  // OSC addresses and string values come from the network. They are put
  // into innerHTML, so they must be escaped — an address containing < would
  // otherwise break the row open, and a string value could carry markup.
  if (!/escape\(e\.address\)/.test(html)) {
    fail('the address is not escaped — it comes from the network');
  }
  if (!/escape\(v\.text\)/.test(html)) {
    fail('value text is not escaped — it comes from the network');
  }
  // Dropped messages are named.
  if (!/dropped/.test(html)) {
    fail('the monitor does not report dropped messages');
  }
  // The log is capped and follows only when already at the bottom.
  if (!/childElementCount > \d+/.test(html)) {
    fail('the log is unbounded');
  }
  if (!/atBottom/.test(html)) {
    fail('the log scrolls unconditionally — reading back would be impossible');
  }
  // The port is settable: the monitor opens a stream of its own, so a busy
  // port has to be avoidable without editing settings.
  if (!/id="port"/.test(html)) {
    fail('the port cannot be changed in the window');
  }
}

if (failed > 0) {
  console.log(`\n${failed} failure(s).`);
  process.exit(1);
}
console.log(
  'ok — OSC monitor: types distinguishable by colour, address filter matches '
  + 'substrings, network text escaped, log capped and scroll-aware'
);
