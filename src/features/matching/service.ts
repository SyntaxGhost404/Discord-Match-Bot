// Discover, likes and matches — the Leo-Match-style core.
//
// Every state change happens inside one synchronous SQLite transaction
// together with the notification job it causes, so a like can never be saved
// without its notification (or vice versa), and double clicks are harmless.

import type { App } from '../../core/app.ts';
import { addYears, todayIso } from '../../domain/age.ts';
import { compatible, discoverScore, groupOf, adultAgeRange, type Matchable } from '../../domain/compatibility.ts';
import { isComplete, type Photo, type Profile } from '../../domain/profile.ts';
import type { MatchRecord } from '../../db/repos/social.ts';
import { otherUser } from '../../db/repos/social.ts';
import type { PendingLike } from '../../db/repos/profiles.ts';
import { DAY, MINUTE } from '../../util/time.ts';

export type CompleteProfile = Profile & { birthDate: string };

export type LikeResult =
  | { status: 'liked' }
  | { status: 'match'; match: MatchRecord; isNew: boolean }
  | { status: 'limit'; resetsAt: number }
  | { status: 'unavailable' };

export interface Candidate {
  profile: CompleteProfile;
  photos: Photo[];
}

/** Passed profiles come back after this long. */
export const PASS_COOLDOWN = 30 * DAY;
/** Minimum gap between two "you got likes" DMs. */
export const LIKE_NOTICE_GAP = 15 * MINUTE;

export function toMatchable(p: CompleteProfile): Matchable {
  return {
    userId: p.userId,
    birthDate: p.birthDate,
    gender: p.gender,
    languages: p.languages,
    interests: p.interests,
    lookingFor: p.lookingFor,
    showGenders: p.showGenders,
    ageMin: p.ageMin,
    ageMax: p.ageMax,
    sameLanguageOnly: p.sameLanguageOnly,
  };
}

const shiftDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

export class MatchingService {
  private readonly app: App;

  constructor(app: App) {
    this.app = app;
  }

  profile(userId: string): CompleteProfile | null {
    const profile = this.app.store.profiles.get(userId);
    return isComplete(profile) ? profile : null;
  }

  /** Can `viewer` interact with `target` right now? (age wall, preferences, blocks, bans) */
  eligible(viewer: CompleteProfile, target: Profile | null, options: { requireVisible: boolean }): target is CompleteProfile {
    if (!isComplete(target) || target.userId === viewer.userId) return false;
    if (target.visibility === 'hidden') return false;
    if (options.requireVisible && target.visibility !== 'visible') return false;
    const now = this.app.clock();
    if (this.app.store.users.activeBan(target.userId, now)) return false;
    if (this.app.store.blocks.eitherWay(viewer.userId, target.userId)) return false;
    return compatible(toMatchable(viewer), toMatchable(target), now);
  }

  /** Birth-date window used to pre-filter candidates in SQL (a superset; padded by a day). */
  birthWindow(viewer: CompleteProfile, now: number): { min: string; max: string } | null {
    const today = todayIso(now);
    const group = groupOf(viewer, now);
    if (!group) return null;
    if (group === 'teen') {
      const teenMin = shiftDays(addYears(today, -18), 1); // not yet 18
      const teenMax = addYears(today, -13); // at least 13
      const gapMin = addYears(viewer.birthDate, -2);
      const gapMax = addYears(viewer.birthDate, 2);
      return { min: shiftDays(teenMin > gapMin ? teenMin : gapMin, -1), max: shiftDays(teenMax < gapMax ? teenMax : gapMax, 1) };
    }
    const range = adultAgeRange(viewer, now);
    return { min: shiftDays(addYears(today, -(range.max + 1)), 0), max: shiftDays(addYears(today, -range.min), 1) };
  }

  nextCandidate(viewer: CompleteProfile): Candidate | null {
    const now = this.app.clock();
    const window = this.birthWindow(viewer, now);
    if (!window) return null;
    const store = this.app.store;
    const pool = store.profiles
      .discoverCandidates({ viewerId: viewer.userId, birthMin: window.min, birthMax: window.max, passCutoff: now - PASS_COOLDOWN, now, limit: 250 })
      .filter((p): p is CompleteProfile => isComplete(p) && compatible(toMatchable(viewer), toMatchable(p), now));
    if (!pool.length) return null;
    const ids = pool.map((p) => p.userId);
    const likedViewer = store.swipes.likersAmong(viewer.userId, ids);
    const photoCounts = store.photos.countActive(ids);
    const me = toMatchable(viewer);
    let best: { profile: CompleteProfile; score: number } | null = null;
    for (const profile of pool) {
      const score = discoverScore(me, toMatchable(profile), {
        likedViewer: likedViewer.has(profile.userId),
        photoCount: photoCounts.get(profile.userId) ?? 0,
        lastActiveAt: profile.lastActiveAt,
        now,
      });
      if (!best || score > best.score) best = { profile, score };
    }
    return best ? { profile: best.profile, photos: store.photos.list(best.profile.userId) } : null;
  }

