// Chat service: anonymous chat sessions, DM delivery, and the DM relay.
// Mirrors the reference services/chat.js surface, rebuilt on raw REST.
//
//  - startChatSession(u1, u2, a1, a2): create the session, DM BOTH strangers
//    the matched Components-V2 card.
//  - concludeSession(session, trigger, actorId, opts): end the session and
//    DM BOTH strangers their persistent, role-aware session summary card
//    (manual end, safety moderation, idle timeout, block, banned partner).
//  - sweepIdleSessions(): wrap up sessions quiet for 30 minutes.
//  - handleDirectMessage(msg): gateway MESSAGE_CREATE relay.

import fs from 'node:fs';
import path from 'node:path';
import { db } from './database.js';
import { matchmaking } from './matchmaking.js';
import { safety } from './safety.js';
import * as profanity from './profanity.js';
import { paths } from '../config.js';
import { Rest, DiscordAPIError, V2, Interactions } from '../discord/rest.js';
import {
  deferUpdate, followupV2, interactionUser, openModal, replyV2, safe,
} from '../discord/interactions.js';
import {
  matchedCard, matchedCardDisabled, searchingCard, simpleCard, reportModal,
  profanityWarningCard, attachmentBlockedCard, attachmentUnreadableCard, statusReconnectCard, sessionOverviewEmbed,
  matchFizzledCard,
} from '../utils/embeds.js';
import { validateAttachment, sniffMatches, ALLOWED_BY_CATEGORY } from './attachments.js';
import { readBodyBounded } from '../utils/media.js';
import { logger, cleanText, safeFilename } from '../util.js';

// ---- tuning (same limits as the reference) ----
const RELAY_WINDOW_MS = 20_000;
const RELAY_MAX = 8; // max relayed messages per window
const RELAY_WARN_COOLDOWN_MS = 60_000;
const HINT_COOLDOWN_MS = 5 * 60_000;
const MAX_RELAY_FILES = 10;
const MAX_RELAY_FILE_BYTES = 20 * 1024 * 1024;

const msgTimes = new Map(); // userId -> [timestamps] (relay rate limiting)
const warnedAt = new Map(); // userId -> last spam warning timestamp
const hintedAt = new Map(); // userId -> last idle hint timestamp

// Relay rate-limit state must not grow forever (one entry per user). Drop
// entries idle for 24h; runs on the existing periodic sweep path (cheapest
// correct option).
const RELAY_STATE_TTL_MS = 24 * 60 * 60 * 1000;
function pruneRelayState(now = Date.now()) {
  for (const [uid, arr] of msgTimes) {
    const kept = arr.filter((t) => now - t < RELAY_STATE_TTL_MS);
    if (kept.length) msgTimes.set(uid, kept); else msgTimes.delete(uid);
  }
  for (const [uid, t] of warnedAt) if (now - t >= RELAY_STATE_TTL_MS) warnedAt.delete(uid);
  for (const [uid, t] of hintedAt) if (now - t >= RELAY_STATE_TTL_MS) hintedAt.delete(uid);
}
/** Test helper: seed relay rate-limit state with an explicit timestamp. */
export function _seedRelayStateForTests(uid, ts) {
  uid = String(uid);
  msgTimes.set(uid, [ts]);
  warnedAt.set(uid, ts);
  hintedAt.set(uid, ts);
}
/** Test helper: run the relay-state prune at `now`. */
export function _pruneRelayStateForTests(now = Date.now()) { pruneRelayState(now); }
/** Test helper: total relay-state entries across the three maps. */
export function _relayStateSizeForTests() {
  return msgTimes.size + warnedAt.size + hintedAt.size;
}

// ---- profanity moderation (per session, in-memory) ----
// Every relayed message is scanned by the local filter. The wordlist is
// two-tiered (see services/wordlist.js): soft profanities (shit, crap, ass,
// damn, hell, ...) pass untouched in isolation, while hard words are masked
// inline. A hard compound containing a soft component still flags the
// message but is masked component-wise (hard parts censored, soft parts
// readable). Profanity is counted per MESSAGE (not per word): each message
// containing at least one masked word uses one strike of the sender's
// session allowance. Minor chats allow 4 flagged messages, adult chats 10;
// the message that reaches the limit ends the chat immediately (no final
// warning) and the full session history is saved to data/modlogs for admin
// review.
const MINOR_PROFANITY_LIMIT = 4;
const ADULT_PROFANITY_LIMIT = 10;
const MOD_HISTORY_CAP = 500; // messages kept per session for the mod log
const modState = new Map(); // sessionId -> { counts: Map<uid, n>, history: [{t, from, text}] }

function getModState(sessionId) {
  let st = modState.get(sessionId);
  if (!st) {
    st = { counts: new Map(), history: [] };
    modState.set(sessionId, st);
  }
  // Self-maintaining: sweep state for long-dead sessions if the map grows.
  if (modState.size > 200) {
    for (const id of modState.keys()) {
      if (!db.sessions.has(id)) modState.delete(id);
    }
  }
  return st;
}

/** Drop a session's moderation state (call when the session ends). */
export function clearModState(sessionId) {
  modState.delete(String(sessionId));
}

/** Test helper: reset moderation state. */
export function _resetModForTests() {
  modState.clear();
}

/**
 * Given a matchmaking match ({ user1, user2, entries }), honor the fizzle
 * circuit breaker and start the session. A cooling-down pair is restored to
 * the queue (original joinedAt) instead of being re-formed. Returns the
 * session, or null when there was no match, the pair was cooling down, or a
 * banned side refused the match (the allowed side is re-queued inside
 * startChatSession).
 */
export async function startChatFromMatch(match) {
  if (!match) return null;
  if (fizzlePairBlocked(match.user1.user_id, match.user2.user_id)) {
    logger.info(`skipping fizzle-cooling pair ${match.user1.user_id}<->${match.user2.user_id}`);
    // Both sides go back to the queue: a cooling-down pair must never
    // strand anyone. The closed-DM side re-queues here only because they
    // asked to (via /new); the fizzle unwind still drops them when the
    // pair's block expires and the DMs are still closed, and /new's
    // terminal branch explains why.
    requeueAfterFizzle(match.user1.user_id, match.user1.anonymous_id, match.entries?.[0]);
    requeueAfterFizzle(match.user2.user_id, match.user2.anonymous_id, match.entries?.[1]);
    return null;
  }
  return startChatSession(
    match.user1.user_id, match.user2.user_id,
    match.user1.anonymous_id, match.user2.anonymous_id,
    match.entries,
  );
}

/**
 * Pair up eligible waiters (lets age-gap expansion resolve for long
 * waiters without needing a fresh /new to trigger it). Returns true when a
 * pair was matched and their session started.
 */
export async function sweepMatchmaking() {
  // null = no eligible pair, a cooling-down pair (restored to the queue),
  // or a banned side refused at match formation (allowed side re-queued).
  const session = await startChatFromMatch(matchmaking.tryMatchWaiters());
  return !!session;
}

function pushModHistory(sessionId, uid, text) {
  const st = getModState(sessionId);
  st.history.push({ t: Date.now(), from: String(uid), text: String(text) });
  if (st.history.length > MOD_HISTORY_CAP) st.history.splice(0, st.history.length - MOD_HISTORY_CAP);
}

/** Unknown date of birth fails safe: treated as a minor. */
function isMinorUid(uid) {
  const age = db.getUserAge(uid);
  return age == null ? true : age < 18;
}

