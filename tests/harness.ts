// Test harness: a fake Discord that records and validates everything the bot
// sends, plus simulated users that run commands, click buttons, submit modals
// and send DMs — driving the real App end to end.

import { deflateSync } from 'node:zlib';
import { createApp } from '../src/app.ts';
import type { Config } from '../src/config.ts';
import { loadConfig } from '../src/config.ts';
import type { App } from '../src/core/app.ts';
import { DiscordApi } from '../src/discord/rest/api.ts';
import { RestClient } from '../src/discord/rest/client.ts';
import { DiscordApiError } from '../src/discord/rest/errors.ts';
import { validateMessagePayload, validateModal } from '../src/discord/components/validate.ts';
import { MessageFlags } from '../src/discord/constants.ts';
import type {
  Application,
  Attachment,
  Channel,
  CommandDefinition,
  CommandOption,
  FileUpload,
  GatewayBotInfo,
  InteractionCallbackResponse,
  InteractionResponse,
  Message,
  MessagePayload,
  Modal,
  RegisteredCommand,
  SubmittedComponent,
  User,
} from '../src/discord/types.ts';
import { Store } from '../src/db/store.ts';
import { silentLogger } from '../src/util/logger.ts';
import { compareSnowflakes } from '../src/util/snowflake.ts';

export const APP_ID = '1300000000000000001';
export const OWNER_ID = '1300000000000000002';
export const MOD_GUILD = '1300000000000000003';
export const MOD_CHANNEL = '1300000000000000004';
export const GUILD_CHANNEL = '1300000000000000005';

let counter = 10_000n;
export const nextId = () => String(1_400_000_000_000_000_000n + counter++);

export interface Recorded {
  kind: 'callback' | 'edit_original' | 'followup' | 'create' | 'edit' | 'delete';
  channelId?: string;
  type?: number;
  payload?: MessagePayload;
  modal?: Modal;
  message?: Message;
}

export class FakeDiscord extends DiscordApi {
  readonly messages = new Map<string, Message[]>();
  readonly dmByUser = new Map<string, string>();
  readonly closedDms = new Set<string>();
  readonly log: Recorded[] = [];
  readonly issues: string[] = [];
  readonly typing: string[] = [];
  readonly reactions: Array<{ channelId: string; messageId: string; emoji: string; added: boolean }> = [];
  readonly uploads = new Map<string, Uint8Array>();
  readonly interactionChannel = new Map<string, string>();
  readonly interactionSource = new Map<string, Message>();
  readonly originals = new Map<string, Message>();
  commands: RegisteredCommand[] = [];
  guildCommands = new Map<string, RegisteredCommand[]>();
  putCount = 0;

  constructor() {
    super(new RestClient({ token: 'test.token.value', logger: silentLogger, fetch: (() => Promise.reject(new Error('no network in tests'))) as typeof fetch }), APP_ID);
  }

  // -- helpers -------------------------------------------------------------------

  channel(id: string): Message[] {
    let list = this.messages.get(id);
    if (!list) this.messages.set(id, (list = []));
    return list;
  }

  find(channelId: string, messageId: string): Message | undefined {
    return this.channel(channelId).find((m) => m.id === messageId);
  }

  private check(payload: MessagePayload, where: string): void {
    for (const issue of validateMessagePayload(payload)) this.issues.push(`${where}: ${issue.path}: ${issue.message}`);
  }

  private build(channelId: string, payload: MessagePayload, files: FileUpload[] | undefined, author: User): Message {
    const attachments: Attachment[] = (files ?? []).map((file) => {
      const id = nextId();
      const url = `https://cdn.test/attachments/${channelId}/${id}/${file.name}`;
      this.uploads.set(url, file.data);
      return { id, filename: file.name, size: file.data.length, url, content_type: file.contentType, flags: 0 };
    });
    return {
      id: nextId(),
      channel_id: channelId,
      author,
      content: payload.content ?? '',
      timestamp: new Date().toISOString(),
      edited_timestamp: null,
      attachments,
      embeds: payload.embeds ?? [],
      components: payload.components ?? [],
      flags: payload.flags ?? 0,
      type: payload.message_reference ? 19 : 0,
      message_reference: payload.message_reference,
    };
  }

