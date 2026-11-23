// Photos, swipes (likes/passes), matches and blocks.

import type { Database } from '../database.ts';
import type { Photo } from '../../domain/profile.ts';
import { orderedPair } from '../../util/snowflake.ts';

// -- photos ---------------------------------------------------------------------

interface PhotoRow {
  id: number;
  user_id: string;
  position: number;
  channel_id: string;
  message_id: string;
  attachment_id: string;
  filename: string;
  content_type: string | null;
  width: number | null;
  height: number | null;
  size: number;
  status: 'active' | 'flagged';
  created_at: number;
}

const toPhoto = (r: PhotoRow): Photo => ({
  id: r.id,
  userId: r.user_id,
  position: r.position,
  channelId: r.channel_id,
  messageId: r.message_id,
  attachmentId: r.attachment_id,
  filename: r.filename,
  contentType: r.content_type,
  width: r.width,
  height: r.height,
  size: r.size,
  status: r.status,
  createdAt: r.created_at,
});

export type NewPhoto = Omit<Photo, 'id' | 'userId' | 'position' | 'status' | 'createdAt'>;

export class PhotosRepo {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  /** Active photos in display order. */
  list(userId: string): Photo[] {
    return this.db
      .all<PhotoRow>(`SELECT * FROM photos WHERE user_id = ? AND status = 'active' ORDER BY position`, [userId])
      .map(toPhoto);
  }

  listAll(userId: string): Photo[] {
    return this.db.all<PhotoRow>('SELECT * FROM photos WHERE user_id = ? ORDER BY position', [userId]).map(toPhoto);
  }

  countActive(userIds: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (!userIds.length) return out;
    const rows = this.db.all<{ user_id: string; n: number }>(
      `SELECT user_id, COUNT(*) AS n FROM photos WHERE status = 'active' AND user_id IN (${userIds.map(() => '?').join(',')}) GROUP BY user_id`,
      userIds,
    );
    for (const row of rows) out.set(row.user_id, row.n);
    return out;
  }

