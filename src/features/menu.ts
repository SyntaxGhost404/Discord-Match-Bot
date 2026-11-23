// The home menu: one Components V2 card with a section per feature.

import { button, container, row, section, separator, text, v2 } from '../discord/components/builders.ts';
import type { MessagePayload } from '../discord/types.ts';
import { cid } from '../interactions/custom-id.ts';
import type { Router } from '../interactions/router.ts';
import type { App } from '../core/app.ts';
import { escapeMarkdown } from '../domain/text.ts';
import { Colors } from '../ui/theme.ts';
import { DM_HELP, dmHelpRows, plural } from '../ui/common.ts';
import { promptOnboarding } from './onboarding.ts';

export function menuPayload(app: App, userId: string, options: { header?: string } = {}): MessagePayload {
  const profile = app.matching.profile(userId);
  if (!profile) throw new Error('menuPayload requires a complete profile');
  const likes = app.matching.pendingCount(userId);
  const matches = app.store.matches.countActive(userId);
  const chat = app.chat.state(userId);
  const user = app.store.users.get(userId);

  const status =
    profile.visibility === 'visible'
      ? '🟢 Your profile is visible'
      : profile.visibility === 'paused'
        ? '⏸️ Your profile is paused — nobody can discover you'
        : '🔒 Your profile is under review by moderators';

  const chatLine =
    chat.kind === 'chatting' ? "You're in a chat right now" : chat.kind === 'queued' ? 'Searching for a partner…' : 'Talk to a random person — no names';

  return v2([
    container(
      [
        text([options.header ?? `## 👋 Hey ${escapeMarkdown(profile.name)}!`, `-# ${status}`].join('\n')),
        separator(),
        section(['🔍 **Discover**', '-# Browse people who match your vibe'], button(cid('dsc', 'open'), 'Discover', { style: 'primary' })),
        section(
          ['💌 **Likes**', `-# ${likes ? `${plural(likes, 'person', 'people')} liked you` : 'No new likes yet'}`],
          button(cid('lk', 'open'), likes ? `See likes (${likes})` : 'See likes', { style: likes ? 'success' : 'secondary' }),
        ),
        section(['🤝 **Matches**', `-# ${matches ? plural(matches, 'match', 'matches') : 'No matches yet'}`], button(cid('mt', 'list', 0), 'Open')),
        section(['🎲 **Anonymous chat**', `-# ${chatLine}`], button(cid('chat', 'open'), chat.kind === 'idle' ? 'Start' : 'Open')),
        user?.dmStatus === 'closed' && text(`-# ⚠️ I can't DM you right now, so you'll miss likes, matches and chats. ${DM_HELP}`),
        ...(user?.dmStatus === 'closed' ? dmHelpRows(app.config.supportServerUrl) : []),
        separator(),
        row(
          button(cid('prof', 'view'), 'Profile', { emoji: '👤' }),
          button(cid('set', 'open'), 'Settings', { emoji: '⚙️' }),
          button(cid('help', 'open'), 'Help', { emoji: '❓' }),
        ),
      ],
      { accent: Colors.brand },
    ),
  ]);
}

export function registerMenu(app: App, router: Router): void {
  router.command({
    name: 'start',
    gate: 'account',
    run: async (ctx) => {
      if (!app.matching.profile(ctx.user.id)) return promptOnboarding(app, ctx);
      await ctx.reply(menuPayload(app, ctx.user.id));
    },
  });
  router.component({
    ns: 'menu',
    action: 'home',
    gate: 'profile',
    run: (ctx) => ctx.update(menuPayload(app, ctx.user.id)),
  });
}
