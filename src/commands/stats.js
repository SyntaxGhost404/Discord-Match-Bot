// /stats — Your lifetime conversation metrics.
// Shows the caller's personal lifetime stats: messages sent, attachments
// shared, total time in chats, plus chats joined, longest chat, voice
// notes and completed identity shares. Ephemeral V2 card.

import { db } from '../services/database.js';
import { personalStatsCard } from '../utils/embeds.js';
import { interactionUser, replyV2 } from '../discord/interactions.js';

export const data = {
  name: 'stats',
  description: 'View your lifetime chat stats',
  integration_types: [0, 1],
  contexts: [0, 1],
};

export const customIds = [];

export async function execute(interaction) {
  const user = interactionUser(interaction);
  const lifetime = db.getLifetimeStats(user.id) || db.constructor.blankLifetime();
  await replyV2(interaction, personalStatsCard(lifetime, db.getReputation(user.id)), { ephemeral: true });
}
