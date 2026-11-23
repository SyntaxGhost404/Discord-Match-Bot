// Discord API constants, transcribed from the official documentation
// (Discord-llms-full.txt). Plain `as const` objects instead of enums so the
// code runs under Node's native TypeScript type stripping.

export const API_VERSION = 10;
export const API_BASE = `https://discord.com/api/v${API_VERSION}`;
export const CDN_BASE = 'https://cdn.discordapp.com';

export const InteractionType = {
  Ping: 1,
  ApplicationCommand: 2,
  MessageComponent: 3,
  ApplicationCommandAutocomplete: 4,
  ModalSubmit: 5,
} as const;

export const InteractionCallbackType = {
  Pong: 1,
  ChannelMessageWithSource: 4,
  DeferredChannelMessageWithSource: 5,
  DeferredUpdateMessage: 6,
  UpdateMessage: 7,
  ApplicationCommandAutocompleteResult: 8,
  Modal: 9,
  LaunchActivity: 12,
} as const;

export const InteractionContextType = { Guild: 0, BotDm: 1, PrivateChannel: 2 } as const;
export const ApplicationIntegrationType = { GuildInstall: 0, UserInstall: 1 } as const;

export const ApplicationCommandType = { ChatInput: 1, User: 2, Message: 3, PrimaryEntryPoint: 4 } as const;

export const ApplicationCommandOptionType = {
  SubCommand: 1,
  SubCommandGroup: 2,
  String: 3,
  Integer: 4,
  Boolean: 5,
  User: 6,
  Channel: 7,
  Role: 8,
  Mentionable: 9,
  Number: 10,
  Attachment: 11,
} as const;

export const ComponentType = {
  ActionRow: 1,
  Button: 2,
  StringSelect: 3,
  TextInput: 4,
  UserSelect: 5,
  RoleSelect: 6,
  MentionableSelect: 7,
  ChannelSelect: 8,
  Section: 9,
  TextDisplay: 10,
  Thumbnail: 11,
  MediaGallery: 12,
  File: 13,
  Separator: 14,
  Container: 17,
  Label: 18,
  FileUpload: 19,
  RadioGroup: 21,
  CheckboxGroup: 22,
  Checkbox: 23,
} as const;

export const ButtonStyle = { Primary: 1, Secondary: 2, Success: 3, Danger: 4, Link: 5, Premium: 6 } as const;
export const TextInputStyle = { Short: 1, Paragraph: 2 } as const;
export const SeparatorSpacing = { Small: 1, Large: 2 } as const;

export const MessageFlags = {
  Crossposted: 1 << 0,
  IsCrosspost: 1 << 1,
  SuppressEmbeds: 1 << 2,
  SourceMessageDeleted: 1 << 3,
  Urgent: 1 << 4,
  HasThread: 1 << 5,
  Ephemeral: 1 << 6,
  Loading: 1 << 7,
  FailedToMentionSomeRolesInThread: 1 << 8,
  SuppressNotifications: 1 << 12,
  IsVoiceMessage: 1 << 13,
  HasSnapshot: 1 << 14,
  IsComponentsV2: 1 << 15,
} as const;

export const AttachmentFlags = {
  IsClip: 1 << 0,
  IsThumbnail: 1 << 1,
  IsRemix: 1 << 2,
  IsSpoiler: 1 << 3,
  ContainsExplicitContent: 1 << 4,
  IsAnimated: 1 << 5,
  ContainsGoreContent: 1 << 6,
  ContainsSelfHarmContent: 1 << 7,
} as const;

/** Flags Discord's content scanning sets on attachments we must never relay. */
export const UNSAFE_ATTACHMENT_FLAGS =
  AttachmentFlags.ContainsExplicitContent | AttachmentFlags.ContainsGoreContent | AttachmentFlags.ContainsSelfHarmContent;

export const ContentScanFlags = { IsExplicitContent: 1 << 0, IsGoreContent: 1 << 1, IsSelfHarmContent: 1 << 2 } as const;

export const MessageType = {
  Default: 0,
  RecipientAdd: 1,
  RecipientRemove: 2,
  Call: 3,
  ChannelPinnedMessage: 6,
  Reply: 19,
  ChatInputCommand: 20,
  ContextMenuCommand: 23,
} as const;

export const MessageReferenceType = { Default: 0, Forward: 1 } as const;

export const ChannelType = {
  GuildText: 0,
  DM: 1,
  GuildVoice: 2,
  GroupDM: 3,
  GuildCategory: 4,
  GuildAnnouncement: 5,
  AnnouncementThread: 10,
  PublicThread: 11,
  PrivateThread: 12,
  GuildStageVoice: 13,
  GuildForum: 15,
  GuildMedia: 16,
} as const;

