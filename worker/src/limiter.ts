/**
 * Runs jobs for the same key one at a time, at least `gapMs` apart, so each store sees a slow,
 * human-paced trickle of searches rather than a burst.
 */
export class PoliteQueue {
  private tails = new Map<string, Promise<unknown>>();
  private last = new Map<string, number>();

  constructor(
    private gapMs: number,
    private sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    private now = () => Date.now(),
  ) {}

  run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        const wait = (this.last.get(key) ?? -Infinity) + this.gapMs - this.now();
        if (wait > 0) await this.sleep(wait);
        try {
          return await job();
        } finally {
          this.last.set(key, this.now());
        }
      });
    this.tails.set(key, next);
    return next;
  }
}
