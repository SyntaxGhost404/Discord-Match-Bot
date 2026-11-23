// Raw HTTP client for the Discord REST API (no wrapper libraries).
//
// Responsibilities:
//  * authentication + the User-Agent format Discord requires
//  * JSON and multipart/form-data bodies (payload_json + files[n])
//  * rate limits (see ratelimit.ts), 429 retries honoring retry_after
//  * bounded retries for transient failures — only where a retry cannot
//    duplicate side effects (idempotent methods, or POSTs we mark safe)
//  * request timeouts

import { API_BASE } from '../constants.ts';
import type { FileUpload } from '../types.ts';
import { DiscordApiError, DiscordNetworkError, redactPath, type DiscordErrorBody } from './errors.ts';
import { RateLimiter, routeInfo } from './ratelimit.ts';
import { backoffDelay, sleep } from '../../util/async.ts';
import type { Logger } from '../../util/logger.ts';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface RequestOptions {
  method: HttpMethod;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  files?: FileUpload[];
  /** Send the bot token (default true; interaction webhooks don't need it). */
  auth?: boolean;
  reason?: string;
  timeoutMs?: number;
  /** Mark a POST as safe to retry (e.g. carries an enforced nonce). */
  idempotent?: boolean;
  /** Give up on 429s whose wait would exceed this many ms. */
  maxRateLimitWaitMs?: number;
  signal?: AbortSignal;
}

export interface RestClientOptions {
  token: string;
  logger: Logger;
  apiBase?: string;
  userAgent?: string;
  fetch?: typeof fetch;
  defaultTimeoutMs?: number;
}

const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

export class RestClient {
  private readonly token: string;
  private readonly log: Logger;
  private readonly apiBase: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultTimeoutMs: number;
  readonly limiter: RateLimiter;

  constructor(options: RestClientOptions) {
    this.token = options.token;
    this.log = options.logger;
    this.apiBase = options.apiBase ?? API_BASE;
    this.userAgent = options.userAgent ?? 'DiscordBot (https://github.com/syntaxghost404/discord-match-bot, 2.0.0)';
    this.fetchImpl = options.fetch ?? fetch;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 15_000;
    this.limiter = new RateLimiter({
      onInvalidThreshold: (count) =>
        this.log.warn('High number of invalid Discord requests in the last 10 minutes', { count, limit: 10_000 }),
    });
  }

  async request<T = unknown>(options: RequestOptions): Promise<T> {
    const info = routeInfo(options.method, options.path);
    const safePath = redactPath(options.path);
    const retrySafe = options.method !== 'POST' || options.idempotent === true;

    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await this.limiter.schedule(info, async () => {
          const res = await this.send(options);
          this.limiter.update(info, res.headers);
          return res;
        });
      } catch (error) {
        const network = new DiscordNetworkError(options.method, safePath, error);
        if (retrySafe && attempt < MAX_ATTEMPTS && !options.signal?.aborted) {
          const wait = backoffDelay(attempt - 1, 500, 5_000);
          this.log.warn('Discord request failed, retrying', { method: options.method, path: safePath, attempt, wait, error: network.message });
          await sleep(wait);
          continue;
        }
        throw network;
      }

      if (response.status === 429) {
        const body = (await readJson(response)) as DiscordErrorBody | null;
        const retryAfterMs = Math.ceil(Number(body?.retry_after ?? response.headers.get('retry-after') ?? 1) * 1000);
        const global = body?.global === true || response.headers.get('x-ratelimit-global') === 'true';
        const scope = response.headers.get('x-ratelimit-scope');
        if (scope !== 'shared') this.limiter.recordInvalid();
        this.limiter.onRateLimited(info, retryAfterMs, global);
        const tooLong = options.maxRateLimitWaitMs !== undefined && retryAfterMs > options.maxRateLimitWaitMs;
        this.log.warn('Rate limited by Discord', { method: options.method, path: safePath, retryAfterMs, global, scope, attempt });
        if (attempt >= MAX_ATTEMPTS || tooLong) throw new DiscordApiError(429, body, options.method, safePath);
        await sleep(retryAfterMs + 50);
        continue;
      }

      if (RETRYABLE_STATUS.has(response.status) && retrySafe && attempt < MAX_ATTEMPTS) {
        await response.body?.cancel().catch(() => {});
        const wait = backoffDelay(attempt - 1, 500, 5_000);
        this.log.warn('Discord server error, retrying', { method: options.method, path: safePath, status: response.status, attempt, wait });
        await sleep(wait);
        continue;
      }

      if (response.status === 401 || response.status === 403) this.limiter.recordInvalid();

      if (!response.ok) {
        const body = (await readJson(response)) as DiscordErrorBody | null;
        throw new DiscordApiError(response.status, body, options.method, safePath);
      }

      if (response.status === 204) return undefined as T;
      return (await readJson(response)) as T;
    }
  }

  private async send(options: RequestOptions): Promise<Response> {
    const url = new URL(this.apiBase + options.path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { 'User-Agent': this.userAgent };
    if (options.auth !== false) headers.Authorization = `Bot ${this.token}`;
    if (options.reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(options.reason.slice(0, 512));

    let body: FormData | string | undefined;
    if (options.files?.length) {
      const form = new FormData();
      form.append('payload_json', JSON.stringify(options.body ?? {}));
      options.files.forEach((file, index) => {
        const blob = new Blob([file.data as Uint8Array<ArrayBuffer>], { type: file.contentType ?? 'application/octet-stream' });
        form.append(`files[${index}]`, blob, file.name);
      });
      body = form; // fetch sets the multipart boundary
    } else if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.defaultTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    return this.fetchImpl(url, { method: options.method, headers, body, signal });
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) };
  }
}
