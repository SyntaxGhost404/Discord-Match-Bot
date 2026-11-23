// Image type sniffing and metadata removal, in plain JavaScript.
//
// File extensions and MIME types are client-declared and can lie, so photos
// are identified by their magic bytes. Metadata (EXIF — which can include GPS
// coordinates — XMP, IPTC, comments, text chunks) is stripped from JPEG, PNG
// and WebP before anything is uploaded, protecting users' privacy.

export type ImageKind = 'jpeg' | 'png' | 'gif' | 'webp' | 'avif';

export const IMAGE_EXTENSIONS: Record<ImageKind, string> = { jpeg: 'jpg', png: 'png', gif: 'gif', webp: 'webp', avif: 'avif' };
export const IMAGE_MIME: Record<ImageKind, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
};

const ascii = (bytes: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...bytes.subarray(start, start + length));

export function sniffImage(bytes: Uint8Array): ImageKind | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG' && bytes[4] === 0x0d && bytes[5] === 0x0a) return 'png';
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (brand === 'avif' || brand === 'avis') return 'avif';
  }
  return null;
}

/** Returns a copy without metadata (or the input unchanged if unsupported/malformed). */
export function stripImageMetadata(bytes: Uint8Array, kind: ImageKind): Uint8Array {
  try {
    if (kind === 'jpeg') return stripJpeg(bytes);
    if (kind === 'png') return stripPng(bytes);
    if (kind === 'webp') return stripWebp(bytes);
  } catch {
    // Malformed structure: fall through and keep the original bytes.
  }
  return bytes;
}

// JPEG: drop APP1 (EXIF / XMP), APP13 (IPTC/Photoshop) and COM segments.
function stripJpeg(bytes: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [bytes.subarray(0, 2)];
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) {
      out.push(bytes.subarray(i));
      break;
    }
    let j = i;
    while (bytes[j + 1] === 0xff) j++; // fill bytes
    const marker = bytes[j + 1]!;
    if (marker === 0xd9 || marker === 0xda) {
      // EOI, or start of scan: the rest is entropy-coded image data.
      out.push(bytes.subarray(j));
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(bytes.subarray(j, j + 2));
      i = j + 2;
      continue;
    }
    const length = (bytes[j + 2]! << 8) | bytes[j + 3]!;
    if (length < 2 || j + 2 + length > bytes.length) throw new Error('bad jpeg segment');
    const end = j + 2 + length;
    if (marker !== 0xe1 && marker !== 0xed && marker !== 0xfe) out.push(bytes.subarray(j, end));
    i = end;
  }
  return concat(out);
}

const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

// PNG: drop textual and EXIF chunks; image data chunks are untouched.
function stripPng(bytes: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [bytes.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= bytes.length) {
    const length = ((bytes[i]! << 24) >>> 0) + (bytes[i + 1]! << 16) + (bytes[i + 2]! << 8) + bytes[i + 3]!;
    const type = ascii(bytes, i + 4, 4);
    const end = i + 12 + length;
    if (end > bytes.length) throw new Error('bad png chunk');
    if (!PNG_DROP.has(type)) out.push(bytes.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return concat(out);
}

// WebP: drop EXIF and XMP chunks and clear their bits in the VP8X header.
function stripWebp(bytes: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let i = 12;
  while (i + 8 <= bytes.length) {
    const type = ascii(bytes, i, 4);
    const size = bytes[i + 4]! | (bytes[i + 5]! << 8) | (bytes[i + 6]! << 16) | ((bytes[i + 7]! << 24) >>> 0);
    const end = i + 8 + size + (size % 2);
    if (i + 8 + size > bytes.length) throw new Error('bad webp chunk');
    if (type !== 'EXIF' && type !== 'XMP ') {
      const chunk = bytes.slice(i, Math.min(end, bytes.length));
      if (type === 'VP8X' && chunk.length > 8) chunk[8] = chunk[8]! & ~0x0c; // clear EXIF (0x08) and XMP (0x04) flags
      chunks.push(chunk);
    }
    i = end;
  }
  const body = concat(chunks);
  const header = new Uint8Array(12);
  header.set(bytes.subarray(0, 12));
  const riffSize = body.length + 4;
  header[4] = riffSize & 0xff;
  header[5] = (riffSize >> 8) & 0xff;
  header[6] = (riffSize >> 16) & 0xff;
  header[7] = (riffSize >>> 24) & 0xff;
  return concat([header, body]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