  private apply(message: Message, payload: MessagePayload): void {
    if (payload.content !== undefined) message.content = payload.content ?? '';
    if (payload.embeds !== undefined) message.embeds = payload.embeds;
    if (payload.components !== undefined) message.components = payload.components;
    if (payload.flags !== undefined) message.flags = (message.flags ?? 0) | payload.flags;
    message.edited_timestamp = new Date().toISOString();
  }

  readonly botUser: User = { id: APP_ID, username: 'TestBot', bot: true };

  // -- application & commands ------------------------------------------------------

  override async getCurrentApplication(): Promise<Application> {
    return { id: APP_ID, name: 'TestBot', description: '', owner: { id: OWNER_ID, username: 'owner' } };
  }

  override async getGatewayBot(): Promise<GatewayBotInfo> {
    return { url: 'wss://gateway.test', shards: 1, session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 } };
  }

  override async getGlobalCommands(): Promise<RegisteredCommand[]> {
    return this.commands;
  }

  override async bulkOverwriteGlobalCommands(commands: CommandDefinition[]): Promise<RegisteredCommand[]> {
    this.putCount++;
    this.commands = commands.map((c) => ({ ...c, id: nextId(), application_id: APP_ID, version: nextId() }));
    return this.commands;
  }

  override async getGuildCommands(guildId: string): Promise<RegisteredCommand[]> {
    return this.guildCommands.get(guildId) ?? [];
  }

  override async bulkOverwriteGuildCommands(guildId: string, commands: CommandDefinition[]): Promise<RegisteredCommand[]> {
    this.putCount++;
    const registered = commands.map((c) => ({ ...c, id: nextId(), application_id: APP_ID, version: nextId(), guild_id: guildId }));
    this.guildCommands.set(guildId, registered);
    return registered;
  }

  override async getUser(userId: string): Promise<User> {
    return { id: userId, username: `user${userId.slice(-4)}` };
  }

  // -- interactions --------------------------------------------------------------------

  override async createInteractionResponse(
    interactionId: string,
    token: string,
    response: InteractionResponse,
    options: { files?: FileUpload[]; withResponse?: boolean } = {},
  ): Promise<InteractionCallbackResponse | undefined> {
    const channelId = this.interactionChannel.get(interactionId) ?? 'unknown';
    const source = this.interactionSource.get(interactionId);
    let message: Message | undefined;
    switch (response.type) {
      case 4: {
        const payload = response.data as MessagePayload;
        this.check(payload, `callback(4) ${token}`);
        message = this.build(channelId, payload, options.files, this.botUser);
        this.channel(channelId).push(message);
        this.originals.set(token, message);
        break;
      }
      case 5: {
        const flags = (response.data as MessagePayload | undefined)?.flags ?? 0;
        if (flags & ~MessageFlags.Ephemeral) this.issues.push('deferred reply with flags other than EPHEMERAL');
        message = this.build(channelId, { content: '', flags: flags | MessageFlags.Loading }, undefined, this.botUser);
        this.channel(channelId).push(message);
        this.originals.set(token, message);
        break;
      }
      case 6:
        if (!source) this.issues.push('deferred update without a source message');
        else this.originals.set(token, source);
        break;
      case 7: {
        const payload = response.data as MessagePayload;
        this.check(payload, `callback(7) ${token}`);
        if (!source) this.issues.push('update without a source message');
        else {
          const stored = this.find(source.channel_id, source.id) ?? source;
          this.validateUpdate(stored, payload, 'callback(7)');
          this.apply(stored, payload);
          this.originals.set(token, stored);
          message = stored;
        }
        break;
      }
      case 9:
        for (const issue of validateModal(response.data as Modal)) this.issues.push(`modal: ${issue.path}: ${issue.message}`);
        this.log.push({ kind: 'callback', type: 9, modal: response.data as Modal });
        return undefined;
      default:
        this.issues.push(`unexpected callback type ${response.type}`);
    }
    this.log.push({ kind: 'callback', type: response.type, payload: response.data as MessagePayload, channelId, message });
    if (!options.withResponse) return undefined;
    return { interaction: { id: interactionId, type: 2, response_message_id: message?.id }, resource: message ? { type: response.type, message } : undefined };
  }

  private validateUpdate(existing: Message, payload: MessagePayload, where: string): void {
    const wasV2 = ((existing.flags ?? 0) & MessageFlags.IsComponentsV2) !== 0;
    const isV2 = ((payload.flags ?? 0) & MessageFlags.IsComponentsV2) !== 0;
    if (wasV2 && !isV2 && (payload.embeds?.length || payload.content)) this.issues.push(`${where}: classic content on a V2 message`);
    if (!wasV2 && isV2 && (existing.embeds.length || existing.content)) this.issues.push(`${where}: turned a classic message into V2`);
  }

  override async editOriginalResponse(token: string, payload: MessagePayload): Promise<Message> {
    this.check(payload, `edit_original ${token}`);
    const message = this.originals.get(token);
    if (!message) throw new DiscordApiError(404, { code: 10008, message: 'Unknown Message' }, 'PATCH', '/webhooks/:id/:token/messages/@original');
    this.validateUpdate(message, payload, 'edit_original');
    this.apply(message, payload);
    message.flags = (message.flags ?? 0) & ~MessageFlags.Loading;
    this.log.push({ kind: 'edit_original', payload, message, channelId: message.channel_id });
    return message;
  }

  override async deleteOriginalResponse(): Promise<void> {}

  override async createFollowup(token: string, payload: MessagePayload): Promise<Message> {
    this.check(payload, `followup ${token}`);
    const original = this.originals.get(token);
    const channelId = original?.channel_id ?? 'unknown';
    const message = this.build(channelId, payload, undefined, this.botUser);
    this.channel(channelId).push(message);
    this.log.push({ kind: 'followup', payload, message, channelId });
    return message;
  }

  // -- channels & messages --------------------------------------------------------------

  override async createDm(userId: string): Promise<Channel> {
    let id = this.dmByUser.get(userId);
    if (!id) {
      id = nextId();
      this.dmByUser.set(userId, id);
    }
    return { id, type: 1, recipients: [{ id: userId, username: 'x' }] };
  }

  private dmOwner(channelId: string): string | undefined {
    for (const [userId, id] of this.dmByUser) if (id === channelId) return userId;
    return undefined;
  }

  override async createMessage(channelId: string, payload: MessagePayload, files?: FileUpload[]): Promise<Message> {
    const owner = this.dmOwner(channelId);
    if (owner && this.closedDms.has(owner)) {
      throw new DiscordApiError(403, { code: 50007, message: 'Cannot send messages to this user' }, 'POST', `/channels/${channelId}/messages`);
    }
    this.check(payload, `create ${channelId}`);
    if ((payload.flags ?? 0) & MessageFlags.IsVoiceMessage && (files?.length !== 1 || payload.content)) this.issues.push('voice messages need exactly one file and no content');
    const message = this.build(channelId, payload, files, this.botUser);
    this.channel(channelId).push(message);
    this.log.push({ kind: 'create', channelId, payload, message });
    return structuredClone(message);
  }

  override async editMessage(channelId: string, messageId: string, payload: MessagePayload): Promise<Message> {
    this.check(payload, `edit ${channelId}`);
    const message = this.find(channelId, messageId);
    if (!message) throw new DiscordApiError(404, { code: 10008, message: 'Unknown Message' }, 'PATCH', `/channels/${channelId}/messages/${messageId}`);
    this.validateUpdate(message, payload, 'edit');
    this.apply(message, payload);
    this.log.push({ kind: 'edit', channelId, payload, message });
    return structuredClone(message);
  }

  override async deleteMessage(channelId: string, messageId: string): Promise<void> {
    const list = this.channel(channelId);
    const index = list.findIndex((m) => m.id === messageId);
    if (index < 0) throw new DiscordApiError(404, { code: 10008, message: 'Unknown Message' }, 'DELETE', `/channels/${channelId}/messages/${messageId}`);
    list.splice(index, 1);
    this.log.push({ kind: 'delete', channelId });
  }

  override async getMessages(channelId: string, query: { after?: string; limit?: number }): Promise<Message[]> {
    return this.channel(channelId)
      .filter((m) => !query.after || compareSnowflakes(m.id, query.after) > 0)
      .sort((a, b) => compareSnowflakes(b.id, a.id))
      .slice(0, query.limit ?? 50)
      .map((m) => structuredClone(m));
  }

  override async triggerTyping(channelId: string): Promise<void> {
    this.typing.push(channelId);
  }

  override async addOwnReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    this.reactions.push({ channelId, messageId, emoji, added: true });
  }

  override async removeOwnReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    this.reactions.push({ channelId, messageId, emoji, added: false });
  }

  /** Bot-authored messages in a channel, newest last. */
  botMessages(channelId: string): Message[] {
    return this.channel(channelId).filter((m) => m.author.id === APP_ID);
  }
}

