// TypeScript shapes for the parts of the Discord API this bot uses, written
// from the official documentation. Field names match the wire format.

export type Snowflake = string;

// ---------------------------------------------------------------------------
// Users, members, channels
// ---------------------------------------------------------------------------

export interface User {
  id: Snowflake;
  username: string;
  discriminator?: string;
  global_name?: string | null;
  avatar?: string | null;
  bot?: boolean;
  system?: boolean;
  public_flags?: number;
}

export interface GuildMember {
  user?: User;
  nick?: string | null;
  roles: Snowflake[];
  joined_at?: string | null;
  permissions?: string;
}

export interface Channel {
  id: Snowflake;
  type: number;
  guild_id?: Snowflake;
  name?: string | null;
  recipients?: User[];
  flags?: number;
}

export interface PartialEmoji {
  id?: Snowflake | null;
  name?: string | null;
  animated?: boolean;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface Attachment {
  id: Snowflake;
  filename: string;
  title?: string;
  description?: string;
  content_type?: string;
  size: number;
  url: string;
  proxy_url?: string;
  height?: number | null;
  width?: number | null;
  ephemeral?: boolean;
  duration_secs?: number;
  waveform?: string;
  flags?: number;
}

export interface AttachmentRequest {
  id: Snowflake | number;
  filename?: string;
  title?: string;
  description?: string;
  duration_secs?: number;
  waveform?: string;
  is_spoiler?: boolean;
}

export interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface Embed {
  title?: string;
  description?: string;
  url?: string;
  timestamp?: string;
  color?: number;
  footer?: { text: string; icon_url?: string };
  image?: { url: string };
  thumbnail?: { url: string };
  author?: { name: string; url?: string; icon_url?: string };
  fields?: EmbedField[];
}

export interface AllowedMentions {
  parse?: Array<'roles' | 'users' | 'everyone'>;
  roles?: Snowflake[];
  users?: Snowflake[];
  replied_user?: boolean;
}

export interface MessageReference {
  type?: number;
  message_id?: Snowflake;
  channel_id?: Snowflake;
  guild_id?: Snowflake;
  fail_if_not_exists?: boolean;
}

export interface StickerItem {
  id: Snowflake;
  name: string;
  format_type: number;
}

export interface Message {
  id: Snowflake;
  channel_id: Snowflake;
  guild_id?: Snowflake;
  author: User;
  content: string;
  timestamp: string;
  edited_timestamp: string | null;
  attachments: Attachment[];
  embeds: Embed[];
  type: number;
  flags?: number;
  components?: MessageComponent[];
  message_reference?: MessageReference;
  referenced_message?: Message | null;
  sticker_items?: StickerItem[];
  poll?: unknown;
  webhook_id?: Snowflake;
  application_id?: Snowflake;
}

/** Body accepted by Create Message / Edit Message / webhook & interaction endpoints. */
export interface MessagePayload {
  content?: string | null;
  embeds?: Embed[];
  components?: MessageComponent[];
  flags?: number;
  allowed_mentions?: AllowedMentions;
  attachments?: AttachmentRequest[];
  message_reference?: MessageReference;
  nonce?: string;
  enforce_nonce?: boolean;
  tts?: boolean;
}

export interface FileUpload {
  /** File name as Discord should store it (also referenced as attachment://name). */
  name: string;
  data: Uint8Array;
  contentType?: string;
}

// ---------------------------------------------------------------------------
// Components (request shapes; response shapes add resolved fields)
// ---------------------------------------------------------------------------

export interface UnfurledMediaItem {
  url: string;
  proxy_url?: string;
  width?: number | null;
  height?: number | null;
  content_type?: string;
  attachment_id?: Snowflake;
}

export interface InteractiveButton {
  type: 2;
  id?: number;
  style: 1 | 2 | 3 | 4;
  custom_id: string;
  label?: string;
  emoji?: PartialEmoji;
  disabled?: boolean;
}

export interface LinkButton {
  type: 2;
  id?: number;
  style: 5;
  url: string;
  label?: string;
  emoji?: PartialEmoji;
  disabled?: boolean;
}

export type Button = InteractiveButton | LinkButton;

export interface SelectOption {
  label: string;
  value: string;
  description?: string;
  emoji?: PartialEmoji;
  default?: boolean;
}

export interface StringSelect {
  type: 3;
  id?: number;
  custom_id: string;
  options: SelectOption[];
  placeholder?: string;
  min_values?: number;
  max_values?: number;
  required?: boolean;
  disabled?: boolean;
}

export interface SelectDefaultValue {
  id: Snowflake;
  type: 'user' | 'role' | 'channel';
}

export interface AutoSelect {
  type: 5 | 6 | 7 | 8;
  id?: number;
  custom_id: string;
  placeholder?: string;
  default_values?: SelectDefaultValue[];
  min_values?: number;
  max_values?: number;
  required?: boolean;
  disabled?: boolean;
  channel_types?: number[];
}

export type SelectMenu = StringSelect | AutoSelect;

export interface ActionRow {
  type: 1;
  id?: number;
  components: Array<Button | SelectMenu | TextInput>;
}

export interface TextDisplay {
  type: 10;
  id?: number;
  content: string;
}

export interface Thumbnail {
  type: 11;
  id?: number;
  media: UnfurledMediaItem;
  description?: string | null;
  spoiler?: boolean;
}

export interface Section {
  type: 9;
  id?: number;
  components: TextDisplay[];
  accessory: Button | Thumbnail;
}

export interface MediaGalleryItem {
  media: UnfurledMediaItem;
  description?: string | null;
  spoiler?: boolean;
}

export interface MediaGallery {
  type: 12;
  id?: number;
  items: MediaGalleryItem[];
}

export interface FileComponent {
  type: 13;
  id?: number;
  file: UnfurledMediaItem;
  spoiler?: boolean;
}

export interface Separator {
  type: 14;
  id?: number;
  divider?: boolean;
  spacing?: 1 | 2;
}

export type ContainerChild = ActionRow | TextDisplay | Section | MediaGallery | Separator | FileComponent;

export interface Container {
  type: 17;
  id?: number;
  components: ContainerChild[];
  accent_color?: number | null;
  spoiler?: boolean;
}

export type MessageComponent = ActionRow | Section | TextDisplay | MediaGallery | FileComponent | Separator | Container | Thumbnail;

// Modal-only components ------------------------------------------------------

export interface TextInput {
  type: 4;
  id?: number;
  custom_id: string;
  style: 1 | 2;
  /** Deprecated outside of Labels; must be omitted inside a Label. */
  label?: string;
  min_length?: number;
  max_length?: number;
  required?: boolean;
  value?: string;
  placeholder?: string;
}

export interface FileUploadComponent {
  type: 19;
  id?: number;
  custom_id: string;
  min_values?: number;
  max_values?: number;
  required?: boolean;
  file_types?: string[];
}

export interface ChoiceOption {
  value: string;
  label: string;
  description?: string;
  default?: boolean;
}

export interface RadioGroup {
  type: 21;
  id?: number;
  custom_id: string;
  options: ChoiceOption[];
  required?: boolean;
}

export interface CheckboxGroup {
  type: 22;
  id?: number;
  custom_id: string;
  options: ChoiceOption[];
  min_values?: number;
  max_values?: number;
  required?: boolean;
}

export interface Checkbox {
  type: 23;
  id?: number;
  custom_id: string;
  default?: boolean;
}

export type LabelChild = TextInput | StringSelect | AutoSelect | FileUploadComponent | RadioGroup | CheckboxGroup | Checkbox;

export interface Label {
  type: 18;
  id?: number;
  label: string;
  description?: string;
  component: LabelChild;
}

export type ModalComponent = Label | TextDisplay | ActionRow;

export interface Modal {
  custom_id: string;
  title: string;
  components: ModalComponent[];
}

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------

export interface ResolvedData {
  users?: Record<Snowflake, User>;
  members?: Record<Snowflake, GuildMember>;
  channels?: Record<Snowflake, Channel>;
  messages?: Record<Snowflake, Message>;
  attachments?: Record<Snowflake, Attachment>;
}

export interface CommandOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: CommandOption[];
  focused?: boolean;
}