export const GatewayOpcode = {
  Dispatch: 0,
  Heartbeat: 1,
  Identify: 2,
  PresenceUpdate: 3,
  VoiceStateUpdate: 4,
  Resume: 6,
  Reconnect: 7,
  RequestGuildMembers: 8,
  InvalidSession: 9,
  Hello: 10,
  HeartbeatAck: 11,
} as const;

export const GatewayIntents = {
  Guilds: 1 << 0,
  GuildMembers: 1 << 1,
  GuildModeration: 1 << 2,
  GuildExpressions: 1 << 3,
  GuildIntegrations: 1 << 4,
  GuildWebhooks: 1 << 5,
  GuildInvites: 1 << 6,
  GuildVoiceStates: 1 << 7,
  GuildPresences: 1 << 8,
  GuildMessages: 1 << 9,
  GuildMessageReactions: 1 << 10,
  GuildMessageTyping: 1 << 11,
  DirectMessages: 1 << 12,
  DirectMessageReactions: 1 << 13,
  DirectMessageTyping: 1 << 14,
  MessageContent: 1 << 15,
  GuildScheduledEvents: 1 << 16,
  AutoModerationConfiguration: 1 << 20,
  AutoModerationExecution: 1 << 21,
  GuildMessagePolls: 1 << 24,
  DirectMessagePolls: 1 << 25,
} as const;

/** Gateway close codes after which reconnecting is pointless (fix config instead). */
export const FATAL_GATEWAY_CLOSE_CODES: ReadonlySet<number> = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
/** Close codes that invalidate the session: reconnect, but identify fresh. */
export const SESSION_INVALIDATING_CLOSE_CODES: ReadonlySet<number> = new Set([4007, 4009]);

export const ActivityType = { Playing: 0, Streaming: 1, Listening: 2, Watching: 3, Custom: 4, Competing: 5 } as const;

/** Permission bits used by the bot (BigInt, as permissions exceed 32 bits). */
export const Permission = {
  CreateInstantInvite: 1n << 0n,
  KickMembers: 1n << 1n,
  BanMembers: 1n << 2n,
  Administrator: 1n << 3n,
  ManageChannels: 1n << 4n,
  ManageGuild: 1n << 5n,
  AddReactions: 1n << 6n,
  ViewChannel: 1n << 10n,
  SendMessages: 1n << 11n,
  ManageMessages: 1n << 13n,
  EmbedLinks: 1n << 14n,
  AttachFiles: 1n << 15n,
  ReadMessageHistory: 1n << 16n,
  ModerateMembers: 1n << 40n,
} as const;

/** JSON error codes the bot reacts to specifically. */
export const JsonErrorCode = {
  UnknownChannel: 10003,
  UnknownMessage: 10008,
  UnknownUser: 10013,
  UnknownWebhook: 10015,
  UnknownInteraction: 10062,
  ExplicitContentBlocked: 20009,
  MaxDailyCommandCreates: 30034,
  OpeningDmsTooFast: 40003,
  RequestEntityTooLarge: 40005,
  InteractionAlreadyAcknowledged: 40060,
  MissingAccess: 50001,
  CannotExecuteOnDm: 50003,
  CannotSendEmptyMessage: 50006,
  CannotSendMessagesToUser: 50007,
  MissingPermissions: 50013,
  InvalidFormBody: 50035,
  FileTooLarge: 50045,
  VoiceMessageNeedsSingleAudio: 50160,
  NoMutualGuilds: 50278,
} as const;

/** Content limits we validate against before calling the API. */
export const Limits = {
  messageContent: 2000,
  customId: 100,
  buttonLabel: 80,
  selectPlaceholder: 150,
  selectOptions: 25,
  selectOptionText: 100,
  linkUrl: 512,
  v2TotalComponents: 40,
  v2TotalText: 4000,
  legacyActionRows: 5,
  mediaGalleryItems: 10,
  sectionTexts: 3,
  modalTitle: 45,
  modalComponents: 5,
  labelText: 45,
  labelDescription: 100,
  textInputLength: 4000,
  textInputPlaceholder: 100,
  radioOptions: { min: 2, max: 10 },
  checkboxOptions: { min: 1, max: 10 },
  fileUploadMax: 10,
  embedTitle: 256,
  embedDescription: 4096,
  embedFields: 25,
  embedFieldName: 256,
  embedFieldValue: 1024,
  embedFooter: 2048,
  embedAuthor: 256,
  embedTotal: 6000,
  embedsPerMessage: 10,
  mediaAltText: 1024,
} as const;
