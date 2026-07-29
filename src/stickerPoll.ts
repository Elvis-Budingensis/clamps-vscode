/**
 * Fetch cycle for sticker rings.
 *
 * The realtime side writes into a ring without allocating (see
 * `sticker-state-record-sample-for-repl` in rpc.lisp). It pushes nothing
 * of its own accord — the audio thread may neither send nor block. So
 * the client fetches.
 *
 * Two things make the difference between "works in the test" and "works
 * at 30 queries per second":
 *
 * 1. Only the increment is transferred. Every answer names the new
 *    sequence number, which goes back along with the next request.
 *    Without that, every query would bring the whole ring — irrelevant
 *    at 256 values, not so for a spectrogram.
 *
 * 2. Only ever one query is in flight. If the bridge is slower than the
 *    cycle, requests would otherwise pile up, and the longer you watch,
 *    the further behind the display runs.
 */

export interface StickerBatch {
  /** Neuer Sequenzstand des Rings. */
  sequence: number;
  /** Values that fell out of the ring between two queries. */
  dropped: number;
  /** The increment, oldest first. */
  values: number[];
}

/** What the poller needs in order to query. Injected so that it stays
 *  testable without a LanguageClient. */
export type StickerRequest = (
  key: string,
  since: number,
  limit: number
) => Promise<StickerBatch | undefined>;

export type StickerListener = (key: string, batch: StickerBatch) => void;

export class StickerPoller {
  private readonly since = new Map<string, number>();
  /**
   * Keys that have been fetched at least once.
   *
   * At the very first fetch the ring is usually long since full: the DSP
   * has been running for minutes, the display is only just being opened.
   * The difference between sequence and ring contents is then enormous,
   * but it is not a gap — it is simply the time before anyone looked.
   * Reported as `dropped`, "3341 lost" would stand next to a perfectly
   * healthy bar right after opening, and the message would thereby be
   * worthless, because it is always there.
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
   * From when something counts as "new". At the first fetch of a key this
   * is 0, so the entire existing ring arrives — which is exactly right
   * when a display is opened, so that it does not start out empty.
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
          // Throw the sequence away as well: whoever subscribes again
          // later wants to see the current ring, not carry on from a
          // position that has long since dropped out.
          this.since.delete(key);
        }
      },
    };
  }

  /** Keys that somebody is currently listening to. */
  activeKeys(): string[] {
    return [...this.listeners.keys()];
  }

  /**
   * One pass. Public so that tests can drive the cycle without waiting
   * for real timers.
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
          // A failed query is no reason to end the cycle. The session may
          // be restarting; the next pass will work again.
          continue;
        }
        if (!batch) continue;

        // A smaller sequence value means the ring was newly created or
        // cleared. Then count from the start again rather than keeping a
        // negative difference that is never made up.
        this.since.set(key, batch.sequence);

        // First fetch: what lies before anyone looked is not a gap.
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
 * Peak value of a block in dBFS, with a lower bound.
 *
 * Without a lower bound log10(0) yields minus infinity and the bar width
 * becomes NaN — the display then vanishes silently instead of showing
 * silence.
 */
export function toDecibels(value: number, floorDb = -60): number {
  const magnitude = Math.abs(value);
  if (!Number.isFinite(magnitude) || magnitude <= 0) return floorDb;
  const db = 20 * Math.log10(magnitude);
  return Math.max(floorDb, Math.min(0, db));
}

/** Bar fraction 0..1 from a dB value. */
export function decibelFraction(db: number, floorDb = -60): number {
  if (floorDb >= 0) return 0;
  return Math.max(0, Math.min(1, (db - floorDb) / -floorDb));
}
