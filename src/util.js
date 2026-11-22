// Tiny logger + shared helpers. No dependencies.

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
let level = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

export function setLogLevel(name) {
  level = LEVELS[String(name || '').toLowerCase()] ?? LEVELS.info;
}

function log(kind, ...args) {
  if ((LEVELS[kind] ?? 99) > level) return;
  const ts = new Date().toISOString();
  const fn = kind === 'error' ? console.error : kind === 'warn' ? console.warn : console.log;
  fn(`[${ts}] [${kind}]`, ...args);
}

export const logger = {
  error: (...a) => log('error', ...a),
  warn: (...a) => log('warn', ...a),
  info: (...a) => log('info', ...a),
  debug: (...a) => log('debug', ...a),
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Jittered exponential backoff: 1s, 2s, 4s, ... capped at 30s. */
export function backoffMs(attempt) {
  const base = Math.min(1000 * 2 ** attempt, 30000);
  return Math.floor(base * (0.5 + Math.random() * 0.5));
}

export const nowIso = () => new Date().toISOString();

/** Strip control characters and trim; keep the message relay-safe. */
export function cleanText(s) {
  return String(s || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}

/** Truncate a string to n chars with an ellipsis. */
export function trunc(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Make a filename safe for multipart upload. */
export function safeFilename(name) {
  return String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) || 'file';
}

/** Split a custom_id on the first ':' -> [head, rest]. */
export function splitCustomId(customId) {
  const s = String(customId || '');
  const i = s.indexOf(':');
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}

/** Loose Discord snowflake check (17-20 digits). */
export function isSnowflake(s) {
  return typeof s === 'string' && /^\d{17,20}$/.test(s);
}
