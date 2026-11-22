// Minimal scriptable mock of Discord's gateway WebSocket, for patch-infra
// regression tests. Speaks just enough RFC 6455: HTTP upgrade handshake,
// unmasked server->client text frames, masked client->server frame parsing.
//   const gw = await startMockGatewayServer({ heartbeatInterval: 100 });
//   gw.url            -> ws://127.0.0.1:PORT to hand to the Gateway under test
//   gw.received       -> [{ op, d }] client frames seen so far
//   gw.connections()  -> number of TCP connections accepted
//   await gw.close()
import http from 'node:http';
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function sendText(sock, obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeUInt32BE(0, 2); header.writeUInt32BE(payload.length, 6);
  }
  sock.write(Buffer.concat([header, payload]));
}

// Parse masked client frames; invokes onMessage(op, d) per text frame.
function pumpFrames(sock, onMessage) {
  let buf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0], b1 = buf[1];
      const opcode = b0 & 0x0f;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2)); off = 10;
      }
      const mlen = (b1 & 0x80) !== 0 ? 4 : 0;
      if (buf.length < off + mlen + len) return;
      let payload = buf.subarray(off + mlen, off + mlen + len);
      if (mlen) {
        const key = buf.subarray(off, off + 4);
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ key[i & 3];
        payload = out;
      }
      buf = buf.subarray(off + mlen + len);
      if (opcode === 0x8) { try { sock.destroy(); } catch {} return; } // close
      if (opcode === 0x9) { // ping -> pong
        sock.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
        continue;
      }
      if (opcode === 0x1) {
        try { const msg = JSON.parse(payload.toString('utf8')); onMessage(msg.op, msg.d); }
        catch { /* ignore malformed */ }
      }
    }
  });
}

export function startMockGatewayServer({ heartbeatInterval = 100 } = {}) {
  const received = [];
  let connCount = 0;
  const socks = new Set();
  const server = http.createServer();
  server.on('upgrade', (req, sock) => {
    connCount++;
    socks.add(sock);
    sock.on('close', () => socks.delete(sock));
    const key = req.headers['sec-websocket-key'] || '';
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    sock.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const resumeUrl = `ws://127.0.0.1:${server.address().port}`;
    sendText(sock, { op: 10, d: { heartbeat_interval: heartbeatInterval } });
    pumpFrames(sock, (op, d) => {
      received.push({ op, d });
      if (op === 2) { // IDENTIFY -> READY
        sendText(sock, {
          op: 0, s: 1, t: 'READY',
          d: { session_id: 'mock-session-1', resume_gateway_url: resumeUrl, user: { username: 'mockbot' } },
        });
      } else if (op === 6) { // RESUME -> RESUMED
        sendText(sock, { op: 0, s: 2, t: 'RESUMED', d: {} });
      } else if (op === 1) { // heartbeat -> ack
        sendText(sock, { op: 11, d: null });
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `ws://127.0.0.1:${server.address().port}`,
        received,
        connections: () => connCount,
        close: () => new Promise((r) => { for (const x of socks) x.destroy(); server.close(r); }),
      });
    });
  });
}
