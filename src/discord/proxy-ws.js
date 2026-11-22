// Minimal RFC 6455 WebSocket client that tunnels through an HTTP(S) proxy via
// the CONNECT method. Node's native WebSocket does not honor *_proxy env vars,
// so on networks where direct egress is blocked the gateway handshake fails
// (close 1006 before HELLO). This shim exposes the same small API surface that
// gateway.js uses: new X(url, proxyUrl), onopen/onmessage/onclose/onerror,
// send(string), close(code, reason), readyState, and static ready-state consts.
//
// Only text frames are produced/consumed by the Discord gateway; binary,
// ping/pong and close control frames are handled per spec.

import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

export const WS_CONNECTING = 0;
export const WS_OPEN = 1;
export const WS_CLOSING = 2;
export const WS_CLOSED = 3;

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 32 * 1024 * 1024; // sanity cap per frame

function hostBypassed(host, list) {
  return list.some((entry) => {
    if (entry === '*') return true;
    if (entry.startsWith('.')) return host.endsWith(entry);
    return host === entry || host.endsWith('.' + entry);
  });
}

/** Proxy URL (string) that should be used for `url`, or null for direct. */
export function proxyForUrl(url) {
  try {
    const u = new URL(url);
    const raw = u.protocol === 'wss:'
      ? (process.env.https_proxy || process.env.HTTPS_PROXY)
      : (process.env.http_proxy || process.env.HTTP_PROXY);
    if (!raw) return null;
    const noProxy = (process.env.no_proxy || process.env.NO_PROXY || '')
      .split(',').map((s) => s.trim().toLowerCase().replace(/^\[|\]$/g, '')).filter(Boolean);
    if (hostBypassed(u.hostname.toLowerCase(), noProxy)) return null;
    return raw;
  } catch {
    return null;
  }
}

export class ProxyWebSocket {
  static CONNECTING = WS_CONNECTING;
  static OPEN = WS_OPEN;
  static CLOSING = WS_CLOSING;
  static CLOSED = WS_CLOSED;

  constructor(url, proxyUrl) {
    this.url = url;
    this._proxyUrl = proxyUrl;
    this.readyState = WS_CONNECTING;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this._buf = Buffer.alloc(0);
    this._frag = null; // { opcode, parts: [] }
    this._phase = 'connect'; // connect -> tls -> ws-handshake -> frames
    this._wsKey = crypto.randomBytes(16).toString('base64');
    // Match the native constructor: connect async so handlers can be attached first.
    setImmediate(() => this._start());
  }

  // -- internal plumbing ---------------------------------------------------

