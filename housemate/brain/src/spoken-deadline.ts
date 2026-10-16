/**
 * The hard deadline on a spoken model call. It starts at the normal spoken
 * limit and can be stretched once, measured from the start, when the turn
 * earns more time.
 */
export class SpokenDeadline {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly startedAtMs: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout;
  private currentMs: number;

  constructor(ms: number, now: () => number = Date.now) {
    this.now = now;
    this.startedAtMs = now();
    this.currentMs = ms;
    this.signal = this.controller.signal;
    this.timer = setTimeout(() => this.expire(), ms);
  }

  get ms(): number {
    return this.currentMs;
  }

  /** Moves the deadline out to `totalMs` from the start; never shortens it or revives an expired one. */
  extendTo(totalMs: number): void {
    if (this.signal.aborted || totalMs <= this.currentMs) {
      return;
    }
    clearTimeout(this.timer);
    this.currentMs = totalMs;
    this.timer = setTimeout(() => this.expire(), Math.max(0, totalMs - (this.now() - this.startedAtMs)));
  }

  clear(): void {
    clearTimeout(this.timer);
  }

  private expire(): void {
    const error = new Error(`Spoken model call passed its ${this.currentMs}ms deadline`);
    error.name = "AbortError";
    this.controller.abort(error);
  }
}
