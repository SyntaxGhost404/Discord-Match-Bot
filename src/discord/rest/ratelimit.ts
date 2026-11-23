// Client-side rate limiting that follows Discord's documented rules
// (Discord-llms-full.txt → "Rate Limits"):
//
//  * Per-route buckets: identified by the X-RateLimit-Bucket header, scoped by
//    the route's top-level resource (channel, guild or webhook = "major param").
//    Requests in one bucket run one at a time; when a bucket is exhausted we
//    wait for X-RateLimit-Reset-After instead of earning a 429.
//  * Global limit: 50 requests per second per bot, except interaction
//    endpoints which are exempt.
//  * Invalid requests (401/403/429) are counted over 10 minutes so we can warn
//    long before Cloudflare's 10,000 / 10 min ban threshold.

import { KeyedSerialQueue, sleep } from '../../util/async.ts';

export interface RouteInfo {
  /** Bucket-independent route identifier, e.g. "PATCH /channels/:major/messages/:id". */
  route: string;
  /** Top-level resource that scopes the bucket (channel/guild/webhook id). */
  major: string;
  /** Whether the request counts toward the 50 req/s global limit. */
  countsTowardGlobal: boolean;
}

const SNOWFLAKE_SEGMENT = /^\d{15,21}$/;

export function routeInfo(method: string, rawPath: string): RouteInfo {
  const path = rawPath.split('?')[0] ?? rawPath;
  const parts = path.split('/').filter(Boolean);
  const top = parts[0] ?? '';

  if (top === 'interactions') {
    // Every interaction is its own resource; never serialize them together.
    return { route: `${method} /interactions/:id/:token/${parts.slice(3).join('/')}`, major: parts[1] ?? '', countsTowardGlobal: false };
  }
  if (top === 'webhooks') {
    const rest = parts.slice(3).map((p) => (SNOWFLAKE_SEGMENT.test(p) ? ':id' : p));
    return { route: `${method} /webhooks/:major/:token/${rest.join('/')}`, major: `${parts[1]}:${parts[2] ?? ''}`, countsTowardGlobal: false };
  }

  let major = 'global';
  const normalized: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (i === 1 && (top === 'channels' || top === 'guilds') && SNOWFLAKE_SEGMENT.test(part)) {
      major = part;
      normalized.push(':major');
      continue;
    }
    if (top === 'channels' && part === 'reactions') {
      // All reaction routes on a message share one limit.
      normalized.push('reactions');
      break;
    }
    normalized.push(SNOWFLAKE_SEGMENT.test(part) ? ':id' : part);
  }
  return { route: `${method} /${normalized.join('/')}`, major, countsTowardGlobal: true };
}

interface BucketState {
  remaining: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly bucketHashes = new Map<string, string>();
  private readonly states = new Map<string, BucketState>();
  private readonly queues = new KeyedSerialQueue();
  private readonly globalWindow: number[] = [];
  private globalBlockedUntil = 0;
  private readonly invalid: number[] = [];

  readonly globalLimit: number;
  private readonly onInvalidThreshold: ((count: number) => void) | undefined;

  constructor(options: { globalLimit?: number; onInvalidThreshold?: (count: number) => void } = {}) {
    this.globalLimit = options.globalLimit ?? 50;
    this.onInvalidThreshold = options.onInvalidThreshold;
  }

  private keyFor(info: RouteInfo): string {
    return `${this.bucketHashes.get(info.route) ?? info.route}|${info.major}`;
  }

  /** Runs `task` inside the request's bucket once the limits allow it. */
  schedule<T>(info: RouteInfo, task: () => Promise<T>): Promise<T> {
    const key = this.keyFor(info);
    return this.queues.run(key, async () => {
      const state = this.states.get(key);
      if (state && state.remaining <= 0) {
        const wait = state.resetAt - Date.now();
        if (wait > 0) await sleep(wait);
        state.remaining = 1;
      }
      if (info.countsTowardGlobal) await this.acquireGlobal();
      return task();
    });
  }

  private async acquireGlobal(): Promise<void> {
    for (;;) {
      const now = Date.now();
      if (this.globalBlockedUntil > now) {
        await sleep(this.globalBlockedUntil - now);
        continue;
      }
      while (this.globalWindow.length && now - this.globalWindow[0]! >= 1000) this.globalWindow.shift();
      if (this.globalWindow.length < this.globalLimit) {
        this.globalWindow.push(now);
        return;
      }
      await sleep(1000 - (now - this.globalWindow[0]!) + 5);
    }
  }

  /** Feeds response headers back into the bucket state. */
  update(info: RouteInfo, headers: Headers): void {
    const hash = headers.get('x-ratelimit-bucket');
    if (hash) this.bucketHashes.set(info.route, hash);
    const remaining = headers.get('x-ratelimit-remaining');
    const resetAfter = headers.get('x-ratelimit-reset-after');
    if (remaining !== null && resetAfter !== null) {
      this.states.set(this.keyFor(info), {
        remaining: Number(remaining),
        resetAt: Date.now() + Number(resetAfter) * 1000,
      });
    }
  }

  /** Records a 429 so the bucket (or everything, if global) pauses. */
  onRateLimited(info: RouteInfo, retryAfterMs: number, global: boolean): void {
    if (global) {
      this.globalBlockedUntil = Math.max(this.globalBlockedUntil, Date.now() + retryAfterMs);
    } else {
      this.states.set(this.keyFor(info), { remaining: 0, resetAt: Date.now() + retryAfterMs });
    }
  }

  /** Counts 401/403/429 responses (Cloudflare bans IPs at 10k / 10 min). */
  recordInvalid(now = Date.now()): number {
    this.invalid.push(now);
    while (this.invalid.length && now - this.invalid[0]! > 10 * 60_000) this.invalid.shift();
    const count = this.invalid.length;
    if (count > 0 && count % 500 === 0) this.onInvalidThreshold?.(count);
    return count;
  }
}
