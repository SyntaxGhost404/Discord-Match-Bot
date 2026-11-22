// Central interaction router. Every INTERACTION_CREATE from the gateway lands
// here, is serialized per-user (prevents double-click races), then dispatched
// to the right command: slash commands by name, components/modals by the head
// of their custom_id (split on the first ':') matched against each command's
// customIds list.
//
// Chat-card buttons (chat_end / chat_report / chat_find_new / queue_cancel)
// are handled by the chat service.

import { safety } from './services/safety.js';
import * as chat from './services/chat.js';
import * as onboarding from './flows/onboarding.js';
import { EmbedFactory } from './utils/embeds.js';
import { interactionUser, replyClassic, replyV2, followupClassic, editOriginalClassic, safe } from './discord/interactions.js';
import { logger, splitCustomId } from './util.js';
import { simpleCard } from './utils/embeds.js';

import * as newCmd from './commands/new.js';
import * as leaveCmd from './commands/leave.js';
import * as endCmd from './commands/end.js';
import * as blockCmd from './commands/block.js';
import * as blocklistCmd from './commands/blocklist.js';
import * as unblockCmd from './commands/unblock.js';
import * as shareCmd from './commands/share.js';
import * as statsCmd from './commands/stats.js';
import * as reportCmd from './commands/report.js';
import * as profileCmd from './commands/profile.js';

const COMMANDS = [
  newCmd, leaveCmd, endCmd, blockCmd, blocklistCmd,
  unblockCmd, shareCmd, statsCmd, reportCmd, profileCmd,
];
const BY_NAME = Object.fromEntries(COMMANDS.map((c) => [c.data.name, c]));

// ---------------------------------------------------------------------------
// per-user serialization
// ---------------------------------------------------------------------------

const userChains = new Map();

// Hunt 4 R4: a single chain step must not park the user's whole queue past
// Discord's 3s ack window — one 429-capped REST retry can take ~60.5s per call.
const CHAIN_STEP_BUDGET_MS = 8000;

export function routeInteraction(interaction) {
  if (!interaction || typeof interaction !== 'object') {
    logger.warn('routeInteraction called with a non-object interaction, ignoring');
    return Promise.resolve();
  }
  const user = interactionUser(interaction);
  const key = user.id || 'anon';
  const prev = userChains.get(key) || Promise.resolve();
  const step = prev.catch(() => {}).then(() => handleInteraction(interaction, user));
  // Race the chain step against a fixed budget. On timeout the chain advances
  // while the late step keeps running in the background — its eventual reply
  // is swallowed by safe() (40060 "already acknowledged" / 404 on the
  // webhook), so the user still gets at most one visible outcome per step.
  //
  // ORDERING TRADEOFF: a timed-out step's late reply can land OUT OF ORDER
  // relative to interactions handled after it (e.g. a slow /stats edit
  // arriving after a newer card). Accepted deliberately: for a chat bot,
  // responsiveness beats strict ordering, and every step still runs exactly
  // once — only the serialization guarantee is softened to "best effort".
  let budgetTimer;
  const budget = new Promise((resolve) => {
    budgetTimer = setTimeout(() => {
      logger.warn(`routeInteraction chain step for user ${key} exceeded ${CHAIN_STEP_BUDGET_MS}ms; advancing chain, step continues in background`);
      resolve();
    }, CHAIN_STEP_BUDGET_MS);
    if (typeof budgetTimer.unref === 'function') budgetTimer.unref();
  });
  const raced = Promise.race([
    step.then(
      (v) => { clearTimeout(budgetTimer); return v; },
      (err) => { clearTimeout(budgetTimer); throw err; },
    ),
    budget,
  ]);
  const tracked = raced.catch(() => {});
  userChains.set(key, tracked);
  tracked.finally(() => { if (userChains.get(key) === tracked) userChains.delete(key); });
  step.catch(() => {}); // background steps must never surface an unhandled rejection
  return raced;
}

