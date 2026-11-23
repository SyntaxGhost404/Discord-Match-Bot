import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { routeInfo, RateLimiter } from '../src/discord/rest/ratelimit.ts';
import { RestClient } from '../src/discord/rest/client.ts';
import { DiscordApiError, redactPath } from '../src/discord/rest/errors.ts';
import { cid, parseCustomId } from '../src/interactions/custom-id.ts';
import { validateMessagePayload, validateModal } from '../src/discord/components/validate.ts';
import { button, container, label, modal, row, stringSelect, option, text, textInput, v2, checkboxGroup, choice } from '../src/discord/components/builders.ts';
import { verifyInteractionSignature, publicKeyFromHex } from '../src/discord/http/verify.ts';
import { sniffImage, stripImageMetadata } from '../src/services/images.ts';
import { Shard } from '../src/discord/gateway/shard.ts';
import { silentLogger } from '../src/util/logger.ts';
import { ModalValues } from '../src/interactions/modal-values.ts';

test('route keys keep major parameters and collapse the rest', () => {
  assert.deepEqual(routeInfo('PATCH', '/channels/111111111111111111/messages/222222222222222222'), {
    route: 'PATCH /channels/:major/messages/:id',
    major: '111111111111111111',
    countsTowardGlobal: true,
  });
  assert.equal(routeInfo('PUT', '/channels/111111111111111111/messages/2222222222222222222/reactions/%F0%9F%91%8D/@me').route, 'PUT /channels/:major/messages/:id/reactions');
  const callback = routeInfo('POST', '/interactions/333333333333333333/token-abc/callback');
  assert.equal(callback.countsTowardGlobal, false);
  assert.equal(callback.major, '333333333333333333');
  assert.equal(routeInfo('POST', '/webhooks/444444444444444444/tok').countsTowardGlobal, false);
  assert.equal(redactPath('/interactions/333333333333333333/secret/callback'), '/interactions/333333333333333333/:token/callback');
});

test('an exhausted bucket waits for its reset instead of earning a 429', async () => {
  const limiter = new RateLimiter();
  const info = routeInfo('POST', '/channels/111111111111111111/messages');
  limiter.update(info, new Headers({ 'x-ratelimit-bucket': 'b1', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '0.2' }));
  const started = Date.now();
  await limiter.schedule(info, async () => undefined);
  assert.ok(Date.now() - started >= 180, 'waited for the bucket reset');
});

function fakeFetch(responses: Array<() => Response>, calls: Array<{ url: string; init: RequestInit }>): typeof fetch {
  return (async (url: URL | string | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next();
  }) as typeof fetch;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('REST client retries 429s using retry_after and returns parsed JSON', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = new RestClient({
    token: 'x.y.z',
    logger: silentLogger,
    fetch: fakeFetch([() => json({ message: 'slow down', retry_after: 0.05, global: false }, 429), () => json({ id: '1' })], calls),
  });
  const result = await client.request<{ id: string }>({ method: 'GET', path: '/users/@me' });
  assert.deepEqual(result, { id: '1' });
  assert.equal(calls.length, 2);
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, 'Bot x.y.z');
  assert.match((calls[0]!.init.headers as Record<string, string>)['User-Agent']!, /^DiscordBot \(/);
});

test('REST client retries server errors for GET but never for a plain POST', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = new RestClient({ token: 'x.y.z', logger: silentLogger, fetch: fakeFetch([() => json({}, 502), () => json({ ok: 1 })], calls) });
  assert.deepEqual(await client.request({ method: 'GET', path: '/gateway/bot' }), { ok: 1 });

  const postCalls: Array<{ url: string; init: RequestInit }> = [];
  const poster = new RestClient({ token: 'x.y.z', logger: silentLogger, fetch: fakeFetch([() => json({ message: 'bad gateway' }, 502)], postCalls) });
  await assert.rejects(poster.request({ method: 'POST', path: '/channels/111111111111111111/messages', body: { content: 'hi' } }), DiscordApiError);
  assert.equal(postCalls.length, 1);
});

