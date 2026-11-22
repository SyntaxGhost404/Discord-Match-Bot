// Raw Discord Gateway client (WebSocket, API v10, JSON encoding). No libraries.
//
//  - GET /gateway/bot, connect, HELLO -> heartbeat loop -> IDENTIFY/RESUME
//  - dispatch INTERACTION_CREATE / MESSAGE_CREATE to the handler callback
//  - heartbeat ACK tracking + zombie-connection detection
//  - reconnect/resume with jittered backoff; honors fatal close codes
//
// Uses the global WebSocket when available; otherwise tunnels through the
// HTTPS proxy via the ProxyWebSocket shim (Node's native WebSocket ignores
// *_proxy env vars).
//
// Interaction answers always go over REST (never the gateway).

import { config } from '../config.js';
import { request } from './rest.js';
import { backoffMs, logger, sleep } from '../util.js';
import { ProxyWebSocket, proxyForUrl, WS_OPEN } from './proxy-ws.js';

const OPCODES = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  PRESENCE_UPDATE: 3,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
};

// Close codes we must NOT blindly retry (fix config instead).
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

// GUILDS (1) | DIRECT_MESSAGES (4096) | MESSAGE_CONTENT (32768)
const INTENTS = 1 | 4096 | 32768; // 36865

const hasNativeWS = typeof WebSocket !== 'undefined';

export class Gateway {
  constructor(onDispatch) {
    this.onDispatch = onDispatch; // async (eventName, data, raw) => {}
    this.ws = null;
    this.seq = null;
    this.sessionId = null;
    this.resumeUrl = null;
    this.gatewayUrl = null;
    this.heartbeatTimer = null;
    this.lastAck = true;
    this.reconnectAttempt = 0;
    this.stopping = false;
    this._helloResolve = null;
    this._connecting = false; // a connect attempt (or its reconnect chain) is in flight
    this._resumeInFlight = false; // INVALID_SESSION(d=true) resume already scheduled/sent
    this._resumeSeq = 0; // generation token: only the chain that set _resumeInFlight may clear it
    this._epoch = 0; // attempt identity: bumped by start()/stop(); stale attempts go silent
    this.resumeFailures = 0;
    this.invalidSessionAttempts = 0;
    this.connectTimeoutMs = 15000; // bound on one connect attempt (HELLO wait)
  }

  async start() {
    // Idempotent: a second start() while an attempt (or its reconnect chain)
    // is in flight must not create a second socket. Two concurrent attempts
    // race on this.ws / this._helloResolve / this.seq and the first socket's
    // handlers then mutate state owned by the replacement.
    if (this.ws || this._connecting) {
      logger.debug('start() ignored: already connected or connecting');
      return;
    }
    // Hunt 6: attempt identity. Every start()/stop() moves the epoch; connect
    // attempts, their timeout timers, onclose handlers and reconnect loops
    // capture the epoch and go silent when it moves, so a killed attempt can
    // never spawn a zombie socket or a duplicate reconnect.
    this._epoch = (this._epoch || 0) + 1;
    const epoch = this._epoch;
    this._connecting = true;
    this.stopping = false;
    try {
      await this.connect(false);
    } catch (err) {
      // connect() throws before its internal retry path when the REST call
      // for the gateway URL blows up; enter the reconnect loop instead of
      // dying silently with no socket and no retries.
      logger.error('initial connect failed, entering reconnect loop:', err?.message || err);
      this.scheduleReconnect(4000, epoch);
    }
  }

  async stop() {
    this.stopping = true;
    this._connecting = false;
    this._resumeInFlight = false;
    this._resumeSeq = (this._resumeSeq || 0) + 1; // neutralize sleeping INVALID_SESSION chains
    this._epoch = (this._epoch || 0) + 1; // Hunt 6: kill in-flight attempts, timers and reconnect loops
    this.clearHeartbeat();
    if (this.ws) {
      try { this.ws.close(1000, 'shutdown'); } catch {}
      this.ws = null;
    }
  }

  async fetchGatewayUrl() {
    const res = await request('GET', '/gateway/bot');
    this.gatewayUrl = res.url;
    logger.info(`Gateway URL: ${this.gatewayUrl} (shards: ${res.shards})`);
    return this.gatewayUrl;
  }

