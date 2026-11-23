// Moderator tools. Reports arrive in MOD_CHANNEL_ID as classic embeds (dense,
// scannable data) with action buttons; /mod offers lookups and manual actions.
// Every action is permission-checked server-side and written to mod_actions.

import { button, checkbox, choice, classic, label, modal, radioGroup, row, textInput } from '../discord/components/builders.ts';
import type { Embed, FileUpload, MessagePayload, Modal } from '../discord/types.ts';
import { cid } from '../interactions/custom-id.ts';
import { commandOptions, modalValues, optionValue, type AnyContext } from '../interactions/context.ts';
import type { Router } from '../interactions/router.ts';
import type { App } from '../core/app.ts';
import { GENDERS, REPORT_REASONS, findItem } from '../domain/catalog.ts';
import { profileAge, profileGroup, photoUrl } from '../domain/profile.ts';
import { truncate } from '../domain/text.ts';
import type { ReportRecord } from '../db/repos/moderation.ts';
import { PERMANENT_BAN } from '../db/repos/users.ts';
import { Colors } from '../ui/theme.ts';
import { embedNotice, isV2Message } from '../ui/common.ts';
import { isSnowflake, snowflakeTime } from '../util/snowflake.ts';
import { DAY, discordTimestamp } from '../util/time.ts';

const DURATIONS: Record<string, number | 'permanent'> = { '1d': DAY, '7d': 7 * DAY, '30d': 30 * DAY, permanent: 'permanent' };
const reasonLabel = (key: string) => findItem(REPORT_REASONS, key)?.label ?? key;

// -- views -----------------------------------------------------------------------------

export function reportMessage(app: App, report: ReportRecord, options: { autoHidden?: boolean } = {}): MessagePayload {
  const { store } = app;
  const history = store.reports.countAgainst(report.targetId);
  const target = store.users.get(report.targetId);
  const open = report.status === 'open';
  const fields: Embed['fields'] = [
    { name: 'Reported', value: `<@${report.targetId}>\n\`${report.targetId}\`${target?.username ? `\n${target.username}` : ''}`, inline: true },
    { name: 'Reporter', value: `<@${report.reporterId}>\n\`${report.reporterId}\``, inline: true },
    { name: 'Where', value: { profile: 'Discover profile', like: 'Like / note', match: 'Match', chat: 'Anonymous chat' }[report.context], inline: true },
    { name: 'Details', value: report.details ? truncate(report.details, 1000) : '—' },
    { name: 'History', value: `${history.total} report(s), ${history.open} open`, inline: true },
  ];
  if (report.evidence.length) fields.push({ name: 'Evidence', value: `${report.evidence.length} line(s) attached as a file`, inline: true });
  if (options.autoHidden) fields.push({ name: 'Auto-moderation', value: 'Profile hidden automatically (several reports)', inline: false });
  if (!open) fields.push({ name: 'Resolution', value: `${report.resolution ?? report.status} by <@${report.resolvedBy}> ${report.resolvedAt ? discordTimestamp(report.resolvedAt, 'R') : ''}` });

  return classic({
    embeds: [
      {
        title: `🚩 Report #${report.id} · ${reasonLabel(report.reason)}`,
        color: open ? Colors.mod : Colors.muted,
        fields,
        timestamp: new Date(report.createdAt).toISOString(),
      },
    ],
    components: open
      ? [
          row(
            button(cid('mod', 'ban', report.targetId, report.id), 'Ban', { style: 'danger', emoji: '🔨' }),
            button(cid('mod', 'hide', report.targetId, report.id), 'Hide profile', { emoji: '🙈' }),
            button(cid('mod', 'dismiss', report.id), 'Dismiss', { style: 'success', emoji: '✅' }),
            button(cid('mod', 'user', report.targetId), 'User info', { emoji: '👤' }),
          ),
        ]
      : [row(button(cid('mod', 'user', report.targetId), 'User info', { emoji: '👤' }))],
  });
}

export function evidenceFile(report: ReportRecord): FileUpload | null {
  if (!report.evidence.length) return null;
  const lines = report.evidence.map((line) => `[${new Date(line.at).toISOString()}] ${line.from === 'reporter' ? 'REPORTER' : 'REPORTED'}: ${line.text}`);
  return { name: `report-${report.id}-evidence.txt`, data: new TextEncoder().encode(lines.join('\n')), contentType: 'text/plain; charset=utf-8' };
}

