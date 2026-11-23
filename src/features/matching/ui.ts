// Discover, likes and matches cards (Components V2).

import { button, container, label, linkButton, modal, row, section, separator, text, textInput, v2 } from '../../discord/components/builders.ts';
import type { ActionRow, ContainerChild, MessagePayload, Modal } from '../../discord/types.ts';
import { cid } from '../../interactions/custom-id.ts';
import type { Photo, Profile } from '../../domain/profile.ts';
import type { MatchRecord } from '../../db/repos/social.ts';
import { profileCard, profileHeadline, profileName } from '../../ui/profile-card.ts';
import { Colors } from '../../ui/theme.ts';
import { menuButton, plural } from '../../ui/common.ts';
import { discordTimestamp } from '../../util/time.ts';

export const NOTE_MAX = 250;
export const MATCHES_PAGE_SIZE = 5;

const profileUrl = (userId: string) => `https://discord.com/users/${userId}`;

/** `ref` is the candidate's opaque reference — never their Discord id. */
export function discoverCard(viewer: Profile, candidate: Profile, photos: Photo[], options: { ref: number; now: number; notice?: string; pendingLikes: number }): MessagePayload {
  const id = options.ref;
  const rows: ActionRow[] = [
    row(
      button(cid('dsc', 'like', id), 'Like', { style: 'success', emoji: '👍' }),
      button(cid('dsc', 'note', id), 'Like + note', { style: 'primary', emoji: '💌' }),
      button(cid('dsc', 'skip', id), 'Skip', { emoji: '👎' }),
      button(cid('dsc', 'report', id), 'Report', { emoji: '🚩' }),
    ),
    row(
      menuButton(),
      options.pendingLikes > 0 && button(cid('lk', 'open'), `Your likes (${options.pendingLikes})`, { emoji: '💌' }),
      button(cid('set', 'open'), 'Filters', { emoji: '⚙️' }),
    ),
  ];
  return v2([profileCard(candidate, photos, { now: options.now, viewer, header: options.notice, rows, accent: Colors.discover })]);
}

export function discoverEmptyCard(notice?: string): MessagePayload {
  return v2([
    container(
      [
        text(
          [
            notice ?? '',
            "## ✨ You've seen everyone for now",
            'New people join all the time — check back a little later. You can also widen your filters, or try an anonymous chat in the meantime.',
          ]
            .filter(Boolean)
            .join('\n'),
        ),
        separator(),
        row(
          button(cid('dsc', 'open'), 'Check again', { emoji: '🔄', style: 'primary' }),
          button(cid('set', 'open'), 'Filters', { emoji: '⚙️' }),
          button(cid('chat', 'open'), 'Anonymous chat', { emoji: '🎲' }),
          menuButton(),
        ),
      ],
      { accent: Colors.discover },
    ),
  ]);
}

export function likeLimitCard(resetsAt: number, pendingLikes: number): MessagePayload {
  return v2([
    container(
      [
        text(`## ⏳ That's all your likes for today\nYou can like more people ${discordTimestamp(resetsAt, 'R')}. Meanwhile, see who already liked you!`),
        separator(),
        row(
          button(cid('lk', 'open'), pendingLikes ? `Your likes (${pendingLikes})` : 'Your likes', { emoji: '💌', style: 'primary' }),
          button(cid('chat', 'open'), 'Anonymous chat', { emoji: '🎲' }),
          menuButton(),
        ),
      ],
      { accent: Colors.discover },
    ),
  ]);
}

export function likeNoteModal(ref: number): Modal {
  return modal(cid('dsc', 'note', ref), 'Like with a note', [
    label(
      'Your note',
      textInput('note', { style: 'paragraph', min: 1, max: NOTE_MAX, required: true, placeholder: 'Say what caught your eye — keep it friendly!' }),
      "They'll see it next to your profile",
    ),
  ]);
}

/** "It's a match!" — shown to both people (inline for the actor, as a DM for the other). */
export function matchCard(other: Profile, photos: Photo[], match: MatchRecord, options: { now: number; viewer: Profile; continueWith: 'discover' | 'likes' | 'none'; intro?: string }): MessagePayload {
  const otherId = other.userId;
  const next =
    options.continueWith === 'discover'
      ? button(cid('dsc', 'open'), 'Keep discovering', { emoji: '▶️' })
      : options.continueWith === 'likes'
        ? button(cid('lk', 'open'), 'Next like', { emoji: '▶️' })
        : null;
  return v2([
    profileCard(other, photos, {
      now: options.now,
      viewer: options.viewer,
      header: `## 🎉 It's a match!\n${options.intro ?? `You and **${profileName(other)}** liked each other.`} Say hi — don't be shy!`,
      revealUserId: otherId,
      accent: Colors.match,
      rows: [
        row(linkButton(profileUrl(otherId), 'Open Discord profile', { emoji: '👤' }), button(cid('mt', 'view', match.id), 'View match', { emoji: '🤝' }), next),
      ],
    }),
  ]);
}

