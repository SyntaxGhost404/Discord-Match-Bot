// /new — Find a new chat partner.
// Faithful port of the reference: safety gate -> profile gate -> active
// session gate -> queue gate -> add to queue -> attempt a match.

import { db } from '../services/database.js';
import { safety } from '../services/safety.js';
import { matchmaking } from '../services/matchmaking.js';
import * as chat from '../services/chat.js';
import { EmbedFactory, searchingCard, simpleCard } from '../utils/embeds.js';
import { interactionUser, replyClassic, replyV2, getOriginalMessage, editOriginalV2 } from '../discord/interactions.js';
import { logger } from '../util.js';

export const data = {
  name: 'new',
  description: 'Find a new chat partner',
  integration_types: [0, 1],
  contexts: [0, 1],
};

export const customIds = [];

export async function execute(interaction) {
  const user = interactionUser(interaction);

  // 1. Check Safety Status
  const safetyStatus = safety.checkUserSafetyStatus(user.id);
  if (!safetyStatus.isAllowed) {
    return replyClassic(interaction, {
      embeds: [EmbedFactory.createErrorEmbed('Access Denied', safetyStatus.reason)],
    });
  }

  // 2. Check Profile Existence
  const profile = db.getUserProfile(user.id);
  if (!profile || !profile.is_onboarded) {
    return replyClassic(interaction, {
      embeds: [EmbedFactory.createInfoEmbed('Set Up Your Profile', 'Please set up your profile first. Run any command to start the setup.')],
    });
  }

  // 3. Check Active Session
  const activeSession = db.getActiveSessionForUser(user.id);
  if (activeSession) {
    return replyClassic(interaction, {
      embeds: [EmbedFactory.createInfoEmbed('Already in a Chat', 'You are already in a chat! Use `/end` to end it first.')],
    });
  }

  // 3b. In-flight conclusion gate: the old session is already gone from the
  // DB, but its conclusion DMs may still be on the wire. Queueing now could
  // form a new chat whose greeting lands BEFORE the old "chat ended" cards.
  if (chat.isUserConcluding(user.id)) {
    return replyClassic(interaction, {
      embeds: [EmbedFactory.createInfoEmbed('One Moment', 'Finishing up your last chat. Try again in a few seconds.')],
    });
  }

  // 4. Check if already in queue
  const position = matchmaking.getQueuePosition(user.id);
  if (position) {
    return replyClassic(interaction, {
      embeds: [EmbedFactory.createInfoEmbed('Already Searching', 'You are already in the queue! Please wait...')],
    });
  }

  // 5. Add to Queue
  const added = matchmaking.addToQueue(user.id, profile.anonymous_id);

  if (added) {
    // Non-ephemeral on purpose: the card lands as a real message in the DM,
    // so the cancel button survives app restarts. An ephemeral reply would
    // vanish and strand the user in the queue with no way to cancel.
    // Position/size are scoped to the user's sliding window: only the
    // waiters who can actually be paired with them are counted.
    const st = matchmaking.getEligibleQueueStats(user.id);
    // Coordination token for the rollback below: chat.js records informed
    // fizzle restores with a monotonic sequence. A restore newer than this
    // snapshot means the queue entry was legitimately re-created mid-call.
    const fizzleSeq = chat.fizzleRestoreSeqNow();
    // Set once the searching card is in the user's hands: even if a later
    // step in the try throws, the entry must stay (the user was informed).
    let replied = false;
    try {
      await replyV2(interaction, searchingCard(st.position, st.size), { ephemeral: false });
      replied = true;

      // Learn the reply's message id so the Cancel-search liveness guard can
      // tell this card apart from stale cards of earlier search episodes.
      const original = await getOriginalMessage(interaction);
      if (original?.id) matchmaking.setSearchingCardId(user.id, original.id);
    } catch (err) {
      // The callback is dead (expired interaction, transport failure).
      // Roll back ONLY the entry this call added: skip when the user was
      // already informed — a delivered searching card, a live session, or a
      // fizzle restore that arrived with an honest "back in the queue" card
      // — so a dying callback can't yank state the user is relying on.
      const informed = replied
        || chat.fizzleRestoredSeqFor(user.id) > fizzleSeq
        || db.getActiveSessionForUser(user.id);
      if (!informed) {
        logger.warn(`new: callback failed for ${user.id}, rolling back queue: ${err.message}`);
        matchmaking.removeFromQueue(user.id);
      } else {
        logger.info(`new: callback failed for ${user.id}, keeping queue entry (user already informed)`);
      }
      return;
    }

    // Trigger match attempt
    await attemptMatch(user.id);

    // Queue 3a/3c: the match attempt can leave the caller neither queued
    // nor in a session (closed-DM fizzle drop, a throw past takePair...).
    // Don't strand them on a live "Searching" card: a closed-DM user gets
    // the honest explainer, everyone else a terminal state (this also
    // retires the stale card behind "That search already ended.").
    if (!matchmaking.getQueuePosition(user.id) && !db.getActiveSessionForUser(user.id)) {
      if (chat.isClosedDmUser(user.id)) {
        await editOriginalV2(interaction, simpleCard(
          "We couldn't reach you in DMs, so the search couldn't go through. Open your DMs and try /new again.",
        ), [], { ephemeral: false });
      } else {
        await editOriginalV2(interaction, simpleCard(
          "That search ended before we found anyone. Run /new again whenever you're ready.",
        ), [], { ephemeral: false });
      }
    }
  } else {
    await replyClassic(interaction, {
      embeds: [EmbedFactory.createErrorEmbed('Queue Error', 'Failed to join the queue. Please try again.')],
    });
  }
}

async function attemptMatch(userId) {
  try {
    // Honors the fizzle circuit breaker and the banned-while-queued guard;
    // null = no match, cooldown, or refused — the user stays queued.
    await chat.startChatFromMatch(matchmaking.findMatch(userId));
  } catch (error) {
    logger.error('Matchmaking error:', error);
  }
}
