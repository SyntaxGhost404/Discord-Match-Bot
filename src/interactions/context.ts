// Per-interaction response helper with an explicit acknowledgement state
// machine. Discord allows exactly one initial response (within 3 seconds) and
// then edits/follow-ups for 15 minutes; this class picks the correct endpoint
// for whatever state the interaction is in, so handlers simply say what they
// want ("reply", "update", "show a modal") and never double-acknowledge.
//
//   none ──reply──▶ replied        none ──deferReply──▶ deferred-reply ──reply/update──▶ edit @original
//   none ──update─▶ updated        none ──deferUpdate─▶ deferred-update ──update──▶ edit @original
//   none ──modal──▶ modal          any acknowledged ──reply──▶ follow-up message
//
// All operations on one context are serialized, so an automatic defer
// (the 3-second watchdog in the router) can never race a handler's reply.

import { ComponentType, InteractionCallbackType, InteractionContextType, InteractionType, JsonErrorCode, MessageFlags } from '../discord/constants.ts';
import type { DiscordApi } from '../discord/rest/api.ts';
import { isApiError } from '../discord/rest/errors.ts';
import { assertValidMessage, assertValidModal } from '../discord/components/validate.ts';
import type {
  CommandInteraction,
  CommandOption,
  ComponentInteraction,
  FileUpload,
  Interaction,
  Message,
  MessagePayload,
  Modal,
  ModalSubmitInteraction,
  User,
} from '../discord/types.ts';
import { ModalValues } from './modal-values.ts';
import type { Logger } from '../util/logger.ts';

export type AckState = 'none' | 'deferred-reply' | 'deferred-update' | 'replied' | 'updated' | 'modal' | 'expired';

export interface ContextServices {
  api: DiscordApi;
  log: Logger;
  /** Validate every outgoing payload against Discord's documented limits. */
  validatePayloads: boolean;
}

export interface ReplyOptions {
  ephemeral?: boolean;
  files?: FileUpload[];
  /** Ask Discord to return the created message (to learn its id). */
  withMessage?: boolean;
}

export class ModalUnavailableError extends Error {
  constructor() {
    super('A modal can only be the first response to an interaction');
    this.name = 'ModalUnavailableError';
  }
}

export class InteractionContext<I extends Interaction = Interaction> {
  readonly interaction: I;
  readonly user: User;
  readonly receivedAt: number;
  private readonly services: ContextServices;
  private state: AckState = 'none';
  private chain: Promise<unknown> = Promise.resolve();
  /** Id of the message created by reply() when requested via withMessage. */
  responseMessageId: string | null = null;

  constructor(interaction: I, services: ContextServices, receivedAt = Date.now()) {
    this.interaction = interaction;
    this.services = services;
    this.receivedAt = receivedAt;
    const user = interaction.member?.user ?? interaction.user;
    if (!user) throw new Error('Interaction without a user');
    this.user = user;
  }

  // -- facts about the interaction ---------------------------------------------

  get ackState(): AckState {
    return this.state;
  }

  get acknowledged(): boolean {
    return this.state !== 'none';
  }

  /** True inside the user's DM with the bot (messages there are persistent). */
  get inBotDm(): boolean {
    if (this.interaction.context !== undefined) return this.interaction.context === InteractionContextType.BotDm;
    return !this.interaction.guild_id && this.interaction.channel?.type === 1;
  }

  get guildId(): string | null {
    return this.interaction.guild_id ?? null;
  }

  get channelId(): string | null {
    return this.interaction.channel_id ?? this.interaction.channel?.id ?? null;
  }

  get locale(): string {
    return this.interaction.locale ?? 'en-US';
  }

  /** Member permissions in the guild (null outside guilds). */
  get memberPermissions(): bigint | null {
    const raw = this.interaction.member?.permissions;
    return raw ? BigInt(raw) : null;
  }

  /** Whether the interaction came from a message component (or a modal opened from one). */
  get hasSourceMessage(): boolean {
    return Boolean(this.interaction.message);
  }

  get sourceMessage(): Message | null {
    return this.interaction.message ?? null;
  }

  // -- responses ------------------------------------------------------------------

