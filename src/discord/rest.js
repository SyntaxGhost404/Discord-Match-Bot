// Raw Discord REST client. No wrappers: fetch() against https://discord.com/api/v10.
// Every call carries `Authorization: Bot <token>`. Multipart uploads go through
// FormData (field `payload_json` + one part per file).

import { config } from '../config.js';
import { logger, sleep } from '../util.js';

const API = 'https://discord.com/api/v10';
const APP_ID = () => config.applicationId;

export class DiscordAPIError extends Error {
  constructor(status, data, method, path) {
    super(`Discord API ${status} on ${method} ${path}: ${data?.message || 'no message'}`);
    this.name = 'DiscordAPIError';
    this.status = status;
    this.code = data?.code ?? null; // Discord's JSON error code (e.g. 50007 = cannot DM)
    this.data = data;
    this.method = method;
    this.path = path;
  }
}

async function rawRequest(method, path, { body, files, reason, attempt = 0 } = {}) {
  const url = API + path;
  const headers = { Authorization: `Bot ${config.token}` };
  if (reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(String(reason)).slice(0, 512);

  let payload;
  if (files && files.length) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify(body ?? {}));
    files.forEach((f, i) => {
      form.append(`files[${i}]`, new Blob([f.data], { type: f.contentType || 'application/octet-stream' }), f.filename);
    });
    payload = form; // fetch sets the multipart content-type + boundary itself
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(15000) });
  } catch (err) {
    throw new Error(`network error on ${method} ${path}: ${err.message}`);
  }

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }

  if (res.status === 429) {
    // Integration-2: an interaction-callback 429 is never worth retrying —
    // the retry would land past Discord's 3s ack window (useless), and the
    // capped sleep wedges the user's whole router chain meanwhile. Fail fast
    // instead; the router's safe() already absorbs the error. Only
    // non-interaction calls (DM sends etc.) keep the capped retry, where the
    // retry has real value.
    if (method === 'POST' && path.includes('/interactions/')) {
      logger.warn(`429 on interaction callback ${method} ${path}, failing fast (no retry)`);
      throw new DiscordAPIError(res.status, data, method, path);
    }
    // Cap the backoff at 30s. Discord occasionally returns absurd
    // retry_after values (minutes/hours), and router.js serializes each
    // user's interactions behind the promise returned here — an uncapped
    // sleep would wedge every later interaction from that user for the full
    // retry_after (each queued interaction also pins its payload in memory).
    // Note the tension: a retry of an interaction-callback 429 that lands
    // past Discord's 3s ack window is useless anyway, so honoring more than
    // 30s buys nothing for the case that matters most.
    const rawRetryAfter = Number(data?.retry_after ?? res.headers.get('retry-after') ?? 1);
    // retry_after=0 means "retry right away": honor it as just the 250ms pad
    // instead of degrading to the 1s default (Number(0) fails the old `> 0`
    // test, which used to sleep 1250ms for a "retry immediately").
    const parsed = Number.isFinite(rawRetryAfter) && rawRetryAfter >= 0 ? rawRetryAfter : 1;
    const retryAfter = Math.min(parsed, 30);
    logger.warn(`429 on ${method} ${path}, retry_after=${retryAfter}s`);
    if (attempt < 2) {
      await sleep(retryAfter * 1000 + 250);
      return rawRequest(method, path, { body, files, reason, attempt: attempt + 1 });
    }
    throw new DiscordAPIError(res.status, data, method, path);
  }

  if (!res.ok) throw new DiscordAPIError(res.status, data, method, path);
  return data;
}

/** request(method, path, { body, files, reason }) */
export function request(method, path, opts = {}) {
  return rawRequest(method, path, opts);
}

const get = (path, opts) => request('GET', path, opts);
const post = (path, body, opts = {}) => request('POST', path, { ...opts, body });
const patch = (path, body, opts = {}) => request('PATCH', path, { ...opts, body });
const put = (path, body, opts = {}) => request('PUT', path, { ...opts, body });
const del = (path, opts = {}) => request('DELETE', path, opts);

// ---------------------------------------------------------------------------
// Application commands
// ---------------------------------------------------------------------------

export const Commands = {
  /** Bulk-overwrite GLOBAL commands (takes up to ~1h to propagate). */
  overwriteGlobal: (commands) => put(`/applications/${APP_ID()}/commands`, commands),
  /** Bulk-overwrite GUILD commands (instant; use for dev). */
  overwriteGuild: (guildId, commands) => put(`/applications/${APP_ID()}/guilds/${guildId}/commands`, commands),
};

// ---------------------------------------------------------------------------
// Interactions (answers go over REST, never the gateway)
// ---------------------------------------------------------------------------

export const Interactions = {
  /** POST /interactions/{id}/{token}/callback: the 3-second acknowledgement. */
  callback: (interaction, response) =>
    post(`/interactions/${interaction.id}/${interaction.token}/callback`, response),

  /** Create a followup message. flags may include 64 (ephemeral) and/or 32768 (V2). */
  followup: (interaction, body, opts = {}) =>
    post(`/webhooks/${APP_ID()}/${interaction.token}`, body, opts),

  /** Edit the original interaction response. */
  editOriginal: (interaction, body, opts = {}) =>
    patch(`/webhooks/${APP_ID()}/${interaction.token}/messages/@original`, body, opts),

  /** Fetch the original interaction response (e.g. to learn its message id). */
  getOriginal: (interaction) =>
    get(`/webhooks/${APP_ID()}/${interaction.token}/messages/@original`),

  /** Edit any followup by id. */
  editFollowup: (interaction, messageId, body, opts = {}) =>
    patch(`/webhooks/${APP_ID()}/${interaction.token}/messages/${messageId}`, body, opts),

  /** Delete the original interaction response (e.g. clean up an ephemeral defer). */
  deleteOriginal: (interaction) =>
    del(`/webhooks/${APP_ID()}/${interaction.token}/messages/@original`),
};

// ---------------------------------------------------------------------------
// Channels / DMs / messages / users
// ---------------------------------------------------------------------------

export const Rest = {
  /** Open (or fetch existing) DM channel with a user. */
  createDM: (userId) => post('/users/@me/channels', { recipient_id: userId }),

  /** Send a message to a channel. Pass { files } for multipart uploads. */
  sendMessage: (channelId, body, opts = {}) => post(`/channels/${channelId}/messages`, body, opts),

  /** Edit a message the bot sent. Pass { files } for multipart uploads. */
  editMessage: (channelId, messageId, body, opts = {}) =>
    patch(`/channels/${channelId}/messages/${messageId}`, body, opts),

  /** React to a message with an emoji (PUT .../reactions/{emoji}/@me). */
  addReaction: (channelId, messageId, emoji) =>
    put(`/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`),

  /** Fetch a user object (id, username, global_name, ...). */
  getUser: (userId) => get(`/users/${userId}`),
};

// Callback response type constants
export const CallbackType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  MODAL: 9,
};

// Message flag constants
export const Flag = {
  EPHEMERAL: 1 << 6,          // 64
  IS_COMPONENTS_V2: 1 << 15, // 32768
};
export const V2 = Flag.IS_COMPONENTS_V2;
export const V2_EPHEMERAL = Flag.IS_COMPONENTS_V2 | Flag.EPHEMERAL; // 32832
