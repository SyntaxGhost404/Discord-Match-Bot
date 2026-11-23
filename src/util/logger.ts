// Small structured logger. Pretty, human-friendly lines on a TTY; one JSON
// object per line otherwise (or when LOG_FORMAT=json), which log shippers love.
//
// Anything that looks like a Discord bot token is redacted from every message
// and field, so a stray `log.error(err)` can never leak credentials.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const TOKEN_PATTERN = /[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}/g;
const COLORS: Record<LogLevel, string> = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';

export function redact(text: string): string {
  return text.replace(TOKEN_PATTERN, '[redacted-token]');
}

/** Turns errors (and their causes) into plain, JSON-safe objects. */
export function serializeError(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error)) return error;
  const out: Record<string, unknown> = { name: error.name, message: error.message };
  for (const key of ['code', 'status', 'method', 'path'] as const) {
    const value = (error as unknown as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  if (error.stack) out.stack = error.stack.split('\n').slice(0, 8).join('\n');
  if (error.cause !== undefined && depth < 3) out.cause = serializeError(error.cause, depth + 1);
  return out;
}

function normalizeFields(fields: LogFields | undefined): LogFields | undefined {
  if (!fields) return undefined;
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = value instanceof Error ? serializeError(value) : value;
  }
  return out;
}

export interface LoggerOptions {
  level?: LogLevel;
  format?: 'pretty' | 'json';
  stream?: { write(chunk: string): unknown };
}

export function createLogger(options: LoggerOptions = {}, bindings: LogFields = {}): Logger {
  const minRank = LEVEL_RANK[options.level ?? 'info'];
  const stream = options.stream ?? process.stdout;
  const format = options.format ?? (process.stdout.isTTY ? 'pretty' : 'json');

  const write = (level: LogLevel, message: string, fields?: LogFields) => {
    if (LEVEL_RANK[level] < minRank) return;
    const merged = normalizeFields({ ...bindings, ...fields });
    let line: string;
    if (format === 'json') {
      line = JSON.stringify({ time: new Date().toISOString(), level, msg: message, ...merged });
    } else {
      const time = new Date().toISOString().slice(11, 23);
      const extra = merged && Object.keys(merged).length ? ` ${safeStringify(merged)}` : '';
      line = `${COLORS[level]}${time} ${level.toUpperCase().padEnd(5)}${RESET} ${message}${extra}`;
    }
    stream.write(redact(line) + '\n');
  };

  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (more) => createLogger(options, { ...bindings, ...more }),
  };
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'bigint') return v.toString();
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[circular]';
      seen.add(v);
    }
    return v;
  });
}

/** A logger that drops everything; handy for tests. */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};
