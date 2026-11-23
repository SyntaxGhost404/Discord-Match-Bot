// Validates message and modal payloads against the limits documented in the
// Component Reference, Message Resource and Interactions docs. Used by the test
// suite on every payload the bot produces, and optionally at runtime
// (VALIDATE_PAYLOADS=1) to catch mistakes before Discord rejects them.

import { ComponentType, Limits, MessageFlags } from '../constants.ts';
import type { Embed, MessagePayload, Modal } from '../types.ts';

export interface ValidationIssue {
  path: string;
  message: string;
}

type Node = Record<string, unknown> & { type?: number };

const MESSAGE_TOP_LEVEL = new Set<number>([
  ComponentType.ActionRow,
  ComponentType.Section,
  ComponentType.TextDisplay,
  ComponentType.MediaGallery,
  ComponentType.File,
  ComponentType.Separator,
  ComponentType.Container,
]);
const CONTAINER_CHILDREN = new Set<number>([
  ComponentType.ActionRow,
  ComponentType.TextDisplay,
  ComponentType.Section,
  ComponentType.MediaGallery,
  ComponentType.Separator,
  ComponentType.File,
]);
const SELECT_TYPES = new Set<number>([
  ComponentType.StringSelect,
  ComponentType.UserSelect,
  ComponentType.RoleSelect,
  ComponentType.MentionableSelect,
  ComponentType.ChannelSelect,
]);
const LABEL_CHILDREN = new Set<number>([
  ComponentType.TextInput,
  ComponentType.StringSelect,
  ComponentType.UserSelect,
  ComponentType.RoleSelect,
  ComponentType.MentionableSelect,
  ComponentType.ChannelSelect,
  ComponentType.FileUpload,
  ComponentType.RadioGroup,
  ComponentType.CheckboxGroup,
  ComponentType.Checkbox,
]);

class Checker {
  readonly issues: ValidationIssue[] = [];
  readonly customIds = new Set<string>();
  readonly ids = new Set<number>();
  componentCount = 0;
  textLength = 0;

  fail(path: string, message: string): void {
    this.issues.push({ path, message });
  }

  len(path: string, value: unknown, max: number, min = 0, name = 'value'): void {
    if (typeof value !== 'string') {
      this.fail(path, `${name} must be a string`);
      return;
    }
    if (value.length < min) this.fail(path, `${name} shorter than ${min}`);
    if (value.length > max) this.fail(path, `${name} longer than ${max} (${value.length})`);
  }

  optLen(path: string, value: unknown, max: number, name: string): void {
    if (value === undefined || value === null) return;
    this.len(path, value, max, 0, name);
  }

  customId(path: string, value: unknown): void {
    this.len(path, value, Limits.customId, 1, 'custom_id');
    if (typeof value === 'string') {
      if (this.customIds.has(value)) this.fail(path, `duplicate custom_id "${value}"`);
      this.customIds.add(value);
    }
  }

  component(path: string, node: Node): void {
    this.componentCount++;
    if (node.id !== undefined) {
      if (typeof node.id !== 'number' || !Number.isInteger(node.id)) this.fail(path, 'id must be an integer');
      else if (node.id !== 0) {
        if (this.ids.has(node.id)) this.fail(path, `duplicate component id ${node.id}`);
        this.ids.add(node.id);
      }
    }
  }
}

// -- messages -------------------------------------------------------------------

