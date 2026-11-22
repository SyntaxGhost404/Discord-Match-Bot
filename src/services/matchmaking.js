// Matchmaking service: tier-first pairing with a dynamic sliding window.
//
// Safety design:
//   - 13-17 and 18+ NEVER pair. The tier wall is absolute and checked FIRST,
//     before any gap math, so no window can ever leak across the 18.0 line.
//   - Within the minor tier there are no fixed sub-bands. Compatibility is a
//     sliding window: at most 2.0 exact years apart by date of birth
//     (calendar-accurate, so a 15.0yo pairs with a 16.5yo but never a 17.5yo).
//     The minor cap never expands with wait time; longer waits for minors
//     are an intentional safety tradeoff.
//   - Adults prefer close ages: 5 year window at first, widening by 1 year
//     per 30 seconds of waiting, capped at 15.
//   - Within the allowed set, the smallest exact age difference wins; ties
//     go to the longest waiter.
//   - Pairs where either side blocked the other are skipped, so a blocked
//     user waits instead of being matched with their blocker.
//
// Ages and gaps derive on the fly from each waiter's stored date of birth,
// so a birthday mid-queue moves them to the right tier automatically.
// A user whose date of birth is unknown is treated as a minor (fail-safe).

import { db } from './database.js';
import { ageFromDOB, tierOfAge, isLeapYear, withinYears } from '../utils/dob.js';

const queue = []; // [{ userId, anonymousId, joinedAt }]
const stats = { matched: 0, totalWaitMs: 0 }; // lifetime, reset on restart

const MINOR_MAX_GAP_YEARS = 2; // hard cap, never expands
const ADULT_BASE_GAP_YEARS = 5;
const ADULT_MAX_GAP_YEARS = 15;
const EXPAND_EVERY_MS = 30_000; // adults widen 1 year per 30s waited

/** Stored ISO dob for a queue entry, or null when unknown. */
function dobOfEntry(entry) {
  const p = db.getUserProfile(entry.userId);
  return p && p.dob ? p.dob : null;
}

/**
 * Widest age gap (whole years) this waiter currently accepts. Minors are
 * pinned at 2.0: the window strictly halts there and never crosses into
 * adulthood. Adults widen with wait time.
 */
function capFor(entry, dob) {
  const age = dob ? ageFromDOB(dob) : null;
  if (tierOfAge(age) === 'minor') return MINOR_MAX_GAP_YEARS;
  const steps = Math.floor(Math.max(0, Date.now() - entry.joinedAt) / EXPAND_EVERY_MS);
  return Math.min(ADULT_MAX_GAP_YEARS, ADULT_BASE_GAP_YEARS + steps);
}

/**
 * Per-sweep derived values for one queue entry, computed ONCE per sweep so
 * the O(n^2) inner pair loop does no date parsing, no Date construction and
 * no db lookups: age, tier, widened cap, dob epoch ms and dob components.
 * Pure data; scoring semantics are identical to the per-pair helper calls.
 */
function deriveEntry(entry, now, nowDate) {
  const dob = dobOfEntry(entry);
  let age = null, tier = 'minor', y = 0, m = 0, d = 0, ms = 0;
  if (dob) {
    const parts = String(dob).split('-');
    y = Number(parts[0]); m = Number(parts[1]); d = Number(parts[2]);
    ms = Date.UTC(y, m - 1, d);
    age = ageFromDOB(dob, nowDate);
    tier = tierOfAge(age);
  }
  let cap;
  if (tier === 'minor') {
    cap = MINOR_MAX_GAP_YEARS;
  } else {
    const steps = Math.floor(Math.max(0, now - entry.joinedAt) / EXPAND_EVERY_MS);
    cap = Math.min(ADULT_MAX_GAP_YEARS, ADULT_BASE_GAP_YEARS + steps);
  }
  return { entry, dob, age, tier, y, m, d, ms, cap };
}

/**
 * Calendar-accurate "at most `years` apart", arithmetic version of
 * withinYears() over precomputed dob components: the younger birth date must
 * fall within `years` calendar years of the older one (Feb 29 clamps to
 * Feb 28 on non-leap years). Identical results to the string-compare form,
 * with no parsing in the hot loop.
 */
function withinYearsFast(oy, om, od, youngerMs, years) {
  const ly = oy + years;
  const ld = (om === 2 && od === 29 && !isLeapYear(ly)) ? 28 : od;
  return youngerMs <= Date.UTC(ly, om - 1, ld);
}

