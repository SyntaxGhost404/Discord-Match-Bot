// Persistence for the anonymous-chat remake.
//
// JSON file (DATA_DIR/db.json) with atomic writes (tmp + rename) and a
// debounced saver. No database dependency; fine for a single-process bot.
//
// Persisted shape:
// {
//   profiles: { [discordId]: { id, is_onboarded, anonymous_id, name, dob,
//                              location, bio, media, interests,
//                              createdAt, updatedAt } },
//   ...
// }
// dob is an ISO date string ("YYYY-MM-DD"). Ages are NEVER stored; every age
// read derives on the fly via getUserAge() (see src/utils/dob.js), so
// birthdays update tiers and matching pools automatically.
// media is an array of { file, name, type, size }; `file` is the stored
// filename under paths.mediaDir/<userId>/ and the bytes are re-attached to
// every profile card render (never hotlinked from expiring CDN URLs).
//   bans:     { [discordId]: { reason, at } },
//   blocks:   { [userId]: { [blockedId]: { at, anonId } } },
//   reports:  [ { id, reporterId, targetId, reason, description, history, at, status } ],
//   shares:   { ["<sessionId>:<userId>"]: { count, last_share } },
//   dms:      { [userId]: dmChannelId },
//   onboard_drafts: { [discordId]: { step, data } },
//   reputation: { [userId]: { likes, dislikes } },   // lifetime community ratings
//   ratedSessions: { [sessionId]: { u1, u2, rated: [raterIds], at } },
// }
//
// `reputation` accumulates every like/dislike a user receives. `ratedSessions`
// remembers concluded pairs (capped) so post-chat ratings resolve the partner
// and enforce one rating per user per session, even across restarts.
//
// `onboard_drafts` holds the in-progress multi-step onboarding wizard so a
// user can abandon it halfway and resume later (even across restarts).
// step: 1 = name/dob modal pending, 2 = location/bio modal pending,
//       3 = media step pending, 4 = preview pending confirmation.
//
// Chat sessions are deliberately IN-MEMORY (ephemeral): a restart drops live
// chats and the queue, exactly like the reference implementation.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from '../config.js';
import { logger, nowIso } from '../util.js';
import { ageFromDOB } from '../utils/dob.js';

// Cheap bounds for maps that grow without a natural cap (cycle-2 load
// hunt): the DM channel cache, abandoned onboarding drafts, and per-user
// block lists. Enforced by pruneCaches() on every save() and on load().
const DMS_CACHE_CAP = 1000; // dm channel cache: insertion-ordered, oldest evicted first
const BLOCKS_PER_USER_CAP = 200; // per-user block entries, oldest-first by block timestamp
const DRAFT_TTL_MS = 7 * 24 * 3600 * 1000; // onboarding drafts untouched for 7 days expire

const EMPTY = () => ({
  profiles: {},
  bans: {},
  blocks: {},
  reports: [],
  shares: {},
  dms: {},
  onboard_drafts: {},
  recentPartners: {},
  reputation: {},
  ratedSessions: {},
});

class Database {
  constructor() {
    this.db = EMPTY();
    this.sessions = new Map(); // sessionId -> { session_id, user1_id, user2_id, started_at, stats, lastActivityAt, shareRequest }
    this._saveTimer = null;
    this._saving = false;
    this._dirty = false;
  }

