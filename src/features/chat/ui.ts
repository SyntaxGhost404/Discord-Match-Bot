// Anonymous chat UI. Live cards are Components V2; the end-of-chat summary is
// a classic embed with fields (it reads like a receipt), plus buttons.

import { button, classic, container, linkButton, row, separator, text, v2 } from '../../discord/components/builders.ts';
import { MessageFlags } from '../../discord/constants.ts';
import type { ActionRow, Embed, MessagePayload } from '../../discord/types.ts';
import { cid } from '../../interactions/custom-id.ts';
import { INTERESTS, LANGUAGES, findItem } from '../../domain/catalog.ts';
import { sharedKeys } from '../../domain/compatibility.ts';
import type { Photo, Profile } from '../../domain/profile.ts';
import type { ChatSession, Side } from '../../db/repos/chat.ts';
import { profileCard } from '../../ui/profile-card.ts';
import { Colors } from '../../ui/theme.ts';
import { DM_HELP, dmHelpRows, menuButton, plural } from '../../ui/common.ts';
import { discordTimestamp, longDuration } from '../../util/time.ts';

export function chatIntroCard(teen: boolean): MessagePayload {
  return v2([
    container(
      [
        text(
          [
            '## 🎲 Anonymous chat',
            'Talk one-on-one with a random person — no names, no profiles.',
            '',
            '🕶️ Messages are relayed through me, so neither of you sees who the other is',
            '🤝 Reveal profiles any time — but only if you **both** agree',
            '🛡️ Report or block with one tap; your chat history stays private',
            teen ? '🌱 Teen chats are text-only and links are removed, to keep things safe' : '📎 Photos, videos, audio and voice messages work too',
            '',
            '-# The chat happens in your DMs with me. Type normally once you are connected.',
          ].join('\n'),
        ),
        separator(),
        row(button(cid('chat', 'start'), 'Start chatting', { style: 'primary', emoji: '▶️' }), menuButton()),
      ],
      { accent: Colors.chat },
    ),
  ]);
}

export function searchingCard(since: number): MessagePayload {
  return v2([
    container(
      [
        text(
          [
            '## 🔎 Looking for someone to chat with…',
            `I'll pair you with someone compatible as soon as possible and ping you here. Searching since ${discordTimestamp(since, 'R')}.`,
            '-# Meanwhile, feel free to do anything else — the search keeps running.',
          ].join('\n'),
        ),
        separator(),
        row(button(cid('chat', 'cancel'), 'Cancel', { emoji: '✖️' })),
      ],
      { accent: Colors.chat },
    ),
  ]);
}

export function searchStoppedCard(reason: 'cancelled' | 'timeout' | 'unreachable', supportServerUrl: string | null = null): MessagePayload {
  const body = {
    cancelled: '✖️ **Search cancelled.** No worries — start again whenever you like.',
    timeout: "⌛ **Nobody was free just now.** I stopped searching so you don't wait forever. Try again in a bit!",
    unreachable: `📭 **I can't message you in DMs**, so I stopped searching — anonymous chats happen there. ${DM_HELP}`,
  }[reason];
  return v2([
    container([text(body), separator({ divider: false }), row(button(cid('chat', 'start'), 'Search again', { style: 'primary', emoji: '🔁' }), menuButton()), ...(reason === 'unreachable' ? dmHelpRows(supportServerUrl) : [])], {
      accent: Colors.muted,
    }),
  ]);
}

function sharedLine(me: Profile, partner: Profile): string {
  const languages = sharedKeys(me.languages, partner.languages)
    .map((k) => findItem(LANGUAGES, k)?.label)
    .filter(Boolean);
  const interests = sharedKeys(me.interests, partner.interests)
    .map((k) => findItem(INTERESTS, k))
    .filter((i) => i !== undefined);
  const parts: string[] = [];
  if (languages.length) parts.push(`🗣️ You both speak ${languages.join(', ')}`);
  if (interests.length) parts.push(`✨ Shared interests: ${interests.map((i) => `${i.emoji} ${i.label}`).join(', ')}`);
  return parts.length ? `-# ${parts.join(' · ')}` : '-# 🌍 Say hi and find out what you have in common!';
}

