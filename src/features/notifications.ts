// Job handlers: everything that is delivered asynchronously with retries.

import type { App } from '../core/app.ts';
import { PERMANENT_BAN } from '../db/repos/users.ts';
import { otherUser } from '../db/repos/social.ts';
import { PermanentJobError } from '../services/jobs.ts';
import type { DmResult } from '../services/dm.ts';
import { embedNotice, notice } from '../ui/common.ts';
import { discordTimestamp } from '../util/time.ts';
import { likeNoticeCard, matchCard } from './matching/ui.ts';
import { evidenceFile, reportMessage } from './moderation.ts';

/** Transient failures are retried; a closed DM or deleted user is final. */
function settle(result: DmResult): void {
  if (result.ok) return;
  if (result.reason === 'error' || result.reason === 'rate_limited') throw new Error(`DM failed: ${result.reason}`);
}

export function registerJobs(app: App): void {
  const { jobs, store } = app;

  jobs.register<{ userId: string }>('notify.like', async ({ userId }) => {
    const profile = app.matching.profile(userId);
    if (!profile?.likeAlerts || store.users.activeBan(userId, app.clock())) return;
    const count = app.matching.pendingCount(userId);
    if (count === 0) return;
    const result = await app.dm.send(userId, likeNoticeCard(count));
    if (result.ok) store.users.setLikeNoticeAt(userId, app.clock());
    settle(result);
  });

  jobs.register<{ matchId: number; userId: string }>('notify.match', async ({ matchId, userId }) => {
    const match = store.matches.get(matchId);
    if (!match || match.endedAt !== null) return;
    const viewer = app.matching.profile(userId);
    const otherId = otherUser(match, userId);
    const other = store.profiles.get(otherId);
    if (!viewer || !other) return;
    const result = await app.dm.send(
      userId,
      matchCard(other, store.photos.list(otherId), match, { now: app.clock(), viewer, continueWith: 'likes', intro: 'Someone you liked liked you back!' }),
    );
    settle(result);
  });

  jobs.register<{ userId: string }>('notify.ban', async ({ userId }) => {
    const ban = store.users.activeBan(userId, app.clock());
    if (!ban) return;
    const until = ban.until >= PERMANENT_BAN ? 'permanently' : `until ${discordTimestamp(ban.until, 'f')}`;
    settle(
      await app.dm.send(
        userId,
        embedNotice(`Your access to this bot has been suspended ${until}.${ban.reason ? `\n**Reason:** ${ban.reason}` : ''}`, 'danger', 'Access suspended'),
      ),
    );
  });

  jobs.register<{ userId: string; count: number }>('notify.photos_flagged', async ({ userId, count }) => {
    settle(
      await app.dm.send(
        userId,
        notice(`${count === 1 ? 'One of your photos was' : `${count} of your photos were`} removed from your profile because Discord's safety filter flagged ${count === 1 ? 'it' : 'them'}. Use \`/profile\` to add new ones.`, 'warning'),
      ),
    );
  });

  jobs.register<{ reportId: number; autoHidden?: boolean }>('mod.report', async ({ reportId, autoHidden }) => {
    const channelId = app.config.moderation.channelId;
    const report = store.reports.get(reportId);
    if (!channelId || !report || report.modMessageId) return;
    const file = evidenceFile(report);
    const payload = reportMessage(app, report, { autoHidden });
    if (file) payload.attachments = [{ id: 0, filename: file.name, description: 'Chat transcript as seen by the reporter' }];
    try {
      const message = await app.api.createMessage(channelId, payload, file ? [file] : undefined);
      store.reports.setModMessage(reportId, channelId, message.id);
    } catch (error) {
      if (error instanceof Error && /Missing (Access|Permissions)|Unknown Channel/i.test(error.message)) {
        throw new PermanentJobError(`Cannot post to MOD_CHANNEL_ID: ${error.message}`);
      }
      throw error;
    }
  });

  jobs.register<{ reportId: number }>('mod.refresh', async ({ reportId }) => {
    const report = store.reports.get(reportId);
    if (!report?.modChannelId || !report.modMessageId) return;
    await app.dm.edit(report.modChannelId, report.modMessageId, reportMessage(app, report));
  });
}
