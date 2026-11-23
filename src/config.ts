// Configuration from environment variables, validated up front: a
// misconfigured bot fails at startup with every problem listed, instead of
// misbehaving later.

import type { LogLevel } from './util/logger.ts';
import { isSnowflake } from './util/snowflake.ts';

export interface Config {
  token: string;
  applicationId: string | null;
  publicKey: string | null;
  interactions: { mode: 'gateway' | 'http'; host: string; port: number; path: string };
  databasePath: string;
  log: { level: LogLevel; format: 'pretty' | 'json' };
  commands: { sync: 'global' | 'guild' | 'off'; devGuildId: string | null };
  moderation: { guildId: string | null; channelId: string | null; adminIds: string[] };
  media: { channelId: string | null; maxPhotos: number; maxPhotoBytes: number };
  limits: { likesPerDay: number; reportsPerDay: number; minAccountAgeDays: number };
  chat: { idleMinutes: number; queueTimeoutMinutes: number };
  brandName: string | null;
  /** Invite to a server shared with the bot (bots can only DM people who share a server). */
  supportServerUrl: string | null;
  shardCount: number | 'auto';
  validatePayloads: boolean;
}

export class ConfigError extends Error {
  constructor(problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];
  const str = (key: string): string | null => {
    const value = env[key]?.trim();
    return value ? value : null;
  };
  const snowflake = (key: string): string | null => {
    const value = str(key);
    if (value && !isSnowflake(value)) problems.push(`${key} must be a Discord id (snowflake)`);
    return value && isSnowflake(value) ? value : null;
  };
  const int = (key: string, fallback: number, min: number, max: number): number => {
    const raw = str(key);
    if (raw === null) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${key} must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return value;
  };
  const oneOf = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const raw = str(key)?.toLowerCase();
    if (!raw) return fallback;
    if (!(allowed as readonly string[]).includes(raw)) {
      problems.push(`${key} must be one of: ${allowed.join(', ')}`);
      return fallback;
    }
    return raw as T;
  };

  const token = str('DISCORD_TOKEN') ?? '';
  if (!token) problems.push('DISCORD_TOKEN is required');
  else if (!/^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$/.test(token)) problems.push('DISCORD_TOKEN does not look like a bot token');

  const mode = oneOf('INTERACTIONS_MODE', ['gateway', 'http'] as const, 'gateway');
  const publicKey = str('DISCORD_PUBLIC_KEY');
  if (publicKey && !/^[0-9a-f]{64}$/i.test(publicKey)) problems.push('DISCORD_PUBLIC_KEY must be 64 hex characters');
  if (mode === 'http' && !publicKey) problems.push('DISCORD_PUBLIC_KEY is required when INTERACTIONS_MODE=http');

  const adminIds = (str('ADMIN_USER_IDS') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of adminIds) if (!isSnowflake(id)) problems.push(`ADMIN_USER_IDS contains an invalid id: ${id}`);

  const sync = oneOf('COMMANDS_SYNC', ['global', 'guild', 'off'] as const, 'global');
  const devGuildId = snowflake('DEV_GUILD_ID');
  if (sync === 'guild' && !devGuildId) problems.push('DEV_GUILD_ID is required when COMMANDS_SYNC=guild');

  const shardRaw = str('SHARD_COUNT');
  let shardCount: number | 'auto' = 'auto';
  if (shardRaw && shardRaw !== 'auto') {
    const n = Number(shardRaw);
    if (!Number.isInteger(n) || n < 1 || n > 1000) problems.push('SHARD_COUNT must be "auto" or a positive integer');
    else shardCount = n;
  }

  const config: Config = {
    token,
    applicationId: snowflake('DISCORD_APPLICATION_ID'),
    publicKey,
    interactions: {
      mode,
      host: str('HTTP_HOST') ?? '0.0.0.0',
      port: int('HTTP_PORT', 8080, 1, 65535),
      path: str('HTTP_PATH') ?? '/interactions',
    },
    databasePath: str('DATABASE_PATH') ?? './data/bot.db',
    log: {
      level: oneOf('LOG_LEVEL', ['debug', 'info', 'warn', 'error'] as const, 'info'),
      format: oneOf('LOG_FORMAT', ['pretty', 'json'] as const, process.stdout.isTTY ? 'pretty' : 'json'),
    },
    commands: { sync, devGuildId },
    moderation: { guildId: snowflake('MOD_GUILD_ID'), channelId: snowflake('MOD_CHANNEL_ID'), adminIds },
    media: {
      channelId: snowflake('MEDIA_CHANNEL_ID'),
      maxPhotos: int('MAX_PHOTOS', 6, 1, 10),
      maxPhotoBytes: int('MAX_PHOTO_MB', 8, 1, 20) * 1024 * 1024,
    },
    limits: {
      likesPerDay: int('LIKES_PER_DAY', 60, 1, 10_000),
      reportsPerDay: int('REPORTS_PER_DAY', 10, 1, 1000),
      minAccountAgeDays: int('MIN_ACCOUNT_AGE_DAYS', 0, 0, 3650),
    },
    chat: {
      idleMinutes: int('CHAT_IDLE_MINUTES', 20, 2, 24 * 60),
      queueTimeoutMinutes: int('CHAT_QUEUE_TIMEOUT_MINUTES', 15, 1, 24 * 60),
    },
    brandName: str('BRAND_NAME'),
    supportServerUrl: (() => {
      const url = str('SUPPORT_SERVER_URL');
      if (url && !/^https:\/\/(discord\.gg|discord\.com\/invite)\/[\w-]+$/.test(url)) problems.push('SUPPORT_SERVER_URL must be a Discord invite link');
      return url;
    })(),
    shardCount,
    validatePayloads: ['1', 'true', 'yes'].includes((str('VALIDATE_PAYLOADS') ?? '').toLowerCase()),
  };

  if (problems.length) throw new ConfigError(problems);
  return config;
}
