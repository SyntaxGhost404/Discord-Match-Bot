// Spawns and supervises gateway shards.
//
// Identify throttling follows the docs: shards are grouped into rate-limit
// buckets by `shard_id % max_concurrency`; each bucket may identify once per
// 5 seconds. The daily session-start budget (`session_start_limit`) is
// respected, and a local circuit breaker slows down runaway identify loops —
// exhausting the 1000/day budget makes Discord reset the bot token.

import type { DiscordApi } from '../rest/api.ts';
import type { GatewayBotInfo, PresenceUpdate } from '../types.ts';
import { Shard } from './shard.ts';
import { KeyedSerialQueue, sleep } from '../../util/async.ts';
import type { Logger } from '../../util/logger.ts';

export interface GatewayManagerOptions {
  api: DiscordApi;
  token: string;
  intents: number;
  shardCount: number | 'auto';
  presence?: PresenceUpdate;
  logger: Logger;
  onDispatch: (event: string, data: unknown, shardId: number) => void;
  onFatal: (code: number, reason: string) => void;
}

export class IdentifyThrottler {
  private readonly queue = new KeyedSerialQueue();
  private readonly nextAllowedAt = new Map<number, number>();
  private readonly recent: number[] = [];
  private remaining: number;
  private resetAt: number;
  private readonly maxConcurrency: number;
  private readonly log: Logger;
  private readonly refresh: () => Promise<GatewayBotInfo>;

  constructor(info: GatewayBotInfo, refresh: () => Promise<GatewayBotInfo>, log: Logger) {
    this.maxConcurrency = Math.max(1, info.session_start_limit.max_concurrency);
    this.remaining = info.session_start_limit.remaining;
    this.resetAt = Date.now() + info.session_start_limit.reset_after;
    this.refresh = refresh;
    this.log = log;
  }

  wait(shardId: number): Promise<void> {
    const bucket = shardId % this.maxConcurrency;
    return this.queue.run(String(bucket), async () => {
      const gap = (this.nextAllowedAt.get(bucket) ?? 0) - Date.now();
      if (gap > 0) await sleep(gap);

      // Circuit breaker against identify storms.
      const now = Date.now();
      while (this.recent.length && now - this.recent[0]! > 10 * 60_000) this.recent.shift();
      if (this.recent.length >= 20) {
        this.log.error('Too many gateway identifies in 10 minutes; backing off for 60s to protect the token');
        await sleep(60_000);
      }

      if (this.remaining <= 5) {
        try {
          const fresh = await this.refresh();
          this.remaining = fresh.session_start_limit.remaining;
          this.resetAt = Date.now() + fresh.session_start_limit.reset_after;
        } catch (error) {
          this.log.warn('Could not refresh the session start limit', { error });
        }
        if (this.remaining <= 1) {
          const wait = Math.max(0, this.resetAt - Date.now());
          this.log.error('Daily gateway session budget exhausted; waiting for reset', { waitMs: wait });
          await sleep(wait + 1000);
        }
      }

      this.remaining--;
      this.recent.push(Date.now());
      this.nextAllowedAt.set(bucket, Date.now() + 5_250);
    });
  }
}

export class GatewayManager {
  private readonly options: GatewayManagerOptions;
  private readonly log: Logger;
  readonly shards: Shard[] = [];

  constructor(options: GatewayManagerOptions) {
    this.options = options;
    this.log = options.logger.child({ component: 'gateway' });
  }

  async start(): Promise<void> {
    const info = await this.options.api.getGatewayBot();
    const count = this.options.shardCount === 'auto' ? Math.max(1, info.shards) : this.options.shardCount;
    this.log.info('Starting gateway', {
      shards: count,
      recommended: info.shards,
      sessionsRemaining: info.session_start_limit.remaining,
      maxConcurrency: info.session_start_limit.max_concurrency,
    });
    const throttler = new IdentifyThrottler(info, () => this.options.api.getGatewayBot(), this.log);

    for (let id = 0; id < count; id++) {
      const shard = new Shard({
        id,
        count,
        token: this.options.token,
        intents: this.options.intents,
        gatewayUrl: info.url,
        presence: this.options.presence,
        logger: this.log,
        identifyGate: (shardId) => throttler.wait(shardId),
        onDispatch: (event, data, s) => this.options.onDispatch(event, data, s.id),
        onFatal: (_s, code, reason) => this.options.onFatal(code, reason),
      });
      this.shards.push(shard);
      shard.connect();
    }
  }

  stop(): void {
    for (const shard of this.shards) shard.destroy(1000);
  }

  updatePresence(presence: PresenceUpdate): void {
    for (const shard of this.shards) shard.updatePresence(presence);
  }

  get latencyMs(): number {
    const values = this.shards.map((s) => s.latencyMs).filter((v) => v >= 0);
    return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : -1;
  }
}
