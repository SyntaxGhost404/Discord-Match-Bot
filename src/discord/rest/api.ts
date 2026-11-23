// Typed wrappers for the REST endpoints the bot uses. Each method maps 1:1 to
// an endpoint in the official API reference.

import type { RestClient } from './client.ts';
import type {
  Application,
  Channel,
  CommandDefinition,
  FileUpload,
  GatewayBotInfo,
  InteractionCallbackResponse,
  InteractionResponse,
  Message,
  MessagePayload,
  RegisteredCommand,
  Snowflake,
  User,
} from '../types.ts';

export class DiscordApi {
  readonly rest: RestClient;
  /** Set once the application id is known (from config or GET /applications/@me). */
  applicationId: Snowflake;

  constructor(rest: RestClient, applicationId: Snowflake = '') {
    this.rest = rest;
    this.applicationId = applicationId;
  }

  // -- application & gateway ------------------------------------------------

  getCurrentApplication(): Promise<Application> {
    return this.rest.request({ method: 'GET', path: '/applications/@me' });
  }

  getGatewayBot(): Promise<GatewayBotInfo> {
    return this.rest.request({ method: 'GET', path: '/gateway/bot' });
  }

  getCurrentUser(): Promise<User> {
    return this.rest.request({ method: 'GET', path: '/users/@me' });
  }

  getUser(userId: Snowflake): Promise<User> {
    return this.rest.request({ method: 'GET', path: `/users/${userId}` });
  }

  // -- commands --------------------------------------------------------------

  getGlobalCommands(): Promise<RegisteredCommand[]> {
    return this.rest.request({ method: 'GET', path: `/applications/${this.applicationId}/commands` });
  }

  bulkOverwriteGlobalCommands(commands: CommandDefinition[]): Promise<RegisteredCommand[]> {
    return this.rest.request({ method: 'PUT', path: `/applications/${this.applicationId}/commands`, body: commands });
  }

  getGuildCommands(guildId: Snowflake): Promise<RegisteredCommand[]> {
    return this.rest.request({ method: 'GET', path: `/applications/${this.applicationId}/guilds/${guildId}/commands` });
  }

  bulkOverwriteGuildCommands(guildId: Snowflake, commands: CommandDefinition[]): Promise<RegisteredCommand[]> {
    return this.rest.request({
      method: 'PUT',
      path: `/applications/${this.applicationId}/guilds/${guildId}/commands`,
      body: commands,
    });
  }

  // -- interactions ------------------------------------------------------------

  /** POST /interactions/{id}/{token}/callback — the initial response. */
  createInteractionResponse(
    interactionId: Snowflake,
    token: string,
    response: InteractionResponse,
    options: { files?: FileUpload[]; withResponse?: boolean } = {},
  ): Promise<InteractionCallbackResponse | undefined> {
    return this.rest.request({
      method: 'POST',
      path: `/interactions/${interactionId}/${token}/callback`,
      query: options.withResponse ? { with_response: true } : undefined,
      body: response,
      files: options.files,
      auth: false,
      timeoutMs: 6_000,
      maxRateLimitWaitMs: 1_000,
    });
  }

  editOriginalResponse(token: string, payload: MessagePayload, files?: FileUpload[]): Promise<Message> {
    return this.rest.request({
      method: 'PATCH',
      path: `/webhooks/${this.applicationId}/${token}/messages/@original`,
      body: payload,
      files,
      auth: false,
    });
  }

  deleteOriginalResponse(token: string): Promise<void> {
    return this.rest.request({ method: 'DELETE', path: `/webhooks/${this.applicationId}/${token}/messages/@original`, auth: false });
  }

  createFollowup(token: string, payload: MessagePayload, files?: FileUpload[]): Promise<Message> {
    return this.rest.request({
      method: 'POST',
      path: `/webhooks/${this.applicationId}/${token}`,
      body: payload,
      files,
      auth: false,
    });
  }

  // -- channels & messages --------------------------------------------------------

  /** POST /users/@me/channels — opens (or returns) the DM channel with a user. */
  createDm(userId: Snowflake): Promise<Channel> {
    return this.rest.request({ method: 'POST', path: '/users/@me/channels', body: { recipient_id: userId }, idempotent: true });
  }

  getChannel(channelId: Snowflake): Promise<Channel> {
    return this.rest.request({ method: 'GET', path: `/channels/${channelId}` });
  }

  getMessage(channelId: Snowflake, messageId: Snowflake): Promise<Message> {
    return this.rest.request({ method: 'GET', path: `/channels/${channelId}/messages/${messageId}` });
  }

  getMessages(channelId: Snowflake, query: { after?: Snowflake; before?: Snowflake; limit?: number }): Promise<Message[]> {
    return this.rest.request({ method: 'GET', path: `/channels/${channelId}/messages`, query });
  }

  createMessage(channelId: Snowflake, payload: MessagePayload, files?: FileUpload[]): Promise<Message> {
    return this.rest.request({
      method: 'POST',
      path: `/channels/${channelId}/messages`,
      body: payload,
      files,
      // Retrying a create is only safe when Discord dedupes it by nonce.
      idempotent: payload.enforce_nonce === true && typeof payload.nonce === 'string',
      timeoutMs: files?.length ? 60_000 : 15_000,
    });
  }

  editMessage(channelId: Snowflake, messageId: Snowflake, payload: MessagePayload, files?: FileUpload[]): Promise<Message> {
    return this.rest.request({ method: 'PATCH', path: `/channels/${channelId}/messages/${messageId}`, body: payload, files });
  }

  deleteMessage(channelId: Snowflake, messageId: Snowflake): Promise<void> {
    return this.rest.request({ method: 'DELETE', path: `/channels/${channelId}/messages/${messageId}` });
  }

  triggerTyping(channelId: Snowflake): Promise<void> {
    return this.rest.request({ method: 'POST', path: `/channels/${channelId}/typing`, idempotent: true });
  }

  addOwnReaction(channelId: Snowflake, messageId: Snowflake, emoji: string): Promise<void> {
    return this.rest.request({
      method: 'PUT',
      path: `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
    });
  }

  removeOwnReaction(channelId: Snowflake, messageId: Snowflake, emoji: string): Promise<void> {
    return this.rest.request({
      method: 'DELETE',
      path: `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
    });
  }
}