export function likesCard(liker: Profile, photos: Photo[], options: { ref: number; now: number; viewer: Profile; note: string | null; remaining: number; notice?: string }): MessagePayload {
  const id = options.ref;
  const headline = profileName(liker);
  const header = [
    options.notice ?? '',
    `## 💌 ${headline} liked you!`,
    options.remaining > 0 ? `-# ${plural(options.remaining, 'more like')} waiting after this one` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return v2([
    profileCard(liker, photos, {
      now: options.now,
      viewer: options.viewer,
      header,
      note: options.note,
      accent: Colors.likes,
      rows: [
        row(
          button(cid('lk', 'yes', id), 'Like back', { style: 'success', emoji: '💖' }),
          button(cid('lk', 'no', id), 'Pass', { emoji: '👎' }),
          button(cid('lk', 'report', id), 'Report', { emoji: '🚩' }),
          menuButton(),
        ),
      ],
    }),
  ]);
}

export function likesEmptyCard(notice?: string): MessagePayload {
  return v2([
    container(
      [
        text([notice ?? '', '## 💌 No new likes right now', "When someone likes you, they'll show up here — and I'll send you a DM."].filter(Boolean).join('\n')),
        separator(),
        row(button(cid('dsc', 'open'), 'Discover people', { emoji: '🔍', style: 'primary' }), menuButton()),
      ],
      { accent: Colors.likes },
    ),
  ]);
}

export function matchesListCard(
  entries: Array<{ match: MatchRecord; other: Profile | null; otherId: string }>,
  options: { now: number; page: number; total: number; notice?: string },
): MessagePayload {
  const pages = Math.max(1, Math.ceil(options.total / MATCHES_PAGE_SIZE));
  const header = [options.notice ?? '', '## 🤝 Your matches', options.total ? `-# ${plural(options.total, 'match', 'matches')} · tap a name to say hi` : ''].filter(Boolean).join('\n');
  const children: ContainerChild[] = [text(header)];
  if (!entries.length) {
    children.push(text('No matches yet. Like people in Discover — when they like you back, they appear here.'));
  }
  for (const { match, other, otherId } of entries) {
    const name = other ? profileHeadline(other, options.now) : 'Someone';
    const via = match.source === 'chat' ? 'via anonymous chat' : 'via Discover';
    children.push(section([`**${name}** · <@${otherId}>`, `-# Matched ${discordTimestamp(match.createdAt, 'R')} · ${via}`], button(cid('mt', 'view', match.id), 'View')));
  }
  const nav: ActionRow =
    pages > 1
      ? row(
          button(cid('mt', 'list', Math.max(0, options.page - 1)), 'Previous', { emoji: '◀️', disabled: options.page === 0 }),
          button(cid('mt', 'page', options.page), `${options.page + 1} / ${pages}`, { disabled: true }),
          button(cid('mt', 'list', Math.min(pages - 1, options.page + 1)), 'Next', { emoji: '▶️', disabled: options.page >= pages - 1 }),
          menuButton(),
        )
      : row(button(cid('dsc', 'open'), 'Discover', { emoji: '🔍' }), menuButton());
  return v2([container([...children, separator(), nav], { accent: Colors.match })]);
}

export function matchDetailCard(other: Profile, photos: Photo[], match: MatchRecord, options: { now: number; viewer: Profile }): MessagePayload {
  const otherId = other.userId;
  return v2([
    profileCard(other, photos, {
      now: options.now,
      viewer: options.viewer,
      header: `## 🤝 You matched with ${profileName(other)}\n-# Matched ${discordTimestamp(match.createdAt, 'R')}`,
      revealUserId: otherId,
      accent: Colors.match,
      rows: [
        row(
          linkButton(profileUrl(otherId), 'Open Discord profile', { emoji: '👤' }),
          button(cid('mt', 'unmatch', match.id), 'Unmatch', { emoji: '💔', style: 'danger' }),
          button(cid('mt', 'report', match.id), 'Report', { emoji: '🚩' }),
        ),
        row(button(cid('mt', 'list', 0), 'All matches', { emoji: '◀️' }), menuButton()),
      ],
    }),
  ]);
}

export function unmatchConfirmCard(other: Profile | null, match: MatchRecord): MessagePayload {
  const name = other ? `**${profileName(other)}**` : 'this person';
  return v2([
    container(
      [
        text(`## 💔 Unmatch ${name}?\nYou'll disappear from each other's matches and won't see each other in Discover again. They won't be notified.`),
        separator(),
        row(button(cid('mt', 'unmatch_yes', match.id), 'Yes, unmatch', { style: 'danger' }), button(cid('mt', 'view', match.id), 'Cancel')),
      ],
      { accent: Colors.danger },
    ),
  ]);
}

export function likeNoticeCard(count: number): MessagePayload {
  return v2([
    container(
      [
        text(`## 💌 You have ${plural(count, 'new like')}!\nSomeone wants to connect with you. Like them back to match.`),
        separator(),
        row(
          button(cid('lk', 'open'), 'See likes', { style: 'primary', emoji: '💌' }),
          button(cid('set', 'toggle', 'likes'), 'Turn off like alerts', { emoji: '🔕' }),
        ),
      ],
      { accent: Colors.likes },
    ),
  ]);
}