export function chatControls(sessionId: number, options: { disabled?: boolean; revealRequested?: boolean } = {}): ActionRow {
  const disabled = options.disabled ?? false;
  return row(
    button(cid('chat', 'next', sessionId), 'Next', { emoji: '⏭️', style: 'primary', disabled }),
    button(cid('chat', 'end', sessionId), 'End', { emoji: '⏹️', style: 'danger', disabled }),
    button(cid('chat', 'reveal', sessionId), options.revealRequested ? 'Reveal requested' : 'Reveal profiles', {
      emoji: '🤝',
      style: 'success',
      disabled: disabled || options.revealRequested,
    }),
    button(cid('chat', 'ice', sessionId), 'Icebreaker', { emoji: '🎲', disabled }),
    button(cid('chat', 'report', sessionId), 'Report', { emoji: '🚩', disabled }),
  );
}

export function connectedCard(session: ChatSession, me: Profile, partner: Profile): MessagePayload {
  return v2(
    [
      container(
        [
          text(
            [
              "## 🎉 You're connected!",
              'Say hi 👋 — everything you type here now goes to your partner anonymously.',
              sharedLine(me, partner),
              session.teen ? '-# 🌱 Teen chat: text only, links are removed automatically.' : '',
            ]
              .filter(Boolean)
              .join('\n'),
          ),
          separator(),
          chatControls(session.id),
        ],
        { accent: Colors.chat },
      ),
    ],
    {},
  );
}

export function chatStatusCard(session: ChatSession, side: Side): MessagePayload {
  const requested = side === 'a' ? session.aReveal : session.bReveal;
  return v2([
    container(
      [
        text(
          [
            "## 💬 You're in an anonymous chat",
            `Started ${discordTimestamp(session.startedAt, 'R')} · ${plural(session.aMessages + session.bMessages, 'message')} so far.`,
            '-# Just type in your DMs with me to talk.',
          ].join('\n'),
        ),
        separator(),
        chatControls(session.id, { revealRequested: requested }),
      ],
      { accent: Colors.chat },
    ),
  ]);
}

export function endedCard(session: ChatSession): MessagePayload {
  const duration = longDuration((session.endedAt ?? Date.now()) - session.startedAt);
  return v2([
    container([text(`## 🎲 Chat ended\n-# Lasted ${duration} · ${plural(session.aMessages + session.bMessages, 'message')}`)], {
      accent: Colors.muted,
    }),
  ]);
}

export type EndRole = 'actor' | 'partner' | 'both';

const END_TEXT: Record<string, { actor: string; partner: string }> = {
  ended: { actor: 'You ended the chat.', partner: 'Your partner ended the chat.' },
  next: { actor: 'You skipped to someone new.', partner: 'Your partner moved on to a new chat.' },
  idle: { actor: 'The chat ended after a while without messages.', partner: 'The chat ended after a while without messages.' },
  block: { actor: "You blocked your partner. You won't be paired again.", partner: 'The chat has ended.' },
  report: { actor: "Thanks for the report — moderators will take a look. You won't be paired again.", partner: 'The chat has ended.' },
  banned: { actor: 'The chat has ended.', partner: 'The chat has ended.' },
  deleted: { actor: 'The chat has ended.', partner: 'Your partner left.' },
  undeliverable: { actor: 'The chat has ended.', partner: 'Your partner can no longer receive messages, so the chat ended.' },
};

export function summaryRows(sessionId: number, options: { rate: boolean; block: boolean; report: boolean }): ActionRow[] {
  const rows: ActionRow[] = [];
  if (options.rate) {
    rows.push(
      row(
        button(cid('chat', 'rate', sessionId, 'up'), 'Good chat', { emoji: '👍', style: 'success' }),
        button(cid('chat', 'rate', sessionId, 'down'), 'Not great', { emoji: '👎' }),
      ),
    );
  }
  rows.push(
    row(
      button(cid('chat', 'start'), 'New chat', { emoji: '🔄', style: 'primary' }),
      options.block && button(cid('chat', 'block', sessionId), 'Block', { emoji: '🚫' }),
      options.report && button(cid('chat', 'report', sessionId), 'Report', { emoji: '🚩' }),
      menuButton(),
    ),
  );
  return rows;
}