  /** Replaces the user's photos; returns the rows that were removed. */
  replace(userId: string, photos: NewPhoto[], now: number): Photo[] {
    return this.db.transaction(() => {
      const removed = this.listAll(userId);
      this.db.run('DELETE FROM photos WHERE user_id = ?', [userId]);
      photos.forEach((p, position) => {
        this.db.run(
          `INSERT INTO photos (user_id, position, channel_id, message_id, attachment_id, filename, content_type, width, height, size, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [userId, position, p.channelId, p.messageId, p.attachmentId, p.filename, p.contentType, p.width, p.height, p.size, now],
        );
      });
      return removed;
    });
  }

  removeAll(userId: string): Photo[] {
    return this.replace(userId, [], 0);
  }

  byMessage(messageId: string): Photo[] {
    return this.db.all<PhotoRow>('SELECT * FROM photos WHERE message_id = ?', [messageId]).map(toPhoto);
  }

  /** Marks photos whose attachments were flagged by Discord's content scanning. */
  flag(messageId: string, attachmentIds: string[]): Photo[] {
    const flagged: Photo[] = [];
    for (const attachmentId of attachmentIds) {
      const row = this.db.get<PhotoRow>(
        `UPDATE photos SET status = 'flagged' WHERE message_id = ? AND attachment_id = ? AND status = 'active' RETURNING *`,
        [messageId, attachmentId],
      );
      if (row) flagged.push(toPhoto(row));
    }
    return flagged;
  }

  removeByMessage(messageId: string): Photo[] {
    return this.db.all<PhotoRow>('DELETE FROM photos WHERE message_id = ? RETURNING *', [messageId]).map(toPhoto);
  }
}

// -- swipes -----------------------------------------------------------------------

export type SwipeKind = 'like' | 'pass';

export interface SwipeRecord {
  actorId: string;
  targetId: string;
  kind: SwipeKind;
  note: string | null;
  createdAt: number;
}

export class SwipesRepo {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  record(actorId: string, targetId: string, kind: SwipeKind, note: string | null, now: number): void {
    this.db.run(
      `INSERT INTO swipes (actor_id, target_id, kind, note, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (actor_id, target_id) DO UPDATE SET kind = excluded.kind, note = excluded.note, created_at = excluded.created_at`,
      [actorId, targetId, kind, note, now],
    );
  }

  get(actorId: string, targetId: string): SwipeRecord | null {
    const row = this.db.get<{ actor_id: string; target_id: string; kind: SwipeKind; note: string | null; created_at: number }>(
      'SELECT * FROM swipes WHERE actor_id = ? AND target_id = ?',
      [actorId, targetId],
    );
    return row ? { actorId: row.actor_id, targetId: row.target_id, kind: row.kind, note: row.note, createdAt: row.created_at } : null;
  }

  likesGivenSince(actorId: string, since: number): number {
    return this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM swipes WHERE actor_id = ? AND kind = 'like' AND created_at > ?`, [actorId, since])!.n;
  }

  /** Oldest like inside the window (to tell users when a like frees up). */
  oldestLikeSince(actorId: string, since: number): number | null {
    return (
      this.db.get<{ t: number | null }>(`SELECT MIN(created_at) AS t FROM swipes WHERE actor_id = ? AND kind = 'like' AND created_at > ?`, [actorId, since])
        ?.t ?? null
    );
  }

  /** Which of `actorIds` have liked `targetId`. */
  likersAmong(targetId: string, actorIds: string[]): Set<string> {
    if (!actorIds.length) return new Set();
    const rows = this.db.all<{ actor_id: string }>(
      `SELECT actor_id FROM swipes WHERE target_id = ? AND kind = 'like' AND actor_id IN (${actorIds.map(() => '?').join(',')})`,
      [targetId, ...actorIds],
    );
    return new Set(rows.map((r) => r.actor_id));
  }

  likesGiven(userId: string): number {
    return this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM swipes WHERE actor_id = ? AND kind = 'like'`, [userId])!.n;
  }

  likesReceived(userId: string): number {
    return this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM swipes WHERE target_id = ? AND kind = 'like'`, [userId])!.n;
  }

  deleteAllBy(userId: string): void {
    this.db.run('DELETE FROM swipes WHERE actor_id = ? OR target_id = ?', [userId, userId]);
  }

  countLikesSince(since: number): number {
    return this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM swipes WHERE kind = 'like' AND created_at > ?`, [since])!.n;
  }
}

// -- matches -----------------------------------------------------------------------

export interface MatchRecord {
  id: number;
  userLow: string;
  userHigh: string;
  source: 'discover' | 'chat';
  createdAt: number;
  endedAt: number | null;
  endedBy: string | null;
}

interface MatchRow {
  id: number;
  user_low: string;
  user_high: string;
  source: 'discover' | 'chat';
  created_at: number;
  ended_at: number | null;
  ended_by: string | null;
}

const toMatch = (r: MatchRow): MatchRecord => ({
  id: r.id,
  userLow: r.user_low,
  userHigh: r.user_high,
  source: r.source,
  createdAt: r.created_at,
  endedAt: r.ended_at,
  endedBy: r.ended_by,
});

export function otherUser(match: MatchRecord, userId: string): string {
  return match.userLow === userId ? match.userHigh : match.userLow;
}

export class MatchesRepo {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  /** Creates the match, or re-activates an ended one. `created` is false if it was already active. */
  create(a: string, b: string, source: MatchRecord['source'], now: number): { match: MatchRecord; created: boolean } {
    const [low, high] = orderedPair(a, b);
    return this.db.transaction(() => {
      const existing = this.db.get<MatchRow>('SELECT * FROM matches WHERE user_low = ? AND user_high = ?', [low, high]);
      if (existing && existing.ended_at === null) return { match: toMatch(existing), created: false };
      if (existing) {
        const row = this.db.get<MatchRow>(
          'UPDATE matches SET ended_at = NULL, ended_by = NULL, created_at = ?, source = ? WHERE id = ? RETURNING *',
          [now, source, existing.id],
        )!;
        return { match: toMatch(row), created: true };
      }
      const row = this.db.get<MatchRow>(
        'INSERT INTO matches (user_low, user_high, source, created_at) VALUES (?, ?, ?, ?) RETURNING *',
        [low, high, source, now],
      )!;
      return { match: toMatch(row), created: true };
    });
  }

  get(id: number): MatchRecord | null {
    const row = this.db.get<MatchRow>('SELECT * FROM matches WHERE id = ?', [id]);
    return row ? toMatch(row) : null;
  }

  between(a: string, b: string): MatchRecord | null {
    const [low, high] = orderedPair(a, b);
    const row = this.db.get<MatchRow>('SELECT * FROM matches WHERE user_low = ? AND user_high = ?', [low, high]);
    return row ? toMatch(row) : null;
  }

  listActive(userId: string, offset: number, limit: number): MatchRecord[] {
    return this.db
      .all<MatchRow>(
        `SELECT * FROM matches WHERE (user_low = :u OR user_high = :u) AND ended_at IS NULL
         ORDER BY created_at DESC, id DESC LIMIT :limit OFFSET :offset`,
        { u: userId, limit, offset },
      )
      .map(toMatch);
  }

  countActive(userId: string): number {
    return this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM matches WHERE (user_low = :u OR user_high = :u) AND ended_at IS NULL`, { u: userId })!.n;
  }

  end(id: number, by: string, now: number): boolean {
    return this.db.run('UPDATE matches SET ended_at = ?, ended_by = ? WHERE id = ? AND ended_at IS NULL', [now, by, id]).changes > 0;
  }

  endBetween(a: string, b: string, by: string, now: number): boolean {
    const [low, high] = orderedPair(a, b);
    return this.db.run('UPDATE matches SET ended_at = ?, ended_by = ? WHERE user_low = ? AND user_high = ? AND ended_at IS NULL', [now, by, low, high]).changes > 0;
  }

  deleteAllFor(userId: string): void {
    this.db.run('DELETE FROM matches WHERE user_low = ? OR user_high = ?', [userId, userId]);
  }

  countSince(since: number): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM matches WHERE created_at > ?', [since])!.n;
  }

  countAll(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM matches WHERE ended_at IS NULL')!.n;
  }
}

// -- blocks -----------------------------------------------------------------------------

export interface BlockRecord {
  blockerId: string;
  blockedId: string;
  context: string | null;
  createdAt: number;
}

export class BlocksRepo {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  add(blockerId: string, blockedId: string, context: string, now: number): boolean {
    if (blockerId === blockedId) return false;
    return this.db.run('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, context, created_at) VALUES (?, ?, ?, ?)', [blockerId, blockedId, context, now]).changes > 0;
  }

  remove(blockerId: string, blockedId: string): boolean {
    return this.db.run('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?', [blockerId, blockedId]).changes > 0;
  }

  eitherWay(a: string, b: string): boolean {
    return Boolean(
      this.db.get('SELECT 1 AS x FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)', [a, b, b, a]),
    );
  }

  list(blockerId: string, offset: number, limit: number): BlockRecord[] {
    return this.db
      .all<{ blocker_id: string; blocked_id: string; context: string | null; created_at: number }>(
        'SELECT * FROM blocks WHERE blocker_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
        [blockerId, limit, offset],
      )
      .map((r) => ({ blockerId: r.blocker_id, blockedId: r.blocked_id, context: r.context, createdAt: r.created_at }));
  }

  count(blockerId: string): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM blocks WHERE blocker_id = ?', [blockerId])!.n;
  }

  /** Removes the user's own blocks (blocks against them stay, so they can't reappear). */
  deleteMadeBy(userId: string): void {
    this.db.run('DELETE FROM blocks WHERE blocker_id = ?', [userId]);
  }
}
