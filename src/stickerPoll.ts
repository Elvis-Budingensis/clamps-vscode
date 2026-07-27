/**
 * Abholtakt für Sticker-Ringe.
 *
 * Die Realtime-Seite schreibt allokationsfrei in einen Ring (siehe
 * `sticker-state-record-sample-for-repl` in rpc.lisp). Sie schiebt nichts
 * von sich aus — der Audio-Thread darf weder senden noch blockieren. Also
 * holt der Client ab.
 *
 * Zwei Dinge machen den Unterschied zwischen „funktioniert im Test" und
 * „funktioniert bei 30 Abfragen pro Sekunde":
 *
 * 1. Es wird nur der Zuwachs übertragen. Jede Antwort nennt die neue
 *    Sequenznummer, die beim nächsten Mal wieder mitgeht. Ohne das käme
 *    bei jeder Abfrage der ganze Ring — bei 256 Werten egal, bei einem
 *    Spektrogramm nicht.
 *
 * 2. Es läuft immer nur eine Abfrage. Ist die Bridge langsamer als der
 *    Takt, würden sich sonst Anfragen stapeln, und je länger man zusieht,
 *    desto weiter läuft die Anzeige hinterher.
 */

export interface StickerBatch {
  /** Neuer Sequenzstand des Rings. */
  sequence: number;
  /** Werte, die zwischen zwei Abfragen aus dem Ring gefallen sind. */
  dropped: number;
  /** Der Zuwachs, ältester zuerst. */
  values: number[];
}

/** Was der Poller zum Abfragen braucht. Injiziert, damit er ohne
 *  LanguageClient testbar bleibt. */
export type StickerRequest = (
  key: string,
  since: number,
  limit: number
) => Promise<StickerBatch | undefined>;

export type StickerListener = (key: string, batch: StickerBatch) => void;

export class StickerPoller {
  private readonly since = new Map<string, number>();
  /**
   * Schlüssel, für die schon einmal abgeholt wurde.
   *
   * Beim allerersten Abholen steht der Ring meist längst voll da: der DSP
   * läuft seit Minuten, die Anzeige wird gerade erst geöffnet. Die
   * Differenz zwischen Sequenz und Ringinhalt ist dann riesig, aber sie
   * ist keine Lücke — es ist schlicht die Zeit vor dem Hinsehen. Als
   * `dropped` gemeldet stünde nach dem Öffnen sofort „3341 verloren"
   * neben einem völlig gesunden Balken, und die Meldung wäre damit
   * wertlos, weil sie immer da ist.
   */
  private readonly primed = new Set<string>();
  private readonly listeners = new Map<string, Set<StickerListener>>();
  private inFlight = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly request: StickerRequest,
    private readonly limit = 4096
  ) {}

  /**
   * Ab wann als „neu" gilt. Beim ersten Abholen eines Schlüssels steht
   * hier 0, also kommt der gesamte vorhandene Ring — was beim Öffnen einer
   * Anzeige genau richtig ist, damit sie nicht leer beginnt.
   */
  sequenceOf(key: string): number {
    return this.since.get(key) ?? 0;
  }

  subscribe(key: string, listener: StickerListener): { dispose(): void } {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);
    return {
      dispose: () => {
        set!.delete(listener);
        if (set!.size === 0) {
          this.listeners.delete(key);
          this.primed.delete(key);
          // Sequenzstand mit wegwerfen: wer später neu abonniert, will den
          // aktuellen Ring sehen und nicht ab einem Stand weitermachen,
          // der inzwischen längst herausgefallen ist.
          this.since.delete(key);
        }
      },
    };
  }

  /** Schlüssel, für die gerade jemand zuhört. */
  activeKeys(): string[] {
    return [...this.listeners.keys()];
  }

  /**
   * Ein Durchlauf. Öffentlich, damit Tests takten können, ohne auf echte
   * Timer zu warten.
   */
  async poll(): Promise<void> {
    if (this.inFlight) return;
    const keys = this.activeKeys();
    if (keys.length === 0) return;

    this.inFlight = true;
    try {
      for (const key of keys) {
        let batch: StickerBatch | undefined;
        try {
          batch = await this.request(key, this.sequenceOf(key), this.limit);
        } catch {
          // Eine gescheiterte Abfrage ist kein Grund, den Takt zu beenden.
          // Die Session kann gerade neu starten; beim nächsten Durchlauf
          // klappt es wieder.
          continue;
        }
        if (!batch) continue;

        // Ein kleinerer Sequenzstand heisst: der Ring wurde neu angelegt
        // oder geleert. Dann von vorn zählen statt eine negative Differenz
        // zu behalten, die nie wieder aufgeholt wird.
        this.since.set(key, batch.sequence);

        // Erstes Abholen: was vor dem Hinsehen liegt, ist keine Lücke.
        const first = !this.primed.has(key);
        this.primed.add(key);
        const reported: StickerBatch = first
          ? { ...batch, dropped: 0 }
          : batch;

        if (reported.values.length === 0 && reported.dropped === 0) continue;
        for (const listener of this.listeners.get(key) ?? []) {
          listener(key, reported);
        }
      }
    } finally {
      this.inFlight = false;
    }
  }

  start(intervalMs: number): void {
    this.stop();
    this.timer = setInterval(() => void this.poll(), intervalMs);
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  dispose(): void {
    this.stop();
    this.listeners.clear();
    this.since.clear();
    this.primed.clear();
  }
}

/**
 * Spitzenwert eines Blocks in dBFS, mit Untergrenze.
 *
 * Ohne Untergrenze liefert log10(0) minus unendlich, und die Balkenbreite
 * wird NaN — die Anzeige verschwindet dann still, statt Stille zu zeigen.
 */
export function toDecibels(value: number, floorDb = -60): number {
  const magnitude = Math.abs(value);
  if (!Number.isFinite(magnitude) || magnitude <= 0) return floorDb;
  const db = 20 * Math.log10(magnitude);
  return Math.max(floorDb, Math.min(0, db));
}

/** Balkenanteil 0..1 aus einem dB-Wert. */
export function decibelFraction(db: number, floorDb = -60): number {
  if (floorDb >= 0) return 0;
  return Math.max(0, Math.min(1, (db - floorDb) / -floorDb));
}