export function validateMessagePayload(payload: MessagePayload): ValidationIssue[] {
  const c = new Checker();
  const isV2 = ((payload.flags ?? 0) & MessageFlags.IsComponentsV2) !== 0;
  const components = (payload.components ?? []) as unknown as Node[];

  if (isV2) {
    if (payload.content) c.fail('content', 'content is not allowed with IS_COMPONENTS_V2');
    if (payload.embeds?.length) c.fail('embeds', 'embeds are not allowed with IS_COMPONENTS_V2');
    components.forEach((node, i) => {
      const path = `components[${i}]`;
      if (!MESSAGE_TOP_LEVEL.has(node.type ?? -1)) c.fail(path, `type ${node.type} not allowed at the top level`);
      messageComponent(c, path, node);
    });
    if (c.componentCount > Limits.v2TotalComponents) {
      c.fail('components', `too many components (${c.componentCount} > ${Limits.v2TotalComponents})`);
    }
    if (c.textLength > Limits.v2TotalText) c.fail('components', `text displays exceed ${Limits.v2TotalText} characters (${c.textLength})`);
  } else {
    if (payload.content && payload.content.length > Limits.messageContent) {
      c.fail('content', `content longer than ${Limits.messageContent}`);
    }
    if (components.length > Limits.legacyActionRows) c.fail('components', 'more than 5 action rows');
    components.forEach((node, i) => {
      const path = `components[${i}]`;
      if (node.type !== ComponentType.ActionRow) c.fail(path, 'legacy messages only allow action rows at the top level');
      messageComponent(c, path, node);
    });
    validateEmbeds(c, payload.embeds ?? []);
  }
  return c.issues;
}

function messageComponent(c: Checker, path: string, node: Node): void {
  c.component(path, node);
  switch (node.type) {
    case ComponentType.ActionRow: {
      const kids = (node.components ?? []) as Node[];
      if (!Array.isArray(kids) || kids.length === 0) {
        c.fail(path, 'action row needs at least one component');
        return;
      }
      const selects = kids.filter((k) => SELECT_TYPES.has(k.type ?? -1));
      const buttons = kids.filter((k) => k.type === ComponentType.Button);
      if (selects.length && kids.length !== 1) c.fail(path, 'a select menu must be alone in its action row');
      if (buttons.length > 5) c.fail(path, 'more than 5 buttons in an action row');
      if (selects.length + buttons.length !== kids.length) c.fail(path, 'action rows in messages hold only buttons or one select');
      kids.forEach((k, i) => messageComponent(c, `${path}.components[${i}]`, k));
      return;
    }
    case ComponentType.Button:
      return validateButton(c, path, node);
    case ComponentType.StringSelect:
      return validateStringSelect(c, path, node, false);
    case ComponentType.UserSelect:
    case ComponentType.RoleSelect:
    case ComponentType.MentionableSelect:
    case ComponentType.ChannelSelect:
      c.customId(`${path}.custom_id`, node.custom_id);
      c.optLen(`${path}.placeholder`, node.placeholder, Limits.selectPlaceholder, 'placeholder');
      return;
    case ComponentType.TextDisplay:
      c.len(`${path}.content`, node.content, Limits.v2TotalText, 1, 'content');
      if (typeof node.content === 'string') c.textLength += node.content.length;
      return;
    case ComponentType.Section: {
      const kids = (node.components ?? []) as Node[];
      if (kids.length < 1 || kids.length > Limits.sectionTexts) c.fail(path, 'a section needs 1-3 text displays');
      kids.forEach((k, i) => {
        if (k.type !== ComponentType.TextDisplay) c.fail(`${path}.components[${i}]`, 'section children must be text displays');
        messageComponent(c, `${path}.components[${i}]`, k);
      });
      const accessory = node.accessory as Node | undefined;
      if (!accessory) c.fail(path, 'section needs an accessory');
      else if (accessory.type !== ComponentType.Button && accessory.type !== ComponentType.Thumbnail) {
        c.fail(`${path}.accessory`, 'accessory must be a button or thumbnail');
      } else messageComponent(c, `${path}.accessory`, accessory);
      return;
    }
    case ComponentType.Thumbnail:
      validateMedia(c, `${path}.media`, node.media);
      c.optLen(`${path}.description`, node.description, Limits.mediaAltText, 'description');
      return;
    case ComponentType.MediaGallery: {
      const items = (node.items ?? []) as Node[];
      if (items.length < 1 || items.length > Limits.mediaGalleryItems) c.fail(path, 'media gallery needs 1-10 items');
      items.forEach((item, i) => {
        validateMedia(c, `${path}.items[${i}].media`, item.media);
        c.optLen(`${path}.items[${i}].description`, item.description, Limits.mediaAltText, 'description');
      });
      return;
    }
    case ComponentType.File: {
      const file = node.file as { url?: string } | undefined;
      if (!file?.url?.startsWith('attachment://')) c.fail(`${path}.file`, 'file components only accept attachment:// urls');
      return;
    }
    case ComponentType.Separator:
      if (node.spacing !== undefined && node.spacing !== 1 && node.spacing !== 2) c.fail(path, 'spacing must be 1 or 2');
      return;
    case ComponentType.Container: {
      const kids = (node.components ?? []) as Node[];
      if (!Array.isArray(kids) || kids.length === 0) c.fail(path, 'container needs at least one child');
      if (node.accent_color !== undefined && node.accent_color !== null) {
        const color = node.accent_color as number;
        if (!Number.isInteger(color) || color < 0 || color > 0xffffff) c.fail(path, 'accent_color must be 0x000000-0xFFFFFF');
      }
      kids.forEach((k, i) => {
        if (!CONTAINER_CHILDREN.has(k.type ?? -1)) c.fail(`${path}.components[${i}]`, `type ${k.type} not allowed in a container`);
        messageComponent(c, `${path}.components[${i}]`, k);
      });
      return;
    }
    default:
      c.fail(path, `component type ${node.type} is not valid in messages`);
  }
}