  async connect(resume) {
    if (this.stopping) return;
    const epoch = this._epoch; // Hunt 6: attempt identity, captured before any await
    if (!(resume && this.resumeUrl)) {
      await this.fetchGatewayUrl();
    }
    // Hunt 6 (B6a): stop() ran — or a newer start() began — while the gateway
    // URL was being fetched. This attempt is dead: unwind without creating a
    // socket, or it becomes an orphaned zombie next to the replacement.
    if (this.stopping || this._epoch !== epoch) {
      logger.debug('connect attempt superseded before socket creation, unwinding');
      return;
    }
    const url = `${resume && this.resumeUrl ? this.resumeUrl : this.gatewayUrl}?v=${config.gatewayVersion}&encoding=json`;
    logger.info(`Connecting to gateway (resume=${!!resume})...`);

    await new Promise((resolve, reject) => {
      const proxy = proxyForUrl(url);
      let ws;
      let settled = false;
      // A proxy that accepts TCP but never answers CONNECT (or a stalled TLS
      // handshake / WS upgrade) would otherwise pend forever: no HELLO, no
      // error, no reconnect, no log. Bound the whole attempt instead; the
      // normal reconnect path below picks it back up.
      const timeoutMs = this.connectTimeoutMs || 15000;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Hunt 6 (B6c): a stale timer — stop()/start() moved the epoch while
        // this attempt was pending — must not clobber the replacement's
        // this.ws / _helloResolve. Reject to unwind the dead attempt; the
        // catch below sees the moved epoch and skips the reconnect.
        if (this._epoch !== epoch) {
          logger.debug('stale connect-timeout timer ignored (attempt superseded)');
          reject(new Error('gateway connect superseded by a newer attempt'));
          return;
        }
        logger.warn(`gateway connect timed out after ${timeoutMs}ms with no HELLO, abandoning attempt`);
        this._helloResolve = null;
        if (ws) {
          // Neutralize EVERYTHING before close(): on the ProxyWebSocket shim
          // (the production egress path) close() leaves inbound frames parsing
          // for ~2s, and a HELLO arriving in that window would otherwise run
          // against the REPLACEMENT connection (consumes its _helloResolve
          // early + fires identify() before its own HELLO, and its stray
          // heartbeat timer can zombie-close the healthy replacement).
          // The onclose neutralization (no double reconnect) stays too.
          ws.onclose = () => {}; // late close must not double-schedule a reconnect
          ws.onmessage = () => {}; // late frames must not touch shared state
          ws.onopen = () => {};
          ws.onerror = () => {};
          try { ws.close(4000, 'connect timeout'); } catch {}
        }
        this.ws = null;
        reject(new Error('gateway connect timed out waiting for HELLO'));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
      const die = (e) => { if (settled) return; settled = true; clearTimeout(timer); reject(e); };

      if (hasNativeWS && !proxy) {
        ws = new WebSocket(url);
      } else if (proxy) {
        logger.info('gateway: connecting through proxy tunnel');
        ws = new ProxyWebSocket(url, proxy);
      } else {
        die(new Error('no global WebSocket and no proxy configured; cannot connect'));
        return;
      }
      this.ws = ws;
      this._helloResolve = done;

      ws.onopen = () => logger.debug('gateway socket open, waiting for HELLO');
      // Pass the socket through so handleMessage can drop frames from a
      // socket that is no longer this.ws (defense in depth for late frames
      // from an abandoned connection, e.g. the proxy shim's ~2s post-close
      // parsing window).
      ws.onmessage = (ev) => this.handleMessage(ev.data, ws).catch((e) => logger.error('dispatch error:', e));
      ws.onerror = (ev) => logger.warn('gateway socket error', ev?.message || '');
      ws.onclose = (ev) => {
        // Hunt 6 (B6b): a late onclose from a socket that is no longer the
        // live connection (pre-stop or superseded attempt) must not kill the
        // replacement's heartbeat timer, null its ws, or schedule a spurious
        // reconnect.
        if (ws !== this.ws) {
          logger.debug(`ignoring onclose from a stale socket (code=${ev.code})`);
          // ...but if it owned the pending HELLO wait (stop() nulled this.ws
          // first), still unwind the dead attempt so a pending start() await
          // cannot hang forever. The epoch check in the catch below keeps
          // this from scheduling a reconnect.
          if (this._helloResolve && this.stopping) {
            const d = this._helloResolve; this._helloResolve = null;
            die(new Error(`closed before HELLO: ${ev.code}`));
          }
          return;
        }
        logger.warn(`gateway closed: code=${ev.code} reason=${ev.reason || 'n/a'}`);
        this.clearHeartbeat();
        this.ws = null;
        if (this._helloResolve) { this._helloResolve = null; die(new Error(`closed before HELLO: ${ev.code}`)); }
        else this.scheduleReconnect(ev.code, epoch);
      };
    }).catch(async (err) => {
      logger.warn('connect failed:', err.message);
      // Hunt 6 (B6a): the killed attempt's catch must not schedule a
      // reconnect after stop()/start() moved the epoch — that duplicate
      // connect orphaned a zombie socket next to the healthy replacement.
      if (this._epoch !== epoch) {
        logger.debug('stale connect attempt unwound without reconnect (epoch moved)');
        return;
      }
      this.scheduleReconnect(4000, epoch);
    });
  }

