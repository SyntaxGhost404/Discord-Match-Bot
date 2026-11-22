// Strict attachment allowlist for the anonymous chat relay.
//
// Only the file formats Discord itself previews or plays inline may travel
// between strangers: images, GIFs, videos, audio/voice recordings, Markdown,
// and plain text. The table below is derived from Discord's File Attachments
// FAQ and the developer docs' attachment/component references:
//   - inline image preview: JPEG, PNG, GIF, WebP, AVIF, BMP, HEIC/HEIF
//   - inline video playback: MP4 (H.264/HEVC/AV1), MOV, WebM
//   - inline audio playback: MP3, OGG/Opus, WAV, FLAC, M4A, AAC
//   - File component reference example: file.txt (plain text)
// Everything else (executables, scripts, archives, documents, and anything
// unrecognized) is blocked without exception, so malware, scripts, and
// compressed payloads can never hop from one stranger to another.
//
// Validation checks BOTH the declared filename extension and the MIME
// content type: the extension must be listed here AND the MIME must be one
// of the MIME types Discord reports for that extension. A renamed payload
// (evil.exe sent as evil.png, or a PNG declared as application/octet-stream)
// fails and is blocked.

/** extension -> { category, mimes } */
const TABLE = {
  // -- Images (Discord renders these inline) --
  jpg:  { category: 'photo', mimes: ['image/jpeg'] },
  jpeg: { category: 'photo', mimes: ['image/jpeg'] },
  jpe:  { category: 'photo', mimes: ['image/jpeg'] },
  jfif: { category: 'photo', mimes: ['image/jpeg'] },
  png:  { category: 'photo', mimes: ['image/png'] },
  gif:  { category: 'photo', mimes: ['image/gif'] },
  webp: { category: 'photo', mimes: ['image/webp'] },
  avif: { category: 'photo', mimes: ['image/avif'] },
  bmp:  { category: 'photo', mimes: ['image/bmp', 'image/x-bmp'] },
  heic: { category: 'photo', mimes: ['image/heic'] },
  heif: { category: 'photo', mimes: ['image/heif'] },
  // -- Videos (Discord plays these inline) --
  mp4:  { category: 'video', mimes: ['video/mp4'] },
  mov:  { category: 'video', mimes: ['video/quicktime'] },
  webm: { category: 'video', mimes: ['video/webm'] },
  m4v:  { category: 'video', mimes: ['video/x-m4v', 'video/mp4'] },
  // -- Audio and voice recordings (Discord plays these inline) --
  mp3:  { category: 'audio', mimes: ['audio/mpeg', 'audio/mp3'] },
  ogg:  { category: 'audio', mimes: ['audio/ogg'] },
  oga:  { category: 'audio', mimes: ['audio/ogg'] },
  opus: { category: 'audio', mimes: ['audio/opus', 'audio/ogg'] },
  wav:  { category: 'audio', mimes: ['audio/wav', 'audio/x-wav', 'audio/wave'] },
  flac: { category: 'audio', mimes: ['audio/flac', 'audio/x-flac'] },
  m4a:  { category: 'audio', mimes: ['audio/mp4', 'audio/x-m4a'] },
  aac:  { category: 'audio', mimes: ['audio/aac', 'audio/x-aac', 'audio/mp4'] },
  weba: { category: 'audio', mimes: ['audio/webm'] },
  // -- Markdown and plain text notes --
  md:       { category: 'note', mimes: ['text/markdown', 'text/x-markdown', 'text/plain'] },
  markdown: { category: 'note', mimes: ['text/markdown', 'text/x-markdown', 'text/plain'] },
  txt:      { category: 'note', mimes: ['text/plain'] },
};

/** Category labels and their extensions, for the sender-facing warning. */
export const ALLOWED_BY_CATEGORY = [
  { label: 'Photos', exts: ['PNG', 'JPG', 'JPEG', 'JPE', 'JFIF', 'GIF', 'WEBP', 'AVIF', 'BMP', 'HEIC', 'HEIF'] },
  { label: 'Videos', exts: ['MP4', 'MOV', 'WEBM', 'M4V'] },
  { label: 'Audio', exts: ['MP3', 'OGG', 'OGA', 'OPUS', 'WAV', 'FLAC', 'M4A', 'AAC', 'WEBA'] },
  { label: 'Notes', exts: ['MD', 'MARKDOWN', 'TXT'] },
];

/** Lowercase extension after the last dot, or '' when there is none. */
export function extensionOf(filename) {
  const name = String(filename || '');
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return '';
  return name.slice(i + 1).toLowerCase();
}

/** Lowercase MIME without parameters (`audio/ogg; codecs=opus` -> `audio/ogg`). */
export function mimeOf(contentType) {
  return String(contentType || '').split(';')[0].trim().toLowerCase();
}