async function handleInteraction(interaction, user) {
  // NOTE: every dispatch below uses `return await`, not bare `return`. In an
  // async function, `try { return promise } catch` does NOT catch the
  // promise's rejection (the implicit await happens after the try exits), so
  // a bare return would let handler failures skip the catch-all error reply
  // and leave the user staring at "application did not respond".
  try {
    const type = interaction.type;

    if (type === 2) {
      const name = interaction.data?.name;
      const cmd = BY_NAME[name];
      if (!cmd) return await replyClassic(interaction, {
        embeds: [EmbedFactory.createErrorEmbed('Unknown Command', "We don't recognize that command. Try `/new` to meet someone new.")],
      });
      const status = safety.checkUserSafetyStatus(user.id);
      if (!status.isAllowed) {
        return await replyClassic(interaction, {
          embeds: [EmbedFactory.createErrorEmbed('Access Denied', status.reason)],
        });
      }
      // Mandatory onboarding: no profile record yet -> divert to the flow.
      // There is no /onboard command; every interaction is intercepted.
      if (onboarding.needsOnboarding(user.id)) {
        return await onboarding.startOnboarding(interaction);
      }
      return await cmd.execute(interaction);
    }

    if (type === 3) {
      const [head] = splitCustomId(interaction.data?.custom_id);
      if (onboarding.customIds.includes(head)) return await onboarding.handleInteraction(interaction);
      if (onboarding.needsOnboarding(user.id)) return await onboarding.startOnboarding(interaction);
      if (head === 'chat_end') return await chat.handleChatEnd(interaction);
      if (head === 'chat_report') return await chat.handleChatReport(interaction);
      if (head === 'rate_like') return await chat.handleRate(interaction, 'like');
      if (head === 'rate_dislike') return await chat.handleRate(interaction, 'dislike');
      if (head === 'chat_find_new') return await chat.handleChatFindNew(interaction);
      if (head === 'queue_cancel') return await chat.handleQueueCancel(interaction);
      const cmd = COMMANDS.find((c) => (c.customIds || []).includes(head));
      if (cmd?.handleInteraction) return await cmd.handleInteraction(interaction);
      logger.debug(`unknown component ${head}`);
      return await safe(replyV2(interaction,
        simpleCard('That button has expired. Run the command again to get a fresh one.')),
        'expired button notice');
    }

    if (type === 5) {
      const [head] = splitCustomId(interaction.data?.custom_id);
      if (onboarding.customIds.includes(head)) return await onboarding.handleInteraction(interaction);
      if (onboarding.needsOnboarding(user.id)) return await onboarding.startOnboarding(interaction);
      const cmd = COMMANDS.find((c) => (c.customIds || []).includes(head));
      if (cmd?.handleInteraction) return await cmd.handleInteraction(interaction);
      logger.debug(`unknown modal ${head}`);
      return await safe(replyV2(interaction,
        simpleCard('That form has expired. Run the command again to get a fresh one.')),
        'expired modal notice');
    }

    logger.debug(`ignored interaction type ${type}`);
  } catch (err) {
    logger.error('handleInteraction failed:', err);
    const errPayload = {
      embeds: [EmbedFactory.createErrorEmbed('Something Went Wrong', 'Something hiccuped on our end. Try again?')],
    };
    // Attempt the webhook edit-original AS WELL AS the initial callback.
    // After a handler's initial ack (defer), Discord answers a second
    // callback with 40060, which safe() swallows — leaving the user staring
    // at "thinking…" forever. The edit-original covers exactly that case:
    // it replaces the deferred "thinking…" with the error card. When nothing
    // was acked yet, the callback succeeds and the edit-original just
    // rewrites the same card in place. Exactly one of the two paths is
    // user-visible; the other fails silently inside safe().
    //
    // Hunt 5: when the original interaction response was DELETED, the
    // callback 40060s AND the edit-original 404s — both swallowed — leaving
    // ZERO visible outcomes. As a last resort, post a followup: it creates a
    // brand-new message, so the user still sees exactly one outcome. The
    // .then(() => true) wrappers turn safe()'s value-or-null into a reliable
    // boolean (editOriginalClassic resolves undefined on success, which is
    // falsy — without the wrapper a successful edit would spuriously trigger
    // the followup and the user would see the card twice).
    const replied = await safe(replyClassic(interaction, errPayload).then(() => true), 'error reply');
    const edited = await safe(editOriginalClassic(interaction, errPayload).then(() => true), 'error edit-original');
    if (!replied && !edited) {
      await safe(followupClassic(interaction, errPayload), 'error followup fallback');
    }
  }
}
