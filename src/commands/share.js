// /share — Swap identities with your chat partner, mutually.
// The requester sends an identity-swap request; the partner gets an
// Accept/Decline card in their DMs. When they accept (or when both sides
// have asked), EACH user receives the other's rich Components-V2 identity
// card: opening line, media showcase, profile summary, Discord identity
// block, closing line. Declining keeps both sides anonymous.
// Anti-spam limits: 2 completed swaps per session in total (not per user),
// 60 seconds between requests for both participants.

import { db } from '../services/database.js';
import * as chat from '../services/chat.js';
import { safety } from '../services/safety.js';
import {
  EmbedFactory, shareRequestCard, identityRevealCard, simpleCard,
} from '../utils/embeds.js';
import { Rest, V2 } from '../discord/rest.js';
import {
  deferUpdate, editOriginalV2, interactionUser, replyClassic, replyV2, safe,
} from '../discord/interactions.js';
import { loadProfileMediaFiles } from '../utils/media.js';
import { logger, splitCustomId } from '../util.js';

export const data = {
  name: 'share',
  description: 'Request a mutual identity swap with your chat partner',
  integration_types: [0, 1],
  contexts: [0, 1],
};

export const customIds = ['share_accept', 'share_decline'];

const SWAP_CAP = 2;
const REQUEST_COOLDOWN_S = 60;
const PENDING_TTL_MS = 5 * 60 * 1000;

/**
 * The request/accept buttons live on real DM messages: edit via REST.
 * B5: prefer the STORED live-card location (cardRef) over the tap's
 * message — a bare tap's message can be any stale card, and editing it
 * leaves the real request card live (double-consumable). Falls back to
 * the interaction's message when no card was stored (DM send failed or
 * legacy request without a stored ref).
 */
async function editRequestCard(ix, components, cardRef) {
  const channelId = cardRef?.channelId || ix.channel_id;
  const messageId = cardRef?.messageId || ix.message?.id;
  if (channelId && messageId) {
    await safe(
      Rest.editMessage(channelId, messageId, { flags: V2, components }),
      'share request card edit',
    );
  }
}

function otherParty(session, userId) {
  return session.user1_id === String(userId) ? session.user2_id : session.user1_id;
}

/**
 * Per-session completed-swap counter, stored alongside the per-user share
 * records under a session-scoped key. The "2 per session" cap is a session
 * total, so both participants consuming it is what enforces the limit.
 */
function getSessionSwapCount(sessionId) {
  const rec = db.db.shares[`${sessionId}:swaps`];
  return rec && typeof rec.count === 'number' ? rec.count : 0;
}

function recordSessionSwap(sessionId) {
  const key = `${sessionId}:swaps`;
  const rec = db.db.shares[key] || { count: 0, last_share: 0 };
  rec.count += 1;
  // Stamp last_share: the >500-entry eviction in recordUsernameShare drops
  // least-recently-shared keys first, and a :swaps key stuck at 0 would be
  // evicted first mid-session, silently resetting the cap counter.
  rec.last_share = Date.now();
  db.db.shares[key] = rec;
  db.save();
}

/** Roll back one reserved cap slot (delivery failure or dead session).
 * B2: byte-exact — restores the full prior :swaps record (count AND
 * last_share), or deletes the key when none existed before the
 * reservation. A bare count decrement would leave the reservation's
 * last_share stamp behind.
 */
function unrecordSessionSwap(sessionId, prevSwaps) {
  const key = `${sessionId}:swaps`;
  if (prevSwaps) db.db.shares[key] = { count: prevSwaps.count, last_share: prevSwaps.last_share };
  else delete db.db.shares[key];
  db.save();
}

/** Stamp the 60s request cooldown for a user without consuming the cap. */
function recordShareCooldown(sessionId, userId) {
  const key = `${sessionId}:${userId}`;
  const cur = db.getShareData(sessionId, userId);
  db.db.shares[key] = { count: cur.count, last_share: Date.now() };
  db.save();
}

