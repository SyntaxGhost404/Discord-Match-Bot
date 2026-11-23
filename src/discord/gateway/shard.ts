// One Gateway connection (shard), implemented from the Gateway docs:
//
//   connect → HELLO → heartbeat every interval (first beat after interval×jitter)
//           → IDENTIFY (new session) or RESUME (existing session)
//           → READY / RESUMED → DISPATCH events…
//
// Every socket gets a connection id. Events from a socket that is no longer
// current are ignored, so a late close/message from an abandoned connection
// can never disturb its replacement. All reconnect decisions flow through
// `reconnect()`, which makes the lifecycle easy to reason about.

import { FATAL_GATEWAY_CLOSE_CODES, GatewayOpcode, SESSION_INVALIDATING_CLOSE_CODES } from '../constants.ts';
import type { GatewayPayload, PresenceUpdate, ReadyEvent } from '../types.ts';
import { backoffDelay } from '../../util/async.ts';
import type { Logger } from '../../util/logger.ts';

export type ShardStatus = 'idle' | 'connecting' | 'handshaking' | 'ready' | 'reconnecting' | 'destroyed';

export interface ShardOptions {
  id: number;
  count: number;
  token: string;
  intents: number;
  gatewayUrl: string;
  presence?: PresenceUpdate;
  logger: Logger;
  /** Resolves when this shard may identify (concurrency + session budget). */
  identifyGate: (shardId: number) => Promise<void>;
  onDispatch: (event: string, data: unknown, shard: Shard) => void;
  onFatal: (shard: Shard, code: number, reason: string) => void;
  WebSocketImpl?: typeof WebSocket;
  helloTimeoutMs?: number;
}

const SEND_LIMIT = 115; // Discord allows 120 per 60s; keep headroom
const SEND_WINDOW_MS = 60_000;
const MAX_PAYLOAD_BYTES = 4096;

export class Shard {
  readonly id: number;
  private readonly options: ShardOptions;
  private readonly log: Logger;
  private readonly WS: typeof WebSocket;

  private ws: WebSocket | null = null;
  private connectionId = 0;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private sequence: number | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatStart: ReturnType<typeof setTimeout> | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private awaitingAck = false;
  private lastHeartbeatAt = 0;
  private reconnectAttempts = 0;
  private sentTimes: number[] = [];

  status: ShardStatus = 'idle';
  latencyMs = -1;

  constructor(options: ShardOptions) {
    this.id = options.id;
    this.options = options;
    this.log = options.logger.child({ shard: options.id });
    this.WS = options.WebSocketImpl ?? WebSocket;
  }

  get hasSession(): boolean {
    return this.sessionId !== null;
  }

  connect(): void {
    if (this.status === 'destroyed') return;
    this.open(this.sessionId !== null);
  }

  /** Closes for good. Code 1000 invalidates the session (bot goes offline). */
  destroy(code = 1000): void {
    this.status = 'destroyed';
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    this.connectionId++;
    if (ws) closeQuietly(ws, code, 'shutdown');
  }

  /** Sends a gateway command (e.g. presence update). Returns false if dropped. */
  send(op: number, d: unknown): boolean {
    const now = Date.now();
    this.sentTimes = this.sentTimes.filter((t) => now - t < SEND_WINDOW_MS);
    if (op !== GatewayOpcode.Heartbeat && this.sentTimes.length >= SEND_LIMIT) {
      this.log.warn('Gateway send budget exhausted, dropping payload', { op });
      return false;
    }
    const ws = this.ws;
    if (!ws || ws.readyState !== this.WS.OPEN) return false;
    const data = JSON.stringify({ op, d });
    if (Buffer.byteLength(data) > MAX_PAYLOAD_BYTES) {
      this.log.error('Gateway payload exceeds 4096 bytes, not sent', { op });
      return false;
    }
    this.sentTimes.push(now);
    ws.send(data);
    return true;
  }

