// Anonymous chat persistence: queue, sessions, relay map, feedback.
// Sessions live in the database, so a restart never drops a conversation.

import { fromJsonArray, toJson, type Database } from '../database.ts';

export type Side = 'a' | 'b';

export interface QueueEntry {
  userId: string;
  joinedAt: number;
  cardChannelId: string | null;
  cardMessageId: string | null;
}

export interface ChatSession {
  id: number;
  userA: string;
  userB: string;
  teen: boolean;
  startedAt: number;
  lastActivityAt: number;
  endedAt: number | null;
  endReason: string | null;
  endedBy: string | null;
  aMessages: number;
  bMessages: number;
  aReveal: boolean;
  bReveal: boolean;
  revealedAt: number | null;
  aCardId: string | null;
  bCardId: string | null;
  aCursor: string | null;
  bCursor: string | null;
}

interface SessionRow {
  id: number;
  user_a: string;
  user_b: string;
  teen: number;
  started_at: number;
  last_activity_at: number;
  ended_at: number | null;
  end_reason: string | null;
  ended_by: string | null;
  a_messages: number;
  b_messages: number;
  a_reveal: number;
  b_reveal: number;
  revealed_at: number | null;
  a_card_id: string | null;
  b_card_id: string | null;
  a_cursor: string | null;
  b_cursor: string | null;
}

const toSession = (r: SessionRow): ChatSession => ({
  id: r.id,
  userA: r.user_a,
  userB: r.user_b,
  teen: r.teen === 1,
  startedAt: r.started_at,
  lastActivityAt: r.last_activity_at,
  endedAt: r.ended_at,
  endReason: r.end_reason,
  endedBy: r.ended_by,
  aMessages: r.a_messages,
  bMessages: r.b_messages,
  aReveal: r.a_reveal === 1,
  bReveal: r.b_reveal === 1,
  revealedAt: r.revealed_at,
  aCardId: r.a_card_id,
  bCardId: r.b_card_id,
  aCursor: r.a_cursor,
  bCursor: r.b_cursor,
});

class NotQueuedError extends Error {}

export function sideOf(session: ChatSession, userId: string): Side | null {
  if (session.userA === userId) return 'a';
  if (session.userB === userId) return 'b';
  return null;
}

export function partnerOf(session: ChatSession, userId: string): string {
  return session.userA === userId ? session.userB : session.userA;
}

export interface RelayRecord {
  srcMessageId: string;
  sessionId: number;
  senderId: string;
  srcChannelId: string;
  dstChannelId: string;
  dstMessageIds: string[];
  contentHash: string | null;
  createdAt: number;
}

interface RelayRow {
  src_message_id: string;
  session_id: number;
  sender_id: string;
  src_channel_id: string;
  dst_channel_id: string;
  dst_message_ids: string;
  content_hash: string | null;
  created_at: number;
}

const toRelay = (r: RelayRow): RelayRecord => ({
  srcMessageId: r.src_message_id,
  sessionId: r.session_id,
  senderId: r.sender_id,
  srcChannelId: r.src_channel_id,
  dstChannelId: r.dst_channel_id,
  dstMessageIds: fromJsonArray(r.dst_message_ids),
  contentHash: r.content_hash,
  createdAt: r.created_at,
});

export class ChatRepo {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  // -- queue ----------------------------------------------------------------------

  /** Adds the user to the queue; false if already waiting. */
  enqueue(userId: string, now: number, joinedAt = now): boolean {
    return this.db.run('INSERT OR IGNORE INTO chat_queue (user_id, joined_at) VALUES (?, ?)', [userId, joinedAt]).changes > 0;
  }

  dequeue(userId: string): QueueEntry | null {
    const row = this.db.get<{ user_id: string; joined_at: number; card_channel_id: string | null; card_message_id: string | null }>(
      'DELETE FROM chat_queue WHERE user_id = ? RETURNING *',
      [userId],
    );
    return row ? { userId: row.user_id, joinedAt: row.joined_at, cardChannelId: row.card_channel_id, cardMessageId: row.card_message_id } : null;
  }

  queueEntry(userId: string): QueueEntry | null {
    const row = this.db.get<{ user_id: string; joined_at: number; card_channel_id: string | null; card_message_id: string | null }>(
      'SELECT * FROM chat_queue WHERE user_id = ?',
      [userId],
    );
    return row ? { userId: row.user_id, joinedAt: row.joined_at, cardChannelId: row.card_channel_id, cardMessageId: row.card_message_id } : null;
  }

  queue(): QueueEntry[] {
    return this.db
      .all<{ user_id: string; joined_at: number; card_channel_id: string | null; card_message_id: string | null }>('SELECT * FROM chat_queue ORDER BY joined_at')
      .map((row) => ({ userId: row.user_id, joinedAt: row.joined_at, cardChannelId: row.card_channel_id, cardMessageId: row.card_message_id }));
  }