function validateMedia(c: Checker, path: string, media: unknown): void {
  const url = (media as { url?: unknown } | undefined)?.url;
  if (typeof url !== 'string' || !url) c.fail(path, 'media.url is required');
  else if (!/^(https?:\/\/|attachment:\/\/)/.test(url)) c.fail(path, 'media.url must be http(s) or attachment://');
}

function validateButton(c: Checker, path: string, node: Node): void {
  if (node.style === 5) {
    c.len(`${path}.url`, node.url, Limits.linkUrl, 1, 'url');
    if (node.custom_id !== undefined) c.fail(path, 'link buttons cannot have a custom_id');
  } else if (node.style === 6) {
    if (!node.sku_id) c.fail(path, 'premium buttons need sku_id');
  } else if (typeof node.style === 'number' && node.style >= 1 && node.style <= 4) {
    c.customId(`${path}.custom_id`, node.custom_id);
    if (node.url !== undefined) c.fail(path, 'non-link buttons cannot have a url');
  } else {
    c.fail(path, `invalid button style ${String(node.style)}`);
  }
  if (node.style !== 6 && !node.label && !node.emoji) c.fail(path, 'button needs a label or an emoji');
  c.optLen(`${path}.label`, node.label, Limits.buttonLabel, 'label');
}

function validateStringSelect(c: Checker, path: string, node: Node, inModal: boolean): void {
  c.customId(`${path}.custom_id`, node.custom_id);
  c.optLen(`${path}.placeholder`, node.placeholder, Limits.selectPlaceholder, 'placeholder');
  const options = (node.options ?? []) as Node[];
  if (options.length < 1 || options.length > Limits.selectOptions) c.fail(path, 'select needs 1-25 options');
  const values = new Set<string>();
  options.forEach((o, i) => {
    c.len(`${path}.options[${i}].label`, o.label, Limits.selectOptionText, 1, 'label');
    c.len(`${path}.options[${i}].value`, o.value, Limits.selectOptionText, 1, 'value');
    c.optLen(`${path}.options[${i}].description`, o.description, Limits.selectOptionText, 'description');
    if (typeof o.value === 'string') {
      if (values.has(o.value)) c.fail(`${path}.options[${i}]`, `duplicate option value "${o.value}"`);
      values.add(o.value);
    }
  });
  const min = (node.min_values as number | undefined) ?? 1;
  const max = (node.max_values as number | undefined) ?? 1;
  if (min < 0 || min > 25 || max < 1 || max > 25 || min > max) c.fail(path, `invalid min/max values (${min}/${max})`);
  if (max > options.length) c.fail(path, 'max_values exceeds the number of options');
  const defaults = options.filter((o) => o.default === true).length;
  if (defaults > max) c.fail(path, 'more default options than max_values');
  if (inModal) {
    if (node.disabled !== undefined) c.fail(path, 'disabled is not allowed on selects inside modals');
    if (node.required !== false && node.min_values === 0) c.fail(path, 'min_values must be ≥ 1 when required');
  }
}