  updatePresence(presence: PresenceUpdate): boolean {
    this.options.presence = presence;
    return this.send(GatewayOpcode.PresenceUpdate, presence);
  }

  // ---------------------------------------------------------------------------

  private open(resume: boolean): void {
    this.clearTimers();
    const connection = ++this.connectionId;
    const base = resume && this.resumeUrl ? this.resumeUrl : this.options.gatewayUrl;
    const url = new URL(base);
    url.searchParams.set('v', '10');
    url.searchParams.set('encoding', 'json');

    this.status = 'connecting';
    this.log.debug('Opening gateway connection', { resume, host: url.host });
    let ws: WebSocket;
    try {
      ws = new this.WS(url.toString());
    } catch (error) {
      this.log.error('Could not create gateway socket', { error });
      this.reconnect('socket-create-failed', resume);
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    this.helloTimer = setTimeout(() => {
      if (connection !== this.connectionId) return;
      this.log.warn('No HELLO from the gateway in time, reconnecting');
      this.reconnect('hello-timeout', this.sessionId !== null);
    }, this.options.helloTimeoutMs ?? 20_000);

    ws.onmessage = (event: MessageEvent) => {
      if (connection !== this.connectionId) return;
      const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data as ArrayBuffer).toString('utf8');
      this.handleRaw(raw, connection);
    };
    ws.onclose = (event: { code: number; reason: string }) => {
      if (connection !== this.connectionId) return;
      this.handleClose(event.code, event.reason);
    };
    ws.onerror = () => {
      // A close event always follows; reconnect decisions happen there.
    };
  }

  private handleRaw(raw: string, connection: number): void {
    let payload: GatewayPayload;
    try {
      payload = JSON.parse(raw) as GatewayPayload;
    } catch {
      this.log.warn('Ignoring malformed gateway payload');
      return;
    }
    if (typeof payload.s === 'number') this.sequence = payload.s;

    switch (payload.op) {
      case GatewayOpcode.Hello:
        void this.handleHello(payload.d as { heartbeat_interval?: number }, connection);
        break;
      case GatewayOpcode.Heartbeat:
        this.sendHeartbeat();
        break;
      case GatewayOpcode.HeartbeatAck:
        this.awaitingAck = false;
        this.latencyMs = Date.now() - this.lastHeartbeatAt;
        break;
      case GatewayOpcode.Reconnect:
        this.log.info('Gateway requested a reconnect');
        this.reconnect('server-requested', true, 0);
        break;
      case GatewayOpcode.InvalidSession: {
        const resumable = payload.d === true;
        this.log.warn('Gateway session invalidated', { resumable });
        if (!resumable) this.resetSession();
        // Docs: wait a random 1-5 seconds before reconnecting.
        this.reconnect('invalid-session', resumable, 1000 + Math.random() * 4000);
        break;
      }
      case GatewayOpcode.Dispatch:
        this.handleDispatch(payload);
        break;
      default:
        this.log.debug('Unhandled gateway opcode', { op: payload.op });
    }
  }

  private async handleHello(d: { heartbeat_interval?: number }, connection: number): Promise<void> {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    const interval = Number(d?.heartbeat_interval);
    if (!Number.isFinite(interval) || interval < 1000 || interval > 600_000) {
      this.log.warn('Malformed HELLO, reconnecting', { interval: d?.heartbeat_interval });
      this.reconnect('bad-hello', this.sessionId !== null);
      return;
    }
    this.startHeartbeat(interval);
    this.status = 'handshaking';

    if (this.sessionId) {
      this.send(GatewayOpcode.Resume, { token: this.options.token, session_id: this.sessionId, seq: this.sequence });
      return;
    }
    try {
      await this.options.identifyGate(this.id);
    } catch (error) {
      this.log.error('Identify gate failed', { error });
    }
    if (connection !== this.connectionId) return; // socket replaced while waiting
    this.send(GatewayOpcode.Identify, {
      token: this.options.token,
      intents: this.options.intents,
      properties: { os: process.platform, browser: 'discord-match-bot', device: 'discord-match-bot' },
      shard: [this.id, this.options.count],
      large_threshold: 50,
      ...(this.options.presence ? { presence: this.options.presence } : {}),
    });
  }

