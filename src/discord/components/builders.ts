// Tiny builders for message components (Components V2 + classic rows) and
// modal components. They only assemble plain objects in Discord's wire format;
// falsy children are skipped so layouts can be composed conditionally.

import { ButtonStyle, ComponentType, MessageFlags, SeparatorSpacing, TextInputStyle } from '../constants.ts';
import type {
  ActionRow,
  Button,
  Checkbox,
  CheckboxGroup,
  ChoiceOption,
  Container,
  ContainerChild,
  Embed,
  FileUploadComponent,
  InteractiveButton,
  Label,
  LabelChild,
  LinkButton,
  MediaGallery,
  MessageComponent,
  MessagePayload,
  Modal,
  ModalComponent,
  PartialEmoji,
  RadioGroup,
  Section,
  SelectMenu,
  SelectOption,
  Separator,
  StringSelect,
  TextDisplay,
  TextInput,
  Thumbnail,
} from '../types.ts';

type Maybe<T> = T | false | null | undefined;
export type EmojiInput = string | PartialEmoji;

const compact = <T>(items: Maybe<T>[]): T[] => items.filter((item): item is T => Boolean(item));
const toEmoji = (emoji?: EmojiInput): PartialEmoji | undefined =>
  emoji === undefined ? undefined : typeof emoji === 'string' ? { name: emoji } : emoji;

// -- message components --------------------------------------------------------

export function container(children: Maybe<ContainerChild>[], options: { accent?: number | null; spoiler?: boolean } = {}): Container {
  const out: Container = { type: ComponentType.Container, components: compact(children) };
  if (options.accent !== undefined) out.accent_color = options.accent;
  if (options.spoiler) out.spoiler = true;
  return out;
}

export function text(content: string): TextDisplay {
  return { type: ComponentType.TextDisplay, content };
}

export function section(content: string | string[], accessory: Button | Thumbnail): Section {
  const texts = (Array.isArray(content) ? content : [content]).filter(Boolean).map(text);
  return { type: ComponentType.Section, components: texts, accessory };
}

export function thumbnail(url: string, options: { description?: string; spoiler?: boolean } = {}): Thumbnail {
  const out: Thumbnail = { type: ComponentType.Thumbnail, media: { url } };
  if (options.description) out.description = options.description;
  if (options.spoiler) out.spoiler = true;
  return out;
}

export function gallery(items: Array<{ url: string; description?: string; spoiler?: boolean }>): MediaGallery {
  return {
    type: ComponentType.MediaGallery,
    items: items.map((item) => ({
      media: { url: item.url },
      ...(item.description ? { description: item.description } : {}),
      ...(item.spoiler ? { spoiler: true } : {}),
    })),
  };
}

export function separator(options: { divider?: boolean; spacing?: 'small' | 'large' } = {}): Separator {
  return {
    type: ComponentType.Separator,
    divider: options.divider ?? true,
    spacing: options.spacing === 'large' ? SeparatorSpacing.Large : SeparatorSpacing.Small,
  };
}

export function row(...components: Maybe<Button | SelectMenu>[]): ActionRow {
  return { type: ComponentType.ActionRow, components: compact(components) };
}

export type ButtonTone = 'primary' | 'secondary' | 'success' | 'danger';
const TONE: Record<ButtonTone, 1 | 2 | 3 | 4> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

export function button(
  customId: string,
  label: string | undefined,
  options: { style?: ButtonTone; emoji?: EmojiInput; disabled?: boolean } = {},
): InteractiveButton {
  const out: InteractiveButton = { type: ComponentType.Button, style: TONE[options.style ?? 'secondary'], custom_id: customId };
  if (label) out.label = label;
  const emoji = toEmoji(options.emoji);
  if (emoji) out.emoji = emoji;
  if (options.disabled) out.disabled = true;
  return out;
}

export function linkButton(url: string, label: string, options: { emoji?: EmojiInput; disabled?: boolean } = {}): LinkButton {
  const out: LinkButton = { type: ComponentType.Button, style: ButtonStyle.Link, url, label };
  const emoji = toEmoji(options.emoji);
  if (emoji) out.emoji = emoji;
  if (options.disabled) out.disabled = true;
  return out;
}

export function stringSelect(
  customId: string,
  options: SelectOption[],
  config: { placeholder?: string; min?: number; max?: number; disabled?: boolean; required?: boolean } = {},
): StringSelect {
  const out: StringSelect = { type: ComponentType.StringSelect, custom_id: customId, options };
  if (config.placeholder) out.placeholder = config.placeholder;
  if (config.min !== undefined) out.min_values = config.min;
  if (config.max !== undefined) out.max_values = config.max;
  if (config.disabled) out.disabled = true;
  if (config.required !== undefined) out.required = config.required;
  return out;
}

