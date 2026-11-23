// Blocking, reporting and moderation actions.
//
// Reports from chats carry evidence: the last messages of the conversation
// exactly as the reporter saw them (read back from their DM with the bot).
// Profiles reported by several different people are hidden automatically
// until a moderator reviews them.

import type { App } from '../../core/app.ts';
import type { EvidenceLine, ReportContext, ReportRecord } from '../../db/repos/moderation.ts';
import { PERMANENT_BAN } from '../../db/repos/users.ts';
import { partnerOf } from '../../db/repos/chat.ts';
import { truncate } from '../../domain/text.ts';
import { DAY } from '../../util/time.ts';

export const AUTO_HIDE_REPORTERS = 3;
export const AUTO_HIDE_WINDOW = 7 * DAY;
const EVIDENCE_MESSAGES = 50;

export interface ReportInput {
  reporterId: string;
  targetId: string;
  context: ReportContext;
  reason: string;
  details: string;
  block: boolean;
  sessionId?: number;
  note?: string | null;
}

export type ReportOutcome = { ok: true; report: ReportRecord; autoHidden: boolean } | { ok: false; reason: 'limit' | 'self' };

export class SafetyService {
  private readonly app: App;

  constructor(app: App) {
    this.app = app;
  }

  /** Blocks someone: no more discovery, likes, matches or chats between the two. */
  async block(blockerId: string, blockedId: string, context: string): Promise<boolean> {
    if (blockerId === blockedId) return false;
    const { store } = this.app;
    const now = this.app.clock();
    const added = store.transaction(() => {
      store.users.ensure(blockedId, now);
      const created = store.blocks.add(blockerId, blockedId, context, now);
      store.matches.endBetween(blockerId, blockedId, blockerId, now);
      return created;
    });
    const session = store.chat.activeFor(blockerId);
    if (session && partnerOf(session, blockerId) === blockedId) await this.app.chat.end(session.id, 'block', blockerId);
    return added;
  }

  unblock(blockerId: string, blockedId: string): boolean {
    return this.app.store.blocks.remove(blockerId, blockedId);
  }

  async report(input: ReportInput): Promise<ReportOutcome> {
    const { store, jobs, config } = this.app;
    if (input.reporterId === input.targetId) return { ok: false, reason: 'self' };
    const now = this.app.clock();
    if (store.reports.countByReporterSince(input.reporterId, now - DAY) >= config.limits.reportsPerDay) return { ok: false, reason: 'limit' };

    const evidence = input.context === 'chat' && input.sessionId !== undefined ? await this.chatEvidence(input.sessionId, input.reporterId) : this.profileEvidence(input.targetId, input.note);

    const { report, autoHidden } = store.transaction(() => {
      const created = store.reports.create(
        { reporterId: input.reporterId, targetId: input.targetId, context: input.context, reason: input.reason, details: input.details, evidence },
        now,
      );
      if (input.block) {
        store.users.ensure(input.targetId, now);
        store.blocks.add(input.reporterId, input.targetId, `report:${input.context}`, now);
        store.matches.endBetween(input.reporterId, input.targetId, input.reporterId, now);
      }
      let hidden = false;
      const profile = store.profiles.get(input.targetId);
      if (profile && profile.visibility !== 'hidden' && store.reports.distinctOpenReportersSince(input.targetId, now - AUTO_HIDE_WINDOW) >= AUTO_HIDE_REPORTERS) {
        store.profiles.update(input.targetId, { visibility: 'hidden' }, now);
        store.modActions.log({ moderatorId: this.app.info.id, targetId: input.targetId, action: 'auto_hide', reason: `${AUTO_HIDE_REPORTERS}+ reports in 7 days` }, now);
        hidden = true;
      }
      jobs.enqueue('mod.report', { reportId: created.id, autoHidden: hidden }, { dedupeKey: `mod.report:${created.id}` });
      return { report: created, autoHidden: hidden };
    });

    // Reporting a chat partner always closes the chat.
    const session = store.chat.activeFor(input.reporterId);
    if (session && partnerOf(session, input.reporterId) === input.targetId) await this.app.chat.end(session.id, 'report', input.reporterId);
    this.app.log.info('Report filed', { report: report.id, context: input.context, reason: input.reason, autoHidden });
    return { ok: true, report, autoHidden };
  }

  /** The conversation as the reporter saw it, read back from their DM with the bot. */
  private async chatEvidence(sessionId: number, reporterId: string): Promise<EvidenceLine[]> {
    const { store, api } = this.app;
    const session = store.chat.get(sessionId);
    if (!session || (session.userA !== reporterId && session.userB !== reporterId)) return [];
    const channelId = store.users.get(reporterId)?.dmChannelId;
    const after = session.userA === reporterId ? session.aCardId : session.bCardId;
    if (!channelId || !after) return [];
    try {
      const messages = await api.getMessages(channelId, { after, limit: 100 });
      const lines: EvidenceLine[] = [];
      for (const message of messages.reverse()) {
        const at = Date.parse(message.timestamp);
        const extras = message.attachments?.length ? ` [${message.attachments.length} attachment(s)]` : '';
        if (message.author?.id === reporterId) {
          if (store.chat.relayBySource(message.id)?.sessionId === sessionId) lines.push({ at, from: 'reporter', text: truncate(message.content + extras, 1000) });
        } else if (message.author?.bot && store.chat.relayByCopy(message.id)?.sessionId === sessionId) {
          lines.push({ at, from: 'reported', text: truncate(message.content + extras, 1000) });
        }
      }
      return lines.slice(-EVIDENCE_MESSAGES);
    } catch (error) {
      this.app.log.warn('Could not collect chat evidence', { sessionId, error });
      return [];
    }
  }