  likesLeft(userId: string): { left: number; resetsAt: number | null } {
    const now = this.app.clock();
    const limit = this.app.config.limits.likesPerDay;
    const used = this.app.store.swipes.likesGivenSince(userId, now - DAY);
    const oldest = used >= limit ? this.app.store.swipes.oldestLikeSince(userId, now - DAY) : null;
    return { left: Math.max(0, limit - used), resetsAt: oldest === null ? null : oldest + DAY };
  }

  /**
   * Records a like. A like back from the inbox (`fromInbox`) works even if the
   * other person has paused their profile since liking.
   */
  like(actorId: string, targetId: string, options: { note?: string | null; fromInbox?: boolean; notifyActor?: boolean } = {}): LikeResult {
    const { store, jobs, config } = this.app;
    return store.transaction((): LikeResult => {
      const now = this.app.clock();
      const actor = this.profile(actorId);
      const target = store.profiles.get(targetId);
      if (!actor || !this.eligible(actor, target, { requireVisible: !options.fromInbox })) return { status: 'unavailable' };

      const reverse = store.swipes.get(targetId, actorId);
      const existing = store.swipes.get(actorId, targetId);
      if (existing?.kind !== 'like') {
        // A like back always goes through; fresh likes respect the daily limit.
        if (reverse?.kind !== 'like') {
          const used = store.swipes.likesGivenSince(actorId, now - DAY);
          if (used >= config.limits.likesPerDay) {
            const oldest = store.swipes.oldestLikeSince(actorId, now - DAY) ?? now;
            return { status: 'limit', resetsAt: oldest + DAY };
          }
        }
        store.swipes.record(actorId, targetId, 'like', options.note ?? null, now);
      }

      if (reverse?.kind === 'like') {
        const { match, created } = store.matches.create(actorId, targetId, 'discover', now);
        if (created) {
          jobs.enqueue('notify.match', { matchId: match.id, userId: targetId }, { dedupeKey: `match:${match.id}:${targetId}` });
          if (options.notifyActor) jobs.enqueue('notify.match', { matchId: match.id, userId: actorId }, { dedupeKey: `match:${match.id}:${actorId}` });
        }
        return { status: 'match', match, isNew: created };
      }

      if (existing?.kind !== 'like' && target.likeAlerts) {
        const lastNotice = store.users.get(targetId)?.likeNoticeAt ?? 0;
        const delayMs = Math.max(0, lastNotice + LIKE_NOTICE_GAP - now) + 3_000;
        jobs.enqueue('notify.like', { userId: targetId }, { dedupeKey: `likes:${targetId}`, delayMs });
      }
      return { status: 'liked' };
    });
  }

  pass(actorId: string, targetId: string): void {
    if (actorId === targetId) return;
    this.app.store.swipes.record(actorId, targetId, 'pass', null, this.app.clock());
  }

  /** Likes waiting for an answer, re-checked against the safety rules. */
  pendingLikes(viewer: CompleteProfile, limit = 25): PendingLike[] {
    return this.app.store.profiles
      .pendingLikes(viewer.userId, this.app.clock(), limit * 2)
      .filter((like) => this.eligible(viewer, like.profile, { requireVisible: false }))
      .slice(0, limit);
  }

  pendingCount(userId: string): number {
    const viewer = this.profile(userId);
    return viewer ? this.pendingLikes(viewer, 99).length : 0;
  }

  /** Ends a match for both people. Only a participant may do it. */
  unmatch(matchId: number, userId: string): MatchRecord | null {
    const match = this.app.store.matches.get(matchId);
    if (!match || match.endedAt !== null || (match.userLow !== userId && match.userHigh !== userId)) return null;
    return this.app.store.matches.end(matchId, userId, this.app.clock()) ? match : null;
  }

  /** The other person in a match the user belongs to (active matches only). */
  activeMatchFor(matchId: number, userId: string): { match: MatchRecord; otherId: string } | null {
    const match = this.app.store.matches.get(matchId);
    if (!match || match.endedAt !== null || (match.userLow !== userId && match.userHigh !== userId)) return null;
    return { match, otherId: otherUser(match, userId) };
  }
}