  /** Sends a new message (initial reply, deferred edit, or follow-up). */
  reply(payload: MessagePayload, options: ReplyOptions = {}): Promise<void> {
    return this.serialize(async () => {
      const ephemeral = options.ephemeral ?? !this.inBotDm;
      this.check(payload);
      switch (this.state) {
        case 'none': {
          const data = withEphemeral(payload, ephemeral);
          const result = await this.callback(InteractionCallbackType.ChannelMessageWithSource, data, options.files, options.withMessage);
          if (result === 'expired') return;
          this.responseMessageId = result?.resource?.message?.id ?? result?.interaction.response_message_id ?? null;
          this.state = 'replied';
          return;
        }
        case 'deferred-reply': {
          const message = await this.services.api.editOriginalResponse(this.interaction.token, stripEphemeral(payload), options.files);
          this.responseMessageId = message?.id ?? null;
          this.state = 'replied';
          return;
        }
        case 'expired':
          return this.warnExpired('reply');
        default:
          await this.services.api.createFollowup(this.interaction.token, withEphemeral(payload, ephemeral), options.files);
      }
    });
  }

  /**
   * Replaces the message the component lives on. Falls back to reply() when
   * there is no source message (slash commands, modals opened by commands).
   */
  update(payload: MessagePayload, options: { files?: FileUpload[] } = {}): Promise<void> {
    if (!this.hasSourceMessage) return this.reply(payload, options);
    // The V2 flag can't be removed from a message, and turning a classic
    // message into V2 would wipe its embeds — send a new message instead.
    const sourceIsV2 = ((this.interaction.message?.flags ?? 0) & MessageFlags.IsComponentsV2) !== 0;
    const payloadIsV2 = ((payload.flags ?? 0) & MessageFlags.IsComponentsV2) !== 0;
    if (sourceIsV2 !== payloadIsV2) return this.reply(payload, options);
    return this.serialize(async () => {
      this.check(payload);
      const data = stripEphemeral(payload);
      switch (this.state) {
        case 'none': {
          const result = await this.callback(InteractionCallbackType.UpdateMessage, data, options.files);
          if (result !== 'expired') this.state = 'updated';
          return;
        }
        case 'expired':
          return this.warnExpired('update');
        default:
          await this.services.api.editOriginalResponse(this.interaction.token, data, options.files);
          if (this.state === 'deferred-update') this.state = 'updated';
          if (this.state === 'deferred-reply') this.state = 'replied';
      }
    });
  }

  showModal(modal: Modal): Promise<void> {
    return this.serialize(async () => {
      if (this.state !== 'none') throw new ModalUnavailableError();
      if (this.services.validatePayloads) assertValidModal(modal);
      const result = await this.callback(InteractionCallbackType.Modal, modal);
      if (result !== 'expired') this.state = 'modal';
    });
  }

  /** Acknowledges now and shows "thinking…"; the response comes later. */
  deferReply(options: { ephemeral?: boolean } = {}): Promise<void> {
    return this.serialize(async () => {
      if (this.state !== 'none') return;
      const ephemeral = options.ephemeral ?? !this.inBotDm;
      // Only the EPHEMERAL flag is allowed on a deferred response.
      const result = await this.callback(InteractionCallbackType.DeferredChannelMessageWithSource, ephemeral ? { flags: MessageFlags.Ephemeral } : {});
      if (result !== 'expired') this.state = 'deferred-reply';
    });
  }

  /** Acknowledges a component interaction without a loading state. */
  deferUpdate(): Promise<void> {
    if (!this.hasSourceMessage) return this.deferReply();
    return this.serialize(async () => {
      if (this.state !== 'none') return;
      const result = await this.callback(InteractionCallbackType.DeferredUpdateMessage);
      if (result !== 'expired') this.state = 'deferred-update';
    });
  }

