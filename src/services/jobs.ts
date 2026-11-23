// Worker for the durable job queue. Handlers must be idempotent-ish: a job
// may run again if the process dies mid-way. Throw PermanentJobError to stop
// retrying (e.g. the target user no longer exists).

import type { JobRecord } from '../db/repos/jobs.ts';
import type { Store } from '../db/store.ts';
import type { Logger } from '../util/logger.ts';
import { MINUTE, SECOND, HOUR, type Clock } from '../util/time.ts';

export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

export type JobHandler = (payload: never, job: JobRecord) => Promise<void>;

const RETRY_DELAYS = [5 * SECOND, 30 * SECOND, 2 * MINUTE, 10 * MINUTE, 30 * MINUTE, HOUR];

export class JobRunner {
  private readonly store: Store;
  private readonly log: Logger;
  private readonly clock: Clock;
  private readonly handlers = new Map<string, JobHandler>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly concurrency: number;

  constructor(store: Store, log: Logger, clock: Clock, concurrency = 4) {
    this.store = store;
    this.log = log.child({ component: 'jobs' });
    this.clock = clock;
    this.concurrency = concurrency;
  }

  register<P>(type: string, handler: (payload: P, job: JobRecord) => Promise<void>): void {
    if (this.handlers.has(type)) throw new Error(`Duplicate job handler ${type}`);
    this.handlers.set(type, handler as JobHandler);
  }

  /** Enqueue a job. Call inside store.transaction() to make it atomic with a state change. */
  enqueue(type: string, payload: unknown, options: { delayMs?: number; dedupeKey?: string; maxAttempts?: number } = {}): void {
    if (!this.handlers.has(type)) throw new Error(`No handler registered for job type ${type}`);
    const now = this.clock();
    this.store.jobs.enqueue(type, payload, { runAt: now + (options.delayMs ?? 0), dedupeKey: options.dedupeKey, maxAttempts: options.maxAttempts }, now);
  }

  start(intervalMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Processes due jobs once (also used directly by tests). */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const jobs = this.store.jobs.claimDue(this.clock(), this.concurrency * 4, 2 * MINUTE);
      for (let i = 0; i < jobs.length; i += this.concurrency) {
        await Promise.all(jobs.slice(i, i + this.concurrency).map((job) => this.run(job)));
      }
      return jobs.length;
    } finally {
      this.running = false;
    }
  }

  private async run(job: JobRecord): Promise<void> {
    const handler = this.handlers.get(job.type);
    if (!handler) {
      this.store.jobs.bury(job.id, `no handler for ${job.type}`);
      return;
    }
    try {
      await handler(job.payload as never, job);
      this.store.jobs.complete(job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof PermanentJobError || job.attempts >= job.maxAttempts) {
        this.log.warn('Job failed permanently', { type: job.type, id: job.id, attempts: job.attempts, error: message });
        this.store.jobs.bury(job.id, message);
        return;
      }
      const delay = RETRY_DELAYS[Math.min(job.attempts - 1, RETRY_DELAYS.length - 1)]!;
      this.log.info('Job failed, will retry', { type: job.type, id: job.id, attempt: job.attempts, delayMs: delay, error: message });
      this.store.jobs.retry(job.id, message, this.clock() + delay);
    }
  }
}