  async scheduleReconnect(closeCode, epoch = this._epoch) {
    if (this.stopping) return;
    // Hunt 6 (B6a): the epoch moved (stop()/start()) while a killed attempt
    // was unwinding — stay silent instead of spawning a duplicate connect.
    if (this._epoch !== epoch) {
      logger.debug('stale reconnect loop exiting (epoch moved)');
      return;
    }
    if (FATAL_CLOSE_CODES.has(closeCode)) {
      logger.error(`Fatal gateway close code ${closeCode}: not retrying. Check token/intents/sharding config.`);
      return;
    }
    // The reconnect loop must survive its own failures. A transient REST
    // outage makes fetchGatewayUrl() throw inside connect(); without this
    // guard that rejection floats (or rejects start()) and the gateway dies
    // silently: ws stays null, zero further reconnects, process keeps running.
    try {
      if (this.sessionId) {
        this.resumeFailures = (this.resumeFailures || 0) + 1;
        if (this.resumeFailures > 2) {
          logger.warn('resume failed repeatedly, starting a fresh session');
          this.sessionId = null;
          this.resumeUrl = null;
          this.resumeFailures = 0;
        }
      }
      const wait = backoffMs(this.reconnectAttempt++);
      logger.info(`Reconnecting in ${wait}ms (attempt ${this.reconnectAttempt})...`);
      await sleep(wait);
      if (this.stopping) return;
      // Hunt 6 (B6a): slept straight through a stop()/start() — the new
      // attempt owns the connection now; do not fire a duplicate connect.
      if (this._epoch !== epoch) {
        logger.debug('stale reconnect loop exiting after sleep (epoch moved)');
        return;
      }
      await this.connect(!!this.sessionId);
    } catch (err) {
      logger.error('reconnect attempt failed, staying in the loop:', err?.message || err);
      if (!this.stopping && this._epoch === epoch) this.scheduleReconnect(4000, epoch);
    }
  }

  clearHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  send(op, d) {
    const OPEN = this.ws instanceof ProxyWebSocket ? WS_OPEN : WebSocket.OPEN;
    if (!this.ws || this.ws.readyState !== OPEN) {
      logger.warn(`cannot send op ${op}: socket not open`);
      return false;
    }
    const payload = JSON.stringify({ op, d });
    if (payload.length > 4096) {
      logger.error(`gateway payload too large (${payload.length} bytes), dropping op ${op}`);
      return false;
    }
    this.ws.send(payload);
    return true;
  }

