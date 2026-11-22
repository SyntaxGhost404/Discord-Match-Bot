// Profile media: photos/videos attached during onboarding or /profile
// edits. Uploads arrive through the File Upload component (type 19) inside
// the wizard's media modal; the submit carries resolved attachment objects
// and we download the bytes to data/media/<userId>/ so profile cards can
// re-attach them later (CDN URLs expire, local files do not).
//
// Media entries stored on the profile look like:
//   { file, name, type, size }
// where `file` is the on-disk filename inside the user's media directory.

import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config.js';
import { logger, safeFilename } from '../util.js';
import { sniffCategory } from '../services/attachments.js';
import { escapeMarkdown } from './embeds.js';

export const MAX_PROFILE_MEDIA = 6;
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

const IMAGE_EXT = new Set(['png', 'gif', 'jpg', 'jpeg', 'jfif', 'webp', 'avif']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'qt', 'webm']);

/** True when a modal-submit attachment is a photo or a video. */
export function isMediaAttachment(att) {
  const ct = String(att?.content_type || '').toLowerCase();
  const ext = String(att?.filename || '').split('.').pop().toLowerCase();
  return ct.startsWith('image/') || ct.startsWith('video/')
    || IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext);
}

function userMediaDir(userId) {
  return path.join(paths.mediaDir, String(userId));
}

/** Wipe every stored media file for a user (replace-all and restart paths). */
export function clearProfileMedia(userId) {
  try {
    fs.rmSync(userMediaDir(userId), { recursive: true, force: true });
  } catch (err) {
    logger.warn(`clearProfileMedia(${userId}) failed: ${err.message}`);
  }
}

/**
 * Validate + download the uploads from a media modal submit.
 * Returns { ok, media } or { ok: false, error }.
 *
 * Safety properties:
 *  - Every file's bytes are magic-byte sniffed (sniffCategory) after
 *    download: only real photos/videos are accepted, never whatever the
 *    declared content_type or extension claims. Executables served as
 *    `photo.mp4` are rejected here, before they can reach a /share card.
 *  - The 20 MB per-file cap is absolute: Discord's declared attachment size
 *    limit (Nitro contexts) never raises it, and the response body is read
 *    through a bounded reader that aborts past the cap.
 *  - Downloads land in a temp directory that is swapped into place ONLY on
 *    full success. A mid-loop failure leaves the existing media directory
 *    and the profile's media entries untouched, so a failed re-upload can
 *    never destroy the live gallery.
 *  - A per-user in-flight guard rejects a second concurrent submit, so two
 *    interleaved uploads cannot orphan each other's files.
 */
export async function downloadProfileMedia(userId, ids, attachments, sizeLimit) {
  const list = Array.isArray(ids) ? ids : [];
  if (!list.length || list.length > MAX_PROFILE_MEDIA) {
    return { ok: false, error: `Please add between 1 and ${MAX_PROFILE_MEDIA} photos or videos.` };
  }
  // Discord's declared limit can exceed our own cap (Nitro); ours wins.
  const declared = Number(sizeLimit) > 0 ? Number(sizeLimit) : MAX_MEDIA_BYTES;
  const limit = Math.min(declared, MAX_MEDIA_BYTES);

  const key = String(userId);
  if (inflightMediaDownloads.has(key)) {
    return { ok: false, error: 'Your photos are still uploading. Wait a moment, then try again.' };
  }
  inflightMediaDownloads.add(key);
  try {
    return await downloadProfileMediaInner(userId, list, attachments, limit);
  } finally {
    inflightMediaDownloads.delete(key);
  }
}

// Users with a download currently running. The second of two concurrent
// modal submits for the same user is rejected instead of interleaving its
// temp-dir wipe with the first submit's writes (orphaned files).
const inflightMediaDownloads = new Set();