// -- component helpers ---------------------------------------------------------------------

type Node = Record<string, unknown>;

export function allComponents(message: { components?: unknown[] }): Node[] {
  const out: Node[] = [];
  const walk = (nodes: unknown[] | undefined) => {
    for (const raw of nodes ?? []) {
      const node = raw as Node;
      out.push(node);
      walk(node.components as unknown[] | undefined);
      if (node.accessory) walk([node.accessory]);
    }
  };
  walk(message.components);
  return out;
}

/** All text shown by a message (V2 text displays + content + embeds). */
export function textOf(message: Message | MessagePayload): string {
  const parts: string[] = [];
  if (message.content) parts.push(message.content);
  for (const embed of message.embeds ?? []) {
    parts.push(embed.title ?? '', embed.description ?? '', ...(embed.fields ?? []).flatMap((f) => [f.name, f.value]), embed.footer?.text ?? '');
  }
  for (const node of allComponents(message as { components?: unknown[] })) if (node.type === 10) parts.push(String(node.content));
  return parts.join('\n');
}

export function buttonIds(message: Message | MessagePayload): string[] {
  return allComponents(message as { components?: unknown[] })
    .filter((n) => (n.type === 2 && n.custom_id) || n.type === 3)
    .map((n) => String(n.custom_id));
}