  startHeartbeat(intervalMs) {
    this.clearHeartbeat();
    this.lastAck = true;
    const jitter = Math.random();
    const firstDelay = Math.floor(intervalMs * jitter);
    logger.debug(`heartbeat every ${intervalMs}ms, first in ${firstDelay}ms`);

    const beat = () => {
      if (!this.lastAck) {
        logger.warn('heartbeat ACK missed, connection looks zombied, reconnecting');
        // Disarm first: a wedged socket whose close() never produces onclose
        // would otherwise spin close() on every tick. The close's onclose
        // (when it arrives) drives the reconnect via scheduleReconnect.
        this.clearHeartbeat();
        this.lastAck = true;
        try { this.ws?.close(4000, 'zombie'); } catch {}
        return;
      }
      this.lastAck = false;
      this.send(OPCODES.HEARTBEAT, this.seq);
    };

    setTimeout(() => {
      if (this.stopping || !this.ws) return;
      beat();
      this.heartbeatTimer = setInterval(beat, intervalMs);
    }, firstDelay);
  }

  identify() {
    logger.info('Identifying...');
    this.send(OPCODES.IDENTIFY, {
      token: config.token,
      intents: INTENTS,
      properties: { os: 'linux', browser: 'anon-chat-remake', device: 'anon-chat-remake' },
      presence: {
        status: 'online',
        activities: [{ name: '/new for an anonymous chat', type: 0 }],
        afk: false,
      },
    });
  }

  resume() {
    logger.info('Resuming session...');
    this.send(OPCODES.RESUME, { token: config.token, session_id: this.sessionId, seq: this.seq });
  }