  /** Always sends an additional message (after the interaction is acknowledged). */
  followUp(payload: MessagePayload, options: { ephemeral?: boolean; files?: FileUpload[] } = {}): Promise<void> {
    return this.serialize(async () => {
      if (this.state === 'none') {
        // Nothing acknowledged yet: a follow-up is just a reply.
        const ephemeral = options.ephemeral ?? !this.inBotDm;
        this.check(payload);
        const result = await this.callback(InteractionCallbackType.ChannelMessageWithSource, withEphemeral(payload, ephemeral), options.files);
        if (result !== 'expired') this.state = 'replied';
        return;
      }
      if (this.state === 'expired') return this.warnExpired('followUp');
      this.check(payload);
      await this.services.api.createFollowup(this.interaction.token, withEphemeral(payload, options.ephemeral ?? !this.inBotDm), options.files);
    });
  }

  /** Used by the router's watchdog so slow handlers never miss the 3s deadline. */
  autoDefer(): Promise<void> {
    if (this.state !== 'none') return Promise.resolve();
    const kind = this.interaction.type;
    if ((kind === InteractionType.MessageComponent || kind === InteractionType.ModalSubmit) && this.hasSourceMessage) {
      return this.deferUpdate();
    }
    return this.deferReply();
  }

  // -- internals -------------------------------------------------------------------

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private check(payload: MessagePayload): void {
    if (this.services.validatePayloads) assertValidMessage(payload);
  }

  private async callback(
    type: number,
    data?: MessagePayload | Modal,
    files?: FileUpload[],
    withResponse = false,
  ): Promise<Awaited<ReturnType<DiscordApi['createInteractionResponse']>> | 'expired'> {
    try {
      return await this.services.api.createInteractionResponse(
        this.interaction.id,
        this.interaction.token,
        data === undefined ? { type } : { type, data },
        { files, withResponse },
      );
    } catch (error) {
      if (isApiError(error, JsonErrorCode.UnknownInteraction)) {
        // The 3-second window passed (or the token is otherwise invalid).
        this.state = 'expired';
        this.services.log.warn('Interaction expired before it was acknowledged', {
          ageMs: Date.now() - this.receivedAt,
          type: this.interaction.type,
        });
        return 'expired';
      }
      if (isApiError(error, JsonErrorCode.InteractionAlreadyAcknowledged)) {
        // Someone else (another running instance?) answered first.
        this.state = 'replied';
        this.services.log.warn('Interaction was already acknowledged elsewhere — is another instance of the bot running?');
        return 'expired';
      }
      throw error;
    }
  }

  private warnExpired(operation: string): void {
    this.services.log.debug('Skipping response on an expired interaction', { operation });
  }
}

function withEphemeral(payload: MessagePayload, ephemeral: boolean): MessagePayload {
  if (!ephemeral) return payload;
  return { ...payload, flags: (payload.flags ?? 0) | MessageFlags.Ephemeral };
}

function stripEphemeral(payload: MessagePayload): MessagePayload {
  if (!payload.flags || !(payload.flags & MessageFlags.Ephemeral)) return payload;
  return { ...payload, flags: payload.flags & ~MessageFlags.Ephemeral };
}

// -- typed context aliases & helpers ------------------------------------------------

export type CommandContext = InteractionContext<CommandInteraction>;
export type ComponentContext = InteractionContext<ComponentInteraction>;
export type ModalContext = InteractionContext<ModalSubmitInteraction>;
export type AnyContext = InteractionContext<CommandInteraction | ComponentInteraction | ModalSubmitInteraction>;

/** Flattens subcommands: returns { sub: 'ban', options: [...] } for "/mod ban …". */
export function commandOptions(ctx: CommandContext): { path: string[]; options: CommandOption[] } {
  const path: string[] = [];
  let options = ctx.interaction.data.options ?? [];
  for (;;) {
    const nested = options.find((o) => o.type === 1 || o.type === 2);
    if (!nested) break;
    path.push(nested.name);
    options = nested.options ?? [];
  }
  return { path, options };
}

export function optionValue(options: CommandOption[], name: string): string | number | boolean | undefined {
  return options.find((o) => o.name === name)?.value;
}

export function modalValues(ctx: ModalContext): ModalValues {
  return new ModalValues(ctx.interaction.data);
}

/** Selected values of a select menu component interaction. */
export function selectedValues(ctx: ComponentContext): string[] {
  return ctx.interaction.data.component_type === ComponentType.Button ? [] : (ctx.interaction.data.values ?? []);
}