  _fail(err) {
    if (this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSED;
    const e = err instanceof Error ? err : new Error(String(err));
    if (this.onerror) { try { this.onerror(e); } catch {} }
    if (this.onclose) { try { this.onclose({ code: 1006, reason: e.message }); } catch {} }
    try { this._sock?.destroy(); } catch {}
  }

  _terminate(code, reason) {
    if (this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSED;
    try { this._sock?.destroy(); } catch {}
    if (this.onclose) { try { this.onclose({ code, reason: String(reason || '') }); } catch {} }
  }

  _start() {
    let proxy;
    try {
      proxy = new URL(this._proxyUrl);
    } catch (e) { return this._fail(e); }
    const target = new URL(this.url);
    this._targetHost = target.hostname;
    this._targetPort = target.port ? Number(target.port) : (target.protocol === 'wss:' ? 443 : 80);
    this._targetPath = (target.pathname || '/') + (target.search || '');

    const beginConnect = (sock) => {
      this._sock = sock;
      sock.on('data', (d) => this._onTunnelData(d));
      sock.on('error', (e) => this._fail(e));
      sock.on('close', () => this._terminate(1006, 'tunnel closed'));
      let req = `CONNECT ${this._targetHost}:${this._targetPort} HTTP/1.1\r\n` +
        `Host: ${this._targetHost}:${this._targetPort}\r\n` +
        `Proxy-Connection: Keep-Alive\r\n`;
      if (proxy.username) {
        const auth = Buffer.from(
          `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
        ).toString('base64');
        req += `Proxy-Authorization: Basic ${auth}\r\n`;
      }
      sock.write(req + '\r\n');
    };

    if (proxy.protocol === 'https:') {
      const s = tls.connect({ host: proxy.hostname, port: Number(proxy.port) || 443, servername: proxy.hostname });
      s.once('secureConnect', () => beginConnect(s));
      s.once('error', (e) => this._fail(e));
    } else {
      const s = net.connect({ host: proxy.hostname, port: Number(proxy.port) || 8080 });
      s.once('connect', () => beginConnect(s));
      s.once('error', (e) => this._fail(e));
    }
  }

  _onTunnelData(chunk) {
    // Hunt 8 (S8a): close() during CONNECTING must stop the handshake. A
    // proxy 200 arriving after close() must not advance the phase toward TLS
    // (which would later flip readyState back to OPEN and fire onopen).
    if (this.readyState === WS_CLOSING || this.readyState === WS_CLOSED) return;
    this._buf = Buffer.concat([this._buf, chunk]);
    const idx = this._buf.indexOf('\r\n\r\n');
    if (idx === -1) return; // wait for full headers
    const head = this._buf.subarray(0, idx).toString('latin1');
    this._buf = this._buf.subarray(idx + 4);
    const statusLine = head.split('\r\n')[0] || '';
    if (!/^HTTP\/\d(\.\d)? 200/.test(statusLine)) {
      return this._fail(new Error('proxy CONNECT rejected: ' + statusLine));
    }
    // The tunnel is up; the server cannot have sent anything yet (TLS handshake
    // is client-initiated), so leftover bytes are not a concern.
    this._sock.removeAllListeners('data');
    this._sock.removeAllListeners('error');
    this._sock.removeAllListeners('close');
    this._phase = 'tls';
    const tlsSock = tls.connect({ socket: this._sock, servername: this._targetHost });
    tlsSock.once('secureConnect', () => {
      this._sock = tlsSock;
      this._phase = 'ws-handshake';
      tlsSock.on('data', (d) => this._onTlsData(d));
      tlsSock.on('error', (e) => this._fail(e));
      tlsSock.on('close', () => this._terminate(1006, 'connection closed'));
      tlsSock.write(
        `GET ${this._targetPath} HTTP/1.1\r\n` +
        `Host: ${this._targetHost}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${this._wsKey}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    tlsSock.once('error', (e) => this._fail(e));
  }

  _onTlsData(chunk) {
    // Hunt 8 (S8a/S8b): a 101 handshake arriving after close() must not flip
    // readyState back to OPEN / fire onopen, and frames arriving while
    // CLOSING must not be parsed or dispatched.
    if (this.readyState === WS_CLOSING || this.readyState === WS_CLOSED) return;
    this._buf = Buffer.concat([this._buf, chunk]);
    if (this._phase === 'ws-handshake') {
      const idx = this._buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const head = this._buf.subarray(0, idx).toString('latin1');
      this._buf = this._buf.subarray(idx + 4);
      const lines = head.split('\r\n');
      if (!/^HTTP\/\d(\.\d)? 101/.test(lines[0] || '')) {
        return this._fail(new Error('websocket upgrade rejected: ' + (lines[0] || '')));
      }
      const accept = (lines.find((l) => /^sec-websocket-accept:/i.test(l)) || '').split(':')[1]?.trim();
      const expected = crypto.createHash('sha1').update(this._wsKey + WS_GUID).digest('base64');
      if (accept !== expected) return this._fail(new Error('bad Sec-WebSocket-Accept'));
      this._phase = 'frames';
      this.readyState = WS_OPEN;
      if (this.onopen) { try { this.onopen(); } catch {} }
    }
    if (this._phase === 'frames') this._parseFrames();
  }

  _parseFrames() {
    while (this.readyState !== WS_CLOSED) {
      if (this._buf.length < 2) return;
      const b0 = this._buf[0];
      const b1 = this._buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this._buf.length < 4) return;
        len = this._buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this._buf.length < 10) return;
        const hi = this._buf.readUInt32BE(2);
        const lo = this._buf.readUInt32BE(6);
        if (hi !== 0 || lo > MAX_FRAME) return this._fail(new Error('frame too large'));
        len = lo;
        off = 10;
      }
      if (len > MAX_FRAME) return this._fail(new Error('frame too large'));
      const mlen = masked ? 4 : 0;
      if (this._buf.length < off + mlen + len) return;
      let payload = this._buf.subarray(off + mlen, off + mlen + len);
      if (masked) {
        const key = this._buf.subarray(off, off + 4);
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ key[i & 3];
        payload = out;
      }
      this._buf = this._buf.subarray(off + mlen + len);
      this._onFrame(fin, opcode, payload);
    }
  }

  _onFrame(fin, opcode, payload) {
    if (opcode === 0x8) { // close
      let code = 1005;
      let reason = '';
      if (payload.length >= 2) {
        code = payload.readUInt16BE(0);
        reason = payload.subarray(2).toString('utf8');
      }
      if (this.readyState === WS_OPEN) this._sendFrame(0x8, payload); // echo close
      this._terminate(code, reason);
      return;
    }
    if (opcode === 0x9) { // ping -> pong
      this._sendFrame(0xa, payload);
      return;
    }
    if (opcode === 0xa) return; // pong
    if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) { // data / continuation
      if (opcode !== 0x0) this._frag = { opcode, parts: [] };
      if (!this._frag) return; // stray continuation
      this._frag.parts.push(payload);
      if (fin) {
        const data = Buffer.concat(this._frag.parts);
        const isText = this._frag.opcode === 0x1;
        this._frag = null;
        if (isText && this.onmessage) {
          try { this.onmessage({ data: data.toString('utf8') }); } catch {}
        }
      }
      return;
    }
    // unknown opcode: drop
  }

  _sendFrame(opcode, payload) {
    if (!this._sock || this.readyState === WS_CLOSED) return;
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode; header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode; header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2); header.writeUInt32BE(payload.length, 6);
    }
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
    this._sock.write(Buffer.concat([header, mask, masked]));
  }

  // -- public API --------------------------------------------------------

  send(data) {
    if (this.readyState !== WS_OPEN) return;
    this._sendFrame(0x1, Buffer.from(String(data), 'utf8'));
  }

  close(code = 1000, reason = '') {
    if (this.readyState === WS_CLOSED || this.readyState === WS_CLOSING) return;
    if (this.readyState === WS_OPEN) {
      const r = Buffer.from(String(reason), 'utf8');
      const payload = Buffer.alloc(2 + r.length);
      payload.writeUInt16BE(code, 0);
      r.copy(payload, 2);
      this._sendFrame(0x8, payload);
    }
    this.readyState = WS_CLOSING;
    const t = setTimeout(() => this._terminate(1006, 'close timeout'), 2000);
    if (typeof t.unref === 'function') t.unref();
  }
}