export function userCard(app: App, userId: string, note?: string): MessagePayload {
  const { store } = app;
  const now = app.clock();
  const user = store.users.get(userId);
  const profile = store.profiles.get(userId);
  const photos = store.photos.list(userId);
  const ban = store.users.activeBan(userId, now);
  const reports = store.reports.against(userId, 3);
  const counts = store.reports.countAgainst(userId);
  const feedback = store.chat.feedbackFor(userId);
  const actions = store.modActions.forTarget(userId, 3);

  const profileText = profile
    ? [
        `**${truncate(profile.name || '—', 40)}**, ${profileAge(profile, now) ?? '?'} (${profileGroup(profile, now) ?? 'unknown'})`,
        `${findItem(GENDERS, profile.gender)?.label ?? profile.gender} · ${profile.stage} · ${profile.visibility}`,
        `${photos.length} photo(s)${profile.bio ? ` · bio: ${truncate(profile.bio, 120)}` : ''}`,
      ].join('\n')
    : 'No profile';

  const fields: Embed['fields'] = [
    { name: 'Profile', value: profileText },
    {
      name: 'Account',
      value: `Created ${discordTimestamp(snowflakeTime(userId), 'R')}${user ? `\nFirst seen ${discordTimestamp(user.firstSeenAt, 'R')}\nLast seen ${discordTimestamp(user.lastSeenAt, 'R')}` : '\nNever used the bot'}`,
      inline: true,
    },
    {
      name: 'Activity',
      value: `Likes ${store.swipes.likesGiven(userId)} given / ${store.swipes.likesReceived(userId)} received\nMatches ${store.matches.countActive(userId)} · Chats ${store.chat.countFor(userId)}\nChat ratings 👍 ${feedback.up} · 👎 ${feedback.down}`,
      inline: true,
    },
    {
      name: `Reports (${counts.total}, ${counts.open} open)`,
      value: reports.length ? reports.map((r) => `#${r.id} ${reasonLabel(r.reason)} · ${r.status} · ${discordTimestamp(r.createdAt, 'R')}`).join('\n') : 'None',
    },
    {
      name: 'Status',
      value: ban ? `🔨 Banned ${ban.until >= PERMANENT_BAN ? 'permanently' : `until ${discordTimestamp(ban.until, 'f')}`}\n${ban.reason ?? ''}` : '✅ Not banned',
      inline: true,
    },
  ];
  if (actions.length) {
    fields.push({ name: 'Recent actions', value: actions.map((a) => `${a.action} by <@${a.moderatorId}> ${discordTimestamp(a.createdAt, 'R')}`).join('\n'), inline: true });
  }
  const embed: Embed = {
    title: `👤 ${user?.username || 'Unknown user'}`,
    description: `<@${userId}> · \`${userId}\`${note ? `\n\n${note}` : ''}`,
    color: Colors.mod,
    fields,
  };
  if (photos[0]) embed.thumbnail = { url: photoUrl(photos[0]) };
  const hidden = profile?.visibility === 'hidden';
  return classic({
    embeds: [embed],
    components: [
      row(
        ban ? button(cid('mod', 'unban', userId), 'Unban', { style: 'success', emoji: '✅' }) : button(cid('mod', 'ban', userId, 0), 'Ban', { style: 'danger', emoji: '🔨' }),
        profile && (hidden ? button(cid('mod', 'unhide', userId), 'Unhide profile', { emoji: '👁️' }) : button(cid('mod', 'hide', userId, 0), 'Hide profile', { emoji: '🙈' })),
        photos.length > 0 && button(cid('mod', 'photos', userId), 'Remove photos', { emoji: '🗑️' }),
        button(cid('mod', 'user', userId), 'Refresh', { emoji: '🔄' }),
      ),
    ],
  });
}

function banModal(userId: string, reportId: number, reason: string): Modal {
  return modal(cid('mod', 'ban', userId, reportId), 'Ban user', [
    label('Reason (shown to the user)', textInput('reason', { style: 'paragraph', min: 3, max: 300, required: true, value: reason })),
    label(
      'Duration',
      radioGroup('duration', [choice('1d', '1 day'), choice('7d', '7 days', { selected: true }), choice('30d', '30 days'), choice('permanent', 'Permanent')], { required: true }),
    ),
    label('Tell the user by DM', checkbox('notify', true)),
  ]);
}