  setQueueCard(userId: string, channelId: string, messageId: string): void {
    this.db.run('UPDATE chat_queue SET card_channel_id = ?, card_message_id = ? WHERE user_id = ?', [channelId, messageId, userId]);
  }

  queueSize(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_queue')!.n;
  }

  // -- sessions ---------------------------------------------------------------------

  /**
   * Atomically removes both users from the queue and opens a session.
   * Returns null if either is already in a session (the participants
   * primary key makes that impossible to violate).
   */
  createSession(userA: string, userB: string, teen: boolean, now: number): ChatSession | null {
    try {
      return this.db.transaction(() => {
        // Both must still be waiting (either may have cancelled meanwhile).
        const removed = this.db.run('DELETE FROM chat_queue WHERE user_id IN (?, ?)', [userA, userB]).changes;
        if (removed !== 2) throw new NotQueuedError();
        const row = this.db.get<SessionRow>(
          'INSERT INTO chat_sessions (user_a, user_b, teen, started_at, last_activity_at) VALUES (?, ?, ?, ?, ?) RETURNING *',
          [userA, userB, teen, now, now],
        )!;
        this.db.run('INSERT INTO chat_participants (user_id, session_id, side) VALUES (?, ?, ?), (?, ?, ?)', [userA, row.id, 'a', userB, row.id, 'b']);
        return toSession(row);
      });
    } catch (error) {
      if (error instanceof NotQueuedError) return null;
      if ((error as { errcode?: number }).errcode === 1555 || /UNIQUE|PRIMARY KEY/i.test(String((error as Error).message))) return null;
      throw error;
    }
  }

  activeFor(userId: string): ChatSession | null {
    const row = this.db.get<SessionRow>(
      'SELECT s.* FROM chat_participants p JOIN chat_sessions s ON s.id = p.session_id WHERE p.user_id = ?',
      [userId],
    );
    return row ? toSession(row) : null;
  }

  get(id: number): ChatSession | null {
    const row = this.db.get<SessionRow>('SELECT * FROM chat_sessions WHERE id = ?', [id]);
    return row ? toSession(row) : null;
  }

  /** Ends a live session exactly once; returns the ended session or null if it was not live. */
  end(id: number, reason: string, endedBy: string | null, now: number): ChatSession | null {
    return this.db.transaction(() => {
      const row = this.db.get<SessionRow>(
        'UPDATE chat_sessions SET ended_at = ?, end_reason = ?, ended_by = ? WHERE id = ? AND ended_at IS NULL RETURNING *',
        [now, reason, endedBy, id],
      );
      if (!row) return null;
      this.db.run('DELETE FROM chat_participants WHERE session_id = ?', [id]);
      return toSession(row);
    });
  }

  recordMessage(id: number, side: Side, now: number): void {
    const column = side === 'a' ? 'a_messages' : 'b_messages';
    this.db.run(`UPDATE chat_sessions SET ${column} = ${column} + 1, last_activity_at = ? WHERE id = ?`, [now, id]);
  }

  touch(id: number, now: number): void {
    this.db.run('UPDATE chat_sessions SET last_activity_at = ? WHERE id = ?', [now, id]);
  }

  setCard(id: number, side: Side, messageId: string): void {
    this.db.run(`UPDATE chat_sessions SET ${side === 'a' ? 'a_card_id' : 'b_card_id'} = ? WHERE id = ?`, [messageId, id]);
  }

  /** Advances the "last processed message" cursor (only forwards). */
  advanceCursor(id: number, side: Side, messageId: string): void {
    const column = side === 'a' ? 'a_cursor' : 'b_cursor';
    this.db.run(
      `UPDATE chat_sessions SET ${column} = ? WHERE id = ? AND (${column} IS NULL OR LENGTH(${column}) < LENGTH(?) OR (LENGTH(${column}) = LENGTH(?) AND ${column} < ?))`,
      [messageId, id, messageId, messageId, messageId],
    );
  }

  /** Records a reveal request; returns the updated session (null if not live). */
  requestReveal(id: number, side: Side): ChatSession | null {
    const row = this.db.get<SessionRow>(
      `UPDATE chat_sessions SET ${side === 'a' ? 'a_reveal' : 'b_reveal'} = 1 WHERE id = ? AND ended_at IS NULL RETURNING *`,
      [id],
    );
    return row ? toSession(row) : null;
  }

  /** Marks the identity reveal as done exactly once. */
  markRevealed(id: number, now: number): boolean {
    return this.db.run('UPDATE chat_sessions SET revealed_at = ? WHERE id = ? AND revealed_at IS NULL AND a_reveal = 1 AND b_reveal = 1', [now, id]).changes > 0;
  }