export interface ApplicationCommandData {
  id: Snowflake;
  name: string;
  type: number;
  resolved?: ResolvedData;
  options?: CommandOption[];
  guild_id?: Snowflake;
  target_id?: Snowflake;
}

export interface MessageComponentData {
  custom_id: string;
  component_type: number;
  values?: string[];
  resolved?: ResolvedData;
}

/** A submitted modal component (labels wrap the actual input). */
export interface SubmittedComponent {
  type: number;
  id?: number;
  custom_id?: string;
  value?: string | boolean | null;
  values?: string[];
  component?: SubmittedComponent;
  components?: SubmittedComponent[];
}

export interface ModalSubmitData {
  custom_id: string;
  components: SubmittedComponent[];
  resolved?: ResolvedData;
}

interface InteractionBase {
  id: Snowflake;
  application_id: Snowflake;
  token: string;
  version: number;
  guild_id?: Snowflake;
  guild?: { id: Snowflake; locale?: string; features?: string[] };
  channel_id?: Snowflake;
  channel?: Channel;
  member?: GuildMember & { user: User; permissions: string };
  user?: User;
  message?: Message;
  app_permissions?: string;
  locale?: string;
  guild_locale?: string;
  context?: number;
  authorizing_integration_owners?: Record<string, Snowflake>;
  attachment_size_limit?: number;
  entitlements?: unknown[];
}