/** A session is a minor chat when EITHER participant is under 18. */
function isMinorSession(session) {
  return isMinorUid(session.user1_id) || isMinorUid(session.user2_id);
}

/** Compact the session's chat history to data/modlogs for admin review. */
function saveModLog(session, offenderId, minor, count) {
  const st = modState.get(session.session_id);
  const log = {
    session_id: session.session_id,
    ended_at: new Date().toISOString(),
    reason: 'profanity_limit',
    minor_chat: minor,
    offender_user_id: String(offenderId),
    offender_flagged_messages: count,
    participants: [session.user1_id, session.user2_id],
    messages: (st ? st.history : []).map((m) => ({
      at: new Date(m.t).toISOString(),
      from: m.from,
      text: m.text,
    })),
  };
  try {
    const dir = path.join(paths.dataDir, 'modlogs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${session.session_id}.json`), JSON.stringify(log, null, 2));
    logger.info(`modlog saved for session ${session.session_id} (${log.messages.length} messages)`);
  } catch (err) {
    logger.error('modlog save failed:', err);
  }
}

/**
 * Unified session conclusion. Every ending trigger (manual end, safety
 * moderation, idle timeout, block, banned partner) flows through here.
 * Each participant receives exactly two persistent (never ephemeral)
 * messages, in order:
 *   1. the status + reconnect card (Components V2 container), with the
 *      who/why explanation adapted to their role in the ending;
 *   2. the session overview (plain Discord embed, zero buttons), identical
 *      across every exit scenario.
 *
 * trigger: 'manual' | 'mod' | 'timeout' | 'block' | 'partner_banned'
 * actorId: the user who caused the end (manual end, block, mod offender).
 * opts.omitDMFor: skip the DM posts for this user (the caller delivers
 *   their two messages through the interaction instead, e.g. an in-place
 *   edit followed by a DM for the embed).
 *
 * Returns { stats, messages } where messages maps each user id to
 * { v2, embed }, the payloads they were sent (or were meant to receive).
 * A duplicate (overlapping) call returns { duplicate: true, stats: null,
 * messages: {} } and sends nothing.
 */
const concluding = new Set(); // session ids with a conclusion currently in flight
// userId -> sessionId, while that session's conclusion DMs are in flight.
// The session is already gone from db.sessions by then, so the set above
// alone can't gate /new: without this map a fast /new could match the user
// into a NEW chat whose greeting lands BEFORE the old chat's conclusion
// cards. Added/deleted in the same synchronous spots as `concluding`.
const concludingUsers = new Map();

/**
 * True while the user's most recent session still has a conclusion in
 * flight. /new and handleChatFindNew refuse while this holds, preserving
 * the "old conclusion cards before any new greeting" delivery order.
 */
export function isUserConcluding(userId) {
  return concludingUsers.has(String(userId));
}

/**
 * True while the session id has a conclusion currently in flight
 * (synchronous read of the `concluding` set). share.js's pre-send
 * re-check uses this so identity cards never go out to a pair that is
 * being concluded (block / mod termination racing the swap).
 */
export function isSessionConcluding(sessionId) {
  return concluding.has(String(sessionId));
}

export async function concludeSession(session, trigger, actorId = null, opts = {}) {
  // Idempotency MUST be synchronous: a check-then-act around
  // db.endChatSession() is not enough, because two overlapping concludes
  // can both pass before either removes the session. This check-and-add is
  // fully synchronous — the first caller wins before any await runs — so
  // the End-tap/sweep, /end/button and double-tap interleavings all
  // collapse to one. Deleted in a finally so a throwing conclusion never
  // wedges the session id.
  const sid = String(session.session_id);
  if (concluding.has(sid) || !db.sessions.has(sid)) {
    logger.info(`concludeSession: ${sid} already concluding/concluded, skipping duplicate`);
    return {
      duplicate: true, stats: null, messages: {},
      user1: String(session.user1_id), user2: String(session.user2_id),
    };
  }
  concluding.add(sid);
  concludingUsers.set(String(session.user1_id), sid);
  concludingUsers.set(String(session.user2_id), sid);
  try {
    return await runConcludeSession(session, trigger, actorId, opts);
  } finally {
    concluding.delete(sid);
    concludingUsers.delete(String(session.user1_id));
    concludingUsers.delete(String(session.user2_id));
  }
}

/** The single body of concludeSession; only ever runs once per session id. */
async function runConcludeSession(session, trigger, actorId = null, opts = {}) {
  const endedAt = Date.now();
  const stats = {
    textMessages: session.stats?.text || 0,
    attachments: session.stats?.attachments || 0,
    durationMs: Math.max(0, endedAt - (session.started_at || endedAt)),
  };
  const u1 = String(session.user1_id);
  const u2 = String(session.user2_id);
  const actor = actorId == null ? null : String(actorId);

  // Fold this chat into each participant's lifetime /stats. Every ending
  // trigger funnels through here, so manual ends, timeouts, moderation
  // terminations and blocks all count identically.
  for (const uid of [u1, u2]) {
    const s = session.userStats?.[uid] || { text: 0, attachments: 0 };
    db.recordChatLifetime(uid, {
      messages: s.text,
      attachments: s.attachments,
      durationMs: stats.durationMs,
    });
    // Remember the pairing so /block can still reach a partner after the
    // chat has ended. Both directions: each side gets their own ring.
    db.pushRecentPartner(uid, uid === u1 ? u2 : u1);
  }

  db.endChatSession(session.session_id);
  // Mark the shared session object concluded: the fizzle unwind in
  // startChatSession holds this same reference, and must NOT requeue a
  // user whose /end landed in the grey-PATCH window (lifecycle BUG 2).
  session.concluded = true;
  clearModState(session.session_id);
  logger.info(`chat ended (${trigger}): ${u1} x ${u2} — ${stats.textMessages} texts, ${stats.attachments} attachments, ${stats.durationMs}ms`);

  // Remember the pair so post-chat 👍/👎 ratings resolve, then grey out the
  // original greeting cards: both participants' "End chat" and "Report"
  // buttons become unclickable, for every ending trigger. Late taps are
  // rejected by the server-side guard in the button handlers below.
  db.noteSessionConcluded(session);
  await disableGreetingButtons(session);

  const roleFor = (uid) => {
    if (trigger === 'manual') return uid === actor ? 'ender' : 'partner';
    if (trigger === 'mod') return 'mod';
    if (trigger === 'timeout') return 'timeout';
    if (trigger === 'block') return uid === actor ? 'blocker' : 'disconnected';
    if (trigger === 'partner_banned') return 'unavailable';
    return 'partner';
  };

  const messages = {};
  const omit = opts.omitDMFor == null ? null : String(opts.omitDMFor);
  for (const uid of [u1, u2]) {
    const v2 = statusReconnectCard(roleFor(uid), session.session_id);
    const embed = sessionOverviewEmbed(stats);
    messages[uid] = { v2, embed };
    if (uid === omit) continue;
    await sendDM(uid, v2);
    await sendEmbedDM(uid, [embed]);
  }
  return { stats, messages, user1: u1, user2: u2 };
}

/**
 * Patch both participants' original match greeting cards so the "End chat"
 * and "Report" buttons render disabled (greyed out, unclickable). Runs for
 * every ending trigger because it lives in concludeSession. Each card is
 * rebuilt with the partner's current reputation so the rating line survives.
 */
async function disableGreetingButtons(session) {
  const g = session.greeting || {};
  const u1 = String(session.user1_id);
  const u2 = String(session.user2_id);
  await Promise.all([u1, u2].map(async (uid) => {
    const ref = g[uid];
    if (!ref?.channelId || !ref?.messageId) return;
    const partnerRep = db.getReputation(uid === u1 ? u2 : u1);
    await safe(
      Rest.editMessage(ref.channelId, ref.messageId, { flags: V2, components: matchedCardDisabled(partnerRep) }),
      'disable greeting buttons',
    );
  }));
}

/**
 * True only when the pressed button sits on the user's CURRENT session
 * greeting card. Anything else is a late press: no session at all, a stale
 * card from a previous chat, or a greeting retired by a restart.
 */
function isLiveGreetingPress(ix, session, userId) {
  if (!session) return false;
  const ref = session.greeting?.[String(userId)];
  return !!(ref?.messageId && ix.message?.id && String(ix.message.id) === String(ref.messageId));
}

/**
 * End the session after repeated flagged language. Both sides get the
 * standardized conclusion: the safety status card (message 1) followed by
 * the identical session overview embed (message 2), and the chat history
 * is saved for review.
 */
async function terminateForProfanity(session, offenderId, partnerId, minor, count) {
  saveModLog(session, offenderId, minor, count);
  await concludeSession(session, 'mod', offenderId);
}

/**
 * Record one flagged message for the sender. Warns on every strike with the
 * remaining allowance; the message that REACHES the limit terminates the chat
 * immediately with no final warning. Returns true when the session was
 * terminated.
 */
async function trackProfanity(uid, partnerId, session) {
  const st = getModState(session.session_id);
  const count = (st.counts.get(uid) || 0) + 1;
  st.counts.set(uid, count);
  const minor = isMinorSession(session);
  const limit = minor ? MINOR_PROFANITY_LIMIT : ADULT_PROFANITY_LIMIT;
  if (count >= limit) {
    await terminateForProfanity(session, uid, partnerId, minor, count);
    return true;
  }
  const remaining = limit - count;
  await sendDM(uid, profanityWarningCard(remaining));
  return false;
}

// ---------------------------------------------------------------------------
// DM helpers
// ---------------------------------------------------------------------------

/** Resolve (and cache) the bot's 1:1 DM channel with a user. */
export async function resolveDMChannel(userId) {
  userId = String(userId);
  let channelId = db.db.dms[userId];
  if (channelId) {
    // LRU refresh: the dms cache evicts oldest-first on plain-object key
    // order, so a re-cache must move the key to the back — otherwise the
    // most-used entries are evicted first (FIFO, not LRU).
    delete db.db.dms[userId];
    db.db.dms[userId] = channelId;
    return channelId;
  }
  try {
    const dm = await Rest.createDM(userId);
    channelId = dm.id;
    db.db.dms[userId] = channelId;
    db.save();
    return channelId;
  } catch (err) {
    logger.warn(`could not open DM with ${userId}: ${err.message}`);
    return null;
  }
}

/**
 * Send a Components-V2 DM. Returns { ok, channelId, messageId }.
 * opts.noMentions strips all mention parsing (relayed stranger text).
 */
export async function sendDM(userId, components, files = [], opts = {}) {
  userId = String(userId);
  // Up to two passes: a 403 (HTTP status, covering EVERY JSON code: 50001,
  // 50013, stale cached DM channel minted under a different app token...)
  // evicts the cache and retries once so resolveDMChannel mints a fresh
  // channel. A 10003 (unknown channel) gets the same single retry. 50007
  // (closed DMs) is persistent and never retried.
  for (let pass = 0; pass < 2; pass++) {
    try {
      const channelId = await resolveDMChannel(userId);
      if (!channelId) return { ok: false, reason: 'dms_closed' };
      const body = { flags: V2, components };
      if (files.length) body.attachments = files.map((f, i) => ({ id: String(i), filename: f.filename }));
      if (opts.noMentions) body.allowed_mentions = { parse: [] };
      const sent = await Rest.sendMessage(channelId, body, files.length ? { files } : {});
      return { ok: true, channelId, messageId: sent?.id || null };
    } catch (err) {
      if (err instanceof DiscordAPIError && err.code === 50007) {
        logger.info(`cannot DM ${userId}: DMs closed or bot blocked`);
        return { ok: false, reason: 'dms_closed' };
      }
      if (err instanceof DiscordAPIError && err.status === 403) {
        delete db.db.dms[userId]; // stale cached channel
        db.save();
        if (pass === 0) continue; // retry once with a freshly minted channel
      }
      if (err instanceof DiscordAPIError && err.code === 10003) {
        delete db.db.dms[userId]; // stale cached channel
        db.save();
        if (pass === 0) continue; // retry once with a freshly minted channel
      }
      logger.warn(`DM to ${userId} failed: ${err.message}`);
      return { ok: false, reason: 'error' };
    }
  }
  return { ok: false, reason: 'error' };
}

/** Send a classic-embed DM (non-V2). Same { ok, channelId, messageId } shape. */
export async function sendEmbedDM(userId, embeds) {
  userId = String(userId);
  // Same two-pass self-heal as sendDM: a 403 (any JSON code) or 10003
  // evicts the stale cached channel and retries once on a fresh one.
  for (let pass = 0; pass < 2; pass++) {
    try {
      const channelId = await resolveDMChannel(userId);
      if (!channelId) return { ok: false, reason: 'dms_closed' };
      const sent = await Rest.sendMessage(channelId, { embeds });
      return { ok: true, channelId, messageId: sent?.id || null };
    } catch (err) {
      if (err instanceof DiscordAPIError && err.code === 50007) {
        logger.info(`cannot DM ${userId}: DMs closed or bot blocked`);
        return { ok: false, reason: 'dms_closed' };
      }
      if (err instanceof DiscordAPIError && err.status === 403) {
        delete db.db.dms[userId]; // stale cached channel
        db.save();
        if (pass === 0) continue; // retry once with a freshly minted channel
      }
      if (err instanceof DiscordAPIError && err.code === 10003) {
        delete db.db.dms[userId]; // stale cached channel
        db.save();
        if (pass === 0) continue; // retry once with a freshly minted channel
      }
      logger.warn(`embed DM to ${userId} failed: ${err.message}`);
      return { ok: false, reason: 'error' };
    }
  }
  return { ok: false, reason: 'error' };
}

export async function safeGetUser(id) {
  try { return await Rest.getUser(id); }
  catch (err) { logger.warn(`getUser(${id}) failed: ${err.message}`); return null; }
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

/**
 * Re-queue one side of a fizzled match, preserving the original joinedAt so
 * the user keeps their gap-expansion progress. No-ops when the user somehow
 * ended up queued or in a session already (never clobber live state), and
 * never re-queues a banned user (a ban that landed mid-queue must drop them).
 */
function requeueAfterFizzle(userId, anonymousId, entry) {
  const uid = String(userId);
  if (matchmaking.getQueuePosition(uid)) return;
  if (db.getActiveSessionForUser(uid)) return;
  if (!safety.checkUserSafetyStatus(uid).isAllowed) return;
  const joinedAt = entry && Number.isFinite(entry.joinedAt) ? entry.joinedAt : Date.now();
  const anon = (entry && entry.anonymousId) || anonymousId || db.getAnonId(uid);
  matchmaking.addToQueue(uid, anon, joinedAt);
}

// ---------------------------------------------------------------------------
// Fizzle circuit breaker: a pair that fizzles repeatedly (one side
// unreachable) must not be re-matched in a tight loop burning DMs. State is
// keyed on the sorted pair. The FIRST consecutive fizzle tells each reachable
// side ("back in the queue"); the 2nd and 3rd are silent; after 3
// consecutive fizzles the pair is skipped for 5 minutes. Both users stay
// queued, so a successful session with anyone resets the counter. Honored by
// the matchmaking sweep AND the /new paths.
// ---------------------------------------------------------------------------
const fizzleState = new Map(); // "uidA:uidB" (sorted) -> { count, blockedUntil }
const FIZZLE_BLOCK_MS = 5 * 60_000;

const fizzleKey = (a, b) => [String(a), String(b)].sort().join(':');

/** Record a fizzle for the pair; returns the pair's consecutive-fizzle count. */
function noteFizzle(a, b) {
  const k = fizzleKey(a, b);
  const st = fizzleState.get(k) || { count: 0, blockedUntil: 0, at: 0 };
  st.count += 1;
  st.at = Date.now();
  if (st.count >= 3) st.blockedUntil = Date.now() + FIZZLE_BLOCK_MS;
  fizzleState.set(k, st);
  return { count: st.count };
}

/** A successful session for either user clears their pair counters. */
function resetFizzleForUser(userId) {
  const uid = String(userId);
  for (const k of [...fizzleState.keys()]) {
    if (k.split(':').includes(uid)) fizzleState.delete(k);
  }
}

/** True while this pair is inside its post-fizzle cooldown. */
export function fizzlePairBlocked(a, b) {
  const st = fizzleState.get(fizzleKey(a, b));
  return !!st && st.blockedUntil > Date.now();
}

/** Test helper: clear all fizzle circuit-breaker state. */
export function _resetFizzleForTests() { fizzleState.clear(); fizzleRestoredSeq.clear(); fizzleRestoreSeq = 0; }

/**
 * Users whose DMs are known to be closed (sendDM returned reason
 * 'dms_closed', i.e. Discord 50007). Recorded in the fizzle unwind; read by
 * the fizzle-pair cooldown branch (drop instead of requeue) and by /new
 * (honest explainer instead of silent fizzle churn). In-memory only.
 */
const closedDmUsers = new Set();
/** True when this user is known to have closed DMs. */
export function isClosedDmUser(userId) { return closedDmUsers.has(String(userId)); }
/** Test helper: clear the closed-DM set. */
export function _resetClosedDmForTests() { closedDmUsers.clear(); }

/** Test helper: number of live fizzle circuit-breaker entries. */
export function _fizzleStateSizeForTests() { return fizzleState.size; }

// Informed fizzle restores: userId -> { seq, at }. The fizzle unwind records
// a restore ONLY when the side actually receives the honest "back in the
// queue" card. /new's rollback consults the monotonic seq: a restore newer
// than the /new call means the queue entry was legitimately re-created
// mid-callback, so a dying interaction must not yank it. Silent restores
// (2nd+ consecutive fizzle, or an undeliverable card) are NOT recorded —
// the user holds no card, so the rollback's clean-slate behavior still
// applies to them.
let fizzleRestoreSeq = 0;
const fizzleRestoredSeq = new Map();
function noteFizzleRestore(userId) {
  fizzleRestoredSeq.set(String(userId), { seq: ++fizzleRestoreSeq, at: Date.now() });
}
/** Monotonic clock of informed fizzle restores; /new snapshots it per call. */
export function fizzleRestoreSeqNow() { return fizzleRestoreSeq; }
/** Last informed fizzle-restore seq for this user (0 when never). */
export function fizzleRestoredSeqFor(userId) {
  return fizzleRestoredSeq.get(String(userId))?.seq || 0;
}

// Fizzle state must not grow forever: pairs that fizzle once or twice and
// never meet again would leak entries. Drop pairs whose block has expired
// and that haven't fizzled in the last hour (an hour of quiet means the
// feud is over; a later fizzle simply starts a fresh count), and drop
// informed-restore markers older than an hour (no /new call lives that
// long). Runs on the existing periodic sweep path, next to the relay-state
// prune — never on a hot path.
const FIZZLE_STATE_TTL_MS = 60 * 60_000;
function pruneFizzleState(now = Date.now()) {
  for (const [k, st] of fizzleState) {
    if (st.blockedUntil <= now && now - st.at >= FIZZLE_STATE_TTL_MS) fizzleState.delete(k);
  }
  for (const [uid, rec] of fizzleRestoredSeq) {
    if (now - rec.at >= FIZZLE_STATE_TTL_MS) fizzleRestoredSeq.delete(uid);
  }
}

/**
 * Create the session and DM BOTH strangers the matched V2 card.
 *
 * Match fizzle is non-destructive: when either greeting DM fails (or a throw
 * happens anywhere after the session is created), the half-born session is
 * ended and each reachable side is put back in the queue with their original
 * joinedAt, so nobody is stranded and nobody loses their place. A side whose
 * DMs are permanently closed (50007) is NOT requeued — it would fizzle with
 * every new partner forever. The first consecutive fizzle sends each
 * reachable side an honest "back in the queue" card; a throw past session
 * creation tells both sides. The 2nd and 3rd consecutive fizzles for the same
 * pair are silent, and after 3 the pair is not matched for 5 minutes
 * (fizzlePairBlocked), so one unreachable side cannot burn DMs in a tight
 * loop. A successful session for either user resets the pair's counter.
 *
 * Formation-liveness: the session is created BEFORE the greeting DMs go out,
 * so /end (or the idle sweep, or moderation) can conclude it mid-flight.
 * After the DM await the session's existence is re-checked; a session that
 * vanished is abandoned without greeting stamps or the fizzle unwind.
 * Returns null when no live session resulted (no match, refused, fizzled,
 * or concluded mid-formation) — callers must not announce a match then.
 *
 * Banned-while-queued guard: a ban that landed between queueing and match
 * formation produces no session; the allowed side keeps their place and the
 * banned side is dropped.
 *
 * `entries` is the matchmaking.takePair snapshot ([a, b]) of the removed
 * queue entries; call sites thread it through from the findMatch result.
 */
export async function startChatSession(user1Id, user2Id, anon1, anon2, entries = null) {
  // Safety re-check at match formation: a ban that landed mid-queue must
  // not become a session (pairScore lives in matchmaking, which is not
  // chat-owned, so the guard lives here and on the sweep/find paths).
  const ban1 = !safety.checkUserSafetyStatus(String(user1Id)).isAllowed;
  const ban2 = !safety.checkUserSafetyStatus(String(user2Id)).isAllowed;
  if (ban1 || ban2) {
    logger.info(`startChatSession: banned side (${ban1 ? user1Id : user2Id}), no session formed`);
    if (!ban1) requeueAfterFizzle(user1Id, anon1, entries?.[0]);
    if (!ban2) requeueAfterFizzle(user2Id, anon2, entries?.[1]);
    return null;
  }
  const session = db.createChatSession(user1Id, user2Id);
  logger.info(`chat started: ${user1Id} <-> ${user2Id} (${session.session_id})`);
  // Each side's card shows the PARTNER's community reputation, so both
  // strangers can evaluate who they were paired with at a glance.
  const cardFor = (viewerId, partnerId) => matchedCard(db.getReputation(partnerId));
  let r1, r2;
  try {
    [r1, r2] = await Promise.all([
      sendDM(user1Id, cardFor(user1Id, user2Id)),
      sendDM(user2Id, cardFor(user2Id, user1Id)),
    ]);
  } catch (err) {
    // sendDM normally swallows its own errors, but a throw anywhere past
    // session creation must still fizzle cleanly rather than strand users.
    logger.warn(`greeting DM phase threw for ${session.session_id}: ${err.message}`);
  }
  const failed = !r1?.ok || !r2?.ok;
  // Formation-liveness re-check: /end, the idle sweep, or moderation may
  // have concluded the half-born session while the greeting DMs were in
  // flight (concludeSession removes the session synchronously, before its
  // own DMs go out, so a missing session here unambiguously means
  // "concluded"). Bail WITHOUT stamping greeting cards or running the
  // fizzle unwind: completing formation for a dead session — or re-queueing
  // a user who just ended the chat — strands both sides.
  if (!db.sessions.has(String(session.session_id))) {
    logger.info(`startChatSession: session ${session.session_id} concluded mid-formation; abandoning`);
    return null;
  }
  if (failed) {
    // Grey out any greeting card that did land before the session dies: its
    // End/Report buttons must not look live on a dead session. (Late presses
    // are rejected server-side by isLiveGreetingPress regardless; this is
    // cosmetic. concludeSession's disableGreetingButtons never runs here
    // because the fizzle path ends the session directly.)
    session.greeting = {
      ...(r1?.ok ? { [String(user1Id)]: { channelId: r1.channelId, messageId: r1.messageId } } : {}),
      ...(r2?.ok ? { [String(user2Id)]: { channelId: r2.channelId, messageId: r2.messageId } } : {}),
    };
    await disableGreetingButtons(session);
    // Lifecycle BUG 2: the session object is shared with any conclusion
    // that landed while the grey-out PATCH was in flight (an End tap on
    // the still-live greeting card). When that happened, concludeSession
    // already ended the chat for BOTH sides, so db.endChatSession below is
    // a no-op and neither side may be requeued or told "back in the queue".
    const concludedMidFlight = session.concluded === true;
    db.endChatSession(session.session_id);
    // Queue 3a: a side whose DMs are permanently closed (50007) is
    // recorded in the closed-DM set so later paths (the fizzle-pair
    // cooldown branch, /new) stop churning it through silent fizzles.
    if (r1?.reason === 'dms_closed') closedDmUsers.add(String(user1Id));
    if (r2?.reason === 'dms_closed') closedDmUsers.add(String(user2Id));
    // A side whose DMs are permanently closed (50007) is NOT requeued: it
    // would fizzle with every new partner forever, churning the queue. Its
    // next user-initiated /new can try again.
    if (!concludedMidFlight) {
      if (r1?.reason !== 'dms_closed') requeueAfterFizzle(user1Id, anon1, entries?.[0]);
      if (r2?.reason !== 'dms_closed') requeueAfterFizzle(user2Id, anon2, entries?.[1]);
    }
    const { count } = noteFizzle(user1Id, user2Id);
    if (count === 1 && !concludedMidFlight) {
      // First consecutive fizzle: each reachable side is told. A throw past
      // session creation leaves r1/r2 undefined — treat "unknown" as
      // unreached and tell both sides rather than going silent. Sides that
      // actually receive the card are recorded so /new's rollback won't yank
      // the entry the fizzle path just restored.
      if (r1 === undefined || r1?.ok) {
        if ((await sendDM(user1Id, matchFizzledCard())).ok) noteFizzleRestore(user1Id);
      }
      if (r2 === undefined || r2?.ok) {
        if ((await sendDM(user2Id, matchFizzledCard())).ok) noteFizzleRestore(user2Id);
      }
    }
    // A fizzle is not a match: null keeps callers (handleChatFindNew, the
    // sweep) honest instead of announcing "found someone" for a dead pair.
    return null;
  }
  resetFizzleForUser(user1Id);
  resetFizzleForUser(user2Id);
  // Retain both greeting cards for the session's lifetime: concludeSession
  // disables their buttons the instant the chat ends, and the button
  // handlers use them to reject late taps on stale cards.
  session.greeting = {
    [String(user1Id)]: { channelId: r1.channelId, messageId: r1.messageId },
    [String(user2Id)]: { channelId: r2.channelId, messageId: r2.messageId },
  };
  return session;
}

/**
 * Wrap up sessions that went quiet: no relayed message for IDLE_TIMEOUT_MS.
 * Both strangers get the timeout summary card. Runs on the bot's interval
 * alongside the matchmaking sweep.
 */
const IDLE_TIMEOUT_MS = 30 * 60_000;

export async function sweepIdleSessions(now = Date.now()) {
  // The relay rate-limit maps (msgTimes/warnedAt/hintedAt) are keyed per
  // user forever; prune entries idle 24h+ here on the periodic path so
  // they cannot grow unbounded. Same for the fizzle circuit-breaker maps.
  pruneRelayState(now);
  pruneFizzleState(now);
  // LOAD-1: reset the vendored profanity library's uncapped per-instance
  // caches on the same periodic path; the engine's own capped verdict
  // cache absorbs the recompute cost.
  profanity.sweepEngineCaches();
  for (const session of db.getActiveSessions()) {
    // A ban that landed mid-chat must end it now with the honest
    // 'partner_banned' card, not 30 minutes later as a 'timeout'.
    if (db.isBanned(session.user1_id) || db.isBanned(session.user2_id)) {
      await concludeSession(session, 'partner_banned');
      continue;
    }
    const last = session.lastActivityAt || session.started_at || now;
    if (now - last >= IDLE_TIMEOUT_MS) {
      await concludeSession(session, 'timeout');
    }
  }
}

// ---------------------------------------------------------------------------
// chat buttons (live on the DM cards)
// ---------------------------------------------------------------------------

/**
 * Edit the card a button lives on: ephemeral interaction responses go through
 * the webhook editOriginal endpoint, real DM channel messages go through
 * PATCH /channels/{id}/messages/{id}.
 */
async function editSourceCard(ix, components) {
  const body = { flags: V2, components };
  if (ix.message && (ix.message.flags & 64)) {
    await safe(Interactions.editOriginal(ix, body), 'edit source card');
  } else if (ix.channel_id && ix.message?.id) {
    await safe(Rest.editMessage(ix.channel_id, ix.message.id, body), 'edit source card');
  }
}

/** "End chat" button on the matched DM card. */
export async function handleChatEnd(ix) {
  const user = interactionUser(ix);
  const session = db.getActiveSessionForUser(user.id);
  // Server-side guard: the button only works on the CURRENT session's
  // greeting card. Late taps (no session, or a stale card from an older
  // chat) are rejected with an ephemeral and never acted on.
  if (!isLiveGreetingPress(ix, session, user.id)) {
    return replyV2(ix, simpleCard('This chat has already ended. Run `/new` whenever you want to meet someone new.'));
  }
  await deferUpdate(ix);
  // The ender's two conclusion messages: the status card replaces the
  // matched card in place (a persistent channel message, never ephemeral),
  // then the overview embed lands as the second message. concludeSession is
  // idempotent: when a racing trigger already concluded the session, this
  // call is a duplicate and there is nothing to deliver in place.
  const { messages, duplicate } = await concludeSession(session, 'manual', user.id, { omitDMFor: user.id });
  if (duplicate) return;
  const mine = messages[String(user.id)];
  await editSourceCard(ix, mine.v2);
  await sendEmbedDM(user.id, [mine.embed]);
}

/** "Report" button on the matched DM card: opens the report modal. */
export async function handleChatReport(ix) {
  const user = interactionUser(ix);
  const session = db.getActiveSessionForUser(user.id);
  if (!isLiveGreetingPress(ix, session, user.id)) {
    return replyV2(ix, simpleCard("This chat has already ended, so there's nothing to report."));
  }
  // Encode the partner's id in the modal's custom id. The submit handler
  // prefers report_modal:<targetId> over "current partner", so if the chat
  // ends while the modal is open the report still files against the right
  // stranger instead of being dropped (or worse, misfiled).
  const partnerId = String(session.user1_id) === String(user.id) ? session.user2_id : session.user1_id;
  await openModal(ix, reportModal(String(partnerId)));
}

/** Deep-copy a V2 component tree with the 👍/👎 rating buttons disabled. */
function withRateButtonsDisabled(components) {
  const copy = JSON.parse(JSON.stringify(components));
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n.type === 2 && typeof n.custom_id === 'string' && /^rate_(like|dislike)/.test(n.custom_id)) {
        n.disabled = true;
      }
      walk(n.components);
    }
  };
  walk(copy);
  return copy;
}

