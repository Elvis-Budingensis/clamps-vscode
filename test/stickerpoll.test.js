// test/stickerpoll.test.js
//
// Abholtakt fuer Sticker-Ringe.
//
// Der Audio-Thread darf weder senden noch blockieren, also holt der Client
// ab. Zwei Eigenschaften entscheiden, ob das bei 30 Abfragen pro Sekunde
// noch traegt: es wird nur der Zuwachs uebertragen, und es laeuft immer
// nur eine Abfrage. Beides ist von aussen unsichtbar, wenn es kaputtgeht —
// die Anzeige laeuft dann einfach immer weiter hinterher.
//
// Aufruf: npx tsc -p ./ && node test/stickerpoll.test.js

require('./vscode-stub');

const {
  StickerPoller, toDecibels, decibelFraction,
} = require('../out/stickerPoll.js');

let failed = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FEHLER ${name}: ${a} statt ${e}`);
    failed++;
  }
};
const ok = (name, condition) => {
  if (!condition) { console.error(`FEHLER ${name}`); failed++; }
};

// Ein Ring, der bei jeder Abfrage weiterzaehlt.
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
  // --- Nur der Zuwachs -------------------------------------------------
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
    check('zweite Abfrage ab dem gemeldeten Stand', calls[1].since, 3);
    check('nur der Zuwachs kommt an', seen, [[1, 2, 3], [4, 5]]);
    check('Sequenzstand steht nach', poller.sequenceOf('meter'), 5);
  }

  // --- Nichts Neues loest keine Meldung aus ----------------------------
  {
    const { request } = fakeRing([{ sequence: 7, dropped: 0, values: [] }]);
    const poller = new StickerPoller(request);
    let calledBack = 0;
    poller.subscribe('meter', () => calledBack++);
    await poller.poll();
    check('leerer Zuwachs meldet nicht', calledBack, 0);
    check('Sequenz wird trotzdem uebernommen', poller.sequenceOf('meter'), 7);
  }

  // --- Verlorene Werte werden gemeldet, auch ohne neue Werte -----------
  //
  // Ein uebergelaufener Ring darf nicht wie ein lueckenloser Verlauf
  // aussehen. Deshalb ist dropped allein schon ein Grund, zu melden —
  // aber erst ab der ZWEITEN Abfrage, siehe unten.
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
    check('Ueberlauf wird gemeldet', seen, [0, 42]);
  }

  // --- Was vor dem Hinsehen liegt, ist keine Luecke --------------------
  //
  // Beim ersten Abholen steht der Ring meist laengst voll da: der DSP
  // laeuft seit Minuten, die Anzeige wird gerade erst geoeffnet. Die
  // Differenz zwischen Sequenz und Ringinhalt ist dann riesig, aber sie
  // ist keine Luecke. Als dropped gemeldet stuende nach dem Oeffnen
  // sofort "3341 verloren" neben einem voellig gesunden Balken — und die
  // Meldung waere wertlos, weil sie immer da ist.
  {
    const { request } = fakeRing([
      { sequence: 3400, dropped: 3144, values: [1, 2, 3] },
      { sequence: 3410, dropped: 0, values: [4] },
    ]);
    const poller = new StickerPoller(request);
    const seen = [];
    poller.subscribe('meter', (key, batch) => seen.push(batch.dropped));
    await poller.poll();
    check('erste Abfrage meldet keinen Verlust', seen, [0]);
    await poller.poll();
    check('danach normal weiter', seen, [0, 0]);
  }

  // Nur die erste Abfrage ist ausgenommen: ein echter Ueberlauf direkt
  // danach muss sichtbar werden.
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

  // Nach Abmelden und neuem Abonnieren zaehlt wieder als "erstes Mal".
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
    check('nach Neuabonnieren wieder ohne Verlustmeldung', seen, [0, 0]);
  }

  // --- Es laeuft immer nur eine Abfrage --------------------------------
  //
  // Ist die Bridge langsamer als der Takt, wuerden sich Anfragen stapeln.
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
    await poller.poll();   // waehrend der ersten noch laeuft
    await poller.poll();
    resolveFirst();
    await first;

    check('keine ueberlappenden Abfragen', maxParallel, 1);
  }

  // --- Ein Fehler beendet den Takt nicht -------------------------------
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
    check('Fehler aendert den Stand nicht', poller.sequenceOf('meter'), 0);
    await poller.poll();
    check('danach laeuft es weiter', seen, [[9]]);
  }

  // --- Neu angelegter Ring: Sequenz faellt zurueck ---------------------
  //
  // Nach sticker-clear-for-repl beginnt die Sequenz wieder bei 0. Bliebe
  // der alte, hoehere Stand stehen, kaeme nie wieder etwas an.
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
    check('Stand folgt dem Ring nach unten', poller.sequenceOf('meter'), 2);
    check('Werte kommen weiter an', seen, [[1], [7, 8]]);
  }

  // --- Ohne Zuhoerer wird nicht gefragt --------------------------------
  {
    const { request, calls } = fakeRing([]);
    const poller = new StickerPoller(request);
    await poller.poll();
    check('keine Abfrage ohne Abonnenten', calls.length, 0);

    const sub = poller.subscribe('meter', () => {});
    check('Schluessel ist aktiv', poller.activeKeys(), ['meter']);
    sub.dispose();
    check('nach dispose keiner mehr', poller.activeKeys(), []);
  }

  // --- Abmelden setzt den Stand zurueck --------------------------------
  //
  // Wer spaeter neu zusieht, will den aktuellen Ring sehen und nicht ab
  // einem Stand weitermachen, der laengst herausgefallen ist.
  {
    const { request } = fakeRing([{ sequence: 40, dropped: 0, values: [1] }]);
    const poller = new StickerPoller(request);
    const sub = poller.subscribe('meter', () => {});
    await poller.poll();
    check('Stand steht', poller.sequenceOf('meter'), 40);
    sub.dispose();
    check('Abmelden vergisst den Stand', poller.sequenceOf('meter'), 0);
  }

  // --- dB-Umrechnung ---------------------------------------------------
  check('Vollaussteuerung', toDecibels(1), 0);
  check('halbe Amplitude', Math.round(toDecibels(0.5) * 100) / 100, -6.02);
  check('Vorzeichen egal', toDecibels(-1), 0);
  // Stille: ohne Untergrenze waere das minus unendlich und die
  // Balkenbreite NaN — die Anzeige verschwaende still, statt Stille zu
  // zeigen.
  check('Stille faellt auf den Boden', toDecibels(0), -60);
  check('NaN faellt auf den Boden', toDecibels(NaN), -60);
  check('ueber Vollaussteuerung wird gedeckelt', toDecibels(4), 0);

  check('Boden ist leer', decibelFraction(-60), 0);
  check('Vollaussteuerung ist voll', decibelFraction(0), 1);
  check('Mitte', decibelFraction(-30), 0.5);
  check('unter dem Boden bleibt leer', decibelFraction(-120), 0);

  if (failed > 0) {
    console.error(`\n${failed} Fehler.`);
    process.exit(1);
  }
  console.log('ok — Sticker-Takt: nur Zuwachs, keine Ueberlappung, Ueberlauf sichtbar');
})();