  private handleDispatch(payload: GatewayPayload): void {
    const event = payload.t ?? '';
    if (event === 'READY') {
      const ready = payload.d as ReadyEvent;
      this.sessionId = ready.session_id;
      this.resumeUrl = ready.resume_gateway_url;
      this.status = 'ready';
      this.reconnectAttempts = 0;
      this.log.info('Gateway session ready', { user: ready.user?.username, guilds: ready.guilds?.length ?? 0 });
    } else if (event === 'RESUMED') {
      this.status = 'ready';
      this.reconnectAttempts = 0;
      this.log.info('Gateway session resumed');
    }
    try {
      this.options.onDispatch(event, payload.d, this);
    } catch (error) {
      this.log.error('Dispatch handler threw', { event, error });
    }
  }

  private handleClose(code: number, reason: string): void {
    this.clearTimers();
    this.ws = null;
    if (this.status === 'destroyed') return;
    if (FATAL_GATEWAY_CLOSE_CODES.has(code)) {
      this.log.error('Gateway closed with a fatal code; not reconnecting', { code, reason });
      this.status = 'destroyed';
      this.options.onFatal(this, code, reason);
      return;
    }
    if (SESSION_INVALIDATING_CLOSE_CODES.has(code)) this.resetSession();
    this.log.warn('Gateway connection closed', { code, reason: reason || undefined });
    this.reconnect(`closed-${code}`, this.sessionId !== null);
  }

  private reconnect(reason: string, resume: boolean, delayOverride?: number): void {
    if (this.status === 'destroyed') return;
    this.clearTimers();
    const old = this.ws;
    this.ws = null;
    this.connectionId++; // silence the old socket's late events
    // Any close code other than 1000/1001 keeps the session resumable.
    if (old) closeQuietly(old, 4000, reason.slice(0, 100));
    if (!resume) this.resetSession();

    const attempt = this.reconnectAttempts++;
    const delay = delayOverride ?? (attempt === 0 ? Math.random() * 1000 : backoffDelay(attempt, 1000, 30_000));
    this.status = 'reconnecting';
    this.log.info('Reconnecting to the gateway', { reason, resume, attempt, delayMs: Math.round(delay) });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open(resume && this.sessionId !== null);
    }, delay);
  }

  private startHeartbeat(interval: number): void {
    this.awaitingAck = false;
    const beat = () => {
      if (this.awaitingAck) {
        this.log.warn('Heartbeat not acknowledged; connection is a zombie, reconnecting');
        this.reconnect('zombie', true, 0);
        return;
      }
      this.sendHeartbeat();
    };
    this.heartbeatStart = setTimeout(() => {
      beat();
      this.heartbeatInterval = setInterval(beat, interval);
    }, Math.floor(interval * Math.random()));
  }

  private sendHeartbeat(): void {
    this.awaitingAck = true;
    this.lastHeartbeatAt = Date.now();
    this.send(GatewayOpcode.Heartbeat, this.sequence);
  }

  private resetSession(): void {
    this.sessionId = null;
    this.resumeUrl = null;
    this.sequence = null;
  }

  private clearTimers(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.heartbeatStart) clearTimeout(this.heartbeatStart);
    if (this.helloTimer) clearTimeout(this.helloTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatInterval = null;
    this.heartbeatStart = null;
    this.helloTimer = null;
    this.reconnectTimer = null;
  }
}

function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  ws.onmessage = null;
  ws.onclose = null;
  ws.onerror = null;
  try {
    ws.close(code, reason);
  } catch {
    // already closing/closed
  }
}
