// Durable job queue (transactional outbox). A feature commits its state
// change and enqueues the follow-up side effect in the same transaction;
// the worker then delivers it with retries, surviving restarts.

import type { Database } from '../database.ts';

export interface JobRecord {
  id: number;
  type: string;
  payload: unknown;
  runAt: number;
  attempts: number;
  maxAttempts: number;
  dedupeKey: string | null;
}

interface JobRow {
  id: number;
  type: string;
  payload: string;
  run_at: number;
  attempts: number;
  max_attempts: number;
  dedupe_key: string | null;
}

export interface EnqueueOptions {
  runAt?: number;
  /** At most one pending job per key; later enqueues are ignored. */
  dedupeKey?: string;
  maxAttempts?: number;
}

export class JobsRepo {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  enqueue(type: string, payload: unknown, options: EnqueueOptions, now: number): number | null {
    const result = this.db.run(
      `INSERT OR IGNORE INTO jobs (type, payload, run_at, max_attempts, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [type, JSON.stringify(payload ?? null), options.runAt ?? now, options.maxAttempts ?? 6, options.dedupeKey ?? null, now],
    );
    return result.changes > 0 ? result.lastInsertRowid : null;
  }

  /** Claims due jobs by locking them for `lockMs`. */
  claimDue(now: number, limit: number, lockMs: number): JobRecord[] {
    return this.db.transaction(() => {
      const rows = this.db.all<JobRow>(
        `SELECT id, type, payload, run_at, attempts, max_attempts, dedupe_key FROM jobs
         WHERE status = 'pending' AND run_at <= ? AND (locked_until IS NULL OR locked_until <= ?)
         ORDER BY run_at, id LIMIT ?`,
        [now, now, limit],
      );
      for (const row of rows) this.db.run('UPDATE jobs SET locked_until = ?, attempts = attempts + 1 WHERE id = ?', [now + lockMs, row.id]);
      return rows.map((row) => ({
        id: row.id,
        type: row.type,
        payload: safeParse(row.payload),
        runAt: row.run_at,
        attempts: row.attempts + 1,
        maxAttempts: row.max_attempts,
        dedupeKey: row.dedupe_key,
      }));
    });
  }

  complete(id: number): void {
    this.db.run('DELETE FROM jobs WHERE id = ?', [id]);
  }

  retry(id: number, error: string, runAt: number): void {
    this.db.run('UPDATE jobs SET run_at = ?, locked_until = NULL, last_error = ? WHERE id = ?', [runAt, error.slice(0, 1000), id]);
  }

  /** Gives up on a job but keeps it for inspection. Frees its dedupe key. */
  bury(id: number, error: string): void {
    this.db.run(`UPDATE jobs SET status = 'dead', locked_until = NULL, dedupe_key = NULL, last_error = ? WHERE id = ?`, [error.slice(0, 1000), id]);
  }

  pruneDead(before: number): number {
    return this.db.run(`DELETE FROM jobs WHERE status = 'dead' AND created_at < ?`, [before]).changes;
  }

  counts(): { pending: number; dead: number } {
    const row = this.db.get<{ pending: number | null; dead: number | null }>(
      `SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead FROM jobs`,
    )!;
    return { pending: row.pending ?? 0, dead: row.dead ?? 0 };
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export class KvRepo {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  get(key: string): string | null {
    return this.db.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', [key])?.value ?? null;
  }

  delete(key: string): void {
    this.db.run('DELETE FROM kv WHERE key = ?', [key]);
  }

  set(key: string, value: string, now: number): void {
    this.db.run(
      'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [key, value, now],
    );
  }
}

/** Opaque references used instead of user ids in buttons and select menus. */
export class RefsRepo {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  refFor(userId: string): number {
    this.db.run('INSERT OR IGNORE INTO profile_refs (user_id) VALUES (?)', [userId]);
    return this.db.get<{ ref: number }>('SELECT ref FROM profile_refs WHERE user_id = ?', [userId])!.ref;
  }

  userFor(ref: number | string): string | null {
    const id = Number(ref);
    if (!Number.isInteger(id) || id <= 0) return null;
    return this.db.get<{ user_id: string }>('SELECT user_id FROM profile_refs WHERE ref = ?', [id])?.user_id ?? null;
  }
}