export function findCustomId(message: Message | MessagePayload, prefix: string): string {
  const id = buttonIds(message).find((c) => c === prefix || c.startsWith(`${prefix}:`));
  if (!id) throw new Error(`No component starting with ${prefix} in: ${buttonIds(message).join(', ')}\n${textOf(message)}`);
  return id;
}

// -- simulated users ----------------------------------------------------------------------------

export type ModalInput = Record<string, string | string[] | boolean | Array<{ filename: string; data: Uint8Array; contentType: string }>>;

export class TestUser {
  readonly id: string;
  readonly username: string;
  private readonly h: Harness;

  constructor(h: Harness, id: string, username: string) {
    this.h = h;
    this.id = id;
    this.username = username;
  }

  get user(): User {
    return { id: this.id, username: this.username, global_name: this.username };
  }

  /** The user's DM channel with the bot (created on first use). */
  get dm(): string {
    let id = this.h.discord.dmByUser.get(this.id);
    if (!id) {
      id = nextId();
      this.h.discord.dmByUser.set(this.id, id);
    }
    return id;
  }

  /** Latest bot message in the user's DM. */
  last(): Message {
    const list = this.h.discord.botMessages(this.dm);
    const message = list[list.length - 1];
    if (!message) throw new Error(`No bot messages in ${this.username}'s DM`);
    return message;
  }

  inbox(): Message[] {
    return this.h.discord.botMessages(this.dm);
  }

  private base(type: number, where: 'dm' | 'guild', extra: Record<string, unknown>) {
    const id = nextId();
    const channelId = where === 'dm' ? this.dm : GUILD_CHANNEL;
    this.h.discord.interactionChannel.set(id, channelId);
    const interaction: Record<string, unknown> = {
      id,
      application_id: APP_ID,
      type,
      token: `tok-${id}`,
      version: 1,
      channel_id: channelId,
      locale: 'en-US',
      app_permissions: '0',
      entitlements: [],
      attachment_size_limit: 20 * 1024 * 1024,
      ...extra,
    };
    if (where === 'dm') {
      interaction.context = 1;
      interaction.channel = { id: channelId, type: 1 };
      interaction.user = this.user;
    } else {
      interaction.context = 0;
      interaction.guild_id = this.h.guildId;
      interaction.channel = { id: channelId, type: 0 };
      interaction.member = { user: this.user, roles: [], permissions: this.h.memberPermissions(this.id) };
    }
    return interaction;
  }

  private async run(interaction: Record<string, unknown>): Promise<Recorded[]> {
    const before = this.h.discord.log.length;
    await this.h.app.router.handle(interaction as never);
    return this.h.discord.log.slice(before);
  }