/**
 * "👍 Like" / "👎 Dislike" on the conclusion card: exactly one rating per
 * user per session, recorded against the partner's lifetime reputation.
 * The rating is a community honor system and never touches matchmaking.
 * Answers with an ephemeral confirmation and greys out both rating buttons
 * on the card in place; repeat taps are told the rating was already recorded.
 */
export async function handleRate(ix, kind) {
  const user = interactionUser(ix);
  // Ack FIRST (deferUpdate), then record: ratePartner is a sync, pure-DB
  // op, so the rating can never be half-applied — but if the defer fails,
  // the interaction is dead and every response must be a followup, never a
  // second initial callback. (The failure path below used to replyV2,
  // which also dies once the interaction has been deferred.)
  await deferUpdate(ix);
  const sessionId = String(ix.data?.custom_id || '').split(':')[1] || '';
  const res = db.ratePartner(sessionId, user.id, kind);
  if (!res.ok) {
    return followupV2(ix, simpleCard(res.reason === 'already_rated'
      ? 'Your rating was already recorded. Thanks!'
      : 'This chat is too old to rate now.'));
  }
  if (ix.message?.components) {
    await safe(editSourceCard(ix, withRateButtonsDisabled(ix.message.components)), 'disable rate buttons');
  }
  const word = kind === 'like' ? '👍 like' : '👎 dislike';
  await safe(
    followupV2(ix, simpleCard(`Thanks! Your ${word} was recorded. It's anonymous. Your partner won't know it was you.`)),
    'rate confirmation',
  );
}

