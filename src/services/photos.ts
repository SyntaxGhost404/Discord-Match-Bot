// Profile photo pipeline.
//
//   File Upload modal → validate size/type → download (bounded) → sniff magic
//   bytes → strip metadata → upload ONCE to a storage channel → keep the
//   attachment ids → render anywhere via the unsigned CDN URL (Discord signs
//   it automatically when it appears in components).
//
// Storage is MEDIA_CHANNEL_ID when configured (a private channel only the bot
// can see), otherwise the user's own DM with the bot. Discord's content
// scanning flags (explicit / gore / self-harm) are checked on upload and on
// every later MESSAGE_UPDATE of a storage message.

import { MessageFlags, UNSAFE_ATTACHMENT_FLAGS } from '../discord/constants.ts';
import type { DiscordApi } from '../discord/rest/api.ts';
import type { Attachment, FileUpload, Message } from '../discord/types.ts';
import type { Store } from '../db/store.ts';
import type { NewPhoto } from '../db/repos/social.ts';
import type { Photo } from '../domain/profile.ts';
import type { DirectMessenger } from './dm.ts';
import { downloadLimited, DownloadError } from './download.ts';
import { IMAGE_EXTENSIONS, IMAGE_MIME, sniffImage, stripImageMetadata } from './images.ts';
import type { Logger } from '../util/logger.ts';

export type PhotoProblem = 'none' | 'too_many' | 'too_large' | 'not_image' | 'download_failed' | 'flagged' | 'no_storage' | 'upload_failed';
export type IngestResult = { ok: true; photos: NewPhoto[] } | { ok: false; problem: PhotoProblem };

const MAX_REQUEST_BYTES = 24 * 1024 * 1024; // Discord's request cap is 25 MiB
const MAX_FILES_PER_MESSAGE = 10;

export interface PhotoServiceOptions {
  api: DiscordApi;
  dm: DirectMessenger;
  store: Store;
  log: Logger;
  storageChannelId: string | null;
  maxPhotos: number;
  maxPhotoBytes: number;
  fetch?: typeof fetch;
}

export class PhotoService {
  private readonly options: PhotoServiceOptions;
  private readonly log: Logger;

  constructor(options: PhotoServiceOptions) {
    this.options = options;
    this.log = options.log.child({ component: 'photos' });
  }

  async ingest(userId: string, attachments: Attachment[]): Promise<IngestResult> {
    const { maxPhotos, maxPhotoBytes } = this.options;
    if (!attachments.length) return { ok: false, problem: 'none' };
    if (attachments.length > maxPhotos) return { ok: false, problem: 'too_many' };
    for (const attachment of attachments) {
      if (attachment.size > maxPhotoBytes) return { ok: false, problem: 'too_large' };
      if (attachment.content_type && !attachment.content_type.startsWith('image/')) return { ok: false, problem: 'not_image' };
    }

    const files: FileUpload[] = [];
    for (const [index, attachment] of attachments.entries()) {
      let bytes: Uint8Array;
      try {
        bytes = await downloadLimited(attachment.url, maxPhotoBytes, { fetch: this.options.fetch });
      } catch (error) {
        if (error instanceof DownloadError && error.kind === 'too_large') return { ok: false, problem: 'too_large' };
        this.log.warn('Photo download failed', { userId, error });
        return { ok: false, problem: 'download_failed' };
      }
      const kind = sniffImage(bytes);
      if (!kind) return { ok: false, problem: 'not_image' };
      files.push({ name: `photo-${index + 1}.${IMAGE_EXTENSIONS[kind]}`, data: stripImageMetadata(bytes, kind), contentType: IMAGE_MIME[kind] });
    }

    const channelId = this.options.storageChannelId ?? (await this.options.dm.channelFor(userId));
    if (!channelId) return { ok: false, problem: 'no_storage' };

    const uploaded: Message[] = [];
    try {
      for (const batch of batches(files)) {
        uploaded.push(await this.upload(channelId, userId, batch));
      }
    } catch (error) {
      this.log.warn('Photo upload failed', { userId, error });
      await this.deleteMessages(uploaded.map((m) => ({ channelId: m.channel_id, messageId: m.id })));
      return { ok: false, problem: this.options.storageChannelId ? 'upload_failed' : 'no_storage' };
    }

    const photos: NewPhoto[] = [];
    for (const message of uploaded) {
      for (const attachment of message.attachments) {
        if ((attachment.flags ?? 0) & UNSAFE_ATTACHMENT_FLAGS) {
          await this.deleteMessages(uploaded.map((m) => ({ channelId: m.channel_id, messageId: m.id })));
          this.log.info('Rejected a photo flagged by Discord content scanning', { userId });
          return { ok: false, problem: 'flagged' };
        }
        photos.push({
          channelId: message.channel_id,
          messageId: message.id,
          attachmentId: attachment.id,
          filename: attachment.filename,
          contentType: attachment.content_type ?? null,
          width: attachment.width ?? null,
          height: attachment.height ?? null,
          size: attachment.size,
        });
      }
    }
    return { ok: true, photos };
  }

  private upload(channelId: string, userId: string, files: FileUpload[]): Promise<Message> {
    const inDm = !this.options.storageChannelId;
    return this.options.api.createMessage(
      channelId,
      {
        content: inDm
          ? '📸 **Your profile photos.** They are kept here so they can appear on your profile card. Change them anytime with `/profile`.'
          : `Profile photos · user ${userId}`,
        attachments: files.map((file, id) => ({ id, filename: file.name })),
        flags: MessageFlags.SuppressNotifications,
        allowed_mentions: { parse: [] },
      },
      files,
    );
  }

  /** Deletes the storage messages that held these photos (after a replacement). */
  async discard(photos: Photo[]): Promise<void> {
    const unique = new Map<string, { channelId: string; messageId: string }>();
    for (const photo of photos) unique.set(photo.messageId, { channelId: photo.channelId, messageId: photo.messageId });
    await this.deleteMessages([...unique.values()]);
  }

  private async deleteMessages(messages: Array<{ channelId: string; messageId: string }>): Promise<void> {
    for (const { channelId, messageId } of messages) {
      await this.options.dm.delete(channelId, messageId);
    }
  }

  /**
   * Content scanning can finish after upload; Discord then sends a
   * MESSAGE_UPDATE with CONTAINS_* flags. Flagged photos are hidden at once.
   */
  handleMessageUpdate(message: Pick<Message, 'id' | 'attachments'>): Photo[] {
    const flaggedIds = (message.attachments ?? []).filter((a) => (a.flags ?? 0) & UNSAFE_ATTACHMENT_FLAGS).map((a) => a.id);
    if (!flaggedIds.length) return [];
    if (!this.options.store.photos.byMessage(message.id).length) return [];
    const flagged = this.options.store.photos.flag(message.id, flaggedIds);
    if (flagged.length) this.log.info('Hid photos flagged by Discord content scanning', { messageId: message.id, count: flagged.length });
    return flagged;
  }

  /** A storage message disappeared (deleted by a moderator, etc.). */
  handleMessageDelete(messageId: string): Photo[] {
    return this.options.store.photos.removeByMessage(messageId);
  }
}

function batches(files: FileUpload[]): FileUpload[][] {
  const out: FileUpload[][] = [];
  let current: FileUpload[] = [];
  let size = 0;
  for (const file of files) {
    if (current.length && (current.length >= MAX_FILES_PER_MESSAGE || size + file.data.length > MAX_REQUEST_BYTES)) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(file);
    size += file.data.length;
  }
  if (current.length) out.push(current);
  return out;
}