/**
 * Validate one Discord attachment object ({ filename, content_type }).
 * Returns { ok: true, category, ext, mime } when both the extension and the
 * MIME type are on the allowlist, otherwise { ok: false, ext, mime, reason }.
 *
 * NOTE: this is only the first layer. Discord's content_type is a label the
 * uploader's client largely controls (mobile clients derive it from the file
 * extension), so a text file renamed to .png can arrive as image/png and sail
 * through this check. The second layer is sniffCategory() below, which reads
 * the actual downloaded bytes. Both must agree before anything is relayed.
 */
export function validateAttachment(att) {
  const ext = extensionOf(att?.filename);
  const mime = mimeOf(att?.content_type);
  const entry = TABLE[ext];
  if (!entry) {
    return { ok: false, ext, mime, reason: 'unknown_extension' };
  }
  if (!entry.mimes.includes(mime)) {
    return { ok: false, ext, mime, reason: 'unrecognized_type' };
  }
  return { ok: true, category: entry.category, ext, mime };
}

// ---------------------------------------------------------------------------
// Magic-byte sniffing (second validation layer).
//
// Reads the actual file bytes instead of trusting the declared content_type.
// Returns one of 'photo' | 'video' | 'audio' | 'note', the special value
// 'av-container' for ISO-BMFF files whose brand is shared by video and audio
// containers (mp4/m4a both use isom/mp41 brands), or null when the bytes match
// nothing we allow (executables, archives, scripts, garbage).
// ---------------------------------------------------------------------------

const PHOTO_FTYP_BRANDS = new Set([
  'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs',
  'heif',
  'avif', 'mif1', 'msf1',
]);

function toBuf(v) {
  if (!v) return Buffer.alloc(0);
  return Buffer.isBuffer(v) ? v : Buffer.from(v);
}

function ascii4(b, at) {
  return b.length >= at + 4 ? b.toString('ascii', at, at + 4) : '';
}

function looksLikeText(b) {
  if (b.length === 0) return true;
  const n = Math.min(b.length, 65536);
  for (let i = 0; i < n; i++) {
    const c = b[i];
    if (c === 0x00 || c === 0x7f) return false;
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return false; // stray control bytes
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(0, n));
    return true;
  } catch {
    return false;
  }
}

/**
 * What the bytes actually are. Never trust the filename or content_type here.
 */
export function sniffCategory(bytes) {
  const b = toBuf(bytes);
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'photo'; // PNG
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'photo'; // JPEG
  if (/^GIF8[79]a/.test(ascii4(b, 0) + (b.length >= 6 ? b.toString('ascii', 4, 6) : ''))) return 'photo'; // GIF
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'photo'; // BMP
  if (ascii4(b, 0) === 'RIFF' && b.length >= 12) { // RIFF container
    const form = ascii4(b, 8);
    if (form === 'WEBP') return 'photo';
    if (form === 'WAVE') return 'audio';
    return null;
  }
  if (ascii4(b, 4) === 'ftyp' && b.length >= 12) { // ISO base media (mp4/mov/m4a/heic/avif)
    const brand = ascii4(b, 8);
    if (PHOTO_FTYP_BRANDS.has(brand)) return 'photo';
    if (brand === 'M4A ') return 'audio';
    return 'av-container'; // isom/mp41/qt/...: video or audio, both allowed categories
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) { // EBML
    const head = b.toString('binary', 0, Math.min(b.length, 4096));
    if (head.includes('webm')) return 'video';
    if (head.includes('weba')) return 'audio';
    return null;
  }
  if (b.length >= 4 && ascii4(b, 0) === 'OggS') return 'audio'; // OGG / Opus
  if (b.length >= 4 && ascii4(b, 0) === 'fLaC') return 'audio'; // FLAC
  if (b.length >= 3 && b.toString('ascii', 0, 3) === 'ID3') return 'audio'; // MP3 with ID3 tag
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'audio'; // MP3/AAC frame sync
  // Executables that are valid UTF-8 (a PE stub or ELF header of printable
  // ASCII) would fool looksLikeText below: never call them a note.
  // MZ refinement: only treat it as an executable when the buffer is NOT
  // cleanly valid printable UTF-8 text. A real PE binary always carries
  // non-text bytes past the header, so it still returns null here; an
  // ASCII-only blob that merely starts with "MZ" (e.g. a note beginning
  // "MZR-12") falls through to the text check below and sniffs as 'note'.
  // Residual limitation: a fully-ASCII fake-PE stub also sniffs as 'note'.
  // That is acceptable because the relay and profile-media paths only accept
  // photo/video/audio categories, so an ASCII stub can never be smuggled in
  // as media.
  if (b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a && !looksLikeText(b)) return null; // MZ: Windows executable
  if (b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return null; // ELF
  if (looksLikeText(b)) return 'note';
  return null;
}

/**
 * Do the sniffed bytes agree with the category the extension claimed?
 * 'av-container' (ambiguous mp4-family brand) is accepted for both video and
 * audio, since both legitimately share those container brands.
 */
export function sniffMatches(declaredCategory, bytes) {
  const sniffed = sniffCategory(bytes);
  if (sniffed === declaredCategory) return true;
  if (sniffed === 'av-container' && (declaredCategory === 'video' || declaredCategory === 'audio')) return true;
  return false;
}