export interface PingInteraction extends InteractionBase {
  type: 1;
}

export interface CommandInteraction extends InteractionBase {
  type: 2;
  data: ApplicationCommandData;
}

export interface ComponentInteraction extends InteractionBase {
  type: 3;
  data: MessageComponentData;
  message: Message;
}

export interface AutocompleteInteraction extends InteractionBase {
  type: 4;
  data: ApplicationCommandData;
}

export interface ModalSubmitInteraction extends InteractionBase {
  type: 5;
  data: ModalSubmitData;
}

export type Interaction =
  | PingInteraction
  | CommandInteraction
  | ComponentInteraction
  | AutocompleteInteraction
  | ModalSubmitInteraction;

export interface InteractionResponse {
  type: number;
  data?: MessagePayload | Modal | { choices: Array<{ name: string; value: string | number }> };
}

export interface InteractionCallbackResponse {
  interaction: { id: Snowflake; type: number; response_message_id?: Snowflake; response_message_ephemeral?: boolean };
  resource?: { type: number; message?: Message };
}

// ---------------------------------------------------------------------------
// Application & commands
// ---------------------------------------------------------------------------

export interface Application {
  id: Snowflake;
  name: string;
  description: string;
  icon?: string | null;
  bot_public?: boolean;
  owner?: User;
  team?: { id: Snowflake; owner_user_id: Snowflake; members: Array<{ user: User; role?: string; membership_state: number }> } | null;
  interactions_endpoint_url?: string | null;
  flags?: number;
}

export interface CommandOptionDefinition {
  type: number;
  name: string;
  description: string;
  required?: boolean;
  choices?: Array<{ name: string; value: string | number }>;
  options?: CommandOptionDefinition[];
  min_value?: number;
  max_value?: number;
  min_length?: number;
  max_length?: number;
  autocomplete?: boolean;
  channel_types?: number[];
}

export interface CommandDefinition {
  name: string;
  type?: number;
  description: string;
  options?: CommandOptionDefinition[];
  default_member_permissions?: string | null;
  integration_types?: number[];
  contexts?: number[] | null;
  nsfw?: boolean;
}

export interface RegisteredCommand extends CommandDefinition {
  id: Snowflake;
  application_id: Snowflake;
  version: Snowflake;
  guild_id?: Snowflake;
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

export interface GatewayPayload<D = unknown> {
  op: number;
  d: D;
  s: number | null;
  t: string | null;
}

export interface GatewayBotInfo {
  url: string;
  shards: number;
  session_start_limit: { total: number; remaining: number; reset_after: number; max_concurrency: number };
}

export interface ReadyEvent {
  v: number;
  user: User;
  guilds: Array<{ id: Snowflake; unavailable?: boolean }>;
  session_id: string;
  resume_gateway_url: string;
  shard?: [number, number];
  application: { id: Snowflake; flags: number };
}

export interface MessageDeleteEvent {
  id: Snowflake;
  channel_id: Snowflake;
  guild_id?: Snowflake;
}

export interface TypingStartEvent {
  channel_id: Snowflake;
  guild_id?: Snowflake;
  user_id: Snowflake;
  timestamp: number;
}

export interface MessageReactionEvent {
  user_id: Snowflake;
  channel_id: Snowflake;
  message_id: Snowflake;
  guild_id?: Snowflake;
  emoji: PartialEmoji;
  message_author_id?: Snowflake;
  burst?: boolean;
  type?: number;
}

export interface PresenceUpdate {
  since: number | null;
  activities: Array<{ name: string; type: number; state?: string; url?: string }>;
  status: 'online' | 'dnd' | 'idle' | 'invisible' | 'offline';
  afk: boolean;
}
