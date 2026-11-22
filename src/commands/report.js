// /report — Report your current or last chat partner.
// Faithful port of the reference: active-session gate -> modal
// ('report_modal' with report_reason + report_description) -> submit files the
// report via safety.createReport and answers with the "Report Filed" embed.
// With no live chat, the target falls back to the most recent partner from
// the recent-partners ring (real user ids, newest first), so "last chat
// partner" reports actually work. The target id rides in the modal's
// custom_id, so a report typed while the chat is alive still files against
// the right person if the session ends before the modal is submitted.

import { db } from '../services/database.js';
import { safety } from '../services/safety.js';
import { EmbedFactory, reportModal } from '../utils/embeds.js';
import {
  interactionUser, openModal, parseModalSubmit, replyClassic,
} from '../discord/interactions.js';
import { logger, splitCustomId } from '../util.js';

export const data = {
  name: 'report',
  description: 'Report your current or last chat partner',
  integration_types: [0, 1],
  contexts: [0, 1],
};

export const customIds = ['report_modal'];

export async function execute(interaction) {
  const user = interactionUser(interaction);
  const session = db.getActiveSessionForUser(user.id);

  let targetId = null;
  if (session) {
    targetId = session.user1_id === user.id ? session.user2_id : session.user1_id;
  } else {
    // No live chat: the ring remembers real user ids, newest first.
    targetId = db.getRecentPartners(user.id)[0] || null;
  }

  if (!targetId) {
    return replyClassic(interaction, {
      embeds: [EmbedFactory.createInfoEmbed('No One to Report', 'You are not in a chat and have no recent chat partners to report.')],
    });
  }

  await openModal(interaction, reportModal(targetId));
}

export async function handleInteraction(interaction) {
  // 'report_modal' submit (possibly 'report_modal:<targetId>')
  const user = interactionUser(interaction);
  const { fields } = parseModalSubmit(interaction);
  const reason = String(fields.report_reason || '');
  const description = String(fields.report_description || '');

  // The modal marks these fields required, but that is client-enforced
  // only: a crafted submit can arrive with empty strings. Reject before
  // anything is filed via safety.createReport.
  if (!reason.trim() || !description.trim()) {
    return replyClassic(interaction, {
      embeds: [EmbedFactory.createErrorEmbed(
        'More Detail Needed',
        'Please say what happened: fill in both the reason and the description before submitting.',
      )],
    });
  }

  // Prefer the target encoded when the modal opened, so the report files
  // against the right person even if the chat ended mid-modal. Fall back to
  // the live partner for modals opened without an encoded target (the chat
  // Report button); that path still needs a live session.
  const [, encodedTarget] = splitCustomId(interaction.data?.custom_id);
  let targetId = encodedTarget || null;
  if (!targetId) {
    const session = db.getActiveSessionForUser(user.id);
    if (!session) {
      return replyClassic(interaction, {
        embeds: [EmbedFactory.createErrorEmbed('Session Ended', 'Session ended, report cannot be filed automatically.')],
      });
    }
    targetId = session.user1_id === user.id ? session.user2_id : session.user1_id;
  }

  try {
    const reportId = safety.createReport(
      user.id,
      targetId,
      reason.trim(),
      description.trim(),
      [], // chat history is not logged; kept as the reference's empty array
    );

    await replyClassic(interaction, {
      embeds: [EmbedFactory.createSuccessEmbed('Report Filed', `Thank you for your report. ID: ${reportId}`)],
    });
  } catch (error) {
    logger.error('Report error:', error);
    await replyClassic(interaction, {
      embeds: [EmbedFactory.createErrorEmbed('Report Failed', 'Failed to file the report. Please try again.')],
    });
  }
}