/** Restore a user's share record to a previously snapshotted state. */
function restoreShareData(sessionId, userId, prev) {
  const key = `${sessionId}:${userId}`;
  if (!prev || (prev.count === 0 && prev.last_share === 0)) delete db.db.shares[key];
  else db.db.shares[key] = { count: prev.count, last_share: prev.last_share };
  db.save();
}

/** Remaining seconds on a user's 60s request cooldown (0 = clear). */
function cooldownRemainingS(sessionId, userId) {
  const d = db.getShareData(sessionId, userId);
  if (!d.last_share) return 0;
  const rem = REQUEST_COOLDOWN_S - (Date.now() - d.last_share) / 1000;
  return rem > 0 ? Math.ceil(rem) : 0;
}

/**
 * The live pending request, or null. Pending requests expire after
 * 5 minutes so an AFK partner cannot leave the requester stuck on
 * "already sent a request" forever. B4: expiry is no longer silent —
 * the requester is DM-notified and the live request card is retired.
 * Boundary: exactly 300.000s is still live, 300.001s is expired.
 */
function liveShareRequest(session) {
  const req = session?.shareRequest;
  if (!req) return null;
  if (typeof req.at === 'number' && Date.now() - req.at > PENDING_TTL_MS) {
    session.shareRequest = null;
    // Fire-and-forget: the expiry notice must not block the caller, and
    // liveShareRequest stays synchronous for its other call sites.
    void expireShareRequest(req);
    return null;
  }
  return req;
}

/**
 * B4: the async tail of a lazy expiry. Tells the requester their share
 * request expired with no answer, and retires the stored live request
 * card so its Accept/Decline buttons can't be tapped afterwards.
 */
async function expireShareRequest(req) {
  try {
    if (req.card?.channelId && req.card?.messageId) {
      await safe(
        Rest.editMessage(req.card.channelId, req.card.messageId, {
          flags: V2,
          components: simpleCard('This share request expired with no answer. You can send a fresh one with /share.'),
        }),
        'expire share request card',
      );
    }
    await chat.sendDM(req.from, simpleCard(
      "Your share request expired with no answer. No worries, you're still anonymous. Send a fresh request with /share whenever you like.",
    ));
  } catch (err) {
    logger.warn(`share request expiry notice failed: ${err.message}`);
  }
}

/**
 * The request card with the session id embedded in the button ids
 * (share_accept:<sessionId>). A tap on a stale card from an older chat can
 * then never consume a newer chat's pending request. The router matches on
 * the head ('share_accept'), so no routing change is needed.
 */
function scopedRequestCard(sessionId) {
  const card = shareRequestCard();
  const scope = (nodes) => {
    for (const n of nodes || []) {
      if (n && n.type === 2 && (n.custom_id === 'share_accept' || n.custom_id === 'share_decline')) {
        n.custom_id = `${n.custom_id}:${sessionId}`;
      }
      if (n && Array.isArray(n.components)) scope(n.components);
    }
  };
  scope(card);
  return card;
}

/** Fallback card data when a profile record is unexpectedly missing. */
function fallbackProfile(id) {
  return {
    id: String(id), name: 'Someone', dob: null, location: '',
    bio: '', interests: [], media: [],
  };
}

/**
 * Complete the swap: clear the pending request, DM each side the other's
 * identity reveal card, and stamp the 60s cooldown for BOTH participants.
 * The cap slot and both cooldowns are reserved synchronously at entry
 * (before the first await) so a /share landing in the DM-send window sees
 * the reservation; they are rolled back if the chat dies mid-swap or a
 * card fails to deliver, so only a fully delivered swap consumes them.
 * acceptIx is the Accept button interaction (for editing its card), or null
 * when the swap was triggered by the partner's own /share.
 */
