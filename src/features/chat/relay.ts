// Relays DMs between the two people in an anonymous chat, making the chat
// feel native: replies, edits, deletions, reactions and typing indicators are
// mirrored on the other side.
//
// Events of one DM channel are processed strictly in order. Message content
// in DMs with the bot is available without the privileged MESSAGE_CONTENT
// intent, so the bot needs no privileged intents at all.

import { createHash } from 'node:crypto';
import type { App } from '../../core/app.ts';
import { MessageFlags, MessageReferenceType, MessageType, UNSAFE_ATTACHMENT_FLAGS } from '../../discord/constants.ts';
import type { Attachment, FileUpload, Message, MessageDeleteEvent, MessagePayload, MessageReactionEvent, TypingStartEvent } from '../../discord/types.ts';
import type { ChatSession } from '../../db/repos/chat.ts';
import { partnerOf, sideOf } from '../../db/repos/chat.ts';
import { censorProfanity, stripLinks } from '../../domain/text.ts';
import { downloadLimited } from '../../services/download.ts';
import { Cooldowns, KeyedSerialQueue, SlidingWindowLimiter } from '../../util/async.ts';
import { compareSnowflakes } from '../../util/snowflake.ts';
import { MINUTE } from '../../util/time.ts';
import { chatNotice } from './ui.ts';

const MAX_RELAY_FILE_BYTES = 20 * 1024 * 1024; // default bot upload limit
const MAX_RELAY_TOTAL_BYTES = 24 * 1024 * 1024;
const RELAYABLE_TYPES = /^(image|video|audio)\//;

const hash = (text: string) => createHash('sha1').update(text).digest('hex');

