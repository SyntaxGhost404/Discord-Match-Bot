// Anonymous chat orchestration: queue, pairing, session lifecycle, reveals.
//
// Pairing is decided synchronously and committed with one transaction that
// requires both people to still be queued and not already chatting, so
// concurrent joins can never double-book anyone. Delivery problems (someone's
// DMs are closed) unwind cleanly: the reachable person goes back to the queue
// with their original place.

import type { App } from '../../core/app.ts';
import { chatScore, compatible, groupOf } from '../../domain/compatibility.ts';
import type { ChatSession, QueueEntry } from '../../db/repos/chat.ts';
import { partnerOf, sideOf } from '../../db/repos/chat.ts';
import { toMatchable, type CompleteProfile } from '../matching/service.ts';
import { Cooldowns } from '../../util/async.ts';
import { MINUTE } from '../../util/time.ts';
import {
  ICEBREAKERS,
  chatNotice,
  connectedCard,
  endedCard,
  icebreakerCard,
  revealCard,
  revealRequestedNotice,
  searchStoppedCard,
  searchingCard,
  summaryPayload,
} from './ui.ts';

export type ChatState = { kind: 'idle' } | { kind: 'queued'; entry: QueueEntry } | { kind: 'chatting'; session: ChatSession };

export type JoinOutcome =
  | { kind: 'queued'; entry: QueueEntry }
  | { kind: 'connected'; session: ChatSession }
  | { kind: 'already_queued'; entry: QueueEntry }
  | { kind: 'already_chatting'; session: ChatSession }
  | { kind: 'dm_closed' }
  | { kind: 'unavailable' };

export type EndReason = 'ended' | 'next' | 'idle' | 'block' | 'report' | 'banned' | 'deleted' | 'undeliverable';

/** Don't pair the same two people again within this window. */
const REPAIR_COOLDOWN = 30 * MINUTE;

export class ChatService {
  private readonly app: App;
  private readonly icebreakerCooldown = new Cooldowns(20_000);
  private readonly revealNoticeCooldown = new Cooldowns(60_000);

  constructor(app: App) {
    this.app = app;
  }

  state(userId: string): ChatState {
    const session = this.app.store.chat.activeFor(userId);
    if (session) return { kind: 'chatting', session };
    const entry = this.app.store.chat.queueEntry(userId);
    return entry ? { kind: 'queued', entry } : { kind: 'idle' };
  }

  /**
   * Joins the queue and tries to pair right away. With `announceInDm` the
   * searching card is also sent to the user's DMs (used when the search starts
   * in a server, which doubles as a check that DMs are open).
   */
  async join(userId: string, options: { announceInDm: boolean }): Promise<JoinOutcome> {
    const { store } = this.app;
    const now = this.app.clock();
    const profile = this.app.matching.profile(userId);
    if (!profile || !groupOf(profile, now)) return { kind: 'unavailable' };
    const current = this.state(userId);
    if (current.kind === 'chatting') return { kind: 'already_chatting', session: current.session };
    if (current.kind === 'queued') return { kind: 'already_queued', entry: current.entry };

    store.chat.enqueue(userId, now);
    if (options.announceInDm) {
      const sent = await this.app.dm.send(userId, searchingCard(now));
      if (!sent.ok) {
        store.chat.dequeue(userId);
        return { kind: 'dm_closed' };
      }
      store.chat.setQueueCard(userId, sent.channelId, sent.message.id);
    }
    const session = await this.matchUser(userId);
    if (session) return { kind: 'connected', session };
    const entry = store.chat.queueEntry(userId);
    if (entry) return { kind: 'queued', entry };
    // The pairing attempt failed in a way that removed us (e.g. our own DMs are closed).
    const after = this.state(userId);
    if (after.kind === 'chatting') return { kind: 'connected', session: after.session };
    return { kind: 'dm_closed' };
  }

  /** Remembers where the searching card lives so it can be cleaned up later. */
  setQueueCard(userId: string, channelId: string, messageId: string): void {
    this.app.store.chat.setQueueCard(userId, channelId, messageId);
  }

  /** Leaves the queue; returns the removed entry. */
  leave(userId: string): QueueEntry | null {
    return this.app.store.chat.dequeue(userId);
  }

  private candidateProfiles(entries: QueueEntry[]): Map<string, CompleteProfile> {
    const now = this.app.clock();
    const profiles = this.app.store.profiles.getMany(entries.map((e) => e.userId));
    const out = new Map<string, CompleteProfile>();
    for (const entry of entries) {
      const profile = profiles.get(entry.userId);
      const usable = profile && profile.stage === 'complete' && profile.birthDate && profile.visibility !== 'hidden' && !this.app.store.users.activeBan(entry.userId, now);
      if (usable) out.set(entry.userId, profile as CompleteProfile);
      else this.app.store.chat.dequeue(entry.userId);
    }
    return out;
  }