export function option(value: string, labelText: string, extra: { description?: string; emoji?: EmojiInput; selected?: boolean } = {}): SelectOption {
  const out: SelectOption = { value, label: labelText };
  if (extra.description) out.description = extra.description;
  const emoji = toEmoji(extra.emoji);
  if (emoji) out.emoji = emoji;
  if (extra.selected) out.default = true;
  return out;
}

// -- modal components ------------------------------------------------------------

export function modal(customId: string, title: string, components: Maybe<ModalComponent>[]): Modal {
  return { custom_id: customId, title, components: compact(components) };
}

export function label(labelText: string, component: LabelChild, description?: string): Label {
  const out: Label = { type: ComponentType.Label, label: labelText, component };
  if (description) out.description = description;
  return out;
}

export function textInput(
  customId: string,
  options: { style?: 'short' | 'paragraph'; min?: number; max?: number; required?: boolean; value?: string | null; placeholder?: string } = {},
): TextInput {
  const out: TextInput = {
    type: ComponentType.TextInput,
    custom_id: customId,
    style: options.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short,
  };
  if (options.min !== undefined) out.min_length = options.min;
  if (options.max !== undefined) out.max_length = options.max;
  if (options.required !== undefined) out.required = options.required;
  if (options.value) out.value = options.max ? options.value.slice(0, options.max) : options.value;
  if (options.placeholder) out.placeholder = options.placeholder;
  return out;
}

export function choice(value: string, labelText: string, extra: { description?: string; selected?: boolean } = {}): ChoiceOption {
  const out: ChoiceOption = { value, label: labelText };
  if (extra.description) out.description = extra.description;
  if (extra.selected) out.default = true;
  return out;
}

export function radioGroup(customId: string, options: ChoiceOption[], config: { required?: boolean } = {}): RadioGroup {
  const out: RadioGroup = { type: ComponentType.RadioGroup, custom_id: customId, options };
  if (config.required !== undefined) out.required = config.required;
  return out;
}

export function checkboxGroup(
  customId: string,
  options: ChoiceOption[],
  config: { min?: number; max?: number; required?: boolean } = {},
): CheckboxGroup {
  const out: CheckboxGroup = { type: ComponentType.CheckboxGroup, custom_id: customId, options };
  if (config.min !== undefined) out.min_values = config.min;
  if (config.max !== undefined) out.max_values = config.max;
  if (config.required !== undefined) out.required = config.required;
  return out;
}

export function checkbox(customId: string, checked = false): Checkbox {
  const out: Checkbox = { type: ComponentType.Checkbox, custom_id: customId };
  if (checked) out.default = true;
  return out;
}

export function fileUpload(
  customId: string,
  config: { min?: number; max?: number; required?: boolean; fileTypes?: string[] } = {},
): FileUploadComponent {
  const out: FileUploadComponent = { type: ComponentType.FileUpload, custom_id: customId };
  if (config.min !== undefined) out.min_values = config.min;
  if (config.max !== undefined) out.max_values = config.max;
  if (config.required !== undefined) out.required = config.required;
  if (config.fileTypes?.length) out.file_types = config.fileTypes;
  return out;
}

// -- payloads ----------------------------------------------------------------------

/** A Components V2 message. Mentions never ping unless explicitly allowed. */
export function v2(components: Maybe<MessageComponent>[], extra: Omit<MessagePayload, 'components'> = {}): MessagePayload {
  return {
    ...extra,
    flags: (extra.flags ?? 0) | MessageFlags.IsComponentsV2,
    components: compact(components),
    allowed_mentions: extra.allowed_mentions ?? { parse: [] },
  };
}

/** A classic message (content / embeds / up to 5 action rows). */
export function classic(parts: { content?: string; embeds?: Embed[]; components?: ActionRow[]; flags?: number }): MessagePayload {
  const out: MessagePayload = { allowed_mentions: { parse: [] } };
  if (parts.content !== undefined) out.content = parts.content;
  if (parts.embeds) out.embeds = parts.embeds;
  if (parts.components) out.components = parts.components;
  if (parts.flags) out.flags = parts.flags;
  return out;
}

export function isV2(payload: MessagePayload): boolean {
  return ((payload.flags ?? 0) & MessageFlags.IsComponentsV2) !== 0;
}