  async command(name: string, options: CommandOption[] = [], where: 'dm' | 'guild' = 'dm'): Promise<Recorded[]> {
    return this.run(this.base(2, where, { data: { id: nextId(), name, type: 1, options } }));
  }

  async click(message: Message, customId: string, values?: string[], where: 'dm' | 'guild' = 'dm'): Promise<Recorded[]> {
    const interaction = this.base(3, where, {
      message: structuredClone(message),
      data: { custom_id: customId, component_type: values ? 3 : 2, ...(values ? { values } : {}) },
    });
    this.h.discord.interactionSource.set(String(interaction.id), message);
    return this.run(interaction);
  }

  /** Submits the most recent modal the bot opened for this user. */
  async submit(modal: Modal, input: ModalInput, source?: Message, where: 'dm' | 'guild' = 'dm'): Promise<Recorded[]> {
    const resolved: Record<string, Attachment> = {};
    const toSubmitted = (component: Node): SubmittedComponent => {
      const customId = String(component.custom_id);
      const given = input[customId];
      switch (component.type) {
        case 4:
          return { type: 4, custom_id: customId, value: typeof given === 'string' ? given : String(component.value ?? '') };
        case 3: {
          const defaults = ((component.options as Node[]) ?? []).filter((o) => o.default).map((o) => String(o.value));
          return { type: 3, custom_id: customId, values: Array.isArray(given) ? (given as string[]) : defaults };
        }
        case 21: {
          const fallback = ((component.options as Node[]) ?? []).find((o) => o.default)?.value;
          return { type: 21, custom_id: customId, value: typeof given === 'string' ? given : fallback === undefined ? null : String(fallback) };
        }
        case 22: {
          const defaults = ((component.options as Node[]) ?? []).filter((o) => o.default).map((o) => String(o.value));
          return { type: 22, custom_id: customId, values: Array.isArray(given) ? (given as string[]) : defaults };
        }
        case 23:
          return { type: 23, custom_id: customId, value: typeof given === 'boolean' ? given : component.default === true };
        case 19: {
          const files = Array.isArray(given) ? (given as Array<{ filename: string; data: Uint8Array; contentType: string }>) : [];
          const ids = files.map((file) => {
            const id = nextId();
            const url = `https://cdn.test/ephemeral-attachments/${id}/${file.filename}`;
            this.h.discord.uploads.set(url, file.data);
            resolved[id] = { id, filename: file.filename, size: file.data.length, url, content_type: file.contentType, ephemeral: true };
            return id;
          });
          return { type: 19, custom_id: customId, values: ids };
        }
        default:
          throw new Error(`unsupported modal component ${String(component.type)}`);
      }
    };
    const components: SubmittedComponent[] = modal.components.map((top) => {
      const node = top as unknown as Node;
      if (node.type === 18) return { type: 18, component: toSubmitted(node.component as Node) };
      return { type: Number(node.type) };
    });
    const interaction = this.base(5, where, {
      ...(source ? { message: structuredClone(source) } : {}),
      data: { custom_id: modal.custom_id, components, resolved: { attachments: resolved } },
    });
    if (source) this.h.discord.interactionSource.set(String(interaction.id), source);
    return this.run(interaction);
  }

  /** Sends a DM to the bot (as if typed in Discord), delivered as MESSAGE_CREATE. */
  async say(content: string, extra: Partial<Message> = {}): Promise<Message> {
    const message: Message = {
      id: nextId(),
      channel_id: this.dm,
      author: this.user,
      content,
      timestamp: new Date(this.h.now).toISOString(),
      edited_timestamp: null,
      attachments: [],
      embeds: [],
      type: extra.message_reference ? 19 : 0,
      flags: 0,
      ...extra,
    };
    this.h.discord.channel(this.dm).push(message);
    await this.h.app.relay.onMessageCreate(structuredClone(message));
    return message;
  }
}

export function modalFrom(records: Recorded[]): Modal {
  const record = records.find((r) => r.type === 9 && r.modal);
  if (!record?.modal) throw new Error(`Expected a modal, got: ${JSON.stringify(records.map((r) => [r.kind, r.type]))}`);
  return record.modal;
}