  idleSince(cutoff: number): ChatSession[] {
    return this.db.all<SessionRow>('SELECT * FROM chat_sessions WHERE ended_at IS NULL AND last_activity_at < ?', [cutoff]).map(toSession);
  }

  allActive(): ChatSession[] {
    return this.db.all<SessionRow>('SELECT * FROM chat_sessions WHERE ended_at IS NULL').map(toSession);
  }

  countActive(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_sessions WHERE ended_at IS NULL')!.n;
  }

  countStartedSince(since: number): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_sessions WHERE started_at > ?', [since])!.n;
  }

  /** People this user chatted with recently (to avoid instant re-pairing). */
  recentPartners(userId: string, since: number): Set<string> {
    const rows = this.db.all<{ partner: string }>(
      `SELECT CASE WHEN user_a = :u THEN user_b ELSE user_a END AS partner
       FROM chat_sessions WHERE (user_a = :u OR user_b = :u) AND started_at > :since`,
      { u: userId, since },
    );
    return new Set(rows.map((r) => r.partner));
  }

  countFor(userId: string): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_sessions WHERE user_a = :u OR user_b = :u', { u: userId })!.n;
  }

  // -- relay map --------------------------------------------------------------------

  addRelay(relay: Omit<RelayRecord, 'createdAt'>, now: number): void {
    this.db.transaction(() => {
      this.db.run(
        `INSERT OR REPLACE INTO chat_relays (src_message_id, session_id, sender_id, src_channel_id, dst_channel_id, dst_message_ids, content_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [relay.srcMessageId, relay.sessionId, relay.senderId, relay.srcChannelId, relay.dstChannelId, toJson(relay.dstMessageIds), relay.contentHash, now],
      );
      for (const dst of relay.dstMessageIds) {
        this.db.run('INSERT OR REPLACE INTO chat_relay_copies (dst_message_id, src_message_id) VALUES (?, ?)', [dst, relay.srcMessageId]);
      }
    });
  }

  relayBySource(srcMessageId: string): RelayRecord | null {
    const row = this.db.get<RelayRow>('SELECT * FROM chat_relays WHERE src_message_id = ?', [srcMessageId]);
    return row ? toRelay(row) : null;
  }

  relayByCopy(dstMessageId: string): RelayRecord | null {
    const row = this.db.get<RelayRow>(
      'SELECT r.* FROM chat_relay_copies c JOIN chat_relays r ON r.src_message_id = c.src_message_id WHERE c.dst_message_id = ?',
      [dstMessageId],
    );
    return row ? toRelay(row) : null;
  }

  updateRelay(srcMessageId: string, dstMessageIds: string[], contentHash: string | null): void {
    this.db.transaction(() => {
      this.db.run('UPDATE chat_relays SET dst_message_ids = ?, content_hash = ? WHERE src_message_id = ?', [toJson(dstMessageIds), contentHash, srcMessageId]);
      this.db.run('DELETE FROM chat_relay_copies WHERE src_message_id = ?', [srcMessageId]);
      for (const dst of dstMessageIds) {
        this.db.run('INSERT OR REPLACE INTO chat_relay_copies (dst_message_id, src_message_id) VALUES (?, ?)', [dst, srcMessageId]);
      }
    });
  }

  deleteRelay(srcMessageId: string): void {
    this.db.run('DELETE FROM chat_relays WHERE src_message_id = ?', [srcMessageId]);
  }

  /** Recent messages of a session (ids only) — used to collect report evidence. */
  relaysForSession(sessionId: number, limit: number): RelayRecord[] {
    return this.db
      .all<RelayRow>('SELECT * FROM chat_relays WHERE session_id = ? ORDER BY created_at DESC LIMIT ?', [sessionId, limit])
      .map(toRelay)
      .reverse();
  }

  pruneRelays(endedBefore: number): number {
    return this.db.run(
      'DELETE FROM chat_relays WHERE session_id IN (SELECT id FROM chat_sessions WHERE ended_at IS NOT NULL AND ended_at < ?)',
      [endedBefore],
    ).changes;
  }

  // -- feedback ---------------------------------------------------------------------

  addFeedback(sessionId: number, raterId: string, rateeId: string, rating: 1 | -1, now: number): boolean {
    return (
      this.db.run('INSERT OR IGNORE INTO chat_feedback (session_id, rater_id, ratee_id, rating, created_at) VALUES (?, ?, ?, ?, ?)', [
        sessionId,
        raterId,
        rateeId,
        rating,
        now,
      ]).changes > 0
    );
  }

  feedbackFor(userId: string): { up: number; down: number } {
    const row = this.db.get<{ up: number | null; down: number | null }>(
      'SELECT SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS up, SUM(CASE WHEN rating = -1 THEN 1 ELSE 0 END) AS down FROM chat_feedback WHERE ratee_id = ?',
      [userId],
    )!;
    return { up: row.up ?? 0, down: row.down ?? 0 };
  }
}
