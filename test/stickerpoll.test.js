// test/stickerpoll.test.js
//
// The fetch cycle for sticker rings.
//
// The audio thread may neither send nor block, so the client fetches. Two
// properties decide whether that still holds up at 30 queries per second:
// only the increment is transferred, and only ever one query is in flight.
// Both are invisible from outside when they break — the display then
// simply runs further and further behind.
//
// Run: npx tsc -p ./ && node test/stickerpoll.test.js

require('./vscode-stub');

const {
  StickerPoller, toDecibels, decibelFraction,
} = require('../out/stickerPoll.js');

let failed = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAILED ${name}: ${a} instead of ${e}`);
    failed++;
  }
};
const ok = (name, condition) => {
  if (!condition) { console.error(`FAILED ${name}`); failed++; }
};

// A ring that keeps counting on with every query.
function fakeRing(chunks) {
  const calls = [];
  let index = 0;
  const request = async (key, since, limit) => {
    calls.push({ key, since, limit });
    const chunk = chunks[index++];
    return chunk;
  };
  return { request, calls };
}

(async () => {
  // --- The increment only ----------------------------------------------
  {
    const { request, calls } = fakeRing([
      { sequence: 3, dropped: 0, values: [1, 2, 3] },
      { sequence: 5, dropped: 0, values: [4, 5] },
    ]);
    const poller = new StickerPoller(request, 4096);
    const seen = [];
    poller.subscribe('meter', (key, batch) => seen.push(batch.values));

    await poller.poll();
    await poller.poll();

    check('erste Abfrage ab 0', calls[0].since, 0);
    check('the second query starts at the reported position', calls[1].since, 3);
    check('only the increment arrives', seen, [[1, 2, 3], [4, 5]]);
    check('the sequence position follows', poller.sequenceOf('meter'), 5);
  }

  // --- Nothing new triggers no notification -----------------------------
  {
    const { request } = fakeRing([{ sequence: 7, dropped: 0, values: [] }]);
    const poller = new StickerPoller(request);
    let calledBack = 0;
    poller.subscribe('meter', () => calledBack++);
    await poller.poll();
    check('an empty increment does not notify', calledBack, 0);
    check('the sequence is adopted all the same', poller.sequenceOf('meter'), 7);
  }

  // --- Lost values are reported, even without new values ----------------
  //
  // An overflowing ring must not look like an unbroken course. So dropped
  // alone is already a reason to report — but only from the SECOND query
  // on, see below.
  {
    const { request } = fakeRing([
      { sequence: 10, dropped: 0, values: [1] },
      { sequence: 99, dropped: 42, values: [] },
    ]);
    const poller = new StickerPoller(request);
    const seen = [];
    poller.subscribe('meter', (key, batch) => seen.push(batch.dropped));
    await poller.poll();
    await poller.poll();
    check('overflow is reported', seen, [0, 42]);
  }

  // --- What lies before anyone looked is not a gap ----------------------
  //
  // At the first fetch the ring is usually long since full: the DSP has
  // been running for minutes, the display is only just being opened. The
  // difference between sequence and ring contents is then enormous, but
  // it is not a gap. Reported as dropped, "3341 lost" would stand next to
  // a perfectly healthy bar right after opening — and the message would
  // be worthless, because it is always there.
  {
    const { request } = fakeRing([
      { sequence: 3400, dropped: 3144, values: [1, 2, 3] },
      { sequence: 3410, dropped: 0, values: [4] },
    ]);
    const poller = new StickerPoller(request);
    const seen = [];
    poller.subscribe('meter', (key, batch) => seen.push(batch.dropped));
    await poller.poll();
    check('the first query reports no loss', seen, [0]);
    await poller.poll();
    check('danach normal weiter', seen, [0, 0]);
  }

  // Only the first query is exempt: a real overflow directly afterwards
  // has to become visible.
  {
    const { request } = fakeRing([
      { sequence: 100, dropped: 90, values: [1] },
      { sequence: 400, dropped: 44, values: [2] },
    ]);
    const poller = new StickerPoller(request);
    const seen = [];
    poller.subscribe('meter', (key, batch) => seen.push(batch.dropped));
    await poller.poll();
    await poller.poll();
    check('zweite Abfrage meldet echten Verlust', seen, [0, 44]);
  }

  // After unsubscribing and subscribing again it counts as a "first time"
  // once more.
  {
    const { request } = fakeRing([
      { sequence: 100, dropped: 90, values: [1] },
      { sequence: 400, dropped: 44, values: [2] },
    ]);
    const poller = new StickerPoller(request);
    const seen = [];
    const sub = poller.subscribe('meter', (key, batch) => seen.push(batch.dropped));
    await poller.poll();
    sub.dispose();
    poller.subscribe('meter', (key, batch) => seen.push(batch.dropped));
    await poller.poll();
    check('no loss report again after resubscribing', seen, [0, 0]);
  }

  // --- Only ever one query is in flight ---------------------------------
  //
  // If the bridge is slower than the cycle, requests would pile up.
  {
    let running = 0;
    let maxParallel = 0;
    let resolveFirst;
    const request = (key, since) => {
      running++;
      maxParallel = Math.max(maxParallel, running);
      return new Promise(resolve => {
        resolveFirst = () => {
          running--;
          resolve({ sequence: since + 1, dropped: 0, values: [1] });
        };
      });
    };
    const poller = new StickerPoller(request);
    poller.subscribe('meter', () => {});

    const first = poller.poll();
    await poller.poll();   // while the first one is still running
    await poller.poll();
    resolveFirst();
    await first;

    check('no overlapping queries', maxParallel, 1);
  }

  // --- An error does not end the cycle ----------------------------------
  {
    let attempts = 0;
    const request = async (key, since) => {
      attempts++;
      if (attempts === 1) throw new Error('Bridge weg');
      return { sequence: 2, dropped: 0, values: [9] };
    };
    const poller = new StickerPoller(request);
    const seen = [];
    poller.subscribe('meter', (key, batch) => seen.push(batch.values));

    await poller.poll();
    check('an error does not change the position', poller.sequenceOf('meter'), 0);
    await poller.poll();
    check('danach laeuft es weiter', seen, [[9]]);
  }

  // --- A newly created ring: the sequence falls back --------------------
  //
  // After sticker-clear-for-repl the sequence starts at 0 again. If the
  // old, higher position stayed, nothing would ever arrive again.
  {
    const { request } = fakeRing([
      { sequence: 500, dropped: 0, values: [1] },
      { sequence: 2, dropped: 0, values: [7, 8] },
    ]);
    const poller = new StickerPoller(request);
    const seen = [];
    poller.subscribe('meter', (key, batch) => seen.push(batch.values));
    await poller.poll();
    await poller.poll();
    check('the position follows the ring downwards', poller.sequenceOf('meter'), 2);
    check('Werte kommen weiter an', seen, [[1], [7, 8]]);
  }

  // --- Without a listener nothing is asked ------------------------------
  {
    const { request, calls } = fakeRing([]);
    const poller = new StickerPoller(request);
    await poller.poll();
    check('no query without subscribers', calls.length, 0);

    const sub = poller.subscribe('meter', () => {});
    check('the key is active', poller.activeKeys(), ['meter']);
    sub.dispose();
    check('none left after dispose', poller.activeKeys(), []);
  }

  // --- Unsubscribing resets the position --------------------------------
  //
  // Whoever watches again later wants to see the current ring, not carry
  // on from a position that has long since dropped out.
  {
    const { request } = fakeRing([{ sequence: 40, dropped: 0, values: [1] }]);
    const poller = new StickerPoller(request);
    const sub = poller.subscribe('meter', () => {});
    await poller.poll();
    check('the position holds', poller.sequenceOf('meter'), 40);
    sub.dispose();
    check('unsubscribing forgets the position', poller.sequenceOf('meter'), 0);
  }

  // --- dB-Umrechnung ---------------------------------------------------
  check('Vollaussteuerung', toDecibels(1), 0);
  check('halbe Amplitude', Math.round(toDecibels(0.5) * 100) / 100, -6.02);
  check('Vorzeichen egal', toDecibels(-1), 0);
  // Silence: without a lower bound that would be minus infinity and the
  // bar width NaN — the display would vanish silently instead of showing
  // silence.
  check('silence falls to the floor', toDecibels(0), -60);
  check('NaN falls to the floor', toDecibels(NaN), -60);
  check('above full scale is capped', toDecibels(4), 0);

  check('the floor is empty', decibelFraction(-60), 0);
  check('full scale is full', decibelFraction(0), 1);
  check('Mitte', decibelFraction(-30), 0.5);
  check('below the floor stays empty', decibelFraction(-120), 0);

  if (failed > 0) {
    console.error(`\n${failed} failure(s).`);
    process.exit(1);
  }
  console.log('ok — sticker cycle: increment only, no overlap, overflow visible');
})();
