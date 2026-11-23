import type { Database } from '../database.ts';

export type DmStatus = 'unknown' | 'ok' | 'closed';

export interface UserRecord {
  id: string;
  username: string;
  globalName: string | null;
  locale: string | null;
  dmChannelId: string | null;
  dmStatus: DmStatus;
  firstSeenAt: number;
  lastSeenAt: number;
  bannedUntil: number | null;
  banReason: string | null;
  bannedBy: string | null;
  likeNoticeAt: number | null;
  chatHintAt: number | null;
}

interface UserRow {
  id: string;
  username: string;
  global_name: string | null;
  locale: string | null;
  dm_channel_id: string | null;
  dm_status: DmStatus;
  first_seen_at: number;
  last_seen_at: number;
  banned_until: number | null;
  ban_reason: string | null;
  banned_by: string | null;
  like_notice_at: number | null;
  chat_hint_at: number | null;
}

const toRecord = (r: UserRow): UserRecord => ({
  id: r.id,
  username: r.username,
  globalName: r.global_name,
  locale: r.locale,
  dmChannelId: r.dm_channel_id,
  dmStatus: r.dm_status,
  firstSeenAt: r.first_seen_at,
  lastSeenAt: r.last_seen_at,
  bannedUntil: r.banned_until,
  banReason: r.ban_reason,
  bannedBy: r.banned_by,
  likeNoticeAt: r.like_notice_at,
  chatHintAt: r.chat_hint_at,
});

export const PERMANENT_BAN = Number.MAX_SAFE_INTEGER;

export class UsersRepo {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  /** Creates or refreshes the user's row from an interaction/message author. */
  touch(user: { id: string; username: string; global_name?: string | null }, locale: string | null, now: number): void {
    this.db.run(
      `INSERT INTO users (id, username, global_name, locale, first_seen_at, last_seen_at)
       VALUES (:id, :username, :global_name, :locale, :now, :now)
       ON CONFLICT (id) DO UPDATE SET
         username = excluded.username,
         global_name = excluded.global_name,
         locale = COALESCE(excluded.locale, users.locale),
         last_seen_at = excluded.last_seen_at`,
      { id: user.id, username: user.username, global_name: user.global_name ?? null, locale, now },
    );
  }

  get(id: string): UserRecord | null {
    const row = this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
    return row ? toRecord(row) : null;
  }

  setDm(id: string, channelId: string | null, status: DmStatus): void {
    this.db.run('UPDATE users SET dm_channel_id = ?, dm_status = ? WHERE id = ?', [channelId, status, id]);
  }

  setDmStatus(id: string, status: DmStatus): void {
    this.db.run('UPDATE users SET dm_status = ? WHERE id = ?', [status, id]);
  }

  /** The active ban, or null. Expired bans count as no ban. */
  activeBan(id: string, now: number): { until: number; reason: string | null } | null {
    const row = this.db.get<{ banned_until: number | null; ban_reason: string | null }>(
      'SELECT banned_until, ban_reason FROM users WHERE id = ?',
      [id],
    );
    if (!row?.banned_until || row.banned_until <= now) return null;
    return { until: row.banned_until, reason: row.ban_reason };
  }

  ban(id: string, until: number, reason: string, by: string): void {
    this.db.run('UPDATE users SET banned_until = ?, ban_reason = ?, banned_by = ? WHERE id = ?', [until, reason, by, id]);
  }

  unban(id: string): boolean {
    return this.db.run('UPDATE users SET banned_until = NULL, ban_reason = NULL, banned_by = NULL WHERE id = ? AND banned_until IS NOT NULL', [id]).changes > 0;
  }

  clearExpiredBans(now: number): number {
    return this.db.run('UPDATE users SET banned_until = NULL, ban_reason = NULL, banned_by = NULL WHERE banned_until IS NOT NULL AND banned_until <= ?', [now]).changes;
  }

  setLikeNoticeAt(id: string, at: number): void {
    this.db.run('UPDATE users SET like_notice_at = ? WHERE id = ?', [at, id]);
  }

  setChatHintAt(id: string, at: number): void {
    this.db.run('UPDATE users SET chat_hint_at = ? WHERE id = ?', [at, id]);
  }

  /** Ensures a row exists (for ids learned from moderator commands). */
  ensure(id: string, now: number): void {
    this.db.run('INSERT OR IGNORE INTO users (id, first_seen_at, last_seen_at) VALUES (?, ?, ?)', [id, now, now]);
  }

  count(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
  }

  countBanned(now: number): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE banned_until > ?', [now])!.n;
  }
}
