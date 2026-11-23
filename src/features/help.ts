// /help: how everything works, commands, and safety tips.

import { button, container, row, separator, text, v2 } from '../discord/components/builders.ts';
import type { MessagePayload } from '../discord/types.ts';
import { cid } from '../interactions/custom-id.ts';
import type { Router } from '../interactions/router.ts';
import { brand, commandMention, type App } from '../core/app.ts';
import { escapeMarkdown } from '../domain/text.ts';
import { Colors } from '../ui/theme.ts';

function homeButton(app: App, userId: string) {
  return app.matching.profile(userId)
    ? button(cid('menu', 'home'), 'Menu', { emoji: '🏠' })
    : button(cid('onb', 'start'), 'Create my profile', { emoji: '✨', style: 'primary' });
}

export function helpPayload(app: App, userId: string): MessagePayload {
  const m = (name: string) => commandMention(app, name);
  return v2([
    container(
      [
        text(
          [
            `## ❓ How ${escapeMarkdown(brand(app))} works`,
            'Meet new people on Discord — for friendship, gaming, studying or just talking.',
            '',
            '### 🔍 Discover & match',
            "Browse profiles one at a time. **Like** the people you'd like to meet (add a note to stand out) or **skip**. When someone you liked likes you back, it's a **match** — you both get each other's Discord, so you can say hi.",
            '',
            '### 🎲 Anonymous chat',
            "Get paired with a random, compatible person and chat through my DMs without names. If you **both** press **Reveal profiles**, you'll see each other and become matches.",
            '',
            '### 🛡️ Built-in safety',
            '• Teens (13–17) only meet teens born within 2 years of them; adults only meet adults',
            '• Your Discord identity stays hidden until you match or both agree to reveal',
            '• Report or block from any card — moderators review every report',
          ].join('\n'),
        ),
        separator(),
        text(
          [
            '### ⌨️ Commands',
            `${m('start')} menu · ${m('discover')} browse · ${m('likes')} who liked you · ${m('matches')} your matches`,
            `${m('profile')} your profile · ${m('chat')} anonymous chat · ${m('next')} new partner · ${m('stop')} end chat · ${m('settings')} settings`,
          ].join('\n'),
        ),
        separator(),
        row(button(cid('help', 'safety'), 'Safety tips', { emoji: '🛡️' }), homeButton(app, userId)),
      ],
      { accent: Colors.help },
    ),
  ]);
}

export function safetyPayload(app: App, userId: string): MessagePayload {
  return v2([
    container(
      [
        text(
          [
            '## 🛡️ Staying safe',
            '• Never share passwords, login codes, or personal details like your address or school',
            '• Be careful with links and files from people you just met',
            "• Take your time — you don't owe anyone a reveal, a reply or a friend request",
            '• Nobody from this bot will ever ask for your password or for money',
            '• Something feels off? **Block and report** — it takes one tap and stays anonymous',
            '',
            "-# If you're in danger or thinking about hurting yourself, please contact local emergency services or find a helpline at <https://findahelpline.com>.",
          ].join('\n'),
        ),
        separator(),
        row(button(cid('help', 'open'), 'Back to help', { emoji: '◀️' }), homeButton(app, userId)),
      ],
      { accent: Colors.help },
    ),
  ]);
}

export function registerHelp(app: App, router: Router): void {
  router.command({ name: 'help', gate: 'none', run: (ctx) => ctx.reply(helpPayload(app, ctx.user.id)) });
  router.component({ ns: 'help', action: 'open', gate: 'none', run: (ctx) => ctx.update(helpPayload(app, ctx.user.id)) });
  router.component({ ns: 'help', action: 'safety', gate: 'none', run: (ctx) => ctx.update(safetyPayload(app, ctx.user.id)) });
}