export function statsPayload(app: App): MessagePayload {
  const { store } = app;
  const now = app.clock();
  const since = now - DAY;
  const profiles = store.profiles.countComplete();
  const jobs = store.jobs.counts();
  return classic({
    embeds: [
      {
        title: '📊 Bot statistics',
        color: Colors.mod,
        fields: [
          { name: 'Users', value: String(store.users.count()), inline: true },
          { name: 'Profiles', value: `${profiles.total} (${profiles.visible} visible, ${profiles.teens} teens)`, inline: true },
          { name: 'Banned', value: String(store.users.countBanned(now)), inline: true },
          { name: 'Matches', value: `${store.matches.countAll()} active · ${store.matches.countSince(since)} today`, inline: true },
          { name: 'Likes (24h)', value: String(store.swipes.countLikesSince(since)), inline: true },
          { name: 'Chats', value: `${store.chat.countActive()} live · ${store.chat.countStartedSince(since)} today · ${store.chat.queueSize()} waiting`, inline: true },
          { name: 'Open reports', value: String(store.reports.countOpen()), inline: true },
          { name: 'Jobs', value: `${jobs.pending} pending · ${jobs.dead} failed`, inline: true },
        ],
        timestamp: new Date(now).toISOString(),
      },
    ],
  });
}

export function reportsListPayload(app: App): MessagePayload {
  const open = app.store.reports.listOpen(15);
  const lines = open.map((r) => {
    const link = r.modChannelId && r.modMessageId && app.config.moderation.guildId ? ` · [open](https://discord.com/channels/${app.config.moderation.guildId}/${r.modChannelId}/${r.modMessageId})` : '';
    return `**#${r.id}** ${reasonLabel(r.reason)} · <@${r.targetId}> · ${discordTimestamp(r.createdAt, 'R')}${link}`;
  });
  return classic({ embeds: [{ title: `🚩 Open reports (${app.store.reports.countOpen()})`, description: lines.join('\n') || 'Nothing to review. 🎉', color: Colors.mod }] });
}

// -- handlers --------------------------------------------------------------------------

function targetFromOptions(options: ReturnType<typeof commandOptions>['options']): string | null {
  const user = optionValue(options, 'user');
  const id = optionValue(options, 'id');
  if (typeof user === 'string' && isSnowflake(user)) return user;
  if (typeof id === 'string' && isSnowflake(id.trim())) return id.trim();
  return null;
}

/** Refreshes the card a moderator acted on (a report post or a user card). */
async function refreshSource(app: App, ctx: AnyContext, userId: string, reportId: number, note: string): Promise<void> {
  if (reportId > 0) {
    const report = app.store.reports.get(reportId);
    if (report) return ctx.update(reportMessage(app, report));
  }
  if (ctx.sourceMessage && !isV2Message(ctx.sourceMessage.flags)) return ctx.update(userCard(app, userId, note));
  await ctx.reply(embedNotice(note, 'success'), { ephemeral: true });
}

