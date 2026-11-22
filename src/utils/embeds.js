// EmbedFactory: classic (non-V2) embeds, faithful to the reference
// utils/embeds.js. Plus the modernized Components-V2 cards used for the
// primary interactive surfaces (searching, matched, ended, share confirm).
//
// Component type ids (discord-llms-full.txt components reference):
//   1 ActionRow, 2 Button, 3 StringSelect, 4 TextInput, 10 TextDisplay,
//   12 MediaGallery, 13 File, 14 Separator, 17 Container
// Flags: 32768 = IS_COMPONENTS_V2, 64 = EPHEMERAL.

import { ageOfProfile } from './dob.js';
import { loadProfileMediaFiles, mediaGalleryItems, MAX_PROFILE_MEDIA } from './media.js';

export const EmbedFactory = {
  /** Green success embed. */
  createSuccessEmbed(title, description) {
    return { title, description, color: 0x57f287 };
  },

  /** Red error embed. */
  createErrorEmbed(title, description) {
    return { title, description, color: 0xED4245 };
  },

  /** Neutral info embed. */
  createInfoEmbed(title, description) {
    return { title, description, color: 0x5865F2 };
  },

  /** "Partner disconnected." style notice (classic embed DM). */
  createChatEndedEmbed(reason) {
    return {
      title: '💔 Chat Ended',
      description: reason || 'Your chat partner disconnected.',
      color: 0xED4245,
    };
  },

};

// ---------------------------------------------------------------------------
// Components V2 cards (the modernized surfaces)
// ---------------------------------------------------------------------------

const T = {
  ACTION_ROW: 1,
  BUTTON: 2,
  STRING_SELECT: 3,
  TEXT_DISPLAY: 10,
  MEDIA_GALLERY: 12,
  SEPARATOR: 14,
  CONTAINER: 17,
  LABEL: 18,
  FILE_UPLOAD: 19,
};

const BTN = { PRIMARY: 1, SECONDARY: 2, SUCCESS: 3, DANGER: 4 };
const ACCENT = 0xEB459E;

const textDisplay = (content) => ({ type: T.TEXT_DISPLAY, content });
const separator = () => ({ type: T.SEPARATOR, divider: true, spacing: 1 });
const actionRow = (...components) => ({ type: T.ACTION_ROW, components });
const button = (custom_id, label, style, emoji) => {
  const b = { type: T.BUTTON, style, custom_id, label };
  if (emoji) b.emoji = { name: emoji };
  return b;
};
const container = (children, accentColor = ACCENT) => ({
  type: T.CONTAINER, accent_color: accentColor, components: children,
});

/**
 * Escape Discord markdown in user-controlled text (names, locations, bios,
 * interests) so it renders as literal text instead of formatting, masked
 * links ([text](url)) or other markdown constructs. Backslash first, then
 * every markdown-significant character. The card's own formatting (**bold**,
 * · separators) is applied by the callers around the escaped text, so it is
 * unaffected.
 */