async function completeSwap(session, requesterId, accepterId, acceptIx) {
  const sid = session.session_id;

  // Cap check at entry, before any await: a raced Accept can otherwise
  // push the session past the limit.
  if (getSessionSwapCount(sid) >= SWAP_CAP) {
    const cardRef = session.shareRequest?.card || null;
    session.shareRequest = null;
    if (acceptIx) {
      await safe(deferUpdate(acceptIx), 'share accept defer');
      await editRequestCard(acceptIx, simpleCard('This chat has already used its 2 identity swaps.'), cardRef);
    }
    await chat.sendDM(requesterId, simpleCard('This chat has already used its 2 identity swaps.'));
    logger.info(`share swap refused (cap): ${requesterId} <-> ${accepterId}`);
    return;
  }

  // Pessimistic reservation, synchronously at entry.
  const prevRequester = db.getShareData(sid, requesterId);
  const prevAccepter = db.getShareData(sid, accepterId);
  // B2: snapshot the :swaps record too, so the rollback restores its
  // prior last_share (not just the count).
  const swapsKey = `${sid}:swaps`;
  const prevSwaps = db.db.shares[swapsKey] ? { ...db.db.shares[swapsKey] } : null;
  // B5: the live request card's location, for the accept-card edit below.
  const requestCard = session.shareRequest?.card || null;
  session.shareRequest = null;
  db.recordUsernameShare(sid, requesterId);
  recordShareCooldown(sid, accepterId);
  recordSessionSwap(sid);
  // rollback() is throw-safe (pure sync DB writes), so the catch below
  // can always run it.
  const rollback = () => {
    unrecordSessionSwap(sid, prevSwaps);
    restoreShareData(sid, requesterId, prevRequester);
    restoreShareData(sid, accepterId, prevAccepter);
  };

  // B1: everything after the reservation runs inside try/catch. An
  // unexpected throw in this span (e.g. identityRevealCard on a malformed
  // profile) must not leak the reserved cap slot or the phantom 60s
  // cooldowns; the error is rethrown after the rollback.
  try {
    // The Accept tap's interaction token may be expired; never let that drop
    // the request silently. The card edit below goes through REST (channel +
    // message ids), so it survives a dead token, and the swap continues.
    if (acceptIx) {
      await safe(deferUpdate(acceptIx), 'share accept defer');
      await editRequestCard(acceptIx, simpleCard(
        'You accepted. Your profile cards are on their way to both of you now.',
      ), requestCard);
    }

    const requesterProfile = db.getUserProfile(requesterId) || fallbackProfile(requesterId);
    const accepterProfile = db.getUserProfile(accepterId) || fallbackProfile(accepterId);
    const [requesterUser, accepterUser] = await Promise.all([
      chat.safeGetUser(requesterId),
      chat.safeGetUser(accepterId),
    ]);

    // The chat may have ended while we were yielding (Accept racing /end).
    // Skip the reveal DMs and roll back the reservation if the session is dead.
    if (db.getActiveSessionForUser(requesterId)?.session_id !== sid
        || db.getActiveSessionForUser(accepterId)?.session_id !== sid) {
      rollback();
      logger.info(`share swap aborted: session ${sid} ended mid-swap`);
      return;
    }

    const cardForAccepter = identityRevealCard(
      requesterProfile, requesterUser?.username || 'unknown', requesterId,
      loadProfileMediaFiles(requesterProfile),
      "Here's the person you've been chatting with.",
    );
    const cardForRequester = identityRevealCard(
      accepterProfile, accepterUser?.username || 'unknown', accepterId,
      loadProfileMediaFiles(accepterProfile),
    );

    // B6 / lifecycle bugs 3+4: re-check liveness IMMEDIATELY before the
    // card-send Promise.all. A /block or mod termination that landed after
    // the check above must not deliver identity cards to a dead or blocked
    // pair. Cards can't be un-sent, but the cap/cooldown accounting stays
    // honest via the rollback.
    if (db.getActiveSessionForUser(requesterId)?.session_id !== sid
        || db.getActiveSessionForUser(accepterId)?.session_id !== sid
        || chat.isSessionConcluding(sid)
        || db.isBlockedBetween(requesterId, accepterId)) {
      rollback();
      logger.warn(`share swap aborted pre-send: session ${sid} dead, concluding, or blocked mid-swap`);
      return;
    }

    const [r1, r2] = await Promise.all([
      chat.sendDM(accepterId, cardForAccepter.components, cardForAccepter.files, { noMentions: true }),
      chat.sendDM(requesterId, cardForRequester.components, cardForRequester.files, { noMentions: true }),
    ]);

    // Only a fully delivered swap keeps the reservation. On failure the cap
    // slot and both cooldowns are restored. B3: the failure notice goes to
    // the side whose DM actually failed, AND the delivered side is told
    // their partner never got the card back (no more silent one-way
    // exposure, no more double-delivery surprise on retry).
    if (!r1.ok || !r2.ok) {
      rollback();
      const failedId = !r1.ok ? accepterId : requesterId;
      const deliveredId = failedId === accepterId ? requesterId : accepterId;
      await chat.sendDM(failedId, simpleCard(
        "We couldn't deliver a profile card just now. Your partner may have closed their DMs.",
      ));
      await chat.sendDM(deliveredId, simpleCard(
        "Quick heads up: your profile card reached your partner, but theirs couldn't reach you, so they never saw your card. They can retry with /share whenever they're ready.",
      ));
      logger.info(`share swap: ${requesterId} <-> ${accepterId} (delivery failed, reservation rolled back)`);
      return;
    }

    db.recordShareLifetime(requesterId);
    db.recordShareLifetime(accepterId);
    logger.info(`share swap: ${requesterId} <-> ${accepterId} (delivered: true)`);
  } catch (err) {
    rollback();
    throw err;
  }
}