export function registerModeration(app: App, router: Router): void {
  const { store } = app;

  router.command({
    name: 'mod',
    gate: 'moderator',
    run: async (ctx) => {
      const { path, options } = commandOptions(ctx);
      const sub = path[0];
      if (sub === 'stats') return ctx.reply(statsPayload(app), { ephemeral: true });
      if (sub === 'reports') return ctx.reply(reportsListPayload(app), { ephemeral: true });
      const target = targetFromOptions(options);
      if (!target) return ctx.reply(embedNotice('Pick a user or paste their id.', 'warning'), { ephemeral: true });
      if (sub === 'user') return ctx.reply(userCard(app, target), { ephemeral: true });
      if (sub === 'unban') {
        const lifted = app.safety.unban(target, ctx.user.id);
        return ctx.reply(embedNotice(lifted ? `Unbanned <@${target}>.` : `<@${target}> was not banned.`, lifted ? 'success' : 'info'), { ephemeral: true });
      }
      if (sub === 'ban') {
        if (target === ctx.user.id || app.info.ownerIds.has(target)) return ctx.reply(embedNotice("You can't ban that account.", 'warning'), { ephemeral: true });
        const duration = DURATIONS[String(optionValue(options, 'duration'))] ?? 7 * DAY;
        const reason = String(optionValue(options, 'reason') ?? 'Violation of the community guidelines');
        await ctx.deferReply({ ephemeral: true });
        await app.safety.ban({ targetId: target, durationMs: duration, reason, moderatorId: ctx.user.id, notify: true });
        return ctx.reply(userCard(app, target, `🔨 Banned by <@${ctx.user.id}>.`), { ephemeral: true });
      }
      await ctx.reply(embedNotice('Unknown subcommand.', 'warning'), { ephemeral: true });
    },
  });

  router.component({ ns: 'mod', action: 'user', gate: 'moderator', run: (ctx, args) => (isSnowflake(args[0]) ? ctx.reply(userCard(app, args[0]), { ephemeral: true }) : ctx.deferUpdate()) });

  router.component({
    ns: 'mod',
    action: 'ban',
    gate: 'moderator',
    run: async (ctx, args) => {
      if (!isSnowflake(args[0])) return ctx.deferUpdate();
      const reportId = Number(args[1]) || 0;
      const report = reportId ? store.reports.get(reportId) : null;
      await ctx.showModal(banModal(args[0], reportId, report ? reasonLabel(report.reason) : 'Violation of the community guidelines'));
    },
  });

  router.modal({
    ns: 'mod',
    action: 'ban',
    gate: 'moderator',
    run: async (ctx, args) => {
      const userId = args[0];
      if (!isSnowflake(userId)) return ctx.deferUpdate();
      if (userId === ctx.user.id || app.info.ownerIds.has(userId)) return ctx.reply(embedNotice("You can't ban that account.", 'warning'), { ephemeral: true });
      const reportId = Number(args[1]) || 0;
      const values = modalValues(ctx);
      const duration = DURATIONS[values.radio('duration') ?? '7d'] ?? 7 * DAY;
      await ctx.deferUpdate();
      await app.safety.ban({ targetId: userId, durationMs: duration, reason: values.text('reason').trim() || 'Violation of the community guidelines', moderatorId: ctx.user.id, reportId: reportId || null, notify: values.checked('notify') });
      await refreshSource(app, ctx, userId, reportId, `🔨 Banned by <@${ctx.user.id}>.`);
    },
  });

  router.component({
    ns: 'mod',
    action: 'unban',
    gate: 'moderator',
    run: async (ctx, args) => {
      if (!isSnowflake(args[0])) return ctx.deferUpdate();
      const lifted = app.safety.unban(args[0], ctx.user.id);
      await refreshSource(app, ctx, args[0], 0, lifted ? `✅ Unbanned by <@${ctx.user.id}>.` : 'Not banned.');
    },
  });

  router.component({
    ns: 'mod',
    action: 'hide',
    gate: 'moderator',
    run: async (ctx, args) => {
      if (!isSnowflake(args[0])) return ctx.deferUpdate();
      const reportId = Number(args[1]) || 0;
      const done = app.safety.setHidden(args[0], true, ctx.user.id, reportId || undefined);
      await refreshSource(app, ctx, args[0], reportId, done ? `🙈 Profile hidden by <@${ctx.user.id}>.` : 'This user has no profile.');
    },
  });

  router.component({
    ns: 'mod',
    action: 'unhide',
    gate: 'moderator',
    run: async (ctx, args) => {
      if (!isSnowflake(args[0])) return ctx.deferUpdate();
      const done = app.safety.setHidden(args[0], false, ctx.user.id);
      await refreshSource(app, ctx, args[0], 0, done ? `👁️ Profile restored by <@${ctx.user.id}>.` : 'This user has no profile.');
    },
  });

  router.component({
    ns: 'mod',
    action: 'dismiss',
    gate: 'moderator',
    run: async (ctx, args) => {
      const reportId = Number(args[0]) || 0;
      const report = store.reports.get(reportId);
      if (!report) return ctx.deferUpdate();
      app.safety.dismiss(reportId, ctx.user.id);
      await ctx.update(reportMessage(app, store.reports.get(reportId)!));
    },
  });

  router.component({
    ns: 'mod',
    action: 'photos',
    gate: 'moderator',
    run: async (ctx, args) => {
      if (!isSnowflake(args[0])) return ctx.deferUpdate();
      await ctx.deferUpdate();
      const removed = await app.safety.removePhotos(args[0], ctx.user.id);
      await refreshSource(app, ctx, args[0], 0, `🗑️ Removed ${removed} photo(s).`);
    },
  });
}