  private bestPartner(meId: string, queue: QueueEntry[], profiles: Map<string, CompleteProfile>, taken: ReadonlySet<string>): string | null {
    const now = this.app.clock();
    const me = profiles.get(meId);
    if (!me) return null;
    const recent = this.app.store.chat.recentPartners(meId, now - REPAIR_COOLDOWN);
    let best: { id: string; score: number } | null = null;
    for (const entry of queue) {
      if (entry.userId === meId || taken.has(entry.userId) || recent.has(entry.userId)) continue;
      const other = profiles.get(entry.userId);
      if (!other || !compatible(toMatchable(me), toMatchable(other), now)) continue;
      if (this.app.store.blocks.eitherWay(meId, entry.userId)) continue;
      // Shared ground first; among equals, whoever has waited longest.
      const waitedMinutes = (now - entry.joinedAt) / MINUTE;
      const score = chatScore(toMatchable(me), toMatchable(other)) + Math.min(waitedMinutes, 30) / 10;
      if (!best || score > best.score) best = { id: entry.userId, score };
    }
    return best?.id ?? null;
  }

  /** Finds a partner for one waiting user. */
  async matchUser(userId: string): Promise<ChatSession | null> {
    const queue = this.app.store.chat.queue();
    if (!queue.some((e) => e.userId === userId)) return null;
    const profiles = this.candidateProfiles(queue);
    const partner = this.bestPartner(userId, queue, profiles, new Set());
    return partner ? this.open(userId, partner, queue) : null;
  }

  /** Pairs everyone it can (periodic sweep). */
  async matchQueue(): Promise<number> {
    const queue = this.app.store.chat.queue();
    if (queue.length < 2) return 0;
    const profiles = this.candidateProfiles(queue);
    const taken = new Set<string>();
    const pairs: Array<[string, string]> = [];
    for (const entry of queue) {
      if (taken.has(entry.userId) || !profiles.has(entry.userId)) continue;
      const partner = this.bestPartner(entry.userId, queue, profiles, taken);
      if (!partner) continue;
      taken.add(entry.userId);
      taken.add(partner);
      pairs.push([entry.userId, partner]);
    }
    let opened = 0;
    for (const [a, b] of pairs) if (await this.open(a, b, queue)) opened++;
    return opened;
  }

  private async open(userA: string, userB: string, queueSnapshot: QueueEntry[]): Promise<ChatSession | null> {
    const { store, dm } = this.app;
    const now = this.app.clock();
    const profileA = this.app.matching.profile(userA);
    const profileB = this.app.matching.profile(userB);
    if (!profileA || !profileB) return null;
    const entryA = store.chat.queueEntry(userA) ?? queueSnapshot.find((e) => e.userId === userA);
    const entryB = store.chat.queueEntry(userB) ?? queueSnapshot.find((e) => e.userId === userB);
    const session = store.chat.createSession(userA, userB, groupOf(profileA, now) === 'teen', now);
    if (!session) return null;

    const [sentA, sentB] = await Promise.all([dm.send(userA, connectedCard(session, profileA, profileB)), dm.send(userB, connectedCard(session, profileB, profileA))]);

    if (!sentA.ok || !sentB.ok) {
      // Unwind: end the session and put whoever is reachable back in line.
      store.chat.end(session.id, 'undeliverable', null, now);
      for (const [sent, userId, entry] of [
        [sentA, userA, entryA],
        [sentB, userB, entryB],
      ] as const) {
        if (sent.ok) {
          await dm.delete(sent.channelId, sent.message.id);
          store.chat.enqueue(userId, now, entry?.joinedAt ?? now);
          if (entry?.cardChannelId && entry.cardMessageId) store.chat.setQueueCard(userId, entry.cardChannelId, entry.cardMessageId);
        } else if (entry?.cardChannelId && entry.cardMessageId) {
          await dm.edit(entry.cardChannelId, entry.cardMessageId, searchStoppedCard('unreachable', this.app.config.supportServerUrl));
        }
      }
      this.app.log.info('Chat pairing unwound: a participant could not be reached', { session: session.id });
      return null;
    }

    store.chat.setCard(session.id, 'a', sentA.message.id);
    store.chat.setCard(session.id, 'b', sentB.message.id);
    store.chat.advanceCursor(session.id, 'a', sentA.message.id);
    store.chat.advanceCursor(session.id, 'b', sentB.message.id);
    // Searching cards are replaced by the fresh "connected" message.
    for (const entry of [entryA, entryB]) {
      if (entry?.cardChannelId && entry.cardMessageId) await dm.delete(entry.cardChannelId, entry.cardMessageId);
    }
    this.app.log.info('Anonymous chat started', { session: session.id, teen: session.teen });
    return store.chat.get(session.id);
  }

  /**
   * Ends a live session exactly once and tells both people. `actorId` is
   * whoever caused the ending (ender, blocker, reporter, banned or deleted user).
   */
  async end(sessionId: number, reason: EndReason, actorId: string | null): Promise<ChatSession | null> {
    const ended = this.app.store.chat.end(sessionId, reason, actorId, this.app.clock());
    if (!ended) return null;
    await this.announceEnd(ended, actorId);
    return ended;
  }

