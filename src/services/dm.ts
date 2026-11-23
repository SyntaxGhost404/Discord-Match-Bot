// Sends direct messages to users and classifies every failure, so features
// can react precisely (closed DMs, content blocked for a recipient, …).

import { JsonErrorCode } from '../discord/constants.ts';
import type { DiscordApi } from '../discord/rest/api.ts';
import { DiscordApiError, isApiError } from '../discord/rest/errors.ts';
import type { FileUpload, Message, MessagePayload } from '../discord/types.ts';
import type { Store } from '../db/store.ts';
import type { Logger } from '../util/logger.ts';

/**
 * dm_closed: the user disabled DMs or blocked the bot (50007).
 * no_mutual_guild: bots can only DM people who share a server with them (50278).
 */
export type DmFailure = 'dm_closed' | 'no_mutual_guild' | 'blocked_content' | 'unknown_user' | 'rate_limited' | 'error';

export type DmResult = { ok: true; message: Message; channelId: string } | { ok: false; reason: DmFailure; error?: unknown };

export class DirectMessenger {
  private readonly api: DiscordApi;
  private readonly store: Store;
  private readonly log: Logger;

  constructor(api: DiscordApi, store: Store, log: Logger) {
    this.api = api;
    this.store = store;
    this.log = log.child({ component: 'dm' });
  }

  /** The DM channel id with a user (cached in the database). */
  async channelFor(userId: string, refresh = false): Promise<string | null> {
    const user = this.store.users.get(userId);
    if (user?.dmChannelId && !refresh) return user.dmChannelId;
    try {
      const channel = await this.api.createDm(userId);
      this.store.users.ensure(userId, Date.now());
      this.store.users.setDm(userId, channel.id, user?.dmStatus ?? 'unknown');
      return channel.id;
    } catch (error) {
      this.log.warn('Could not open a DM channel', { userId, error: describe(error) });
      return null;
    }
  }

  async send(userId: string, payload: MessagePayload, files?: FileUpload[]): Promise<DmResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const channelId = await this.channelFor(userId, attempt > 0);
      if (!channelId) return { ok: false, reason: 'unknown_user' };
      try {
        const message = await this.api.createMessage(channelId, payload, files);
        if (this.store.users.get(userId)?.dmStatus !== 'ok') this.store.users.setDmStatus(userId, 'ok');
        return { ok: true, message, channelId };
      } catch (error) {
        const reason = classify(error);
        if (reason === 'stale_channel' && attempt === 0) continue;
        if (reason === 'dm_closed' || reason === 'no_mutual_guild') this.store.users.setDmStatus(userId, 'closed');
        if (reason !== 'dm_closed' && reason !== 'no_mutual_guild' && reason !== 'blocked_content') {
          this.log.warn('Direct message failed', { userId, error: describe(error) });
        }
        return { ok: false, reason: reason === 'stale_channel' ? 'error' : reason, error };
      }
    }
    return { ok: false, reason: 'error' };
  }

  /** Edits a message in a DM channel; false if it no longer exists. */
  async edit(channelId: string, messageId: string, payload: MessagePayload): Promise<boolean> {
    try {
      await this.api.editMessage(channelId, messageId, payload);
      return true;
    } catch (error) {
      if (!isApiError(error, JsonErrorCode.UnknownMessage, JsonErrorCode.UnknownChannel)) {
        this.log.warn('Could not edit a DM message', { channelId, messageId, error: describe(error) });
      }
      return false;
    }
  }

  async delete(channelId: string, messageId: string): Promise<boolean> {
    try {
      await this.api.deleteMessage(channelId, messageId);
      return true;
    } catch (error) {
      if (!isApiError(error, JsonErrorCode.UnknownMessage, JsonErrorCode.UnknownChannel)) {
        this.log.warn('Could not delete a DM message', { channelId, messageId, error: describe(error) });
      }
      return false;
    }
  }
}

function classify(error: unknown): DmFailure | 'stale_channel' {
  if (!(error instanceof DiscordApiError)) return 'error';
  switch (error.code) {
    case JsonErrorCode.CannotSendMessagesToUser:
      return 'dm_closed';
    case JsonErrorCode.NoMutualGuilds:
      return 'no_mutual_guild';
    case JsonErrorCode.ExplicitContentBlocked:
      return 'blocked_content';
    case JsonErrorCode.UnknownUser:
      return 'unknown_user';
    case JsonErrorCode.UnknownChannel:
      return 'stale_channel';
    case JsonErrorCode.OpeningDmsTooFast:
      return 'rate_limited';
    default:
      if (error.status === 429) return 'rate_limited';
      return 'error';
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