/** The message a set of records produced or edited (last one wins). */
export function shown(records: Recorded[]): Message {
  const record = [...records].reverse().find((r) => r.message);
  if (!record?.message) throw new Error(`No message in records: ${JSON.stringify(records.map((r) => [r.kind, r.type]))}`);
  return record.message;
}

// -- harness ---------------------------------------------------------------------------------

export class Harness {
  readonly discord = new FakeDiscord();
  readonly guildId = MOD_GUILD;
  now = Date.UTC(2026, 10, 23, 12, 0, 0);
  app!: App;
  private readonly moderators = new Set<string>();
  private readonly users = new Map<string, TestUser>();

  static async create(overrides: Record<string, string> = {}): Promise<Harness> {
    const h = new Harness();
    const config: Config = loadConfig({
      DISCORD_TOKEN: 'MTAwMDAwMDAwMDAwMDAwMDAw.GxxxxX.abcdefghijklmnopqrstuvwxyz0123456789ab',
      DATABASE_PATH: ':memory:',
      MOD_GUILD_ID: MOD_GUILD,
      MOD_CHANNEL_ID: MOD_CHANNEL,
      VALIDATE_PAYLOADS: '1',
      LOG_LEVEL: 'error',
      ...overrides,
    });
    const fetchFake = (async (url: URL | string | Request) => {
      const data = h.discord.uploads.get(String(url));
      if (!data) return new Response('not found', { status: 404 });
      return new Response(data as Uint8Array<ArrayBuffer>, { status: 200, headers: { 'content-length': String(data.length) } });
    }) as typeof fetch;
    h.app = await createApp({ config, api: h.discord, store: Store.open(':memory:'), clock: () => h.now, log: silentLogger, fetch: fetchFake });
    return h;
  }

  user(name: string): TestUser {
    let u = this.users.get(name);
    if (!u) {
      // Old account ids (created years ago) so account-age checks pass.
      u = new TestUser(this, String(700_000_000_000_000_000n + BigInt(this.users.size + 1) * 1_000_000n), name);
      this.users.set(name, u);
    }
    return u;
  }

  makeModerator(user: TestUser): void {
    this.moderators.add(user.id);
  }

  memberPermissions(userId: string): string {
    return this.moderators.has(userId) ? String(1n << 2n) : '0';
  }

  advance(ms: number): void {
    this.now += ms;
  }

  async runJobs(): Promise<void> {
    for (let i = 0; i < 5; i++) if ((await this.app.jobs.tick()) === 0) break;
  }

  /** Runs the whole onboarding flow for a user and returns the final card. */
  async onboard(
    user: TestUser,
    options: { birthday: string; gender?: string; interests?: string[]; languages?: string[]; lookingFor?: string[]; bio?: string; photo?: boolean },
  ): Promise<Message> {
    const welcome = shown(await user.command('start'));
    const basicsModal = modalFrom(await user.click(welcome, findCustomId(welcome, 'onb:start')));
    const confirm = shown(await user.submit(basicsModal, { name: user.username, birthday: options.birthday, gender: options.gender ?? 'woman', agree: true }, welcome));
    const aboutModal = modalFrom(await user.click(confirm, findCustomId(confirm, 'onb:age_ok')));
    const photosStep = shown(
      await user.submit(
        aboutModal,
        {
          interests: options.interests ?? ['music', 'gaming'],
          looking_for: options.lookingFor ?? ['friends'],
          languages: options.languages ?? ['en'],
          location: 'Dhaka',
          bio: options.bio ?? 'Hi there!',
        },
        confirm,
      ),
    );
    let review: Message;
    if (options.photo) {
      const photosModal = modalFrom(await user.click(photosStep, findCustomId(photosStep, 'onb:photos')));
      review = shown(await user.submit(photosModal, { photos: [{ filename: 'me.png', data: TINY_PNG, contentType: 'image/png' }] }, photosStep));
    } else {
      review = shown(await user.click(photosStep, findCustomId(photosStep, 'onb:skip_photos')));
    }
    return shown(await user.click(review, findCustomId(review, 'onb:finish')));
  }
}

// A valid 1×1 PNG carrying a tEXt chunk (which the photo pipeline must strip).
function makePng(): Uint8Array {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const b of bytes) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('tEXt', Buffer.from('GPS\u0000somewhere secret', 'latin1')),
      chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

export const TINY_PNG = makePng();
