// Runs before every handler: records the user, applies anti-spam limits,
// bans, the account-age gate, the moderator gate and the onboarding gate.

import { Permission } from '../discord/constants.ts';
import type { AnyContext } from '../interactions/context.ts';
import type { Gate, Guard } from '../interactions/router.ts';
import { isComplete } from '../domain/profile.ts';
import { embedNotice } from '../ui/common.ts';
import { SlidingWindowLimiter } from '../util/async.ts';
import { snowflakeTime } from '../util/snowflake.ts';
import { DAY, discordTimestamp } from '../util/time.ts';
import { PERMANENT_BAN } from '../db/repos/users.ts';
import type { App } from './app.ts';

export function isModerator(app: Pick<App, 'config' | 'info'>, ctx: AnyContext): boolean {
  const userId = ctx.user.id;
  if (app.info.ownerIds.has(userId) || app.config.moderation.adminIds.includes(userId)) return true;
  const modGuild = app.config.moderation.guildId;
  const permissions = ctx.memberPermissions;
  if (!modGuild || ctx.guildId !== modGuild || permissions === null) return false;
  return (permissions & Permission.Administrator) !== 0n || (permissions & Permission.BanMembers) !== 0n;
}

export function createGuard(app: App, onboarding: (ctx: AnyContext) => Promise<void>): Guard & { limiter: SlidingWindowLimiter } {
  const limiter = new SlidingWindowLimiter(20, 15_000);

  const guard = async (ctx: AnyContext, gate: Gate): Promise<boolean> => {
    const now = app.clock();
    app.store.users.touch(ctx.user, ctx.interaction.locale ?? null, now);

    if (gate === 'moderator') {
      if (isModerator(app, ctx)) return true;
      await ctx.reply(embedNotice('This is only available to moderators.', 'danger'), { ephemeral: true });
      return false;
    }

    if (!limiter.hit(ctx.user.id, now)) {
      await ctx.reply(embedNotice("You're going a little fast. Take a breath and try again in a few seconds.", 'warning'), { ephemeral: true });
      return false;
    }

    if (gate === 'none') return true;

    const ban = app.store.users.activeBan(ctx.user.id, now);
    if (ban) {
      const until = ban.until >= PERMANENT_BAN ? 'permanently' : `until ${discordTimestamp(ban.until, 'f')}`;
      await ctx.reply(
        embedNotice(`Your access to this bot has been suspended ${until}.${ban.reason ? `\n**Reason:** ${ban.reason}` : ''}`, 'danger', 'Access suspended'),
        { ephemeral: true },
      );
      return false;
    }

    const minAgeDays = app.config.limits.minAccountAgeDays;
    if (minAgeDays > 0) {
      const allowedAt = snowflakeTime(ctx.user.id) + minAgeDays * DAY;
      if (allowedAt > now) {
        await ctx.reply(
          embedNotice(`To keep everyone safe, Discord accounts need to be at least ${minAgeDays} days old to use this bot. You can join ${discordTimestamp(allowedAt, 'R')}.`, 'warning'),
          { ephemeral: true },
        );
        return false;
      }
    }

    if (gate === 'profile') {
      const profile = app.store.profiles.get(ctx.user.id);
      if (!isComplete(profile)) {
        await onboarding(ctx);
        return false;
      }
      app.store.profiles.touchActive(ctx.user.id, now);
    }
    return true;
  };

  return Object.assign(guard, { limiter });
}