  async handleMessage(raw, ws = null) {
    // Defense in depth: a frame arriving on a socket that is no longer the
    // live connection (abandoned connect attempt, stale close) must not run
    // against the replacement's state (HELLO handlers, heartbeats, seq).
    if (ws && ws !== this.ws) {
      logger.debug('dropping gateway frame from a stale socket');
      return;
    }
    let msg;
    try { msg = JSON.parse(raw); } catch { logger.warn('non-JSON gateway payload'); return; }
    const { op, t, s, d } = msg;
    if (s !== null && s !== undefined) this.seq = s;

    switch (op) {
      case OPCODES.HELLO: {
        // Validate before touching any timers: a missing/non-numeric
        // heartbeat_interval would make setInterval(beat, undefined) a ~1ms
        // hot loop (zombie branch then suicides the fresh socket), and a null
        // d would throw with _helloResolve never consumed (attempt burns the
        // full connect timeout). Fail this attempt fast instead: close the
        // socket so onclose -> die() rejects the connect promise and the
        // normal reconnect path picks it up immediately.
        const iv = Number(d?.heartbeat_interval);
        // Hunt 3 R3: bound above too. Node clamps setInterval delays > 2^31-1
        // ms to 1ms, so an absurd heartbeat_interval (e.g. 1e15) becomes a hot
        // loop whose zombie branch then suicides the fresh socket into an
        // infinite reconnect flap. Anything over an hour is nonsense.
        if (!Number.isFinite(iv) || iv <= 0 || iv > 3_600_000) {
          logger.warn(`malformed HELLO (heartbeat_interval=${d?.heartbeat_interval}), failing this connect attempt`);
          try { (ws ?? this.ws)?.close(4000, 'malformed HELLO'); } catch {}
          break;
        }
        this.startHeartbeat(iv);
        if (this._helloResolve) { const r = this._helloResolve; this._helloResolve = null; r(); }
        if (this.sessionId) this.resume();
        else this.identify();
        break;
      }
      case OPCODES.HEARTBEAT_ACK:
        this.lastAck = true;
        break;
      case OPCODES.HEARTBEAT:
        this.send(OPCODES.HEARTBEAT, this.seq);
        break;
      case OPCODES.DISPATCH:
        this.reconnectAttempt = 0; // healthy traffic resets backoff
        if (t === 'READY') {
          // Validate before storing anything: a missing d (or a non-string
          // session_id) used to throw mid-block, leaving a STALE sessionId in
          // place so the next HELLO resumed a dead session and flapped
          // through INVALID_SESSION. Fail safe to a fresh identify instead.
          const sid = typeof d?.session_id === 'string' && d.session_id ? d.session_id : null;
          if (!sid) {
            logger.warn('malformed READY (no session_id), clearing session state to identify fresh');
            this.sessionId = null;
            this.resumeUrl = null;
          } else {
            this.sessionId = sid;
            this.resumeUrl = d.resume_gateway_url;
            this.resumeFailures = 0;
            this.invalidSessionAttempts = 0;
            logger.info(`READY as ${d.user?.username || '?'} (session ${this.sessionId.slice(0, 8)}…)`);
          }
        } else if (t === 'RESUMED') {
          this.resumeFailures = 0;
          this.invalidSessionAttempts = 0;
          logger.info('Session RESUMED, replay complete.');
        }
        try { await this.onDispatch(t, d, msg); }
        catch (err) { logger.error(`error handling ${t}:`, err); }
        break;
      case OPCODES.RECONNECT:
        logger.warn('server asked to RECONNECT');
        try { this.ws?.close(4000, 'server reconnect'); } catch {}
        break;
      case OPCODES.INVALID_SESSION:
        if (d === true) {
          // Resumable, but not forever: bounded exponential backoff, then
          // give up and identify fresh instead of retrying on a fixed delay
          // until the heat death of the universe.
          //
          // In-flight guard: handleMessage has no mutual exclusion, so a flap
          // burst of N INVALID_SESSIONs must not schedule N concurrent
          // sleep->resume chains (N RESUME ops, and the attempt counter burning
          // N times for one logical event, spuriously exhausting the cap of 5
          // while stray RESUMEs draw more INVALID_SESSIONs). Set before
          // sleep(), cleared after resume().
          if (this._resumeInFlight) {
            logger.debug('duplicate INVALID_SESSION(d=true) ignored, resume already in flight');
            break;
          }
          this.invalidSessionAttempts = (this.invalidSessionAttempts || 0) + 1;
          if (this.invalidSessionAttempts > 5) {
            logger.warn('invalid session retries exhausted, starting a fresh session');
            this.invalidSessionAttempts = 0;
            this.sessionId = null; this.resumeUrl = null;
            try { this.ws?.close(4000, 'invalid session retries exhausted'); } catch {}
          } else {
            this._resumeInFlight = true;
            // Hunt 2 (B2a): generation token. Only the chain that set the flag
            // may clear it — a stale chain waking late must not clobber a
            // newer chain's flag. d=false and stop() bump the generation to
            // invalidate sleepers.
            const token = this._resumeSeq = (this._resumeSeq || 0) + 1;
            try {
              const wait = backoffMs(this.invalidSessionAttempts);
              // Hunt 2 (B2b): capture the socket + session identity before
              // sleeping. A d=false (or a fresh READY) mid-sleep means this
              // chain is stale: resuming then would send RESUME
              // {session_id: null, seq: 0} — or a duplicate RESUME — on the
              // fresh socket, a protocol violation that cascades into another
              // INVALID_SESSION and a self-inflicted flap.
              const ws = this.ws, sid = this.sessionId;
              logger.warn(`invalid session (resumable), retrying resume in ${wait}ms (attempt ${this.invalidSessionAttempts})`);
              await sleep(wait);
              if (!this.stopping && this.ws === ws && sid && this.sessionId === sid) {
                this.resume();
              } else {
                logger.debug('stale INVALID_SESSION resume chain skipped (socket or session moved on)');
              }
            } finally {
              if (this._resumeSeq === token) { this._resumeInFlight = false; this._resumeSeq = 0; }
            }
          }
        } else {
          logger.warn('invalid session (not resumable), starting fresh');
          this.seq = 0;
          this.sessionId = null; this.resumeUrl = null;
          // Hunt 2 (B2a/B2c): a non-resumable INVALID_SESSION kills the
          // session the sleeping chain belonged to. Clear its in-flight flag
          // (so a d=true for the NEW session is not swallowed as "duplicate")
          // and reset the attempt tally (so INVALID_SESSIONs on the new
          // connection do not count against the stale tally and prematurely
          // exhaust retries on a healthy socket).
          this._resumeInFlight = false;
          this._resumeSeq = (this._resumeSeq || 0) + 1;
          this.invalidSessionAttempts = 0;
          try { this.ws?.close(4000, 'invalid session'); } catch {}
        }
        break;
      default:
        logger.debug(`unhandled gateway op ${op} (t=${t})`);
    }
  }
}
