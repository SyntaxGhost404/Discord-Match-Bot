// /block — Block a chat partner and never be matched with them again.
//
// Two paths, one promise (the blocked stranger is never told who blocked them):
//   1. Live chat: blocks the current partner immediately and ends the chat.
//      The partner only ever sees the generic "disconnected" notice.
//   2. After the chat: with no active session, blocks the most recent partner
//      you have not already blocked (drawn from your recent-partners ring),
//      so someone who misbehaved at the very end can still be shut out.

import { db } from '../services/database.js';
import { safety } from '../services/safety.js';
import * as chat from '../services/chat.js';
import { EmbedFactory } from '../utils/embeds.js';
import { interactionUser, replyClassic, safe } from '../discord/interactions.js';
import { logger } from '../util.js';

export const data = {
  name: 'block',
  description: 'Block your chat partner forever',
  integration_types: [0, 1],
  contexts: [0, 1],
};

export const customIds = [];

export async function execute(interaction) {
  const user = interactionUser(interaction);
  const me = user.id;

  // Path 1: live chat -> block the partner on the spot, end the chat.
  const session = db.getActiveSessionForUser(me);
  if (session) {
    const partnerId = session.user1_id === me ? session.user2_id : session.user1_id;
    safety.emergencyBlockUser(me, partnerId, 'User requested block', { source: 'chat' });
    // Conclude BEFORE the interaction reply: concludeSession only sends DMs
    // (it never touches the interaction token), so a dead/expired token must
    // not leave the chat live between a blocked pair. The confirmation reply
    // is best-effort, like /end's status card.
    // Lifecycle BUG 1: concludeSession is unguarded here — on the
    // (near-impossible) DB-layer throw, the block above is already
    // recorded but the chat stays live and the interaction dies
    // unanswered. Answer honestly instead.
    try {
      await chat.concludeSession(session, 'block', me);
    } catch (err) {
      logger.warn(`block: concludeSession threw for ${session.session_id}: ${err.message}`);
      await safe(replyClassic(interaction, {
        embeds: [EmbedFactory.createInfoEmbed(
          'Blocked',
          'They are blocked and will never be matched with you again. The chat may still be live though, so try /end again to close it.',
        )],
      }), 'block failure notice');
      return;
    }
    await safe(replyClassic(interaction, {
      embeds: [EmbedFactory.createSuccessEmbed(
        'Blocked',
        'They are blocked and the chat is over. You will never be matched with them again.',
      )],
    }), 'block confirmation');
    return;
  }

  // Path 2: no live chat -> block the most recent partner not already blocked.
  const target = db.getRecentPartners(me).find((pid) => !db.isBlockedBetween(me, pid));
  if (!target) {
    return replyClassic(interaction, {
      embeds: [EmbedFactory.createInfoEmbed(
        'No One To Block',
        'You are not in a chat right now, and there is no recent partner left to block.',
      )],
    });
  }
  safety.emergencyBlockUser(me, target, 'User requested block', { source: 'recent' });
  await replyClassic(interaction, {
    embeds: [EmbedFactory.createSuccessEmbed(
      'Blocked',
      `Your most recent chat partner (\`${db.getAnonId(target).slice(0, 8)}\`) is blocked. You will never be matched with them again.`,
    )],
  });
}
