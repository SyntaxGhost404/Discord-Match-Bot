// Thin wrapper around Node's built-in SQLite (node:sqlite).
//
// SQLite calls are synchronous, so a transaction body cannot be interleaved
// with other JavaScript: every multi-step state change done inside
// `transaction()` is atomic by construction. Network I/O never happens inside
// a transaction — features commit state first, then talk to Discord.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlInput = SqlValue | boolean | undefined;
export type Params = Record<string, SqlInput> | SqlInput[];

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

function bind(value: SqlInput): SqlValue {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function normalize(params: Params | undefined): SqlValue[] | Record<string, SqlValue> {
  if (!params) return [];
  if (Array.isArray(params)) return params.map(bind);
  const out: Record<string, SqlValue> = {};
  for (const [key, value] of Object.entries(params)) out[key] = bind(value);
  return out;
}

export class Database {
  readonly raw: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
  }

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.raw.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  run(sql: string, params?: Params): RunResult {
    const args = normalize(params);
    const result = Array.isArray(args) ? this.statement(sql).run(...args) : this.statement(sql).run(args);
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  get<T>(sql: string, params?: Params): T | undefined {
    const args = normalize(params);
    const row = Array.isArray(args) ? this.statement(sql).get(...args) : this.statement(sql).get(args);
    return row as T | undefined;
  }

  all<T>(sql: string, params?: Params): T[] {
    const args = normalize(params);
    const rows = Array.isArray(args) ? this.statement(sql).all(...args) : this.statement(sql).all(args);
    return rows as T[];
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** Runs `fn` atomically. Nested calls become savepoints. `fn` must be synchronous. */
  transaction<T>(fn: () => T): T {
    const savepoint = `sp_${this.depth}`;
    this.raw.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.depth++;
    try {
      const result = fn();
      if (result instanceof Promise) throw new Error('transaction() callbacks must be synchronous');
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw error;
    }
  }

  close(): void {
    this.statements.clear();
    this.raw.close();
  }
}

/** JSON column helpers. */
export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJsonArray<T = string>(value: unknown): T[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}