export async function execute(interaction) {
  const user = interactionUser(interaction);
  const session = db.getActiveSessionForUser(user.id);

  if (!session) {
    return replyClassic(interaction, {
      embeds: [EmbedFactory.createInfoEmbed('No Active Chat', 'You are not in an active chat.')],
    });
  }

  const live = liveShareRequest(session);

  // If the partner already asked, this /share IS the mutual agreement.
  // Snapshot the request BEFORE the await: a second rapid /share (or an
  // Accept tap) can resolve it while we are yielding, and the stale
  // session.shareRequest would then be null.
  if (live && live.from !== user.id) {
    const pending = live;
    await replyV2(interaction, simpleCard('They already asked. Swapping identities now.'));
    if (session.shareRequest !== pending) {
      return editOriginalV2(interaction, simpleCard(
        'That request was already handled. You are still anonymous.',
      ));
    }
    // The session may have ended while we were yielding; the orphaned
    // session object still matches the snapshot above.
    if (db.getActiveSessionForUser(user.id)?.session_id !== session.session_id) {
      return editOriginalV2(interaction, simpleCard('That chat has already ended.'));
    }
    // The mutual path gets the same cap + cooldown checks as a fresh
    // request: without them a decline-throttled user can answer a new
    // request immediately and complete a swap.
    if (getSessionSwapCount(session.session_id) >= SWAP_CAP) {
      return editOriginalV2(interaction, simpleCard('This chat has already used its 2 identity swaps.'));
    }
    const cd = cooldownRemainingS(session.session_id, user.id);
    if (cd > 0) {
      return editOriginalV2(interaction, simpleCard(`Please wait ${cd} seconds before sharing again.`));
    }
    await completeSwap(session, pending.from, user.id, null);
    return;
  }
  if (live) {
    return replyV2(interaction, simpleCard('You already sent a request. Waiting on your partner.'));
  }

  // Check cooldown/limits. The cap is a per-session total: once two swaps
  // have completed in this chat, nobody can start another one.
  if (getSessionSwapCount(session.session_id) >= SWAP_CAP) {
    return replyClassic(interaction, {
      embeds: [EmbedFactory.createErrorEmbed('Share Limit Reached', 'You have reached the limit of 2 shares per session.')],
    });
  }

  const shareData = db.getShareData(session.session_id, user.id);

  if (shareData.last_share) {
    const timeDiff = (Date.now() - shareData.last_share) / 1000; // seconds
    if (timeDiff < 60) {
      return replyClassic(interaction, {
        embeds: [EmbedFactory.createInfoEmbed('Slow Down', `Please wait ${Math.ceil(60 - timeDiff)} seconds before sharing again.`)],
      });
    }
  }

  const partnerId = otherParty(session, user.id);
  session.shareRequest = { from: user.id, at: Date.now() };
  // Snapshot the created request: if the partner completes the swap via
  // the mutual path while our DM is in flight, session.shareRequest is no
  // longer ours and the ack must NOT be rewritten to a false failure.
  const mine = session.shareRequest;
  // Ack FIRST: the interaction must be answered within 3s, and the DM send
  // below is network I/O. If the DM fails, the ack is updated in place.
  await replyV2(interaction, simpleCard(
    "Request sent. If they accept, you'll both see each other's profile card.",
  ));
  const res = await chat.sendDM(partnerId, scopedRequestCard(session.session_id));
  // B4/B5: remember where the live request card landed, so expiry,
  // accept, and decline all edit THIS card (not the tap's message).
  if (res.ok && session.shareRequest === mine) {
    mine.card = { channelId: res.channelId, messageId: res.messageId };
  }
  if (!res.ok && session.shareRequest === mine) {
    session.shareRequest = null;
    await editOriginalV2(interaction, simpleCard(
      "We couldn't reach your partner right now. They may have closed their DMs.",
    ));
  }
}

