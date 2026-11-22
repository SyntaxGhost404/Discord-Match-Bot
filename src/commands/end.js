// /end — End your current chat session.
// The ender gets their persistent session summary card as the (visible,
// non-ephemeral) command response; the partner gets theirs as a fresh DM.

import { db } from '../services/database.js';
import * as chat from '../services/chat.js';
import { EmbedFactory, simpleCard } from '../utils/embeds.js';
import {
  interactionUser, replyClassic, deferPublic, editOriginalV2, safe,
} from '../discord/interactions.js';

export const data = {
  name: 'end',
  description: 'End your current chat session',
  integration_types: [0, 1],
  contexts: [0, 1],
};

export const customIds = [];

export async function execute(interaction) {
  const user = interactionUser(interaction);

  // Check if in session
  const session = db.getActiveSessionForUser(user.id);
  if (!session) {
    return replyClassic(interaction, {
      embeds: [EmbedFactory.createInfoEmbed('No Active Chat', 'You are not in an active chat session.')],
    });
  }

  // Defer publicly: the status card that replaces this response persists
  // in the DM like any other message (never ephemeral).
  await deferPublic(interaction);
  const { messages, duplicate } = await chat.concludeSession(session, 'manual', user.id, { omitDMFor: user.id });
  // The ender's two conclusion messages: the status card replaces the
  // command response in place, then the overview embed lands as the second
  // message. The partner got theirs as two fresh DMs. On a duplicate
  // On a duplicate conclusion the racing winner already delivered everything,
  // so there is nothing to deliver in place. The defer above still needs
  // resolving, or the public "thinking..." response hangs forever in the DM.
  if (duplicate) {
    return safe(
      editOriginalV2(interaction, simpleCard('That chat just ended.'), [], { ephemeral: false }),
      'end duplicate notice',
    );
  }
  const mine = messages[String(user.id)];
  await safe(
    editOriginalV2(interaction, mine.v2, [], { ephemeral: false }),
    'end status card',
  );
  await chat.sendEmbedDM(user.id, [mine.embed]);
}