/** Splits text into ≤2000-character chunks, preferring line/word boundaries. */
export function splitContent(text: string, max = 2000): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export class RelayService {
  private readonly app: App;
  private readonly order = new KeyedSerialQueue();
  private readonly spam = new SlidingWindowLimiter(10, 10_000);
  private readonly warnings = new Cooldowns(60_000);
  private readonly typing = new Cooldowns(8_000);

  constructor(app: App) {
    this.app = app;
  }

  onMessageCreate(message: Message): Promise<void> {
    if (message.guild_id || message.author?.bot) return Promise.resolve();
    return this.order.run(message.channel_id, () => this.handleCreate(message, false));
  }

  onMessageUpdate(message: Message): Promise<void> {
    if (message.guild_id) return Promise.resolve();
    return this.order.run(message.channel_id, () => this.handleUpdate(message));
  }

  onMessageDelete(event: MessageDeleteEvent): Promise<void> {
    if (event.guild_id) return Promise.resolve();
    return this.order.run(event.channel_id, () => this.handleDelete(event));
  }

  // -- new messages -------------------------------------------------------------

  private async handleCreate(message: Message, catchUp: boolean): Promise<void> {
    const { store } = this.app;
    const author = message.author;
    if (!author || author.bot || author.system) return;
    if (message.type !== MessageType.Default && message.type !== MessageType.Reply) return;
    const now = this.app.clock();
    store.users.touch(author, null, now);
    const user = store.users.get(author.id);
    if (user && user.dmChannelId !== message.channel_id) store.users.setDm(author.id, message.channel_id, 'ok');

    const session = store.chat.activeFor(author.id);
    if (!session) {
      if (!catchUp) await this.hintIdle(author.id, now);
      return;
    }
    const side = sideOf(session, author.id)!;
    store.chat.advanceCursor(session.id, side, message.id);

    if (store.users.activeBan(author.id, now)) {
      await this.app.chat.end(session.id, 'banned', author.id);
      return;
    }
    if (!catchUp && !this.spam.hit(author.id, now)) {
      if (this.warnings.take(`spam:${author.id}`, now)) await this.notice(author.id, "⏳ You're sending messages very fast — a few weren't delivered. Slow down a little.");
      return;
    }

    const partnerId = partnerOf(session, author.id);
    const partner = store.profiles.get(partnerId);
    const built = await this.build(message, session, author.id, partner?.chatFilter ?? true);
    if (!built) return;

    const dstIds: string[] = [];
    let partnerChannel = '';
    let failure: string | null = null;
    for (const part of built.parts) {
      const result = await this.app.dm.send(partnerId, part.payload, part.files);
      if (result.ok) {
        dstIds.push(result.message.id);
        partnerChannel = result.channelId;
        this.checkDeliveredFlags(result.message, author.id);
      } else {
        failure = result.reason;
        break;
      }
    }

    if (dstIds.length) {
      store.transaction(() => {
        store.chat.addRelay(
          { srcMessageId: message.id, sessionId: session.id, senderId: author.id, srcChannelId: message.channel_id, dstChannelId: partnerChannel, dstMessageIds: dstIds, contentHash: built.textHash },
          now,
        );
        store.chat.recordMessage(session.id, side, now);
      });
    }

    if (failure === 'dm_closed' || failure === 'no_mutual_guild' || failure === 'unknown_user') {
      await this.app.chat.end(session.id, 'undeliverable', partnerId);
    } else if (failure === 'blocked_content') {
      await this.notice(author.id, '🛡️ Discord blocked that message for your partner because it may contain sensitive content, so it was not delivered.');
    } else if (failure) {
      await this.react(message, '⚠️');
      await this.notice(author.id, "⚠️ That message couldn't be delivered. Please try again in a moment.");
    }
  }

  private async build(
    message: Message,
    session: ChatSession,
    senderId: string,
    recipientFilter: boolean,
  ): Promise<{ parts: Array<{ payload: MessagePayload; files?: FileUpload[] }>; textHash: string | null } | null> {
    const isForward = message.message_reference?.type === MessageReferenceType.Forward || ((message.flags ?? 0) & MessageFlags.HasSnapshot) !== 0;
    if (isForward) {
      await this.notice(senderId, "↪️ Forwarded messages can't be relayed in anonymous chat. Copy the text instead.");
      return null;
    }
    if (message.poll) {
      await this.notice(senderId, "📊 Polls can't be relayed in anonymous chat.");
      return null;
    }

    let content = message.content ?? '';
    const stickers = message.sticker_items ?? [];
    if (stickers.length) content = `${content}${content ? '\n' : ''}${stickers.map((s) => `*[sticker: ${s.name}]*`).join(' ')}`;

    const attachments = message.attachments ?? [];
    if (session.teen) {
      if (attachments.length) {
        await this.notice(senderId, '🌱 Only text can be shared in teen chats, so your attachment was not sent.');
        if (!content.trim()) return null;
      }
      const stripped = stripLinks(content);
      if (stripped.removed && this.warnings.take(`links:${session.id}:${senderId}`)) {
        await this.notice(senderId, '🌱 Links are removed in teen chats to keep everyone safe.');
      }
      content = stripped.text;
    }
    if (session.teen || recipientFilter) content = censorProfanity(content).text;

    const reference = this.mapReply(message, session, senderId);
    const textHash = content ? hash(content) : null;
    const parts: Array<{ payload: MessagePayload; files?: FileUpload[] }> = [];
    const base = (text: string | undefined, withReference: boolean): MessagePayload => ({
      ...(text ? { content: text } : {}),
      allowed_mentions: { parse: [] },
      flags: MessageFlags.SuppressEmbeds,
      ...(withReference && reference ? { message_reference: { message_id: reference, fail_if_not_exists: false } } : {}),
    });

    const files = session.teen ? { regular: [] } : await this.collectFiles(attachments, senderId, message);
    if (files === null) return null;

    // Voice messages must be sent alone, with their waveform and duration.
    if (files.voice) {
      parts.push({
        payload: {
          flags: MessageFlags.IsVoiceMessage,
          attachments: [{ id: 0, filename: files.voice.file.name, duration_secs: files.voice.duration, waveform: files.voice.waveform }],
          ...(reference ? { message_reference: { message_id: reference, fail_if_not_exists: false } } : {}),
        },
        files: [files.voice.file],
      });
      return { parts, textHash };
    }

    const chunks = content.trim() ? splitContent(content) : [];
    if (!chunks.length && !files.regular.length) return null;
    if (!chunks.length) chunks.push('');
    chunks.forEach((chunk, i) => {
      const last = i === chunks.length - 1;
      const payload = base(chunk || undefined, i === 0);
      if (last && files.regular.length) {
        payload.attachments = files.regular.map((f, id) => ({ id, filename: f.name }));
        parts.push({ payload, files: files.regular });
      } else {
        parts.push({ payload });
      }
    });
    return { parts, textHash };
  }

  private async collectFiles(
    attachments: Attachment[],
    senderId: string,
    message: Message,
  ): Promise<{ regular: FileUpload[]; voice?: { file: FileUpload; duration: number; waveform: string } } | null> {
    if (!attachments.length) return { regular: [] };
    if (attachments.some((a) => (a.flags ?? 0) & UNSAFE_ATTACHMENT_FLAGS)) {
      await this.notice(senderId, "🛡️ Discord's safety filter flagged that file, so it wasn't sent.");
      return null;
    }
    const unsupported = attachments.filter((a) => !RELAYABLE_TYPES.test(a.content_type ?? ''));
    if (unsupported.length) {
      await this.notice(senderId, '📎 Only photos, videos and audio can be shared in anonymous chat. Your message was not sent.');
      return null;
    }
    const total = attachments.reduce((n, a) => n + a.size, 0);
    if (attachments.some((a) => a.size > MAX_RELAY_FILE_BYTES) || total > MAX_RELAY_TOTAL_BYTES) {
      await this.notice(senderId, '📦 That file is too large to relay (20 MB per message at most).');
      return null;
    }
    const files: FileUpload[] = [];
    for (const [index, attachment] of attachments.entries()) {
      try {
        const data = await downloadLimited(attachment.url, MAX_RELAY_FILE_BYTES, { fetch: this.app.fetch });
        const ext = (attachment.filename.match(/\.([a-z0-9]{1,5})$/i)?.[1] ?? 'bin').toLowerCase();
        // Neutral names: original file names can reveal identities.
        files.push({ name: `${attachment.content_type?.split('/')[0] ?? 'file'}-${index + 1}.${ext}`, data, contentType: attachment.content_type });
      } catch (error) {
        this.app.log.warn('Could not download an attachment to relay', { error });
        await this.notice(senderId, "⚠️ I couldn't fetch your attachment from Discord, so the message wasn't sent. Please try again.");
        return null;
      }
    }
    const first = attachments[0]!;
    const isVoice = ((message.flags ?? 0) & MessageFlags.IsVoiceMessage) !== 0 && attachments.length === 1;
    if (isVoice && first.waveform && first.duration_secs !== undefined) {
      return { regular: [], voice: { file: { ...files[0]!, name: 'voice-message.ogg' }, duration: first.duration_secs, waveform: first.waveform } };
    }
    return { regular: files };
  }

  /** Maps a reply target in the sender's DM to the matching message in the partner's DM. */
  private mapReply(message: Message, session: ChatSession, senderId: string): string | null {
    const target = message.message_reference?.message_id;
    if (!target) return null;
    const { chat } = this.app.store;
    // Replying to the partner's message (a copy in my DM) → their original.
    const copy = chat.relayByCopy(target);
    if (copy && copy.sessionId === session.id && copy.senderId !== senderId) return copy.srcMessageId;
    // Replying to my own message → its copy in the partner's DM.
    const own = chat.relayBySource(target);
    if (own && own.sessionId === session.id && own.senderId === senderId) return own.dstMessageIds[0] ?? null;
    return null;
  }

  // -- edits, content scanning, deletes ------------------------------------------------

  private async handleUpdate(message: Message): Promise<void> {
    const { store } = this.app;
    // A copy we delivered was flagged by content scanning after the fact.
    if (message.author?.bot) {
      if ((message.attachments ?? []).some((a) => (a.flags ?? 0) & UNSAFE_ATTACHMENT_FLAGS)) {
        const relay = store.chat.relayByCopy(message.id);
        if (relay) await this.retract(relay.srcMessageId, relay.senderId, true);
      }
      return;
    }
    const relay = store.chat.relayBySource(message.id);
    if (!relay) return;
    if ((message.attachments ?? []).some((a) => (a.flags ?? 0) & UNSAFE_ATTACHMENT_FLAGS)) {
      await this.retract(relay.srcMessageId, relay.senderId, true);
      return;
    }
    const session = store.chat.activeFor(relay.senderId);
    if (!session || session.id !== relay.sessionId || typeof message.content !== 'string') return;
    const partner = store.profiles.get(partnerOf(session, relay.senderId));
    let content = session.teen ? stripLinks(message.content).text : message.content;
    if (session.teen || (partner?.chatFilter ?? true)) content = censorProfanity(content).text;
    const textHash = content ? hash(content) : null;
    if (textHash === relay.contentHash || !content.trim()) return;

    const chunks = splitContent(content);
    const kept: string[] = [];
    for (const [i, dstId] of relay.dstMessageIds.entries()) {
      const chunk = chunks[i];
      if (chunk === undefined && i > 0) {
        await this.app.dm.delete(relay.dstChannelId, dstId);
        continue;
      }
      const ok = await this.app.dm.edit(relay.dstChannelId, dstId, { content: chunk ?? '', allowed_mentions: { parse: [] } });
      if (ok) kept.push(dstId);
    }
    store.chat.updateRelay(relay.srcMessageId, kept, textHash);
  }

  private async handleDelete(event: MessageDeleteEvent): Promise<void> {
    const relay = this.app.store.chat.relayBySource(event.id);
    if (relay) await this.retract(relay.srcMessageId, relay.senderId, false);
  }

  /** Removes every delivered copy of a message (unsend, or unsafe content). */
  private async retract(srcMessageId: string, senderId: string, unsafe: boolean): Promise<void> {
    const relay = this.app.store.chat.relayBySource(srcMessageId);
    if (!relay) return;
    for (const dstId of relay.dstMessageIds) await this.app.dm.delete(relay.dstChannelId, dstId);
    this.app.store.chat.deleteRelay(srcMessageId);
    if (unsafe) await this.notice(senderId, "🛡️ Discord's safety filter flagged something you sent, so it was removed from the chat.");
  }

  private checkDeliveredFlags(sent: Message, senderId: string): void {
    if ((sent.attachments ?? []).some((a) => (a.flags ?? 0) & UNSAFE_ATTACHMENT_FLAGS)) {
      void this.app.dm.delete(sent.channel_id, sent.id).then(() => this.notice(senderId, "🛡️ Discord's safety filter flagged that file, so it was removed."));
    }
  }

  // -- typing & reactions ----------------------------------------------------------------

  async onTyping(event: TypingStartEvent): Promise<void> {
    if (event.guild_id) return;
    const session = this.app.store.chat.activeFor(event.user_id);
    if (!session || !this.typing.take(event.user_id)) return;
    const partnerChannel = this.app.store.users.get(partnerOf(session, event.user_id))?.dmChannelId;
    if (!partnerChannel) return;
    await this.app.api.triggerTyping(partnerChannel).catch(() => {});
  }

  async onReaction(event: MessageReactionEvent, added: boolean): Promise<void> {
    if (event.guild_id || event.user_id === this.app.info.id) return;
    const emoji = event.emoji;
    if (!emoji?.name || emoji.id) return; // custom emoji may not be usable by the bot
    const session = this.app.store.chat.activeFor(event.user_id);
    if (!session) return;
    const { chat } = this.app.store;
    let target: { channelId: string; messageId: string } | null = null;
    const copy = chat.relayByCopy(event.message_id);
    if (copy && copy.sessionId === session.id && copy.senderId !== event.user_id) target = { channelId: copy.srcChannelId, messageId: copy.srcMessageId };
    const own = !target ? chat.relayBySource(event.message_id) : null;
    if (own && own.sessionId === session.id && own.senderId === event.user_id && own.dstMessageIds[0]) {
      target = { channelId: own.dstChannelId, messageId: own.dstMessageIds[0] };
    }
    if (!target) return;
    const call = added ? this.app.api.addOwnReaction(target.channelId, target.messageId, emoji.name) : this.app.api.removeOwnReaction(target.channelId, target.messageId, emoji.name);
    await call.catch((error) => this.app.log.debug('Reaction mirror failed', { error }));
  }

  // -- catch-up after downtime ----------------------------------------------------------------

  /** Relays messages people sent while the bot was offline (called on a fresh READY). */
  async catchUp(): Promise<void> {
    const { store } = this.app;
    for (const session of store.chat.allActive()) {
      for (const side of ['a', 'b'] as const) {
        const userId = side === 'a' ? session.userA : session.userB;
        const cursor = side === 'a' ? session.aCursor : session.bCursor;
        const channelId = store.users.get(userId)?.dmChannelId;
        if (!channelId || !cursor) continue;
        let messages: Message[];
        try {
          messages = await this.app.api.getMessages(channelId, { after: cursor, limit: 50 });
        } catch (error) {
          this.app.log.warn('Catch-up fetch failed', { session: session.id, error });
          continue;
        }
        const pending = messages.filter((m) => m.author?.id === userId).sort((x, y) => compareSnowflakes(x.id, y.id));
        for (const message of pending) {
          await this.order.run(channelId, () => this.handleCreate(message, true));
        }
        if (pending.length) this.app.log.info('Relayed messages sent while offline', { session: session.id, count: pending.length });
      }
    }
  }

  // -- helpers ----------------------------------------------------------------------------

  private async hintIdle(userId: string, now: number): Promise<void> {
    const { store } = this.app;
    const user = store.users.get(userId);
    if (user?.chatHintAt && now - user.chatHintAt < 10 * MINUTE) return;
    store.users.setChatHintAt(userId, now);
    const queued = store.chat.queueEntry(userId);
    await this.notice(
      userId,
      queued
        ? "🔎 Still looking for a partner — messages are only delivered once you're connected."
        : "💡 You're not in an anonymous chat right now. Use `/chat` to start one, or `/start` for the menu.",
    );
  }

  private async notice(userId: string, body: string): Promise<void> {
    await this.app.dm.send(userId, chatNotice(body));
  }

  private async react(message: Message, emoji: string): Promise<void> {
    await this.app.api.addOwnReaction(message.channel_id, message.id, emoji).catch(() => {});
  }
}
