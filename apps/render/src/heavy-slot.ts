/**
 * The heavy jobs one render process runs at once (2026-10-03).
 *
 * `render.video` and `render.compilation` are separate BullMQ workers, and
 * each has its own concurrency: without this a compilation would encode
 * beside a video render, two x264 encoders on a node sized for one. Both
 * processors run through the same slots - as many as `RENDER_CONCURRENCY` -
 * and take them in the order they asked. A job waiting here is still held by
 * its worker (BullMQ renews the lock of every active job), and stays `queued`
 * to the API until it starts and posts its first progress.
 */
export class HeavySlots {
  private busy = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly slots: number) {
    if (!Number.isInteger(slots) || slots < 1) {
      throw new RangeError(`at least one slot, not ${String(slots)}`);
    }
  }

  /** How many jobs hold a slot now, and how many wait for one. */
  get load(): { readonly running: number; readonly waiting: number } {
    return { running: this.busy, waiting: this.waiting.length };
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.busy < this.slots) {
      this.busy += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      // The slot is handed over, not freed and retaken: nobody can jump the line.
      this.waiting.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next === undefined) {
      this.busy -= 1;
      return;
    }
    next();
  }
}
