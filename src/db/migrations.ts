// Versioned schema migrations. Never edit a migration that has shipped;
// add a new one instead.

import type { Database } from './database.ts';

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE users (
        id              TEXT PRIMARY KEY,
        username        TEXT NOT NULL DEFAULT '',
        global_name     TEXT,
        locale          TEXT,
        dm_channel_id   TEXT,
        dm_status       TEXT NOT NULL DEFAULT 'unknown' CHECK (dm_status IN ('unknown', 'ok', 'closed')),
        first_seen_at   INTEGER NOT NULL,
        last_seen_at    INTEGER NOT NULL,
        banned_until    INTEGER,
        ban_reason      TEXT,
        banned_by       TEXT,
        like_notice_at  INTEGER,
        chat_hint_at    INTEGER
      );

      CREATE TABLE profiles (
        user_id             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        stage               TEXT NOT NULL CHECK (stage IN ('basics', 'confirm', 'about', 'photos', 'review', 'complete')),
        visibility          TEXT NOT NULL DEFAULT 'visible' CHECK (visibility IN ('visible', 'paused', 'hidden')),
        name                TEXT NOT NULL DEFAULT '',
        birth_date          TEXT,
        gender              TEXT NOT NULL DEFAULT 'unspecified',
        bio                 TEXT NOT NULL DEFAULT '',
        location            TEXT NOT NULL DEFAULT '',
        languages           TEXT NOT NULL DEFAULT '[]',
        interests           TEXT NOT NULL DEFAULT '[]',
        looking_for         TEXT NOT NULL DEFAULT '[]',
        show_genders        TEXT NOT NULL DEFAULT '[]',
        age_min             INTEGER,
        age_max             INTEGER,
        same_language_only  INTEGER NOT NULL DEFAULT 0,
        like_alerts         INTEGER NOT NULL DEFAULT 1,
        chat_filter         INTEGER NOT NULL DEFAULT 1,
        guidelines_at       INTEGER,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        completed_at        INTEGER,
        last_active_at      INTEGER NOT NULL
      );
      CREATE INDEX profiles_discoverable ON profiles (stage, visibility, birth_date);

      -- Opaque, never-reused numbers that stand for a person in buttons, so
      -- Discord user ids never appear in a custom_id before people match.
      CREATE TABLE profile_refs (
        ref      INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id  TEXT NOT NULL UNIQUE
      );

      CREATE TABLE photos (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        position       INTEGER NOT NULL,
        channel_id     TEXT NOT NULL,
        message_id     TEXT NOT NULL,
        attachment_id  TEXT NOT NULL,
        filename       TEXT NOT NULL,
        content_type   TEXT,
        width          INTEGER,
        height         INTEGER,
        size           INTEGER NOT NULL DEFAULT 0,
        status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'flagged')),
        created_at     INTEGER NOT NULL
      );
      CREATE INDEX photos_by_user ON photos (user_id, position);
      CREATE INDEX photos_by_message ON photos (message_id);

      CREATE TABLE swipes (
        actor_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        target_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind        TEXT NOT NULL CHECK (kind IN ('like', 'pass')),
        note        TEXT,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (actor_id, target_id)
      );
      CREATE INDEX swipes_received ON swipes (target_id, kind, created_at);
      CREATE INDEX swipes_given ON swipes (actor_id, kind, created_at);

      CREATE TABLE matches (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_low    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_high   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source      TEXT NOT NULL CHECK (source IN ('discover', 'chat')),
        created_at  INTEGER NOT NULL,
        ended_at    INTEGER,
        ended_by    TEXT,
        UNIQUE (user_low, user_high)
      );
      CREATE INDEX matches_low ON matches (user_low, ended_at);
      CREATE INDEX matches_high ON matches (user_high, ended_at);

      CREATE TABLE blocks (
        blocker_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        blocked_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        context     TEXT,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (blocker_id, blocked_id)
      );
      CREATE INDEX blocks_blocked ON blocks (blocked_id);

      -- Reports outlive accounts on purpose (moderation history), so no FKs.
      CREATE TABLE reports (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        reporter_id     TEXT NOT NULL,
        target_id       TEXT NOT NULL,
        context         TEXT NOT NULL,
        reason          TEXT NOT NULL,
        details         TEXT NOT NULL DEFAULT '',
        evidence        TEXT,
        status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
        mod_channel_id  TEXT,
        mod_message_id  TEXT,
        resolved_by     TEXT,
        resolved_at     INTEGER,
        resolution      TEXT,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX reports_by_target ON reports (target_id, status, created_at);
      CREATE INDEX reports_by_reporter ON reports (reporter_id, created_at);

      CREATE TABLE mod_actions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        moderator_id  TEXT NOT NULL,
        target_id     TEXT NOT NULL,
        action        TEXT NOT NULL,
        reason        TEXT,
        report_id     INTEGER,
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX mod_actions_by_target ON mod_actions (target_id, created_at);

      -- Anonymous chat --------------------------------------------------------
      CREATE TABLE chat_queue (
        user_id          TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        joined_at        INTEGER NOT NULL,
        card_channel_id  TEXT,
        card_message_id  TEXT
      );

      CREATE TABLE chat_sessions (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        user_a            TEXT NOT NULL,
        user_b            TEXT NOT NULL,
        teen              INTEGER NOT NULL DEFAULT 0,
        started_at        INTEGER NOT NULL,
        last_activity_at  INTEGER NOT NULL,
        ended_at          INTEGER,
        end_reason        TEXT,
        ended_by          TEXT,
        a_messages        INTEGER NOT NULL DEFAULT 0,
        b_messages        INTEGER NOT NULL DEFAULT 0,
        a_reveal          INTEGER NOT NULL DEFAULT 0,
        b_reveal          INTEGER NOT NULL DEFAULT 0,
        revealed_at       INTEGER,
        a_card_id         TEXT,
        b_card_id         TEXT,
        a_cursor          TEXT,
        b_cursor          TEXT
      );
      CREATE INDEX chat_sessions_open ON chat_sessions (ended_at, last_activity_at);
      CREATE INDEX chat_sessions_a ON chat_sessions (user_a, started_at);
      CREATE INDEX chat_sessions_b ON chat_sessions (user_b, started_at);

      -- One row per user in a live session: the primary key makes it
      -- impossible for anyone to be in two chats at once.
      CREATE TABLE chat_participants (
        user_id     TEXT PRIMARY KEY,
        session_id  INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        side        TEXT NOT NULL CHECK (side IN ('a', 'b'))
      );

      -- Maps each relayed message to its copy, for replies, edits, deletes
      -- and reactions. Pruned shortly after a session ends.
      CREATE TABLE chat_relays (
        src_message_id   TEXT PRIMARY KEY,
        session_id       INTEGER NOT NULL,
        sender_id        TEXT NOT NULL,
        src_channel_id   TEXT NOT NULL,
        dst_channel_id   TEXT NOT NULL,
        dst_message_ids  TEXT NOT NULL,
        content_hash     TEXT,
        created_at       INTEGER NOT NULL
      );
      CREATE INDEX chat_relays_session ON chat_relays (session_id);
      CREATE TABLE chat_relay_copies (
        dst_message_id  TEXT PRIMARY KEY,
        src_message_id  TEXT NOT NULL REFERENCES chat_relays(src_message_id) ON DELETE CASCADE
      );
      CREATE INDEX chat_relay_copies_src ON chat_relay_copies (src_message_id);

      CREATE TABLE chat_feedback (
        session_id  INTEGER NOT NULL,
        rater_id    TEXT NOT NULL,
        ratee_id    TEXT NOT NULL,
        rating      INTEGER NOT NULL CHECK (rating IN (-1, 1)),
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (session_id, rater_id)
      );
      CREATE INDEX chat_feedback_ratee ON chat_feedback (ratee_id);

      -- Durable outbox for notifications and other side effects -------------
      CREATE TABLE jobs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        type          TEXT NOT NULL,
        payload       TEXT NOT NULL,
        run_at        INTEGER NOT NULL,
        attempts      INTEGER NOT NULL DEFAULT 0,
        max_attempts  INTEGER NOT NULL DEFAULT 6,
        status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dead')),
        locked_until  INTEGER,
        last_error    TEXT,
        dedupe_key    TEXT UNIQUE,
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX jobs_due ON jobs (status, run_at);

      CREATE TABLE kv (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        updated_at  INTEGER NOT NULL
      );
    `,
  },
];

export function migrate(db: Database, now = Date.now()): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
  const applied = new Set(db.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version));
  const ran: number[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [migration.version, migration.name, now]);
    });
    ran.push(migration.version);
  }
  return ran;
}

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
