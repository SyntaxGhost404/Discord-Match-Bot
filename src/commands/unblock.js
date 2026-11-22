// /unblock — Unblock a stranger by their 8-character reference code
// (the code shown in /blocklist). Uses the exact same confirmation
// container as the /blocklist string select, so every unblock action
// behaves identically across the bot.

import { db } from '../services/database.js';
import { simpleCard, unblockResultCard } from '../utils/embeds.js';
import { interactionUser, optString, replyV2 } from '../discord/interactions.js';
import { logger } from '../util.js';

export const data = {
  name: 'unblock',
  description: 'Unblock a user by their anonymous ID',
  options: [{
    type: 3,
    name: 'anonymous_id',
    description: 'The anonymous ID to unblock',
    required: true,
  }],
  integration_types: [0, 1],
  contexts: [0, 1],
};

export const customIds = [];

export async function execute(interaction) {
  const user = interactionUser(interaction);
  const raw = optString(interaction, 'anonymous_id') || '';
  // removeBlock already matches full ids, full anon ids, and 8-char codes;
  // normalize the display code the same way the /blocklist select does.
  const code = raw.replace(/\./g, '').slice(0, 8);
  const ok = db.removeBlock(user.id, raw);
  // 'ambiguous' is truthy but deleted nothing: the short code matched 2+
  // strangers, so ask for more characters instead of showing success.
  if (ok === 'ambiguous') {
    return replyV2(interaction, simpleCard(
      `⚠️ That code matches more than one blocked stranger. Type a few more characters of the \`${code}\` code so the right person gets unblocked.`,
    ), { ephemeral: true });
  }
  logger.info(`unblock via command: ${user.id} -> ${code} (${ok ? 'ok' : 'not found'})`);
  // Ephemeral V2 confirmation: the unblock is private, and the canonical
  // copy explains the stranger can be matched again and was never told.
  await replyV2(interaction, unblockResultCard(ok, code), { ephemeral: true });
}