function validateEmbeds(c: Checker, embeds: Embed[]): void {
  if (embeds.length > Limits.embedsPerMessage) c.fail('embeds', 'more than 10 embeds');
  let total = 0;
  embeds.forEach((embed, i) => {
    const path = `embeds[${i}]`;
    const add = (value: string | undefined, max: number, name: string) => {
      if (value === undefined) return;
      total += value.trim().length;
      if (value.trim().length > max) c.fail(`${path}.${name}`, `${name} longer than ${max}`);
    };
    add(embed.title, Limits.embedTitle, 'title');
    add(embed.description, Limits.embedDescription, 'description');
    add(embed.footer?.text, Limits.embedFooter, 'footer.text');
    add(embed.author?.name, Limits.embedAuthor, 'author.name');
    const fields = embed.fields ?? [];
    if (fields.length > Limits.embedFields) c.fail(`${path}.fields`, 'more than 25 fields');
    fields.forEach((field, j) => {
      if (!field.name?.trim()) c.fail(`${path}.fields[${j}].name`, 'field name is required');
      if (!field.value?.trim()) c.fail(`${path}.fields[${j}].value`, 'field value is required');
      add(field.name, Limits.embedFieldName, `fields[${j}].name`);
      add(field.value, Limits.embedFieldValue, `fields[${j}].value`);
    });
    if (embed.color !== undefined && (embed.color < 0 || embed.color > 0xffffff)) c.fail(`${path}.color`, 'invalid color');
  });
  if (total > Limits.embedTotal) c.fail('embeds', `embeds exceed ${Limits.embedTotal} characters in total`);
}

// -- modals ---------------------------------------------------------------------

export function validateModal(modal: Modal): ValidationIssue[] {
  const c = new Checker();
  c.len('custom_id', modal.custom_id, Limits.customId, 1, 'custom_id');
  c.len('title', modal.title, Limits.modalTitle, 1, 'title');
  const components = (modal.components ?? []) as unknown as Node[];
  if (components.length < 1 || components.length > Limits.modalComponents) c.fail('components', 'modals need 1-5 components');

  components.forEach((node, i) => {
    const path = `components[${i}]`;
    c.component(path, node);
    if (node.type === ComponentType.TextDisplay) {
      c.len(`${path}.content`, node.content, Limits.v2TotalText, 1, 'content');
      return;
    }
    if (node.type === ComponentType.ActionRow) {
      const kids = (node.components ?? []) as Node[];
      if (kids.length !== 1 || kids[0]?.type !== ComponentType.TextInput) c.fail(path, 'modal action rows hold exactly one text input');
      else {
        c.len(`${path}.components[0].label`, kids[0].label, Limits.labelText, 1, 'label');
        validateTextInput(c, `${path}.components[0]`, kids[0], true);
      }
      return;
    }
    if (node.type !== ComponentType.Label) {
      c.fail(path, `type ${node.type} not allowed at the top level of a modal`);
      return;
    }
    c.len(`${path}.label`, node.label, Limits.labelText, 1, 'label');
    c.optLen(`${path}.description`, node.description, Limits.labelDescription, 'description');
    const child = node.component as Node | undefined;
    if (!child || !LABEL_CHILDREN.has(child.type ?? -1)) {
      c.fail(`${path}.component`, 'label needs one supported interactive component');
      return;
    }
    const childPath = `${path}.component`;
    c.component(childPath, child);
    switch (child.type) {
      case ComponentType.TextInput:
        if (child.label !== undefined) c.fail(childPath, 'text inputs inside a label must not set label');
        validateTextInput(c, childPath, child, false);
        break;
      case ComponentType.StringSelect:
        validateStringSelect(c, childPath, child, true);
        break;
      case ComponentType.RadioGroup:
        validateChoices(c, childPath, child, Limits.radioOptions);
        if (((child.options ?? []) as Node[]).filter((o) => o.default === true).length > 1) c.fail(childPath, 'radio group has several defaults');
        break;
      case ComponentType.CheckboxGroup: {
        const count = validateChoices(c, childPath, child, Limits.checkboxOptions);
        const min = (child.min_values as number | undefined) ?? 1;
        const max = (child.max_values as number | undefined) ?? count;
        if (min < 0 || min > 10 || max < 1 || max > 10 || min > max || max > count) c.fail(childPath, `invalid min/max values (${min}/${max})`);
        if (child.required !== false && child.min_values === 0) c.fail(childPath, 'min_values must be ≥ 1 when required');
        break;
      }
      case ComponentType.Checkbox:
        c.customId(`${childPath}.custom_id`, child.custom_id);
        if (child.default !== undefined && typeof child.default !== 'boolean') c.fail(childPath, 'default must be a boolean');
        break;
      case ComponentType.FileUpload: {
        c.customId(`${childPath}.custom_id`, child.custom_id);
        const min = (child.min_values as number | undefined) ?? 1;
        const max = (child.max_values as number | undefined) ?? 1;
        if (min < 0 || min > Limits.fileUploadMax || max < 1 || max > Limits.fileUploadMax || min > max) {
          c.fail(childPath, `invalid min/max values (${min}/${max})`);
        }
        if (child.required !== false && child.min_values === 0) c.fail(childPath, 'min_values must be ≥ 1 when required');
        const types = (child.file_types ?? []) as unknown[];
        if (types.length > 10) c.fail(childPath, 'at most 10 file_types');
        break;
      }
      default:
        c.customId(`${childPath}.custom_id`, child.custom_id);
    }
  });
  return c.issues;
}

