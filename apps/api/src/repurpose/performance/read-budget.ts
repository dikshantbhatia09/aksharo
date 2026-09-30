/**
 * Reads of a shared allowance over the last hour (2026-10-05), and a pause when
 * the other side asks for one: Postiz's analytics come out of the key posting
 * uses. One API process serves this deployment and the scheduler runs a tick
 * at a time, so a count in memory is the deployment's count - and a restart
 * forgetting it costs at most one hour's small allowance again.
 */

const HOUR_MS = 60 * 60_000;

export class ReadBudget {
  #reads: number[] = [];
  #pausedUntil = 0;

  constructor(
    readonly perHour: number,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Takes one read; false when the hour's allowance is spent or a pause is on. */
  take(): boolean {
    const now = this.clock();
    if (now < this.#pausedUntil) return false;
    this.#reads = this.#reads.filter((at) => now - at < HOUR_MS);
    if (this.#reads.length >= this.perHour) return false;
    this.#reads.push(now);
    return true;
  }

  /** Every read waits until `until` (epoch ms); an earlier pause never shortens a later one. */
  pauseUntil(until: number): void {
    this.#pausedUntil = Math.max(this.#pausedUntil, until);
  }

  /** Until when reads wait, or null when they do not. */
  get pausedUntil(): number | null {
    return this.#pausedUntil > this.clock() ? this.#pausedUntil : null;
  }

  /** Reads taken in the last hour. */
  get used(): number {
    const now = this.clock();
    return this.#reads.filter((at) => now - at < HOUR_MS).length;
  }
}