  private profileEvidence(targetId: string, note?: string | null): EvidenceLine[] {
    const profile = this.app.store.profiles.get(targetId);
    if (!profile) return [];
    const at = this.app.clock();
    const lines: EvidenceLine[] = [{ at, from: 'reported', text: `Profile name: ${profile.name}` }];
    if (profile.location) lines.push({ at, from: 'reported', text: `Location: ${profile.location}` });
    if (profile.bio) lines.push({ at, from: 'reported', text: `Bio: ${profile.bio}` });
    if (note) lines.push({ at, from: 'reported', text: `Note with their like: ${note}` });
    return lines;
  }

  // -- moderator actions -----------------------------------------------------------------

  async ban(input: { targetId: string; durationMs: number | 'permanent'; reason: string; moderatorId: string; reportId?: number | null; notify: boolean }): Promise<void> {
    const { store, jobs } = this.app;
    const now = this.app.clock();
    const until = input.durationMs === 'permanent' ? PERMANENT_BAN : now + input.durationMs;
    const resolved = store.transaction(() => {
      store.users.ensure(input.targetId, now);
      store.users.ban(input.targetId, until, input.reason, input.moderatorId);
      store.chat.dequeue(input.targetId);
      store.modActions.log({ moderatorId: input.moderatorId, targetId: input.targetId, action: 'ban', reason: input.reason, reportId: input.reportId ?? null }, now);
      const label = input.durationMs === 'permanent' ? 'banned permanently' : `banned ${Math.round(input.durationMs / DAY)}d`;
      const closed = store.reports.resolveAllAgainst(input.targetId, 'actioned', input.moderatorId, label, now);
      if (input.notify) jobs.enqueue('notify.ban', { userId: input.targetId }, { dedupeKey: `ban:${input.targetId}:${now}` });
      for (const report of closed) jobs.enqueue('mod.refresh', { reportId: report.id }, { dedupeKey: `mod.refresh:${report.id}` });
      return closed.length;
    });
    await this.app.chat.endForUser(input.targetId, 'banned');
    this.app.log.info('User banned', { target: input.targetId, by: input.moderatorId, reportsClosed: resolved });
  }

  unban(targetId: string, moderatorId: string): boolean {
    const { store } = this.app;
    const now = this.app.clock();
    return store.transaction(() => {
      const lifted = store.users.unban(targetId);
      if (lifted) store.modActions.log({ moderatorId, targetId, action: 'unban' }, now);
      return lifted;
    });
  }

  setHidden(targetId: string, hidden: boolean, moderatorId: string, reportId?: number): boolean {
    const { store, jobs } = this.app;
    const now = this.app.clock();
    return store.transaction(() => {
      const profile = store.profiles.get(targetId);
      if (!profile) return false;
      store.profiles.update(targetId, { visibility: hidden ? 'hidden' : 'visible' }, now);
      store.modActions.log({ moderatorId, targetId, action: hidden ? 'hide' : 'unhide', reportId: reportId ?? null }, now);
      if (hidden && reportId !== undefined && store.reports.resolve(reportId, 'actioned', moderatorId, 'profile hidden', now)) {
        jobs.enqueue('mod.refresh', { reportId }, { dedupeKey: `mod.refresh:${reportId}` });
      }
      if (!hidden) {
        for (const report of store.reports.resolveAllAgainst(targetId, 'dismissed', moderatorId, 'profile restored', now)) {
          jobs.enqueue('mod.refresh', { reportId: report.id }, { dedupeKey: `mod.refresh:${report.id}` });
        }
      }
      return true;
    });
  }

  dismiss(reportId: number, moderatorId: string): boolean {
    const { store, jobs } = this.app;
    const now = this.app.clock();
    return store.transaction(() => {
      const report = store.reports.get(reportId);
      if (!report || !store.reports.resolve(reportId, 'dismissed', moderatorId, 'dismissed', now)) return false;
      store.modActions.log({ moderatorId, targetId: report.targetId, action: 'dismiss', reportId }, now);
      jobs.enqueue('mod.refresh', { reportId }, { dedupeKey: `mod.refresh:${reportId}` });
      return true;
    });
  }

  async removePhotos(targetId: string, moderatorId: string): Promise<number> {
    const { store } = this.app;
    const now = this.app.clock();
    const removed = store.transaction(() => {
      const photos = store.photos.removeAll(targetId);
      if (photos.length) store.modActions.log({ moderatorId, targetId, action: 'remove_photos' }, now);
      return photos;
    });
    await this.app.photos.discard(removed);
    return removed.length;
  }
}