function validateTextInput(c: Checker, path: string, node: Node, legacy: boolean): void {
  c.customId(`${path}.custom_id`, node.custom_id);
  if (node.style !== 1 && node.style !== 2) c.fail(path, 'style must be 1 or 2');
  const min = node.min_length as number | undefined;
  const max = node.max_length as number | undefined;
  if (min !== undefined && (min < 0 || min > Limits.textInputLength)) c.fail(path, 'min_length out of range');
  if (max !== undefined && (max < 1 || max > Limits.textInputLength)) c.fail(path, 'max_length out of range');
  if (min !== undefined && max !== undefined && min > max) c.fail(path, 'min_length greater than max_length');
  c.optLen(`${path}.placeholder`, node.placeholder, Limits.textInputPlaceholder, 'placeholder');
  if (node.value !== undefined) {
    c.len(`${path}.value`, node.value, max ?? Limits.textInputLength, 0, 'value');
  }
  if (!legacy && node.label !== undefined) c.fail(path, 'label belongs on the Label component');
}

function validateChoices(c: Checker, path: string, node: Node, bounds: { min: number; max: number }): number {
  c.customId(`${path}.custom_id`, node.custom_id);
  const options = (node.options ?? []) as Node[];
  if (options.length < bounds.min || options.length > bounds.max) c.fail(path, `needs ${bounds.min}-${bounds.max} options`);
  const values = new Set<string>();
  options.forEach((o, i) => {
    c.len(`${path}.options[${i}].label`, o.label, Limits.selectOptionText, 1, 'label');
    c.len(`${path}.options[${i}].value`, o.value, Limits.selectOptionText, 1, 'value');
    c.optLen(`${path}.options[${i}].description`, o.description, Limits.selectOptionText, 'description');
    if (typeof o.value === 'string') {
      if (values.has(o.value)) c.fail(`${path}.options[${i}]`, `duplicate value "${o.value}"`);
      values.add(o.value);
    }
  });
  return options.length;
}

export class PayloadValidationError extends Error {
  readonly issues: ValidationIssue[];
  constructor(kind: string, issues: ValidationIssue[]) {
    super(`Invalid ${kind} payload: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
    this.name = 'PayloadValidationError';
    this.issues = issues;
  }
}

export function assertValidMessage(payload: MessagePayload): void {
  const issues = validateMessagePayload(payload);
  if (issues.length) throw new PayloadValidationError('message', issues);
}

export function assertValidModal(modal: Modal): void {
  const issues = validateModal(modal);
  if (issues.length) throw new PayloadValidationError('modal', issues);
}
