import { checkbox, choice, label, modal, radioGroup, text, textInput } from '../../discord/components/builders.ts';
import type { Modal } from '../../discord/types.ts';
import { cid } from '../../interactions/custom-id.ts';
import { REPORT_REASONS } from '../../domain/catalog.ts';
import type { ReportContext } from '../../db/repos/moderation.ts';

export function reportModal(context: ReportContext, ref: string | number): Modal {
  return modal(cid('rep', context, ref), 'Report', [
    text(
      context === 'chat'
        ? '🛡️ The recent messages of this chat will be shared with moderators so they can see what happened. Your partner is never told who reported them.'
        : '🛡️ Reports are anonymous — the person is never told who reported them.',
    ),
    label('What happened?', radioGroup('reason', REPORT_REASONS.map((r) => choice(r.key, `${r.emoji} ${r.label}`)), { required: true })),
    label('Details for moderators (optional)', textInput('details', { style: 'paragraph', max: 1000, required: false, placeholder: 'What did they say or do?' })),
    label('Also block this person', checkbox('block', true), "You won't see or be paired with them again"),
  ]);
}