/**
 * Eligibility + score for a candidate pair, over precomputed derived
 * entries. Tier is verified first (the hard wall), then the sliding window:
 * both sides must accept the exact gap (withinYears is symmetric in the
 * dobs and monotone in the cap, so one check with the tighter cap is
 * equivalent to the old two-call form). Lower exact gap scores better;
 * ties go to the pair that waited longest. Returns null when ineligible.
 */
function pairScore(A, B) {
  const a = A.entry, b = B.entry;
  if (a.userId === b.userId) return null;
  if (db.isBlockedBetween(a.userId, b.userId)) return null;
  if (A.tier !== B.tier) return null; // hard minor/adult wall
  const waited = Math.min(a.joinedAt, b.joinedAt);
  // Unknown DOB: eligible (fail-safe) but sorts last, so a closer real pair
  // is never stolen by a zero-gap unknown. (cycle-2 fix)
  if (!A.dob || !B.dob) return { gap: Infinity, waited };
  const gap = Math.abs(A.ms - B.ms) / 31557600000; // 365.25 days in ms (== gapYears)
  const older = A.ms <= B.ms ? A : B;
  const youngerMs = A.ms <= B.ms ? B.ms : A.ms;
  if (!withinYearsFast(older.y, older.m, older.d, youngerMs, Math.min(A.cap, B.cap))) return null;
  return { gap, waited };
}

function isBetter(score, best) {
  return !best || score.gap < best.score.gap
    || (score.gap === best.score.gap && score.waited < best.score.waited);
}

/** Remove two entries and build the match result shape. The removed queue
 *  entries ride along as `entries` so a fizzled match (a greeting DM that
 *  never lands) can re-queue both sides with their original joinedAt. */
function takePair(a, b) {
  matchmaking.removeFromQueue(a.userId);
  matchmaking.removeFromQueue(b.userId);
  stats.matched += 1;
  stats.totalWaitMs += Math.max(0, Date.now() - Math.min(a.joinedAt, b.joinedAt));
  return {
    user1: { user_id: a.userId, anonymous_id: a.anonymousId },
    user2: { user_id: b.userId, anonymous_id: b.anonymousId },
    entries: [a, b],
  };
}