export function escapeMarkdown(text) {
  return String(text ?? '').replace(/[\\`*_~#>|[\]()]/g, (ch) => `\\${ch}`);
}

/** One-line status card: a single Container with one TextDisplay. */
export const simpleCard = (text) => [container([textDisplay(String(text))])];

/**
 * The unblock confirmation, identical everywhere an unblock happens (the
 * /blocklist string select and the standalone /unblock command): a single
 * paragraph with the italicized 8-char code, explaining the stranger can be
 * matched again and was never told about the block.
 */
export const unblockResultCard = (ok, code) => simpleCard(ok
  ? `✅ *\`${code}\`* is unblocked. You can be matched with them again in the future. They were never told you had blocked them, and they are not told now.`
  : '❌ Could not find that stranger in your blocked list.');

/** "Looking for a partner..." with eligible-pool queue position + cancel button.
 *  position/size are scoped to the user's own sliding window: only the
 *  waiters who can actually be paired with them are counted. */
export function searchingCard(position = null, size = null) {
  const line = position && size
    ? `\n\nYou are #${position} in line (${size} in your age group searching right now).`
    : '';
  return [container([
    textDisplay(
      '🔎 **Searching for a partner...**\n\n' +
      'Hang tight. The moment someone else starts searching, we will pair you ' +
      'up and drop you both a message.' + line
    ),
    separator(),
    actionRow(button('queue_cancel', 'Cancel search', BTN.SECONDARY, '✖️')),
  ])];
}

/**
 * DM card both strangers receive the moment they are paired. `rating` is the
 * PARTNER's lifetime community reputation ({ score, total } from
 * db.getReputation, or null) so each person can see who they were matched
 * with at a glance.
 */
export function matchedCard(rating = null) {
  const repLine = rating && rating.total > 0
    ? `⭐ Community rating: **${rating.score.toFixed(2)} / 5.00** · ${rating.total} ${rating.total === 1 ? 'rating' : 'ratings'}`
    : '⭐ Community rating: **new here** · no ratings yet. Say hi!';
  return [container([
    textDisplay(
      "🎉 **You're now chatting with a stranger.**\n\n" +
      'Say hi. Everything you type in your DMs with the bot goes straight to ' +
      'them, and they never see who you are.' +
      `\n\n${repLine}`
    ),
    separator(),
    actionRow(
      button('chat_end', 'End chat', BTN.DANGER),
      button('chat_report', 'Report', BTN.SECONDARY),
    ),
  ])];
}

/**
 * The same matched card with both action buttons disabled: applied to the
 * original greeting message the instant a session concludes, so the red
 * "End chat" and grey "Report" buttons render greyed out and unclickable.
 * Takes the partner rating so the reputation line survives the rebuild.
 */
export function matchedCardDisabled(rating = null) {
  const card = matchedCard(rating);
  for (const row of card[0].components) {
    if (row.type !== 1) continue;
    for (const btn of row.components) {
      if (btn.type === 2 && (btn.custom_id === 'chat_end' || btn.custom_id === 'chat_report')) {
        btn.disabled = true;
      }
    }
  }
  return card;
}

/** End-of-chat DM card with a "search again" button. */
export function endedCard() {
  return [container([
    textDisplay('This chat has ended.\n\nUse `/new` whenever you want to meet someone new.'),
    separator(),
    actionRow(button('chat_find_new', 'Find someone new', BTN.PRIMARY, '🔎')),
  ])];
}

/**
 * The reachable side of a fizzled match gets this: their greeting DM landed
 * but the partner's never did, so the match was unwound and both strangers
 * went back into the queue with their place kept. Honest and warm.
 */
export function matchFizzledCard() {
  return [container([
    textDisplay(
      "We couldn't reach your match just now, so you're back in the queue. " +
      "Nothing is lost, we'll keep looking and pair you up as soon as someone " +
      'compatible starts searching.'
    ),
    separator(),
    actionRow(button('queue_cancel', 'Cancel search', BTN.SECONDARY, '✖️')),
  ])];
}

/**
 * Natural-language duration: "45 seconds", "3 minutes 12 seconds",
 * "1 hour 5 minutes". Built from an exact millisecond span (pairing moment
 * to session end), so the phrasing adapts to the length of the chat.
 */
export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (totalSeconds < 60) return plural(totalSeconds, 'second');
  const minutes = Math.floor(totalSeconds / 60);
  const restSeconds = totalSeconds % 60;
  if (minutes < 60) {
    return restSeconds
      ? `${plural(minutes, 'minute')} ${plural(restSeconds, 'second')}`
      : plural(minutes, 'minute');
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes
    ? `${plural(hours, 'hour')} ${plural(restMinutes, 'minute')}`
    : plural(hours, 'hour');
}

/**
 * Message 1 of the standardized session conclusion: the status + reconnect
 * card (Components V2 container). One unbroken paragraph explains who ended
 * the chat and why, invites an optional anonymous 👍/👎 rating of the partner
 * (a community honor system; it never touches matchmaking), then flows into
 * the invitation to keep meeting people via `/new` or the button below.
 * A divider sits under the text, then one action row with Like, Dislike,
 * and "Find someone new" in that order. `sessionId` tags the rating buttons
 * so each tap resolves to exactly one concluded session.
 */
export function statusReconnectCard(role, sessionId = '') {
  const rate = 'How was it? Tap 👍 or 👎 to rate your partner. Totally optional and anonymous.';
  const invite = 'When you are ready to meet someone new, run `/new` or tap below.';
  const texts = {
    ender: `👋 You ended the chat. ${rate} ${invite}`,
    blocker: `🛡️ You blocked this stranger. The chat is over, and they were never told you blocked them. ${rate} ${invite}`,
    partner: `💔 Your chat partner left the conversation. ${rate} ${invite}`,
    timeout: `⏰ This chat timed out after a while of quiet. ${rate} ${invite}`,
    disconnected: `💔 Your chat partner disconnected. ${rate} ${invite}`,
    unavailable: `💔 Your chat partner is no longer available. ${rate} ${invite}`,
    mod: `🛡️ This chat was ended automatically after repeated flagged language, and a record of it was saved for review by our moderators. ${rate} ${invite}`,
  };
  const likeId = sessionId ? `rate_like:${sessionId}` : 'rate_like';
  const dislikeId = sessionId ? `rate_dislike:${sessionId}` : 'rate_dislike';
  return [container([
    textDisplay(texts[role] || texts.partner),
    separator(),
    actionRow(
      button(likeId, 'Like', BTN.SUCCESS, '👍'),
      button(dislikeId, 'Dislike', BTN.SECONDARY, '👎'),
      button('chat_find_new', 'Find someone new', BTN.PRIMARY, '🔎'),
    ),
  ])];
}

/**
 * Message 2 of the standardized session conclusion: the session overview
 * (plain Discord embed, zero buttons). Identical across every exit scenario:
 * text messages, attachments, and the human-readable chat duration.
 */
export function sessionOverviewEmbed(stats) {
  return {
    title: '📊 Session Overview',
    color: 0xEB459E,
    fields: [
      { name: '💬 Text Messages', value: String(stats.textMessages), inline: true },
      { name: '📎 Attachments', value: String(stats.attachments), inline: true },
      { name: '⏱️ Chat Duration', value: formatDuration(stats.durationMs), inline: true },
    ],
  };
}

/**
 * Warning DM sent to the sender on EVERY message that contains masked
 * profanity. Shows how many flagged messages remain before the chat ends.
 */
export function profanityWarningCard(remaining) {
  const noun = remaining === 1 ? 'flagged message' : 'flagged messages';
  return [container([
    textDisplay(
      '⚠️ We masked some language in your last message before passing it along. ' +
      `You have **\`${remaining}\`** more ${noun} before this chat ends automatically.`
    ),
  ], 0xF59E0B)];
}

/**
 * Warning DM sent to the sender when a message is blocked because one of its
 * attachments failed the security allowlist. Names the blocked file(s) and
 * lists every permitted extension by category so the sender knows what can
 * go through.
 */
export function attachmentBlockedCard(filenames, allowedByCategory) {
  const files = filenames.map((n) => `\`${escapeMarkdown(n)}\``).join(', ');
  const lines = allowedByCategory
    .map((c) => `**${c.label}:** ${c.exts.join(', ')}`)
    .join('\n');
  return [container([
    textDisplay(
      '🛡️ **That file type is blocked**\n\n' +
      `We couldn't pass along ${files}. To keep every chat safe, only photos, ` +
      'videos, audio, and plain text notes can be shared here.\n\n' +
      '**What you can send:**\n' +
      lines + '\n\n' +
      'Send your message again with one of these file types and it will go straight through.'
    ),
  ], 0xED4245)];
}

/**
 * Warning DM sent when an attachment passed the allowlist but the downloaded
 * bytes could not be read as that file type (truncated or corrupt upload).
 * Kept separate from attachmentBlockedCard: telling the user the file type
 * is banned would be misleading here, the fix is to re-send the file.
 */
export function attachmentUnreadableCard(filenames) {
  const files = filenames.map((n) => `\`${escapeMarkdown(n)}\``).join(', ');
  return [container([
    textDisplay(
      "⚠️ **We couldn't read that file**\n\n" +
      `We couldn't read ${files}. It may be corrupted, so try sending it again.`
    ),
  ], 0xED4245)];
}

/** DM card the partner receives when someone requests an identity swap. */
export function shareRequestCard() {
  return [container([
    textDisplay(
      '🤝 **Your chat partner wants to swap identities.**\n\n' +
      "If you accept, you'll both see each other's profile card with photos, bio, and Discord username."
    ),
    separator(),
    actionRow(
      button('share_accept', 'Accept', BTN.SUCCESS, '✅'),
      button('share_decline', 'Decline', BTN.SECONDARY),
    ),
  ])];
}

/**
 * The mutual identity reveal: a rich V2 profile exchange card.
 * Layout: opening line, divider, media showcase, divider, profile summary,
 * divider, contact prompt, Discord identity block, closing line. Media
 * sections are omitted entirely when the profile has no photos or videos.
 * headerText lets the caller pick the opening line per role: the share
 * requester sees "They said yes! ...", the accepter sees the plain version.
 *
 * Markdown audit: the profile fields reach this card through profileHeadline
 * (markdown-escaped). `username`/`userId` are intentionally NOT escaped: they
 * render inside an inline code span, where markdown never parses (so a masked
 * link cannot form), and Discord usernames cannot contain backticks or
 * brackets that could break out of the span.
 */
export function identityRevealCard(profile, username, userId, files = [], headerText = "They said yes! Here's the person you've been chatting with.") {
  const parts = [
    textDisplay(headerText),
    separator(),
  ];
  if (files.length) {
    parts.push(mediaGallery(mediaGalleryItems(files)), separator());
  }
  parts.push(
    textDisplay(profileHeadline(profile)),
    separator(),
    textDisplay("Here's how to reach them on Discord:"),
    textDisplay(`> \`@${username}\` (\`${userId}\`)`),
    textDisplay('Send them a friend request and keep the conversation going.'),
  );
  return { components: [container(parts)], files };
}

// ---------------------------------------------------------------------------
// Report modal (shared by /report and the chat Report button)
// ---------------------------------------------------------------------------

const textInputRow = (custom_id, label, style, { placeholder, required = true, min_length, max_length } = {}) => ({
  type: T.ACTION_ROW,
  components: [{
    type: 4, custom_id, label, style, required,
    ...(placeholder ? { placeholder } : {}),
    ...(min_length !== undefined ? { min_length } : {}),
    ...(max_length !== undefined ? { max_length } : {}),
  }],
});

/** Modal custom_id 'report_modal' (or 'report_modal:<targetId>' when the
 *  target is known up front, so a report filed after the chat has ended
 *  still lands on the right person): reason (Short) + description (Paragraph). */
export function reportModal(targetId = '') {
  return {
    type: 9,
    data: {
      custom_id: targetId ? `report_modal:${targetId}` : 'report_modal',
      title: 'Report User',
      components: [
        textInputRow('report_reason', 'Reason', 1, {
          placeholder: 'Spam, Harassment, Inappropriate content...',
          required: true,
        }),
        textInputRow('report_description', 'Description', 2, {
          placeholder: 'Please provide more details...',
          required: true,
        }),
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Onboarding (mandatory first-run wizard, no slash command)
// ---------------------------------------------------------------------------

const labelWrap = (label, component, description) => ({
  type: T.LABEL,
  label,
  ...(description ? { description } : {}),
  component,
});

/** Components-V2 MediaGallery from attachment:// item descriptors. */
const mediaGallery = (items) => ({ type: T.MEDIA_GALLERY, items });

/**
 * The one-line profile summary used on profile cards and identity reveals:
 * `**{Name}**, {age} · {location} · {bio}`, with the location and bio
 * segments omitted when they are empty. Name, location and bio are
 * user-controlled, so each is markdown-escaped (a bio of
 * `[x](https://evil.example)` must not render as a clickable masked link on
 * the identity card DM'd to the stranger).
 */
export function profileHeadline(profile) {
  const age = ageOfProfile(profile);
  let s = `**${escapeMarkdown(profile.name) || 'Someone'}**, ${age != null ? age : '?'}`;
  if (profile.location) s += ` · ${escapeMarkdown(profile.location)}`;
  if (profile.bio) s += ` · ${escapeMarkdown(profile.bio)}`;
  return s;
}

/**
 * The shared profile card: media showcase on top, then the headline, then
 * interests (when set), then optional button rows. Returns
 * { components, files } where files are the re-attached local media files.
 * buttonRows is an array of rows; each row is an array of button objects.
 */
export function profileCard(profile, { buttonRows = [] } = {}) {
  const files = loadProfileMediaFiles(profile);
  const parts = [];
  if (files.length) {
    parts.push(mediaGallery(mediaGalleryItems(files)), separator());
  }
  parts.push(textDisplay(profileHeadline(profile)));
  const details = [];
  if ((profile.interests || []).length) details.push(`Interests: ${profile.interests.map(escapeMarkdown).join(', ')}`);
  if (details.length) parts.push(textDisplay(details.join('\n')));
  if (buttonRows.length) {
    parts.push(separator(), ...buttonRows.map((row) => actionRow(...row)));
  }
  return { components: [container(parts)], files };
}

/** Tiny ephemeral receipt shown after a /profile edit modal saves. */
export function profileSavedCard(headline, detail) {
  return [container([
    textDisplay(`✅ **${headline}**${detail ? `\n\n${detail}` : ''}`),
  ])];
}

/** Humanize milliseconds for /stats: "45m", "14h 32m", "2d 4h". */
export function formatChatDuration(ms) {
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  if (totalMin < 1) return 'under a minute';
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m || parts.length === 0) parts.push(`${m}m`);
  return parts.join(' ');
}

const fmtNum = (n) => Number(n || 0).toLocaleString('en-US');

/** /stats: the user's lifetime conversation metrics as a V2 card. */
export function personalStatsCard(l, rep = null) {  const parts = [
    textDisplay('📊 **Your lifetime stats**'),
    separator(),
    textDisplay(`💬 Messages sent: **${fmtNum(l.messages)}**`),
    textDisplay(`📎 Attachments shared: **${fmtNum(l.attachments)}**`),
    textDisplay(`⏱️ Time in chats: **${formatChatDuration(l.chatMs)}**`),
    textDisplay(`💭 Chats joined: **${fmtNum(l.chats)}**`),
    textDisplay(`🏆 Longest chat: **${formatChatDuration(l.longestChatMs)}**`),
    textDisplay(`🤝 Identities shared: **${fmtNum(l.shares)}**`),
    separator(),
    textDisplay(rep && rep.total > 0
      ? `⭐ Community rating: **${rep.score.toFixed(2)} / 5.00** · ${rep.total} ${rep.total === 1 ? 'rating' : 'ratings'} (${rep.likes} 👍 · ${rep.dislikes} 👎)`
      : '⭐ Community rating: **no ratings yet**. It shows up here once partners rate you.'),
  ];
  if (!l.chats) {
    parts.push(separator(), textDisplay('No chats yet. Run `/new` to meet your first stranger.'));
  }
  return [container(parts)];
}

/** Discord dynamic full timestamp from an ISO date: renders in the viewer's own timezone. */
const discordTs = (iso) => {
  const s = Math.floor(new Date(iso).getTime() / 1000);
  return Number.isFinite(s) ? `<t:${s}:F>` : '';
};

/** Items per page on the /blocklist card (mirrors the /help directory's paging). */
export const BLOCKLIST_PAGE_SIZE = 8;

/**
 * /blocklist: paginated V2 card of the user's blocked strangers, newest
 * first. Each entry is keyed by the stranger's stable 8-char code (the only
 * identifier the blocker ever sees) plus a dynamic <t:…:F> timestamp, so
 * entries stay identifiable without exposing any real identity.
 */
export function blocklistCard(entries, { page = 1 } = {}) {
  if (!entries.length) {
    return simpleCard('🚫 **Blocked strangers**\n\nYou have not blocked anyone. If someone bothers you in a chat, run `/block` and you will never be matched with them again.');
  }
  const totalPages = Math.max(1, Math.ceil(entries.length / BLOCKLIST_PAGE_SIZE));
  const bounded = Math.min(totalPages, Math.max(1, page));
  const start = (bounded - 1) * BLOCKLIST_PAGE_SIZE;
  const shown = entries.slice(start, start + BLOCKLIST_PAGE_SIZE);

  const lines = shown.map((e) => {
    const code = String(e.anonId).slice(0, 8);
    const bits = [`\`${code}\``, discordTs(e.at), `blocked ${e.source === 'recent' ? 'after' : 'during'} a chat`]
      .filter(Boolean);
    return bits.join(' · ');
  });

  const parts = [
    textDisplay(`🚫 **Blocked strangers** (${entries.length})`),
    separator(),
    textDisplay(lines.join('\n')),
  ];
  if (totalPages > 1) {
    parts.push(textDisplay(`Page ${bounded} of ${totalPages}`));
  }
  parts.push(
    separator(),
    textDisplay('Choose someone below to unblock them. They are never told.'),
  );
  if (totalPages > 1) {
    const prev = button(`blocklist:page:${Math.max(1, bounded - 1)}`, '⬅ Previous', BTN.SECONDARY);
    const next = button(`blocklist:page:${Math.min(totalPages, bounded + 1)}`, 'Next ➡', BTN.SECONDARY);
    if (bounded === 1) prev.disabled = true;
    if (bounded === totalPages) next.disabled = true;
    parts.push(actionRow(prev, next));
  }
  parts.push(actionRow({
    type: T.STRING_SELECT,
    custom_id: `unblock_select:${bounded}`,
    placeholder: 'Select a stranger to unblock...',
    min_values: 1,
    max_values: 1,
    options: shown.map((e) => ({
      label: `Stranger ${String(e.anonId).slice(0, 8)}`,
      value: String(e.anonId),
    })),
  }));
  return [container(parts)];
}

/** Welcome card shown to anyone who interacts before onboarding. */
export function onboardWelcomeCard(resuming = false) {
  return [container([
    textDisplay(
      resuming
        ? '👋 **Welcome back.**\n\nLooks like you started setting up your profile but didn\'t finish. Pick up where you left off, it only takes a moment.'
        : '👋 **Welcome to anonymous chat.**\n\n' +
          "Before you jump in, let's get you set up. Three quick steps, about a minute, and you'll never see this again."
    ),
    separator(),
    actionRow(button('onboard_start', resuming ? 'Continue setup' : 'Get started', BTN.PRIMARY, '✨')),
  ])];
}

/** Error card with a button that reopens the wizard at the right step. */
export function onboardRetryCard(message) {
  return [container([
    textDisplay(`⚠️ **That didn't save**\n\n${message}`),
    separator(),
    actionRow(button('onboard_start', 'Try again', BTN.PRIMARY, '↩️')),
  ])];
}

/** Confirmation card once the profile record exists. */
export function onboardDoneCard(name) {
  return [container([
    textDisplay(
      `🎉 **You're in, ${escapeMarkdown(name)}!**\n\n` +
      'Your profile is ready. Use `/new` whenever you want to meet someone.'
    ),
  ])];
}

/** Step 1 card (after the name/DOB modal): prompt for location + bio. */
export function onboardStep2Card(name) {
  return [container([
    textDisplay(
      `Nice to meet you, **${escapeMarkdown(name)}**! Now, where are you chatting from, and what should people know about you?`
    ),
    separator(),
    actionRow(button('onboard_next2', 'Continue', BTN.PRIMARY)),
  ])];
}

/** Step 3 card: prompt for photos/videos, with skip. */
export function onboardMediaPromptCard() {
  return [container([
    textDisplay(
      "Looking good. Last step: add some photos so people can see who's behind the words."
    ),
    separator(),
    actionRow(
      button('onboard_next3', 'Add photos', BTN.PRIMARY, '📷'),
      button('onboard_skip_media', 'Skip for now', BTN.SECONDARY),
    ),
  ])];
}

/** Buttons for the preview step: confirm the profile or start over. */
export function onboardPreviewButtonRow() {
  return [
    button('onboard_confirm', 'Looks good', BTN.SUCCESS, '✅'),
    button('onboard_restart', 'Start over', BTN.SECONDARY, '↩️'),
  ];
}

/** The two rows of edit buttons on the /profile card. */
/** Edit buttons for the /profile card. Pass disabled=true to grey them out
 *  (the card stays fully visible while searching or chatting). */
export function profileEditButtonRows(disabled = false) {
  const rows = [
    [
      button('profile_edit_name', 'Edit Name', BTN.SECONDARY),
      button('profile_edit_dob', 'Edit Date of Birth', BTN.SECONDARY),
      button('profile_edit_location', 'Edit Location', BTN.SECONDARY),
    ],
    [
      button('profile_edit_bio', 'Edit Bio', BTN.SECONDARY),
      button('profile_edit_interests', 'Edit Interests', BTN.SECONDARY),
      button('profile_edit_media', 'Edit Photos', BTN.SECONDARY),
    ],
  ];
  if (disabled) for (const row of rows) for (const b of row) b.disabled = true;
  return rows;
}

/** Intro line shown above the profile card at the preview step. */
export function onboardPreviewIntro() {
  return [container([
    textDisplay("Here's how you'll look when you share your identity. Happy with it?"),
  ])];
}

/** Card for under-13 signups: the platform floor, kindly. */
export function onboardTooYoungCard() {
  return [container([
    textDisplay(
      '👋 **This bot is 13 and up.**\n\n' +
      "Discord itself requires you to be at least 13, so we do too. Come back when you're old enough, we'll be here."
    ),
  ])];
}

const modalTextInput = (custom_id, label, style, {
  placeholder, required = true, min_length, max_length, value,
} = {}) => ({
  type: T.LABEL,
  label,
  ...(placeholder ? { description: placeholder } : {}),
  component: {
    type: 4, custom_id, style, required,
    ...(value ? { value: String(value).slice(0, max_length || 4000) } : {}),
    ...(min_length !== undefined ? { min_length } : {}),
    ...(max_length !== undefined ? { max_length } : {}),
  },
});

/**
 * Wizard modal 1 (custom_id 'onboard_m1'): name + date of birth
 * (Day/Month/Year). `defaults` pre-fills when retrying or resuming.
 */
export function onboardModal1(defaults = {}) {
  const [y, m, d] = String(defaults.dob || '--').split('-');
  const num = (v) => (/^\d+$/.test(v || '') ? v : undefined);
  return {
    type: 9,
    data: {
      custom_id: 'onboard_m1',
      title: 'Create your profile · 1/3',
      components: [
        modalTextInput('onboard_name', 'What should we call you?', 1, {
          placeholder: 'A name, e.g. midnightfox',
          required: true,
          max_length: 30,
          value: defaults.name,
        }),
        modalTextInput('onboard_dob_day', 'Day of birth (DD)', 1, {
          placeholder: 'DD', required: true, min_length: 1, max_length: 2, value: num(d),
        }),
        modalTextInput('onboard_dob_month', 'Month of birth (MM)', 1, {
          placeholder: 'MM', required: true, min_length: 1, max_length: 2, value: num(m),
        }),
        modalTextInput('onboard_dob_year', 'Year of birth (YYYY)', 1, {
          placeholder: 'YYYY', required: true, min_length: 4, max_length: 4, value: num(y),
        }),
      ],
    },
  };
}

/** Wizard modal 2 (custom_id 'onboard_m2'): location + bio. */
export function onboardModal2(defaults = {}) {
  return {
    type: 9,
    data: {
      custom_id: 'onboard_m2',
      title: 'Create your profile · 2/3',
      components: [
        modalTextInput('onboard_location', 'Where are you chatting from?', 1, {
          placeholder: 'Your city or area',
          required: false,
          max_length: 60,
          value: defaults.location,
        }),
        modalTextInput('onboard_bio', 'Tell people a little about yourself', 2, {
          placeholder: 'A sentence or two is perfect...',
          required: false,
          max_length: 500,
          value: defaults.bio,
        }),
      ],
    },
  };
}

/**
 * Wizard modal 3 (custom_id 'onboard_m3'): photos/videos via the File Upload
 * component (1 to 6, images and videos only). Skipping is handled by the
 * "Skip for now" button on the media prompt card instead.
 */
export function onboardModal3() {
  return {
    type: 9,
    data: {
      custom_id: 'onboard_m3',
      title: 'Create your profile · 3/3',
      components: [
        labelWrap(
          'Your photos',
          {
            type: T.FILE_UPLOAD,
            custom_id: 'onboard_media',
            min_values: 1,
            max_values: MAX_PROFILE_MEDIA,
            required: true,
            file_types: ['image', 'video'],
          },
          `Add 1 to ${MAX_PROFILE_MEDIA} photos or videos. They sit at the top of your profile card.`,
        ),
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// /profile editing
// ---------------------------------------------------------------------------

/** Modal custom_id 'profile_update_name_modal'. */
export function profileNameModal(profile) {
  return {
    type: 9,
    data: {
      custom_id: 'profile_update_name_modal',
      title: 'Update Name',
      components: [
        modalTextInput('profile_name_input', 'What should we call you?', 1, {
          required: true, max_length: 30, value: profile.name,
        }),
      ],
    },
  };
}

/** Modal custom_id 'profile_update_dob_modal', prefilled from the stored DOB. */
export function profileDobModal(profile) {
  const [y, m, d] = String(profile.dob || '--').split('-');
  const num = (v) => (/^\d+$/.test(v || '') ? v : undefined);
  return {
    type: 9,
    data: {
      custom_id: 'profile_update_dob_modal',
      title: 'Update Date of Birth',
      components: [
        modalTextInput('profile_dob_day', 'Day (DD)', 1, {
          required: true, min_length: 1, max_length: 2, value: num(d),
        }),
        modalTextInput('profile_dob_month', 'Month (MM)', 1, {
          required: true, min_length: 1, max_length: 2, value: num(m),
        }),
        modalTextInput('profile_dob_year', 'Year (YYYY)', 1, {
          required: true, min_length: 4, max_length: 4, value: num(y),
        }),
      ],
    },
  };
}

/** Modal custom_id 'profile_update_location_modal'. */
export function profileLocationModal(profile) {
  return {
    type: 9,
    data: {
      custom_id: 'profile_update_location_modal',
      title: 'Update Location',
      components: [
        modalTextInput('profile_location_input', 'Where are you chatting from?', 1, {
          required: false, max_length: 60, value: profile.location,
        }),
      ],
    },
  };
}

/** Modal custom_id 'profile_update_bio_modal'. */
export function profileBioModal(profile) {
  return {
    type: 9,
    data: {
      custom_id: 'profile_update_bio_modal',
      title: 'Update Bio',
      components: [
        modalTextInput('profile_bio_input', 'Tell people a little about yourself', 2, {
          required: false, max_length: 500, value: profile.bio,
        }),
      ],
    },
  };
}

/** Modal custom_id 'profile_update_interests_modal'. */
export function profileInterestsModal(profile) {
  return {
    type: 9,
    data: {
      custom_id: 'profile_update_interests_modal',
      title: 'Update Interests',
      components: [
        modalTextInput('profile_interests_input', 'Interests (comma separated)', 2, {
          required: false, max_length: 500, value: (profile.interests || []).join(', '),
        }),
      ],
    },
  };
}

/**
 * Modal custom_id 'profile_update_media_modal': replace the profile photos.
 * Optional upload (0 to 6): submitting with no files removes all photos.
 */
export function profileMediaModal() {
  return {
    type: 9,
    data: {
      custom_id: 'profile_update_media_modal',
      title: 'Update Photos',
      components: [
        labelWrap(
          'Your photos',
          {
            type: T.FILE_UPLOAD,
            custom_id: 'profile_media',
            min_values: 0,
            max_values: MAX_PROFILE_MEDIA,
            required: false,
            file_types: ['image', 'video'],
          },
          `Upload up to ${MAX_PROFILE_MEDIA} photos or videos to replace your current ones. Submit empty to remove them all.`,
        ),
      ],
    },
  };
}
