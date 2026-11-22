// Interaction plumbing shared by all commands.
//
// Golden rule: answer every interaction within 3 seconds. Heavy work always
// happens AFTER a defer acknowledgement; Components-V2 messages go through
// the webhook endpoints (edit-original / followup), never the initial callback.

import { CallbackType, Flag, Interactions, V2, V2_EPHEMERAL } from './rest.js';
import { logger } from '../util.js';

/** The Discord user behind an interaction (guild -> member.user, DM -> user). */
export function interactionUser(interaction) {
  const u = interaction.member?.user ?? interaction.user ?? {};
  return {
    id: String(u.id || ''),
    username: u.username || 'unknown',
    globalName: u.global_name || null,
  };
}

/** Read a slash-command string option. */
export function optString(interaction, name) {
  const o = (interaction.data?.options || []).find((x) => x.name === name);
  return o && typeof o.value === 'string' ? o.value.trim() : '';
}

/**
 * Parse a modal-submit interaction.
 * Returns { fields, attachments, sizeLimit }: fields maps custom_id ->
 * value (text inputs) or values[] (selects / file uploads); attachments is
 * the resolved attachment map (for File Upload components); sizeLimit is
 * the per-attachment byte cap Discord reported for this interaction.
 * Walks nested ActionRows and Label wrappers.
 */
export function parseModalSubmit(interaction) {
  const fields = {};
  const walk = (c) => {
    if (!c || typeof c !== 'object') return;
    if (c.type === 18 && c.component) { walk(c.component); return; } // Label wrapper
    if (c.type === 4 && c.custom_id) fields[c.custom_id] = c.value ?? '';
    else if ((c.type === 3 || c.type === 19) && c.custom_id) fields[c.custom_id] = c.values ?? [];
    if (Array.isArray(c.components)) c.components.forEach(walk);
    if (c.component) walk(c.component);
  };
  // components can arrive as a truthy non-array on malformed payloads; only
  // walk it when it really is an array.
  const components = interaction.data?.components;
  (Array.isArray(components) ? components : []).forEach(walk);
  return {
    fields,
    attachments: interaction.data?.resolved?.attachments || {},
    sizeLimit: interaction.attachment_size_limit || 20 * 1024 * 1024,
  };
}

/**
 * Immediate Components-V2 reply in the callback (ephemeral by default).
 * Used for the primary interactive cards: searching, share confirm, etc.
 */
export async function replyV2(interaction, components, { ephemeral = true } = {}) {
  await Interactions.callback(interaction, {
    type: CallbackType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: ephemeral ? V2_EPHEMERAL : V2, components },
  });
}

/**
 * Immediate classic-embed reply (non-V2) in the callback.
 * Used for the reference-style surfaces: /stats, /blocklist, success cards.
 */
export async function replyClassic(interaction, { embeds = [], components = [], ephemeral = true } = {}) {
  await Interactions.callback(interaction, {
    type: CallbackType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds,
      ...(components.length ? { components } : {}),
      ...(ephemeral ? { flags: Flag.EPHEMERAL } : {}),
    },
  });
}

/** Classic-embed followup (non-V2), ephemeral by default. */
export async function followupClassic(interaction, { embeds = [], components = [], ephemeral = true } = {}) {
  const body = { embeds };
  if (components.length) body.components = components;
  if (ephemeral) body.flags = Flag.EPHEMERAL;
  return Interactions.followup(interaction, body);
}

/** Send a followup Components-V2 message (ephemeral by default). */
export async function followupV2(interaction, components, { files = [], ephemeral = true } = {}) {
  const body = { flags: ephemeral ? V2_EPHEMERAL : V2, components };
  if (files.length) body.attachments = files.map((f, i) => ({ id: String(i), filename: f.filename }));
  return Interactions.followup(interaction, body, files.length ? { files } : {});
}

/** Replace the original response with a classic-embed message (non-V2). */
export async function editOriginalClassic(interaction, { embeds = [], components = [] } = {}) {
  const body = { embeds };
  if (components.length) body.components = components;
  await Interactions.editOriginal(interaction, body);
}

/** Replace the original response with a Components-V2 message. */
export async function editOriginalV2(interaction, components, files = [], { ephemeral = true } = {}) {
  const body = {
    flags: ephemeral ? V2_EPHEMERAL : V2,
    components,
    attachments: files.map((f, i) => ({ id: String(i), filename: f.filename })),
  };
  await Interactions.editOriginal(interaction, body, files.length ? { files } : {});
}

/** Open a modal (valid for command & component interactions). */
export async function openModal(interaction, modal) {
  await Interactions.callback(interaction, modal); // modal is { type: 9, data: {...} }
}

/** Defer as ephemeral "thinking…" (only the EPHEMERAL flag is allowed here). */
export async function deferEphemeral(interaction) {
  await Interactions.callback(interaction, {
    type: CallbackType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: Flag.EPHEMERAL },
  });
}

/** Defer as a public "thinking…" (no flags): the follow-up stays visible. */
export async function deferPublic(interaction) {
  await Interactions.callback(interaction, {
    type: CallbackType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: {},
  });
}

/** Delete the original interaction response (cleans up an ephemeral defer). */
export async function deleteDeferredResponse(interaction) {
  await Interactions.deleteOriginal(interaction);
}

/** Defer a component interaction (edits the message in place, no loading state). */
export async function deferUpdate(interaction) {
  await Interactions.callback(interaction, { type: CallbackType.DEFERRED_UPDATE_MESSAGE });
}

/** Safe wrapper: log instead of throwing when an interaction token expired. */
export async function safe(promise, what) {
  try { return await promise; }
  catch (err) {
    logger.warn(`interaction op failed (${what}): ${err.message}`);
    return null;
  }
}

/** Fetch the original response message of an interaction (null on failure). */
export async function getOriginalMessage(interaction) {
  return safe(Interactions.getOriginal(interaction), 'get original message');
}