export const matchmaking = {
  /**
   * Add a user to the queue. Returns false when they are already queued.
   * The optional `joinedAt` is honored so a fizzled match can restore both
   * sides without losing their gap-expansion progress (fairness).
   */
  addToQueue(userId, anonymousId, joinedAt = Date.now()) {
    const uid = String(userId);
    if (this.getQueuePosition(uid)) return false;
    queue.push({
      userId: uid,
      anonymousId: anonymousId || db.getAnonId(uid),
      joinedAt: Number.isFinite(joinedAt) ? joinedAt : Date.now(),
    });
    return true;
  },

  removeFromQueue(userId) {
    const uid = String(userId);
    const i = queue.findIndex((e) => e.userId === uid);
    if (i >= 0) queue.splice(i, 1);
  },

  /** 1-based position in line, or null when not queued. */
  getQueuePosition(userId) {
    const i = queue.findIndex((e) => e.userId === String(userId));
    return i >= 0 ? i + 1 : null;
  },

  getQueueSize() {
    return queue.length;
  },

  /**
   * Record the message id of the user's CURRENT searching card. The Cancel
   * button on old searching cards stays clickable in DM history, so
   * handleQueueCancel compares the pressed card against this id and treats
   * anything else as a stale press (same pattern as isLiveGreetingPress).
   * The id dies with the queue entry: matching, /leave and a successful
   * cancel all remove the entry, clearing the stored id automatically.
   */
  setSearchingCardId(userId, messageId) {
    const e = queue.find((x) => x.userId === String(userId));
    if (e) e.searchingCardId = messageId ? String(messageId) : null;
  },

  /** The message id of the user's current searching card, or null. */
  getSearchingCardId(userId) {
    const e = queue.find((x) => x.userId === String(userId));
    return e && e.searchingCardId ? String(e.searchingCardId) : null;
  },

  /**
   * The waiters who could actually be paired with `userId` right now: same
   * tier, within the sliding window both sides currently accept (the
   * window is mutual: a pairing only happens when both waiters accept the
   * exact gap), and not blocked in either direction (pairScore rejects
   * blocked pairs, so counting them here would show phantom slots).
   * In join order, including the user themselves when queued.
   */
  getEligiblePool(userId) {
    const uid = String(userId);
    const me = queue.find((e) => e.userId === uid) || { userId: uid, joinedAt: Date.now() };
    const myDob = dobOfEntry(me);
    const myTier = tierOfAge(myDob ? ageFromDOB(myDob) : null);
    const myCap = capFor(me, myDob);
    return queue.filter((e) => {
      if (db.isBlockedBetween(uid, e.userId)) return false;
      const d = dobOfEntry(e);
      if (tierOfAge(d ? ageFromDOB(d) : null) !== myTier) return false;
      if (!myDob || !d) return true; // unknown dob: tier check only (fail-safe)
      return withinYears(myDob, d, Math.min(myCap, capFor(e, d)));
    });
  },

  /**
   * Queue numbers scoped to the user's eligible pool: 1-based position among
   * waiters who can actually be paired with them, plus the pool size.
   * Returns null when the user is not in the queue.
   */
  getEligibleQueueStats(userId) {
    const uid = String(userId);
    const pool = this.getEligiblePool(uid);
    const i = pool.findIndex((e) => e.userId === uid);
    return i >= 0 ? { position: i + 1, size: pool.length } : null;
  },

  /**
   * Pair `userId`: first the best eligible partner for the newcomer, else
   * the best pair among all waiters (lets gap expansion resolve for long
   * waiters even when the newcomer fits nobody). The minor/adult wall is
   * never crossed. Removes the pair from the queue. Returns
   * { user1: { user_id, anonymous_id }, user2: {...}, entries: [a, b] } or
   * null (entries are the removed queue snapshots, for fizzle re-queue).
   */
  findMatch(userId) {
    const uid = String(userId);
    // Derived values hoisted: one pass over the queue, then the pair loop
    // is pure arithmetic (same shape as tryMatchWaiters below).
    const now = Date.now();
    const derived = queue.map((e) => deriveEntry(e, now, new Date(now)));
    const meIdx = derived.findIndex((D) => D.entry.userId === uid);
    if (meIdx < 0) return null;
    const me = derived[meIdx];

    let best = null;
    for (let i = 0; i < derived.length; i++) {
      if (i === meIdx) continue;
      const score = pairScore(me, derived[i]);
      if (score && isBetter(score, best)) best = { entry: derived[i].entry, score };
    }
    if (best) return takePair(me.entry, best.entry);
    return this.tryMatchWaiters();
  },

  /**
   * Pair the best eligible two waiters, regardless of who is newest. Used
   * by the periodic sweep so waiting users match as their accepted age gap
   * widens, without needing a new join to trigger it.
   */
  tryMatchWaiters() {
    // Hoist per-entry derived values (age, tier, widened cap, dob epoch ms)
    // once per sweep: the inner pair loop becomes pure arithmetic instead
    // of re-parsing DOBs and rebuilding Dates for every pair. Pairing and
    // ordering semantics are unchanged.
    const now = Date.now();
    const derived = queue.map((e) => deriveEntry(e, now, new Date(now)));
    let best = null;
    for (let i = 0; i < derived.length; i++) {
      for (let j = i + 1; j < derived.length; j++) {
        const score = pairScore(derived[i], derived[j]);
        if (score && isBetter(score, best)) best = { a: derived[i].entry, b: derived[j].entry, score };
      }
    }
    if (!best) return null;
    return takePair(best.a, best.b);
  },

  /** { total, avgWaitTime } with avgWaitTime in minutes (reference stats.js shape). */
  getQueueStats() {
    return {
      total: queue.length,
      avgWaitTime: stats.matched ? stats.totalWaitMs / stats.matched / 60000 : 0,
    };
  },

  /** Test helper: clear queue + lifetime stats. */
  _resetForTests() {
    queue.length = 0;
    stats.matched = 0;
    stats.totalWaitMs = 0;
  },

  /** Test helper: backdate a waiter's join time (exercises gap expansion). */
  _setJoinedAtForTests(userId, ts) {
    const e = queue.find((x) => x.userId === String(userId));
    if (e) e.joinedAt = ts;
  },

  /** Test helper: read a waiter's join time (asserts joinedAt preservation). */
  _getJoinedAtForTests(userId) {
    const e = queue.find((x) => x.userId === String(userId));
    return e ? e.joinedAt : null;
  },
};

/**
 * Queue eviction for bans: database.js cannot import this module (it would
 * be circular — this file already imports db), so the queue registers its
 * own removal hook here. db.banUser calls it so a banned-while-queued user
 * leaves the queue at once instead of lingering in eligible-pool counts.
 */
if (typeof db.setQueueEvictor === 'function') {
  db.setQueueEvictor((userId) => { matchmaking.removeFromQueue(userId); });
}
