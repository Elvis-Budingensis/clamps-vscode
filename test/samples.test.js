// test/samples.test.js
//
// The sample browser's formatting and sorting.
//
// The header reader is checked in lisp/test-samples.lisp against files the
// gate writes itself. What is left here is the table, and it deserves a
// test for one reason above all: a numeric column sorted as text puts 100
// before 20. It LOOKS sorted. In a list of sample rates or durations that
// is exactly the kind of wrongness one does not catch by glancing, because
// the column is neatly ordered — just not by size.
//
// Run: npx tsc -p ./ && node test/samples.test.js

require('./vscode-stub');

const { durationLabel, sizeLabel, rateLabel, sortEntries, SampleBrowserView } =
  require('../out/sampleBrowser.js');

let failed = 0;
const fail = msg => { failed++; console.error(`FAILED ${msg}`); };
const equal = (name, actual, expected) => {
  if (actual !== expected) {
    fail(`${name}: ${JSON.stringify(actual)} instead of ${JSON.stringify(expected)}`);
  }
};

// ---------------------------------------------------------------------
// 1. Durations
// ---------------------------------------------------------------------
equal('a second', durationLabel(1), '1.000 s');
equal('under a minute', durationLabel(45.5), '45.500 s');
equal('over a minute', durationLabel(90), '1:30.00');
equal('several minutes', durationLabel(3725), '62:05.00');
// An unknown duration is a dash, not "0.000 s": the file may be hours
// long and merely have an unreadable header, and a zero would assert
// something the header did not say.
equal('unknown is a dash', durationLabel(0), '—');
equal('negative is a dash', durationLabel(-1), '—');
equal('NaN is a dash', durationLabel(NaN), '—');

// ---------------------------------------------------------------------
// 2. Sizes
// ---------------------------------------------------------------------
equal('bytes', sizeLabel(512), '512 B');
equal('kilobytes', sizeLabel(2048), '2.0 kB');
equal('megabytes', sizeLabel(5 * 1024 * 1024), '5.0 MB');
equal('large megabytes lose the decimal', sizeLabel(50 * 1024 * 1024), '50 MB');
equal('gigabytes', sizeLabel(3 * 1024 * 1024 * 1024), '3.0 GB');
equal('unknown size', sizeLabel(0), '—');

// ---------------------------------------------------------------------
// 3. Sample rates
// ---------------------------------------------------------------------
equal('44100', rateLabel(44100), '44.1 k');
equal('48000 without a trailing zero', rateLabel(48000), '48 k');
equal('96000', rateLabel(96000), '96 k');
equal('192000', rateLabel(192000), '192 k');
// A rate that is not a whole number of hertz is shown in full. That is a
// fact about the file and almost always a sign that something upstream
// resampled it — rounding it to "44.1 k" would hide precisely the anomaly
// worth seeing.
equal('a fractional rate is shown in full', rateLabel(44099.5), '44099.500 Hz');
equal('unknown rate', rateLabel(0), '—');

// ---------------------------------------------------------------------
// 4. Sorting — numeric columns numerically
// ---------------------------------------------------------------------
// The point of this file. Sorted as text, 100 comes before 20 and the
// column looks perfectly ordered.
{
  const entries = [
    { name: 'c.wav', channels: 2, sampleRate: 44100, duration: 100, size: 3 },
    { name: 'a.wav', channels: 1, sampleRate: 96000, duration: 20, size: 1 },
    { name: 'B.wav', channels: 6, sampleRate: 8000, duration: 3, size: 2 },
  ];
  equal('durations rise numerically',
        sortEntries(entries, 'duration', false).map(e => e.duration).join(),
        '3,20,100');
  equal('and fall the other way',
        sortEntries(entries, 'duration', true).map(e => e.duration).join(),
        '100,20,3');
  equal('rates sort numerically',
        sortEntries(entries, 'sampleRate', false).map(e => e.sampleRate).join(),
        '8000,44100,96000');
  // Names sort case-insensitively: a column where B.wav lands before a.wav
  // is sorted by byte value, which is not what anyone reading a file list
  // means by alphabetical.
  equal('names ignore case',
        sortEntries(entries, 'name', false).map(e => e.name).join(),
        'a.wav,B.wav,c.wav');
  // Sorting must not modify the input: the view keeps one array and sorts
  // it for every render.
  const before = entries.map(e => e.name).join();
  sortEntries(entries, 'duration', true);
  equal('the input is untouched', entries.map(e => e.name).join(), before);
}

// ---------------------------------------------------------------------
// 5. The table shows what it cannot read
// ---------------------------------------------------------------------
// A listing that silently drops unreadable files is worse than one that
// marks them: the user knows the file is in the folder and would go
// looking for a bug in the browser.
{
  const html = SampleBrowserView.html('/tmp/samples');
  if (!/unreadable header/.test(html)) {
    fail('the browser does not report files with unreadable headers');
  }
  if (!/'\u2014'/.test(html) && !/\\u2014/.test(html)) {
    fail('the table has no marker for missing values — a 0 would assert '
       + 'something the header did not say');
  }
  // The columns a sample folder is actually opened with. The header is
  // built from a table of definitions in the webview, so the check is on
  // the label appearing there.
  for (const column of ['Rate', 'Ch', 'Bits', 'Duration', 'Format', 'Size']) {
    if (!html.includes(`label: '${column}'`)) {
      fail(`the column ${column} is missing`);
    }
  }
}

if (failed > 0) {
  console.log(`\n${failed} failure(s).`);
  process.exit(1);
}
console.log(
  'ok — sample browser: durations and sizes readable, fractional rates shown '
  + 'in full, numeric columns sorted numerically'
);