async function downloadProfileMediaInner(userId, list, attachments, limit) {
  const tmpDir = path.join(paths.mediaDir, `${String(userId)}.tmp-${process.pid}`);
  const discard = () => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  const fail = (error) => { discard(); return { ok: false, error }; };

  discard();
  fs.mkdirSync(tmpDir, { recursive: true });

  const media = [];
  for (const attId of list) {
    const att = attachments?.[attId];
    const label = `\`${escapeMarkdown(att?.filename || 'a file')}\``;
    if (!att?.url) {
      return fail("One of your uploads didn't come through. Try again?");
    }
    if (!isMediaAttachment(att)) {
      return fail(`${label} doesn't look like a photo or video. Images and videos only, please.`);
    }
    if ((att.size || 0) > limit) {
      return fail(`${label} is too big (max ${(limit / 1024 / 1024).toFixed(0)} MB).`);
    }
    try {
      const res = await fetch(att.url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await readBodyBounded(res, limit);
      const sniffed = sniffCategory(buf);
      if (sniffed !== 'photo' && sniffed !== 'video' && sniffed !== 'av-container') {
        return fail(`${label} doesn't look like a real photo or video. Please upload the actual file.`);
      }
      const file = `${attId}_${safeFilename(att.filename || 'upload')}`;
      fs.writeFileSync(path.join(tmpDir, file), buf);
      media.push({
        file,
        name: att.filename || 'upload',
        type: (att.content_type || 'application/octet-stream').toLowerCase(),
        size: buf.length,
      });
    } catch (err) {
      logger.warn(`media download failed for ${userId}: ${err.message}`);
      if (err && err.tooLarge) {
        return fail(`${label} is too big (max ${(limit / 1024 / 1024).toFixed(0)} MB).`);
      }
      return fail("We couldn't fetch one of your uploads. Try again?");
    }
  }

  // Full success: swap the temp dir into place via a backup rename, so the
  // live gallery is never destroyed by a mid-swap failure:
  //   1. rename the live dir aside to <dir>.bak-<pid> (a crash after this
  //      leaves the old photos intact and recoverable under .bak-<pid>);
  //   2. rename the temp dir into place (no destructive rm of the live dir
  //      is needed first: renameSync onto a non-existent path cannot fail
  //      ENOTEMPTY);
  //   3. best-effort delete of the backup.
  // Everything before this point touched only the temp dir, and the whole
  // swap returns a normal fail() result on error instead of throwing, so a
  // crash/EACCES/ENOSPC here can never leave the interaction stuck on
  // "thinking" with a half-gone gallery.
  const dir = userMediaDir(userId);
  const bakDir = `${dir}.bak-${process.pid}`;
  try {
    try { fs.rmSync(bakDir, { recursive: true, force: true }); } catch { /* stale backup */ }
    if (fs.existsSync(dir)) fs.renameSync(dir, bakDir);
    fs.renameSync(tmpDir, dir);
    try { fs.rmSync(bakDir, { recursive: true, force: true }); } catch { /* best effort */ }
  } catch (err) {
    logger.warn(`media swap failed for ${userId}: ${err.message}`);
    // Best effort: put the old gallery back if we moved it aside.
    try {
      if (fs.existsSync(bakDir) && !fs.existsSync(dir)) fs.renameSync(bakDir, dir);
    } catch { /* best effort */ }
    return fail("We couldn't save your uploads. Your existing photos are unchanged; try again?");
  }
  return { ok: true, media };
}

/**
 * Read a fetch response body, aborting as soon as more than `limit` bytes
 * arrive. Prefers the streaming reader (real fetch); falls back to a
 * post-hoc length check for mocks/clients without a body stream.
 */
export async function readBodyBounded(res, limit) {
  const tooLarge = () => {
    const err = new Error('body exceeds limit');
    err.tooLarge = true;
    return err;
  };
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > limit) throw tooLarge();
    return buf;
  }
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw tooLarge();
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    try { await reader.cancel(); } catch { /* best effort */ }
  }
  return Buffer.concat(chunks, total);
}

/**
 * Load a profile's stored media files for sending: returns
 * [{ filename, data, contentType }] ready for the REST file payload.
 * Missing files are skipped silently (the entry is left on the profile).
 */
export function loadProfileMediaFiles(profile) {
  const dir = userMediaDir(profile?.id);
  const out = [];
  for (const m of (profile?.media || [])) {
    try {
      const data = fs.readFileSync(path.join(dir, m.file));
      out.push({ filename: m.file, data, contentType: m.type || 'application/octet-stream' });
    } catch {
      // File vanished; the gallery simply shows fewer items.
    }
  }
  return out;
}

/**
 * Components-V2 MediaGallery items for already-uploaded files, using
 * attachment:// references (the caller attaches the same files).
 */
export function mediaGalleryItems(files) {
  return files.slice(0, 10).map((f) => ({ media: { url: `attachment://${f.filename}` } }));
}
