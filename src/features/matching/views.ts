// Turns current state into the right card, so every entry point (commands,
// buttons, notifications, report flows) shows the same thing.

import type { MessagePayload } from '../../discord/types.ts';
import type { App } from '../../core/app.ts';
import { otherUser } from '../../db/repos/social.ts';
import {
  MATCHES_PAGE_SIZE,
  discoverCard,
  discoverEmptyCard,
  likeLimitCard,
  likesCard,
  likesEmptyCard,
  matchDetailCard,
  matchesListCard,
} from './ui.ts';
import type { CompleteProfile } from './service.ts';

function viewer(app: App, userId: string): CompleteProfile {
  const profile = app.matching.profile(userId);
  if (!profile) throw new Error('A complete profile is required here');
  return profile;
}

export function discoverView(app: App, userId: string, notice?: string): MessagePayload {
  const me = viewer(app, userId);
  const pendingLikes = app.matching.pendingCount(userId);
  const quota = app.matching.likesLeft(userId);
  if (quota.left === 0 && quota.resetsAt) return likeLimitCard(quota.resetsAt, pendingLikes);
  const candidate = app.matching.nextCandidate(me);
  if (!candidate) return discoverEmptyCard(notice);
  return discoverCard(me, candidate.profile, candidate.photos, { ref: app.store.refs.refFor(candidate.profile.userId), now: app.clock(), notice, pendingLikes });
}

/** Shows one specific candidate again (e.g. after a rejected note). */
export function candidateView(app: App, userId: string, targetId: string, notice: string): MessagePayload {
  const me = viewer(app, userId);
  const target = app.store.profiles.get(targetId);
  if (!app.matching.eligible(me, target, { requireVisible: true })) return discoverView(app, userId, notice);
  return discoverCard(me, target, app.store.photos.list(targetId), {
    ref: app.store.refs.refFor(targetId),
    now: app.clock(),
    notice,
    pendingLikes: app.matching.pendingCount(userId),
  });
}

export function likesView(app: App, userId: string, notice?: string): MessagePayload {
  const me = viewer(app, userId);
  const pending = app.matching.pendingLikes(me);
  const first = pending[0];
  if (!first) return likesEmptyCard(notice);
  return likesCard(first.profile, app.store.photos.list(first.profile.userId), {
    ref: app.store.refs.refFor(first.profile.userId),
    now: app.clock(),
    viewer: me,
    note: first.note,
    remaining: pending.length - 1,
    notice,
  });
}

export function matchesView(app: App, userId: string, page: number, notice?: string): MessagePayload {
  const total = app.store.matches.countActive(userId);
  const pages = Math.max(1, Math.ceil(total / MATCHES_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), pages - 1);
  const matches = app.store.matches.listActive(userId, safePage * MATCHES_PAGE_SIZE, MATCHES_PAGE_SIZE);
  const profiles = app.store.profiles.getMany(matches.map((m) => otherUser(m, userId)));
  const entries = matches.map((match) => {
    const otherId = otherUser(match, userId);
    return { match, otherId, other: profiles.get(otherId) ?? null };
  });
  return matchesListCard(entries, { now: app.clock(), page: safePage, total, notice });
}

export function matchDetailView(app: App, userId: string, matchId: number): MessagePayload {
  const found = app.matching.activeMatchFor(matchId, userId);
  const other = found ? app.store.profiles.get(found.otherId) : null;
  if (!found || !other) return matchesView(app, userId, 0, '⚠️ That match is no longer available.');
  return matchDetailCard(other, app.store.photos.list(found.otherId), found.match, { now: app.clock(), viewer: viewer(app, userId) });
}
