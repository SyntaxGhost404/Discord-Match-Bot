// Reads the values a user submitted in a modal. Labels wrap the real inputs,
// and legacy action rows may still appear, so the tree is walked fully.

import { ComponentType } from '../discord/constants.ts';
import type { Attachment, ModalSubmitData, SubmittedComponent } from '../discord/types.ts';

export class ModalValues {
  private readonly byId = new Map<string, SubmittedComponent>();
  private readonly attachmentsById: Record<string, Attachment>;

  constructor(data: ModalSubmitData) {
    const walk = (node: SubmittedComponent | undefined) => {
      if (!node || typeof node !== 'object') return;
      if (node.custom_id && node.type !== ComponentType.Label && node.type !== ComponentType.ActionRow) {
        this.byId.set(node.custom_id, node);
      }
      if (node.component) walk(node.component);
      if (Array.isArray(node.components)) node.components.forEach(walk);
    };
    (Array.isArray(data.components) ? data.components : []).forEach(walk);
    this.attachmentsById = data.resolved?.attachments ?? {};
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Text input value ('' when missing). */
  text(id: string): string {
    const value = this.byId.get(id)?.value;
    return typeof value === 'string' ? value : '';
  }

  /** Selected values of a string select / checkbox group / file upload. */
  values(id: string): string[] {
    const values = this.byId.get(id)?.values;
    return Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string') : [];
  }

  /** Radio group selection (null when nothing selected). */
  radio(id: string): string | null {
    const value = this.byId.get(id)?.value;
    return typeof value === 'string' ? value : null;
  }

  /** Checkbox state. */
  checked(id: string): boolean {
    return this.byId.get(id)?.value === true;
  }

  /** Files uploaded through a File Upload component, resolved to attachments. */
  attachments(id: string): Attachment[] {
    return this.values(id)
      .map((attachmentId) => this.attachmentsById[attachmentId])
      .filter((a): a is Attachment => Boolean(a));
  }
}
