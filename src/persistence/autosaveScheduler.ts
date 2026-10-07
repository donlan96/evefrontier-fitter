interface AutosaveTimerApi {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const browserTimers: AutosaveTimerApi = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

export class AutosaveScheduler {
  private idleTimer: unknown = null;
  private maxWaitTimer: unknown = null;
  private pending = false;

  constructor(
    private readonly save: () => void | Promise<void>,
    private readonly idleDelayMs = 5_000,
    private readonly maxWaitMs = 30_000,
    private readonly timers: AutosaveTimerApi = browserTimers,
  ) {}

  schedule(): void {
    this.pending = true;
    if (this.idleTimer !== null) this.timers.clearTimeout(this.idleTimer);
    this.idleTimer = this.timers.setTimeout(() => this.flushPending(), this.idleDelayMs);
    if (this.maxWaitTimer === null) {
      this.maxWaitTimer = this.timers.setTimeout(() => this.flushPending(), this.maxWaitMs);
    }
  }

  cancel(): void {
    this.pending = false;
    this.clearTimers();
  }

  private flushPending(): void {
    if (!this.pending) return;
    this.pending = false;
    this.clearTimers();
    void Promise.resolve(this.save()).catch(() => {
      // The persistence status path reports failures and keeps retryable state.
    });
  }

  private clearTimers(): void {
    if (this.idleTimer !== null) this.timers.clearTimeout(this.idleTimer);
    if (this.maxWaitTimer !== null) this.timers.clearTimeout(this.maxWaitTimer);
    this.idleTimer = null;
    this.maxWaitTimer = null;
  }
}
