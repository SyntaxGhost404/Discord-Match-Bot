// Async primitives used across the bot.

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Runs tasks one at a time per key, in arrival order. Different keys run
 * concurrently. Used to serialize a user's interactions and to keep relayed
 * chat messages in order.
 */
export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  get size(): number {
    return this.tails.size;
  }
}

/** Sliding-window limiter: at most `limit` hits per `windowMs` per key. */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Records a hit and returns whether it is within the limit. */
  hit(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  /** Drops keys with no recent hits so the map cannot grow forever. */
  prune(now = Date.now()): void {
    for (const [key, times] of this.hits) {
      if (!times.some((t) => now - t < this.windowMs)) this.hits.delete(key);
    }
  }
}

/** Remembers when something last happened per key (cooldowns, throttles). */
export class Cooldowns {
  private readonly last = new Map<string, number>();
  private readonly ms: number;

  constructor(ms: number) {
    this.ms = ms;
  }

  /** True (and starts the cooldown) when the key is not cooling down. */
  take(key: string, now = Date.now()): boolean {
    const previous = this.last.get(key);
    if (previous !== undefined && now - previous < this.ms) return false;
    this.last.set(key, now);
    return true;
  }

  prune(now = Date.now()): void {
    for (const [key, at] of this.last) if (now - at >= this.ms) this.last.delete(key);
  }
}

/** Exponential backoff with full jitter, capped. */
export function backoffDelay(attempt: number, baseMs = 1000, capMs = 60_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}