export function summaryPayload(session: ChatSession, viewerSide: Side, role: 'actor' | 'partner', options: { allowFeedback: boolean }): MessagePayload {
  const reason = session.endReason ?? 'ended';
  const description = (END_TEXT[reason] ?? END_TEXT.ended!)[role];
  const mine = viewerSide === 'a' ? session.aMessages : session.bMessages;
  const theirs = viewerSide === 'a' ? session.bMessages : session.aMessages;
  const actedAgainst = role === 'actor' && (reason === 'block' || reason === 'report');
  return classic({
    embeds: [
      {
        title: '💬 Chat ended',
        description,
        color: Colors.chat,
        fields: [
          { name: 'Duration', value: longDuration((session.endedAt ?? Date.now()) - session.startedAt), inline: true },
          { name: 'Messages', value: `You ${mine} · Partner ${theirs}`, inline: true },
        ],
        ...(options.allowFeedback ? { footer: { text: 'Rating is anonymous and helps keep chats friendly.' } } : {}),
      },
    ],
    components: summaryRows(session.id, { rate: options.allowFeedback, block: !actedAgainst, report: !actedAgainst }),
  });
}

/** The summary after the viewer rated / blocked / reported: same receipt, fewer buttons. */
export function summaryUpdated(embeds: Embed[] | undefined, note: string, rows: ActionRow[]): MessagePayload {
  const embed = embeds?.[0];
  return classic({
    embeds: [embed ? { ...embed, footer: { text: note } } : { description: note, color: Colors.chat }],
    components: rows,
  });
}

export function revealRequestedNotice(): MessagePayload {
  return v2([
    container(
      [
        text(
          '🤝 **Your partner would like to reveal profiles.**\nIf you want to as well, press **Reveal profiles** on your chat card. If not, just keep chatting — nothing is shared unless you both agree.',
        ),
      ],
      { accent: Colors.match },
    ),
  ]);
}

export function revealCard(partner: Profile, photos: Photo[], partnerId: string, now: number): MessagePayload {
  return v2([
    profileCard(partner, photos, {
      now,
      header: "## 🤝 Profiles revealed!\nYou both agreed — here's who you've been talking to. You're now matches, too.",
      revealUserId: partnerId,
      accent: Colors.match,
      rows: [row(linkButton(`https://discord.com/users/${partnerId}`, 'Open Discord profile', { emoji: '👤' }))],
    }),
  ]);
}

export function icebreakerCard(question: string): MessagePayload {
  return v2([container([text(`🎲 **Icebreaker:** ${question}`)], { accent: Colors.chat })]);
}

export function chatNotice(body: string): MessagePayload {
  return v2([container([text(body)], { accent: Colors.muted })], { flags: MessageFlags.SuppressNotifications });
}

export const ICEBREAKERS: readonly string[] = [
  "What's something you're looking forward to this week?",
  'If you could instantly master any skill, what would it be?',
  "What's a song you've had on repeat lately?",
  'Best game, show or book you discovered this year?',
  "What's your go-to comfort food?",
  'Morning person or night owl? Defend your choice.',
  "What's the most underrated hobby, in your opinion?",
  'If you could live anywhere for a year, where would you go?',
  "What's a small thing that always makes your day better?",
  "What's a fun fact about you most people don't know?",
  'Cats, dogs, or something more unusual?',
  "What's the last thing that made you laugh out loud?",
  'Which fictional world would you most like to visit?',
  'If you had a free day tomorrow, how would you spend it?',
  "What's a skill you're currently trying to get better at?",
  'Sweet or savory snacks?',
  'What was your favorite game as a kid?',
  "What's one place you'd love to see in person?",
  "What's a hot take you're willing to defend?",
  'Describe your perfect weekend in three words.',
  "What's the best piece of advice you've ever gotten?",
  "If you could have dinner with any character, who'd it be?",
  "What's a movie you can watch over and over?",
  'Which app do you open first in the morning?',
  "What's your favorite way to relax after a long day?",
];