test('REST client surfaces Discord error codes and sends multipart uploads', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = new RestClient({
    token: 'x.y.z',
    logger: silentLogger,
    fetch: fakeFetch([() => json({ code: 50007, message: 'Cannot send messages to this user' }, 403), () => new Response(null, { status: 204 })], calls),
  });
  const error = await client.request({ method: 'POST', path: '/channels/111111111111111111/messages', body: {} }).catch((e) => e);
  assert.ok(error instanceof DiscordApiError);
  assert.equal(error.code, 50007);

  await client.request({
    method: 'POST',
    path: '/interactions/333333333333333333/tok/callback',
    body: { type: 4 },
    files: [{ name: 'a.txt', data: new TextEncoder().encode('hello') }],
    auth: false,
  });
  const init = calls[1]!.init;
  assert.ok(init.body instanceof FormData);
  assert.equal((init.body as FormData).get('payload_json'), JSON.stringify({ type: 4 }));
  assert.ok((init.body as FormData).get('files[0]') instanceof Blob);
  assert.equal((init.headers as Record<string, string>).Authorization, undefined);
});

test('custom ids are validated and round-trip', () => {
  assert.equal(cid('dsc', 'like', 42), 'dsc:like:42');
  assert.deepEqual(parseCustomId('chat:rate:7:up'), { ns: 'chat', action: 'rate', args: ['7', 'up'] });
  assert.equal(parseCustomId('nocolon'), null);
  assert.equal(parseCustomId('a:b c'), null);
  assert.throws(() => cid('x', 'y', 'has:colon'));
  assert.throws(() => cid('x', 'y', 'z'.repeat(100)));
});

test('the payload validator catches documented limit violations', () => {
  assert.deepEqual(validateMessagePayload(v2([container([text('hello'), row(button('a:b', 'Go'))])])), []);
  const sixButtons = v2([row(...Array.from({ length: 6 }, (_, i) => button(`a:${i}`, 'x')))]);
  assert.ok(validateMessagePayload(sixButtons).some((i) => i.message.includes('more than 5 buttons')));
  const dup = v2([row(button('a:b', 'x'), button('a:b', 'y'))]);
  assert.ok(validateMessagePayload(dup).some((i) => i.message.includes('duplicate custom_id')));
  const tooLong = v2([text('x'.repeat(4001))]);
  assert.ok(validateMessagePayload(tooLong).length > 0);
  const v2WithContent = { ...v2([text('a')]), content: 'nope' };
  assert.ok(validateMessagePayload(v2WithContent).some((i) => i.path === 'content'));

  const good = modal('m:x', 'Title', [label('Name', textInput('name', { max: 32 })), label('Pick', checkboxGroup('c', [choice('a', 'A'), choice('b', 'B')], { min: 1, max: 2 }))]);
  assert.deepEqual(validateModal(good), []);
  const badLabel = modal('m:x', 'Title', [label('x'.repeat(46), textInput('name'))]);
  assert.ok(validateModal(badLabel).some((i) => i.message.includes('longer than 45')));
  const disabledSelect = modal('m:x', 'Title', [label('Pick', stringSelect('s', [option('a', 'A')], { disabled: true }))]);
  assert.ok(validateModal(disabledSelect).some((i) => i.message.includes('disabled')));
  const sixComponents = modal('m:x', 'T', Array.from({ length: 6 }, (_, i) => label(`L${i}`, textInput(`t${i}`))));
  assert.ok(validateModal(sixComponents).some((i) => i.message.includes('1-5')));
});