  load() {
    fs.mkdirSync(paths.dataDir, { recursive: true });
    if (fs.existsSync(paths.dbFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(paths.dbFile, 'utf8'));
        // Per-key type guards: each key must match its EMPTY() default's
        // type (plain object, except `reports` which must be an array).
        // A wrong-typed key (e.g. {"profiles":"oops"}, {"reports":null})
        // falls back to its default instead of crashing later or silently
        // poisoning the whole database; missing keys keep defaults too.
        const fresh = EMPTY();
        const merged = { ...fresh };
        for (const key of Object.keys(fresh)) {
          const v = parsed?.[key];
          if (v === undefined) continue;
          const wantArray = Array.isArray(fresh[key]);
          const typeOk = wantArray
            ? Array.isArray(v)
            : (v !== null && typeof v === 'object' && !Array.isArray(v));
          if (typeOk) {
            merged[key] = v;
          } else {
            logger.warn(`db.json: ignoring "${key}" (wrong type), using default`);
          }
        }
        this.db = merged;
        // Nested-record hardening (cycle-2): the per-key guard above only
        // checks the top-level type, so a null/wrong-typed ENTRY inside an
        // id-keyed map survives load. A null ratedSessions/shares entry
        // crashes the cap-eviction comparators at exactly the 501st insert
        // (before save()), permanently breaking the cap; drop them here.
        // (blocks entries are filtered at read time instead, so /blocklist
        // never bricks on one bad entry.)
        let purgedCorrupt = false;
        for (const key of ['ratedSessions', 'shares']) {
          const m = merged[key];
          for (const k of Object.keys(m)) {
            const v = m[k];
            if (v === null || typeof v !== 'object' || Array.isArray(v)) {
              logger.warn(`db.json: dropping corrupt "${key}.${k}" entry, using default`);
              delete m[k];
              purgedCorrupt = true;
            }
          }
        }
        if (purgedCorrupt) {
          // Persist the purge now: without this, the file stays corrupt
          // until the next dirty save, and a crash before that re-triggers
          // the warn on the next boot.
          this.save();
        }
        this.pruneCaches();
        logger.info(`Loaded database (${Object.keys(this.db.profiles).length} profiles, ${this.db.reports.length} reports)`);
      } catch (err) {
        logger.error('Failed to parse db.json, starting empty. Error:', err.message);
        const bak = paths.dbFile + '.corrupt-' + Date.now();
        try { fs.copyFileSync(paths.dbFile, bak); logger.warn('Corrupt db backed up to', bak); } catch {}
        this.db = EMPTY();
      }
    } else {
      logger.info('No db.json found, starting with an empty database.');
    }
  }

  /** Debounced save (coalesces rapid writes); call flush() on shutdown. */
  save() {
    this.pruneCaches();
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._writeNow().catch((e) => logger.error('save failed:', e.message));
    }, 250);
  }

  /**
   * Enforce the cheap growth bounds on uncapped maps: the DM channel
   * cache (hard cap, oldest-first), abandoned onboarding drafts (7-day
   * idle expiry), and per-user block lists (200 per user, oldest-first).
   * Runs synchronously on every save() and once on load(), so legacy
   * over-cap data is trimmed without changing save/load semantics.
   */
  pruneCaches() {
    // (a) dms: hard cap, oldest-first (plain-object keys keep insertion order).
    const dmKeys = Object.keys(this.db.dms);
    if (dmKeys.length > DMS_CACHE_CAP) {
      for (const k of dmKeys.slice(0, dmKeys.length - DMS_CACHE_CAP)) delete this.db.dms[k];
    }
    // (b) onboard_drafts: drop drafts untouched for 7 days. Drafts with no
    // touch timestamp predate the bound and are kept (fail-safe).
    const now = Date.now();
    for (const [k, d] of Object.entries(this.db.onboard_drafts)) {
      if (d && typeof d.touchedAt === 'number' && now - d.touchedAt > DRAFT_TTL_MS) {
        delete this.db.onboard_drafts[k];
      }
    }
    // (c) blocks: per-user cap, oldest-first by block timestamp. ISO `at`
    // strings sort chronologically; epoch-ms numbers are normalized to ISO
    // first (a raw String() of "17899…" would sort before all ISO strings
    // and evict the NEWEST entry). Missing `at` sorts as "" and is evicted
    // first (fail-safe). The stable sort keeps insertion order on ties.
    for (const mine of Object.values(this.db.blocks)) {
      if (!mine || typeof mine !== 'object') continue;
      const ids = Object.keys(mine);
      if (ids.length > BLOCKS_PER_USER_CAP) {
        const at = (id) => {
          const v = mine[id]?.at;
          return typeof v === 'number' ? new Date(v).toISOString() : String(v || '');
        };
        ids.sort((x, y) => (at(x) < at(y) ? -1 : at(x) > at(y) ? 1 : 0));
        for (const drop of ids.slice(0, ids.length - BLOCKS_PER_USER_CAP)) delete mine[drop];
      }
    }
  }

  async flush() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    if (this._dirty || this._saving) await this._writeNow().catch((e) => logger.error('flush failed:', e.message));
  }

  async _writeNow() {
    if (this._saving) { this._dirty = true; return; }
    this._saving = true;
    try {
      const tmp = paths.dbFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2));
      fs.renameSync(tmp, paths.dbFile);
      this._dirty = false;
    } finally {
      this._saving = false;
      if (this._dirty) {
        this._dirty = false;
        const tmp = paths.dbFile + '.tmp';
        try {
          fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2));
          fs.renameSync(tmp, paths.dbFile);
        } catch (e) { logger.error('save retry failed:', e.message); }
      }
    }
  }

  // ------------------------------------------------------------------
  // profiles
  // ------------------------------------------------------------------

  /**
   * Fetch a user's profile, or null when they have never onboarded.
   * Profiles are created exactly once, by the mandatory onboarding flow
   * (src/flows/onboarding.js), which the router runs before any other
   * interaction. Nothing here auto-creates records.
   */
  getUserProfile(id) {
    const p = this.db.profiles[String(id)];
    // Plain-object guard (cycle-2): a corrupt wrong-typed profile (e.g. a
    // string) must read as "never onboarded", never as a truthy record the
    // lifetime accessors then crash on or updateUserProfile spreads into
    // garbage like {"0":"x",...}.
    return (p !== null && typeof p === 'object' && !Array.isArray(p)) ? p : null;
  }

  /**
   * Create the profile record that marks onboarding complete.
   * Called once per user, from the onboarding wizard's confirm step.
   * Stores the ISO date of birth; the age is always derived on the fly.
   */
  createProfile({
    id, name, dob, location = '', bio = '', interests = [], media = [],
  }) {
    id = String(id);
    const profile = {
      id,
      is_onboarded: true,
      anonymous_id: this.getAnonId(id),
      name: String(name).slice(0, 30),
      dob,
      location: String(location || '').slice(0, 60),
      bio: String(bio || '').slice(0, 500),
      media: Array.isArray(media) ? media.slice(0, 6) : [],
      interests: interests.slice(0, 10),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.db.profiles[id] = profile;
    this.save();
    return profile;
  }

  /**
   * Live-computed age in whole years from the stored date of birth, or null
   * when unknown. Nothing here ever persists an age; birthdays take effect
   * the moment they happen.
   */
  getUserAge(id, now = new Date()) {
    const p = this.getUserProfile(id);
    return p && p.dob ? ageFromDOB(p.dob, now) : null;
  }

  updateUserProfile(profile) {
    const id = String(profile.id);
    const prev = this.getUserProfile(id); // null-safe: corrupt records read as absent
    this.db.profiles[id] = {
      ...(prev || {}),
      ...profile,
      id,
      updatedAt: nowIso(),
      createdAt: prev?.createdAt || nowIso(),
    };
    this.save();
    return this.db.profiles[id];
  }

  // ------------------------------------------------------------------
  // lifetime chat metrics (persisted on the profile, shown by /stats)
  // ------------------------------------------------------------------

  /** Blank lifetime counters for a profile that has never chatted. */
  static blankLifetime() {
    return {
      messages: 0,      // text messages sent
      attachments: 0,   // files, voice notes and clips sent (all audio counts here)
      chatMs: 0,        // total milliseconds spent in active chats
      chats: 0,         // chats joined
      longestChatMs: 0, // longest single chat
      shares: 0,        // mutual identity shares completed
    };
  }

  /** The profile's lifetime counters, initializing them when absent. */
  ensureLifetime(profile) {
    if (!profile.lifetime) profile.lifetime = Database.blankLifetime();
    return profile.lifetime;
  }

  /** Lifetime counters for a user, or null when they never onboarded. */
  getLifetimeStats(id) {
    const p = this.getUserProfile(id);
    return p ? this.ensureLifetime(p) : null;
  }

  /**
   * Fold one finished chat into both participants' lifetime counters.
   * Called once per user from concludeSession, so every ending trigger
   * (manual end, timeout, moderation, block) counts the same way.
   */
  recordChatLifetime(userId, { messages = 0, attachments = 0, durationMs = 0 }) {
    const p = this.getUserProfile(userId);
    if (!p) return;
    const l = this.ensureLifetime(p);
    l.messages += messages;
    l.attachments += attachments;
    l.chatMs += Math.max(0, durationMs);
    l.chats += 1;
    if (durationMs > l.longestChatMs) l.longestChatMs = durationMs;
    p.updatedAt = nowIso();
    this.save();
  }

  /** Count one completed mutual identity share for a user. */
  recordShareLifetime(userId) {
    const p = this.getUserProfile(userId);
    if (!p) return;
    this.ensureLifetime(p).shares += 1;
    p.updatedAt = nowIso();
    this.save();
  }

  // ------------------------------------------------------------------
  // onboarding drafts (the multi-step wizard's in-progress state)
  // ------------------------------------------------------------------

  /** The user's in-progress wizard state, or null when none (or expired). */
  getOnboardDraft(id) {
    id = String(id);
    const d = this.db.onboard_drafts[id];
    if (!d) return null;
    // Lazy expiry: drafts untouched for 7 days are dropped on read, so an
    // abandoned draft can never resurrect a stale wizard.
    if (typeof d.touchedAt === 'number' && Date.now() - d.touchedAt > DRAFT_TTL_MS) {
      delete this.db.onboard_drafts[id];
      this.save();
      return null;
    }
    return d;
  }

  /** Persist wizard progress: { step, data }. Stamps the touch time for expiry. */
  saveOnboardDraft(id, draft) {
    const rec = { ...(draft || {}), touchedAt: Date.now() };
    this.db.onboard_drafts[String(id)] = rec;
    this.save();
    return rec;
  }

  /** Drop the wizard state (on completion, restart, or validation reset). */
  clearOnboardDraft(id) {
    delete this.db.onboard_drafts[String(id)];
    this.save();
  }

  // ------------------------------------------------------------------
  // bans
  // ------------------------------------------------------------------

  isBanned(id) { return !!this.db.bans[String(id)]; }

  banUser(id, reason) {
    id = String(id);
    if (id === '__proto__') return; // prototype-pollution guard (cycle-2)
    this.db.bans[id] = { reason: reason || 'Banned by admin.', at: nowIso() };
    // A banned-while-queued user must leave the matchmaking queue at once:
    // otherwise they linger in other waiters' eligible-pool counts until a
    // match attempt pairs and drops them. The queue lives in the
    // matchmaking service (this file cannot import it — circular), which
    // registers its evictor via setQueueEvictor().
    if (typeof this._queueEvictor === 'function') {
      try { this._queueEvictor(id); }
      catch (err) { logger.error('ban queue evict failed:', err.message); }
    }
    this.save();
  }

  /**
   * Registered by the matchmaking service so banUser can evict a banned
   * user from its queue without a circular import.
   */
  setQueueEvictor(fn) { this._queueEvictor = typeof fn === 'function' ? fn : null; }

  unbanUser(id) {
    delete this.db.bans[String(id)];
    this.save();
  }

  // ------------------------------------------------------------------
  // chat sessions (in-memory)
  // ------------------------------------------------------------------

  createChatSession(user1Id, user2Id) {
    const session = {
      session_id: `s_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      user1_id: String(user1Id),
      user2_id: String(user2Id),
      started_at: Date.now(),
      // Session metrics for the end-of-chat summary: texts/attachments
      // actually exchanged, and the last relayed-message timestamp the
      // idle-timeout sweep reads. The duration clock runs from started_at
      // (the exact pairing millisecond) to the end millisecond.
      stats: { text: 0, attachments: 0 },
      lastActivityAt: Date.now(),
      // Mutual identity-share handshake: { from, at } while a request is
      // pending the partner's accept/decline, otherwise null.
      shareRequest: null,
    };
    this.sessions.set(session.session_id, session);
    return session;
  }

  getActiveSessionForUser(userId) {
    const uid = String(userId);
    for (const s of this.sessions.values()) {
      if (s.user1_id === uid || s.user2_id === uid) return s;
    }
    return null;
  }

  getActiveSessions() {
    return [...this.sessions.values()];
  }

  endChatSession(sessionId) {
    return this.sessions.delete(String(sessionId));
  }

  // ------------------------------------------------------------------
  // blocks (anonymous ids)
  // ------------------------------------------------------------------

  /**
   * Stable anonymous id for a user (used for block lists, never the real id).
   * Deterministic so it survives restarts.
   */
  getAnonId(id) {
    return crypto.createHash('sha256').update(`anon:${id}`).digest('hex').slice(0, 16);
  }

  /** First 8 chars plus ellipsis: how blocked users appear in lists. */
  maskAnonId(anonId) {
    return `${String(anonId).slice(0, 8)}...`;
  }

  /**
   * Record a block. Entries carry the block timestamp, the target's stable
   * anonymous id (the only identifier the blocker ever sees), and where the
   * block happened ('chat' for a live /block, 'recent' for a post-chat one)
   * so entries stay identifiable without exposing any real identity.
   */
  blockUser(by, target, meta = {}) {
    by = String(by); target = String(target);
    // __proto__ as either key would retarget/pollute the blocks map's
    // prototype instead of creating an entry (unreachable via numeric
    // Discord snowflakes, but cheap to close).
    if (by === '__proto__' || target === '__proto__') return;
    // A wrong-typed truthy block map (e.g. the string "x" from a corrupt
    // db) passes a bare falsy guard and then crashes on property
    // assignment; reset it to a fresh map instead.
    if (!this.db.blocks[by] || typeof this.db.blocks[by] !== 'object') this.db.blocks[by] = {};
    this.db.blocks[by][target] = {
      at: nowIso(),
      anonId: this.getAnonId(target),
      source: meta.source === 'recent' ? 'recent' : 'chat',
    };
    this.save();
  }

  /**
   * Remove a block by full discord id, full anonymous id, or the masked
   * 8-char prefix shown in /blocklist. Returns true when something was
   * removed, false when nothing matched, and the string 'ambiguous' when a
   * short prefix matches 2+ strangers (caller should ask for more
   * characters instead of unblocking the wrong person).
   */
  removeBlock(userId, anonymousId) {
    const mine = this.db.blocks[String(userId)] || {};
    // anonIds are lowercase hex; lowercase the selector so uppercase input
    // still matches instead of silently matching nothing.
    const sel = String(anonymousId).replace(/\./g, '').trim().toLowerCase();
    // A dots-only/blank selector normalizes to "": "".startsWith matches
    // every entry, so reject it before matching rather than unblocking the
    // wrong (oldest) stranger with a success card.
    if (!sel) return false;
    // Exact matches (full discord id or full anon id) win outright.
    for (const [id, entry] of Object.entries(mine)) {
      if (!entry || typeof entry !== 'object') continue;
      const anon = String(entry.anonId || '').toLowerCase();
      if (id === sel || anon === sel) {
        delete mine[id];
        this.save();
        return true;
      }
    }
    // Prefix matches: unique prefix unblocks, ambiguous prefix refuses.
    const prefixHits = [];
    for (const [id, entry] of Object.entries(mine)) {
      if (!entry || typeof entry !== 'object') continue;
      const anon = String(entry.anonId || '').toLowerCase();
      if (anon.startsWith(sel)) prefixHits.push(id);
    }
    if (prefixHits.length === 1) {
      delete mine[prefixHits[0]];
      this.save();
      return true;
    }
    if (prefixHits.length > 1) return 'ambiguous';
    return false;
  }

  // ------------------------------------------------------------------
  // reputation (community honor system)
  // ------------------------------------------------------------------

  /**
   * Lifetime community feedback for a user: { likes, dislikes, total,
   * score }. score is the 5.00-scale star rating (like share of all votes
   * times 5), or null when nobody has rated them yet.
   */
  getReputation(userId) {
    const r = this.db.reputation?.[String(userId)] || { likes: 0, dislikes: 0 };
    const likes = r.likes || 0;
    const dislikes = r.dislikes || 0;
    const total = likes + dislikes;
    return { likes, dislikes, total, score: total ? (likes / total) * 5 : null };
  }

  /**
   * Remember a concluded session's pair so post-chat ratings can resolve
   * the partner and enforce one rating per user per session. Kept capped
   * (most recent 500) so the file never grows unbounded. Merges with an
   * existing record instead of overwriting: a duplicate conclusion must
   * never wipe the one-rating guard (`rated`) or the original timestamp.
   */
  noteSessionConcluded(session) {
    if (!this.db.ratedSessions) this.db.ratedSessions = {};
    const id = session.session_id;
    const prev = this.db.ratedSessions[id];
    this.db.ratedSessions[id] = {
      u1: String(session.user1_id),
      u2: String(session.user2_id),
      rated: prev && Array.isArray(prev.rated) ? prev.rated : [],
      at: prev && prev.at != null ? prev.at : Date.now(),
    };
    const ids = Object.keys(this.db.ratedSessions);
    if (ids.length > 500) {
      // Optional chaining: a null entry that slipped in after load must not
      // crash the sweep (which would fire before save() and permanently
      // break the cap).
      ids.sort((a, b) => (this.db.ratedSessions[a]?.at || 0) - (this.db.ratedSessions[b]?.at || 0));
      for (const drop of ids.slice(0, ids.length - 500)) delete this.db.ratedSessions[drop];
    }
    this.save();
  }

  /**
   * Record one like/dislike from raterId for their partner in a concluded
   * session. Exactly one rating per user per session. Returns
   * { ok, partnerId, likes, dislikes, total } or { ok: false, reason }.
   */
  ratePartner(sessionId, raterId, kind) {
    const rec = this.db.ratedSessions?.[String(sessionId)];
    if (!rec) return { ok: false, reason: 'unknown_session' };
    const rater = String(raterId);
    if (rater !== rec.u1 && rater !== rec.u2) return { ok: false, reason: 'not_a_participant' };
    // A corrupt record may be missing `rated` or carry a wrong-typed one;
    // coerce to a real array (and persist it so the one-rating guard holds).
    const rated = Array.isArray(rec.rated) ? rec.rated : [];
    rec.rated = rated;
    if (rated.includes(rater)) return { ok: false, reason: 'already_rated' };
    if (kind !== 'like' && kind !== 'dislike') return { ok: false, reason: 'bad_kind' };
    const partnerId = rater === rec.u1 ? rec.u2 : rec.u1;
    if (!this.db.reputation) this.db.reputation = {};
    // A corrupt reputation entry (wrong type, or non-numeric counters that
    // would string-concat into "51") resets to a blank record instead of
    // crashing or persisting garbage.
    let rep = this.db.reputation[partnerId];
    if (!rep || typeof rep !== 'object' || Array.isArray(rep) ||
        typeof rep.likes !== 'number' || typeof rep.dislikes !== 'number') {
      rep = { likes: 0, dislikes: 0 };
    }
    if (kind === 'like') rep.likes = (rep.likes || 0) + 1;
    else rep.dislikes = (rep.dislikes || 0) + 1;
    this.db.reputation[partnerId] = rep;
    rated.push(rater);
    this.save();
    return { ok: true, partnerId, likes: rep.likes, dislikes: rep.dislikes, total: rep.likes + rep.dislikes };
  }

  /**
   * Blocked users of `userId` as entry objects, newest first:
   * [{ anonId, at, source }]. This is what /blocklist renders.
   */
  getBlockEntries(userId) {
    const mine = this.db.blocks[String(userId)] || {};
    return Object.entries(mine)
      // A corrupt null/wrong-typed entry must not brick /blocklist for the
      // whole user; skip it instead of crashing in sort/map.
      .filter(([, entry]) => entry !== null && typeof entry === 'object' && !Array.isArray(entry))
      .sort((a, b) => (a[1].at < b[1].at ? 1 : -1))
      .map(([, entry]) => ({
        anonId: entry.anonId,
        at: entry.at,
        source: entry.source || 'chat',
      }));
  }

  /**
   * Blocked users of `userId` as an array of anonymous-id STRINGS,
   * newest first (this is what the reference blocklist.js iterates).
   */
  getBlockedUsers(userId) {
    return this.getBlockEntries(userId).map((e) => e.anonId);
  }

  isBlockedBetween(a, b) {
    a = String(a); b = String(b);
    return !!(this.db.blocks[a]?.[b] || this.db.blocks[b]?.[a]);
  }

  // ------------------------------------------------------------------
  // recent partners (lets /block reach the last chat after it ended)
  // ------------------------------------------------------------------

  /** Ring of the user's most recent chat partners, newest first, cap 5. */
  pushRecentPartner(userId, partnerId) {
    const uid = String(userId); const pid = String(partnerId);
    if (uid === pid) return;
    // A corrupt wrong-typed ring (e.g. a string, which would unshift-crash
    // or spread into per-character pseudo-users) resets to a fresh array.
    let list = this.db.recentPartners[uid];
    if (!Array.isArray(list)) {
      list = [];
      this.db.recentPartners[uid] = list;
    }
    const i = list.indexOf(pid);
    if (i >= 0) list.splice(i, 1);
    list.unshift(pid);
    while (list.length > 5) list.pop();
    this.save();
  }

  /** Newest-first partner ids, most recent chat first. */
  getRecentPartners(userId) {
    const list = this.db.recentPartners[String(userId)];
    return Array.isArray(list) ? [...list] : [];
  }

  // ------------------------------------------------------------------
  // username shares
  // ------------------------------------------------------------------

  /** { count, last_share } (ms epoch) for a user inside a session. */
  getShareData(sessionId, userId) {
    const rec = this.db.shares[`${sessionId}:${userId}`];
    return rec ? { count: rec.count, last_share: rec.last_share } : { count: 0, last_share: 0 };
  }

  recordUsernameShare(sessionId, userId) {
    const key = `${sessionId}:${userId}`;
    const rec = this.db.shares[key] || { count: 0, last_share: 0 };
    rec.count += 1;
    rec.last_share = Date.now();
    this.db.shares[key] = rec;
    // Cap at 500 entries, evicting the least-recently-shared first
    // (same pattern as ratedSessions).
    const ids = Object.keys(this.db.shares);
    if (ids.length > 500) {
      // Optional chaining, same rationale as the ratedSessions sweep above.
      const byRecency = (a, b) => (this.db.shares[a]?.last_share || 0) - (this.db.shares[b]?.last_share || 0);
      // Never evict a `:swaps` key that belongs to a currently-active
      // session: losing it silently resets that session's completed-swap
      // count to 0 (getSessionSwapCount falls back to 0), letting the
      // 2-swap cap be exceeded. Sessions are in-memory on this Database
      // instance, so no import cycle is involved.
      const isLiveSwapKey = (k) => k.endsWith(':swaps') && this.sessions.has(k.slice(0, -':swaps'.length));
      const evictable = ids.filter((k) => !isLiveSwapKey(k));
      const over = ids.length - 500;
      const victims = evictable.sort(byRecency).slice(0, over);
      if (victims.length < over) {
        // Defensive: if live :swaps keys alone exceed the cap (shouldn't
        // happen), evict the oldest of them too so the cap still holds.
        victims.push(...ids.filter(isLiveSwapKey).sort(byRecency).slice(0, over - victims.length));
      }
      for (const drop of victims) delete this.db.shares[drop];
    }
    this.save();
  }

  // ------------------------------------------------------------------
  // reports
  // ------------------------------------------------------------------

  addReport(report) {
    this.db.reports.push(report);
    // Cap at 200 reports, evicting the oldest first (reports carry ISO
    // `at` timestamps, which sort chronologically as strings).
    if (this.db.reports.length > 200) {
      const at = (r) => (r && r.at != null ? String(r.at) : '');
      this.db.reports.sort((a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0));
      this.db.reports.splice(0, this.db.reports.length - 200);
    }
    this.save();
    return report;
  }

  /** Test helper: wipe everything (in-memory + persisted). */
  _resetForTests() {
    this.db = EMPTY();
    this.sessions.clear();
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    this._dirty = false;
    this._saving = false;
    try { fs.rmSync(paths.dbFile, { force: true }); } catch {}
  }
}

export const db = new Database();