  async endForUser(userId: string, reason: EndReason): Promise<ChatSession | null> {
    const session = this.app.store.chat.activeFor(userId);
    return session ? this.end(session.id, reason, userId) : null;
  }

  private async announceEnd(session: ChatSession, actorId: string | null): Promise<void> {
    const reason = (session.endReason ?? 'ended') as EndReason;
    for (const side of ['a', 'b'] as const) {
      const userId = side === 'a' ? session.userA : session.userB;
      const cardId = side === 'a' ? session.aCardId : session.bCardId;
      const channelId = this.app.store.users.get(userId)?.dmChannelId;
      if (channelId && cardId) await this.app.dm.edit(channelId, cardId, endedCard(session));
      const isActor = userId === actorId;
      if (isActor && (reason === 'banned' || reason === 'deleted')) continue;
      const role = isActor ? 'actor' : 'partner';
      const allowFeedback = !(isActor && (reason === 'block' || reason === 'report')) && session.aMessages + session.bMessages > 0;
      await this.app.dm.send(userId, summaryPayload(session, side, role, { allowFeedback }));
    }
  }

  /** Ends the current chat and immediately searches again. */
  async next(userId: string, announceInDm: boolean): Promise<{ ended: ChatSession | null; join: JoinOutcome }> {
    const ended = await this.endForUser(userId, 'next');
    const join = await this.join(userId, { announceInDm });
    return { ended, join };
  }

  /** Mutual identity reveal: nothing is shared until both have asked. */
  async reveal(sessionId: number, userId: string): Promise<'requested' | 'revealed' | 'already' | 'not_found'> {
    const { store } = this.app;
    const session = store.chat.activeFor(userId);
    if (!session || session.id !== sessionId) return 'not_found';
    if (session.revealedAt) return 'already';
    const side = sideOf(session, userId)!;
    const updated = store.chat.requestReveal(session.id, side);
    if (!updated) return 'not_found';
    const partnerId = partnerOf(updated, userId);
    if (!(updated.aReveal && updated.bReveal)) {
      if (this.revealNoticeCooldown.take(`${session.id}:${side}`)) await this.app.dm.send(partnerId, revealRequestedNotice());
      return 'requested';
    }
    const now = this.app.clock();
    const revealed = store.transaction(() => {
      if (!store.chat.markRevealed(session.id, now)) return false;
      store.matches.create(session.userA, session.userB, 'chat', now);
      return true;
    });
    if (!revealed) return 'already';
    for (const [viewer, other] of [
      [session.userA, session.userB],
      [session.userB, session.userA],
    ] as const) {
      const otherProfile = store.profiles.get(other);
      if (otherProfile) await this.app.dm.send(viewer, revealCard(otherProfile, store.photos.list(other), other, now));
    }
    this.app.log.info('Anonymous chat profiles revealed', { session: session.id });
    return 'revealed';
  }

  async icebreaker(sessionId: number, userId: string): Promise<'sent' | 'cooldown' | 'not_found'> {
    const session = this.app.store.chat.activeFor(userId);
    if (!session || session.id !== sessionId) return 'not_found';
    if (!this.icebreakerCooldown.take(String(session.id))) return 'cooldown';
    const question = ICEBREAKERS[Math.floor(Math.random() * ICEBREAKERS.length)]!;
    await Promise.all([this.app.dm.send(session.userA, icebreakerCard(question)), this.app.dm.send(session.userB, icebreakerCard(question))]);
    this.app.store.chat.touch(session.id, this.app.clock());
    return 'sent';
  }

  rate(sessionId: number, raterId: string, rating: 1 | -1): 'ok' | 'already' | 'not_found' {
    const session = this.app.store.chat.get(sessionId);
    if (!session) return 'not_found';
    const side = sideOf(session, raterId);
    if (!side) return 'not_found';
    const ratee = partnerOf(session, raterId);
    return this.app.store.chat.addFeedback(sessionId, raterId, ratee, rating, this.app.clock()) ? 'ok' : 'already';
  }

  /** Periodic upkeep: idle chats, stale searches, pending pairings. */
  async sweep(): Promise<void> {
    const { store } = this.app;
    const now = this.app.clock();
    for (const session of store.chat.idleSince(now - this.app.config.chat.idleMinutes * MINUTE)) {
      await this.end(session.id, 'idle', null);
    }
    const timeout = this.app.config.chat.queueTimeoutMinutes * MINUTE;
    for (const entry of store.chat.queue()) {
      if (entry.joinedAt >= now - timeout) continue;
      if (!store.chat.dequeue(entry.userId)) continue;
      if (entry.cardChannelId && entry.cardMessageId) {
        await this.app.dm.edit(entry.cardChannelId, entry.cardMessageId, searchStoppedCard('timeout'));
      } else {
        await this.app.dm.send(entry.userId, searchStoppedCard('timeout'));
      }
    }
    await this.matchQueue();
  }

  /** Small anonymous system notice to one participant. */
  async notify(userId: string, body: string): Promise<void> {
    await this.app.dm.send(userId, chatNotice(body));
  }
}
