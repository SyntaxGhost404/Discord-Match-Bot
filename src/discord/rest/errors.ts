// Errors raised by the REST client. Paths are stored with interaction and
// webhook tokens stripped, so errors are always safe to log.

export interface DiscordErrorBody {
  code?: number;
  message?: string;
  errors?: unknown;
  retry_after?: number;
  global?: boolean;
}

export class DiscordApiError extends Error {
  readonly status: number;
  /** Discord's JSON error code (e.g. 50007), or null when absent. */
  readonly code: number | null;
  readonly method: string;
  readonly path: string;
  readonly body: DiscordErrorBody | null;

  constructor(status: number, body: DiscordErrorBody | null, method: string, path: string) {
    const detail = body?.message ?? 'no message';
    const fieldErrors = body?.errors ? ` ${JSON.stringify(body.errors).slice(0, 800)}` : '';
    super(`Discord API ${status} (${body?.code ?? '-'}) on ${method} ${path}: ${detail}${fieldErrors}`);
    this.name = 'DiscordApiError';
    this.status = status;
    this.code = typeof body?.code === 'number' ? body.code : null;
    this.method = method;
    this.path = path;
    this.body = body;
  }
}

export class DiscordNetworkError extends Error {
  readonly method: string;
  readonly path: string;

  constructor(method: string, path: string, cause: unknown) {
    super(`Network error on ${method} ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'DiscordNetworkError';
    this.method = method;
    this.path = path;
  }
}

export function isApiError(error: unknown, ...codes: number[]): error is DiscordApiError {
  return error instanceof DiscordApiError && (codes.length === 0 || (error.code !== null && codes.includes(error.code)));
}

export function isStatus(error: unknown, ...statuses: number[]): error is DiscordApiError {
  return error instanceof DiscordApiError && statuses.includes(error.status);
}

/** Removes secrets (interaction / webhook tokens) from an API path. */
export function redactPath(path: string): string {
  return path
    .replace(/^(\/interactions\/\d+\/)[^/?]+/, '$1:token')
    .replace(/^(\/webhooks\/\d+\/)[^/?]+/, '$1:token');
}
