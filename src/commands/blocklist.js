// /blocklist — View and manage your blocked strangers.
//
// A paginated Components V2 card (8 per page, newest first, mirroring the
// /help directory's paging architecture): Previous/Next buttons carry the
// page in their custom id (`blocklist:page:N`, disabled at the bounds),
// and a string select unblocks someone on the current page in place.
// Each entry shows the stranger's stable 8-char code plus a dynamic
// <t:…:F> timestamp that renders in the viewer's own timezone; no real
// identity is ever exposed.
//
// The main list message is persistent (never ephemeral): ephemeral messages
// vanish on client reload, which would strand the user's list. Unblock
// confirmations go out as a separate ephemeral V2 follow-up so the main
// card always shows a clean list.

import { db } from '../services/database.js';
import { blocklistCard, simpleCard, unblockResultCard } from '../utils/embeds.js';
import {
  deferUpdate, editOriginalV2, followupV2, interactionUser, replyV2, safe,
} from '../discord/interactions.js';
import { logger } from '../util.js';

export const data = {
  name: 'blocklist',
  description: 'View and manage your blocked strangers',
  integration_types: [0, 1],
  contexts: [0, 1],
};

/** Router splits custom ids on the first ':' and matches the head. */
export const customIds = ['blocklist', 'unblock_select'];

const parsePage = (raw) => {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
};

export async function execute(interaction) {
  const user = interactionUser(interaction);
  const entries = db.getBlockEntries(user.id);
  // Persistent list: it must survive client reloads.
  await replyV2(interaction, blocklistCard(entries, { page: 1 }), { ephemeral: false });
}

/**
 * Page buttons (`blocklist:page:N`) re-render the card in place.
 * The unblock string select (`unblock_select:N`) refreshes the main card
 * cleanly and sends the confirmation as a separate ephemeral V2 follow-up.
 */
export async function handleInteraction(interaction) {
  const user = interactionUser(interaction);
  const customId = interaction.data?.custom_id || '';
  const [head, ...rest] = customId.split(':');
  await deferUpdate(interaction);

  const page = parsePage(rest[rest.length - 1]);

  if (head === 'unblock_select') {
    const values = interaction.data?.values || [];
    if (values[0]) {
      const code = String(values[0]).slice(0, 8);
      const ok = db.removeBlock(user.id, values[0]);
      // 'ambiguous' is truthy but deleted nothing: the short code matched
      // 2+ strangers, so ask for more characters instead of stamping a
      // success confirmation onto the follow-up.
      if (ok === 'ambiguous') {
        await safe(followupV2(interaction, simpleCard(
          `⚠️ That code matches more than one blocked stranger. Type a few more characters of the \`${code}\` code so the right person gets unblocked.`,
        )), 'unblock ambiguous');
        return;
      }
      logger.info(`unblock via select: ${user.id} -> ${code} (${ok ? 'ok' : 'not found'})`);

      // 1. Main message: clean refresh of the list, nothing stamped into it.
      const entries = db.getBlockEntries(user.id);
      await safe(
        editOriginalV2(interaction, blocklistCard(entries, { page }), [], { ephemeral: false }),
        'blocklist refresh',
      );
      // 2. Separate ephemeral V2 confirmation with the explanation.
      await safe(followupV2(interaction, unblockResultCard(ok, code)), 'unblock confirmation');
      return;
    }
  }

  const entries = db.getBlockEntries(user.id);
  await safe(
    editOriginalV2(interaction, blocklistCard(entries, { page }), [], { ephemeral: false }),
    'blocklist refresh',
  );
}