/** "Find someone new" button on the ended DM card: re-enter the queue. */
export async function handleChatFindNew(ix) {
  const user = interactionUser(ix);
  // Narrow safety gate: the router gates only slash commands (type 2), so
  // without this a banned user could queue — and churn a partner — through
  // this button. Kept narrow on purpose: a router-level type-3 gate would
  // also strip a banned mid-session user's End/Report buttons.
  if (!safety.checkUserSafetyStatus(user.id).isAllowed) {
    await deferUpdate(ix);
    await editSourceCard(ix, simpleCard('This account is not allowed to use the bot.'));
    return;
  }
  await deferUpdate(ix);
  if (db.getActiveSessionForUser(user.id)) {
    await editSourceCard(ix, simpleCard("You're already in a chat. Say hi!"));
    return;
  }
  // In-flight conclusion gate: the old session is already gone from the DB
  // but its conclusion DMs may still be on the wire. Queueing now could
  // form a new chat whose greeting lands BEFORE the old "chat ended" cards.
  if (isUserConcluding(user.id)) {
    await editSourceCard(ix, simpleCard('Finishing up your last chat, one moment…'));
    return;
  }
  if (matchmaking.getQueuePosition(user.id)) {
    const st = matchmaking.getEligibleQueueStats(user.id);
    await editSourceCard(ix, searchingCard(st.position, st.size));
    // Don't re-parent the searching card: the /new card (or an earlier
    // find_new press) is still the live one with the working Cancel button.
    // Overwriting the id would orphan it — Cancel there would say the
    // search "already ended" while the user is still queued.
    if (!matchmaking.getSearchingCardId(user.id)) {
      matchmaking.setSearchingCardId(user.id, ix.message?.id);
    }
    return;
  }
  // NOTE: the router's onboarding gate guarantees a profile here.
  matchmaking.addToQueue(user.id, db.getAnonId(user.id));
  // startChatFromMatch honors the fizzle circuit breaker (a cooling-down
  // pair is restored to the queue) and the banned-while-queued guard (the
  // allowed side is re-queued, the banned side dropped). null = no match
  // formed; the user is left queued and sees the searching card.
  const session = await startChatFromMatch(matchmaking.findMatch(user.id));
  if (session) {
    await editSourceCard(ix, simpleCard('Found someone. Check your DMs, your anonymous chat is waiting.'));
    return;
  }
  const st = matchmaking.getEligibleQueueStats(user.id);
  if (!st) {
    // The caller was dropped from the queue (e.g. a ban landed mid-queue
    // and the banned-while-queued guard refused the match). Nothing to
    // show a position for; the router's safety gate explains on next use.
    await editSourceCard(ix, simpleCard("Hmm, that didn't work. Try `/new` again in a bit."));
    return;
  }
  await editSourceCard(ix, searchingCard(st.position, st.size));
  matchmaking.setSearchingCardId(user.id, ix.message?.id);
}

