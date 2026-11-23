// Shared UI pieces: notices (V2 and classic), navigation rows and helpers.

import { button, classic, container, linkButton, row, separator, text, v2 } from '../discord/components/builders.ts';
import { MessageFlags } from '../discord/constants.ts';
import type { ActionRow, MessagePayload } from '../discord/types.ts';
import { cid } from '../interactions/custom-id.ts';
import { ToneColor, ToneEmoji, type Tone } from './theme.ts';

/** A small Components V2 notice card (used when updating V2 cards in place). */
export function notice(body: string, tone: Tone = 'info', rows: ActionRow[] = []): MessagePayload {
  return v2([container([text(`${ToneEmoji[tone]} ${body}`), ...(rows.length ? [separator({ divider: false }), ...rows] : [])], { accent: ToneColor[tone] })]);
}

/** A compact classic-embed notice (used for quick replies and follow-ups). */
export function embedNotice(body: string, tone: Tone = 'info', title?: string): MessagePayload {
  return classic({ embeds: [{ ...(title ? { title } : {}), description: `${ToneEmoji[tone]} ${body}`, color: ToneColor[tone] }] });
}

export function errorPayload(): MessagePayload {
  return embedNotice('Something went wrong on our side. Please try again in a moment.', 'danger');
}

export function retryPayload(): MessagePayload {
  return embedNotice('That took a little longer than expected. Please press the button again.', 'warning');
}

export function staleButtonPayload(): MessagePayload {
  return embedNotice('This button is from an older message. Use `/start` to open a fresh menu.', 'info');
}

export function menuButton(label = 'Menu'): ReturnType<typeof button> {
  return button(cid('menu', 'home'), label, { emoji: '🏠' });
}

export function navRow(...extra: ReturnType<typeof button>[]): ActionRow {
  return row(...extra, menuButton());
}

/** Why DMs might not work, in plain words (bots can only DM people who share a server with them). */
export const DM_HELP = 'I can only message people who share a server with me and allow DMs from its members.';

/** A "join the community server" button, when one is configured. */
export function dmHelpRows(supportServerUrl: string | null): ActionRow[] {
  return supportServerUrl ? [row(linkButton(supportServerUrl, 'Join the community server', { emoji: '🏠' }))] : [];
}

export function isV2Message(flags: number | undefined): boolean {
  return ((flags ?? 0) & MessageFlags.IsComponentsV2) !== 0;
}

export function plural(n: number, singular: string, pluralWord = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralWord}`;
}
