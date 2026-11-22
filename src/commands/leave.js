// /leave — Leave the matchmaking queue.
// Faithful port of the reference: queue -> leave; in a session -> point at
// /end; otherwise -> not in queue.

import { db } from '../services/database.js';
import { matchmaking } from '../services/matchmaking.js';
import { EmbedFactory } from '../utils/embeds.js';
import { interactionUser, replyClassic } from '../discord/interactions.js';

export const data = {
  name: 'leave',
  description: 'Leave the matchmaking queue',
  integration_types: [0, 1],
  contexts: [0, 1],
};

export const customIds = [];

export async function execute(interaction) {
  const user = interactionUser(interaction);

  // Check if in queue
  const position = matchmaking.getQueuePosition(user.id);
  if (position) {
    matchmaking.removeFromQueue(user.id);
    return replyClassic(interaction, {
      embeds: [EmbedFactory.createSuccessEmbed('Left the Queue', 'You have been removed from the matchmaking queue.')],
    });
  }

  // Check if in session - separate command /end is used for this now
  const session = db.getActiveSessionForUser(user.id);
  if (session) {
    return replyClassic(interaction, {
      embeds: [EmbedFactory.createInfoEmbed('Still in a Chat', 'You are currently in a chat session. Use `/end` to leave the chat.')],
    });
  }

  return replyClassic(interaction, {
    embeds: [EmbedFactory.createInfoEmbed('Not in the Queue', 'You are not in the matchmaking queue.')],
  });
}