/**
 * True only when the pressed button sits on the user's CURRENT searching
 * card. Anything else is a late press: no queue entry at all, or a stale
 * card from a previous search episode (the same pattern as
 * isLiveGreetingPress). When the card id was never recorded (e.g. the
 * @original fetch failed), fall back to the old behavior rather than
 * trapping the user in the queue.
 */
function isLiveQueueCancelPress(ix, userId) {
  if (!matchmaking.getQueuePosition(userId)) return false;
  const current = matchmaking.getSearchingCardId(userId);
  if (!current) {
    logger.warn(`no searching card id recorded for queued user ${userId}; allowing cancel`);
    return true;
  }
  const pressed = ix.message?.id ? String(ix.message.id) : null;
  return !!pressed && pressed === current;
}

/** "Cancel search" button on the searching card. */
export async function handleQueueCancel(ix) {
  const user = interactionUser(ix);
  // Server-side guard: the button only works on the CURRENT searching card.
  // Late taps (not queued, or a stale card from an older search) are
  // rejected with an ephemeral and never acted on.
  if (!isLiveQueueCancelPress(ix, user.id)) {
    return replyV2(ix, simpleCard('That search already ended. If you want to meet someone new, run `/new`.'));
  }
  await deferUpdate(ix);
  // Re-validate AFTER the await: the world can change during the defer
  // (a match can form, a fizzle can complete). Cancelling blindly here
  // would clobber the new reality — overwrite the matched card, or
  // re-queue a user the fizzle path already decided to drop. If the user is
  // no longer queued on this exact card, skip both the removal and the
  // card edit.
  if (!isLiveQueueCancelPress(ix, user.id)) return;
  matchmaking.removeFromQueue(user.id);
  await editSourceCard(ix, simpleCard('Search cancelled. No worries.\n\n`/new` whenever you feel like meeting someone.'));
}