export async function handleInteraction(interaction) {
  const [head, arg] = splitCustomId(interaction.data?.custom_id);
  const user = interactionUser(interaction);

  if (head !== 'share_accept' && head !== 'share_decline') return;

  // Integration-1: narrow safety gate (same pattern as handleChatFindNew).
  // The router gates only slash commands, so without this a banned user
  // could complete a pending swap through these buttons. Ephemeral notice,
  // no state change.
  if (!safety.checkUserSafetyStatus(user.id).isAllowed) {
    return replyV2(interaction, simpleCard('This account is not allowed to use the bot.'));
  }

  const session = db.getActiveSessionForUser(user.id);
  const req = liveShareRequest(session);
  if (!session || !req || req.from === user.id) {
    return replyV2(interaction, simpleCard(head === 'share_accept'
      ? "There's no pending share request to accept."
      : 'There\'s no pending share request to decline.'));
  }
  // The session id is embedded in the button id; a tap on a stale card
  // from an older chat must not consume the current chat's request.
  if (arg && session.session_id !== arg) {
    return replyV2(interaction, simpleCard(
      'That request is from an earlier chat. Ask your current partner with /share instead.',
    ));
  }

  if (head === 'share_decline') {
    const requesterId = req.from;
    session.shareRequest = null;
    // Throttle the requester: without this, request -> decline can be
    // looped to spam the partner's DMs. No cap is consumed by a decline.
    recordShareCooldown(session.session_id, requesterId);
    await deferUpdate(interaction);
    await editRequestCard(interaction, simpleCard(
      'No worries. You stay anonymous, and the chat goes on as before.',
    ), req.card);
    await chat.sendDM(requesterId, simpleCard(
      "They'd rather stay anonymous for now. No worries, your chat continues as is.",
    ));
    logger.info(`share declined: ${requesterId} x ${user.id}`);
    return;
  }

  // share_accept: the accept path gets the same cap + cooldown checks as a
  // fresh request, so a raced swap cannot push the session past the limit.
  if (getSessionSwapCount(session.session_id) >= SWAP_CAP) {
    return replyV2(interaction, simpleCard('This chat has already used its 2 identity swaps.'));
  }
  const cd = cooldownRemainingS(session.session_id, user.id);
  if (cd > 0) {
    return replyV2(interaction, simpleCard(`Please wait ${cd} seconds before sharing again.`));
  }
  // completeSwap defers this interaction and edits the request card.
  await completeSwap(session, req.from, user.id, interaction);
}