test('modal values are read through labels', () => {
  const values = new ModalValues({
    custom_id: 'x:y',
    components: [
      { type: 18, component: { type: 4, custom_id: 'name', value: 'Alex' } },
      { type: 18, component: { type: 21, custom_id: 'gender', value: 'man' } },
      { type: 18, component: { type: 22, custom_id: 'goals', values: ['friends', 'gaming'] } },
      { type: 18, component: { type: 23, custom_id: 'agree', value: true } },
      { type: 18, component: { type: 19, custom_id: 'photos', values: ['9'] } },
    ],
    resolved: { attachments: { '9': { id: '9', filename: 'a.png', size: 10, url: 'https://cdn/a.png' } } },
  });
  assert.equal(values.text('name'), 'Alex');
  assert.equal(values.radio('gender'), 'man');
  assert.deepEqual(values.values('goals'), ['friends', 'gaming']);
  assert.equal(values.checked('agree'), true);
  assert.equal(values.checked('missing'), false);
  assert.equal(values.attachments('photos')[0]?.filename, 'a.png');
});

test('Ed25519 interaction signatures are verified', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'jwk' }).x!;
  const hex = Buffer.from(raw, 'base64url').toString('hex');
  const key = publicKeyFromHex(hex);
  const now = Date.now();
  const timestamp = String(Math.floor(now / 1000));
  const body = Buffer.from('{"type":1}');
  const signature = sign(null, Buffer.concat([Buffer.from(timestamp), body]), privateKey).toString('hex');
  assert.equal(verifyInteractionSignature(key, signature, timestamp, body, { now }), true);
  assert.equal(verifyInteractionSignature(key, signature, timestamp, Buffer.from('{"type":2}'), { now }), false);
  assert.equal(verifyInteractionSignature(key, signature, timestamp, body, { now: now + 10 * 60_000 }), false);
  assert.equal(verifyInteractionSignature(key, undefined, timestamp, body, { now }), false);
});

test('image sniffing and metadata stripping', () => {
  // JPEG: SOI, APP0 (keep), APP1 Exif (drop), SOS + data.
  const app0 = [0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46];
  const app1 = [0xff, 0xe1, 0x00, 0x06, 0x45, 0x78, 0x69, 0x66];
  const jpeg = new Uint8Array([0xff, 0xd8, ...app0, ...app1, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]);
  assert.equal(sniffImage(jpeg), 'jpeg');
  const strippedJpeg = stripImageMetadata(jpeg, 'jpeg');
  assert.equal(Buffer.from(strippedJpeg).includes(Buffer.from('Exif')), false);
  assert.deepEqual([...strippedJpeg.subarray(0, 2)], [0xff, 0xd8]);
  assert.equal(strippedJpeg.length, jpeg.length - app1.length);

  // PNG: signature, IHDR, tEXt (drop), IEND.
  const chunk = (type: string, data: number[]) => {
    const len = [0, 0, 0, data.length];
    return [...len, ...Buffer.from(type), ...data, 0, 0, 0, 0];
  };
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', Array(13).fill(0)), ...chunk('tEXt', [0x41, 0x42]), ...chunk('IEND', [])]);
  assert.equal(sniffImage(png), 'png');
  const strippedPng = stripImageMetadata(png, 'png');
  assert.equal(Buffer.from(strippedPng).includes(Buffer.from('tEXt')), false);
  assert.equal(Buffer.from(strippedPng).includes(Buffer.from('IEND')), true);

  // WebP: RIFF, VP8X with EXIF flag, EXIF chunk (drop).
  const vp8x = [...Buffer.from('VP8X'), 10, 0, 0, 0, 0x08, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const exif = [...Buffer.from('EXIF'), 2, 0, 0, 0, 0x01, 0x02];
  const body = [...Buffer.from('WEBP'), ...vp8x, ...exif];
  const size = body.length;
  const webp = new Uint8Array([...Buffer.from('RIFF'), size & 0xff, (size >> 8) & 0xff, 0, 0, ...body]);
  assert.equal(sniffImage(webp), 'webp');
  const strippedWebp = stripImageMetadata(webp, 'webp');
  assert.equal(Buffer.from(strippedWebp).includes(Buffer.from('EXIF')), false);
  assert.equal(strippedWebp[20]! & 0x08, 0, 'EXIF flag cleared in VP8X');
  assert.equal(sniffImage(new TextEncoder().encode('not an image at all')), null);
});

// -- gateway shard against a scripted fake socket ------------------------------------------

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1;
  binaryType = 'blob';
  sent: Array<{ op: number; d: unknown }> = [];
  closed: number | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code: number) {
    this.closed = code;
  }
  receive(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  serverClose(code: number) {
    this.onclose?.({ code, reason: '' });
  }
}