// ---------------------------------------------------------------------------
// DM relay (gateway MESSAGE_CREATE)
// ---------------------------------------------------------------------------

function relayAllowed(userId) {
  const now = Date.now();
  let arr = (msgTimes.get(userId) || []).filter((t) => now - t < RELAY_WINDOW_MS);
  arr.push(now);
  // Only the in-window count matters for the limit decision, so the array
  // never needs more than RELAY_MAX + headroom entries. Cap it to keep the
  // per-call filter cost and memory constant no matter how long a user
  // spams. Decisions are unchanged: a trimmed count can only fall below
  // RELAY_MAX when the true count was already at or under it.
  if (arr.length > RELAY_MAX + 8) arr = arr.slice(arr.length - (RELAY_MAX + 8));
  msgTimes.set(userId, arr);
  return arr.length <= RELAY_MAX;
}

async function maybeWarnSpam(userId) {
  const now = Date.now();
  if (now - (warnedAt.get(userId) || 0) < RELAY_WARN_COOLDOWN_MS) return;
  warnedAt.set(userId, now);
  await sendDM(userId, simpleCard("Whoa, slow down a little. You're sending messages faster than we can pass along."));
}

async function maybeHintIdle(userId) {
  const now = Date.now();
  if (now - (hintedAt.get(userId) || 0) < HINT_COOLDOWN_MS) return;
  hintedAt.set(userId, now);
  await sendDM(userId, simpleCard("You're not in an anonymous chat right now. Use `/new` and we'll find you someone to talk to."));
}

async function downloadAttachment(att) {
  // Bound the download: without a timeout a hung CDN fetch stalls the
  // relay loop for this message indefinitely. The body itself is
  // byte-bounded too: an unbounded Buffer.from(arrayBuffer()) lets a
  // declared-0/chunked body eat arbitrary memory (memory-DoS).
  const res = await fetch(att.url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await readBodyBounded(res, MAX_RELAY_FILE_BYTES);
  const ct = att.content_type || 'application/octet-stream';
  const kind = ct.startsWith('image/') || ct.startsWith('video/') ? 'media' : 'file';
  return { data: buf, contentType: ct, kind };
}

const VOICE_MESSAGE_FLAG = 1 << 13; // 8192, Discord's IS_VOICE_MESSAGE flag

/** A voice note carries waveform + duration metadata (and the client flag). */
function isVoiceNote(att, msgFlags) {
  if (att.waveform && att.duration_secs) return true;
  const ct = att.content_type || '';
  return ct.startsWith('audio/') && (msgFlags & VOICE_MESSAGE_FLAG);
}

/**
 * Relay a voice note bare: a native message (no V2 container) with the audio
 * re-uploaded along with its duration_secs + waveform metadata and the
 * IS_VOICE_MESSAGE flag, so the recipient gets a working voice player.
 */
export async function sendVoiceNote(userId, voiceFile) {
  userId = String(userId);
  const body = {
    flags: VOICE_MESSAGE_FLAG,
    attachments: [{
      id: '0',
      filename: voiceFile.filename,
      duration_secs: voiceFile.duration_secs,
      waveform: voiceFile.waveform,
    }],
  };
  const files = [{ filename: voiceFile.filename, data: voiceFile.data, contentType: voiceFile.contentType }];
  // Same two-pass self-heal as sendDM/sendEmbedDM: a 403 (HTTP status,
  // covering EVERY JSON code: 50001, 50013, stale cached DM channel minted
  // under a different app token...) evicts the cache and retries once so
  // resolveDMChannel mints a fresh channel. A 10003 (unknown channel) gets
  // the same single retry. 50007 (closed DMs) is persistent and never
  // retried.
  for (let pass = 0; pass < 2; pass++) {
    try {
      const channelId = await resolveDMChannel(userId);
      if (!channelId) return { ok: false, reason: 'dms_closed' };
      const sent = await Rest.sendMessage(channelId, body, { files });
      return { ok: true, channelId, messageId: sent?.id || null };
    } catch (err) {
      if (err instanceof DiscordAPIError && err.code === 50007) {
        logger.info(`cannot DM ${userId}: DMs closed or bot blocked`);
        return { ok: false, reason: 'dms_closed' };
      }
      if (err instanceof DiscordAPIError && err.status === 403) {
        delete db.db.dms[userId]; // stale cached channel
        db.save();
        if (pass === 0) continue; // retry once with a freshly minted channel
      }
      if (err instanceof DiscordAPIError && err.code === 10003) {
        delete db.db.dms[userId]; // stale cached channel
        db.save();
        if (pass === 0) continue; // retry once with a freshly minted channel
      }
      logger.warn(`voice note DM to ${userId} failed: ${err.message}`);
      return { ok: false, reason: 'error' };
    }
  }
  return { ok: false, reason: 'error' };
}

/** React ✅ / ❌ on the sender's original message to show delivery status. */
async function reactDeliveryStatus(channelId, messageId, delivered) {
  await safe(
    Rest.addReaction(channelId, messageId, delivered ? '✅' : '❌'),
    'delivery status reaction',
  );
}

/**
 * Build the relayed stranger message. No header: the recipient already knows
 * every relayed message comes from their chat partner. Layout order is always:
 *   1. text content (TextDisplay) at the very top
 *   2. a divider separator immediately below the text
 *   3. media attachments (MediaGallery) and other files at the bottom
 */
function relayMessage(content, files) {
  const parts = [];
  if (content) parts.push({ type: 10, content });
  const mediaItems = files
    .filter((f) => f.kind === 'media')
    .slice(0, 10)
    .map((f) => ({ media: { url: `attachment://${f.filename}` } }));
  const fileParts = files.filter((f) => f.kind !== 'media');
  if (mediaItems.length || fileParts.length) {
    if (content) parts.push({ type: 14, divider: true, spacing: 1 });
    if (mediaItems.length) parts.push({ type: 12, items: mediaItems });
    for (const f of fileParts) parts.push({ type: 13, file: { url: `attachment://${f.filename}` } });
  }
  return {
    components: [{ type: 17, accent_color: 0xEB459E, components: parts }],
    files,
  };
}

/**
 * Gateway MESSAGE_CREATE handler. Relays 1:1 DMs with the bot between the
 * two strangers of an active session.
 */
export async function handleDirectMessage(msg) {
  try {
    const author = msg.author || {};
    if (!author.id || author.bot) return;
    if (msg.guild_id || msg.type !== 0) return; // DMs only, plain messages only
    const uid = String(author.id);

    // Confirm this is the bot's own 1:1 DM channel with the user.
    const dmId = await resolveDMChannel(uid);
    if (!dmId || dmId !== String(msg.channel_id)) return;

    if (db.isBanned(uid)) {
      const s = db.getActiveSessionForUser(uid);
      if (s) await concludeSession(s, 'partner_banned', uid, { omitDMFor: uid });
      return;
    }

    const session = db.getActiveSessionForUser(uid);
    if (!session) {
      await maybeHintIdle(uid);
      return;
    }
    const partnerId = session.user1_id === uid ? session.user2_id : session.user1_id;
    if (db.isBanned(partnerId)) {
      await concludeSession(session, 'partner_banned', uid);
      return;
    }

    if (!relayAllowed(uid)) {
      await maybeWarnSpam(uid);
      return;
    }

    const content = cleanText(msg.content || '').slice(0, 2000);

    // Local profanity scan: the partner receives the masked text, the
    // message itself is never deleted or rejected.
    const filtered = profanity.filterText(content, { adultChat: !isMinorSession(session) });
    const relayText = filtered.text;
    if (content) pushModHistory(session.session_id, uid, content);

    const files = [];
    const voiceNotes = [];
    let skippedBig = false;
    const atts = (msg.attachments || []).slice(0, MAX_RELAY_FILES);

    // Strict attachment security, layer 1 (metadata): every attachment's
    // declared file extension AND MIME content type must be on the allowlist.
    // A single forbidden or unrecognized file blocks the entire message:
    // nothing is relayed, the message is marked ❌, and the sender gets a
    // warning naming what can be sent instead.
    const blockedNames = [];
    const cleared = [];
    for (const att of atts) {
      const v = validateAttachment(att);
      if (!v.ok) blockedNames.push(att?.filename || 'a file');
      else cleared.push({ att, category: v.category });
    }
    if (blockedNames.length) {
      await reactDeliveryStatus(dmId, msg.id, false);
      await sendDM(uid, attachmentBlockedCard(blockedNames, ALLOWED_BY_CATEGORY));
      logger.info(`relay: blocked ${blockedNames.join(', ')} from ${uid}`);
      return;
    }

    // Layer 2 (content): the downloaded bytes must actually be what the
    // extension claims. Discord's content_type largely mirrors the file
    // extension the uploader's client chose, so a text file renamed to .png
    // can arrive labeled image/png and pass layer 1. Sniffing the magic bytes
    // catches it here, before anything reaches the partner.
    const failedDownloads = [];
    for (const { att, category } of cleared) {
      if ((att.size || 0) > MAX_RELAY_FILE_BYTES) { skippedBig = true; continue; }
      try {
        const dl = await downloadAttachment(att);
        if (!sniffMatches(category, dl.data)) {
          blockedNames.push(att?.filename || 'a file');
          continue;
        }
        const f = { filename: `${files.length + voiceNotes.length}_${safeFilename(att.filename)}`, ...dl };
        if (isVoiceNote(att, msg.flags || 0)) {
          voiceNotes.push({ ...f, duration_secs: att.duration_secs, waveform: att.waveform });
        } else {
          files.push(f);
        }
      } catch (err) {
        // A download can fail (CDN 500, timeout, reset). The sender must be
        // told: otherwise their message vanishes into silence while the
        // partner never receives it.
        logger.warn(`relay: download failed for ${uid}: ${err.message}`);
        failedDownloads.push(att?.filename || 'a file');
      }
    }
    if (blockedNames.length) {
      await reactDeliveryStatus(dmId, msg.id, false);
      await sendDM(uid, attachmentUnreadableCard(blockedNames));
      logger.info(`relay: blocked ${blockedNames.join(', ')} from ${uid} (content mismatch)`);
      return;
    }
    if (!content && !files.length && !voiceNotes.length) {
      // Nothing to relay at all: say why, honestly. A failed download is
      // not the sender's fault, so the notice says so and asks for a retry.
      if (failedDownloads.length) {
        await reactDeliveryStatus(dmId, msg.id, false);
        // Media-5: the too-big line must not be swallowed when downloads
        // also failed — append it to the same notice.
        const dlText = failedDownloads.length === 1
          ? 'Your file couldn\'t be downloaded, so nothing went through. Please try sending it again.'
          : `${failedDownloads.length} of your files couldn't be downloaded, so nothing went through. Please try sending them again.`;
        await sendDM(uid, simpleCard(skippedBig
          ? `${dlText} One file was also too big to pass along (20 MB max).`
          : dlText));
        return;
      }
      if (skippedBig) {
        // Media-5: the skippedBig-only path marks the message too.
        await reactDeliveryStatus(dmId, msg.id, false);
        await sendDM(uid, simpleCard('That file was too big to pass along. Keep it under 20 MB.'));
      }
      return;
    }

    // Voice notes go bare so the recipient gets the native voice player.
    let delivered = true;
    for (const vn of voiceNotes) {
      const r = await sendVoiceNote(partnerId, vn);
      if (!r.ok) delivered = false;
    }

    // Text + other attachments ride in the V2 container.
    if (relayText || files.length) {
      const { components, files: sendFiles } = relayMessage(relayText, files);
      const res = await sendDM(partnerId, components, sendFiles, { noMentions: true });
      if (!res.ok) delivered = false;
    }

    // Lifecycle BUG 5: the chat may have died mid-relay (a 403 self-heal
    // retry, an /end on either side). On a dead session skip the delivery
    // reaction and the stats bump, and tell the sender the chat ended
    // instead of marking anything delivered.
    if (db.getActiveSessionForUser(uid)?.session_id !== session.session_id) {
      await sendDM(uid, simpleCard('That chat just ended, so your message had nowhere to go. Use /new to meet someone new.'));
      return;
    }

    await reactDeliveryStatus(dmId, msg.id, delivered);
    if (!delivered) {
      await sendDM(uid, simpleCard("Couldn't deliver that. They may have closed their DMs."));
      return;
    }
    // Partial delivery failure: the relay went out, but be honest about
    // what didn't make it. Otherwise the sender assumes the partner got
    // everything. Oversized files silently skipped above (skippedBig) get
    // the same honesty treatment: text + a 25 MB video must not look like
    // a clean send to the sender.
    if (failedDownloads.length || skippedBig) {
      const missing = [];
      if (failedDownloads.length === 1) {
        missing.push(`"${failedDownloads[0]}" couldn't be downloaded and wasn't passed along`);
      } else if (failedDownloads.length > 1) {
        missing.push(`${failedDownloads.length} files couldn't be downloaded and weren't passed along`);
      }
      if (skippedBig) {
        missing.push('one file was too big to pass along (20 MB max)');
      }
      await sendDM(uid, simpleCard(
        `Your message went through, but ${missing.join(' and ')}. Everything else arrived fine.`));
    }

    // Session metrics for the end-of-chat summary: text messages and
    // attachments actually exchanged, plus the last-activity timestamp the
    // idle-timeout sweep reads. The duration clock itself runs from the
    // pairing millisecond (session.started_at) to the end millisecond.
    // Per-user counters feed the lifetime /stats; they only move on
    // delivered messages, so "exchanged" is literal.
    session.stats = session.stats || { text: 0, attachments: 0 };
    if (relayText) session.stats.text += 1;
    session.stats.attachments += files.length + voiceNotes.length;
    const perUser = (session.userStats ||= {});
    const mine = (perUser[uid] ||= { text: 0, attachments: 0 });
    if (relayText) mine.text += 1;
    // Every attachment kind (photos, video, files, voice notes, clips)
    // counts under the single attachments metric.
    mine.attachments += files.length + voiceNotes.length;
    session.lastActivityAt = Date.now();

    // Profanity accounting: one strike per flagged message, a warning DM on
    // every strike before the limit showing the remaining allowance, and
    // immediate termination on the message that reaches the limit (4 for
    // minor chats, 10 for adult chats).
    if (filtered.flagged && content) {
      await trackProfanity(uid, partnerId, session);
    }
  } catch (err) {
    logger.error('relay failed:', err);
  }
}

/** Test helper: reset relay rate-limit state. */
export function _resetRelayForTests() {
  msgTimes.clear();
  warnedAt.clear();
  hintedAt.clear();
}