const flush = () => new Promise((r) => setTimeout(r, 5));

test('gateway shard identifies, resumes after RECONNECT and stops on fatal codes', async (t) => {
  FakeSocket.instances = [];
  const events: string[] = [];
  let fatal: number | null = null;
  const shard = new Shard({
    id: 0,
    count: 1,
    token: 'tok',
    intents: 4096,
    gatewayUrl: 'wss://gateway.example',
    logger: silentLogger,
    identifyGate: async () => {},
    onDispatch: (event) => events.push(event),
    onFatal: (_s, code) => (fatal = code),
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
  });
  t.after(() => shard.destroy());
  shard.connect();
  const first = FakeSocket.instances[0]!;
  assert.match(first.url, /v=10&encoding=json/);
  first.receive({ op: 10, d: { heartbeat_interval: 45_000 }, s: null, t: null });
  await flush();
  const identify = first.sent.find((p) => p.op === 2);
  assert.ok(identify, 'identify sent after HELLO');
  assert.deepEqual((identify!.d as { shard: number[] }).shard, [0, 1]);

  first.receive({ op: 0, t: 'READY', s: 1, d: { session_id: 'sess', resume_gateway_url: 'wss://resume.example', user: { username: 'bot' }, guilds: [] } });
  assert.equal(shard.status, 'ready');
  assert.deepEqual(events, ['READY']);

  first.receive({ op: 7, d: null, s: null, t: null });
  assert.equal(first.closed, 4000, 'closed with a resumable code');
  await new Promise((r) => setTimeout(r, 50));
  const second = FakeSocket.instances[1]!;
  assert.match(second.url, /^wss:\/\/resume\.example/);
  second.receive({ op: 10, d: { heartbeat_interval: 45_000 }, s: null, t: null });
  await flush();
  const resume = second.sent.find((p) => p.op === 6);
  assert.deepEqual(resume?.d, { token: 'tok', session_id: 'sess', seq: 1 });

  second.serverClose(4004);
  assert.equal(fatal, 4004);
  assert.equal(shard.status, 'destroyed');
});

test('gateway shard re-identifies after a non-resumable invalid session', async (t) => {
  FakeSocket.instances = [];
  const shard = new Shard({
    id: 0,
    count: 1,
    token: 'tok',
    intents: 4096,
    gatewayUrl: 'wss://gateway.example',
    logger: silentLogger,
    identifyGate: async () => {},
    onDispatch: () => {},
    onFatal: () => {},
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
  });
  t.after(() => shard.destroy());
  shard.connect();
  const first = FakeSocket.instances[0]!;
  first.receive({ op: 10, d: { heartbeat_interval: 45_000 }, s: null, t: null });
  await flush();
  first.receive({ op: 0, t: 'READY', s: 5, d: { session_id: 'old', resume_gateway_url: 'wss://resume.example', user: {}, guilds: [] } });
  first.receive({ op: 9, d: false, s: null, t: null });
  await new Promise((r) => setTimeout(r, 5200));
  const second = FakeSocket.instances[1]!;
  assert.match(second.url, /^wss:\/\/gateway\.example/, 'fresh sessions use the original gateway url');
  second.receive({ op: 10, d: { heartbeat_interval: 45_000 }, s: null, t: null });
  await flush();
  assert.ok(second.sent.some((p) => p.op === 2), 'identified again');
  assert.ok(!second.sent.some((p) => p.op === 6), 'did not try to resume');
});
