// Verification suite for the anon-chat-remake.
// Run: node tests/remake.mjs   (also: npm test)
// Mocks globalThis.fetch: Discord API -> canned JSON; CDN downloads -> tiny PNG.
// NEVER touches the real Discord API. Exits non-zero on any failure.

process.env.DATA_DIR = './tests/.data-remake';
process.env.APPLICATION_ID = 'app123';
process.env.DISCORD_TOKEN = 'test-token';
process.env.LOG_LEVEL = 'error';

const { rmSync, readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
rmSync('./tests/.data-remake', { recursive: true, force: true });

// ---------------------------------------------------------------------------
// fetch mock
// ---------------------------------------------------------------------------

const sent = []; // every captured Discord API request { url, method, body }
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ftyp = (brand) => Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftyp', 'ascii'), Buffer.from(brand, 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08]),
]);
const ebml = (doctype) => Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03]),
  Buffer.from(doctype, 'ascii'), Buffer.from([0x00]),
]);
// Magic bytes served for mocked CDN downloads, keyed by the URL's extension,
// so the relay's content-sniffing layer sees realistic bytes in tests.
const magicForUrl = (u) => {
  if (u.includes('spoof')) return Buffer.from('SPOOF TEST FILE\nplain text, no image bytes\n', 'utf8');
  const ext = String(u.split('?')[0].split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'png': return PNG;
    case 'jpg': case 'jpeg': return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    case 'gif': return Buffer.from('GIF89a', 'ascii');
    case 'bmp': return Buffer.from([0x42, 0x4d, 0x00, 0x00]);
    case 'webp': return Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP', 'ascii')]);
    case 'mp4': case 'mov': case 'm4v': return ftyp('isom');
    case 'm4a': return ftyp('M4A ');
    case 'webm': return ebml('webm');
    case 'weba': return ebml('weba');
    case 'mp3': return Buffer.from('ID3\x04\x00\x00\x00\x00\x01\x02', 'binary');
    case 'ogg': case 'opus': case 'oga': return Buffer.from('OggS\x00\x02\x00\x00', 'binary');
    case 'wav': return Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVE', 'ascii')]);
    case 'flac': return Buffer.from('fLaC\x00\x00\x00\x22', 'binary');
    case 'aac': return Buffer.from([0xff, 0xf1, 0x50, 0x80]);
    case 'txt': case 'md': case 'markdown': return Buffer.from('just a plain text note\n', 'utf8');
    default: return PNG;
  }
};
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

// Unique message ids per send, so tests can distinguish greeting cards
// across sessions (the real API always returns a fresh id).
let msgSeq = 0;

// User ids whose DM-channel message POSTs should fail with 50007 (closed
// DMs). Lets regression tests simulate a greeting DM that never lands.
const failDMFor = new Set();
// Failure-injection controls for the patch regression sections (all start
// empty/disabled, so the pre-existing sections are unaffected).
const fail10003For = new Set(); // uid -> ONE-SHOT: next DM POST fails 404/10003
const fail403For = new Map();   // uid -> json code; ONE-SHOT: next DM POST fails 403
const failDownloadFor = new Set(); // url substring -> CDN download returns 500
let failCallbackOnce = false;   // next /interactions/*/callback throws (transport failure)
let hangDefer = false;          // deferUpdate callbacks (type 6) hang until released
let deferResolvers = [];
const mockRest = { gatewayBotFailTimes: 0 }; // scriptable REST failures for gateway tests

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://discord.com/api/v10')) {
    const method = (opts.method || 'GET').toUpperCase();
    if (failCallbackOnce && u.includes('/interactions/') && u.endsWith('/callback')) {
      failCallbackOnce = false;
      throw new Error('simulated callback transport failure');
    }
    // Scriptable gateway REST failures (infra section, test O).
    if (u.endsWith('/gateway/bot') && method === 'GET') {
      if (mockRest.gatewayBotFailTimes > 0) {
        mockRest.gatewayBotFailTimes--;
        throw new Error('mock REST outage');
      }
      return json({ url: globalThis.mockWsUrl || 'ws://127.0.0.1:1', shards: 1 });
    }
    let body = null;
    const b = opts.body;
    if (typeof b === 'string') {
      try { body = JSON.parse(b); } catch { /* ignore */ }
    } else if (b && typeof b.get === 'function') {
      // FormData multipart: payload_json + files[i]
      try { body = JSON.parse(b.get('payload_json')); } catch { body = {}; }
      body._multipart = true;
    }
    sent.push({ url: u, method, body });
    if (hangDefer && body?.type === 6) {
      await new Promise((res) => deferResolvers.push(res));
    }
    if (u.endsWith('/users/@me/channels') && method === 'POST') {
      return json({ id: `dm_${body?.recipient_id}` });
    }
    const um = u.match(/\/users\/([A-Za-z0-9_]+)$/);
    if (um && method === 'GET') {
      return json({ id: um[1], username: `user_${um[1]}`, global_name: null });
    }
    // Simulated DM failures: one-shot 10003/403 self-heal probes, then the
    // terminal 50007 closed-DMs case, like the real API.
    if (method === 'POST') {
      const cm = u.match(/\/channels\/dm_([A-Za-z0-9_]+)\/messages$/);
      if (cm) {
        const uid = cm[1];
        if (fail10003For.has(uid)) {
          fail10003For.delete(uid);
          return json({ message: 'Unknown Channel', code: 10003 }, 404);
        }
        if (fail403For.has(uid)) {
          const code = fail403For.get(uid);
          fail403For.delete(uid);
          return json({ message: 'Forbidden', code }, 403);
        }
        if (failDMFor.has(uid)) {
          return json({ message: 'Cannot send messages to this user', code: 50007 }, 403);
        }
      }
    }
    return json({ id: `msg${++msgSeq}` });
  }
  // CDN / attachment downloads: injected failures first, then magic bytes
  // matching the URL's extension.
  if (failDownloadFor.size && [...failDownloadFor].some((m) => u.includes(m))) {
    return new Response('download failed', { status: 500 });
  }
  return new Response(magicForUrl(u), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
};

// ---------------------------------------------------------------------------
// imports (after env + mock are in place)
// ---------------------------------------------------------------------------

const { db } = await import('../src/services/database.js');
const { safety } = await import('../src/services/safety.js');
const { matchmaking } = await import('../src/services/matchmaking.js');
const chat = await import('../src/services/chat.js');
const newCmd = await import('../src/commands/new.js');
const leaveCmd = await import('../src/commands/leave.js');
const endCmd = await import('../src/commands/end.js');
const blockCmd = await import('../src/commands/block.js');
const blocklistCmd = await import('../src/commands/blocklist.js');
const unblockCmd = await import('../src/commands/unblock.js');
const shareCmd = await import('../src/commands/share.js');
const statsCmd = await import('../src/commands/stats.js');
const reportCmd = await import('../src/commands/report.js');
const profileCmd = await import('../src/commands/profile.js');
const embeds = await import('../src/utils/embeds.js');
const { routeInteraction } = await import('../src/router.js');
const dobUtils = await import('../src/utils/dob.js');

db.load();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : (fail++, console.log('FAIL:', name)); };
const str = (o) => JSON.stringify(o);

const user = (id) => ({ id: String(id), username: `user_${id}`, global_name: null });
const cmdIx = (name, uid, options) => ({ id: 'ix', token: 'tok', type: 2, user: user(uid), data: { name, options } });
const btnIx = (customId, uid, { channelId = 'dm_x', messageId = 'm1', flags = 0, values, components } = {}) => ({
  id: 'ix', token: 'tok', type: 3, user: user(uid), channel_id: channelId,
  data: { custom_id: customId, ...(values ? { values } : {}) },
  message: { id: messageId, flags, ...(components ? { components } : {}) },
});
const modalIx = (customId, uid, pairs) => ({
  id: 'ix', token: 'tok', type: 5, user: user(uid), channel_id: 'dm_x',
  message: { id: 'm1', channel_id: 'dm_x' },
  data: {
    custom_id: customId,
    components: pairs.map(([cid, value]) => ({ type: 1, components: [{ type: 4, custom_id: cid, value }] })),
  },
});
/** Modal submit with Label-wrapped inputs + File Upload components. */
const modalUploadIx = (customId, uid, { texts = {}, uploads = {}, attachments = {}, sizeLimit } = {}) => {
  const comps = [];
  for (const [cid, v] of Object.entries(texts)) {
    comps.push({ type: 18, component: { type: 4, custom_id: cid, value: v } });
  }
  for (const [cid, vs] of Object.entries(uploads)) {
    comps.push({ type: 18, component: { type: 19, custom_id: cid, values: vs } });
  }
  const ix = {
    id: 'ix', token: 'tok', type: 5, user: user(uid), channel_id: 'dm_x',
    message: { id: 'm1', channel_id: 'dm_x' },
    data: { custom_id: customId, components: comps, resolved: { attachments } },
  };
  if (sizeLimit) ix.attachment_size_limit = sizeLimit;
  return ix;
};
/** A CDN-style attachment fixture for upload tests. */
const attFixture = (id, filename = 'pic.png', content_type = 'image/png') => ({
  [id]: { url: `https://cdn.discordapp.com/${id}/${filename}`, filename, content_type, size: 100 },
});
/** Last webhook edit of an interaction's original response. */
const lastEditOriginal = () => [...sent].reverse().find((s) => s.url.includes('/messages/@original'))?.body;

const reset = () => {
  db._resetForTests();
  matchmaking._resetForTests();
  chat._resetRelayForTests();
  chat._resetModForTests();
  if (typeof chat._resetFizzleForTests === 'function') chat._resetFizzleForTests();
  failDMFor.clear();
  fail10003For.clear();
  fail403For.clear();
  failDownloadFor.clear();
  failCallbackOnce = false;
  hangDefer = false;
  deferResolvers = [];
  sent.length = 0;
};

// Source snapshot for white-box asserts (chatdb fix 5 timeout, fix G ordering).
const __chatSrc = readFileSync('./src/services/chat.js', 'utf8');
// Test-only controls for the patch regression sections.
const __armDeferHang = () => { hangDefer = true; };
const __releaseDefer = () => { hangDefer = false; deferResolvers.splice(0).forEach((r) => r()); };
const __tick = (n = 8) => new Promise((res) => { const s = () => (n-- > 0 ? setImmediate(s) : res()); s(); });
const __failCallbackOnce = () => { failCallbackOnce = true; };
const __writeDbFile = (text) => writeFileSync('./tests/.data-remake/db.json', text);

const callbacks = () => sent.filter((s) => s.url.includes('/interactions/') && s.body?.type);
const lastCb = () => callbacks()[callbacks().length - 1]?.body;
const cbData = () => lastCb()?.data;
const dmPosts = (uid) => sent.filter((s) => s.url.includes(`/channels/dm_${uid}/messages`) && s.method === 'POST');
const dmPatches = (uid) => sent.filter((s) => s.url.includes(`/channels/dm_${uid}/messages`) && s.method === 'PATCH');
const reactions = (uid) => sent.filter((s) => s.url.includes(`/channels/dm_${uid}/messages`) && s.method === 'PUT' && s.url.includes('/reactions/'));

/** Greeting message id the session retained for a user. */
const greetingMsgId = (uid) => db.getActiveSessionForUser(uid)?.greeting?.[uid]?.messageId;

/** True when a PATCH body is the disabled-buttons greeting card. */
const greetingButtonsDisabled = (body) => {
  const btns = [];
  for (const c of body.components?.[0]?.components || []) {
    if (c.type === 1) for (const b of c.components || []) if (b.type === 2) btns.push(b);
  }
  const end = btns.find((b) => b.custom_id === 'chat_end');
  const rep = btns.find((b) => b.custom_id === 'chat_report');
  return end?.disabled === true && end?.style === 4 && rep?.disabled === true && rep?.style === 2;
};

async function matchPair(a, b) {
  onboarded(a);
  onboarded(b);
  await newCmd.execute(cmdIx('new', a));
  sent.length = 0;
  await newCmd.execute(cmdIx('new', b));
  sent.length = 0;
}

/** ISO dob ("YYYY-MM-DD") that yields exactly `age` years today. */
function dobForAge(age) {
  const n = new Date();
  let d = n.getUTCDate();
  const m = n.getUTCMonth() + 1;
  if (m === 2 && d === 29) d = 28; // clamp leap day so the date always exists
  const y = n.getUTCFullYear() - age;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Create the profile record the router's onboarding gate requires. */
function onboarded(id) {
  return db.createProfile({ id: String(id), name: `user_${id}`, dob: dobForAge(20), interests: [] });
}

/** Onboard with a specific age (via a DOB that yields it today). */
const aged = (id, age) => db.createProfile({ id: String(id), alias: `u${id}`, dob: dobForAge(age), interests: [] });
/** ISO dob exactly `years` (fractional) before right now, for window tests. */
const dobYearsAgo = (years) => new Date(Date.now() - years * 365.25 * 86400000).toISOString().slice(0, 10);
/** Onboard with an exact fractional age (e.g. 16.5). */
const agedExact = (id, years) => db.createProfile({ id: String(id), alias: `u${id}`, dob: dobYearsAgo(years), interests: [] });

// ---------------------------------------------------------------------------
// A. command definitions
// ---------------------------------------------------------------------------

reset();
{
  const cmds = [newCmd, leaveCmd, endCmd, blockCmd, blocklistCmd, unblockCmd, shareCmd, statsCmd, reportCmd, profileCmd];
  ok(cmds.length === 10, 'ten commands');
  ok(cmds.every((c) => c.data.integration_types.join() === '0,1' && c.data.contexts.join() === '0,1'),
    'all commands enabled for guild + user installs');
  const unblockOpt = unblockCmd.data.options?.[0];
  ok(unblockOpt?.name === 'anonymous_id' && unblockOpt?.type === 3 && unblockOpt?.required === true,
    '/unblock has required anonymous_id string option');
  ok(newCmd.data.name === 'new' && blocklistCmd.customIds.includes('unblock_select'),
    'command names + customIds wiring');
}

// ---------------------------------------------------------------------------
// A2. date-of-birth utilities: validation, dynamic age, tiers, bands
// ---------------------------------------------------------------------------

{
  const { parseDOB, checkDOBAge, ageFromDOB, tierOfAge, withinYears, gapYears, formatDOB } = dobUtils;

  // parseDOB: shape + calendar validity
  ok(parseDOB('15', '8', '2001').ok && parseDOB('15', '8', '2001').dob === '2001-08-15',
    'valid DOB parses to ISO');
  ok(parseDOB('29', '2', '2000').ok, 'Feb 29 valid on a leap year');
  ok(!parseDOB('29', '2', '2001').ok, 'Feb 29 rejected on a non-leap year');
  ok(!parseDOB('30', '2', '2000').ok, 'Feb 30 rejected');
  ok(!parseDOB('31', '4', '2000').ok, 'April 31 rejected');
  ok(!parseDOB('abc', '8', '2001').ok, 'non-numeric day rejected');
  ok(!parseDOB('15', '13', '2001').ok, 'month 13 rejected');
  const nextYear = new Date().getUTCFullYear() + 1;
  ok(!parseDOB('1', '1', String(nextYear)).ok, 'future year rejected');
  ok(!parseDOB('', '', '').ok, 'blank DOB rejected');

  // ageFromDOB: exact age at day precision, incl. birthday boundaries
  const D = (iso) => new Date(iso + 'T12:00:00Z');
  ok(ageFromDOB('2001-09-18', D('2026-09-17')) === 24, 'age 24 the day before the birthday');
  ok(ageFromDOB('2001-09-18', D('2026-09-18')) === 25, 'age 25 on the birthday itself');
  ok(ageFromDOB('2000-02-29', D('2026-02-27')) === 25, 'Feb 29 birthday: 25 on Feb 27 of a non-leap year');
  ok(ageFromDOB('2000-02-29', D('2026-02-28')) === 26, 'Feb 29 birthday: 26 on Feb 28 of a non-leap year');

  // tiers and the sliding window helpers, with the birthday crossing updating automatically
  ok(tierOfAge(17) === 'minor' && tierOfAge(18) === 'adult', 'tier wall at 18');
  ok(tierOfAge(null) === 'minor', 'unknown age fails safe to minor');
  ok(withinYears('2009-09-18', '2011-09-18', 2), 'exactly 2.0 calendar years apart is within the window');
  ok(!withinYears('2009-09-18', '2011-09-19', 2), '2 years and 1 day apart is outside the window');
  ok(!withinYears('2009-09-18', '2011-09-18', 1), 'exactly 2.0 years apart exceeds a 1 year cap');
  ok(withinYears('2008-02-29', '2010-02-28', 2), 'Feb 29 clamps to Feb 28 for the leap-year boundary');
  ok(withinYears('2011-09-18', '2009-09-18', 2), 'window is symmetric regardless of argument order');
  ok(Math.abs(gapYears('2009-09-18', '2011-09-18') - 2.0) < 0.01, 'gapYears scores ~2.0 for a 2 year gap');
  ok(gapYears('2009-09-18', '2010-03-18') < gapYears('2009-09-18', '2011-09-18'),
    'gapYears grows monotonically for proximity sorting');
  const crossing = '2008-09-18'; // turns 18 on 2026-09-18
  ok(ageFromDOB(crossing, D('2026-09-17')) === 17 && tierOfAge(ageFromDOB(crossing, D('2026-09-17'))) === 'minor',
    'day before 18th birthday: still a minor');
  ok(ageFromDOB(crossing, D('2026-09-18')) === 18 && tierOfAge(ageFromDOB(crossing, D('2026-09-18'))) === 'adult',
    'on the 18th birthday: tier flips to adult with no stored age to update');

  // checkDOBAge: the 13-99 gate
  ok(!checkDOBAge(dobForAge(12)).ok, 'age 12 rejected by the gate');
  ok(checkDOBAge(dobForAge(13)).ok && checkDOBAge(dobForAge(99)).ok, 'ages 13 and 99 accepted');
  ok(!checkDOBAge(dobForAge(100)).ok, 'age 100 rejected by the gate');

  ok(formatDOB('2001-08-15') === '15/08/2001', 'DOB formats as DD/MM/YYYY');
  ok(dobUtils.ageOfProfile({ dob: dobForAge(30) }) === 30, 'ageOfProfile derives age from the stored dob');
  ok(dobUtils.ageOfProfile({}) === null, 'ageOfProfile is null with no dob');
}

// ---------------------------------------------------------------------------
// B. /new
// ---------------------------------------------------------------------------

reset();
db.banUser('666', 'test ban');
await newCmd.execute(cmdIx('new', '666'));
ok(cbData()?.embeds?.[0]?.title === 'Access Denied', '/new banned user gets Access Denied');
db.unbanUser('666');

onboarded('A');
onboarded('B');
sent.length = 0;
await newCmd.execute(cmdIx('new', 'A'));
{
  const cb = lastCb();
  ok(cb?.type === 4 && cb.data.flags === 32768, '/new replies V2 non-ephemeral (flags 32768) so the card persists');
  ok(cb.data.components?.[0]?.type === 17, '/new reply is a single V2 container');
  ok(str(cb).includes('Searching for a partner'), '/new reply has searching copy');
  ok(str(cb).includes('queue_cancel'), '/new reply has cancel button');
  ok(str(cb).includes('in your age group'), '/new card scopes the count to the age group');
  ok(matchmaking.getQueueSize() === 1 && matchmaking.getQueuePosition('A') === 1, 'A is queued at position 1');
}
sent.length = 0;
await newCmd.execute(cmdIx('new', 'A'));
ok(str(cbData()).includes('already in the queue'), '/new while queued warns');

// queue numbers are scoped to the user's sliding window, never global:
// the window slides per user, so different waiters can see different counts.
// (W20 goes through /new first while alone, so no instant match fires;
// the minors are staged with addToQueue, which never triggers matching.
// Blocked waiters are excluded from the eligible pool since cycle-2, so the
// window counts are demonstrated here with pure age gaps.)
reset();
agedExact('W14', 14.0); agedExact('W155', 15.5); agedExact('W17', 17.0); agedExact('W20', 20.0);
sent.length = 0;
await newCmd.execute(cmdIx('new', 'W20')); // adult: tier wall, waits
matchmaking.addToQueue('W14', db.getAnonId('W14')); // 14.0yo
matchmaking.addToQueue('W155', db.getAnonId('W155')); // 15.5yo: gap 1.5 to W14
matchmaking.addToQueue('W17', db.getAnonId('W17')); // 17.0yo: gap 3.0 to W14
{
  const s14 = matchmaking.getEligibleQueueStats('W14');
  const s155 = matchmaking.getEligibleQueueStats('W155');
  const s17 = matchmaking.getEligibleQueueStats('W17');
  const s20 = matchmaking.getEligibleQueueStats('W20');
  ok(s14 && s14.position === 1 && s14.size === 2, '14.0yo sees self + 15.5yo (window [12,16])');
  ok(s155 && s155.position === 2 && s155.size === 3, '15.5yo sees 14.0, self and 17.0 (window [13.5,17.5])');
  ok(s17 && s17.position === 2 && s17.size === 2, '17.0yo sees 15.5yo + self (window [15,17.x])');
  ok(s20 && s20.position === 1 && s20.size === 1, 'adult sees only adults');
  ok(matchmaking.getQueueSize() === 4, 'global queue still holds all four');
  ok(matchmaking.getEligibleQueueStats('ghost') === null, 'non-queued user gets no eligible stats');
  ok(str(lastCb()).includes('You are #1 in line (1 in your age group searching right now)'),
    'searching card shows window-scoped numbers');
}

reset();
onboarded('A');
onboarded('B');
sent.length = 0;
await newCmd.execute(cmdIx('new', 'A'));
sent.length = 0;
await newCmd.execute(cmdIx('new', 'B'));
{
  const toA = dmPosts('A'), toB = dmPosts('B');
  ok(toA.length === 1 && toB.length === 1, 'both strangers get the matched V2 DM');
  ok(toA[0].body.components?.[0]?.type === 17, 'matched card is a single container');
  const s = str(toA[0].body);
  ok(s.includes('chatting with a stranger'), 'matched card copy');
  ok(s.includes('chat_end') && s.includes('chat_report'), 'matched card has End chat + Report buttons');
  ok(s.includes('no ratings yet'), 'fresh users show the clean unrated state');
  const sa = db.getActiveSessionForUser('A'), sb = db.getActiveSessionForUser('B');
  ok(sa && sb && sa.session_id === sb.session_id, 'sessions linked both ways');
  ok([sa.user1_id, sa.user2_id].sort().join() === 'A,B', 'session pairs A and B');
  ok(matchmaking.getQueueSize() === 0, 'queue drained on match');
}
sent.length = 0;
await newCmd.execute(cmdIx('new', 'A'));
ok(str(cbData()).includes('already in a chat'), '/new while chatting warns');

// ---------------------------------------------------------------------------
// C. /leave and /end
// ---------------------------------------------------------------------------

sent.length = 0;
await leaveCmd.execute(cmdIx('leave', 'A'));
ok(str(cbData()).includes('currently in a chat session'), '/leave in chat points at /end');

sent.length = 0;
await endCmd.execute(cmdIx('end', 'A'));
{
  const toB = dmPosts('B');
  ok(toB.length === 2, '/end: partner gets exactly two DMs (status card + overview embed)');
  ok(toB[0].body.flags === 32768, '/end: partner status card is a persistent (non-ephemeral) V2 message');
  const sB = str(toB[0].body);
  ok(sB.includes('Your chat partner left the conversation'), '/end: partner is told their partner left');
  ok(sB.includes('chat_find_new') && sB.includes('`/new`'), '/end: partner gets the reconnect card with find-new button');
  ok(toB[1].body.embeds?.[0]?.title === '📊 Session Overview',
    '/end: partner overview embed follows the status card');
  ok(!db.getActiveSessionForUser('A') && !db.getActiveSessionForUser('B'), '/end closes the session');
  const edit = lastEditOriginal();
  ok(edit?.flags === 32768, '/end: ender status card replaces the command response as a persistent V2 message');
  const sA = str(edit);
  ok(sA.includes('You ended the chat'), '/end: ender gets a confirmation that they ended it');
  const toA = dmPosts('A');
  ok(toA.length === 1 && toA[0].body.embeds?.[0]?.title === '📊 Session Overview',
    '/end: ender overview embed lands as their second message');
  ok(str(toA[0].body).includes('Chat Duration'), '/end: ender overview shows the session metrics');
}
sent.length = 0;
await endCmd.execute(cmdIx('end', 'A'));
ok(str(cbData()).includes('not in an active chat session'), '/end with no session explains');
sent.length = 0;
await leaveCmd.execute(cmdIx('leave', 'A'));
ok(str(cbData()).includes('not in the matchmaking queue'), '/leave idle explains');

sent.length = 0;
await newCmd.execute(cmdIx('new', 'A'));
sent.length = 0;
await leaveCmd.execute(cmdIx('leave', 'A'));
ok(str(cbData()).includes('removed from the matchmaking queue'), '/leave removes the waiter');
ok(matchmaking.getQueueSize() === 0, 'queue empty after /leave');

// ---------------------------------------------------------------------------
// D. /block, /blocklist, /unblock
// ---------------------------------------------------------------------------

reset();
onboarded('C');
await matchPair('A', 'B');
await blockCmd.execute(cmdIx('block', 'A'));
{
  ok(db.isBlockedBetween('A', 'B'), '/block records the block');
  ok(!db.getActiveSessionForUser('A') && !db.getActiveSessionForUser('B'), '/block ends the session');
  const toB = dmPosts('B');
  ok(toB.length === 2, '/block: partner gets exactly two DMs (status card + overview embed)');
  const sB = str(toB[0].body);
  ok(sB.includes('Your chat partner disconnected.') && !sB.includes('blocked'),
    '/block: partner gets the generic disconnected notice (block stays private)');
  ok(toB[0].body.flags === 32768, '/block: partner notice is persistent (non-ephemeral)');
  ok(toB[1].body.embeds?.[0]?.title === '📊 Session Overview',
    '/block: partner overview embed follows the status card');
  const toA = dmPosts('A');
  ok(toA.length === 2 && str(toA[0].body).includes('You blocked this stranger'),
    '/block: blocker gets their own persistent status card');
  ok(toA[1].body.embeds?.[0]?.title === '📊 Session Overview',
    '/block: blocker overview embed lands as their second message');
  ok(cbData()?.embeds?.[0]?.title === 'Blocked', '/block: blocker gets Blocked success embed');
}
// blocked pair never rematches
sent.length = 0;
await newCmd.execute(cmdIx('new', 'A'));
sent.length = 0;
await newCmd.execute(cmdIx('new', 'B'));
ok(matchmaking.getQueuePosition('A') && matchmaking.getQueuePosition('B'), 'blocked pair both wait');
ok(!db.getActiveSessionForUser('A') && !db.getActiveSessionForUser('B'), 'no session between blocked pair');
sent.length = 0;
await newCmd.execute(cmdIx('new', 'C'));
{
  const sc = db.getActiveSessionForUser('C');
  const other = sc ? (sc.user1_id === 'C' ? sc.user2_id : sc.user1_id) : null;
  ok(other === 'A', 'a third user matches the non-blocked waiter');
  ok(matchmaking.getQueuePosition('B') === 1, 'blocked user keeps waiting');
}

// /block with no active chat falls back to the most recent partner
await matchPair('D', 'E');
const sDE = db.getActiveSessionForUser('D');
const partnerDE = sDE ? (sDE.user1_id === 'D' ? sDE.user2_id : sDE.user1_id) : null;
await endCmd.execute(cmdIx('end', 'D')); // chat over, nobody blocked
sent.length = 0;
await blockCmd.execute(cmdIx('block', 'D'));
{
  ok(partnerDE && db.isBlockedBetween('D', partnerDE), '/block with no active chat blocks the most recent partner');
  const b = db.getBlockEntries('D')[0];
  ok(b.source === 'recent', 'post-chat block is tagged as recent');
  ok(str(cbData()).includes('Blocked') && str(cbData()).includes(db.getAnonId(partnerDE).slice(0, 8)),
    '/block names the blocked stranger by short code');
}
sent.length = 0;
await blockCmd.execute(cmdIx('block', 'D'));
ok(str(cbData()).includes('No One To Block'), '/block with nobody left to block explains itself');
ok(db.getBlockEntries('A')[0].source === 'chat', 'live /block is tagged as a chat block');

sent.length = 0;
await blocklistCmd.execute(cmdIx('blocklist', 'A'));
{
  const data = cbData();
  ok(data.components?.[0]?.type === 17, '/blocklist renders a V2 card');
  ok(data.flags === 32768, '/blocklist main message is persistent (non-ephemeral)');
  const text = data.components[0].components.filter((c) => c.type === 10).map((c) => c.content).join('\n');
  ok(text.includes('Blocked strangers** (1)'), '/blocklist header counts the entries');
  ok(text.includes(`\`${db.getAnonId('B').slice(0, 8)}\``), '/blocklist shows the stable short stranger code');
  ok(/<t:\d+:F>/.test(text), '/blocklist uses a dynamic <t:…:F> timestamp, no hardcoded date');
  ok(text.includes('during a chat'), '/blocklist notes how the block happened');
  ok(!text.includes('Page 1 of'), 'single page shows no page indicator');
  const sel = data.components[0].components.filter((c) => c.type === 1)
    .flatMap((r) => r.components).find((c) => c.type === 3);
  ok(sel?.custom_id === 'unblock_select:1', '/blocklist select carries its page');
  ok(sel.options?.[0]?.value === db.getAnonId('B'), 'select option carries the anonymous id');
  ok(sel.options?.[0]?.label === `Stranger ${db.getAnonId('B').slice(0, 8)}`, 'select label names the stranger');
  ok(sel.options?.[0]?.description === undefined, 'select option has no hardcoded date description');
}
sent.length = 0;
await blocklistCmd.execute(cmdIx('blocklist', 'C'));
ok(str(cbData()).includes('have not blocked anyone'), 'empty blocklist explains itself');

sent.length = 0;
await blocklistCmd.handleInteraction(btnIx('unblock_select:1', 'A', { flags: 64, values: [db.getAnonId('B')] }));
{
  ok(!db.isBlockedBetween('A', 'B'), 'unblock_select removes the block');
  const main = lastEditOriginal();
  const mainText = str(main);
  ok(mainText.includes('have not blocked anyone'), 'main message refreshes to the empty state');
  ok(!mainText.includes('is unblocked'), 'no confirmation stamped into the main list card');
  ok(main?.flags === 32768, 'main message stays persistent after the refresh');
  const fu = sent.filter((s) => s.url.includes('/webhooks/') && !s.url.includes('/messages/') && s.method === 'POST').pop()?.body;
  ok(fu?.flags === 32768 + 64, 'unblock confirmation is a separate ephemeral V2 message');
  ok(str(fu).includes('is unblocked') && str(fu).includes('matched with them again'),
    'ephemeral confirmation explains the unblock');
}

// Pagination: 10 blocks -> 2 pages of 8/2, newest first, /help-style nav
for (let i = 0; i < 10; i++) {
  db.blockUser('P', `PX${i}`);
  db.db.blocks['P'][`PX${i}`].at = new Date(Date.UTC(2026, 8, 19, 12, 0, i)).toISOString();
}
const blCardText = (body) => body.components[0].components
  .filter((c) => c.type === 10).map((c) => c.content).join('\n');
const blEntryLines = (body) => blCardText(body).split('\n').filter((l) => l.startsWith('`'));
const blNavButtons = (body) => body.components[0].components
  .filter((c) => c.type === 1).map((r) => r.components).flat()
  .filter((c) => c.type === 2);

sent.length = 0;
await blocklistCmd.execute(cmdIx('blocklist', 'P'));
{
  const data = cbData();
  const text = blCardText(data);
  ok(text.includes('Blocked strangers** (10)'), 'paginated header counts all entries');
  ok(text.includes('Page 1 of 2'), 'page indicator on a multi-page list');
  const lines = blEntryLines(data);
  ok(lines.length === 8, 'page 1 shows 8 entries');
  ok(lines[0].includes(`\`${db.getAnonId('PX9').slice(0, 8)}\``), 'newest block is listed first');
  ok(lines.every((l) => /<t:\d+:F>/.test(l)), 'every entry uses a dynamic <t:…:F> timestamp');
  const [prev, next] = blNavButtons(data);
  ok(prev.custom_id === 'blocklist:page:1' && prev.disabled === true, 'Previous disabled on page 1');
  ok(next.custom_id === 'blocklist:page:2' && !next.disabled, 'Next enabled on page 1');
  const sel = data.components[0].components.filter((c) => c.type === 1)
    .flatMap((r) => r.components).find((c) => c.type === 3);
  ok(sel?.custom_id === 'unblock_select:1' && sel.options.length === 8,
    'unblock select is scoped to the current page');
}
sent.length = 0;
await blocklistCmd.handleInteraction(btnIx('blocklist:page:2', 'P'));
{
  const body = lastEditOriginal();
  const text = blCardText(body);
  ok(text.includes('Page 2 of 2'), 'Next navigates to page 2');
  ok(body?.flags === 32768, 'page navigation keeps the message persistent');
  const lines = blEntryLines(body);
  ok(lines.length === 2, 'page 2 shows the remaining 2 entries');
  ok(lines[0].includes(`\`${db.getAnonId('PX1').slice(0, 8)}\``), 'page 2 continues newest-first');
  const [prev, next] = blNavButtons(body);
  ok(!prev.disabled && next.disabled === true, 'Previous enabled and Next disabled on the last page');
}
sent.length = 0;
await blocklistCmd.handleInteraction(btnIx('blocklist:page:99', 'P'));
ok(blCardText(lastEditOriginal()).includes('Page 2 of 2'), 'out-of-range page clamps to the last page');
sent.length = 0;
await blocklistCmd.handleInteraction(btnIx('blocklist:page:1', 'P'));
ok(blCardText(lastEditOriginal()).includes('Page 1 of 2'), 'Previous navigates back to page 1');

db.blockUser('A', 'B');
sent.length = 0;
await unblockCmd.execute(cmdIx('unblock', 'A', [{ name: 'anonymous_id', value: db.getAnonId('B') }]));
let unblockCb;
{
  unblockCb = cbData();
  ok(unblockCb?.flags === 32768 + 64, '/unblock confirmation is ephemeral V2');
  const text = str(unblockCb);
  ok(text.includes('is unblocked') && text.includes('matched with them again') && text.includes('never told'),
    '/unblock uses the canonical confirmation copy');
  ok(!db.isBlockedBetween('A', 'B'), '/unblock removes the block');
}
sent.length = 0;
await unblockCmd.execute(cmdIx('unblock', 'A', [{ name: 'anonymous_id', value: 'deadbeef' }]));
ok(str(cbData()).includes('Could not find that stranger'), '/unblock unknown id explains itself');
// parity: the standalone command and the /blocklist string select render
// byte-identical confirmation cards, so every unblock behaves the same
{
  db.blockUser('A', 'B');
  sent.length = 0;
  await blocklistCmd.handleInteraction(btnIx('unblock_select:1', 'A', { flags: 64, values: [db.getAnonId('B')] }));
  const fu = sent.filter((s) => s.url.includes('/webhooks/') && !s.url.includes('/messages/') && s.method === 'POST').pop()?.body;
  ok(str(fu?.components) === str(unblockCb?.components),
    '/unblock and unblock_select produce identical confirmation cards');
}
ok(db.getAnonId('A') === db.getAnonId('A'), 'anonymous ids are deterministic');

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// E. /share (mutual identity swap)
// ---------------------------------------------------------------------------

reset();
sent.length = 0;
await shareCmd.execute(cmdIx('share', 'D'));
ok(str(cbData()).includes('not in an active chat'), '/share with no session explains');

await matchPair('A', 'B');
db.updateUserProfile({ ...db.getUserProfile('A'), name: 'Aria', location: 'Dhaka', bio: 'night owl' });
db.updateUserProfile({ ...db.getUserProfile('B'), name: 'Bir', location: 'CTG', bio: 'coffee first' });

sent.length = 0;
await shareCmd.execute(cmdIx('share', 'A'));
{
  const toB = dmPosts('B');
  ok(toB.length === 1, 'partner gets the share request card');
  const body = toB[0].body;
  ok(body.components?.[0]?.type === 17, 'request card is a V2 container');
  const s = str(body);
  ok(s.includes('share_accept') && s.includes('share_decline'), 'request card has accept/decline buttons');
  ok(str(cbData()).includes('Request sent'), 'requester gets a confirmation');
}
ok(db.getActiveSessionForUser('A').shareRequest?.from === 'A', 'pending request recorded on the session');

sent.length = 0;
await shareCmd.execute(cmdIx('share', 'A'));
ok(str(cbData()).includes('already sent a request'), 'duplicate request while one is pending is refused');

// B accepts -> both sides get the rich V2 identity reveal card
sent.length = 0;
await shareCmd.handleInteraction(btnIx('share_accept', 'B', { channelId: 'dm_B', messageId: 'req1' }));
{
  const toA = dmPosts('A');
  const toB = dmPosts('B');
  ok(toA.length === 1 && toB.length === 1, 'both sides receive the reveal card');
  const cardA = toA[0].body;
  ok(cardA.components?.[0]?.type === 17, 'reveal card is a V2 container');
  const sA = str(cardA);
  ok(sA.includes('**Bir**') && sA.includes('CTG') && sA.includes('coffee first'), "A gets B's profile summary");
  ok(sA.includes('`@user_B`') && sA.includes('(`B`)'), "A gets B's Discord identity block");
  ok(sA.includes('friend request'), 'reveal card has the closing line');
  const sB = str(toB[0].body);
  ok(sB.includes('**Aria**') && sB.includes('Dhaka') && sB.includes('night owl'), "B gets A's profile summary");
  ok(sB.includes('`@user_A`') && sB.includes('(`A`)'), "B gets A's Discord identity block");
  // layout without media: opening, divider, summary, divider, connector, identity block, closing
  const parts = cardA.components[0].components.map((c) => c.type);
  ok(JSON.stringify(parts) === JSON.stringify([10, 14, 10, 14, 10, 10, 10]), 'reveal layout: opening/divider/summary/divider/connector/identity/closing');
  ok(sA.includes("They said yes! Here's the person you've been chatting with."), 'requester header: They said yes!');
  ok(sA.includes("Here's how to reach them on Discord:"), 'contact prompt ends with a colon');
  ok(sB.includes("Here's the person you've been chatting with."), 'accepter gets the plain header');
  ok(!sB.includes('They said yes!'), 'accepter header has no They said yes');
  ok(!db.getActiveSessionForUser('A').shareRequest, 'request cleared after accept');
}
const sessionId = db.getActiveSessionForUser('A').session_id;
ok(db.getShareData(sessionId, 'A').count === 1, 'completed swap counts against the requester');
ok(db.getLifetimeStats('A').shares === 1 && db.getLifetimeStats('B').shares === 1,
  'completed swap bumps lifetime identity shares for both sides');

// decline path (before the per-session cap is reached): A's cooldown cleared honestly
db.db.shares[`${sessionId}:A`].last_share = Date.now() - 61_000;
sent.length = 0;
await shareCmd.execute(cmdIx('share', 'A'));
ok(str(cbData()).includes('Request sent'), 'share allowed again after cooldown');
sent.length = 0;
await shareCmd.handleInteraction(btnIx('share_decline', 'B', { channelId: 'dm_B', messageId: 'req3' }));
{
  const toA = dmPosts('A');
  ok(toA.length === 1 && str(toA[0].body).includes('stay anonymous'), 'requester is told the partner declined');
  ok(!db.getActiveSessionForUser('A').shareRequest, 'request cleared after decline');
  ok(db.getShareData(sessionId, 'A').count === 1, 'a declined request does not consume the share limit');
}

// media showcase folds into the mutual swap: give A a photo first
{
  const { downloadProfileMedia } = await import('../src/utils/media.js');
  const dl = await downloadProfileMedia('A', ['att1'], attFixture('att1'), 20 * 1024 * 1024);
  ok(dl.ok, 'test fixture media downloads');
  const p = db.getUserProfile('A');
  p.media = dl.media;
  db.updateUserProfile(p);
}

// mutual /share: the partner's own /share completes the swap.
// Both cooldowns cleared honestly (B carries one from accepting swap 1,
// A from the declined request above).
db.db.shares[`${sessionId}:A`].last_share = Date.now() - 61_000;
db.db.shares[`${sessionId}:B`].last_share = Date.now() - 61_000;
sent.length = 0;
await shareCmd.execute(cmdIx('share', 'A'));
ok(str(cbData()).includes('Request sent'), 'share allowed again after cooldown');
sent.length = 0;
await shareCmd.execute(cmdIx('share', 'B'));
{
  ok(str(cbData()).includes('already asked'), 'mutual /share completes the swap');
  ok(dmPosts('A').length === 1 && dmPosts('B').length === 1, 'both get reveal cards on mutual share');
  const toB = dmPosts('B');
  const gallery = toB[0].body.components[0].components.find((c) => c.type === 12);
  ok(gallery && gallery.items.length === 1, "reveal card shows A's photo in a media gallery");
  ok(toB[0].body._multipart, 'reveal card with media is sent multipart');
  const parts = toB[0].body.components[0].components.map((c) => c.type);
  ok(JSON.stringify(parts) === JSON.stringify([10, 14, 12, 14, 10, 14, 10, 10, 10]), 'reveal layout with media: gallery between dividers');
  ok(!db.getActiveSessionForUser('A').shareRequest, 'request cleared after mutual swap');
}
ok(db.getShareData(sessionId, 'A').count === 2, 'two swaps recorded');

// the per-session cap (2 swaps) is now reached: further requests hit the cap, not the cooldown
sent.length = 0;
await shareCmd.execute(cmdIx('share', 'A'));
ok(str(cbData()).includes('limit of 2 shares'), 'post-second-swap share hits the per-session cap, not the cooldown');

// accept with no pending request
sent.length = 0;
await shareCmd.handleInteraction(btnIx('share_accept', 'B', { channelId: 'dm_B', messageId: 'req9' }));
ok(str(cbData()).includes('no pending share request'), 'stray accept is refused');

// F. /stats (personal lifetime metrics)
// ---------------------------------------------------------------------------

reset();
onboarded('S1');
onboarded('S2');
const sdm = (uid, content, attachments = []) => ({
  id: 'm1', channel_id: `dm_${uid}`, type: 0,
  author: { id: uid, bot: false }, content, attachments,
});
const statsText = () => cbData().components?.[0]?.components
  ?.filter((c) => c.type === 10).map((c) => c.content).join('\n');

// fresh user: all zeros plus the nudge to start chatting
sent.length = 0;
await statsCmd.execute(cmdIx('stats', 'S1'));
{
  ok(cbData()?.flags === 32832, '/stats renders as an ephemeral V2 card');
  const text = statsText();
  ok(text.includes('Your lifetime stats'), '/stats card title');
  for (const line of ['Messages sent: **0**', 'Attachments shared: **0**',
    'Time in chats: **under a minute**', 'Chats joined: **0**',
    'Longest chat: **under a minute**', 'Identities shared: **0**']) {
    ok(text.includes(line), `/stats shows "${line}" for a fresh user`);
  }
  ok(text.includes('`/new`'), 'empty stats hint backticks the /new command');
  ok(text.includes('Community rating') && text.includes('no ratings yet'),
    'fresh stats show the unrated reputation state');
}

// formatChatDuration unit table
{
  const { formatChatDuration } = embeds;
  ok(formatChatDuration(0) === 'under a minute', 'duration 0');
  ok(formatChatDuration(20000) === 'under a minute', 'duration 20s');
  ok(formatChatDuration(90000) === '1m', 'duration 90s');
  ok(formatChatDuration(3600000) === '1h', 'duration 1h');
  ok(formatChatDuration(5400000) === '1h 30m', 'duration 1h30m');
  ok(formatChatDuration(172800000) === '2d', 'duration 2d');
}

// chat, exchange texts + a photo + a voice note, end -> lifetime accumulates per user
await matchPair('S1', 'S2');
await chat.handleDirectMessage(sdm('S1', 'hello there'));
await chat.handleDirectMessage(sdm('S1', 'look', [
  { url: 'https://cdn.discordapp.com/pic.png', filename: 'pic.png', content_type: 'image/png', size: 100 },
]));
await chat.handleDirectMessage({
  id: 'm9', channel_id: 'dm_S1', type: 0, flags: 8192,
  author: { id: 'S1', bot: false }, content: '',
  attachments: [{
    url: 'https://cdn.discordapp.com/voice.ogg', filename: 'voice.ogg',
    content_type: 'audio/ogg', size: 50, duration_secs: 4.2, waveform: 'aGVsbG8=',
  }],
});
await chat.handleDirectMessage(sdm('S2', 'hey back'));
sent.length = 0;
await endCmd.execute(cmdIx('end', 'S1'));
{
  const l1 = db.getLifetimeStats('S1');
  ok(l1.messages === 2, 'S1 lifetime messages = 2 sent');
  ok(l1.attachments === 2, 'S1 lifetime attachments = photo + voice note in one metric');
  ok(l1.chats === 1, 'S1 lifetime chats = 1');
  ok(l1.chatMs >= 0 && l1.longestChatMs === l1.chatMs, 'S1 chat duration recorded as the longest');
  const l2 = db.getLifetimeStats('S2');
  ok(l2.messages === 1 && l2.attachments === 0 && l2.chats === 1,
    'S2 lifetime counted separately from S1');
}
// /stats reflects the accumulated totals
sent.length = 0;
await statsCmd.execute(cmdIx('stats', 'S1'));
{
  const text = statsText();
  ok(text.includes('Messages sent: **2**') && text.includes('Attachments shared: **2**') &&
    text.includes('Chats joined: **1**'),
    '/stats shows accumulated lifetime totals');
  ok(!text.includes('No chats yet'), 'starter hint gone once the user has chatted');
}
// lifetime survives a second chat and accumulates (no re-onboarding: that would reset the profile)
await newCmd.execute(cmdIx('new', 'S1'));
await newCmd.execute(cmdIx('new', 'S2'));
await chat.handleDirectMessage(sdm('S2', 'round two'));
await endCmd.execute(cmdIx('end', 'S2'));
{
  const l1 = db.getLifetimeStats('S1');
  const l2 = db.getLifetimeStats('S2');
  ok(l1.chats === 2 && l1.messages === 2, 'S1 totals accumulate across chats');
  ok(l2.chats === 2 && l2.messages === 2, 'S2 second chat counted');
}

// ---------------------------------------------------------------------------
// G. /report
// ---------------------------------------------------------------------------

reset();
sent.length = 0;
await reportCmd.execute(cmdIx('report', 'D'));
{
  const cb = lastCb();
  ok(cb?.type === 4 && /No Active Chat|No One to Report/.test(cb?.data?.embeds?.[0]?.title || ''),
    '/report with no session explains (info embed, no modal)');
}

await matchPair('A', 'B');
sent.length = 0;
await reportCmd.execute(cmdIx('report', 'A'));
{
  const cb = lastCb();
  ok(cb?.type === 9, '/report opens a modal (callback type 9)');
  ok(cb.data.custom_id === 'report_modal:B', 'modal custom_id encodes the partner target');
  const s = str(cb.data.components);
  ok(s.includes('report_reason') && s.includes('report_description'), 'modal has reason + description inputs');
}
sent.length = 0;
await reportCmd.handleInteraction(modalIx('report_modal', 'A', [['report_reason', 'spam'], ['report_description', 'details here']]));
{
  const emb = cbData()?.embeds?.[0];
  ok(emb?.title === 'Report Filed', 'report submit -> Report Filed embed');
  ok(/ID: rp_/.test(emb?.description || ''), 'report filed message carries the report ID');
  const r = db.db.reports[0];
  ok(r && r.reporterId === 'A' && r.targetId === 'B' && r.reason === 'spam', 'report persisted with reporter/target/reason');
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// H. /profile (V2 card + edit controls)
// ---------------------------------------------------------------------------

reset();
{
  const p = onboarded('A');
  db.updateUserProfile({ ...p, name: 'Aria', location: 'Dhaka', bio: 'night owl', interests: ['music', 'hiking'] });
}
sent.length = 0;
await profileCmd.execute(cmdIx('profile', 'A'));
{
  const body = lastEditOriginal();
  ok(body?.flags === 32768, '/profile renders as a persistent (non-ephemeral) V2 card');
  ok(!(lastCb()?.data?.flags & 64), '/profile defer carries no ephemeral flag');
  const card = body.components?.[0];
  ok(card?.type === 17, 'profile card is a V2 container');
  const text = card.components.filter((c) => c.type === 10).map((c) => c.content).join('\n');
  ok(text.includes('**Aria**, 20 · Dhaka · night owl'), 'profile headline: name, live age, location, bio');
  ok(!text.includes('Date of birth:'), 'profile card no longer shows the date of birth');
  ok(text.includes('Interests: music, hiking'), 'profile shows interests');
  const btns = card.components.filter((c) => c.type === 1).flatMap((r) => r.components.map((b) => b.custom_id));
  ok(btns.length === 6 && btns.includes('profile_edit_name') && btns.includes('profile_edit_media'),
    'profile has all six edit buttons');
}

// profile card without interests: no DOB line, no empty details block
{
  const { components } = embeds.profileCard({ name: 'Bo', dob: dobForAge(22), location: '', bio: '', media: [], interests: [] });
  const text = components[0].components.filter((c) => c.type === 10).map((c) => c.content).join('\n');
  ok(text.includes('**Bo**, 22'), 'headline still renders with the live age');
  ok(!text.includes('Date of birth:'), 'no DOB line on the card');
  ok(!text.includes('Interests:'), 'no empty interests line when interests are unset');
}

// profileSavedCard: ephemeral receipt shape
{
  const card = embeds.profileSavedCard('Bio updated', 'Your bio now reads:\n> just vibing');
  ok(Array.isArray(card) && card[0].type === 17 && card[0].components[0].type === 10,
    'saved receipt is a V2 container with a text display');
  ok(str(card).includes('Bio updated') && str(card).includes('just vibing'),
    'receipt shows the field and the new value');
}

// edit name
sent.length = 0;
await profileCmd.handleInteraction(btnIx('profile_edit_name', 'A', {}));
ok(lastCb()?.data.custom_id === 'profile_update_name_modal', 'name edit opens the modal');
/** The modal submit must PATCH the original card in place, then turn the
 *  ephemeral defer into a visible receipt: no new chat message, ever. */
const inPlaceEdit = (what) => {
  const patches = dmPatches('x');
  ok(patches.length === 1 && patches[0].url.endsWith('/channels/dm_x/messages/m1'),
    `${what}: single in-place PATCH to the original card`);
  ok(!dmPosts('x').length, `${what}: no new message posted to the chat`);
  const confirm = lastEditOriginal();
  ok(confirm && (confirm.flags & 64) === 64, `${what}: ephemeral confirmation receipt sent`);
  ok(!sent.some((s) => s.method === 'DELETE' && s.url.includes('/messages/@original')),
    `${what}: defer converted to a receipt, not deleted`);
  return { card: patches[0].body, confirm };
};
sent.length = 0;
await profileCmd.handleInteraction(modalIx('profile_update_name_modal', 'A', [['profile_name_input', 'Nova']]));
ok(db.getUserProfile('A').name === 'Nova', 'name persisted');
{
  const { card, confirm } = inPlaceEdit('name edit');
  ok(str(card).includes('**Nova**'), 'card re-renders with the new name');
  ok(str(confirm).includes('Name updated') && str(confirm).includes('Your name is now **Nova**.'),
    'ephemeral receipt confirms the name change');
}
sent.length = 0;
await profileCmd.handleInteraction(modalIx('profile_update_name_modal', 'A', [['profile_name_input', '   ']]));
ok(str(cbData()).includes("didn't save"), 'blank name is rejected with the retry card');
ok(db.getUserProfile('A').name === 'Nova', 'blank name does not overwrite');

// edit date of birth
sent.length = 0;
await profileCmd.handleInteraction(btnIx('profile_edit_dob', 'A', {}));
{
  const cb = lastCb();
  ok(cb?.type === 9 && cb?.data.custom_id === 'profile_update_dob_modal', 'DOB edit opens the modal');
  const ids = cb.data.components.map((r) => r.component.custom_id);
  ok(ids.join() === 'profile_dob_day,profile_dob_month,profile_dob_year', 'modal has Day/Month/Year fields');
}
sent.length = 0;
{
  const [yy, mm, dd] = dobForAge(25).split('-');
  await profileCmd.handleInteraction(modalIx('profile_update_dob_modal', 'A', [
    ['profile_dob_day', dd], ['profile_dob_month', mm], ['profile_dob_year', yy],
  ]));
}
ok(db.getUserProfile('A').dob === dobForAge(25), 'DOB persisted');
{
  const { card, confirm } = inPlaceEdit('dob edit');
  ok(str(card).includes('**Nova**, 25'), 'card shows the recomputed age');
  ok(str(confirm).includes('Date of birth updated') && str(confirm).includes('(age 25)'),
    'ephemeral receipt confirms the DOB change');
}
ok(!('age' in db.getUserProfile('A')), 'no static age is stored on the profile');
for (const [dd, mm, yy, why] of [['abc', '08', '2001', 'non-numeric'], ['31', '02', '2001', 'impossible']]) {
  sent.length = 0;
  await profileCmd.handleInteraction(modalIx('profile_update_dob_modal', 'A', [
    ['profile_dob_day', dd], ['profile_dob_month', mm], ['profile_dob_year', yy],
  ]));
  ok(str(cbData()).includes('Invalid Date of Birth'), `DOB (${why}) rejected`);
}
{
  const [yy, mm, dd] = dobForAge(12).split('-');
  sent.length = 0;
  await profileCmd.handleInteraction(modalIx('profile_update_dob_modal', 'A', [
    ['profile_dob_day', dd], ['profile_dob_month', mm], ['profile_dob_year', yy],
  ]));
  ok(str(cbData()).includes('Invalid Date of Birth'), 'DOB yielding age below 13 rejected');
}

// edit location + bio
sent.length = 0;
await profileCmd.handleInteraction(btnIx('profile_edit_location', 'A', {}));
ok(lastCb()?.data.custom_id === 'profile_update_location_modal', 'location edit opens the modal');
sent.length = 0;
await profileCmd.handleInteraction(modalIx('profile_update_location_modal', 'A', [['profile_location_input', 'Sylhet']]));
ok(db.getUserProfile('A').location === 'Sylhet', 'location persisted');
{
  const { card, confirm } = inPlaceEdit('location edit');
  ok(str(card).includes('Sylhet'), 'card re-renders with the new location');
  ok(str(confirm).includes('Location updated') && str(confirm).includes('**Sylhet**'),
    'ephemeral receipt confirms the location change');
}

sent.length = 0;
await profileCmd.handleInteraction(btnIx('profile_edit_bio', 'A', {}));
ok(lastCb()?.data.custom_id === 'profile_update_bio_modal', 'bio edit opens the modal');
sent.length = 0;
await profileCmd.handleInteraction(modalIx('profile_update_bio_modal', 'A', [['profile_bio_input', 'just vibing']]));
ok(db.getUserProfile('A').bio === 'just vibing', 'bio persisted');
{
  const { card, confirm } = inPlaceEdit('bio edit');
  ok(str(card).includes('just vibing'), 'card re-renders with the new bio');
  ok(str(confirm).includes('Bio updated') && str(confirm).includes('> just vibing'),
    'ephemeral receipt confirms the bio change');
}

// edit interests
sent.length = 0;
await profileCmd.handleInteraction(btnIx('profile_edit_interests', 'A', {}));
ok(lastCb()?.data.custom_id === 'profile_update_interests_modal', 'interests edit opens modal');
sent.length = 0;
await profileCmd.handleInteraction(modalIx('profile_update_interests_modal', 'A', [['profile_interests_input', 'music, hiking']]));
ok(JSON.stringify(db.getUserProfile('A').interests) === JSON.stringify(['music', 'hiking']), 'interests parsed + persisted');
{
  const { card, confirm } = inPlaceEdit('interests edit');
  ok(str(card).includes('music, hiking'), 'card re-renders with the new interests');
  ok(str(confirm).includes('Interests updated') && str(confirm).includes('**music, hiking**'),
    'ephemeral receipt confirms the interests change');
}

// edit photos: upload then remove
sent.length = 0;
await profileCmd.handleInteraction(btnIx('profile_edit_media', 'A', {}));
{
  const cb = lastCb();
  ok(cb?.type === 9 && cb?.data.custom_id === 'profile_update_media_modal', 'photo edit opens the upload modal');
  const up = cb.data.components[0].component;
  ok(up.type === 19 && up.required === false && up.max_values === 6, 'upload is optional, up to 6 files');
  ok(cb.data.components[0].description.length <= 100, 'media modal label description fits the 100-char cap');
}
sent.length = 0;
await profileCmd.handleInteraction(modalUploadIx('profile_update_media_modal', 'A', {
  uploads: { profile_media: ['att1', 'att2'] },
  attachments: { ...attFixture('att1'), ...attFixture('att2', 'clip.mp4', 'video/mp4') },
}));
{
  const p = db.getUserProfile('A');
  ok(p.media.length === 2, 'two photos persisted on the profile');
  const { card, confirm } = inPlaceEdit('media edit');
  ok(card.components[0].components.some((c) => c.type === 12), 'card re-renders with a media gallery');
  ok(card._multipart, 'card with media is sent multipart');
  ok(str(confirm).includes('Photos updated') && str(confirm).includes('Saved 2 photos'),
    'ephemeral receipt confirms the photo upload');
}
sent.length = 0;
await profileCmd.handleInteraction(modalUploadIx('profile_update_media_modal', 'A', {
  uploads: { profile_media: [] }, attachments: {},
}));
{
  ok(db.getUserProfile('A').media.length === 0, 'empty submit removes all photos');
  const { card, confirm } = inPlaceEdit('media removal');
  ok(!card.components[0].components.some((c) => c.type === 12), 'gallery gone after removal');
  ok(str(confirm).includes('Removed all photos'), 'ephemeral receipt confirms the removal');
}
// non-media upload rejected
sent.length = 0;
await profileCmd.handleInteraction(modalUploadIx('profile_update_media_modal', 'A', {
  uploads: { profile_media: ['att9'] },
  attachments: attFixture('att9', 'notes.txt', 'text/plain'),
}));
ok(str(lastEditOriginal()).includes('Photos Not Saved'), 'non-photo upload rejected');
ok(db.getUserProfile('A').media.length === 0, 'rejected upload does not touch existing media');

// H2. profile lock: full card always visible, buttons greyed out while queued/in chat
reset();
onboarded('L1');
onboarded('L2');
await newCmd.execute(cmdIx('new', 'L1')); // L1 now searching
const cardButtons = () => lastEditOriginal().components?.[0].components
  .filter((c) => c.type === 1).flatMap((r) => r.components);
const cardText = () => lastEditOriginal().components?.[0].components
  .filter((c) => c.type === 10).map((c) => c.content).join('\n');
sent.length = 0;
await profileCmd.execute(cmdIx('profile', 'L1'));
{
  ok(lastEditOriginal()?.flags === 32768, 'queued /profile still renders the full V2 card');
  ok(cardText().includes('**user\\_L1**, 20'), 'queued /profile card shows the full profile');
  const btns = cardButtons();
  ok(btns.length === 6 && btns.every((b) => b.disabled === true), 'queued /profile greys out all six edit buttons');
}
// server-side guards still reject stale-card edits mid-queue
sent.length = 0;
await profileCmd.handleInteraction(btnIx('profile_edit_bio', 'L1', {}));
ok(str(lastCb()).includes('Profile Locked'), 'queued edit button is blocked');
sent.length = 0;
await profileCmd.handleInteraction(modalIx('profile_update_bio_modal', 'L1', [['profile_bio_input', 'sneaky edit']]));
ok(str(lastCb()).includes('Profile Locked'), 'queued modal submit is blocked');
ok(!db.getUserProfile('L1').bio, 'queued modal submit changes nothing');
await newCmd.execute(cmdIx('new', 'L2')); // L2 joins -> L1+L2 paired in a chat
sent.length = 0;
await profileCmd.execute(cmdIx('profile', 'L2'));
{
  ok(cardText().includes('**user\\_L2**, 20'), 'in-chat /profile shows the full profile');
  const btns = cardButtons();
  ok(btns.length === 6 && btns.every((b) => b.disabled === true), 'in-chat /profile greys out all six edit buttons');
}
sent.length = 0;
await profileCmd.handleInteraction(btnIx('profile_edit_location', 'L1', {}));
ok(str(lastCb()).includes('Profile Locked'), 'in-chat edit button is blocked');
sent.length = 0;
await profileCmd.handleInteraction(modalIx('profile_update_location_modal', 'L1', [['profile_location_input', 'Nowhere']]));
ok(str(lastCb()).includes('Profile Locked'), 'in-chat modal submit is blocked');
ok(!db.getUserProfile('L1').location, 'in-chat modal submit changes nothing');
await endCmd.execute(cmdIx('end', 'L1')); // chat over for both
sent.length = 0;
await profileCmd.execute(cmdIx('profile', 'L2'));
ok(cardButtons().every((b) => !b.disabled), '/profile buttons enabled again after the chat ends');
sent.length = 0;
await profileCmd.handleInteraction(btnIx('profile_edit_bio', 'L2', {}));
ok(lastCb()?.data?.custom_id === 'profile_update_bio_modal', 'edit button works again after the chat ends');
sent.length = 0;
await profileCmd.handleInteraction(modalIx('profile_update_bio_modal', 'L2', [['profile_bio_input', 'free again']]));
ok(db.getUserProfile('L2').bio === 'free again', 'modal submit persists after the chat ends');

// I. DM relay
// ---------------------------------------------------------------------------

reset();
await matchPair('P', 'Q');
const dm = (uid, content, attachments = []) => ({
  id: 'm1', channel_id: `dm_${uid}`, type: 0,
  author: { id: uid, bot: false }, content, attachments,
});
sent.length = 0;
await chat.handleDirectMessage(dm('P', 'hello <@123>'));
{
  const toQ = dmPosts('Q');
  ok(toQ.length === 1, 'text relayed to partner');
  const s = str(toQ[0].body);
  ok(s.includes('hello <@123>') && !s.includes('Stranger'), 'relay carries no Stranger header');
  ok(JSON.stringify(toQ[0].body.allowed_mentions?.parse) === '[]', 'relay strips mention parsing');
  ok(toQ[0].body.components?.[0]?.type === 17, 'relay message is a V2 container');
  const rx = reactions('P');
  ok(rx.length === 1 && decodeURIComponent(rx[0].url).includes('✅'), 'successful relay reacts ✅ on the sender message');
}
sent.length = 0;
await chat.handleDirectMessage(dm('P', 'caption here', [
  { url: 'https://cdn.discordapp.com/pic.png', filename: 'pic.png', content_type: 'image/png', size: 100 },
]));
{
  const toQ = dmPosts('Q');
  ok(toQ.length === 1, 'text + photo relayed together');
  const inner = toQ[0].body.components?.[0]?.components || [];
  const kinds = inner.map((c) => c.type);
  ok(kinds[0] === 10 && str(inner[0]).includes('caption here'), 'text sits at the very top');
  ok(kinds[1] === 14 && inner[1].divider === true, 'a divider separator sits immediately below the text');
  ok(kinds[2] === 12, 'media gallery lands at the bottom');
}
sent.length = 0;
await chat.handleDirectMessage(dm('Q', '', [
  { url: 'https://cdn.discordapp.com/pic.png', filename: 'pic.png', content_type: 'image/png', size: 100 },
]));
{
  const toP = dmPosts('P');
  ok(toP.length === 1, 'photo relayed to partner');
  ok(str(toP[0].body).includes('"type":12'), 'photo lands in a media gallery');
  ok(toP[0].body._multipart === true, 'relay with files uses multipart');
}
// voice notes go bare: native message, voice flag, audio metadata preserved
sent.length = 0;
await chat.handleDirectMessage({
  id: 'm9', channel_id: 'dm_Q', type: 0, flags: 8192,
  author: { id: 'Q', bot: false }, content: '',
  attachments: [{
    url: 'https://cdn.discordapp.com/voice.ogg', filename: 'voice.ogg',
    content_type: 'audio/ogg; codecs=opus', size: 5000,
    duration_secs: 4.2, waveform: 'aGVsbG8=',
  }],
});
{
  const toP = dmPosts('P');
  ok(toP.length === 1, 'voice note relayed to partner');
  ok(toP[0].body.flags === 8192, 'voice note message carries the voice flag');
  ok(!(toP[0].body.components || []).some((c) => c.type === 17), 'voice note is NOT wrapped in a V2 container');
  const att = toP[0].body.attachments?.[0] || {};
  ok(att.duration_secs === 4.2 && att.waveform === 'aGVsbG8=', 'voice metadata preserved for the native player');
}
// regular audio files (mp3) are NOT voice notes: they ride the container as File components
sent.length = 0;
await chat.handleDirectMessage({
  id: 'm10', channel_id: 'dm_Q', type: 0, flags: 0,
  author: { id: 'Q', bot: false }, content: '',
  attachments: [{
    url: 'https://cdn.discordapp.com/sound_notification.mp3', filename: 'sound_notification.mp3',
    content_type: 'audio/mpeg', size: 42000,
  }],
});
{
  const toP = dmPosts('P');
  ok(toP.length === 1, 'mp3 audio file relayed to partner');
  const inner = toP[0].body.components?.[0]?.components || [];
  ok(inner.some((c) => c.type === 13 && str(c).includes('attachment://')), 'mp3 lands in a File component');
  ok(toP[0].body._multipart === true, 'mp3 relay uses multipart');
  const rx = reactions('Q');
  ok(rx.length === 1 && decodeURIComponent(rx[0].url).includes('✅'), 'mp3 relay reacts ✅ on the sender message');
}
sent.length = 0;
await chat.handleDirectMessage(dm('Z', 'anybody here?'));
ok(dmPosts('Z').length === 1 && str(dmPosts('Z')).includes('Use `/new`'), 'idle user gets the /new hint');

// rate limit: 8 per 20s
await matchPair('R', 'S');
chat._resetRelayForTests();
sent.length = 0;
for (let i = 0; i < 9; i++) {
  await chat.handleDirectMessage(dm('R', `msg ${i}`));
}
ok(dmPosts('S').length === 8, 'relay capped at 8 messages per window');
ok(dmPosts('R').length === 1 && str(dmPosts('R')).includes('slow down'), 'spammer gets a warning');

// failed delivery reacts ❌ on the sender message
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/channels/dm_S/messages') && (opts.method || 'GET').toUpperCase() === 'POST') {
      return new Response('{"message":"nope","code":50007}', { status: 403 });
    }
    return realFetch(url, opts);
  };
  chat._resetRelayForTests();
  sent.length = 0;
  await chat.handleDirectMessage(dm('R', 'will fail'));
  globalThis.fetch = realFetch;
  const rx = reactions('R');
  ok(rx.length === 1 && decodeURIComponent(rx[0].url).includes('❌'), 'failed relay reacts ❌ on the sender message');
  ok(str(sent).includes("Couldn't deliver that"), 'sender is told delivery failed');
}

// ignored traffic
sent.length = 0;
await chat.handleDirectMessage({ id: 'm', channel_id: 'dm_P', type: 0, author: { id: 'P', bot: true }, content: 'x', attachments: [] });
await chat.handleDirectMessage({ id: 'm', channel_id: 'guildchan', guild_id: '999', type: 0, author: { id: 'P' }, content: 'x', attachments: [] });
ok(sent.length === 0, 'bot messages and guild messages are not relayed');

// ---------------------------------------------------------------------------
// I2. attachment security filter
// ---------------------------------------------------------------------------

reset();
await matchPair('T', 'U');
chat._resetRelayForTests();
const ratt = (filename, content_type) => ({
  url: `https://cdn.discordapp.com/${filename}`, filename, content_type, size: 100,
});

// unit: the allowlist table (extension + MIME must both match)
{
  const { validateAttachment } = await import('../src/services/attachments.js');
  const good = [
    ['pic.png', 'image/png'], ['photo.JPG', 'image/jpeg'], ['anim.gif', 'image/gif'],
    ['img.webp', 'image/webp'], ['img.avif', 'image/avif'], ['img.bmp', 'image/bmp'],
    ['img.heic', 'image/heic'], ['clip.mp4', 'video/mp4'], ['clip.mov', 'video/quicktime'],
    ['clip.webm', 'video/webm'], ['s.mp3', 'audio/mpeg'], ['v.ogg', 'audio/ogg; codecs=opus'],
    ['v.opus', 'audio/opus'], ['s.wav', 'audio/x-wav'], ['s.flac', 'audio/flac'],
    ['s.m4a', 'audio/mp4'], ['s.aac', 'audio/aac'], ['notes.md', 'text/markdown'],
    ['notes.txt', 'text/plain'],
  ];
  for (const [filename, content_type] of good) {
    ok(validateAttachment({ filename, content_type }).ok, `allowlisted: ${filename} (${content_type})`);
  }
  const bad = [
    ['setup.exe', 'application/x-msdownload', 'executable'],
    ['evil.png', 'application/octet-stream', 'renamed payload, MIME mismatch'],
    ['pic.png', 'application/octet-stream', 'MIME mismatch on allowed extension'],
    ['archive.zip', 'application/zip', 'archive'],
    ['doc.pdf', 'application/pdf', 'document'],
    ['x.js', 'application/javascript', 'script'],
    ['x.html', 'text/html', 'markup'],
    ['x.svg', 'image/svg+xml', 'scriptable image'],
    ['noext', 'image/png', 'missing extension'],
    ['x.xyz', 'application/octet-stream', 'unknown extension'],
    ['x.mp3', '', 'missing MIME type'],
  ];
  for (const [filename, content_type, why] of bad) {
    ok(!validateAttachment({ filename, content_type }).ok, `blocked: ${why}`);
  }
}

// forbidden attachment: whole message blocked, ❌, warning DM with the allowed list
sent.length = 0;
await chat.handleDirectMessage(dm('T', 'check this out', [ratt('setup.exe', 'application/x-msdownload')]));
{
  ok(dmPosts('U').length === 0, 'forbidden attachment is never relayed');
  const rx = reactions('T');
  ok(rx.length === 1 && decodeURIComponent(rx[0].url).includes('❌'), 'blocked message reacts ❌ on the sender message');
  const warn = dmPosts('T');
  ok(warn.length === 1, 'sender gets a warning DM');
  const body = warn[0].body;
  ok(body.components?.[0]?.type === 17, 'warning is a V2 container');
  const s = str(body);
  ok(s.includes('`setup.exe`'), 'warning names the blocked file');
  ok(s.includes('PNG') && s.includes('MP4') && s.includes('MP3') && s.includes('TXT'),
    'warning lists the allowed extensions');
  ok(!s.includes('—') && !s.includes('–'), 'warning copy has no em/en dashes');
}

// one forbidden file poisons the whole message, even next to allowed files
sent.length = 0;
await chat.handleDirectMessage(dm('T', 'photos', [ratt('pic.png', 'image/png'), ratt('a.zip', 'application/zip')]));
ok(dmPosts('U').length === 0, 'mixed message is blocked entirely');

// unit: magic-byte sniffing reads the bytes, not the label
{
  const { sniffCategory, sniffMatches } = await import('../src/services/attachments.js');
  const B = (s) => Buffer.from(s, 'binary');
  const cases = [
    [B('\x89PNG\r\n\x1a\n'), 'photo', 'PNG magic'],
    [B('\xff\xd8\xff\xe0'), 'photo', 'JPEG magic'],
    [B('GIF89a'), 'photo', 'GIF magic'],
    [B('BM\x00\x00'), 'photo', 'BMP magic'],
    [B('RIFF\x00\x00\x00\x00WEBP'), 'photo', 'WebP RIFF magic'],
    [B('RIFF\x00\x00\x00\x00WAVE'), 'audio', 'WAV RIFF magic'],
    [Buffer.concat([B('\x00\x00\x00\x18'), B('ftyp'), B('isom'), B('\x00\x00\x00\x00')]), 'av-container', 'mp4 ftyp/isom'],
    [Buffer.concat([B('\x00\x00\x00\x18'), B('ftyp'), B('heic'), B('\x00\x00\x00\x00')]), 'photo', 'HEIC ftyp brand'],
    [Buffer.concat([B('\x00\x00\x00\x18'), B('ftyp'), B('M4A '), B('\x00\x00\x00\x00')]), 'audio', 'M4A ftyp brand'],
    [Buffer.concat([B('\x1a\x45\xdf\xa3'), B('webm')]), 'video', 'WebM EBML magic'],
    [Buffer.concat([B('\x1a\x45\xdf\xa3'), B('weba')]), 'audio', 'WebA EBML magic'],
    [B('OggS\x00\x02'), 'audio', 'OGG magic'],
    [B('fLaC\x00'), 'audio', 'FLAC magic'],
    [B('ID3\x04\x00\x00'), 'audio', 'MP3 ID3 magic'],
    [B('\xff\xfb\x90\x00'), 'audio', 'MP3 frame sync'],
    [B('hello, just text\n'), 'note', 'plain text'],
    [B('MZ\x90\x00'), null, 'EXE MZ header'],
    [B('PK\x03\x04'), null, 'ZIP magic'],
    [B('\x00\x01\x02\xff\xfe'), null, 'binary blob with NUL bytes'],
    [B('#!/bin/sh\necho hi\n'), 'note', 'script bytes are plain text (blocked only when the extension claims otherwise)'],
  ];
  for (const [bytes, want, why] of cases) {
    ok(sniffCategory(bytes) === want, `sniff: ${why} -> ${want}`);
  }
  ok(sniffMatches('photo', B('\x89PNG\r\n\x1a\n')), 'sniff matches declared photo');
  ok(!sniffMatches('photo', B('plain text\n')), 'text bytes do not match declared photo');
  ok(sniffMatches('video', Buffer.concat([B('\x00\x00\x00\x18'), B('ftyp'), B('isom')])), 'av-container accepted for video');
  ok(sniffMatches('audio', Buffer.concat([B('\x00\x00\x00\x18'), B('ftyp'), B('isom')])), 'av-container accepted for audio');
  ok(!sniffMatches('photo', Buffer.concat([B('\x00\x00\x00\x18'), B('ftyp'), B('isom')])), 'av-container rejected for photo');
  ok(!sniffMatches('audio', B('MZ\x90\x00')), 'exe bytes never match');
}

// spoof test: text file renamed to .png, labeled image/png by the client.
// Passes the metadata allowlist but the bytes betray it: blocked, ❌, warning.
sent.length = 0;
await chat.handleDirectMessage(dm('T', 'innocent picture', [ratt('spoof-test.png', 'image/png')]));
{
  ok(dmPosts('U').length === 0, 'spoofed png is never relayed to the partner');
  const rx = reactions('T');
  ok(rx.length === 1 && decodeURIComponent(rx[0].url).includes('❌'), 'spoofed upload reacts ❌ on the sender message');
  const warn = dmPosts('T');
  ok(warn.length === 1 && str(warn[0]).includes('`spoof-test.png`'), 'sender gets a warning naming the spoofed file');
}

// every allowed category relays together with ✅
sent.length = 0;
await chat.handleDirectMessage(dm('T', 'bundle', [
  ratt('pic.png', 'image/png'), ratt('clip.mp4', 'video/mp4'),
  ratt('s.mp3', 'audio/mpeg'), ratt('n.txt', 'text/plain'),
]));
{
  ok(dmPosts('U').length === 1, 'allowed bundle relayed to partner');
  const rx = reactions('T');
  ok(rx.length === 1 && decodeURIComponent(rx[0].url).includes('✅'), 'allowed relay reacts ✅ on the sender message');
}

// ---------------------------------------------------------------------------
// J. chat buttons on DM cards
// ---------------------------------------------------------------------------

reset();
await matchPair('M', 'N');
const mGreet = greetingMsgId('M');
const nGreet = greetingMsgId('N');
ok(mGreet && nGreet && mGreet !== nGreet, 'greeting cards are retained for both users');
sent.length = 0;
await chat.handleChatEnd(btnIx('chat_end', 'M', { channelId: 'dm_M', messageId: mGreet }));
{
  ok(callbacks().some((c) => c.body.type === 6), 'chat_end defers the button');
  const toN = dmPosts('N');
  ok(toN.length === 2, 'chat_end: partner gets exactly two DMs (status card + overview embed)');
  ok(toN[0].body.flags === 32768, 'chat_end: partner status card is persistent (non-ephemeral)');
  ok(str(toN[0].body).includes('Your chat partner left the conversation'), 'chat_end: partner is told their partner left');
  ok(toN[1].body.embeds?.[0]?.title === '📊 Session Overview',
    'chat_end: partner overview embed follows the status card');
  const mPatches = dmPatches('M');
  const statusPatch = mPatches.find((p) => str(p.body).includes('You ended the chat'));
  ok(statusPatch?.url.endsWith(`/channels/dm_M/messages/${mGreet}`), 'chat_end: DM card edited in place');
  ok(str(statusPatch?.body).includes('You ended the chat'), 'chat_end: ender card confirms they ended it');
  const disablePatch = mPatches.find((p) => p !== statusPatch);
  ok(disablePatch?.url.endsWith(`/channels/dm_M/messages/${mGreet}`) && greetingButtonsDisabled(disablePatch.body),
    'chat_end: ender greeting buttons disabled the instant the chat ends');
  const nPatches = dmPatches('N');
  ok(nPatches.length === 1 && nPatches[0].url.endsWith(`/channels/dm_N/messages/${nGreet}`),
    'chat_end: partner greeting card is patched too');
  ok(greetingButtonsDisabled(nPatches[0].body), 'chat_end: partner End chat (red) + Report (grey) both greyed out');
  const toM = dmPosts('M');
  ok(toM.length === 1 && toM[0].body.embeds?.[0]?.title === '📊 Session Overview',
    'chat_end: ender overview embed lands as their second message');
  ok(!db.getActiveSessionForUser('M'), 'chat_end closes the session');
}

// Late press on the now-ended greeting card: ephemeral rejection, nothing acted on.
sent.length = 0;
await chat.handleChatEnd(btnIx('chat_end', 'M', { channelId: 'dm_M', messageId: mGreet }));
{
  const d = cbData();
  ok(d?.flags === 32768 + 64, 'late chat_end: ephemeral rejection');
  ok(str(d).includes('already ended'), 'late chat_end explains the chat ended');
  ok(!sent.some((s) => s.method === 'PATCH' && s.url.includes('/channels/')),
    'late chat_end: no card is touched');
}
sent.length = 0;
await chat.handleChatReport(btnIx('chat_report', 'N', { channelId: 'dm_N', messageId: nGreet }));
{
  const d = cbData();
  ok(d?.flags === 32768 + 64, 'late chat_report: ephemeral rejection');
  ok(str(d).includes('nothing to report'), 'late chat_report explains there is nothing to report');
}

// Stale card: a tap on an OLD greeting while a NEW session is live must not end it.
await matchPair('M', 'Q');
const newGreet = greetingMsgId('M');
ok(newGreet && newGreet !== mGreet, 're-pairing issues a fresh greeting card');
sent.length = 0;
await chat.handleChatEnd(btnIx('chat_end', 'M', { channelId: 'dm_M', messageId: mGreet }));
{
  ok(cbData()?.flags === 32768 + 64, 'stale-card chat_end: ephemeral rejection');
  ok(db.getActiveSessionForUser('M'), 'stale-card chat_end: the live session is untouched');
  ok(!sent.some((s) => s.method === 'PATCH' && s.url.includes('/channels/')),
    'stale-card chat_end: no card is touched');
}
sent.length = 0;
await chat.handleChatEnd(btnIx('chat_end', 'M', { channelId: 'dm_M', messageId: newGreet }));
ok(!db.getActiveSessionForUser('M'), 'live-card chat_end still ends the session');
sent.length = 0;
await chat.handleChatFindNew(btnIx('chat_find_new', 'N', { channelId: 'dm_N', messageId: 'card2' }));
{
  const patch = dmPatches('N')[0];
  ok(patch && str(patch.body).includes('Searching for a partner'), 'chat_find_new shows the searching card');
  ok(matchmaking.getQueuePosition('N') === 1, 'chat_find_new requeues the user');
}
sent.length = 0;
// The press must land on the user's CURRENT searching card (card2, rendered
// by chat_find_new above); taps on stale cards are rejected by the liveness
// guard and leave the queue untouched.
await chat.handleQueueCancel(btnIx('queue_cancel', 'N', { channelId: 'dm_x', messageId: 'card2', flags: 64 }));
ok(!matchmaking.getQueuePosition('N'), 'queue_cancel removes the user from the queue');
ok(sent.some((s) => s.url.includes('/messages/@original') && s.method === 'PATCH'), 'queue_cancel edits the ephemeral card');

await matchPair('M2', 'N2');
sent.length = 0;
await chat.handleChatReport(btnIx('chat_report', 'M2', { channelId: 'dm_M2', messageId: greetingMsgId('M2') }));
ok(lastCb()?.type === 9 && lastCb()?.data.custom_id === 'report_modal:N2', 'chat_report opens the report modal');

// ---------------------------------------------------------------------------
// R. reputation & ratings (community honor system)
// ---------------------------------------------------------------------------

// db unit: fresh user
{
  const r = db.getReputation('nobody-yet');
  ok(r.likes === 0 && r.dislikes === 0 && r.total === 0 && r.score === null,
    'unrated user: zero reputation, null star score');
}

// db unit: ratePartner flow + 5.00-scale math
reset();
{
  db.noteSessionConcluded({ session_id: 's_t1', user1_id: 'A', user2_id: 'B' });
  let res = db.ratePartner('s_t1', 'A', 'like');
  ok(res.ok && res.partnerId === 'B' && res.likes === 1, 'like records against the partner');
  ok(Math.abs(db.getReputation('B').score - 5) < 1e-9, 'single like = 5.00');
  res = db.ratePartner('s_t1', 'A', 'dislike');
  ok(!res.ok && res.reason === 'already_rated', 'one rating per user per session');
  res = db.ratePartner('s_t1', 'B', 'like');
  ok(res.ok && res.partnerId === 'A', 'the partner can rate back');
  db.noteSessionConcluded({ session_id: 's_t2', user1_id: 'B', user2_id: 'C' });
  db.ratePartner('s_t2', 'C', 'dislike');
  const rep = db.getReputation('B');
  ok(rep.total === 2 && rep.likes === 1 && rep.dislikes === 1 && Math.abs(rep.score - 2.5) < 1e-9,
    'star score = like share x 5.00 (1/2 -> 2.50)');
  db.noteSessionConcluded({ session_id: 's_t3', user1_id: 'B', user2_id: 'D' });
  db.ratePartner('s_t3', 'D', 'like');
  db.noteSessionConcluded({ session_id: 's_t4', user1_id: 'B', user2_id: 'E' });
  db.ratePartner('s_t4', 'E', 'like');
  const rep3 = db.getReputation('B');
  ok(rep3.total === 4 && rep3.likes === 3 && rep3.dislikes === 1 && rep3.score.toFixed(2) === '3.75',
    'lifetime totals accumulate across sessions');
  ok(db.ratePartner('s_nope', 'A', 'like').reason === 'unknown_session', 'unknown session rejected');
  ok(db.ratePartner('s_t1', 'Z', 'like').reason === 'not_a_participant', 'non-participant rejected');
}

// greeting card shows the PARTNER's star score + vote count
reset();
onboarded('G1');
onboarded('G2');
db.noteSessionConcluded({ session_id: 's_g1', user1_id: 'G2', user2_id: 'X1' });
db.ratePartner('s_g1', 'X1', 'like');
db.noteSessionConcluded({ session_id: 's_g2', user1_id: 'G2', user2_id: 'X2' });
db.ratePartner('s_g2', 'X2', 'like');
db.noteSessionConcluded({ session_id: 's_g3', user1_id: 'G2', user2_id: 'X3' });
db.ratePartner('s_g3', 'X3', 'dislike');
await newCmd.execute(cmdIx('new', 'G1'));
sent.length = 0;
await newCmd.execute(cmdIx('new', 'G2'));
{
  const card = dmPosts('G1').find((p) => str(p.body).includes("You're now chatting"));
  ok(card, 'greeting card DM sent to G1');
  const text = str(card.body);
  ok(text.includes('3.33 / 5.00') && text.includes('3 ratings'),
    'greeting shows the partner star score (2/3 -> 3.33) and vote count');
  const card2 = dmPosts('G2').find((p) => str(p.body).includes("You're now chatting"));
  ok(str(card2.body).includes('no ratings yet'), 'unrated partner shows the clean unrated state');
}

// full rating flow: like -> counted, buttons greyed, ephemeral confirmation
reset();
await matchPair('R1', 'R2');
const rSid = db.getActiveSessionForUser('R1').session_id;
sent.length = 0;
await chat.handleChatEnd(btnIx('chat_end', 'R1', { channelId: 'dm_R1', messageId: greetingMsgId('R1') }));
ok(!db.getActiveSessionForUser('R1'), 'session ended before rating');
const r2card = dmPosts('R2')[0];
ok(str(r2card.body).includes('rate_like:'), 'conclusion card carries session-tagged rating buttons');
sent.length = 0;
await chat.handleRate(btnIx(`rate_like:${rSid}`, 'R2', {
  channelId: 'dm_R2', messageId: 'conc1', components: r2card.body.components,
}), 'like');
{
  const rep = db.getReputation('R1');
  ok(rep.likes === 1 && rep.total === 1 && Math.abs(rep.score - 5) < 1e-9, 'like recorded against the partner');
  const patch = dmPatches('R2')[0];
  ok(patch?.url.endsWith('/channels/dm_R2/messages/conc1'), 'rate: card patched in place');
  const btns = [];
  for (const c of patch.body.components?.[0]?.components || []) {
    if (c.type === 1) for (const b of c.components || []) btns.push(b);
  }
  ok(btns.find((b) => b.custom_id.startsWith('rate_like'))?.disabled === true, 'Like greyed out after rating');
  ok(btns.find((b) => b.custom_id.startsWith('rate_dislike'))?.disabled === true, 'Dislike greyed out after rating');
  ok(btns.find((b) => b.custom_id === 'chat_find_new')?.disabled !== true, 'Find someone new stays clickable');
  const fu = sent.filter((s) => s.url.includes('/webhooks/') && !s.url.includes('/messages/') && s.method === 'POST').pop()?.body;
  ok(fu?.flags === 32768 + 64, 'rate confirmation is a separate ephemeral V2 container');
  ok(str(fu).includes('recorded'), 'confirmation says the rating was recorded');
}
// repeat tap: told it was already recorded, never double counted
sent.length = 0;
await chat.handleRate(btnIx(`rate_dislike:${rSid}`, 'R2', { channelId: 'dm_R2', messageId: 'conc1' }), 'dislike');
{
  // handleRate defers first, so the rejection arrives as an ephemeral
  // followup, not as the interaction callback.
  const fu = sent.filter((s) => s.url.includes('/webhooks/') && !s.url.includes('/messages/') && s.method === 'POST').pop()?.body;
  ok(fu?.flags === 32768 + 64, 'repeat rating: ephemeral rejection');
  ok(str(fu).includes('already recorded'), 'repeat rating explains it was recorded');
  ok(db.getReputation('R1').dislikes === 0, 'repeat tap is not double counted');
}
// unknown session id
sent.length = 0;
await chat.handleRate(btnIx('rate_like:s_nope', 'R2', { channelId: 'dm_R2', messageId: 'conc1' }), 'like');
{
  // handleRate defers first, so the rejection arrives as an ephemeral followup.
  const fu = sent.filter((s) => s.url.includes('/webhooks/') && !s.url.includes('/messages/') && s.method === 'POST').pop()?.body;
  ok(str(fu).includes('too old to rate'), 'unknown session: ephemeral rejection');
}
// router reaches the rating handler
sent.length = 0;
await routeInteraction(btnIx('rate_dislike:s_nope', 'R2', { channelId: 'dm_R2', messageId: 'conc1' }));
{
  const fu = sent.filter((s) => s.url.includes('/webhooks/') && !s.url.includes('/messages/') && s.method === 'POST').pop()?.body;
  ok(str(fu).includes('too old to rate'), 'router: rate_dislike reaches the rating handler');
}
// /stats shows the personal star score
sent.length = 0;
await statsCmd.execute(cmdIx('stats', 'R1'));
{
  const text = str(cbData());
  ok(text.includes('Community rating') && text.includes('5.00 / 5.00') && text.includes('1 rating'),
    '/stats shows the personal star score and vote count');
}

// ---------------------------------------------------------------------------
// K. router
// ---------------------------------------------------------------------------

reset();
onboarded('A');
sent.length = 0;
await routeInteraction(cmdIx('nope', 'A'));
ok(str(cbData()).includes('Unknown Command'), 'router: unknown command');

await matchPair('X', 'Y');
sent.length = 0;
await routeInteraction(btnIx('chat_end', 'X', { channelId: 'dm_X', messageId: greetingMsgId('X') }));
ok(!db.getActiveSessionForUser('X'), 'router: chat_end button ends the session');
ok(dmPosts('Y').length === 2, 'router: chat_end delivers both conclusion messages to the partner');
ok(str(dmPosts('Y')[0].body).includes('Your chat partner left the conversation'),
  'router: chat_end partner notice carries the role context');

sent.length = 0;
await routeInteraction(cmdIx('stats', 'X'));
ok(cbData()?.components?.[0]?.type === 17, 'router: slash command dispatch');

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// L. mandatory onboarding (3-step wizard)
// ---------------------------------------------------------------------------

reset();
sent.length = 0;
await routeInteraction(cmdIx('new', 'OB1'));
{
  const cb = lastCb();
  ok(cb?.type === 4 && cb?.data?.flags === 32832, 'new user /new is intercepted with an ephemeral V2 card');
  ok(str(cb?.data).includes('onboard_start'), 'intercept card carries the Get started button');
  ok(!matchmaking.getQueuePosition('OB1'), 'intercepted user never enters the queue');
}

// step 1: name + date of birth
sent.length = 0;
await routeInteraction(btnIx('onboard_start', 'OB1', {}));
{
  const cb = lastCb();
  ok(cb?.type === 9 && cb?.data?.custom_id === 'onboard_m1', 'Get started opens wizard modal 1');
  ok(cb?.data?.title === 'Create your profile · 1/3', 'modal 1 title');
  const ids = cb.data.components.map((r) => r.component.custom_id);
  ok(ids.join() === 'onboard_name,onboard_dob_day,onboard_dob_month,onboard_dob_year', 'modal 1 has name + DOB fields');
}
sent.length = 0;
{
  const [yy, mm, dd] = dobForAge(21).split('-');
  await routeInteraction(modalUploadIx('onboard_m1', 'OB1', {
    texts: { onboard_name: 'fox', onboard_dob_day: dd, onboard_dob_month: mm, onboard_dob_year: yy },
  }));
}
{
  ok(str(cbData()).includes('onboard_next2'), 'valid step 1 advances to the location/bio prompt');
  const d = db.getOnboardDraft('OB1');
  ok(d && d.step === 2 && d.data.name === 'fox' && d.data.dob === dobForAge(21), 'draft saved at step 2');
  ok(!db.getUserProfile('OB1'), 'no profile record exists before confirmation');
}

// step 2: location + bio
sent.length = 0;
await routeInteraction(btnIx('onboard_next2', 'OB1', {}));
{
  const cb = lastCb();
  ok(cb?.type === 9 && cb?.data?.custom_id === 'onboard_m2', 'Continue opens wizard modal 2');
  const ids = cb.data.components.map((r) => r.component.custom_id);
  ok(ids.join() === 'onboard_location,onboard_bio', 'modal 2 has location + bio fields');
}
sent.length = 0;
await routeInteraction(modalUploadIx('onboard_m2', 'OB1', {
  texts: { onboard_location: 'Dhaka', onboard_bio: 'night owl' },
}));
{
  const s = str(cbData());
  ok(s.includes('onboard_next3') && s.includes('onboard_skip_media'), 'step 2 advances to the media prompt with skip');
  const d = db.getOnboardDraft('OB1');
  ok(d && d.step === 3 && d.data.location === 'Dhaka' && d.data.bio === 'night owl', 'draft saved at step 3');
}

// step 3: photos via the File Upload component
sent.length = 0;
await routeInteraction(btnIx('onboard_next3', 'OB1', {}));
{
  const cb = lastCb();
  ok(cb?.type === 9 && cb?.data?.custom_id === 'onboard_m3', 'Add photos opens wizard modal 3');
  const up = cb.data.components[0].component;
  ok(up.type === 19 && up.required === true && up.min_values === 1 && up.max_values === 6,
    'modal 3 has a required 1-6 file upload');
}
sent.length = 0;
await routeInteraction(modalUploadIx('onboard_m3', 'OB1', {
  uploads: { onboard_media: ['att1'] },
  attachments: attFixture('att1'),
}));
{
  const body = lastEditOriginal();
  ok(body?._multipart, 'preview is sent with the uploaded photo attached');
  const s = str(body);
  ok(s.includes('onboard_confirm') && s.includes('onboard_restart'), 'preview has confirm/restart buttons');
  ok(s.includes('**fox**, 21 · Dhaka · night owl'), 'preview shows the profile headline');
  const d = db.getOnboardDraft('OB1');
  ok(d && d.step === 4 && d.data.media.length === 1, 'draft saved at step 4 with the media');
}

// confirm: the profile record is created
sent.length = 0;
await routeInteraction(btnIx('onboard_confirm', 'OB1', {}));
{
  const p = db.getUserProfile('OB1');
  ok(p && p.name === 'fox' && p.dob === dobForAge(21) && p.is_onboarded, 'confirm creates the profile with a DOB');
  ok(p.location === 'Dhaka' && p.bio === 'night owl', 'location + bio persisted');
  ok(p.media.length === 1, 'media persisted on the profile');
  ok(!('age' in p), 'no static age is stored at onboarding');
  ok(!db.getOnboardDraft('OB1'), 'draft cleared after confirm');
  ok(str(lastEditOriginal()).includes("You're in, fox"), 'success card greets the name');
}
sent.length = 0;
await routeInteraction(cmdIx('new', 'OB1'));
ok(str(cbData()).includes('Searching for a partner'), 'onboarded user /new proceeds to the queue');

// skip path: no photos, straight to preview
reset();
await routeInteraction(btnIx('onboard_start', 'OB2', {}));
{
  const [yy, mm, dd] = dobForAge(30).split('-');
  await routeInteraction(modalUploadIx('onboard_m1', 'OB2', {
    texts: { onboard_name: 'rex', onboard_dob_day: dd, onboard_dob_month: mm, onboard_dob_year: yy },
  }));
}
await routeInteraction(btnIx('onboard_next2', 'OB2', {}));
await routeInteraction(modalUploadIx('onboard_m2', 'OB2', { texts: { onboard_location: '', onboard_bio: '' } }));
sent.length = 0;
await routeInteraction(btnIx('onboard_skip_media', 'OB2', {}));
{
  const body = lastEditOriginal();
  ok(str(body).includes('onboard_confirm'), 'skip lands on the preview step');
  ok(!body.components[1].components.some((c) => c.type === 12), 'preview has no gallery when media was skipped');
}
sent.length = 0;
await routeInteraction(btnIx('onboard_confirm', 'OB2', {}));
{
  const p = db.getUserProfile('OB2');
  ok(p && p.name === 'rex' && p.media.length === 0, 'skipped media confirms fine with no photos');
}

// resume: a half-finished draft reopens at the right step
reset();
db.saveOnboardDraft('OBR', { step: 2, data: { name: 'rex', dob: dobForAge(21), location: '', bio: '', media: [] } });
sent.length = 0;
await routeInteraction(cmdIx('new', 'OBR'));
ok(str(cbData()).includes('Continue setup'), 'returning user gets the resume welcome card');
sent.length = 0;
await routeInteraction(btnIx('onboard_start', 'OBR', {}));
ok(lastCb()?.data?.custom_id === 'onboard_m2', 'resume reopens wizard modal 2');

// restart wipes the draft and starts over
sent.length = 0;
await routeInteraction(btnIx('onboard_restart', 'OBR', {}));
ok(lastCb()?.data?.custom_id === 'onboard_m1', 'start over reopens wizard modal 1');
ok(!db.getOnboardDraft('OBR'), 'restart clears the draft');

// resuming at the preview step keeps the media attached
reset();
{
  const { downloadProfileMedia } = await import('../src/utils/media.js');
  const dl = await downloadProfileMedia('OBP', ['att1'], attFixture('att1'), 20 * 1024 * 1024);
  ok(dl.ok, 'preview-resume fixture media downloads');
  db.saveOnboardDraft('OBP', {
    step: 4,
    data: { name: 'fox', dob: dobForAge(21), location: 'Dhaka', bio: 'night owl', media: dl.media },
  });
}
sent.length = 0;
await routeInteraction(btnIx('onboard_start', 'OBP', {}));
{
  const body = lastEditOriginal();
  ok(body?._multipart, 'resumed preview re-attaches the gallery media');
  ok(body.components[1].components.some((c) => c.type === 12), 'resumed preview shows the media gallery');
  ok(str(body).includes('onboard_confirm'), 'resumed preview has the confirm button');
}

// validation: bad DOB shapes, impossible dates, underage, missing name
reset();
{
  const parts = (age) => { const [yy, mm, dd] = dobForAge(age).split('-'); return [dd, mm, yy]; };
  const [u12d, u12m, u12y] = parts(12);
  const [okd, okm, oky] = parts(21);
  const cases = [
    ['OB3', 'abc', '08', '2001', 'fox', "didn't save", 'non-numeric day'],
    ['OB4', '31', '02', '2001', 'fox', "didn't save", 'impossible date'],
    ['OB6', okd, okm, oky, '', "didn't save", 'missing name'],
  ];
  for (const [uid, dd, mm, yy, name, want, why] of cases) {
    sent.length = 0;
    await routeInteraction(modalUploadIx('onboard_m1', uid, {
      texts: { onboard_name: name, onboard_dob_day: dd, onboard_dob_month: mm, onboard_dob_year: yy },
    }));
    ok(!db.getUserProfile(uid), `invalid step 1 (${why}) creates no profile`);
    ok(str(cbData()).includes(want), `invalid step 1 (${why}) shows the retry card`);
  }
  // under 13: the kind rejection, draft cleared
  sent.length = 0;
  await routeInteraction(modalUploadIx('onboard_m1', 'OB5', {
    texts: { onboard_name: 'fox', onboard_dob_day: u12d, onboard_dob_month: u12m, onboard_dob_year: u12y },
  }));
  ok(!db.getUserProfile('OB5'), 'under-13 step 1 creates no profile');
  ok(str(cbData()).includes('13 and up'), 'under-13 gets the kind rejection card');
  ok(!db.getOnboardDraft('OB5'), 'under-13 clears the draft');
}

// button clicks from strangers are intercepted too
sent.length = 0;
await routeInteraction(btnIx('chat_end', 'OB9', { channelId: 'dm_OB9', messageId: 'card1' }));
ok(str(lastCb()?.data).includes('onboard_start'), 'new user button click is intercepted');

// banned users are denied before onboarding ever comes up
reset();
db.banUser('OB7', 'test ban');
sent.length = 0;
await routeInteraction(cmdIx('new', 'OB7'));
ok(cbData()?.embeds?.[0]?.title === 'Access Denied', 'banned user is denied, not onboarded');
db.unbanUser('OB7');

// onboarded users pass straight through
reset();
db.createProfile({ id: 'OB8', name: 'fox', dob: dobForAge(21), interests: [] });
sent.length = 0;
await routeInteraction(cmdIx('stats', 'OB8'));
ok(cbData()?.components?.[0]?.type === 17, 'onboarded user is never intercepted');

// J. local profanity filter (in-house, PurgoMalum-inspired)
// ---------------------------------------------------------------------------
{
  const { filterText, maskSpan, MASK } = await import('../src/services/profanity.js');
  ok(MASK === '∗', 'masking uses the asterisk operator U+2217, never markdown *');
  let r = filterText('you are a fuck');
  ok(r.flagged && r.text === 'you are a f∗∗k', 'plain profanity masked inline, message preserved');
  r = filterText('what the hell');
  ok(!r.flagged && r.text === 'what the hell', 'soft profanity in isolation passes unmasked');
  r = filterText('shit happens, this is crap');
  ok(!r.flagged && r.text === 'shit happens, this is crap',
    'shit-family is mild now: clean in minor chats with no flaggable company');
  r = filterText('bitch happens, this is crap');
  ok(r.flagged && r.text === 'bi∗ch happens, this is c∗∗p',
    'hard-tier bitch flags; mild crap upgrades beside flaggable company');
  r = filterText('hello world, classic stuff');
  ok(!r.flagged && r.text === 'hello world, classic stuff', 'no false positive inside innocent words');
  r = filterText('I love my class');
  ok(!r.flagged, 'class never trips ass');
  r = filterText('f.u.c.k you');
  ok(r.flagged && r.text === 'f.∗∗∗.k you', 'separator evasion caught');
  r = filterText('@ss and 5h1t');
  ok(r.flagged && r.hits === 2 && r.text === '@∗s and 5∗∗t',
    'sensitive leetspeak still flags in minor chats; mild leet upgrades beside it');
  r = filterText('5h1t');
  ok(!r.flagged && r.text === '5h1t', 'mild leetspeak passes clean alone');
  r = filterText('fuuuck this');
  ok(r.flagged, 'repeated letters caught');
  r = filterText('you bastard');
  ok(!r.flagged && r.text === 'you bastard', 'soft insults pass in isolation');
  r = filterText('you motherfucker');
  ok(r.flagged && r.text === 'you mo∗∗∗∗∗∗∗∗er', 'longer hard words keep first and last two chars');
  r = filterText('FUCK');
  ok(r.flagged && r.text === 'F∗∗K', 'masking preserves original casing');
  r = filterText('c.l.a.s.s dismissed');
  ok(!r.flagged, 'whitelist protects dotted safe words');
  r = filterText('shitake mushrooms and cucumber');
  ok(!r.flagged, 'whitelist protects shitake and cucumber');
  r = filterText('a gay friend');
  ok(!r.flagged, 'identity terms are not profanity');
  r = filterText('this sucks and screw you');
  ok(!r.flagged, 'mild slang outside the list passes');
  r = filterText('fuck shit');
  ok(r.flagged && r.hits === 2 && r.text === 'f∗∗k s∗∗t',
    'sensitive word flags; mild shit upgrades beside flaggable profanity, two hits');
  // Compound rule: a compound word containing a sensitive or mild component is
  // still filtered (it flags the message), with component-wise masking
  r = filterText('you assfuck');
  ok(r.flagged && r.hits === 1 && r.text === 'you a∗sf∗∗k',
    'compound: sensitive components masked like hard ones in minor chats');
  r = filterText('shitfucker');
  ok(r.flagged && r.text === 's∗∗tfu∗∗er',
    'compound: every component masked by the keep-rules in minor chats');
  r = filterText('fuckass');
  ok(r.flagged && r.text === 'f∗∗ka∗s', 'compound: hard component first, sensitive last, both masked');
  r = filterText('5hitfuck3r');
  ok(r.flagged && r.text === '5∗∗tfu∗∗3r', 'compound rule survives leetspeak');
  r = filterText('a.s.s.f.u.c.k');
  ok(r.flagged && r.text === 'a.∗.s.f.∗.∗.k', 'compound rule survives separator evasion');
  r = filterText('shitskin');
  ok(r.flagged && r.text === 's∗∗tskin',
    'compound: mild component masked beside flaggable hard word, neutral filler stays readable');
  // Soft-only compounds pass entirely
  for (const w of ['bullshit', 'dumbass', 'jackass', 'shithole', 'dipshit', 'goddamn']) {
    r = filterText(`that ${w} though`);
    ok(!r.flagged && r.text === `that ${w} though`, `soft-only compound passes: ${w}`);
  }
  // Sensitive words flag on their own in minor chats, mild words only upgrade
  r = filterText('fuck your ass');
  ok(r.flagged && r.hits === 2 && r.text === 'f∗∗k your a∗s',
    'sensitive words masked alongside hard profanity in minor chats');
  r = filterText('i wanna fuck your butt');
  ok(r.flagged && r.text === 'i wanna f∗∗k your b∗∗t',
    'sensitive body-part word masked beside flaggable profanity');
  r = filterText('ass');
  ok(r.flagged && r.text === 'a∗s', 'sensitive words flag alone in minor chats');
  r = filterText('fuck this damn thing');
  ok(r.flagged && r.text === 'f∗∗k this d∗∗n thing',
    'upgrade applies to any soft word next to hard profanity');
  r = filterText('shitfuck');
  ok(r.flagged && r.text === 's∗∗tf∗∗k',
    'compound: sensitive + mild components masked inside compounds in minor chats');
  r = filterText('fuckshit');
  ok(r.flagged && r.text === 'f∗∗ks∗∗t',
    'compound: newly listed fuckshit masks both components in minor chats');
  r = filterText('');
  ok(!r.flagged && r.text === '', 'empty input is clean');
  ok(maskSpan('ab') === '∗∗', 'two-char span fully masked');
}

// ---------------------------------------------------------------------------
// K. age-aware pairing: hard minor/adult wall, sliding window, expansion
// ---------------------------------------------------------------------------
reset();
// (uses the top-level `aged` helper: profiles with a DOB yielding the age;
// `agedExact` for fractional ages in window tests)

// hard wall: 13 and 18 never pair, no matter how long they wait
aged('K13', 13); aged('K18', 18);
await newCmd.execute(cmdIx('new', 'K13'));
sent.length = 0;
await newCmd.execute(cmdIx('new', 'K18'));
ok(!db.getActiveSessionForUser('K13') && !db.getActiveSessionForUser('K18'), '13yo and 18yo never pair (hard wall)');
ok(matchmaking.getQueueSize() === 2, 'both keep waiting across the wall');
matchmaking._setJoinedAtForTests('K13', Date.now() - 3_600_000);
matchmaking._setJoinedAtForTests('K18', Date.now() - 3_600_000);
ok(!(await chat.sweepMatchmaking()), 'sweep never crosses the wall either');
ok(!db.getActiveSessionForUser('K13'), 'wall holds after an hour of waiting');

// minor window: 13 pairs with 15 (exact gap 2.0, at the cap), never with 17 (gap 4.0)
reset();
aged('M13', 13); aged('M15', 15);
await newCmd.execute(cmdIx('new', 'M13'));
sent.length = 0;
await newCmd.execute(cmdIx('new', 'M15'));
ok(!!db.getActiveSessionForUser('M13'), '13yo pairs with 15yo (exact gap 2.0, at the cap)');
reset();
aged('N13', 13); aged('N17', 17);
await newCmd.execute(cmdIx('new', 'N13'));
matchmaking._setJoinedAtForTests('N13', Date.now() - 600_000);
sent.length = 0;
await newCmd.execute(cmdIx('new', 'N17'));
ok(!db.getActiveSessionForUser('N13'), '13yo never pairs with 17yo (gap 4.0 over the 2.0 cap)');

// sliding window replaces fixed sub-bands: 15.0 pairs with 16.5 (gap 1.5)
reset();
agedExact('SW15', 15.0); agedExact('SW165', 16.5);
await newCmd.execute(cmdIx('new', 'SW15'));
sent.length = 0;
await newCmd.execute(cmdIx('new', 'SW165'));
ok(!!db.getActiveSessionForUser('SW15'), '15.0yo pairs with 16.5yo (gap 1.5 inside the window)');

// ...but never with 17.5 (gap 2.5), and the window never expands with waiting
reset();
agedExact('FW15', 15.0); agedExact('FW175', 17.5);
await newCmd.execute(cmdIx('new', 'FW15'));
sent.length = 0;
await newCmd.execute(cmdIx('new', 'FW175'));
ok(!db.getActiveSessionForUser('FW15'), '15.0yo never pairs with 17.5yo (gap 2.5 over the cap)');
ok(matchmaking.getQueueSize() === 2, 'both keep waiting outside the window');
matchmaking._setJoinedAtForTests('FW15', Date.now() - 3_600_000);
matchmaking._setJoinedAtForTests('FW175', Date.now() - 3_600_000);
ok(!(await chat.sweepMatchmaking()), 'minor window never expands, even after an hour');

// tier wall beats the window: 17.9yo minor and 18.1yo adult never pair (gap 0.2)
reset();
agedExact('TW179', 17.9); agedExact('TW181', 18.1);
await newCmd.execute(cmdIx('new', 'TW179'));
sent.length = 0;
await newCmd.execute(cmdIx('new', 'TW181'));
ok(!db.getActiveSessionForUser('TW179'), 'tier wall holds: 17.9yo minor never pairs with 18.1yo adult');
ok(matchmaking.getQueueSize() === 2, 'both keep waiting across the wall');

// adults: close ages pair at once, far ages wait; expansion resolves with time
reset();
aged('C20', 20); aged('C30', 30); aged('C22', 22);
await newCmd.execute(cmdIx('new', 'C20'));
sent.length = 0;
await newCmd.execute(cmdIx('new', 'C30'));
ok(!db.getActiveSessionForUser('C20'), '20yo and 30yo do not pair immediately (gap 10 over base 5)');
sent.length = 0;
await newCmd.execute(cmdIx('new', 'C22'));
{
  const s = db.getActiveSessionForUser('C22');
  const other = s ? (s.user1_id === 'C22' ? s.user2_id : s.user1_id) : null;
  ok(other === 'C20', 'closest age wins: 22 pairs with 20, not 30');
}
reset();
aged('E25', 25); aged('E33', 33);
await newCmd.execute(cmdIx('new', 'E25'));
await newCmd.execute(cmdIx('new', 'E33'));
ok(!db.getActiveSessionForUser('E25'), '25yo and 33yo do not pair at once (gap 8 over base 5)');
matchmaking._setJoinedAtForTests('E25', Date.now() - 180_000);
matchmaking._setJoinedAtForTests('E33', Date.now() - 180_000);
ok(await chat.sweepMatchmaking(), 'sweep pairs them once both waited (gap 8 within 11)');
ok(!!db.getActiveSessionForUser('E25'), 'expanded pair starts a session');
// adult cap: 18 and 40 (gap 22) never pair
reset();
aged('W18', 18); aged('W40', 40);
await newCmd.execute(cmdIx('new', 'W18'));
await newCmd.execute(cmdIx('new', 'W40'));
matchmaking._setJoinedAtForTests('W18', Date.now() - 3_600_000);
matchmaking._setJoinedAtForTests('W40', Date.now() - 3_600_000);
ok(!(await chat.sweepMatchmaking()), 'adult gap capped at 15: 18yo and 40yo never pair');

// ---------------------------------------------------------------------------
// L. profanity pipeline: per-message limits, warnings, termination, mod logs
// ---------------------------------------------------------------------------
{
  const { readFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const modlogFor = (sid) => join('./tests/.data-remake', 'modlogs', `${sid}.json`);
  const pairAged = async (a, ageA, b, ageB) => {
    aged(a, ageA); aged(b, ageB);
    await newCmd.execute(cmdIx('new', a));
    sent.length = 0;
    await newCmd.execute(cmdIx('new', b));
    sent.length = 0;
  };
  const fdm = (uid, content) => ({
    id: 'm1', channel_id: `dm_${uid}`, type: 0,
    author: { id: uid, bot: false }, content, attachments: [],
  });
  const posts = (uid) => sent.filter((s) => s.url.includes(`/channels/dm_${uid}/messages`) && s.method === 'POST');
  const embedsTo = (uid) => posts(uid).filter((s) => s.body?.embeds);

  // minor session: strikes 1-3 warn, the 4th terminates immediately (no final warning)
  reset();
  await pairAged('F13', 13, 'F15', 15);
  ok(!!db.getActiveSessionForUser('F13'), 'minor pair matched for the pipeline test');
  await chat.handleDirectMessage(fdm('F15', 'hey there'));
  for (let i = 1; i <= 3; i++) {
    chat._resetRelayForTests();
    sent.length = 0;
    await chat.handleDirectMessage(fdm('F13', `you are a fuck ${i}`));
    const toPartner = posts('F15');
    ok(toPartner.length === 1 && str(toPartner[0].body).includes('f∗∗k'),
      `minor strike ${i}: masked message still delivered`);
    const toSender = posts('F13');
    ok(toSender.length === 1 && str(toSender[0]).includes('We masked some language'),
      `minor strike ${i}: sender warned`);
    ok(str(toSender[0]).includes(`**\`${4 - i}\`** more flagged`),
      `minor strike ${i}: warning shows **\`${4 - i}\`** remaining in bold inline code`);
    ok(!!db.getActiveSessionForUser('F13'), `minor strike ${i}: chat survives`);
  }
  const sid = db.getActiveSessionForUser('F13').session_id;
  chat._resetRelayForTests();
  sent.length = 0;
  await chat.handleDirectMessage(fdm('F13', 'fuck this shit'));
  ok(!db.getActiveSessionForUser('F13') && !db.getActiveSessionForUser('F15'),
    'minor chat terminated on the 4th flagged message');
  const termOff = embedsTo('F13'), termPar = embedsTo('F15');
  ok(termOff.length === 1 && termOff[0].body.embeds[0].title === '📊 Session Overview',
    'offender gets the standardized overview embed as message 2');
  ok(termPar.length === 1 && termPar[0].body.embeds[0].title === '📊 Session Overview',
    'partner gets the standardized overview embed as message 2');
  {
    const fields = termOff[0].body.embeds[0].fields || [];
    const names = fields.map((f) => f.name).join('|');
    ok(names.includes('Text Messages') && names.includes('Attachments') && names.includes('Chat Duration'),
      'overview embed carries the session stats for both sides');
    ok(fields.every((f) => String(f.value).length > 0), 'overview stats fields are populated');
  }
  const statusOff = posts('F13').filter((s) => !s.body?.embeds);
  ok(statusOff.length === 1 && str(statusOff[0].body).includes('This chat was ended automatically'),
    'offender gets the safety status card as message 1 (no redundant warning on the final strike)');
  ok(str(statusOff[0].body).includes('`/new`'),
    'safety status card wraps /new in backticks');
  const statusPar = posts('F15').filter((s) => !s.body?.embeds);
  ok(statusPar.length === 2, 'partner gets the relayed message plus their safety status card');
  ok(statusPar.some((s) => str(s.body).includes('f∗∗k')),
    'final flagged message relayed masked before termination');
  ok(statusPar.some((s) => str(s.body).includes('This chat was ended automatically')),
    'partner gets the safety status card');
  ok(existsSync(modlogFor(sid)), 'modlog file saved for the terminated session');
  {
    const log = JSON.parse(readFileSync(modlogFor(sid), 'utf8'));
    ok(log.reason === 'profanity_limit' && log.minor_chat === true,
      'modlog marks a minor-chat profanity termination');
    ok(log.offender_user_id === 'F13' && log.offender_flagged_messages === 4,
      'modlog records the offender and the strike count');
    ok(log.messages.length === 5 && log.messages.every((m) => m.from && m.at && typeof m.text === 'string'),
      'modlog holds the compacted chat history (clean + flagged messages)');
    ok(log.messages.some((m) => m.text === 'hey there'), 'modlog keeps the original unmasked text');
  }

  // adult session: strikes 1-9 warn, the 10th terminates immediately (no final warning)
  reset();
  await pairAged('G20', 20, 'G25', 25);
  ok(!!db.getActiveSessionForUser('G20'), 'adult pair matched for the pipeline test');
  for (let i = 1; i <= 9; i++) {
    chat._resetRelayForTests();
    sent.length = 0;
    // strike 5 packs three hard-tier words into ONE message: still one strike
    // (mild words upgrade next to hard profanity but strikes are per message)
    await chat.handleDirectMessage(fdm('G20', i === 5 ? 'bitch dick hell' : `bitch ${i}`));
    ok(!!db.getActiveSessionForUser('G20'), `adult strike ${i}: chat survives`);
  }
  {
    const warns = posts('G20');
    ok(warns.length === 1 && str(warns[0]).includes('**`1`** more flagged message'),
      '9th strike warns with **`1`** remaining (singular)');
  }
  chat._resetRelayForTests();
  sent.length = 0;
  await chat.handleDirectMessage(fdm('G20', 'bitch 10'));
  ok(!db.getActiveSessionForUser('G20'), 'adult chat terminated on the 10th flagged message');
  ok(embedsTo('G20').length === 1 && embedsTo('G25').length === 1,
    'both sides get the overview embed on adult limit');
}

// ---------------------------------------------------------------------------
// L2. tiered profanity filtering (minor vs adult)
// ---------------------------------------------------------------------------
{
  const { readFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { filterText } = await import('../src/services/profanity.js');
  const modlogFor = (sid) => join('./tests/.data-remake', 'modlogs', `${sid}.json`);
  const pairAged = async (a, ageA, b, ageB) => {
    aged(a, ageA); aged(b, ageB);
    await newCmd.execute(cmdIx('new', a));
    sent.length = 0;
    await newCmd.execute(cmdIx('new', b));
    sent.length = 0;
  };
  const fdm = (uid, content) => ({
    id: 'm1', channel_id: `dm_${uid}`, type: 0,
    author: { id: uid, bot: false }, content, attachments: [],
  });
  const posts = (uid) => sent.filter((s) => s.url.includes(`/channels/dm_${uid}/messages`) && s.method === 'POST');

  // --- unit layer: filterText with an explicit chat tier ---
  reset();

  // hard tier: masked + flagged in both chat types
  let r = filterText('bitch please', { adultChat: false });
  ok(r.flagged && r.text === 'bi∗ch please', 'minor: hard words masked and flagged');
  r = filterText('bitch please', { adultChat: true });
  ok(r.flagged && r.text === 'bi∗ch please', 'adult: hard words masked and flagged identically');

  // sensitive hard tier: minor flags, adult skips entirely
  for (const [word, masked] of [['fuck', 'f∗∗k']]) {
    r = filterText(`you are a ${word}`, { adultChat: false });
    ok(r.flagged && r.text === `you are a ${masked}`, `minor: sensitive word masked and flagged (${word})`);
    r = filterText(`you are a ${word}`, { adultChat: true });
    ok(!r.flagged && r.text === `you are a ${word}`, `adult: sensitive word passes clean (${word})`);
  }
  // shit-family reclassified mild 2026-09-21: clean alone in both chat types
  for (const word of ['shit', 'shits', 'shitty', 'shite', 'shart', '5h1t', 'sh1t', 's_h_i_t']) {
    r = filterText(word, { adultChat: false });
    ok(!r.flagged && r.text === word, `minor: mild shit-family word passes alone (${word})`);
    r = filterText(word, { adultChat: true });
    ok(!r.flagged && r.text === word, `adult: mild shit-family word passes alone (${word})`);
  }

  // sensitive soft tier: ass/butt mask in minor, pass clean in adult
  r = filterText('ass', { adultChat: false });
  ok(r.flagged && r.text === 'a∗s', 'minor: sensitive soft word flags alone');
  r = filterText('ass', { adultChat: true });
  ok(!r.flagged && r.text === 'ass', 'adult: sensitive soft word passes alone');
  r = filterText('butt', { adultChat: false });
  ok(r.flagged && r.text === 'b∗∗t', 'minor: butt flags alone');
  r = filterText('butt', { adultChat: true });
  ok(!r.flagged && r.text === 'butt', 'adult: butt passes alone');

  // mild tier: clean in isolation in both chat types
  r = filterText('what the hell', { adultChat: false });
  ok(!r.flagged && r.text === 'what the hell', 'minor: mild words pass alone');
  r = filterText('what the hell', { adultChat: true });
  ok(!r.flagged && r.text === 'what the hell', 'adult: mild words pass alone');

  // the upgrade rule follows the flaggable word, not the tier
  r = filterText('fuck hell', { adultChat: false });
  ok(r.flagged && r.hits === 2 && r.text === 'f∗∗k h∗∗l',
    'minor: mild word masked beside a flaggable sensitive word');
  r = filterText('fuck hell', { adultChat: true });
  ok(!r.flagged && r.text === 'fuck hell', 'adult: nothing flaggable, nothing masked');
  r = filterText('bitch hell', { adultChat: true });
  ok(r.flagged && r.hits === 2 && r.text === 'bi∗ch h∗∗l',
    'adult: mild word masked beside a hard word');
  // the upgrade rule still catches mild shit beside flaggable words, both tiers
  r = filterText('shit bitch', { adultChat: false });
  ok(r.flagged && r.hits === 2 && r.text === 's∗∗t bi∗ch',
    'minor: mild shit masked beside a hard word');
  r = filterText('shit bitch', { adultChat: true });
  ok(r.flagged && r.hits === 2 && r.text === 's∗∗t bi∗ch',
    'adult: mild shit masked beside a hard word too');

  // compounds in both chat types
  r = filterText('assfuck', { adultChat: false });
  ok(r.flagged && r.text === 'a∗sf∗∗k', 'minor: sensitive-only compound masked component-wise');
  r = filterText('assfuck', { adultChat: true });
  ok(!r.flagged && r.text === 'assfuck', 'adult: sensitive-only compound passes clean');
  r = filterText('pussyfart', { adultChat: false });
  ok(r.flagged && r.text === 'pu∗syf∗∗t', 'minor: hard+mild compound masked component-wise');
  r = filterText('pussyfart', { adultChat: true });
  ok(r.flagged && r.text === 'pu∗syf∗∗t', 'adult: hard component still masked in compounds');
  r = filterText('fuckbitch', { adultChat: false });
  ok(r.flagged && r.text === 'f∗∗kbi∗ch', 'minor: mixed compound masked per component');
  r = filterText('fuckbitch', { adultChat: true });
  ok(r.flagged && r.text === 'fuckbi∗ch', 'adult: mixed compound masks only the hard component');
  r = filterText('shitfuck', { adultChat: false });
  ok(r.flagged && r.text === 's∗∗tf∗∗k', 'minor: sensitive+mild compound both components masked');
  r = filterText('shitfuck', { adultChat: true });
  ok(!r.flagged && r.text === 'shitfuck', 'adult: non-mixed sensitive compound passes clean');
  r = filterText('shitfucker', { adultChat: false });
  ok(r.flagged && r.text === 's∗∗tfu∗∗er', 'minor: mild anchor keeps compound components split');
  r = filterText('shitfucker', { adultChat: true });
  ok(!r.flagged && r.text === 'shitfucker', 'adult: non-mixed sensitive compound passes clean');
  r = filterText('fuckshit', { adultChat: false });
  ok(r.flagged && r.text === 'f∗∗ks∗∗t', 'minor: newly listed fuckshit masks both components');
  r = filterText('fuckshit', { adultChat: true });
  ok(!r.flagged && r.text === 'fuckshit', 'adult: fuckshit passes clean (not mixed)');
  r = filterText('fuckingshitmotherfucker', { adultChat: false });
  ok(r.flagged && r.text === 'fu∗∗∗ngs∗∗tmo∗∗∗∗∗∗∗∗er',
    'minor: long sensitive compound keeps its exact mask shape');
  r = filterText('fuckingshitmotherfucker', { adultChat: true });
  ok(!r.flagged && r.text === 'fuckingshitmotherfucker',
    'adult: non-mixed long compound passes clean');
  r = filterText('shitskin', { adultChat: false });
  ok(r.flagged && r.text === 's∗∗tskin', 'minor: hard compound masks the mild component, filler readable');
  r = filterText('shitskin', { adultChat: true });
  ok(r.flagged && r.text === 's∗∗tskin', 'adult: shitskin is hard now, flagged in both tiers');

  // mixed-sensitive entries: adult chats mask the genuine hard component only
  r = filterText('shitdick', { adultChat: true });
  ok(r.flagged && r.text === 'shitd∗∗k', 'adult: mixed compound masks the hard component');
  r = filterText('titfuck', { adultChat: true });
  ok(r.flagged && r.text === 't∗tfuck', 'adult: mixed compound keeps the sensitive component readable');
  r = filterText('titfuck', { adultChat: false });
  ok(r.flagged && r.text === 't∗tf∗∗k', 'minor: mixed compound masked per component');

  // leet and separator evasion, per tier
  r = filterText('@ss and 5h1t', { adultChat: false });
  ok(r.flagged && r.text === '@∗s and 5∗∗t', 'minor: sensitive leetspeak flagged');
  r = filterText('@ss and 5h1t', { adultChat: true });
  ok(!r.flagged && r.text === '@ss and 5h1t', 'adult: sensitive leetspeak passes');
  r = filterText('f.u.c.k', { adultChat: false });
  ok(r.flagged && r.text === 'f.∗∗∗.k', 'minor: sensitive separator evasion flagged');
  r = filterText('f.u.c.k', { adultChat: true });
  ok(!r.flagged && r.text === 'f.u.c.k', 'adult: sensitive separator evasion passes');

  // whitelist and soft-only compounds stay clean in both tiers
  for (const w of ['bullshit', 'dumbass', 'jackass', 'c.l.a.s.s']) {
    r = filterText(`that ${w} though`, { adultChat: false });
    ok(!r.flagged, `minor: clean compound passes (${w})`);
    r = filterText(`that ${w} though`, { adultChat: true });
    ok(!r.flagged, `adult: clean compound passes (${w})`);
  }

  // --- pipeline layer: handleDirectMessage with real sessions ---
  // minor pair: sensitive words relay masked, warn, accrue strikes to the 4-limit
  reset();
  await pairAged('L2A', 15, 'L2B', 16);
  ok(!!db.getActiveSessionForUser('L2A'), 'minor pair matched for the tiered pipeline test');
  for (let i = 1; i <= 3; i++) {
    chat._resetRelayForTests();
    sent.length = 0;
    await chat.handleDirectMessage(fdm('L2A', 'ass happens'));
    const toPartner = posts('L2B');
    ok(toPartner.length === 1 && str(toPartner[0].body).includes('a∗s happens'),
      `minor sensitive strike ${i}: masked relay still delivered`);
    ok(posts('L2A').length === 1 && str(posts('L2A')[0]).includes('We masked some language'),
      `minor sensitive strike ${i}: sender warned`);
    ok(!!db.getActiveSessionForUser('L2A'), `minor sensitive strike ${i}: chat survives`);
  }
  const sid = db.getActiveSessionForUser('L2A').session_id;
  chat._resetRelayForTests();
  sent.length = 0;
  await chat.handleDirectMessage(fdm('L2A', 'ass happens'));
  ok(!db.getActiveSessionForUser('L2A') && !db.getActiveSessionForUser('L2B'),
    'minor chat terminated on the 4th sensitive strike');
  ok(existsSync(modlogFor(sid)), 'modlog saved for the minor-chat termination');
  {
    const log = JSON.parse(readFileSync(modlogFor(sid), 'utf8'));
    ok(log.reason === 'profanity_limit' && log.minor_chat === true,
      'modlog marks the minor-chat profanity termination');
    ok(log.offender_user_id === 'L2A' && log.offender_flagged_messages === 4,
      'modlog records the offender and the strike count');
  }

  // adult pair: the same sensitive word relays clean, no warning, no strike
  reset();
  await pairAged('L2C', 20, 'L2D', 25);
  ok(!!db.getActiveSessionForUser('L2C'), 'adult pair matched for the tiered pipeline test');
  for (let i = 1; i <= 12; i++) {
    chat._resetRelayForTests();
    sent.length = 0;
    await chat.handleDirectMessage(fdm('L2C', 'shit happens'));
    ok(posts('L2D').length === 1 && str(posts('L2D')[0].body).includes('shit happens')
      && !str(posts('L2D')[0].body).includes('∗'),
      `adult sensitive message ${i}: relayed clean`);
    ok(posts('L2C').length === 0, `adult sensitive message ${i}: no warning to sender`);
  }
  ok(!!db.getActiveSessionForUser('L2C'), 'adult chat survives a dozen sensitive messages');
  // and they accrued zero strikes: the next hard word warns with 9 remaining
  chat._resetRelayForTests();
  sent.length = 0;
  await chat.handleDirectMessage(fdm('L2C', 'bitch please'));
  ok(posts('L2C').length === 1 && str(posts('L2C')[0]).includes('**`9`** more flagged'),
    'adult sensitive messages accrued no strikes (hard word warns with 9 remaining)');

  // unknown age fails safe to minor behavior
  reset();
  db.createProfile({ id: 'L2E', name: 'user_L2E', interests: [] }); // no DOB on file
  aged('L2F', 15);
  await newCmd.execute(cmdIx('new', 'L2E'));
  sent.length = 0;
  await newCmd.execute(cmdIx('new', 'L2F'));
  sent.length = 0;
  ok(!!db.getActiveSessionForUser('L2E'), 'unknown-age user still matches in the minor tier');
  chat._resetRelayForTests();
  sent.length = 0;
  await chat.handleDirectMessage(fdm('L2E', 'ass happens'));
  ok(posts('L2F').length === 1 && str(posts('L2F')[0].body).includes('a∗s happens'),
    'unknown age: sensitive word relayed masked like a minor chat');
  ok(posts('L2E').length === 1 && str(posts('L2E')[0]).includes('We masked some language'),
    'unknown age: sender warned like a minor chat');

  // shit-family reclassified mild 2026-09-21: shit-only messages never
  // strike, not even in minor chats
  reset();
  await pairAged('L2M', 15, 'L2N', 16);
  ok(!!db.getActiveSessionForUser('L2M'), 'minor pair matched for the mild-shit pipeline test');
  for (let i = 1; i <= 5; i++) {
    chat._resetRelayForTests();
    sent.length = 0;
    await chat.handleDirectMessage(fdm('L2M', 'shit happens'));
    ok(posts('L2N').length === 1 && str(posts('L2N')[0].body).includes('shit happens')
      && !str(posts('L2N')[0].body).includes('∗'),
      `minor shit-only message ${i}: relayed clean`);
    ok(posts('L2M').length === 0, `minor shit-only message ${i}: no warning to sender`);
  }
  ok(!!db.getActiveSessionForUser('L2M'), 'minor chat survives five shit-only messages');
  // mild leetspeak alone is clean too
  chat._resetRelayForTests();
  sent.length = 0;
  await chat.handleDirectMessage(fdm('L2M', '5h1t happens'));
  ok(posts('L2N').length === 1 && str(posts('L2N')[0].body).includes('5h1t happens')
    && !str(posts('L2N')[0].body).includes('∗'),
    'minor: mild leetspeak alone relayed clean');
  ok(posts('L2M').length === 0, 'minor: mild leetspeak alone warns nobody');
  // and they accrued zero strikes: the next hard word warns with 3 remaining
  chat._resetRelayForTests();
  sent.length = 0;
  await chat.handleDirectMessage(fdm('L2M', 'bitch please'));
  ok(posts('L2M').length === 1 && str(posts('L2M')[0]).includes('**`3`** more flagged'),
    'shit-only messages accrued no strikes (hard word warns with 3 remaining)');

  // hard-word control: bitch flags identically in both chat types
  reset();
  await pairAged('L2G', 15, 'L2H', 16);
  chat._resetRelayForTests();
  sent.length = 0;
  await chat.handleDirectMessage(fdm('L2G', 'bitch please'));
  ok(posts('L2H').length === 1 && str(posts('L2H')[0].body).includes('bi∗ch please'),
    'minor: hard word relayed masked');
  ok(posts('L2G').length === 1 && str(posts('L2G')[0]).includes('We masked some language'),
    'minor: hard word warns the sender');
  reset();
  await pairAged('L2I', 20, 'L2J', 25);
  chat._resetRelayForTests();
  sent.length = 0;
  await chat.handleDirectMessage(fdm('L2I', 'bitch please'));
  ok(posts('L2J').length === 1 && str(posts('L2J')[0].body).includes('bi∗ch please'),
    'adult: hard word relayed masked identically');
  ok(posts('L2I').length === 1 && str(posts('L2I')[0]).includes('We masked some language'),
    'adult: hard word warns the sender identically');
}

// ---------------------------------------------------------------------------
// R1. profanity warning format: single streamlined message, bold code count
// ---------------------------------------------------------------------------
{
  const plural = str(embeds.profanityWarningCard(3));
  ok(!plural.includes('Quick heads up'), 'warning has no separate header line');
  ok(!plural.includes('\\n'), 'warning is one unbroken paragraph');
  ok(plural.includes('⚠️ We masked some language in your last message before passing it along.'),
    'warning keeps the masking notice');
  ok(plural.includes('**`3`** more flagged messages'),
    'remaining count is bold inline code with plural noun (X > 1)');
  const singular = str(embeds.profanityWarningCard(1));
  ok(singular.includes('**`1`** more flagged message before'),
    'singular noun when exactly 1 remains');
  ok(!singular.includes('flagged messages'), 'no plural noun in the singular case');
}

// ---------------------------------------------------------------------------
// R. session conclusion experience (status card, overview embed, roles, metrics, timeout)
// ---------------------------------------------------------------------------

// formatDuration: natural phrasing per length
{
  ok(embeds.formatDuration(0) === '0 seconds', 'duration: 0s');
  ok(embeds.formatDuration(1000) === '1 second', 'duration: 1s singular');
  ok(embeds.formatDuration(45000) === '45 seconds', 'duration: seconds');
  ok(embeds.formatDuration(60000) === '1 minute', 'duration: 1m singular');
  ok(embeds.formatDuration(90000) === '1 minute 30 seconds', 'duration: m + s');
  ok(embeds.formatDuration(180000) === '3 minutes', 'duration: minutes, no dangling seconds');
  ok(embeds.formatDuration(3600000) === '1 hour', 'duration: 1h singular');
  ok(embeds.formatDuration(7500000) === '2 hours 5 minutes', 'duration: h + m');
}

// message 1: status + reconnect card roles render the right context line
{
  const roles = {
    ender: 'You ended the chat',
    blocker: 'You blocked this stranger',
    partner: 'Your chat partner left the conversation',
    timeout: 'This chat timed out',
    disconnected: 'Your chat partner disconnected',
    unavailable: 'Your chat partner is no longer available',
    mod: 'This chat was ended automatically',
  };
  for (const [role, line] of Object.entries(roles)) {
    const card = embeds.statusReconnectCard(role, 's_abc123');
    ok(card[0].type === 17, `status card (${role}) is a V2 container`);
    const text = card[0].components[0].content;
    ok(text.includes(line), `status card (${role}) shows its context line`);
    ok(!text.includes('\n'), `status card (${role}) blends context + invite in one unbroken paragraph`);
    ok(text.includes('`/new`'), `status card (${role}) wraps /new in backticks`);
    ok(text.includes('👍') && text.includes('👎'), `status card (${role}) invites an optional rating`);
    ok(card[0].components[1].type === 14 && card[0].components[1].divider === true,
      `status card (${role}) has the divider directly under the text`);
    const btns = card[0].components[2].components;
    ok(btns.length === 3, `status card (${role}) has three action buttons`);
    ok(btns[0].custom_id === 'rate_like:s_abc123' && btns[0].label === 'Like',
      `status card (${role}) leads with Like`);
    ok(btns[1].custom_id === 'rate_dislike:s_abc123' && btns[1].label === 'Dislike',
      `status card (${role}) has Dislike second`);
    ok(btns[2].custom_id === 'chat_find_new' && btns[2].label === 'Find someone new',
      `status card (${role}) keeps find-new third`);
  }
}

// message 2: the overview embed is identical across every exit scenario
{
  const s = { textMessages: 4, attachments: 2, durationMs: 125000 };
  const embed = embeds.sessionOverviewEmbed(s);
  ok(embed.title === '📊 Session Overview', 'overview embed title');
  const fields = embed.fields || [];
  ok(fields.length === 3, 'overview embed has exactly three fields');
  ok(fields[0].name === '💬 Text Messages' && fields[0].value === '4',
    'overview embed counts text messages');
  ok(fields[1].name === '📎 Attachments' && fields[1].value === '2',
    'overview embed counts attachments');
  ok(fields[2].name === '⏱️ Chat Duration' && fields[2].value === '2 minutes 5 seconds',
    'overview embed shows the human duration');
  ok(!embed.components, 'overview embed carries zero buttons');
}

// relayed traffic feeds the session stats; the end card reports them
reset();
await matchPair('S1', 'S2');
{
  const dm = (uid, content, attachments = []) => ({
    id: 'm1', channel_id: `dm_${uid}`, type: 0,
    author: { id: uid, bot: false }, content, attachments,
  });
  sent.length = 0;
  await chat.handleDirectMessage(dm('S1', 'hello there'));
  chat._resetRelayForTests();
  await chat.handleDirectMessage(dm('S2', 'hey', [
    { url: 'https://cdn.discordapp.com/a.png', filename: 'a.png', content_type: 'image/png', size: 100 },
    { url: 'https://cdn.discordapp.com/b.mp3', filename: 'b.mp3', content_type: 'audio/mpeg', size: 100 },
  ]));
  chat._resetRelayForTests();
  await chat.handleDirectMessage(dm('S1', '', [
    { url: 'https://cdn.discordapp.com/c.txt', filename: 'c.txt', content_type: 'text/plain', size: 100 },
  ]));
  const session = db.getActiveSessionForUser('S1');
  ok(session.stats.text === 2 && session.stats.attachments === 3,
    'session stats count relayed texts (2) and attachments (3)');
  sent.length = 0;
  await chat.handleChatEnd(btnIx('chat_end', 'S1', { channelId: 'dm_S1', messageId: greetingMsgId('S1') }));
  const toS2 = dmPosts('S2');
  ok(toS2.length === 2, 'partner gets exactly two conclusion messages, in order');
  ok(toS2[0].body.flags === 32768 && (toS2[0].body.flags & 64) === 0,
    'conclusion DMs carry no ephemeral flag');
  const s2 = str(toS2[0].body);
  ok(s2.includes('Your chat partner left the conversation') && s2.includes('chat_find_new'),
    'message 1 is the status + reconnect card');
  const ov = toS2[1].body.embeds?.[0];
  ok(ov?.title === '📊 Session Overview', 'message 2 is the session overview embed');
  const vals = Object.fromEntries((ov.fields || []).map((f) => [f.name, f.value]));
  ok(vals['💬 Text Messages'] === '2' && vals['📎 Attachments'] === '3',
    'overview reports the exchanged message + attachment counts');
  ok(typeof vals['⏱️ Chat Duration'] === 'string' && vals['⏱️ Chat Duration'].length > 0,
    'overview reports the chat duration');
}

// idle timeout sweep wraps up quiet sessions with the timeout card
reset();
await matchPair('T1', 'T2');
{
  const session = db.getActiveSessionForUser('T1');
  session.lastActivityAt = Date.now() - 31 * 60_000; // quiet for 31 minutes
  session.started_at = Date.now() - 32 * 60_000;
  sent.length = 0;
  await chat.sweepIdleSessions();
  ok(!db.getActiveSessionForUser('T1') && !db.getActiveSessionForUser('T2'),
    'idle sweep ends sessions quiet past the timeout');
  const toT1 = dmPosts('T1'), toT2 = dmPosts('T2');
  ok(toT1.length === 2 && toT2.length === 2, 'idle sweep delivers both conclusion messages to each side');
  ok(str(toT1[0].body).includes('This chat timed out') && str(toT2[0].body).includes('This chat timed out'),
    'timeout card explains the quiet-close to both sides');
  ok(str(toT1[1].body).includes('32 minutes'), 'timeout overview shows the full session duration');
}
reset();
await matchPair('U1', 'U2');
{
  const session = db.getActiveSessionForUser('U1');
  session.lastActivityAt = Date.now() - 5 * 60_000; // active 5 minutes ago
  sent.length = 0;
  await chat.sweepIdleSessions();
  ok(!!db.getActiveSessionForUser('U1'), 'idle sweep leaves recently active sessions alone');
  ok(dmPosts('U1').length === 0 && dmPosts('U2').length === 0, 'no timeout cards for active sessions');
}

// ---------------------------------------------------------------------------
// S. queue fizzle + stale-cancel regression (matchmaking robustness)
// ---------------------------------------------------------------------------

// S1. DM-failure requeue: A queued, B joins, one greeting DM fails.
// Neither user may be stranded: no live session, both back in the queue
// with their original joinedAt, reachable side told honestly.
{
  reset();
  onboarded('QA1'); onboarded('QA2');
  const t0 = Date.now() - 120_000; // QA1 has been waiting 2 minutes
  await newCmd.execute(cmdIx('new', 'QA1'));
  matchmaking._setJoinedAtForTests('QA1', t0);
  failDMFor.add('QA2'); // QA2's greeting DM will fail (closed DMs)
  sent.length = 0;
  await newCmd.execute(cmdIx('new', 'QA2'));
  failDMFor.clear();
  ok(!db.getActiveSessionForUser('QA1') && !db.getActiveSessionForUser('QA2'),
    'fizzle: no live session after a failed greeting DM');
  ok(matchmaking.getQueuePosition('QA1'), 'fizzle: QA1 back in queue, not stranded');
  ok(!matchmaking.getQueuePosition('QA2'),
    'fizzle: QA2 (closed DMs) NOT re-queued — no infinite fizzle loop');
  ok(matchmaking._getJoinedAtForTests?.('QA1') === t0, 'fizzle: QA1 kept original joinedAt');
  ok(dmPosts('QA1').some((s) => str(s.body).includes('back in the queue')),
    'fizzle: reachable side got the honest back-in-queue card');
  ok(!dmPosts('QA2').some((s) => str(s.body).includes('back in the queue')),
    'fizzle: unreachable side got no card (nothing to tell them on)');
  // QA2 is not stranded: a fresh /new works once their DMs are reachable.
  failDMFor.clear();
  sent.length = 0;
  await newCmd.execute(cmdIx('new', 'QA2'));
  ok(!!db.getActiveSessionForUser('QA2'), 'fizzle: QA2 can /new again afterwards (not stuck)');
}

// S2. Stale cancel: a Cancel tap on an OLD searching card must not yank the
// user out of their CURRENT search episode.
{
  reset();
  onboarded('QB1'); onboarded('QB2');
  await newCmd.execute(cmdIx('new', 'QB1')); // queued, searching card issued
  const m1 = typeof matchmaking.getSearchingCardId === 'function'
    ? matchmaking.getSearchingCardId('QB1') : 'stale_card_1';
  sent.length = 0;
  await newCmd.execute(cmdIx('new', 'QB2')); // match -> session
  ok(!!db.getActiveSessionForUser('QB1'), 'stale-cancel: QB1 matched');
  const g1 = greetingMsgId('QB1');
  await chat.handleChatEnd(btnIx('chat_end', 'QB1', { channelId: 'dm_QB1', messageId: g1 }));
  ok(!db.getActiveSessionForUser('QB1'), 'stale-cancel: chat ended');
  sent.length = 0;
  await chat.handleChatFindNew(btnIx('chat_find_new', 'QB1', { channelId: 'dm_QB1', messageId: 'm2card' }));
  ok(matchmaking.getQueuePosition('QB1'), 'stale-cancel: QB1 re-queued (new episode)');
  const m2 = typeof matchmaking.getSearchingCardId === 'function'
    ? matchmaking.getSearchingCardId('QB1') : 'm2card';
  ok(m1 !== m2, 'stale-cancel: the new episode has a different card id');
  // The stale tap on the OLD card must leave the current queue untouched.
  sent.length = 0;
  await chat.handleQueueCancel(btnIx('queue_cancel', 'QB1', { channelId: 'dm_QB1', messageId: m1 }));
  ok(matchmaking.getQueuePosition('QB1'), 'stale-cancel: old card tap leaves the current queue intact');
  ok(str(cbData() || '').includes('already ended'), 'stale-cancel: stale tap gets an ephemeral explanation');
  // The CURRENT card still cancels for real.
  await chat.handleQueueCancel(btnIx('queue_cancel', 'QB1', { channelId: 'dm_QB1', messageId: m2, flags: 64 }));
  ok(!matchmaking.getQueuePosition('QB1'), 'stale-cancel: current card tap still cancels the search');
}

// S3. Quick-succession join: A then B join back-to-back. Success -> exactly
// one shared session and an empty queue; DM failure -> both re-queued.
{
  reset();
  onboarded('QC1'); onboarded('QC2');
  const t0 = Date.now() - 60_000;
  await newCmd.execute(cmdIx('new', 'QC1'));
  matchmaking._setJoinedAtForTests('QC1', t0);
  sent.length = 0;
  await newCmd.execute(cmdIx('new', 'QC2'));
  const s1 = db.getActiveSessionForUser('QC1');
  const s2 = db.getActiveSessionForUser('QC2');
  ok(!!s1 && !!s2 && s1.session_id === s2.session_id, 'quick-join: A and B share exactly one session');
  ok(matchmaking.getQueueSize() === 0, 'quick-join: queue drained on success');
  ok(!!greetingMsgId('QC1') && !!greetingMsgId('QC2'), 'quick-join: both greeting cards retained');
}
{
  reset();
  onboarded('QD1'); onboarded('QD2');
  const t0 = Date.now() - 90_000;
  await newCmd.execute(cmdIx('new', 'QD1'));
  matchmaking._setJoinedAtForTests('QD1', t0);
  failDMFor.add('QD1'); // the FIRST joiner's greeting DM fails this time
  sent.length = 0;
  await newCmd.execute(cmdIx('new', 'QD2'));
  failDMFor.clear();
  ok(!db.getActiveSessionForUser('QD1') && !db.getActiveSessionForUser('QD2'),
    'quick-join fizzle: no session, nobody stranded in limbo');
  ok(!matchmaking.getQueuePosition('QD1'),
    'quick-join fizzle: closed-DM side NOT re-queued');
  ok(matchmaking.getQueuePosition('QD2'), 'quick-join fizzle: reachable side re-queued');
  ok(dmPosts('QD2').some((s) => str(s.body).includes('back in the queue')),
    'quick-join fizzle: reachable side got the back-in-queue card');
}

// S4. Sweep fizzle: the 30s sweep pairs two long-waiting adults whose window
// expanded; one greeting DM fails mid-sweep. Both must be re-queued.
{
  reset();
  db.createProfile({ id: 'QE1', name: 'user_QE1', dob: dobForAge(25), interests: [] });
  db.createProfile({ id: 'QE2', name: 'user_QE2', dob: dobForAge(38), interests: [] });
  await newCmd.execute(cmdIx('new', 'QE1'));
  await newCmd.execute(cmdIx('new', 'QE2'));
  ok(matchmaking.getQueueSize() === 2, 'sweep fizzle: wide-gap pair waits (no instant match)');
  const t0 = Date.now() - 300_000; // ~5 min: adult window expanded to 15y
  matchmaking._setJoinedAtForTests('QE1', t0);
  matchmaking._setJoinedAtForTests('QE2', t0);
  failDMFor.add('QE2');
  sent.length = 0;
  const swept = await chat.sweepMatchmaking();
  failDMFor.clear();
  ok(swept === false, 'sweep fizzle: the sweep returns false on the fizzle (post-patch behavior)');
  ok(!db.getActiveSessionForUser('QE1') && !db.getActiveSessionForUser('QE2'),
    'sweep fizzle: no live session after the failed greeting DM');
  ok(matchmaking.getQueuePosition('QE1'),
    'sweep fizzle: reachable side re-queued, none stranded');
  ok(!matchmaking.getQueuePosition('QE2'),
    'sweep fizzle: closed-DM side NOT re-queued');
  ok(matchmaking._getJoinedAtForTests?.('QE1') === t0, 'sweep fizzle: joinedAt preserved');
}


// ===========================================================================
// MERGED PATCH REGRESSION SECTIONS (stress-test cycle 1 fleet).
// Each section below is the verbatim regression section from one patch agent,
// spliced onto this suite's harness (ok, reset, cmdIx, btnIx, modalIx,
// modalUploadIx, lastCb, cbData, dmPosts, dmPatches, reactions, sent,
// failDMFor, db, safety, matchmaking, chat, *Cmd, embeds, routeInteraction,
// dobUtils, matchPair, onboarded, aged, dobForAge, attFixture,
// lastEditOriginal, greetingMsgId, str, plus the __ test controls).
// ===========================================================================

// ---------------------------------------------------------------------------
// Z. /share regression: TOCTOU, per-session cap, accepter/decline cooldowns,
// ack-before-DM. Splice-in section for tests/remake.mjs: uses the harness
// helpers (ok, reset, cmdIx, btnIx, lastCb, cbData, dmPosts, sent, db,
// shareCmd, matchPair, failDMFor, lastEditOriginal, str). No imports.
// ---------------------------------------------------------------------------

// Z1. TOCTOU: two rapid partner /share calls must not crash or double-swap.
reset();
await matchPair('TA', 'TB');
sent.length = 0;
await shareCmd.execute(cmdIx('share', 'TA')); // TA requests; TB gets the card
sent.length = 0;
const z1a = shareCmd.execute(cmdIx('share', 'TB'));
const z1b = shareCmd.execute(cmdIx('share', 'TB'));
const z1r = await Promise.allSettled([z1a, z1b]);
ok(z1r.every((r) => r.status === 'fulfilled'), 'Z1 TOCTOU: rapid mutual /share calls both settle without throwing');
ok(dmPosts('TA').length === 1 && dmPosts('TB').length === 1, 'Z1 TOCTOU: exactly one swap completes (one reveal card each)');
ok(str(lastEditOriginal() || '').includes('already handled'), 'Z1 TOCTOU: loser of the race gets a clean already-handled notice');

// Z2. Swap stamps the 60s cooldown for BOTH participants (accepter included).
reset();
await matchPair('CA', 'CB');
await shareCmd.execute(cmdIx('share', 'CA'));
sent.length = 0;
await shareCmd.handleInteraction(btnIx('share_accept', 'CB', { channelId: 'dm_CB', messageId: 'req1' }));
const csid = db.getActiveSessionForUser('CA').session_id;
ok(db.getShareData(csid, 'CA').last_share > 0 && db.getShareData(csid, 'CB').last_share > 0,
  'Z2 cooldown: both participants carry last_share after a swap');
sent.length = 0;
await shareCmd.execute(cmdIx('share', 'CB'));
ok(str(cbData()).includes('Please wait'), 'Z2 cooldown: accepter cannot immediately re-request');

// Z3. Cap is 2 swaps per SESSION total, not per user.
reset();
await matchPair('DA', 'DB');
await shareCmd.execute(cmdIx('share', 'DA'));
await shareCmd.handleInteraction(btnIx('share_accept', 'DB', { channelId: 'dm_DB', messageId: 'r1' }));
const dsid = db.getActiveSessionForUser('DA').session_id;
for (const u of ['DA', 'DB']) {
  db.db.shares[`${dsid}:${u}`] = db.db.shares[`${dsid}:${u}`] || { count: 0, last_share: 0 };
  db.db.shares[`${dsid}:${u}`].last_share = Date.now() - 61_000;
}
sent.length = 0;
await shareCmd.execute(cmdIx('share', 'DB'));
ok(str(cbData()).includes('Request sent'), 'Z3 cap: second swap request allowed after cooldown');
await shareCmd.handleInteraction(btnIx('share_accept', 'DA', { channelId: 'dm_DA', messageId: 'r2' }));
sent.length = 0;
await shareCmd.execute(cmdIx('share', 'DA'));
ok(str(cbData()).includes('limit of 2 shares'), 'Z3 cap: third swap in one session is rejected');

// Z4. Decline throttles the requester (60s cooldown, no cap consumed).
reset();
await matchPair('EA', 'EB');
const esid = db.getActiveSessionForUser('EA').session_id;
await shareCmd.execute(cmdIx('share', 'EA'));
sent.length = 0;
await shareCmd.handleInteraction(btnIx('share_decline', 'EB', { channelId: 'dm_EB', messageId: 'r1' }));
ok(!db.getActiveSessionForUser('EA').shareRequest, 'Z4 decline: pending request cleared');
ok(db.getShareData(esid, 'EA').count === 0, 'Z4 decline: declined request does not consume the cap');
sent.length = 0;
await shareCmd.execute(cmdIx('share', 'EA'));
ok(str(cbData()).includes('Please wait'), 'Z4 decline: requester hits the 60s cooldown, no spam loop');

// Z5. Requester ack goes out BEFORE the partner DM (3s interaction deadline).
reset();
await matchPair('FA', 'FB');
sent.length = 0;
await shareCmd.execute(cmdIx('share', 'FA'));
{
  const cbIdx = sent.findIndex((s) => s.url.includes('/interactions/'));
  const dmIdx = sent.findIndex((s) => s.url.includes('/channels/dm_FB/messages') && s.method === 'POST');
  ok(cbIdx !== -1 && dmIdx !== -1 && cbIdx < dmIdx, 'Z5 ack-first: requester callback precedes the partner DM');
  ok(str(cbData()).includes('Request sent'), 'Z5 ack-first: requester gets the sent confirmation');
}

// Z6. Partner DM failure: pending cleared, ack updated in place.
reset();
await matchPair('GA', 'GB');
failDMFor.add('GB');
sent.length = 0;
await shareCmd.execute(cmdIx('share', 'GA'));
failDMFor.clear();
ok(!db.getActiveSessionForUser('GA').shareRequest, 'Z6 DM failure: pending request cleared');
ok(str(cbData()).includes('Request sent'), 'Z6 DM failure: requester was acked first');
ok(str(lastEditOriginal() || '').includes("couldn't reach your partner"), 'Z6 DM failure: ack updated via editOriginal');

// ---------------------------------------------------------------------------
// P. Patch regression section: chat.js + database.js (+ new.js) fixes.
// Code only; uses the suite harness bindings (ok, reset, cmdIx, btnIx,
// lastCb, dmPosts, reactions, sent, failDMFor, fail10003For, fail403For,
// failDownloadFor, db, safety, matchmaking, chat, newCmd, onboarded, aged,
// dobForAge, matchPair, __armDeferHang, __releaseDefer, __tick,
// __failCallbackOnce, __writeDbFile, __chatSrc). No imports.
// ---------------------------------------------------------------------------

// ---- Fix 1: no em/en dash in the user-facing rating confirmation ----
{
  reset();
  await matchPair('F1A', 'F1B');
  const s1 = db.getActiveSessionForUser('F1A');
  await chat.concludeSession(s1, 'manual', 'F1A');
  sent.length = 0;
  await chat.handleRate(btnIx(`rate_like:${s1.session_id}`, 'F1A', { channelId: 'dm_F1A' }), 'like');
  const fu1 = sent.find((x) => x.url.includes('/webhooks/') && x.method === 'POST');
  ok(!!fu1, 'F1: rating confirmation followup sent');
  const txt1 = str(fu1?.body);
  ok(!txt1.includes('—') && !txt1.includes('–'), 'F1: no em/en dash in rating confirmation');
  ok(txt1.includes('anonymous. Your partner'), 'F1: dash replaced with a period');
}

// ---- Fix 2 + A: 10003 and 403 self-heal — evict + retry ONCE via fresh createDM ----
{
  reset();
  fail10003For.add('F2A'); // one-shot 404/10003 on the cached DM channel
  const r10003 = await chat.sendDM('F2A', [{ type: 10, content: 'hi' }]);
  const createsA = sent.filter((x) => x.url.endsWith('/users/@me/channels') && x.method === 'POST').length;
  ok(r10003.ok === true, 'F2: 10003 evicts and retries once -> ok:true');
  ok(createsA === 2, 'F2: 10003 retry mints a fresh DM channel (2 createDM calls)');
  ok(!!db.db.dms['F2A'], 'F2: fresh channel cached after 10003 retry');
  sent.length = 0;
  fail403For.set('F2B', 50013); // one-shot 403 Missing Permissions — the never-ported hole
  const r403 = await chat.sendDM('F2B', [{ type: 10, content: 'hi' }]);
  const createsB = sent.filter((x) => x.url.endsWith('/users/@me/channels') && x.method === 'POST').length;
  ok(r403.ok === true, 'A: 403/50013 evicts and retries once -> ok:true');
  ok(createsB === 2, 'A: 403/50013 retry mints a fresh DM channel');
  sent.length = 0;
  fail403For.set('F2D', 50001); // another 403 JSON code: also covered by status===403
  const r403b = await chat.sendDM('F2D', [{ type: 10, content: 'hi' }]);
  ok(r403b.ok === true, 'A: 403/50001 also self-heals via status===403');
  sent.length = 0;
  failDMFor.add('F2C'); // 50007 closed DMs: terminal, never retried
  const r50007 = await chat.sendDM('F2C', [{ type: 10, content: 'hi' }]);
  const createsC = sent.filter((x) => x.url.endsWith('/users/@me/channels') && x.method === 'POST').length;
  ok(r50007.ok === false && r50007.reason === 'dms_closed', 'F2: 50007 stays terminal (dms_closed)');
  ok(createsC === 1, 'F2: 50007 does not retry');
}

// ---- Fix 3 + D: double conclude collapses to one (synchronous in-flight set) ----
{
  reset();
  await matchPair('F3A', 'F3B');
  const s3 = db.getActiveSessionForUser('F3A');
  const sid3 = s3.session_id;
  const n3a = dmPosts('F3A').length, n3b = dmPosts('F3B').length;
  const [c1, c2] = await Promise.all([
    chat.concludeSession(s3, 'manual', 'F3A'),
    chat.concludeSession(s3, 'manual', 'F3B'),
  ]);
  ok(dmPosts('F3A').length - n3a === 2, 'D: exactly 2 conclusion DMs to F3A');
  ok(dmPosts('F3B').length - n3b === 2, 'D: exactly 2 conclusion DMs to F3B');
  ok(db.getLifetimeStats('F3A').chats === 1 && db.getLifetimeStats('F3B').chats === 1,
    'D: lifetime stats counted once per user');
  const rec3 = db.db.ratedSessions[sid3];
  ok(rec3 && Array.isArray(rec3.rated) && rec3.rated.length === 0, 'D: rated guard not resurrected by double conclude');
  ok((c1.duplicate === true) !== (c2.duplicate === true), 'D: exactly one winner, one duplicate');
  // rating after conclusion still works, exactly once
  sent.length = 0;
  await chat.handleRate(btnIx(`rate_like:${sid3}`, 'F3A', { channelId: 'dm_F3A' }), 'like');
  ok(db.db.ratedSessions[sid3].rated.includes('F3A'), 'D: rating after conclusion recorded');
  ok(db.getReputation('F3B').likes === 1, 'D: partner reputation updated');
  await chat.handleRate(btnIx(`rate_like:${sid3}`, 'F3A', { channelId: 'dm_F3A' }), 'like');
  ok(db.db.ratedSessions[sid3].rated.length === 1 && db.getReputation('F3B').likes === 1,
    'D: duplicate rating still rejected');
}

// ---- Fix 4: download-failure notices (all-fail + partial) ----
{
  reset();
  await matchPair('F4A', 'F4B');
  sent.length = 0;
  const dmCh4 = await chat.resolveDMChannel('F4A');
  // all attachments fail, no text -> the sender must be told (was: silence)
  failDownloadFor.add('DLFAIL');
  await chat.handleDirectMessage({
    id: 'm4a', author: { id: 'F4A', bot: false }, channel_id: dmCh4, type: 0, content: '',
    attachments: [{ url: 'https://cdn.discordapp.com/DLFAIL/pic.png', filename: 'pic.png', content_type: 'image/png', size: 100 }],
    flags: 0,
  });
  const toSender4 = dmPosts('F4A');
  const lastToSender4 = toSender4[toSender4.length - 1];
  ok(toSender4.length >= 1 && str(lastToSender4?.body).includes("couldn't be downloaded"),
    'F4: all-fail notifies the sender');
  ok(!str(lastToSender4?.body || '').includes('—'), 'F4: all-fail notice has no em dash');
  ok(dmPosts('F4B').length === 0, 'F4: all-fail relays nothing to the partner');
  ok(reactions('F4A').length >= 1, 'F4: sender message marked not-delivered');
  failDownloadFor.clear();
  // partial: text + one good file + one failed file -> relay + honest notice
  sent.length = 0;
  failDownloadFor.add('DLFAIL');
  await chat.handleDirectMessage({
    id: 'm4b', author: { id: 'F4A', bot: false }, channel_id: dmCh4, type: 0, content: 'hey',
    attachments: [
      { url: 'https://cdn.discordapp.com/ok/pic.png', filename: 'pic.png', content_type: 'image/png', size: 100 },
      { url: 'https://cdn.discordapp.com/DLFAIL/pic2.png', filename: 'pic2.png', content_type: 'image/png', size: 100 },
    ],
    flags: 0,
  });
  const toPartner4b = dmPosts('F4B');
  ok(toPartner4b.length >= 1 && str(toPartner4b[0].body).includes('hey'), 'F4: partial still relays what downloaded');
  const notice4 = dmPosts('F4A').find((x) => str(x.body).includes("wasn't passed along"));
  ok(!!notice4, 'F4: partial delivery tells the sender about the missing file');
  ok(!str(notice4?.body || '').includes('—'), 'F4: partial notice has no em dash');
  failDownloadFor.clear();
}

// ---- Fix 5: download timeout ----
{
  ok(__chatSrc.includes('AbortSignal.timeout(15000)'), 'F5: downloadAttachment uses AbortSignal.timeout(15000)');
}

// ---- Fix 6: load() per-key type validation ----
{
  reset();
  // wrong-typed keys fall back to defaults WITHOUT nuking well-typed siblings
  __writeDbFile(JSON.stringify({ profiles: 'oops', reports: [{ id: 'r1' }], shares: 42, reputation: [1, 2] }));
  db.load();
  ok(db.db.profiles && typeof db.db.profiles === 'object' && !Array.isArray(db.db.profiles),
    'F6: wrong-typed profiles falls back to {}');
  ok(Array.isArray(db.db.reports) && db.db.reports.length === 1,
    'F6: well-typed sibling keys survive a bad neighbor');
  ok(db.db.shares && typeof db.db.shares === 'object' && !Array.isArray(db.db.shares),
    'F6: wrong-typed shares falls back to {}');
  ok(db.db.reputation && typeof db.db.reputation === 'object' && !Array.isArray(db.db.reputation),
    'F6: wrong-typed reputation falls back to {}');
  // well-typed values still load untouched
  reset();
  __writeDbFile(JSON.stringify({ profiles: { UX: { id: 'UX', is_onboarded: true } }, reports: [{ id: 'r1' }] }));
  db.load();
  ok(db.db.profiles.UX && db.db.profiles.UX.id === 'UX', 'F6: well-typed values still load');
  ok(db.db.reports.length === 1, 'F6: well-typed reports still load');
}

// ---- Fix 7: unbounded shares / reports caps ----
{
  reset();
  for (let i = 0; i < 520; i++) db.recordUsernameShare('sess' + i, 'u' + i);
  const shareKeys = Object.keys(db.db.shares);
  ok(shareKeys.length === 500, 'F7: shares capped at 500');
  ok(!db.db.shares['sess0:u0'] && !!db.db.shares['sess519:u519'], 'F7: oldest shares evicted first');
  for (let i = 0; i < 220; i++) {
    db.addReport({ id: 'rp' + i, at: new Date(Date.now() - (220 - i) * 1000).toISOString() });
  }
  ok(db.db.reports.length === 200, 'F7: reports capped at 200');
  ok(!db.db.reports.some((r) => r.id === 'rp0') && db.db.reports.some((r) => r.id === 'rp219'),
    'F7: oldest reports evicted first');
}

// ---- Fix B: fizzle circuit breaker ----
{
  reset();
  onboarded('CB1A'); onboarded('CB1B');
  failDMFor.add('CB1B'); // CB1B unreachable (closed DMs) -> every pairing fizzles
  await newCmd.execute(cmdIx('new', 'CB1A')); sent.length = 0;
  await newCmd.execute(cmdIx('new', 'CB1B')); // match -> fizzle #1
  const fzCard = (uid) => dmPosts(uid).filter((x) => str(x.body).includes('back in the queue'));
  ok(fzCard('CB1A').length === 1, 'B: first consecutive fizzle sends the card');
  ok(!matchmaking.getQueuePosition('CB1B'),
    'B: closed-DM side is not auto re-queued (no tight fizzle loop)');
  sent.length = 0;
  // CB1B keeps pressing /new: each retry re-fizzles the pair, and the breaker
  // still counts consecutive fizzles per pair.
  const fp = async () => {
    matchmaking.addToQueue('CB1B', db.getAnonId('CB1B')); // user-initiated retry
    const m = matchmaking.tryMatchWaiters();
    ok(!!m, 'B: pair re-formed on retry');
    await chat.startChatSession(m.user1.user_id, m.user2.user_id, m.user1.anonymous_id, m.user2.anonymous_id, m.entries);
  };
  await fp(); // fizzle #2
  ok(fzCard('CB1A').length === 0, 'B: second consecutive fizzle is silent');
  sent.length = 0;
  await fp(); // fizzle #3 -> 5-minute pairing cooldown
  ok(fzCard('CB1A').length === 0, 'B: third fizzle is silent');
  ok(chat.fizzlePairBlocked('CB1A', 'CB1B'), 'B: pair blocked after 3 consecutive fizzles');
  matchmaking.addToQueue('CB1B', db.getAnonId('CB1B')); // CB1B retries during the cooldown
  const sweptB = await chat.sweepMatchmaking();
  ok(sweptB === false, 'B: sweep skips the cooling-down pair');
  ok(matchmaking.getQueuePosition('CB1A') && matchmaking.getQueuePosition('CB1B'),
    'B: cooling-down pair restored to the queue (never stranded)');
  ok(!db.getActiveSessionForUser('CB1A'), 'B: no session formed during cooldown');
  failDMFor.clear();
}

// ---- Fix B (cont.): a successful session resets the counter ----
{
  reset();
  onboarded('CB2A'); onboarded('CB2B'); onboarded('CB2C');
  failDMFor.add('CB2B');
  await newCmd.execute(cmdIx('new', 'CB2A')); sent.length = 0;
  // Strict earliest-waiter: same-millisecond joinedAt ties are broken by
  // queue order, which would make the CB2C pairing nondeterministic.
  matchmaking._setJoinedAtForTests('CB2A', Date.now() - 5000);
  await newCmd.execute(cmdIx('new', 'CB2B')); // fizzle #1 -> card
  sent.length = 0;
  matchmaking.addToQueue('CB2B', db.getAnonId('CB2B')); // CB2B retries /new
  const m2 = matchmaking.tryMatchWaiters();
  ok(!!m2, 'B: pair re-formed on retry');
  await chat.startChatSession(m2.user1.user_id, m2.user2.user_id, m2.user1.anonymous_id, m2.user2.anonymous_id, m2.entries); // fizzle #2 -> silent
  ok(dmPosts('CB2A').filter((x) => str(x.body).includes('back in the queue')).length === 0,
    'B: second fizzle silent before reset');
  // CB2A has a successful chat with CB2C -> resets the (CB2A,CB2B) counter
  failDMFor.clear();
  sent.length = 0;
  await newCmd.execute(cmdIx('new', 'CB2C')); // pairs CB2A+CB2C (longest waiter)
  ok(!!db.getActiveSessionForUser('CB2A'), 'B: CB2A in a live session (success resets)');
  await chat.concludeSession(db.getActiveSessionForUser('CB2A'), 'manual', 'CB2A');
  failDMFor.add('CB2B');
  matchmaking.addToQueue('CB2A', db.getAnonId('CB2A'));
  matchmaking.addToQueue('CB2B', db.getAnonId('CB2B')); // CB2B retries /new again
  sent.length = 0;
  const m3 = matchmaking.tryMatchWaiters();
  ok(!!m3, 'B: pair re-formed after reset');
  await chat.startChatSession(m3.user1.user_id, m3.user2.user_id, m3.user1.anonymous_id, m3.user2.anonymous_id, m3.entries);
  ok(dmPosts('CB2A').filter((x) => str(x.body).includes('back in the queue')).length === 1,
    'B: successful session resets the counter -> card sent again');
  failDMFor.clear();
}

// ---- Fix B (cont.): the /new button path honors the cooldown ----
{
  reset();
  onboarded('CB3A'); onboarded('CB3B');
  failDMFor.add('CB3B');
  await newCmd.execute(cmdIx('new', 'CB3A')); sent.length = 0;
  await newCmd.execute(cmdIx('new', 'CB3B')); // fizzle #1
  for (let i = 0; i < 2; i++) {
    matchmaking.addToQueue('CB3B', db.getAnonId('CB3B')); // CB3B retries /new
    const m = matchmaking.tryMatchWaiters();
    ok(!!m, 'B: pair re-formed on retry');
    await chat.startChatSession(m.user1.user_id, m.user2.user_id, m.user1.anonymous_id, m.user2.anonymous_id, m.entries);
  } // fizzles #2, #3 -> cooldown
  failDMFor.clear();
  sent.length = 0;
  // CB3B retries once more while the pair is cooling down; CB3A presses
  // "find someone new" -> the cooldown is honored, no session forms.
  matchmaking.addToQueue('CB3B', db.getAnonId('CB3B'));
  matchmaking.removeFromQueue('CB3A'); // CB3A presses "find someone new" while CB3B waits
  await chat.handleChatFindNew(btnIx('chat_find_new', 'CB3A', { channelId: 'dm_CB3A', messageId: 'm9' }));
  ok(!db.getActiveSessionForUser('CB3A'), 'B: /new button does not pair the cooling-down duo');
  ok(matchmaking.getQueuePosition('CB3A') && matchmaking.getQueuePosition('CB3B'),
    'B: /new button leaves both queued');
}

// ---- Fix C: catch-path fizzle card (throw past session creation) ----
{
  reset();
  onboarded('CC1A'); onboarded('CC1B');
  matchmaking.addToQueue('CC1A', db.getAnonId('CC1A'));
  matchmaking.addToQueue('CC1B', db.getAnonId('CC1B'));
  sent.length = 0;
  const origGetRep = db.getReputation;
  db.getReputation = () => { throw new Error('boom'); }; // greeting-card build throws
  let sessC;
  try {
    const m = matchmaking.tryMatchWaiters();
    sessC = await chat.startChatSession(m.user1.user_id, m.user2.user_id, m.user1.anonymous_id, m.user2.anonymous_id, m.entries);
  } finally {
    db.getReputation = origGetRep;
  }
  ok(sessC === null, 'C: startChatSession returns null on the throw path (fizzle, not a match)');
  const cCard = (uid) => dmPosts(uid).filter((x) => str(x.body).includes('back in the queue'));
  ok(cCard('CC1A').length === 1 && cCard('CC1B').length === 1,
    'C: both sides get the fizzle card on the throw path');
  ok(matchmaking.getQueuePosition('CC1A') && matchmaking.getQueuePosition('CC1B'), 'C: both re-queued');
  ok(!db.getActiveSessionForUser('CC1A'), 'C: no half-born session left');
}

// ---- Fix E: removeBlock rejects empty-after-normalization selectors ----
{
  reset();
  db.blockUser('CE1A', 'CE1B');
  db.blockUser('CE1A', 'CE1C');
  ok(db.removeBlock('CE1A', '...') === false, 'E: dots-only selector rejected');
  ok(db.removeBlock('CE1A', '   ') === false, 'E: whitespace selector rejected');
  ok(db.removeBlock('CE1A', '') === false, 'E: empty selector rejected');
  ok(db.getBlockedUsers('CE1A').length === 2, 'E: no block removed by empty selectors');
  ok(db.removeBlock('CE1A', db.getAnonId('CE1B').slice(0, 8)) === true, 'E: valid 8-char code still unblocks');
  ok(db.getBlockedUsers('CE1A').length === 1, 'E: exactly the selected block removed');
}

// ---- Fix F: relay rate-limit maps pruned on the periodic path ----
{
  const hasHooks = typeof chat._seedRelayStateForTests === 'function'
    && typeof chat._pruneRelayStateForTests === 'function'
    && typeof chat._relayStateSizeForTests === 'function';
  ok(hasHooks, 'F: prune test hooks exist');
  if (hasHooks) {
    reset();
    const dayMs = 24 * 3600 * 1000;
    chat._seedRelayStateForTests('CF1A', Date.now() - dayMs - 1000);
    chat._seedRelayStateForTests('CF1B', Date.now());
    await chat.sweepIdleSessions(); // the periodic path runs the prune
    ok(chat._relayStateSizeForTests() === 3, 'F: entries idle 24h+ pruned, fresh kept');
  }
}

// ---- Fix G: handleRate acks (deferUpdate) before recording the rating ----
{
  ok(__chatSrc.includes('await deferUpdate(ix);\n  const sessionId = String(ix.data?.custom_id'),
    'G: deferUpdate runs before ratePartner in handleRate');
  reset();
  await matchPair('CG1A', 'CG1B');
  const sG = db.getActiveSessionForUser('CG1A');
  await chat.concludeSession(sG, 'manual', 'CG1A');
  sent.length = 0;
  await chat.handleRate(btnIx(`rate_like:${sG.session_id}`, 'CG1A', { channelId: 'dm_CG1A' }), 'like');
  const cbG = sent.find((x) => x.url.includes('/interactions/') && x.body?.type === 6);
  const fuG = sent.find((x) => x.url.includes('/webhooks/') && x.method === 'POST');
  ok(!!cbG && !!fuG, 'G: rating flow defers first, then follows up');
  ok(str(fuG?.body).includes('recorded'), 'G: confirmation delivered');
  sent.length = 0;
  await chat.handleRate(btnIx('rate_like:nope', 'CG1A', { channelId: 'dm_CG1A' }), 'like');
  const fuG2 = sent.find((x) => x.url.includes('/webhooks/') && x.method === 'POST');
  ok(!!fuG2 && str(fuG2.body).includes('too old to rate'), 'G: failure path uses followup after defer');
}

// ---- Micro-fix: handleChatReport encodes the partner target in the modal ----
{
  reset();
  await matchPair('CR1A', 'CR1B');
  const sR = db.getActiveSessionForUser('CR1A');
  const gidR = sR.greeting['CR1A'].messageId;
  sent.length = 0;
  await chat.handleChatReport(btnIx('chat_report', 'CR1A', { channelId: 'dm_CR1A', messageId: gidR }));
  const modalCb = [...sent].reverse().find((x) => x.body?.type === 9);
  ok(!!modalCb && modalCb.body.data.custom_id === 'report_modal:CR1B',
    'report modal custom_id encodes the partner target');
}

// ---- Q1: cancel-then-match race — re-validate after the await ----
{
  reset();
  onboarded('CQ1A'); onboarded('CQ1B');
  await newCmd.execute(cmdIx('new', 'CQ1A')); sent.length = 0;
  const mQ1 = matchmaking.getSearchingCardId('CQ1A');
  __armDeferHang();
  const pc = chat.handleQueueCancel(btnIx('queue_cancel', 'CQ1A', { channelId: 'dm_CQ1A', messageId: mQ1 }));
  await __tick();
  ok(matchmaking.getQueuePosition('CQ1A') === 1, 'Q1: cancel in flight, still queued');
  await newCmd.execute(cmdIx('new', 'CQ1B')); // a live match forms in the window
  ok(!!db.getActiveSessionForUser('CQ1A'), 'Q1: match formed mid-cancel -> live session');
  __releaseDefer();
  await pc;
  const cancelledEdits = sent.filter((x) => x.method === 'PATCH'
    && x.url.includes(`/channels/dm_CQ1A/messages/${mQ1}`)
    && str(x.body).includes('Search cancelled'));
  ok(cancelledEdits.length === 0, 'Q1: cancel does not overwrite the card after a match formed');
  ok(!!db.getActiveSessionForUser('CQ1A'), 'Q1: live session untouched by the late cancel');
}

// ---- Q1b: fizzle completes inside the cancel window ----
{
  reset();
  onboarded('CQ2A'); onboarded('CQ2B');
  await newCmd.execute(cmdIx('new', 'CQ2A')); sent.length = 0;
  const mQ2 = matchmaking.getSearchingCardId('CQ2A');
  __armDeferHang();
  const pc2 = chat.handleQueueCancel(btnIx('queue_cancel', 'CQ2A', { channelId: 'dm_CQ2A', messageId: mQ2 }));
  await __tick();
  failDMFor.add('CQ2B'); // partner unreachable -> fizzle completes in-window
  await newCmd.execute(cmdIx('new', 'CQ2B'));
  failDMFor.clear();
  __releaseDefer();
  await pc2;
  ok(matchmaking.getQueuePosition('CQ2A') === null, 'Q1: after fizzle+cancel, user is NOT re-queued');
  const cancelled2 = [...sent].reverse().find((x) => x.method === 'PATCH'
    && x.url.includes(`/channels/dm_CQ2A/messages/${mQ2}`));
  ok(!!cancelled2 && str(cancelled2.body).includes('Search cancelled'),
    'Q1: card honestly shows cancelled');
}

// ---- Q2: banned-while-queued users must not be matched ----
{
  reset();
  aged('CQ3A', 25); aged('CQ3B', 33);
  await newCmd.execute(cmdIx('new', 'CQ3A'));
  await newCmd.execute(cmdIx('new', 'CQ3B')); // gap 8 > initial cap 5 -> both wait
  ok(matchmaking.getQueueSize() === 2, 'Q2: both waiting');
  db.banUser('CQ3A', 'test ban');
  const pastQ = Date.now() - 3 * 60_000; // age-gap expansion would now pair them
  matchmaking._setJoinedAtForTests('CQ3A', pastQ);
  matchmaking._setJoinedAtForTests('CQ3B', pastQ);
  const sweptQ = await chat.sweepMatchmaking();
  ok(sweptQ === false, 'Q2: sweep does not pair a banned user');
  ok(!db.getActiveSessionForUser('CQ3A') && !db.getActiveSessionForUser('CQ3B'), 'Q2: no live session formed');
  ok(!!matchmaking.getQueuePosition('CQ3B'), 'Q2: allowed user keeps their place');
  ok(!matchmaking.getQueuePosition('CQ3A'), 'Q2: banned user not re-queued');
  // fizzle path: banned users must not be re-queued either
  reset();
  aged('CQ3C', 25); aged('CQ3D', 26);
  db.banUser('CQ3C', 'test ban');
  matchmaking.addToQueue('CQ3C', db.getAnonId('CQ3C'));
  matchmaking.addToQueue('CQ3D', db.getAnonId('CQ3D'));
  failDMFor.add('CQ3D'); // force fizzle; CQ3C reachable
  const mq = matchmaking.findMatch('CQ3D');
  await chat.startChatSession(mq.user1.user_id, mq.user2.user_id, mq.user1.anonymous_id, mq.user2.anonymous_id, mq.entries);
  failDMFor.clear();
  ok(!matchmaking.getQueuePosition('CQ3C'), 'Q2: banned user not re-queued after fizzle');
  ok(!!matchmaking.getQueuePosition('CQ3D'), 'Q2: allowed user re-queued after fizzle');
}

// ---- Q3: /new callback failure rolls back the queue ----
{
  reset();
  onboarded('CQ4A');
  __failCallbackOnce();
  let threwQ = false;
  try { await newCmd.execute(cmdIx('new', 'CQ4A')); } catch { threwQ = true; }
  ok(threwQ === false, 'Q3: /new swallows the dead callback after rolling back');
  ok(!matchmaking.getQueuePosition('CQ4A'), 'Q3: queue rolled back after callback failure');
  sent.length = 0;
  await newCmd.execute(cmdIx('new', 'CQ4A'));
  ok(matchmaking.getQueuePosition('CQ4A') === 1, 'Q3: retry queues cleanly');
  ok(!str(lastCb()).includes('Already Searching'), 'Q3: retry gets a fresh searching card');
}

// ---------------------------------------------------------------------------
// UX patch regression (patch-fleet section; run via runner, no own imports)
// ---------------------------------------------------------------------------

reset();
{
  // --- fix 1: no em dashes in user-facing copy ---
  const dashFree = (v, name) => ok(!String(v).includes('—'), `ux1 no em dash: ${name}`);
  dashFree(JSON.stringify(embeds.matchedCard(null)), 'matchedCard unrated');
  dashFree(JSON.stringify(embeds.statusReconnectCard('ender', 's1')), 'statusReconnectCard');
  const hlProfile = { name: 'X', dob: '2000-01-01', location: 'Dhaka', bio: 'hello world', interests: [] };
  const headline = embeds.profileHeadline(hlProfile);
  dashFree(headline, 'profileHeadline');
  ok(headline.includes(' · hello world'), 'ux1 profileHeadline bio uses the middle dot');
  dashFree(JSON.stringify(embeds.personalStatsCard(db.constructor.blankLifetime())), 'personalStatsCard unrated');

  // --- fix 2: formatChatDuration is floor-based ---
  ok(embeds.formatChatDuration(90000) === '1m', 'ux2 formatChatDuration: 90s -> 1m');
  ok(embeds.formatChatDuration(119000) === '1m', 'ux2 formatChatDuration: 119s -> 1m');
  ok(embeds.formatChatDuration(60000) === '1m', 'ux2 formatChatDuration: 60s -> 1m');
  ok(embeds.formatChatDuration(30000) === 'under a minute', 'ux2 formatChatDuration: 30s stays sub-minute');
  ok(embeds.formatChatDuration(3600000 + 5 * 60000) === '1h 5m', 'ux2 formatChatDuration: 1h5m');

  // --- fix 3: /stats is an ephemeral V2 card ---
  onboarded('st1');
  sent.length = 0;
  await statsCmd.execute(cmdIx('stats', 'st1'));
  const statsCb = lastCb();
  ok(statsCb?.type === 4 && statsCb?.data?.flags === 32832, 'ux3 /stats reply is ephemeral V2');

  // --- fix 4: /report falls back to the recent-partners ring when idle ---
  onboarded('r1'); onboarded('r2');
  await newCmd.execute(cmdIx('new', 'r1')); sent.length = 0;
  await newCmd.execute(cmdIx('new', 'r2')); sent.length = 0;
  const rSess = db.getActiveSessionForUser('r1');
  ok(!!rSess, 'ux4 report fallback: session started');
  await chat.concludeSession(rSess, 'manual', 'r1');
  sent.length = 0;
  ok(!db.getActiveSessionForUser('r1'), 'ux4 report fallback: session ended');
  ok(db.getRecentPartners('r1')[0] === 'r2', 'ux4 report fallback: ring holds the real partner id');
  await reportCmd.execute(cmdIx('report', 'r1'));
  const rOpen = lastCb();
  ok(rOpen?.type === 9 && rOpen?.data?.custom_id === 'report_modal:r2',
    'ux4 report fallback: idle /report opens a modal targeting the last partner');

  // --- fix 4b: /report with no session and no ring says so (no modal) ---
  sent.length = 0;
  onboarded('r0');
  await reportCmd.execute(cmdIx('report', 'r0'));
  const rNone = lastCb();
  ok(rNone?.type === 4 && rNone?.data?.custom_id === undefined &&
    /No Active Chat|No One to Report/.test(rNone?.data?.embeds?.[0]?.title || ''),
    'ux4 report fallback: no session and no ring answers with an info embed, not a modal');

  // --- fix 5: session ending mid-modal does not discard the report ---
  onboarded('m1'); onboarded('m2');
  await newCmd.execute(cmdIx('new', 'm1')); sent.length = 0;
  await newCmd.execute(cmdIx('new', 'm2')); sent.length = 0;
  const mSess = db.getActiveSessionForUser('m1');
  ok(!!mSess, 'ux5 mid-modal: session started');
  const mPartner = mSess.user1_id === 'm1' ? mSess.user2_id : mSess.user1_id;
  await chat.concludeSession(mSess, 'manual', 'm1');
  sent.length = 0;
  // The modal was opened against the encoded partner before the chat ended.
  await reportCmd.handleInteraction(modalIx(`report_modal:${mPartner}`, 'm1',
    [['report_reason', 'spam'], ['report_description', 'sent links']]));
  const filed = lastCb();
  ok(filed?.type === 4 && /Report Filed/.test(filed?.data?.embeds?.[0]?.title || ''),
    'ux5 mid-modal: report is still filed after the session ends');
  ok(db.db.reports.some((r) => r.reporterId === 'm1' && r.targetId === String(mPartner)),
    'ux5 mid-modal: report record targets the encoded partner');

  // --- fix 6: stale profile edit button answers instead of going silent ---
  sent.length = 0;
  await profileCmd.handleInteraction(btnIx('profile_edit_name', 'ghost'));
  const ghostCb = lastCb();
  ok(!!ghostCb && ghostCb.type === 4, 'ux6 stale edit: an ephemeral notice is sent');
  ok(ghostCb?.data?.flags === 32832, 'ux6 stale edit: the notice is an ephemeral V2 card');

  // --- fix 7: /new no longer points at the ghost /onboard command ---
  sent.length = 0;
  await newCmd.execute(cmdIx('new', 'nosuchuser'));
  const gateDesc = lastCb()?.data?.embeds?.[0]?.description || '';
  ok(!gateDesc.includes('/onboard'), 'ux7 /new copy no longer mentions the ghost /onboard command');
  ok(/profile/i.test(gateDesc), 'ux7 /new copy still guides toward profile setup');

  // --- fix H: /new points in-session users at /end, not /leave ---
  onboarded('h1'); onboarded('h2');
  await newCmd.execute(cmdIx('new', 'h1')); sent.length = 0;
  await newCmd.execute(cmdIx('new', 'h2')); sent.length = 0;
  ok(!!db.getActiveSessionForUser('h1'), 'uxH: chat active for the dead-end check');
  sent.length = 0;
  await newCmd.execute(cmdIx('new', 'h1'));
  const busyDesc = lastCb()?.data?.embeds?.[0]?.description || '';
  ok(busyDesc.includes('`/end`'), 'uxH: in-chat /new copy says /end');
  ok(!busyDesc.includes('`/leave`'), 'uxH: in-chat /new copy no longer says /leave');

  // --- fix I: pager buttons carry clamped page ids at the bounds ---
  const mkEntries = (n) => Array.from({ length: n }, (_, i) => ({
    anonId: `code${String(i).padStart(4, '0')}ab`,
    at: new Date(Date.now() - i * 60000).toISOString(),
    source: i % 2 ? 'recent' : 'chat',
  }));
  const pagerBtns = (components) => {
    const out = [];
    for (const c of components?.[0]?.components || []) {
      if (c.type === 1) for (const b of c.components || []) if (b.type === 2 && /^blocklist:page:/.test(b.custom_id)) out.push(b);
    }
    return out;
  };
  {
    const first = pagerBtns(embeds.blocklistCard(mkEntries(20), { page: 1 }));
    const prev = first.find((b) => b.custom_id.startsWith('blocklist:page:') && /Previous/.test(b.label));
    ok(prev?.custom_id === 'blocklist:page:1' && prev?.disabled === true,
      'uxI: first-page Previous renders a clamped, disabled id (blocklist:page:1)');
  }
  {
    const last = pagerBtns(embeds.blocklistCard(mkEntries(20), { page: 3 }));
    const next = last.find((b) => /Next/.test(b.label));
    ok(next?.custom_id === 'blocklist:page:3' && next?.disabled === true,
      'uxI: last-page Next renders a clamped, disabled id (blocklist:page:3)');
  }
  {
    const mid = pagerBtns(embeds.blocklistCard(mkEntries(20), { page: 2 }));
    const prev = mid.find((b) => /Previous/.test(b.label));
    const next = mid.find((b) => /Next/.test(b.label));
    ok(prev?.custom_id === 'blocklist:page:1' && next?.custom_id === 'blocklist:page:3',
      'uxI: middle page renders live neighbor ids');
  }
}

// ---------------------------------------------------------------------------
// PATCH-FUZZBLEED: profanity-engine regressions (adult fuzzy bleed, J leet
// v->u/(->c, K minor compound masking). Folded into the suite's pass/fail
// counters; every assertion kept verbatim.
// ---------------------------------------------------------------------------
{
  const { default: assert } = await import('node:assert');
  const EXP = '/home/hatch/workspace/anon-chat-remake-experimental';
  const cur = await import(`${EXP}/src/services/profanity.js`);
  const leg = await import(`${EXP}/src/services/profanity.legacy.js`);
  const tiers = await import(`${EXP}/src/services/profanity-tiers.js`);
  const { SENSITIVE_WORDS } = await import(`${EXP}/src/services/wordlist.js`);

  const { filterText, maskSpan } = cur;
  const { HARD_TIER, MIXED_SENSITIVE, MILD_SOFT } = tiers;
  const minor = (s) => filterText(s);
  const adult = (s) => filterText(s, { adultChat: true });

// ---------------------------------------------------------------- counts
ok(HARD_TIER.length === 603, `HARD_TIER is 603 (got ${HARD_TIER.length})`);
ok(SENSITIVE_WORDS.length === 116, `SENSITIVE_WORDS is 116 (got ${SENSITIVE_WORDS.length})`);
ok(MIXED_SENSITIVE.size === 16, `MIXED_SENSITIVE is 16 (got ${MIXED_SENSITIVE.size})`);
ok(SENSITIVE_WORDS.filter((w) => !MIXED_SENSITIVE.has(w)).length === 100,
  'non-mixed sensitive words are 100');
ok(MILD_SOFT.length === 31, `MILD_SOFT is 31 (got ${MILD_SOFT.length})`);

// ------------------------------------------------- 1. fuzzy-bleed fix
// Reported inputs: clean + byte-identical in adult, flag+mask in minor.
for (const input of ['f*ck', 'F*ck', 'f_ck', 'f.ck', 'f-ck', 'ph*ck']) {
  const a = adult(input), m = minor(input);
  ok(!a.flagged && a.text === input && a.hits === 0,
    `bleed: adult passes untouched: ${input}`);
  ok(m.flagged && m.text !== input,
    `bleed: minor still flags: ${input} -> ${m.text}`);
}
// Mixed-entry evasions keep their adult flag: the sensitive-wins rule must
// never steal a mixed entry ("f*ckbitch" ~ "fuckbitch").
{
  const r = adult('f*ckbitch');
  ok(r.flagged, `bleed: adult mixed evasion still flags: f*ckbitch -> ${r.text}`);
}
// ------------------------------------------------- 2. J: v->u / (->c
const J_SIX = ['fvck', 'cvnt', 'pvssy', 'fuvk', '(ock', '(unt'];
for (const w of J_SIX) {
  ok(leg.filterText(w).flagged, `J: legacy flags ${w} (parity baseline)`);
  ok(minor(w).flagged, `J: minor flags ${w} -> ${minor(w).text}`);
}
// Tier-correct adult behavior: hard folds flag, sensitive folds pass.
for (const w of ['cvnt', 'pvssy', '(ock', '(unt']) {
  ok(adult(w).flagged, `J: adult flags hard fold ${w}`);
}
for (const w of ['fvck', 'fuvk']) {
  const r = adult(w);
  ok(!r.flagged && r.text === w, `J: adult passes sensitive fold untouched: ${w}`);
}
// Innocents stay clean (legacy agrees).
for (const w of ['gave', 'gives', '(ok', 'gave it to charity', 'gave blood today']) {
  ok(!leg.filterText(w).flagged, `J: legacy clean on ${JSON.stringify(w)}`);
  const m = minor(w), a = adult(w);
  ok(!m.flagged && m.text === w, `J: minor clean on ${JSON.stringify(w)}`);
  ok(!a.flagged && a.text === w, `J: adult clean on ${JSON.stringify(w)}`);
}
// ------------------------------------------------- 3. K: compound mask
ok(minor('fuckbitch').flagged && minor('fuckbitch').text === 'f∗∗kbi∗ch',
  `K: minor fuckbitch -> f∗∗kbi∗ch (got ${minor('fuckbitch').text})`);
ok(adult('fuckbitch').flagged && adult('fuckbitch').text === 'fuckbi∗ch',
  `K: adult fuckbitch unchanged -> fuckbi∗ch (got ${adult('fuckbitch').text})`);

// --------------------------------------- no-regression: 603 hard words
for (const w of HARD_TIER) {
  const m = minor(w), a = adult(w);
  ok(m.flagged && m.text !== w, `hard/minor flags+mask: ${w}`);
  ok(a.flagged && a.text !== w, `hard/adult flags+mask: ${w}`);
}
// --------------------------------------- no-regression: leet hard (adult)
for (const w of ['b1tch', 'd*ck', 'c*nt']) {
  ok(adult(w).flagged, `leet hard still flags in adult: ${w} -> ${adult(w).text}`);
}
// --------------------------------------- no-regression: 116 sensitive
for (const w of SENSITIVE_WORDS) {
  const m = minor(w);
  ok(m.flagged && m.text !== w, `sensitive/minor flags+mask: ${w}`);
}
for (const w of SENSITIVE_WORDS.filter((x) => !MIXED_SENSITIVE.has(x))) {
  const a = adult(w);
  ok(!a.flagged && a.text === w, `sensitive/adult byte-identical: ${w}`);
}
// --------------------------------------- no-regression: 16 mixed (adult)
// 15 mask only the hard component; tittyfucker full-masks (pre-existing).
for (const w of [...MIXED_SENSITIVE].sort()) {
  const a = adult(w);
  ok(a.flagged, `mixed/adult flags: ${w}`);
  if (w === 'tittyfucker') {
    ok(a.text === maskSpan(w), `mixed/adult tittyfucker full-mask (pre-existing): ${a.text}`);
  } else {
    ok(a.text !== maskSpan(w), `mixed/adult component mask (not full): ${w} -> ${a.text}`);
  }
}
// --------------------------------------- no-regression: mild untouched
for (const w of MILD_SOFT) {
  for (const [tier, r] of [['minor', minor(w)], ['adult', adult(w)]]) {
    ok(!r.flagged && r.text === w && r.hits === 0, `mild/${tier} untouched: ${w}`);
  }
}
// --------------------------------------- no-regression: 10 legacy deltas
// F1 differential @ minor vs the legacy benchmark: exactly the 10
// documented tiering deltas, no more, no fewer.
const testSrc = readFileSync(`${EXP}/tests/profanity-engine.mjs`, 'utf8');
function extractSetLiteral(name) {
  const m = testSrc.match(new RegExp(`const ${name} = (new Set\\()?\\[([\\s\\S]*?)\\]\\)?;`));
  assert(m, `could not extract ${name}`);
  return eval(`[${m[2]}]`);
}
const CORPUS = extractSetLiteral('CORPUS');
const EXPECTED = new Set(extractSetLiteral('EXPECTED_LEGACY_DIFFS'));
const actual = new Set();
for (const input of CORPUS) {
  const a = minor(input), b = leg.filterText(input);
  if (a.flagged !== b.flagged || (a.flagged && a.text !== b.text)) actual.add(input);
}
const missing = [...EXPECTED].filter((x) => !actual.has(x));
const extra = [...actual].filter((x) => !EXPECTED.has(x));
ok(missing.length === 0, `deltas: none missing: ${JSON.stringify(missing)}`);
ok(extra.length === 0, `deltas: none unexpected: ${JSON.stringify(extra)}`);
ok(actual.size === 10, `deltas: exactly 10 (got ${actual.size})`);
}

// ---------------------------------------------------------------------------
// PATCH-INFRA preamble: gateway/router regression dependencies.
// ---------------------------------------------------------------------------
const readSource = (rel) => readFileSync('./' + rel, 'utf8');
const { Gateway } = await import('../src/discord/gateway.js');
const { parseModalSubmit } = await import('../src/discord/interactions.js');
const { startMockGatewayServer } = await import('./ws-mock.mjs');
const startMockGateway = startMockGatewayServer;
const _net = await import('node:net');
// TCP server that accepts connections and never answers: hangs the CONNECT
// phase for the gateway connect-timeout test. close() destroys server-side
// sockets first so it never waits on a wedged client.
const startHangServer = () => new Promise((resolve) => {
  let conns = 0;
  const socks = new Set();
  const s = _net.createServer((sock) => {
    conns++; socks.add(sock);
    sock.on('error', () => {});
    sock.on('close', () => socks.delete(sock));
  });
  s.listen(0, '127.0.0.1', () => resolve({
    port: s.address().port,
    connections: () => conns,
    close: () => new Promise((r) => { for (const x of socks) x.destroy(); s.close(r); }),
  }));
});
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e?.message || String(e)));
// The VM's egress proxy env would route even 127.0.0.1 gateway URLs through
// the proxy shim (proxyForUrl reads scheme vars, no no_proxy support; undici
// WS falls back to ALL_PROXY). Scrub for the gateway tests, restore after.
const __savedProxyEnv = {};
for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']) {
  __savedProxyEnv[k] = process.env[k];
  delete process.env[k];
}
process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.no_proxy = '127.0.0.1,localhost';

// ---------------------------------------------------------------------------
// PATCH-INFRA regression: unknown custom_id acks, 4004 fatal code, crash flush
//
// This section is executed inside the test-harness scope and must NOT have
// imports of its own. It uses harness helpers: ok, reset, onboarded, btnIx,
// modalIx, sent, lastCb, str, routeInteraction, readSource.
// ---------------------------------------------------------------------------

// FIX 1a: unknown component custom_id -> ephemeral expired notice, not silence
reset();
onboarded('PX');
sent.length = 0;
await routeInteraction(btnIx('totally_unknown_btn', 'PX'));
{
  const cb = lastCb();
  ok(cb?.type === 4, 'fix1: unknown button custom_id sends an interaction ack (callback type 4)');
  ok(cb?.data?.flags === 32832, 'fix1: unknown-button ack is ephemeral V2 (flags 32832)');
  ok(/expired/i.test(str(cb?.data)), 'fix1: unknown-button ack tells the user the button expired');
  ok(!/—|–/.test(str(cb?.data)), 'fix1: expired-button notice has no em/en dashes');
}

// FIX 1b: unknown modal custom_id -> same notice
sent.length = 0;
await routeInteraction(modalIx('totally_unknown_modal', 'PX', []));
{
  const cb = lastCb();
  ok(cb?.type === 4, 'fix1: unknown modal custom_id sends an interaction ack (callback type 4)');
  ok(cb?.data?.flags === 32832, 'fix1: unknown-modal ack is ephemeral V2 (flags 32832)');
  ok(/expired/i.test(str(cb?.data)), 'fix1: unknown-modal ack tells the user the form expired');
  ok(!/—|–/.test(str(cb?.data)), 'fix1: expired-modal notice has no em/en dashes');
}

// FIX 2: 4004 (authentication failed / invalid token) is a fatal close code
{
  const src = readSource('src/discord/gateway.js');
  const m = src.match(/FATAL_CLOSE_CODES\s*=\s*new\s+Set\(\s*\[([^\]]*)\]\s*\)/);
  ok(!!m, 'fix2: FATAL_CLOSE_CODES set found in gateway.js');
  const codes = (m?.[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
  ok(codes.includes('4004'), 'fix2: 4004 (auth failed) is in FATAL_CLOSE_CODES, so bad tokens do not reconnect-loop');
}

// FIX 3: index.js registers an uncaughtException handler that flushes the db
// then exits. Static check plus a unit test of the REAL extracted handler
// body against stubbed db/logger/process (no live process.exit involved).
{
  const src = readSource('src/index.js');
  const hookAt = src.indexOf("process.on('uncaughtException'");
  ok(hookAt !== -1, 'fix3: index.js registers an uncaughtException handler');
  const arrowAt = src.indexOf('=>', hookAt);
  const braceAt = src.indexOf('{', arrowAt);
  let depth = 0, end = -1;
  for (let i = braceAt; i >= 0 && i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = braceAt >= 0 && end > braceAt ? src.slice(braceAt, end + 1) : '';
  ok(/try\s*\{[\s\S]*db\.flush\(\)/.test(body), 'fix3: handler calls db.flush() inside a try block');
  ok(/catch/.test(body), 'fix3: the flush attempt is guarded by try/catch');
  ok(/process\.exit\(1\)/.test(body), 'fix3: handler exits with code 1 after the flush attempt');
  // Unit-test the actual handler code with stubs (only when we found it).
  if (hookAt !== -1 && body) {
    const runHandler = new Function('logger', 'db', 'process', 'err', body);
    let flushed = 0, exited = null;
    const stubLogger = { error: () => {} };
    const stubProcess = { exit: (c) => { exited = c; } };
    runHandler(stubLogger, { flush: () => { flushed++; } }, stubProcess, new Error('boom'));
    ok(flushed === 1, 'fix3: handler calls db.flush() on an uncaught exception');
    ok(exited === 1, 'fix3: handler exits with code 1 after a clean flush');
    // If flush itself throws, the handler must still exit 1 rather than die.
    flushed = 0; exited = null;
    runHandler(stubLogger, { flush: () => { flushed++; throw new Error('disk gone'); } }, stubProcess, new Error('boom'));
    ok(flushed === 1 && exited === 1, 'fix3: handler still exits 1 when db.flush() throws');
  } else {
    ok(false, 'fix3: handler body extractable for unit testing');
    ok(false, 'fix3: handler calls db.flush() on an uncaught exception');
    ok(false, 'fix3: handler exits with code 1 after a clean flush');
    ok(false, 'fix3: handler still exits 1 when db.flush() throws');
  }
}

// ---------------------------------------------------------------------------
// L. router catch-all catches ASYNC handler failures (return await)
// ---------------------------------------------------------------------------
reset();
onboarded('PL');
sent.length = 0;
// Sabotage the db write the name-modal handler performs: the handler's
// promise rejects asynchronously, after its initial defer reply.
const origUpdate = db.updateUserProfile;
let sawRejection = false;
db.updateUserProfile = () => { throw new Error('mock db outage'); };
try {
  await routeInteraction(modalIx('profile_update_name_modal', 'PL', [['profile_name_input', 'Bob']]))
    .catch(() => { sawRejection = true; });
} finally {
  db.updateUserProfile = origUpdate;
}
{
  ok(!sawRejection, 'L: routeInteraction resolves instead of rejecting when a handler fails');
  ok(lastCb()?.data?.embeds?.[0]?.title === 'Something Went Wrong',
    'L: async handler failure triggers the Something Went Wrong error reply');
}

// ---------------------------------------------------------------------------
// M. routeInteraction tolerates non-object interactions
// ---------------------------------------------------------------------------
{
  let threwNull = false, threwStr = false;
  try { await routeInteraction(null); } catch { threwNull = true; }
  try { await routeInteraction('junk'); } catch { threwStr = true; }
  ok(!threwNull, 'M: routeInteraction(null) resolves instead of throwing');
  ok(!threwStr, 'M: routeInteraction("junk") resolves instead of throwing');
}

// ---------------------------------------------------------------------------
// N. parseModalSubmit tolerates truthy non-array components
// ---------------------------------------------------------------------------
{
  let threw = false, res = null;
  try { res = parseModalSubmit({ data: { components: 'junk' } }); } catch { threw = true; }
  ok(!threw, 'N: parseModalSubmit does not throw on truthy non-array components');
  ok(res && typeof res.fields === 'object' && Object.keys(res.fields).length === 0,
    'N: parseModalSubmit returns empty fields for malformed components');
}

// ---------------------------------------------------------------------------
// O. transient REST failure does not kill the reconnect loop (HIGH)
// ---------------------------------------------------------------------------
{
  const server = await startMockGateway();
  globalThis.mockWsUrl = server.url;
  mockRest.gatewayBotFailTimes = 2; // first two /gateway/bot calls blow up
  unhandled.length = 0;
  const gw = new Gateway(async () => {});
  const started = gw.start(); // must not reject; the loop must survive
  const t0 = Date.now();
  while (!gw.sessionId && Date.now() - t0 < 20000) await sleepMs(100);
  ok(gw.sessionId === 'mock-session-1', 'O: gateway reaches READY after transient REST failures');
  ok(unhandled.length === 0, 'O: no unhandled rejections while riding out the outage');
  await gw.stop();
  await started.catch(() => {});
  mockRest.gatewayBotFailTimes = 0;
  await server.close();
}

// ---------------------------------------------------------------------------
// P. connect attempt times out instead of hanging forever (HIGH)
// ---------------------------------------------------------------------------
{
  const mock = await startMockGateway();
  globalThis.mockWsUrl = mock.url;
  const hang = await startHangServer(); // accepts TCP, never answers CONNECT
  const proxyUrl = `http://127.0.0.1:${hang.port}`;
  const prevEnv = {};
  for (const k of ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY']) {
    prevEnv[k] = process.env[k];
    process.env[k] = proxyUrl;
  }
  delete process.env.no_proxy; delete process.env.NO_PROXY;
  const gw = new Gateway(async () => {});
  gw.connectTimeoutMs = 400; // production default is 15000; shrink for the test
  const t0 = Date.now();
  gw.connect(false).catch(() => {}); // floats on purpose: unpatched, this never settles
  while (gw.reconnectAttempt < 1 && Date.now() - t0 < 8000) await sleepMs(100);
  const elapsed = Date.now() - t0;
  ok(hang.connections() >= 1, 'P: the attempt really went through the hanging proxy');
  ok(gw.reconnectAttempt >= 1, 'P: timed-out connect attempt enters the reconnect path');
  ok(elapsed < 8000, 'P: the attempt failed fast instead of hanging forever');
  await gw.stop();
  for (const k of Object.keys(prevEnv)) {
    if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k];
  }
  await hang.close();
  await mock.close();
}

// ---------------------------------------------------------------------------
// Q. zombie heartbeat branch disarms the timer (no close() hot loop)
// ---------------------------------------------------------------------------
{
  const gw = new Gateway(async () => {});
  let closeCalls = 0;
  // fake socket that never produces onclose (the wedged case)
  gw.ws = { readyState: 1, send() {}, close() { closeCalls++; } };
  gw.lastAck = false; // simulate the heartbeat that never got its ACK
  gw.startHeartbeat(25);
  const t0 = Date.now();
  while (closeCalls < 1 && Date.now() - t0 < 3000) await sleepMs(10);
  await sleepMs(150); // give a hot loop time to spin
  ok(closeCalls === 1, 'Q: zombie branch closes the socket exactly once');
  ok(gw.heartbeatTimer === null, 'Q: zombie branch disarms the heartbeat timer');
  ok(gw.lastAck === true, 'Q: zombie branch resets lastAck');
  gw.clearHeartbeat();
}

// ---------------------------------------------------------------------------
// R. INVALID_SESSION(d=true): bounded backoff, then fresh identify
// ---------------------------------------------------------------------------
{
  const gw = new Gateway(async () => {});
  const sentOps = [];
  gw.ws = {
    readyState: 1,
    send(payload) { try { sentOps.push(JSON.parse(payload).op); } catch {} },
    close() {},
  };
  gw.sessionId = 'sess-r'; gw.resumeUrl = 'ws://127.0.0.1:9'; gw.seq = 42;
  await gw.handleMessage(JSON.stringify({ op: 9, d: true }));
  ok(gw.invalidSessionAttempts === 1, 'R: resumable invalid-session uses a bounded attempt counter');
  ok(sentOps.includes(6), 'R: resume is still retried while under the cap');
  // cap exhausted: no more sleeping, straight to a fresh session
  gw.invalidSessionAttempts = 99;
  gw.sessionId = 'sess-r'; gw.resumeUrl = 'ws://127.0.0.1:9';
  sentOps.length = 0;
  const t0 = Date.now();
  await gw.handleMessage(JSON.stringify({ op: 9, d: true }));
  ok(Date.now() - t0 < 1500, 'R: exhausted retries fall back immediately instead of sleeping forever');
  ok(gw.sessionId === null && gw.resumeUrl === null, 'R: exhausted retries clear the session for a fresh identify');
  ok(!sentOps.includes(6), 'R: no resume attempted after the cap');
  await gw.stop();
}

// ---------------------------------------------------------------------------
// S. seq resets on fresh identify after non-resumable INVALID_SESSION
// ---------------------------------------------------------------------------
{
  const gw = new Gateway(async () => {});
  gw.ws = { readyState: 1, send() {}, close() {} };
  gw.sessionId = 'sess-s'; gw.resumeUrl = 'ws://127.0.0.1:9'; gw.seq = 42;
  await gw.handleMessage(JSON.stringify({ op: 9, d: false, s: 43 }));
  ok(gw.seq === 0, 'S: seq resets to 0 on fresh identify after non-resumable invalid session');
  ok(gw.sessionId === null && gw.resumeUrl === null, 'S: session cleared on non-resumable invalid session');
  await gw.stop();
}

// Restore the proxy environment after the gateway tests.
for (const [k, v] of Object.entries(__savedProxyEnv)) {
  if (v === undefined) delete process.env[k]; else process.env[k] = v;
}

// ---------------------------------------------------------------------------
// P. patch-attachwiz regressions (stress-test fleet).
// Touches: src/services/attachments.js, src/utils/media.js, src/flows/onboarding.js.
// Written to FAIL on unpatched code and PASS after the six fixes.
// In scope from the harness: ok, reset, sent, db, str, btnIx, modalUploadIx,
// lastCb, routeInteraction, onboarded, dobForAge.
// ---------------------------------------------------------------------------

// P1. note-sniff executable bypass: an MZ/ELF stub made of valid UTF-8 bytes
// (as x.txt/text/plain) used to sail through both validation layers.
// (Cycle-2 fix7: a PURE-ASCII MZ stub now sniffs as 'note' — documented
// residual, since blocking "MZR-12 ..." text was a false positive. Binaries
// with non-text bytes are still blocked.)
reset();
{
  const { validateAttachment, sniffCategory, sniffMatches } = await import('../src/services/attachments.js');
  // Pure-ASCII PE/ELF stubs: looksLikeText alone would call them plain text.
  const mzStub = Buffer.from('MZ' + 'A'.repeat(64) + '\nThis program cannot be run in DOS mode.\n', 'utf8');
  const mzBinary = Buffer.concat([
    Buffer.from('MZ', 'utf8'),
    Buffer.from([0x90, 0x00, 0x03, 0x00, 0xff, 0xd8]),
    Buffer.from('This program cannot be run in DOS mode.', 'utf8'),
  ]);
  const elfStub = Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    Buffer.from(' ELF64 stub header, plain ascii bytes\n', 'utf8'),
  ]);
  ok(sniffCategory(mzStub) === 'note', "P1: pure-ASCII MZ stub sniffs as note (fix7 documented residual)");
  ok(sniffCategory(mzBinary) === null, 'P1: real PE binary (non-text bytes) is not sniffed as a note');
  ok(sniffCategory(elfStub) === null, 'P1: ELF stub is not sniffed as a note');
  ok(!sniffMatches('note', mzBinary), 'P1: PE binary declared as x.txt/text/plain is blocked at the sniff layer');
  ok(!sniffMatches('note', elfStub), 'P1: ELF bytes declared as x.txt/text/plain are blocked at the sniff layer');
  const layer1 = validateAttachment({ filename: 'x.txt', content_type: 'text/plain' });
  ok(layer1.ok && layer1.category === 'note', 'P1: first layer still accepts a genuine x.txt/text/plain');
  ok(sniffMatches(layer1.category, Buffer.from('just a real note\n', 'utf8')), 'P1: legit text still sniffs as a note');
}

// P2. category list drift: every extension the validator accepts must appear
// in the sender-facing ALLOWED_BY_CATEGORY, and every listed ext must be known.
reset();
{
  const { validateAttachment, ALLOWED_BY_CATEGORY } = await import('../src/services/attachments.js');
  const listed = new Set(ALLOWED_BY_CATEGORY.flatMap((c) => c.exts.map((e) => String(e).toLowerCase())));
  for (const [ext, mime] of [['jpe', 'image/jpeg'], ['jfif', 'image/jpeg'], ['heif', 'image/heif'], ['oga', 'audio/ogg']]) {
    ok(validateAttachment({ filename: `f.${ext}`, content_type: mime }).ok, `P2: validator accepts .${ext}`);
    ok(listed.has(ext), `P2: ALLOWED_BY_CATEGORY lists ${ext.toUpperCase()}`);
  }
  for (const ext of listed) {
    const r = validateAttachment({ filename: `f.${ext}`, content_type: 'bogus/type' });
    ok(r.reason !== 'unknown_extension', `P2: listed ${ext.toUpperCase()} is a known extension`);
  }
}

// P3. download timeout: downloadProfileMedia must not hang forever on a
// stalled CDN connection (15s abort). The mocked fetch never hangs, so this
// asserts the call carries the timeout signal.
reset();
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/utils/media.js', import.meta.url), 'utf8');
  ok(src.includes('fetch(att.url, { signal: AbortSignal.timeout(15000) })'),
    'P3: downloadProfileMedia passes AbortSignal.timeout(15000) to fetch');
}

// P4. confirm-failure loop: confirming with a broken draft (no name/dob)
// used to show a retry card whose only button (onboard_start) led straight
// back to the same failure, forever.
reset();
db.saveOnboardDraft('OBX', { step: 4, data: { name: '', dob: '', location: '', bio: '', media: [] } });
sent.length = 0;
await routeInteraction(btnIx('onboard_confirm', 'OBX', {}));
ok(!db.getOnboardDraft('OBX'), 'P4: confirm-failure clears the broken draft');
{
  const cb = lastCb();
  ok(cb?.type === 4 && str(cb?.data).includes('Welcome to anonymous chat'),
    'P4: confirm-failure routes to a fresh welcome card');
  ok(!str(cb?.data).includes("didn't save"), 'P4: no retry card after confirm-failure');
}

// P5. stale wizard buttons: onboard_next2/onboard_next3/onboard_restart opened
// modals with no needsOnboarding guard (their submit counterparts have it).
reset();
onboarded('OBG');
for (const cid of ['onboard_next2', 'onboard_next3', 'onboard_restart']) {
  sent.length = 0;
  await routeInteraction(btnIx(cid, 'OBG', {}));
  const cb = lastCb();
  ok(cb?.type === 4 && str(cb?.data).includes('already set up'),
    `P5: ${cid} refuses an onboarded user instead of opening a wizard modal`);
}

// P6. lost typed name: a failed DOB validation never saved the valid name,
// so the retry modal reopened blank.
reset();
sent.length = 0;
await routeInteraction(modalUploadIx('onboard_m1', 'OBN', {
  texts: { onboard_name: 'typedname', onboard_dob_day: 'abc', onboard_dob_month: '08', onboard_dob_year: '2001' },
}));
ok(db.getOnboardDraft('OBN')?.data?.name === 'typedname',
  'P6: the typed name is persisted to the draft before DOB validation');
sent.length = 0;
await routeInteraction(btnIx('onboard_start', 'OBN', {}));
{
  const cb = lastCb();
  ok(cb?.type === 9 && cb?.data?.custom_id === 'onboard_m1', 'P6: retry reopens wizard modal 1');
  ok(str(cb?.data).includes('typedname'), 'P6: reopened modal 1 prefills the typed name');
}

// ---------------------------------------------------------------------------
// X. Patch regression: profanity-engine DoS cap, profile markdown escaping,
//    identity-card noMentions. (Stress-test patch section; merged into the
//    suite verbatim. Uses only the shared harness helpers plus dynamic
//    imports; no static imports, no side effects outside the assertions.)
// ---------------------------------------------------------------------------

// X1. Bug 1 (CRITICAL): scanHard must not hang the event loop on long
// unspaced spans. The deep fuzzy analysis is capped to a leading window;
// exact/simple evidence still runs on the full span.
{
  const { scanHard } = await import('../src/services/profanity-engine.js');
  const longSpan = Array.from(
    { length: 200 }, (_, i) => String.fromCharCode(97 + (i % 26)),
  ).join('');
  const t0 = Date.now();
  const hits = scanHard(longSpan, {});
  const ms = Date.now() - t0;
  ok(ms < 1000, `200-char unspaced span scans in <1000ms (took ${ms}ms)`);
  ok(Array.isArray(hits), 'scanHard still returns a hits array for long spans');
  // A long span carrying plain profanity is still caught: substring/exact
  // evidence runs on the full span, outside the fuzzy cap.
  ok(scanHard(`fuck${'x'.repeat(196)}`, {}).length > 0,
    '200-char span with embedded profanity still flags');
  // Short-span evasions are untouched by the cap (all under the window).
  for (const w of ['f*ck', 'fvck', 'f.u.c.k', 'fucck', 'fuuuck']) {
    ok(scanHard(w, {}).length > 0, `short-span evasion still flagged: ${w}`);
  }
  ok(scanHard('hello', {}).length === 0, 'innocent word still clean');
}

// X2. Bug 2 (MODERATE): user-controlled profile fields must not inject
// markdown (masked-link phishing) into cards DM'd to the stranger.
{
  const embeds = await import('../src/utils/embeds.js');
  const hostile = {
    name: 'Eve', dob: dobForAge(20), location: '[HQ](https://evil.example)',
    bio: '[x](https://evil.example)', interests: ['a](https://evil.example', 'plain'],
    media: [],
  };
  const headline = embeds.profileHeadline(hostile);
  ok(!headline.includes('[x](https://evil.example)'),
    'masked-link bio is escaped in the headline');
  ok(!headline.includes('[HQ](https://evil.example)'),
    'masked-link location is escaped in the headline');
  ok(headline.startsWith('**Eve**'), 'headline keeps its own bold-name formatting');
  ok(headline.includes(' · '), 'headline keeps its separators');
  const card = embeds.identityRevealCard(
    hostile, 'user_E', 'E', [], "Here's the person you've been chatting with.",
  );
  const s = str(card);
  ok(!s.includes('[x](https://evil.example)'),
    'identity reveal card escapes the hostile bio (no clickable masked link)');
  ok(s.includes('**Eve**'), 'identity card keeps the bold name');
  const pc = embeds.profileCard(hostile);
  ok(!str(pc).includes('](https://evil.example'),
    'profile card escapes hostile interests');
  ok(str(pc).includes('Interests:') && str(pc).includes('plain'),
    'profile card still lists benign interests');
}

// X3. Bug 3 (LOW): the identity reveal cards must be sent with mention
// parsing disabled, so @everyone/@here in a bio cannot ping anyone.
{
  const slashIx = (name, uid) => ({
    id: 'ix', token: 'tok', type: 2,
    user: { id: String(uid), username: `user_${uid}`, global_name: null },
    data: { name },
  });
  reset();
  onboarded('A');
  onboarded('B');
  db.updateUserProfile({ ...db.getUserProfile('A'), name: 'Aria', bio: '@everyone hi' });
  db.updateUserProfile({ ...db.getUserProfile('B'), name: 'Bir', bio: '@here hello' });
  await routeInteraction(slashIx('new', 'A'));
  await routeInteraction(slashIx('new', 'B'));
  await routeInteraction(slashIx('share', 'A'));
  sent.length = 0;
  await routeInteraction(btnIx('share_accept', 'B', { channelId: 'dm_B', messageId: 'req1' }));
  const cardPosts = sent.filter(
    (e) => e.method === 'POST' && /\/channels\/dm_[AB]\/messages$/.test(e.url),
  );
  ok(cardPosts.length === 2, 'both identity cards are DM-sent on accept');
  ok(cardPosts.every((m) => JSON.stringify(m.body.allowed_mentions) === '{"parse":[]}'),
    'identity card DMs carry allowed_mentions { parse: [] }');
  const bodies = str(cardPosts.map((m) => m.body));
  ok(bodies.includes('@everyone') && bodies.includes('@here'),
    'hostile bios still reach the card text (only mention parsing is off)');
}

// ---------------------------------------------------------------------------
// Patch-evasion2 regression section (E1-E4).
// Merge context: the suite harness provides `ok` (plus reset, sent, db,
// str, routeInteraction, onboarded, dobForAge for other sections). Dynamic
// imports only; no static imports; no top-level side effects beyond the
// asserts themselves.
// ---------------------------------------------------------------------------
const { filterText, maskCompoundSpan } = await import('../src/services/profanity.js');
const evMinor = (s) => filterText(s);                  // default: minor chat
const evAdult = (s) => filterText(s, { adultChat: true });

// ---------------------------------------------------------------------------
// E1 — emoji inside a word defeats detection. The tokenizer splits emoji as
// punct, so f😀uck / b😀itch / n😀igga must re-glue and flag (6 inputs).
// ---------------------------------------------------------------------------
for (const w of ['f😀uck', 'b😀itch', 'n😀igga']) {
  ok(evMinor(w).flagged, `E1 minor: emoji-inside word flags: ${w}`);
}
ok(evMinor('f😀u😀c😀k').flagged, 'E1 minor: multi-emoji evasion flags: f😀u😀c😀k');
for (const w of ['b😀itch', 'n😀igga']) {
  ok(evAdult(w).flagged, `E1 adult: hard-tier emoji word flags: ${w}`);
}
ok(evMinor('f😀uck').text !== 'f😀uck', 'E1 minor: f😀uck is masked, not byte-identical');
// Tiering preserved: sensitive-tier emoji evasions still pass in adult chats,
// mirroring the pinned adult f.u.c.k behavior.
{
  const r = evAdult('f😀uck');
  ok(!r.flagged && r.text === 'f😀uck', 'E1 adult: sensitive-tier emoji evasion passes (tiering)');
}
// Controls: emoji-only messages and emoji between words are unaffected.
for (const s of ['😀😀😀', '😀', 'hi 😀 there', 'fuck 😀 you']) {
  const r = evMinor(s);
  if (s === 'fuck 😀 you') {
    ok(r.flagged && r.text === 'f∗∗k 😀 you', 'E1 control: words around emoji still handled');
  } else {
    ok(!r.flagged && r.text === s, `E1 control passes clean and byte-identical: ${s}`);
  }
}

// ---------------------------------------------------------------------------
// E2 — long digit strings false-positive + strike. Pure-digit spans must
// pass clean (never take the fuzzy verdict); mention syntax survives relay.
// ---------------------------------------------------------------------------
for (const s of ['987654321098765432', '15551234567', '12345678901']) {
  const r = evMinor(s);
  ok(!r.flagged && r.text === s, `E2 digit string passes clean and byte-identical: ${s}`);
}
{
  const s = '<@123456789012345678>';
  const r = evMinor(s);
  ok(!r.flagged && r.text === s, 'E2 mention syntax survives relay byte-identical');
}
// Spans with real letters keep the full pipeline: 5h1t/sh1t still upgrade
// beside flaggable profanity.
{
  const r = evMinor('@ss and 5h1t');
  ok(r.flagged && r.text === '@∗s and 5∗∗t', 'E2 control: 5h1t (has letters) still processed');
}
{
  const r = evMinor('fuck this sh1t');
  ok(r.flagged && r.text === 'f∗∗k this s∗∗t', 'E2 control: sh1t (has letters) still processed');
}

// ---------------------------------------------------------------------------
// E3 — full-width + zalgo evasions must flag.
// ---------------------------------------------------------------------------
{
  const r = evMinor('ｆｕｃｋ ｙｏｕ');
  ok(r.flagged, 'E3 full-width ｆｕｃｋ flags');
}
{
  const zalgo = 'f\u0301u\u0327c\u0302k\u0308'; // f+acute, u+cedilla-below, c+circumflex, k+diaeresis
  const r = evMinor(zalgo);
  ok(r.flagged, 'E3 zalgo combining-marks fuck flags');
}

// ---------------------------------------------------------------------------
// E4 — maskCompoundSpan astral misalignment: code-point-consistent masking.
// ---------------------------------------------------------------------------
ok(
  maskCompoundSpan('😀fuckass') === '😀f∗∗ka∗s',
  'E4 maskCompoundSpan astral: 😀fuckass -> 😀f∗∗ka∗s',
);
ok(
  maskCompoundSpan('fuckass') === 'f∗∗ka∗s',
  'E4 control: BMP-only maskCompoundSpan unchanged',
);

// ---------------------------------------------------------------------------
// L3. unknown-DOB waiters sort last (cycle-2 fix): an unknown-DOB newcomer
// must not steal the closer real pair in a sweep.
// ---------------------------------------------------------------------------
reset();
agedExact('L3A', 13.0); agedExact('L3B', 13.25);
db.createProfile({ id: 'L3U', name: 'user_L3U', dob: null, interests: [] });
matchmaking.addToQueue('L3A', 'anonA');
matchmaking.addToQueue('L3B', 'anonB');
matchmaking.addToQueue('L3U', 'anonU');
{
  const pair = matchmaking.tryMatchWaiters();
  const ids = [pair.user1.user_id, pair.user2.user_id].sort().join(',');
  ok(ids === 'L3A,L3B', 'unknown-DOB waiter sorts last: closer real pair (gap ~0.25y) wins the sweep');
  ok(matchmaking.getQueueSize() === 1, 'unknown-DOB waiter stays queued after the real pair is taken');
}


// ---------------------------------------------------------------------------
// DB2. database.js corruption-hardening regressions (cycle-2 persistence hunt).
// Merged from regression-sections/patch-db2-section.mjs (25 tests); uses the
// suite harness (ok, reset, db, rmSync, writeFileSync, mkdirSync).
// ---------------------------------------------------------------------------
{
    // ---- cycle-2 merge prologue: reproduce the section's standalone isolation ----
  {
      const { rmSync: rmDir } = await import('node:fs');
      const { default: nodePath } = await import('node:path');
      const { paths: cfgPaths } = await import('../src/config.js');
      process.env.DATA_DIR = '/tmp/patch-db2-data';
      rmDir(process.env.DATA_DIR, { recursive: true, force: true });
      cfgPaths.dataDir = nodePath.resolve(process.env.DATA_DIR);
      cfgPaths.dbFile = nodePath.join(cfgPaths.dataDir, 'db.json');
      cfgPaths.mediaDir = nodePath.join(cfgPaths.dataDir, 'media');
    }
    reset();

    const path = (await import('node:path')).default;
  const DIR = process.env.DATA_DIR;
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const DBF = path.join(DIR, 'db.json');

  db.save = () => {}; // neutralize debounced disk writes

  const SESS = { session_id: 's1', user1_id: 'u1', user2_id: 'u2' };
  function check(label, actual, expectFn, note = '') {
    ok(expectFn(actual), `[db2] ${label}${note ? ' :: ' + note : ''}`);
  }
  function load(payload) {
    writeFileSync(DBF, JSON.stringify(payload));
    db.load();
  }

  // ---------- Bug 1: ratePartner crashes on corrupt ratedSessions record ----------
  load({ ratedSessions: { s1: { u1: 'u1', u2: 'u2' } } }); // missing `rated`
  try {
    const r = db.ratePartner('s1', 'u1', 'like');
    check('bug1 missing-rated', r, (r) => r.ok === true && r.partnerId === 'u2' && r.likes === 1, JSON.stringify(r));
  } catch (e) { check('bug1 missing-rated', null, () => false, `THREW ${e.constructor.name}: ${e.message}`); }

  load({ ratedSessions: { s1: { u1: 'u1', u2: 'u2', rated: 'x' } } }); // wrong-typed `rated`
  try {
    const r = db.ratePartner('s1', 'u1', 'like');
    check('bug1 wrongtype-rated', r, (r) => r.ok === true && r.likes === 1, JSON.stringify(r));
  } catch (e) { check('bug1 wrongtype-rated', null, () => false, `THREW ${e.constructor.name}: ${e.message}`); }

  // ---------- Bug 2: cap-eviction comparators crash on null entries ----------
  {
    const rs = {};
    for (let i = 0; i < 500; i++) rs['s' + i] = { u1: 'a', u2: 'b', rated: [], at: 1000 + i };
    load({ ratedSessions: rs });
    db.db.ratedSessions.rt_null = null; // runtime-injected null (load purge can't see it)
    try {
      db.noteSessionConcluded({ session_id: 'sNew', user1_id: 'a', user2_id: 'b' });
      const n = Object.keys(db.db.ratedSessions).length;
      const hasNull = Object.values(db.db.ratedSessions).some((v) => v == null);
      check('bug2a eviction-null', n, () => n === 500 && !hasNull, `entries=${n} hasNull=${hasNull}`);
    } catch (e) { check('bug2a eviction-null', null, () => false, `THREW ${e.constructor.name}: ${e.message}`); }
  }
  {
    const sh = {};
    for (let i = 0; i < 500; i++) sh['k' + i] = { count: 1, last_share: 1000 + i };
    load({ shares: sh });
    db.db.shares.rt_null = null;
    try {
      db.recordUsernameShare('ns', 'u9');
      const n = Object.keys(db.db.shares).length;
      const hasNull = Object.values(db.db.shares).some((v) => v == null);
      check('bug2b shares-eviction-null', n, () => n === 500 && !hasNull, `entries=${n} hasNull=${hasNull}`);
    } catch (e) { check('bug2b shares-eviction-null', null, () => false, `THREW ${e.constructor.name}: ${e.message}`); }
  }

  // ---------- Bug 3: ratePartner on wrong-typed reputation entry ----------
  load({ reputation: { u1: 'x' } });
  db.noteSessionConcluded(SESS);
  try {
    const r = db.ratePartner('s1', 'u2', 'like');
    const rep = db.db.reputation.u1;
    check('bug3a rep-string', r, () => r.ok === true && r.likes === 1 && typeof rep.likes === 'number' && rep.dislikes === 0,
      JSON.stringify(r) + ' stored=' + JSON.stringify(rep));
  } catch (e) { check('bug3a rep-string', null, () => false, `THREW ${e.constructor.name}: ${e.message}`); }

  load({ reputation: { u1: { likes: '5' } } });
  db.noteSessionConcluded(SESS);
  try {
    const r = db.ratePartner('s1', 'u2', 'like');
    check('bug3b rep-stringnums', r, (r) => r.ok === true && r.likes === 1 && r.dislikes === 0 && r.total === 1,
      JSON.stringify(r));
  } catch (e) { check('bug3b rep-stringnums', null, () => false, `THREW ${e.constructor.name}: ${e.message}`); }

  // ---------- Bug 4: getBlockEntries/getBlockedUsers crash on null entry ----------
  load({ blocks: { u1: { t1: null, t2: { at: '2026-01-01T00:00:00.000Z', anonId: 'aabbccdd1122', source: 'chat' } } } });
  try {
    const entries = db.getBlockEntries('u1');
    const users = db.getBlockedUsers('u1');
    check('bug4 null-block-entry', entries, (e) => e.length === 1 && users.length === 1 && users[0] === 'aabbccdd1122',
      `entries=${entries.length}`);
  } catch (e) { check('bug4 null-block-entry', null, () => false, `THREW ${e.constructor.name}: ${e.message}`); }

  // ---------- Bug 5: blockUser crashes on wrong-typed block map ----------
  load({ blocks: { u1: 'x' } });
  try {
    db.blockUser('u1', 't9');
    const n = db.getBlockedUsers('u1').length;
    check('bug5 blockmap-string', n, () => n === 1, `blocked=${n}`);
  } catch (e) { check('bug5 blockmap-string', null, () => false, `THREW ${e.constructor.name}: ${e.message}`); }

  // ---------- Bug 6: recent-partner ring wrong-typed ----------
  load({ recentPartners: { u1: 'str' } });
  try {
    db.pushRecentPartner('u1', 'p1');
    const l = db.getRecentPartners('u1');
    check('bug6a push-string-ring', l, () => Array.isArray(l) && l.length === 1 && l[0] === 'p1', JSON.stringify(l));
  } catch (e) { check('bug6a push-string-ring', null, () => false, `THREW ${e.constructor.name}: ${e.message}`); }

  load({ recentPartners: { u1: 'str' } });
  try {
    const l = db.getRecentPartners('u1');
    check('bug6b get-string-ring', l, () => Array.isArray(l) && l.length === 0, JSON.stringify(l));
  } catch (e) { check('bug6b get-string-ring', null, () => false, `THREW ${e.constructor.name}: ${e.message}`); }

  // ---------- Bug 7: lifetime accessors on wrong-typed profile ----------
  load({ profiles: { u1: 'x' } });
  try {
    const p = db.getUserProfile('u1');
    const lt = db.getLifetimeStats('u1');
    db.recordChatLifetime('u1', { messages: 1, durationMs: 10 }); // must not throw / create garbage
    check('bug7a profile-string', { p, lt }, ({ p, lt }) => p === null && lt === null, `profile=${JSON.stringify(p)}`);
  } catch (e) { check('bug7a profile-string', null, () => false, `THREW ${e.constructor.name}: ${e.message}`); }

  load({ profiles: { u1: 'x' } });
  try {
    db.updateUserProfile({ id: 'u1', name: 'n' });
    const stored = db.db.profiles.u1;
    const clean = stored && typeof stored === 'object' && stored.id === 'u1' && stored.name === 'n' && !('0' in stored);
    check('bug7b update-garbage', stored, () => clean, JSON.stringify(stored)?.slice(0, 90));
  } catch (e) { check('bug7b update-garbage', null, () => false, `THREW ${e.constructor.name}: ${e.message}`); }

  // ---------- Bug 9: __proto__ pollution guards ----------
  load({});
  try {
    const protoBefore = Object.getPrototypeOf(db.db.blocks);
    db.blockUser('__proto__', 't1');
    db.blockUser('u1', '__proto__');
    const ok = Object.getPrototypeOf(db.db.blocks) === protoBefore && !('t1' in {});
    check('bug9 proto-block', ok, (v) => v === true, `protoChanged=${Object.getPrototypeOf(db.db.blocks) !== protoBefore}`);
  } catch (e) { check('bug9 proto-block', null, () => false, `THREW ${e.constructor.name}: ${e.message}`); }

  load({});
  try {
    const protoBefore = Object.getPrototypeOf(db.db.bans);
    db.banUser('__proto__', 'r');
    const ok = Object.getPrototypeOf(db.db.bans) === protoBefore && db.isBanned('u-none') === false;
    check('bug9 proto-ban', ok, (v) => v === true, `protoChanged=${Object.getPrototypeOf(db.db.bans) !== protoBefore}`);
  } catch (e) { check('bug9 proto-ban', null, () => false, `THREW ${e.constructor.name}: ${e.message}`); }

  // ---------- removeBlock (a): ambiguous prefix -> 'ambiguous' ----------
  {
    const at = '2026-01-01T00:00:00.000Z';
    load({ blocks: { u1: {
      t1: { at, anonId: 'abcd1234aaaa', source: 'chat' },
      t2: { at, anonId: 'abcd1234bbbb', source: 'chat' },
    } } });
    const r = db.removeBlock('u1', 'abcd1234');
    const remaining = Object.keys(db.db.blocks.u1).length;
    check('removeBlock-ambiguous', r, () => r === 'ambiguous' && remaining === 2, `result=${JSON.stringify(r)} remaining=${remaining}`);
  }
  // ---------- removeBlock (b): uppercase selector matches lowercase hex ----------
  load({ blocks: { u1: { t1: { at: '2026-01-01T00:00:00.000Z', anonId: 'abcdef12cafe', source: 'chat' } } } });
  {
    const r = db.removeBlock('u1', 'ABCDEF12');
    check('removeBlock-uppercase', r, () => r === true && Object.keys(db.db.blocks.u1).length === 0, `result=${JSON.stringify(r)}`);
  }
  // exact-match and unique-prefix paths still work
  load({ blocks: { u1: { t1: { at: '2026-01-01T00:00:00.000Z', anonId: 'abcdef12cafe', source: 'chat' } } } });
  check('removeBlock-exact-full-anonid', db.removeBlock('u1', 'abcdef12cafe'), (r) => r === true);
  load({ blocks: { u1: { '12345': { at: '2026-01-01T00:00:00.000Z', anonId: 'zzzz', source: 'chat' } } } });
  check('removeBlock-exact-discord-id', db.removeBlock('u1', '12345'), (r) => r === true);
  load({ blocks: { u1: { t1: { at: '2026-01-01T00:00:00.000Z', anonId: 'abcdef12cafe', source: 'chat' } } } });
  check('removeBlock-unique-prefix', db.removeBlock('u1', 'abcdef12'), (r) => r === true);
  load({ blocks: { u1: { t1: { at: '2026-01-01T00:00:00.000Z', anonId: 'abcdef12cafe', source: 'chat' } } } });
  check('removeBlock-no-match', db.removeBlock('u1', '9999'), (r) => r === false);

  // ---------- Cycle-1 regression guards ----------
  load({ profiles: 'oops', reports: null, shares: 42 });
  check('cycle1 load-type-guards', null, () =>
    typeof db.db.profiles === 'object' && !Array.isArray(db.db.profiles) &&
    Array.isArray(db.db.reports) && typeof db.db.shares === 'object');

  load({ shares: {} });
  for (let i = 0; i < 501; i++) db.recordUsernameShare('s' + i, 'u' + i);
  check('cycle1 shares-cap-500', Object.keys(db.db.shares).length, (n) => n === 500);

  load({ ratedSessions: {} });
  for (let i = 0; i < 501; i++) db.noteSessionConcluded({ session_id: 'c' + i, user1_id: 'a', user2_id: 'b' });
  check('cycle1 ratedSessions-cap-500', Object.keys(db.db.ratedSessions).length, (n) => n === 500);

  load({ reports: [] });
  for (let i = 0; i < 201; i++) db.addReport({ id: 'r' + i, at: new Date(1000 + i).toISOString() });
  check('cycle1 reports-cap-200', db.db.reports.length, (n) => n === 200);

  load({ blocks: { u1: { t1: { at: '2026-01-01T00:00:00.000Z', anonId: 'aabbccdd1122', source: 'chat' } } } });
  check('cycle1 removeBlock-empty-selector', db.removeBlock('u1', '...'), (r) => r === false);

  delete db.save; // restore the real debounced saver for later sections
}


// ---------------------------------------------------------------------------
// MEDIA2. media/attachment patch regressions (fixes 1-9).
// Merged from regression-sections/patch-media2-section.mjs (28 tests); uses the
// suite harness `ok` for accounting (per-test PASS logging dropped per suite
// convention); installs its own globalThis.fetch mock.
// ---------------------------------------------------------------------------
{
    // ---- cycle-2 merge prologue: reproduce the section's standalone isolation ----
  {
      const { rmSync: rmDir } = await import('node:fs');
      const { default: nodePath } = await import('node:path');
      const { paths: cfgPaths } = await import('../src/config.js');
      process.env.DATA_DIR = '/tmp/patchmedia2-data';
      rmDir(process.env.DATA_DIR, { recursive: true, force: true });
      cfgPaths.dataDir = nodePath.resolve(process.env.DATA_DIR);
      cfgPaths.dbFile = nodePath.join(cfgPaths.dataDir, 'db.json');
      cfgPaths.mediaDir = nodePath.join(cfgPaths.dataDir, 'media');
    }
    reset();

    const fs = (await import('node:fs')).default;

  const check = (label, cond) => { ok(cond, `[media2] ${label}`); };
  const B = (a) => Buffer.from(a);
  const S = (s) => Buffer.from(s, 'binary');
  const MB = 1024 * 1024;
  const PNG = Buffer.concat([B([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), S('padding-bytes-here')]);
  const MP4 = S('\x00\x00\x00\x20ftypisom\x00\x00\x00\x00padding');
  const MZ = Buffer.concat([S('MZ'), B([0x90, 0x00, 0x03, 0x00, 0xff, 0xd8]), S('This program cannot be run in DOS mode.')]);
  const dirOf = (u) => `/tmp/patchmedia2-data/media/${u}`;
  const dirFiles = (u) => (fs.existsSync(dirOf(u)) ? fs.readdirSync(dirOf(u)) : []);

  // ---- fetch mock: Discord API + CDN + streaming bodies ----
  const cdn = new Map();
  const cdnDelay = new Map();
  const cdnStream = new Map();
  const apiCalls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('https://discord.com/api')) {
      let body = null;
      try { body = opts.body ? JSON.parse(opts.body) : null; } catch { /* non-JSON */ }
      apiCalls.push({ url: u, body });
      let id = 'api1';
      if (u.includes('/users/@me/channels')) id = `DM_${body?.recipient_id || 'x'}`;
      else if (u.includes('/messages')) id = 'msg1';
      const text = JSON.stringify({ id });
      return {
        ok: true, status: 200, json: async () => ({ id }), text: async () => text,
        arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => 'application/json' },
      };
    }
    if (cdnStream.has(u)) {
      return {
        ok: true, status: 200, body: cdnStream.get(u),
        arrayBuffer: async () => { throw new Error('stream only'); },
        headers: { get: () => null },
      };
    }
    const d = cdnDelay.get(u) || 0;
    if (d) await new Promise((r) => setTimeout(r, d));
    const buf = cdn.get(u);
    if (!buf) {
      return {
        ok: false, status: 404, json: async () => ({}), text: async () => 'nf',
        arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => null },
      };
    }
    const slice = () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return {
      ok: true, status: 200, json: async () => ({}), text: async () => '',
      arrayBuffer: async () => slice(), headers: { get: () => null },
    };
  };
  const dmTexts = (uid) => apiCalls
    .filter((c) => c.url.includes(`/channels/DM_${uid}/messages`))
    .map((c) => JSON.stringify(c.body)).join('\n');

  const EXP = '/home/hatch/workspace/anon-chat-remake-experimental';
  const media = await import(`${EXP}/src/utils/media.js`);
  const { sniffCategory } = await import(`${EXP}/src/services/attachments.js`);
  const embeds = await import(`${EXP}/src/utils/embeds.js`);
  const { db } = await import(`${EXP}/src/services/database.js`);
  const chat = await import(`${EXP}/src/services/chat.js`);
  const ob = await import(`${EXP}/src/flows/onboarding.js`);

  // ---------- fix 1: profile-media path sniffs bytes ----------
  cdn.set('https://cdn/x/f1-evil.mp4', MZ);
  let r = await media.downloadProfileMedia('F1A', ['e1'],
    { e1: { filename: 'photo.mp4', content_type: 'video/mp4', size: 1024, url: 'https://cdn/x/f1-evil.mp4' } }, 20 * MB);
  check('fix1: MZ binary served as photo.mp4/video-mp4 is rejected', !r.ok && /real photo or video/.test(r.error || ''));
  check('fix1: rejected MZ leaves nothing on disk', dirFiles('F1A').length === 0);
  cdn.set('https://cdn/x/f1-evil2.mp4', MZ);
  r = await media.downloadProfileMedia('F1B', ['e1'],
    { e1: { filename: 'clip.mp4.exe', content_type: 'video/mp4', size: 10, url: 'https://cdn/x/f1-evil2.mp4' } }, 20 * MB);
  check('fix1: clip.mp4.exe served as video/mp4 is rejected', !r.ok);
  cdn.set('https://cdn/x/f1-real.png', PNG);
  r = await media.downloadProfileMedia('F1C', ['p1'],
    { p1: { filename: 'p.png', content_type: 'image/png', size: 100, url: 'https://cdn/x/f1-real.png' } }, 20 * MB);
  check('fix1: real PNG accepted', r.ok === true && r.media.length === 1);
  cdn.set('https://cdn/x/f1-real.mp4', MP4);
  r = await media.downloadProfileMedia('F1D', ['v1'],
    { v1: { filename: 'v.mp4', content_type: 'video/mp4', size: 100, url: 'https://cdn/x/f1-real.mp4' } }, 20 * MB);
  check('fix1: real MP4 accepted', r.ok === true && r.media.length === 1);

  // ---------- fix 3: 20MB cap is absolute ----------
  cdn.set('https://cdn/x/f3-big.png', PNG);
  r = await media.downloadProfileMedia('F3A', ['b1'],
    { b1: { filename: 'big.png', content_type: 'image/png', size: 25 * MB, url: 'https://cdn/x/f3-big.png' } }, 100 * MB);
  check('fix3: Nitro-style 100MB declared limit cannot exceed the 20MB cap', !r.ok && /max 20 MB/.test(r.error || ''));
  const huge = Buffer.alloc(25 * MB, 0x41);
  PNG.copy(huge, 0);
  cdn.set('https://cdn/x/f3-huge.png', huge);
  r = await media.downloadProfileMedia('F3B', ['h1'],
    { h1: { filename: 'h.png', content_type: 'image/png', size: 100, url: 'https://cdn/x/f3-huge.png' } }, 20 * MB);
  check('fix3: oversized body aborted despite small declared size', !r.ok && /too big/.test(r.error || ''));
  const mkStream = (chunks) => {
    let i = 0;
    return {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
        cancel: async () => {},
      }),
    };
  };
  cdnStream.set('https://cdn/x/f3-stream-big.png', mkStream([PNG, Buffer.alloc(11 * MB), Buffer.alloc(11 * MB)]));
  r = await media.downloadProfileMedia('F3C', ['s1'],
    { s1: { filename: 's.png', content_type: 'image/png', size: 100, url: 'https://cdn/x/f3-stream-big.png' } }, 20 * MB);
  check('fix3: streaming read aborts past 20MB', !r.ok && /too big/.test(r.error || ''));
  cdnStream.set('https://cdn/x/f3-stream-ok.png', mkStream([PNG, Buffer.alloc(1024)]));
  r = await media.downloadProfileMedia('F3D', ['s1'],
    { s1: { filename: 's.png', content_type: 'image/png', size: 100, url: 'https://cdn/x/f3-stream-ok.png' } }, 20 * MB);
  check('fix3: streaming read under the cap is accepted', r.ok === true);

  // ---------- fix 9: filenames escaped in cards ----------
  const evilName = 'a`b\nc**d.png';
  const blockedText = JSON.stringify(embeds.attachmentBlockedCard([evilName], []));
  check('fix9: backticks/asterisks escaped in attachmentBlockedCard',
    blockedText.includes('a\\\\`b') && blockedText.includes('\\\\*\\\\*') && !blockedText.includes('`a`b`'));
  r = await media.downloadProfileMedia('F9', ['z1'],
    { z1: { filename: evilName, content_type: 'image/png', size: 25 * MB, url: 'https://cdn/x/f9.png' } }, 20 * MB);
  check('fix9: media error message escapes the filename', !r.ok && r.error.includes('a\\`b'));

  // ---------- fix 2: failed re-upload preserves live gallery ----------
  media.clearProfileMedia('F2U');
  cdn.set('https://cdn/x/f2-old.png', PNG);
  r = await media.downloadProfileMedia('F2U', ['o1'],
    { o1: { filename: 'old.png', content_type: 'image/png', size: 100, url: 'https://cdn/x/f2-old.png' } }, 20 * MB);
  check('fix2: seed upload ok', r.ok === true);
  cdn.set('https://cdn/x/f2-new.png', PNG);
  r = await media.downloadProfileMedia('F2U', ['n1', 'n2'], {
    n1: { filename: 'new.png', content_type: 'image/png', size: 100, url: 'https://cdn/x/f2-new.png' },
    n2: { filename: 'gone.png', content_type: 'image/png', size: 100, url: 'https://cdn/x/f2-missing.png' },
  }, 20 * MB);
  const f2files = dirFiles('F2U');
  check('fix2: mid-loop failure returns ok:false', r.ok === false);
  check('fix2: live gallery file survives the failed re-upload', f2files.length === 1 && f2files[0].includes('o1'));
  check('fix2: failed re-upload leaves no partial files', !f2files.some((f) => f.includes('n1')));

  // ---------- fix 7: MZ text false positive ----------
  check('fix7: ASCII note starting "MZR-12" is not rejected', sniffCategory(S('MZR-12 inspection report, all clear')) === 'note');
  check('fix7: real PE binary (non-text bytes) still blocked', sniffCategory(MZ) === null);
  check('fix7: ELF still blocked', sniffCategory(B([0x7f, 0x45, 0x4c, 0x46, 0x90, 0x00])) === null);
  check('fix7: ASCII-only MZ stub sniffs as note (documented residual)', sniffCategory(S(`MZ${'A'.repeat(1000)}`)) === 'note');

  // ---------- onboarding helpers (fixes 5, 6) ----------
  const btn = (uid, custom_id) => ({ type: 3, id: 'i1', token: 't1', user: { id: uid, username: 'u' }, data: { custom_id } });
  const modal = (uid, custom_id, comps, resolved) => ({
    type: 5, id: 'i2', token: 't2', user: { id: uid, username: 'u' },
    data: { custom_id, components: comps, resolved: resolved ? { attachments: resolved } : {} },
  });
  const t4 = (cid, value) => ({ type: 4, custom_id: cid, value });
  const fu = (cid, values) => ({ type: 19, custom_id: cid, values });
  const onboardToMedia = async (U) => {
    await ob.handleInteraction(modal(U, 'onboard_m1', [
      t4('onboard_name', 'Zed'), t4('onboard_dob_day', '02'), t4('onboard_dob_month', '02'), t4('onboard_dob_year', '1999')]));
    await ob.handleInteraction(modal(U, 'onboard_m2', [t4('onboard_location', ''), t4('onboard_bio', '')]));
  };

  // fix 5: stale skip orphans files
  await onboardToMedia('S5');
  cdn.set('https://cdn/x/s5.png', PNG);
  await ob.handleInteraction(modal('S5', 'onboard_m3', [fu('onboard_media', ['s1'])],
    { s1: { filename: 's.png', content_type: 'image/png', size: 50, url: 'https://cdn/x/s5.png' } }));
  check('fix5: upload landed before skip', dirFiles('S5').length === 1);
  await ob.handleInteraction(btn('S5', 'onboard_skip_media'));
  const d5 = db.getOnboardDraft('S5');
  check('fix5: skip clears draft media', d5?.data.media.length === 0);
  check('fix5: skip leaves no orphan files on disk', dirFiles('S5').length === 0);

  // fix 6: concurrent double media-modal submit
  await onboardToMedia('S6');
  cdn.set('https://cdn/x/s6a.png', PNG);
  cdnDelay.set('https://cdn/x/s6a.png', 60);
  cdn.set('https://cdn/x/s6b.png', PNG);
  await Promise.all([
    ob.handleInteraction(modal('S6', 'onboard_m3', [fu('onboard_media', ['a1'])],
      { a1: { filename: 's6a.png', content_type: 'image/png', size: 10, url: 'https://cdn/x/s6a.png' } })),
    ob.handleInteraction(modal('S6', 'onboard_m3', [fu('onboard_media', ['b1'])],
      { b1: { filename: 's6b.png', content_type: 'image/png', size: 10, url: 'https://cdn/x/s6b.png' } })),
  ]);
  const d6 = db.getOnboardDraft('S6');
  const f6 = dirFiles('S6');
  check('fix6: exactly one of the concurrent submits won', d6?.data.media.length === 1 && f6.length === 1);
  check('fix6: every file on disk is referenced by the draft (no orphans)',
    f6.every((f) => (d6?.data.media || []).some((m) => m.file === f)));

  // ---------- fix 4: oversized relay file gets an honesty notice ----------
  db.createChatSession('R1', 'R2');
  cdn.set('https://cdn/x/big.mp4', PNG);
  await chat.handleDirectMessage({
    author: { id: 'R1', bot: false }, id: 'm1', channel_id: 'DM_R1', type: 0,
    content: 'hey there',
    attachments: [{ filename: 'big.mp4', content_type: 'video/mp4', size: 25 * MB, url: 'https://cdn/x/big.mp4' }],
  });
  check('fix4: partner still receives the text', dmTexts('R2').includes('hey there'));
  check('fix4: sender is told the file was too big', /too big/.test(dmTexts('R1')));

  // ---------- fix 8: corrupt file gets the unreadable copy, not the blocked copy ----------
  db.createChatSession('R3', 'R4');
  cdn.set('https://cdn/x/corrupt.png', B([0x89, 0x50, 0x4e, 0x47]));
  await chat.handleDirectMessage({
    author: { id: 'R3', bot: false }, id: 'm2', channel_id: 'DM_R3', type: 0,
    content: '',
    attachments: [{ filename: 'corrupt.png', content_type: 'image/png', size: 4, url: 'https://cdn/x/corrupt.png' }],
  });
  const r3dm = dmTexts('R3');
  check('fix8: corrupt PNG gets the unreadable-file card', /couldn.t read that file/.test(r3dm) && /corrupt/.test(r3dm));
  check('fix8: corrupt PNG does NOT get the file-type-blocked card', !/file type is blocked/.test(r3dm));
}


// ---------------------------------------------------------------------------
// CMD2. command/db-bound patch regressions (block/profile/report/rating/queue).
// Merged from regression-sections/patch-commands2-section.mjs (13 tests); uses
// the suite harness `ok` for accounting; installs its own globalThis.fetch mock.
// ---------------------------------------------------------------------------
{
    // ---- cycle-2 merge prologue: reproduce the section's standalone isolation ----
  {
      const { rmSync: rmDir } = await import('node:fs');
      const { default: nodePath } = await import('node:path');
      const { paths: cfgPaths } = await import('../src/config.js');
      process.env.DATA_DIR = '/tmp/patch-commands2-db';
      rmDir(process.env.DATA_DIR, { recursive: true, force: true });
      cfgPaths.dataDir = nodePath.resolve(process.env.DATA_DIR);
      cfgPaths.dbFile = nodePath.join(cfgPaths.dataDir, 'db.json');
      cfgPaths.mediaDir = nodePath.join(cfgPaths.dataDir, 'media');
    }
    reset();


  const { rmSync, mkdirSync } = await import('node:fs');
  rmSync('/tmp/patch-commands2-db', { recursive: true, force: true });
  mkdirSync('/tmp/patch-commands2-db', { recursive: true });

  // ---------------------------------------------------------------------------
  // fetch mock
  // ---------------------------------------------------------------------------
  const sent = []; // captured Discord API traffic { kind, url?, body }
  let msgSeq = 0;
  let failCallbackOnce = false; // next /interactions/.../callback POST throws
  const json = (o, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    let body = null;
    try { body = opts.body ? JSON.parse(opts.body) : null; } catch { /* ignore */ }
    if (u.includes('/interactions/') && u.endsWith('/callback')) {
      if (failCallbackOnce) {
        failCallbackOnce = false;
        throw new Error('simulated callback transport failure');
      }
      sent.push({ kind: 'callback', body });
      return json({ id: 'cb' });
    }
    if (u.endsWith('/users/@me/channels') && method === 'POST') {
      sent.push({ kind: 'dm-create', body });
      return json({ id: `dm_${body?.recipient_id || 'x'}` });
    }
    if (/\/channels\/[^/]+\/messages$/.test(u) && method === 'POST') {
      sent.push({ kind: 'dm-send', url: u, body });
      return json({ id: `msg_${++msgSeq}` });
    }
    if (u.includes('/webhooks/') && method === 'POST' && !/\/messages\//.test(u)) {
      sent.push({ kind: 'followup', url: u, body });
      return json({ id: `msg_${++msgSeq}` });
    }
    if (/\/messages\//.test(u) && (method === 'PATCH' || method === 'POST')) {
      sent.push({ kind: 'edit', url: u, body });
      return json({ id: 'edited' });
    }
    return json({});
  };

  // ---------------------------------------------------------------------------
  // dynamic imports (after env + fetch mock)
  // ---------------------------------------------------------------------------
  const ROOT = '/home/hatch/workspace/anon-chat-remake-experimental/src';
  const { db } = await import(`${ROOT}/services/database.js`);
  const { safety } = await import(`${ROOT}/services/safety.js`);
  const { matchmaking } = await import(`${ROOT}/services/matchmaking.js`);
  const chat = await import(`${ROOT}/services/chat.js`);
  const block = await import(`${ROOT}/commands/block.js`);
  const profile = await import(`${ROOT}/commands/profile.js`);
  const report = await import(`${ROOT}/commands/report.js`);
  const unblock = await import(`${ROOT}/commands/unblock.js`);
  const blocklist = await import(`${ROOT}/commands/blocklist.js`);

  db._resetForTests();

  // ---------------------------------------------------------------------------
  // suite helpers
  // ---------------------------------------------------------------------------
  async function check(name, fn) {
    try { await fn(); ok(true, `[commands2] ${name}`); }
    catch (e) { ok(false, `[commands2] ${name}: ${e.message}`); }
  }
  function assert(cond, msg) { if (!cond) throw new Error(msg); }

  /** Collect all textDisplay content strings from a V2 component tree. */
  function v2text(components) {
    const out = [];
    const walk = (c) => {
      if (!c || typeof c !== 'object') return;
      if (typeof c.content === 'string') out.push(c.content);
      (c.components || []).forEach(walk);
      if (c.component) walk(c.component);
    };
    (components || []).forEach(walk);
    return out.join('\n');
  }
  const lastCallback = () => [...sent].reverse().find((s) => s.kind === 'callback');
  const lastFollowup = () => [...sent].reverse().find((s) => s.kind === 'followup');
  const cbEmbed = (n = 0) => lastCallback()?.body?.data?.embeds?.[n] || {};

  const ADULT_DOB = '2000-06-15';
  const mkProfile = (id) => db.createProfile({ id, name: `N${id}`, dob: ADULT_DOB });
  const cmdIx = (uid, n) => ({
    type: 2, id: `int${n}`, token: `tok${n}`,
    user: { id: uid, username: `u${uid}` }, data: { name: 'x' },
  });
  const compIx = (uid, customId, n, dataExtra = {}) => ({
    type: 3, id: `cint${n}`, token: `ctok${n}`,
    user: { id: uid, username: `u${uid}` },
    data: { custom_id: customId, ...dataExtra },
  });

  // ---------------------------------------------------------------------------
  // 1. /block: reply failure must not leave the chat live (ordering bug)
  // ---------------------------------------------------------------------------
  await check('1 block: forced reply failure still concludes session + records block', async () => {
    const a = 'p1a', b = 'p1b';
    mkProfile(a); mkProfile(b);
    db.createChatSession(a, b);
    failCallbackOnce = true;
    let threw = false;
    try { await block.execute(cmdIx(a, 11)); } catch { threw = true; }
    assert(db.isBlockedBetween(a, b), 'block was not recorded');
    assert(
      db.getActiveSessionForUser(a) === null,
      `session still live after /block (reply threw=${threw}); blocked pair keeps relaying`,
    );
  });

  // ---------------------------------------------------------------------------
  // 2. /profile lock notice: remedy branches on the lock reason
  // ---------------------------------------------------------------------------
  await check('2 profile: in-chat lock notice suggests /end', async () => {
    const a = 'p2a', b = 'p2b';
    mkProfile(a); mkProfile(b);
    const s = db.createChatSession(a, b);
    sent.length = 0;
    await profile.handleInteraction(compIx(a, 'profile_edit_name', 21));
    const desc = cbEmbed().description || '';
    assert(desc.includes('`/end`'), `in-chat notice suggests the wrong remedy: ${desc}`);
    db.endChatSession(s.session_id);
  });
  await check('2 profile: in-queue lock notice still suggests /leave', async () => {
    const q = 'p2q';
    mkProfile(q);
    matchmaking.addToQueue(q, db.getAnonId(q));
    sent.length = 0;
    await profile.handleInteraction(compIx(q, 'profile_edit_name', 22));
    const desc = cbEmbed().description || '';
    assert(desc.includes('`/leave`'), `in-queue notice lost its remedy: ${desc}`);
    matchmaking.removeFromQueue(q);
  });

  // ---------------------------------------------------------------------------
  // 4. /report: empty/whitespace-only fields rejected before createReport
  // ---------------------------------------------------------------------------
  const modalIx = (uid, target, reason, desc, n) => ({
    type: 5, id: `mint${n}`, token: `mtok${n}`,
    user: { id: uid, username: 'r' },
    data: {
      custom_id: `report_modal:${target}`,
      components: [{ type: 1, components: [
        { type: 4, custom_id: 'report_reason', value: reason },
        { type: 4, custom_id: 'report_description', value: desc },
      ] }],
    },
  });
  await check('4 report: empty/whitespace fields rejected before createReport', async () => {
    const before = db.db.reports.length;
    sent.length = 0;
    await report.handleInteraction(modalIx('p4r', 'p4t', '', '   ', 41));
    const emb = cbEmbed();
    assert(db.db.reports.length === before, 'crafted empty report was filed');
    assert(/say what happened/i.test(emb.description || ''), `error embed lacks guidance: ${emb.description}`);
  });
  await check('4 report: valid report still files', async () => {
    const before = db.db.reports.length;
    sent.length = 0;
    await report.handleInteraction(modalIx('p4r', 'p4t', 'spam', 'they spammed links', 42));
    assert(db.db.reports.length === before + 1, 'valid report was not filed');
    assert(cbEmbed().title === 'Report Filed', `expected Report Filed, got: ${cbEmbed().title}`);
  });

  // ---------------------------------------------------------------------------
  // 5. rating copy on evicted sessions
  // ---------------------------------------------------------------------------
  await check('5 rating: evicted session says "too old to rate"', async () => {
    sent.length = 0;
    await chat.handleRate(compIx('p5r', 'rate_like:sess_evicted_9', 51), 'like');
    const text = v2text(lastFollowup()?.body?.components);
    assert(/too old to rate/i.test(text), `unexpected rating copy: ${text}`);
  });

  // ---------------------------------------------------------------------------
  // 6. getEligiblePool excludes blocked waiters
  // ---------------------------------------------------------------------------
  await check('6 matchmaking: getEligiblePool excludes blocked waiters', async () => {
    const a = 'p6a', b = 'p6b';
    mkProfile(a); mkProfile(b);
    matchmaking.addToQueue(a, db.getAnonId(a));
    matchmaking.addToQueue(b, db.getAnonId(b));
    db.blockUser(a, b, { source: 'chat' });
    const pool = matchmaking.getEligiblePool(a).map((e) => e.userId);
    const stats = matchmaking.getEligibleQueueStats(a);
    assert(!pool.includes(b), `blocked waiter ${b} still counted in eligible pool`);
    assert(stats && stats.size === 1, `eligible pool size ${stats?.size}, expected 1 (phantom slot)`);
    matchmaking.removeFromQueue(a);
    matchmaking.removeFromQueue(b);
  });

  // ---------------------------------------------------------------------------
  // 7a. banUser evicts the banned user from the matchmaking queue
  // ---------------------------------------------------------------------------
  await check('7a ban: banned user leaves the matchmaking queue immediately', async () => {
    const u = 'p7u';
    mkProfile(u);
    matchmaking.addToQueue(u, db.getAnonId(u));
    assert(matchmaking.getQueuePosition(u) === 1, 'setup: user not queued');
    db.banUser(u, 'test ban');
    assert(matchmaking.getQueuePosition(u) === null, 'banned user still visible in queue/eligible pools');
    assert(db.isBanned(u), 'ban itself was not recorded');
    db.unbanUser(u);
  });

  // ---------------------------------------------------------------------------
  // 7b. bounded growth: dms cap, draft expiry, per-user block cap
  // ---------------------------------------------------------------------------
  await check('7b db: dms cache capped at 1000, oldest-first', async () => {
    for (let i = 0; i < 1005; i++) db.db.dms[`dmuser${i}`] = `chan${i}`;
    db.save(); // prune runs on save()
    const n = Object.keys(db.db.dms).length;
    assert(n <= 1000, `dms cache holds ${n} entries (unbounded)`);
    assert(!('dmuser0' in db.db.dms), 'oldest dms entry was not evicted first');
    db.db.dms = {};
  });
  await check('7b db: onboard drafts stamped and expired after 7d idle', async () => {
    const d = db.saveOnboardDraft('du1', { step: 1, data: {} });
    assert(d && typeof d.touchedAt === 'number', 'fresh draft carries no touch timestamp');
    db.clearOnboardDraft('du1');
    const staleAt = Date.now() - 8 * 864e5;
    db.db.onboard_drafts['du2'] = { step: 2, data: {}, touchedAt: staleAt };
    assert(db.getOnboardDraft('du2') === null, 'stale draft still returned on read');
    assert(!('du2' in db.db.onboard_drafts), 'stale draft not dropped on read');
    db.db.onboard_drafts['du3'] = { step: 1, data: {}, touchedAt: staleAt };
    db.db.onboard_drafts['du4'] = { step: 1, data: {}, touchedAt: Date.now() };
    await db.flush();
    db.load();
    assert(!('du3' in db.db.onboard_drafts), 'stale draft survived load()');
    assert('du4' in db.db.onboard_drafts, 'fresh draft wrongly expired on load()');
    db.clearOnboardDraft('du4');
  });
  await check('7b db: per-user block list capped at 200, oldest-first', async () => {
    for (let i = 0; i < 205; i++) db.blockUser('p8bu', `p8t${i}`, { source: 'chat' });
    const ids = Object.keys(db.db.blocks['p8bu'] || {});
    assert(ids.length === 200, `block list holds ${ids.length} entries (unbounded)`);
    assert(!ids.includes('p8t0'), 'oldest block was not evicted first');
    assert(ids.includes('p8t204'), 'newest block missing after eviction');
  });

  // ---------------------------------------------------------------------------
  // 8. removeBlock 'ambiguous': both callers ask for more characters
  // ---------------------------------------------------------------------------
  const seedAmbiguous = () => {
    const iso = new Date().toISOString();
    db.db.blocks['p9u'] = {
      k1: { at: iso, anonId: 'abcdef1200000000', source: 'chat' },
      k2: { at: iso, anonId: 'abcdef12ffffffff', source: 'chat' },
    };
    assert(db.removeBlock('p9u', 'abcdef12') === 'ambiguous', 'setup: expected ambiguous test fixture');
    seedAmbiguous.blocks = 2;
  };
  await check('8 unblock: ambiguous prefix asks for more characters, deletes nothing', async () => {
    seedAmbiguous();
    sent.length = 0;
    await unblock.execute({
      type: 2, id: 'uix1', token: 'utok1',
      user: { id: 'p9u', username: 'x' },
      data: { name: 'unblock', options: [{ name: 'anonymous_id', type: 3, value: 'abcdef12' }] },
    });
    const text = v2text(lastCallback()?.body?.data?.components);
    assert(/more characters/i.test(text), `ambiguous unblock showed success card instead: ${text}`);
    assert(Object.keys(db.db.blocks['p9u']).length === 2, 'ambiguous unblock deleted a block');
  });
  await check('8 blocklist: ambiguous select asks for more characters, deletes nothing', async () => {
    seedAmbiguous();
    sent.length = 0;
    await blocklist.handleInteraction(compIx('p9u', 'unblock_select:1', 61, { values: ['abcdef12'] }));
    const text = v2text(lastFollowup()?.body?.components);
    assert(/more characters/i.test(text), `ambiguous select showed success card instead: ${text}`);
    assert(Object.keys(db.db.blocks['p9u']).length === 2, 'ambiguous select deleted a block');
  });
}


// ---------------------------------------------------------------------------
// SHARE2. /share race/cap/cooldown regressions + B1 /end duplicate-defer.
// Merged from regression-sections/patch-share2-section.mjs (17 tests); the
// section-local reset() is renamed to resetS2 so the merge prologue can use
// the suite harness reset; installs its own globalThis.fetch mock.
// ---------------------------------------------------------------------------
{
    // ---- cycle-2 merge prologue: reproduce the section's standalone isolation ----
  {
      const { rmSync: rmDir } = await import('node:fs');
      const { default: nodePath } = await import('node:path');
      const { paths: cfgPaths } = await import('../src/config.js');
      process.env.DATA_DIR = '/tmp/patch-share2-data';
      rmDir(process.env.DATA_DIR, { recursive: true, force: true });
      cfgPaths.dataDir = nodePath.resolve(process.env.DATA_DIR);
      cfgPaths.dbFile = nodePath.join(cfgPaths.dataDir, 'db.json');
      cfgPaths.mediaDir = nodePath.join(cfgPaths.dataDir, 'media');
    }
    reset();


  const { rmSync } = await import('node:fs');
  rmSync('/tmp/patch-share2-data', { recursive: true, force: true });

  // ---- fetch mock -----------------------------------------------------------
  const sent = [];
  let msgSeq = 0;
  const failDMFor = new Set();
  let hangDMPost = false;
  let hangDMOnce = false;
  let hangCallbackWith = null;
  const dmWaiters = [];
  const cbWaiters = [];
  const isDMPost = (u, m) => m === 'POST' && /\/channels\/dm_[A-Za-z0-9_]+\/messages$/.test(u);
  const json = (o, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

  globalThis.__releaseDM = (fail = false) => { for (const w of dmWaiters.splice(0)) w(fail); };
  globalThis.__releaseCB = () => { for (const w of cbWaiters.splice(0)) w(); };

  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('https://discord.com/api/v10')) {
      const method = (opts.method || 'GET').toUpperCase();
      let body = null;
      const b = opts.body;
      if (typeof b === 'string') { try { body = JSON.parse(b); } catch {} }
      sent.push({ url: u, method, body });
      if (hangCallbackWith && u.includes('/interactions/') && u.endsWith('/callback')
          && JSON.stringify(body || {}).includes(hangCallbackWith)) {
        await new Promise((res) => cbWaiters.push(res));
      }
      if ((hangDMPost || hangDMOnce) && isDMPost(u, method)) {
        if (hangDMOnce) hangDMOnce = false;
        const fail = await new Promise((res) => dmWaiters.push(res));
        if (fail) return json({ message: 'Cannot send messages to this user', code: 50007 }, 403);
      }
      if (u.endsWith('/users/@me/channels') && method === 'POST')
        return json({ id: `dm_${body?.recipient_id}` });
      const um = u.match(/\/users\/([A-Za-z0-9_]+)$/);
      if (um && method === 'GET') return json({ id: um[1], username: `user_${um[1]}`, global_name: null });
      if (method === 'POST') {
        const cm = u.match(/\/channels\/dm_([A-Za-z0-9_]+)\/messages$/);
        if (cm && failDMFor.has(cm[1]))
          return json({ message: 'Cannot send messages to this user', code: 50007 }, 403);
      }
      return json({ id: `msg${++msgSeq}` });
    }
    return new Response(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
      { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  };

  // ---- dynamic imports (tree modules only) -----------------------------------
  const { db } = await import('/home/hatch/workspace/anon-chat-remake-experimental/src/services/database.js');
  const { matchmaking } = await import('/home/hatch/workspace/anon-chat-remake-experimental/src/services/matchmaking.js');
  const chat = await import('/home/hatch/workspace/anon-chat-remake-experimental/src/services/chat.js');
  const newCmd = await import('/home/hatch/workspace/anon-chat-remake-experimental/src/commands/new.js');
  const endCmd = await import('/home/hatch/workspace/anon-chat-remake-experimental/src/commands/end.js');
  const shareCmd = await import('/home/hatch/workspace/anon-chat-remake-experimental/src/commands/share.js');

  // ---- helpers ---------------------------------------------------------------
  const str = (o) => JSON.stringify(o);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const user = (id) => ({ id: String(id), username: `user_${id}`, global_name: null });
  const cmdIx = (name, uid) => ({ id: 'ix', token: 'tok', type: 2, user: user(uid), data: { name } });
  const btnIx = (customId, uid, { channelId = 'dm_x', messageId = 'm1' } = {}) => ({
    id: 'ix', token: 'tok', type: 3, user: user(uid), channel_id: channelId,
    data: { custom_id: customId }, message: { id: messageId, flags: 0 },
  });
  const resetS2 = () => {
    db._resetForTests(); matchmaking._resetForTests(); chat._resetRelayForTests();
    chat._resetModForTests(); chat._resetFizzleForTests?.();
    failDMFor.clear(); sent.length = 0; hangDMPost = false; hangDMOnce = false; hangCallbackWith = null;
  };
  const dobForAge = (age) => { const n = new Date(); return new Date(Date.UTC(n.getUTCFullYear()-age, n.getUTCMonth(), n.getUTCDate())).toISOString().slice(0,10); };
  const onboarded = (id) => db.createProfile({ id: String(id), name: `user_${id}`, dob: dobForAge(20), interests: [] });
  // NOTE: builds sessions directly instead of via /new, so this section stays
  // independent of matchmaking.js (concurrently edited by another agent).
  async function matchPair(a, b) { onboarded(a); onboarded(b); db.createChatSession(a, b); sent.length = 0; }
  const cbData = () => { const c = [...sent].reverse().find((s) => s.url.includes('/interactions/')); return c?.body; };
  const lastEditOriginal = () => { const e = [...sent].reverse().find((s) => s.url.includes('/webhooks/') && s.method === 'PATCH'); return e?.body; };
  const dmPosts = (uid) => sent.filter((s) => s.url.includes(`/channels/dm_${uid}/messages`) && s.method === 'POST');
  const ageCooldowns = (sid) => { for (const u of ['A','B']) { const k = `${sid}:${u}`; db.db.shares[k] = db.db.shares[k] || {count:0,last_share:0}; db.db.shares[k].last_share = Date.now()-61_000; } };
  const swapCount = (sid) => { const r = db.db.shares[`${sid}:swaps`]; return r?.count || 0; };
  const acceptIx = (sid, uid) => btnIx(`share_accept:${sid}`, uid, { channelId: `dm_${uid}`, messageId: 'r1' });

  const check = (name, cond, detail) => { ok(cond, `[share2] [${name}] ${detail}`); };

  // === S2-R1: cap bypass — raced /share in the DM window is rejected, count stays 2 ===
  {
    resetS2(); await matchPair('A', 'B');
    const sid = db.getActiveSessionForUser('A').session_id;
    await shareCmd.execute(cmdIx('share', 'A'));
    await shareCmd.handleInteraction(acceptIx(sid, 'B'));
    ageCooldowns(sid); sent.length = 0;
    await shareCmd.execute(cmdIx('share', 'A'));
    hangDMPost = true;
    const acceptP = shareCmd.handleInteraction(acceptIx(sid, 'B'));
    await sleep(50);
    const raceShare = shareCmd.execute(cmdIx('share', 'B'));
    await sleep(50);
    globalThis.__releaseDM(false);
    await acceptP; await raceShare; sent.length = 0;
    hangDMPost = false;
    const noRacedPending = db.getActiveSessionForUser('A')?.shareRequest == null;
    const c = swapCount(sid);
    check('S2-R1', noRacedPending && c === 2, `raced request rejected=${noRacedPending}, count=${c}`);
  }

  // === S2-R1b: share_accept entry checks the cap ===
  {
    resetS2(); await matchPair('A', 'B');
    const sid = db.getActiveSessionForUser('A').session_id;
    await shareCmd.execute(cmdIx('share', 'A'));
    await shareCmd.handleInteraction(acceptIx(sid, 'B'));
    ageCooldowns(sid);
    await shareCmd.execute(cmdIx('share', 'A'));
    db.db.shares[`${sid}:swaps`].count = 2; // simulate a raced reservation
    sent.length = 0;
    await shareCmd.handleInteraction(acceptIx(sid, 'B'));
    const told = str(cbData()).includes('2 identity swaps');
    check('S2-R1b', swapCount(sid) === 2 && told, `count=${swapCount(sid)}, accepter told=${told}`);
  }

  // === S2-R1c: share_accept entry checks the accepter cooldown ===
  {
    resetS2(); await matchPair('A', 'B');
    const sid = db.getActiveSessionForUser('A').session_id;
    await shareCmd.execute(cmdIx('share', 'A'));
    await shareCmd.handleInteraction(acceptIx(sid, 'B'));
    db.db.shares[`${sid}:A`].last_share = Date.now() - 61_000; // age only A
    sent.length = 0;
    await shareCmd.execute(cmdIx('share', 'A'));
    await shareCmd.handleInteraction(acceptIx(sid, 'B'));
    const told = str(cbData()).includes('Please wait');
    check('S2-R1c', swapCount(sid) === 1 && told, `count=${swapCount(sid)}, throttled=${told}`);
  }

  // === S2-R2: mutual path on a dead session does not swap ===
  {
    resetS2(); await matchPair('A', 'B');
    await shareCmd.execute(cmdIx('share', 'A'));
    const sid = db.getActiveSessionForUser('A').session_id;
    hangCallbackWith = 'already asked';
    const bShare = shareCmd.execute(cmdIx('share', 'B'));
    await sleep(50);
    await endCmd.execute(cmdIx('end', 'A'));
    hangCallbackWith = null; globalThis.__releaseCB();
    sent.length = 0;
    await bShare;
    const cards = dmPosts('A').length + dmPosts('B').length;
    const ended = str(lastEditOriginal() || '').includes('already ended');
    check('S2-R2', swapCount(sid) === 0 && cards === 0 && ended,
      `count=${swapCount(sid)}, reveal DMs=${cards}, told ended=${ended}`);
    hangCallbackWith = null;
  }

  // === S2-R3: mutual path enforces the decline cooldown ===
  {
    resetS2(); await matchPair('A', 'B');
    const sid = db.getActiveSessionForUser('A').session_id;
    await shareCmd.execute(cmdIx('share', 'A'));
    await shareCmd.handleInteraction(btnIx(`share_decline:${sid}`, 'B', { channelId: 'dm_B', messageId: 'r1' }));
    await shareCmd.execute(cmdIx('share', 'B'));
    sent.length = 0;
    await shareCmd.execute(cmdIx('share', 'A'));
    const slow = str(lastEditOriginal() || '').includes('Please wait');
    check('S2-R3', swapCount(sid) === 0 && slow, `count=${swapCount(sid)}, throttled=${slow}`);
  }

  // === S2-R4: no false failure card when mutual path won the race ===
  {
    resetS2(); await matchPair('A', 'B');
    const sid = db.getActiveSessionForUser('A').session_id;
    hangDMOnce = true;
    const reqP = shareCmd.execute(cmdIx('share', 'A'));
    await sleep(50);
    await shareCmd.execute(cmdIx('share', 'B'));
    const swapped = swapCount(sid) === 1;
    globalThis.__releaseDM(true);
    await reqP;
    const editTxt = str(lastEditOriginal() || '');
    check('S2-R4', swapped && !editTxt.includes("couldn't reach your partner"),
      `swapped=${swapped}, false failure=${editTxt.includes("couldn't reach your partner")}`);
  }

  // === S2-R5: :swaps record is stamped, survives the >500 eviction ===
  {
    resetS2(); await matchPair('A', 'B');
    const sid = db.getActiveSessionForUser('A').session_id;
    await shareCmd.execute(cmdIx('share', 'A'));
    await shareCmd.handleInteraction(acceptIx(sid, 'B'));
    const stamped = (db.db.shares[`${sid}:swaps`] || {}).last_share > 0;
    // Flood with OLDER entries (as in production, where the swap is the most
    // recent share activity); the stamped :swaps key must not be evicted.
    for (let i = 0; i < 600; i++) db.db.shares[`s_x:u${i}`] = { count: 0, last_share: Date.now() - 3_600_000 };
    db.recordUsernameShare('s_x', 'Z');
    const rec = db.db.shares[`${sid}:swaps`];
    check('S2-R5', stamped && rec && rec.count === 1, `stamped=${stamped}, survives=${!!rec}, count=${rec?.count}`);
  }

  // === S2-R6: failed delivery rolls back cap + cooldowns ===
  {
    resetS2(); await matchPair('A', 'B');
    const sid = db.getActiveSessionForUser('A').session_id;
    await shareCmd.execute(cmdIx('share', 'A'));
    failDMFor.add('B');
    sent.length = 0;
    await shareCmd.handleInteraction(acceptIx(sid, 'B'));
    failDMFor.clear();
    const notice = sent.some((p) => p.url.includes('/channels/dm_B/messages') && str(p.body).includes("couldn't deliver a profile card"));
    const aC = db.getShareData(sid, 'A').last_share > 0;
    const bC = db.getShareData(sid, 'B').last_share > 0;
    check('S2-R6', notice && swapCount(sid) === 0 && !aC && !bC,
      `notice=${notice}, count=${swapCount(sid)}, A throttled=${aC}, B throttled=${bC}`);
  }

  // === S2-R7: expired-token Accept still completes the swap ===
  {
    resetS2(); await matchPair('A', 'B');
    const sid = db.getActiveSessionForUser('A').session_id;
    await shareCmd.execute(cmdIx('share', 'A'));
    sent.length = 0;
    let failNextCallback = true;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      if (failNextCallback && String(url).includes('/interactions/') && String(url).endsWith('/callback')) {
        failNextCallback = false; throw new Error('expired token');
      }
      return origFetch(url, opts);
    };
    let threw = false;
    try { await shareCmd.handleInteraction(acceptIx(sid, 'B')); } catch { threw = true; }
    globalThis.fetch = origFetch;
    const reveals = sent.filter((p) => p.url.includes('/messages') && p.method === 'POST').length;
    check('S2-R7', !threw && swapCount(sid) === 1 && reveals >= 2,
      `threw=${threw}, count=${swapCount(sid)}, reveal DMs=${reveals}`);
  }

  // === S2-R8: Accept racing /end sends no cards and keeps no accounting ===
  {
    resetS2(); await matchPair('A', 'B');
    await shareCmd.execute(cmdIx('share', 'A'));
    const sid = db.getActiveSessionForUser('A').session_id;
    const origFetch = globalThis.fetch;
    let hangDefer = true;
    globalThis.fetch = async (url, opts = {}) => {
      let body = null; try { body = JSON.parse(opts.body); } catch {}
      if (hangDefer && String(url).includes('/interactions/') && body?.type === 6)
        await new Promise((res) => cbWaiters.push(res));
      return origFetch(url, opts);
    };
    const acceptP = shareCmd.handleInteraction(acceptIx(sid, 'B'));
    await sleep(50);
    await endCmd.execute(cmdIx('end', 'A'));
    sent.length = 0;
    hangDefer = false; globalThis.__releaseCB();
    await acceptP;
    globalThis.fetch = origFetch;
    const postEndDMs = dmPosts('A').length + dmPosts('B').length;
    check('S2-R8', postEndDMs === 0 && swapCount(sid) === 0,
      `reveal DMs after end=${postEndDMs}, dead-session swaps=${swapCount(sid)}`);
  }

  // === S2-R9: stale suffixed card is rejected; current-session card works ===
  {
    resetS2(); await matchPair('A', 'B');
    const s1 = db.getActiveSessionForUser('A');
    const sid1 = s1.session_id;
    await shareCmd.execute(cmdIx('share', 'A'));
    await chat.concludeSession(s1, 'manual', 'A');
    await matchPair('A', 'C');
    const sid2 = db.getActiveSessionForUser('A').session_id;
    await shareCmd.execute(cmdIx('share', 'C'));
    sent.length = 0;
    await shareCmd.handleInteraction(btnIx(`share_accept:${sid1}`, 'A', { channelId: 'dm_B', messageId: 'm_old' }));
    const intact = db.getActiveSessionForUser('A')?.shareRequest?.from === 'C';
    const rejected = str(cbData()).includes('earlier chat');
    check('S2-R9', intact && swapCount(sid2) === 0 && rejected,
      `new request intact=${intact}, new-session swaps=${swapCount(sid2)}, rejected=${rejected}`);
    await shareCmd.handleInteraction(btnIx(`share_accept:${sid2}`, 'A', { channelId: 'dm_C', messageId: 'm_new' }));
    check('S2-R9b', swapCount(sid2) === 1, `current-session accept completes, count=${swapCount(sid2)}`);
  }

  // === S2-R10: pending requests expire after 5 minutes ===
  {
    resetS2(); await matchPair('A', 'B');
    const sid = db.getActiveSessionForUser('A').session_id;
    await shareCmd.execute(cmdIx('share', 'A'));
    db.getActiveSessionForUser('A').shareRequest.at = Date.now() - 6 * 60 * 1000;
    sent.length = 0;
    await shareCmd.execute(cmdIx('share', 'A'));
    const s = db.getActiveSessionForUser('A');
    const fresh = s?.shareRequest?.from === 'A' && (Date.now() - s.shareRequest.at) < 60_000;
    const notStuck = !str(cbData()).includes('already sent a request');
    s.shareRequest.at = Date.now() - 6 * 60 * 1000;
    sent.length = 0;
    await shareCmd.handleInteraction(acceptIx(sid, 'B'));
    const noPending = str(cbData()).includes('no pending share request');
    check('S2-R10', fresh && notStuck && noPending,
      `re-request ok=${fresh && notStuck}, expired accept refused=${noPending}`);
  }

  // === S2-Z: cycle-1 behaviors (cap total, both cooldowns, ack-before-DM, TOCTOU) ===
  {
    resetS2(); await matchPair('A', 'B');
    const sid = db.getActiveSessionForUser('A').session_id;
    await shareCmd.execute(cmdIx('share', 'A'));
    await shareCmd.handleInteraction(acceptIx(sid, 'B'));
    ageCooldowns(sid);
    await shareCmd.execute(cmdIx('share', 'A'));
    await shareCmd.handleInteraction(acceptIx(sid, 'B'));
    const c2 = swapCount(sid);
    const aC = db.getShareData(sid, 'A').last_share > 0;
    const bC = db.getShareData(sid, 'B').last_share > 0;
    ageCooldowns(sid); sent.length = 0;
    await shareCmd.execute(cmdIx('share', 'A'));
    const limited = str(cbData()).includes('Share Limit Reached');
    check('S2-Z cap/cooldowns', c2 === 2 && aC && bC && limited,
      `2 swaps=${c2 === 2}, both throttled=${aC && bC}, 3rd rejected=${limited}`);
  }
  {
    resetS2(); await matchPair('A', 'B');
    failDMFor.add('B');
    sent.length = 0;
    await shareCmd.execute(cmdIx('share', 'A'));
    failDMFor.clear();
    const editTxt = str(lastEditOriginal() || '');
    const cleared = db.getActiveSessionForUser('A')?.shareRequest == null;
    check('S2-Z ack-before-DM', editTxt.includes("couldn't reach your partner") && cleared,
      `ack edited=${editTxt.includes("couldn't reach your partner")}, pending cleared=${cleared}`);
  }
  {
    resetS2(); await matchPair('A', 'B');
    const sid = db.getActiveSessionForUser('A').session_id;
    await shareCmd.execute(cmdIx('share', 'A'));
    hangCallbackWith = 'already asked';
    const bShare = shareCmd.execute(cmdIx('share', 'B'));
    await sleep(50);
    await shareCmd.handleInteraction(acceptIx(sid, 'B'));
    hangCallbackWith = null; globalThis.__releaseCB();
    await bShare;
    const handled = str(lastEditOriginal() || '').includes('already handled');
    check('S2-Z TOCTOU', swapCount(sid) === 1 && handled,
      `count=${swapCount(sid)}, stale mutual told already-handled=${handled}`);
    hangCallbackWith = null;
  }

  // === S2-B1: /end losing a conclusion race resolves its deferred response ===
  {
    resetS2();
    const session = db.createChatSession('U1', 'U2');
    hangCallbackWith = '"type":5'; // park /end inside deferPublic
    const endP = endCmd.execute(cmdIx('end', 'U1'));
    await sleep(50);
    const win = await chat.concludeSession(session, 'timeout'); // sweep wins
    hangCallbackWith = null; globalThis.__releaseCB();
    await endP;
    await sleep(20);
    const edited = sent.filter((s) => s.method === 'PATCH'
      && s.url.includes('/webhooks/') && s.url.includes('/messages/@original'));
    const saysEnded = edited.some((e) => str(e.body).includes('just ended'));
    const sessionGone = db.getActiveSessionForUser('U1') === null;
    // The sweep wins the race (its return carries no `duplicate` field); /end
    // loses and must take the duplicate path, which writes the 'just ended'
    // notice — that text only exists on the duplicate path.
    check('S2-B1', sessionGone && edited.length > 0 && saysEnded,
      `session gone=${sessionGone}, @original edits=${edited.length}, notice=${saysEnded}`);
  }
}


// ---------------------------------------------------------------------------
// QUEUE2. queue/matchmaking regressions (T1-T8) + session-lifecycle b-items.
// Merged from regression-sections/patch-queue2-section.mjs (59 tests); the
// section-local ok/reset are dropped/renamed (resetQ2) so accounting flows
// into the suite harness; installs its own globalThis.fetch mock.
// ---------------------------------------------------------------------------
{
    // ---- cycle-2 merge prologue: reproduce the section's standalone isolation ----
  {
      const { rmSync: rmDir } = await import('node:fs');
      const { default: nodePath } = await import('node:path');
      const { paths: cfgPaths } = await import('../src/config.js');
      process.env.DATA_DIR = '/tmp/patch-queue2-data';
      rmDir(process.env.DATA_DIR, { recursive: true, force: true });
      cfgPaths.dataDir = nodePath.resolve(process.env.DATA_DIR);
      cfgPaths.dbFile = nodePath.join(cfgPaths.dataDir, 'db.json');
      cfgPaths.mediaDir = nodePath.join(cfgPaths.dataDir, 'media');
    }
    reset();


  const { rmSync } = await import('node:fs');
  rmSync('/tmp/patch-queue2-data', { recursive: true, force: true });

  // ---------------- fetch mock ----------------
  const API = 'https://discord.com/api/v10';
  const sent = [];
  let msgSeq = 0;
  const hanging = []; // { resolve, reject, url, body }
  const json = (o, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const hooks = {
    hangCallback: null,  // (url, body) => true to hold an interaction callback POST open
    failCallback: false, // next interaction callback POST throws (consumed once)
    failDM: new Map(),   // uid -> { status, body, remaining } (Infinity = persistent)
    onMessagePost: null, // (uid, url, body) => 'hang' | {status, body} | null
    originalFails: false,
  };
  const readBody = (b) => {
    if (typeof b === 'string') { try { return JSON.parse(b); } catch { return null; } }
    if (b && typeof b.get === 'function') { try { return JSON.parse(b.get('payload_json')); } catch { return {}; } }
    return null;
  };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    const body = readBody(opts.body);
    sent.push({ url: u, method, body });
    if (u.startsWith(API + '/interactions/') && u.endsWith('/callback') && method === 'POST') {
      if (hooks.failCallback) { hooks.failCallback = false; throw new Error('simulated callback transport failure'); }
      if (hooks.hangCallback && hooks.hangCallback(u, body)) {
        return new Promise((resolve, reject) => hanging.push({ resolve, reject, url: u, body }));
      }
      return json({});
    }
    if (u === API + '/users/@me/channels' && method === 'POST') return json({ id: `dm_${body?.recipient_id}` });
    const cm = u.match(/\/channels\/(dm_[A-Za-z0-9_]+)\/messages$/);
    if (cm && method === 'POST') {
      const uid = cm[1].slice(3);
      if (hooks.onMessagePost) {
        const v = hooks.onMessagePost(uid, u, body);
        if (v === 'hang') return new Promise((resolve, reject) => hanging.push({ resolve, reject, url: u, body }));
        if (v && typeof v === 'object') return json(v.body, v.status);
      }
      const spec = hooks.failDM.get(uid);
      if (spec && spec.remaining > 0) { spec.remaining--; return json(spec.body, spec.status); }
      return json({ id: `m_${++msgSeq}` });
    }
    if (method === 'PATCH') return json({ id: 'patched' });
    if (method === 'GET' && u.includes('/messages/@original')) {
      return hooks.originalFails ? json({ message: 'x' }, 500) : json({ id: 'orig_1' });
    }
    return json({});
  };
  function releaseHanging(filter = () => true, err = null) {
    for (let i = hanging.length - 1; i >= 0; i--) {
      if (filter(hanging[i])) {
        const h = hanging.splice(i, 1)[0];
        if (err) h.reject(err); else h.resolve(json({ id: `m_${++msgSeq}` }));
      }
    }
  }

  // ---------------- dynamic tree imports ----------------
  const TREE = '/home/hatch/workspace/anon-chat-remake-experimental/src';
  const { db } = await import(`${TREE}/services/database.js`);
  const { matchmaking } = await import(`${TREE}/services/matchmaking.js`);
  const chat = await import(`${TREE}/services/chat.js`);
  const newCmd = await import(`${TREE}/commands/new.js`);
  const endCmd = await import(`${TREE}/commands/end.js`);
  db.load();

  // ---------------- suite helpers ----------------
  const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
  const str = (o) => JSON.stringify(o);
  const resetQ2 = () => {
    db._resetForTests(); matchmaking._resetForTests();
    chat._resetRelayForTests(); chat._resetModForTests(); chat._resetFizzleForTests();
    sent.length = 0; msgSeq = 0; hanging.length = 0;
    hooks.hangCallback = null; hooks.failCallback = false; hooks.failDM.clear();
    hooks.onMessagePost = null; hooks.originalFails = false;
  };
  function dobForAge(age) {
    const n = new Date(); let d = n.getUTCDate(); const m = n.getUTCMonth() + 1;
    if (m === 2 && d === 29) d = 28;
    return `${n.getUTCFullYear() - age}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const onboarded = (id) => db.createProfile({ id: String(id), name: `user_${id}`, dob: dobForAge(20), interests: [] });
  const cmdIx = (name, uid) => ({ id: 'ix', token: 'tok', type: 2, user: { id: String(uid), username: `u${uid}` }, data: { name } });
  const btnIx = (customId, uid, { channelId = 'dm_x', messageId = 'm1', flags = 0 } = {}) => ({
    id: 'ix', token: 'tok', type: 3, user: { id: String(uid), username: `u${uid}` }, channel_id: channelId,
    data: { custom_id: customId }, message: { id: messageId, flags },
  });
  const postsTo = (uid) => sent.filter((s) => s.method === 'POST' && s.url === `${API}/channels/dm_${uid}/messages`);
  const patchesTo = (uid) => sent.filter((s) => s.method === 'PATCH' && s.url.includes(`/channels/dm_${uid}/messages`));
  const patchToMsg = (uid, mid) => patchesTo(uid).find((s) => s.url.endsWith(`/messages/${mid}`));
  const failDM = (uid, status, code, remaining = Infinity) =>
    hooks.failDM.set(uid, { status, body: { message: 'mocked', code }, remaining });
  const dm50007 = (uid) => failDM(uid, 403, 50007);
  const hasFizzleCard = (uid) => postsTo(uid).some((s) => str(s.body).includes('back in the queue'));
  const queued = (uid) => !!matchmaking.getQueuePosition(uid);

  console.log('=== T1a (fix 1): /new rollback keeps a fizzle-restored queue entry ===');
  {
    resetQ2();
    onboarded('T1A'); onboarded('T1B');
    matchmaking.addToQueue('T1B', db.getAnonId('T1B'));
    dm50007('T1B');
    hooks.hangCallback = () => true;
    const p = newCmd.execute(cmdIx('new', 'T1A')); // queues T1A, hangs in replyV2
    for (let i = 0; i < 200 && !queued('T1A'); i++) await tick();
    ok(queued('T1A'), 'T1a setup: T1A queued while callback hangs');
    await chat.sweepMatchmaking(); // pairs T1A+T1B, T1B unreachable -> fizzle -> both handled
    ok(hasFizzleCard('T1A'), 'T1a setup: T1A got the honest back-in-queue card');
    ok(queued('T1A'), 'T1a setup: fizzle re-queued T1A');
    hooks.hangCallback = null;
    releaseHanging(() => true, new Error('simulated callback transport failure')); // /new callback dies
    await p;
    ok(queued('T1A'), 'T1a: fizzle-restored entry SURVIVES the /new rollback');
    ok(!queued('T1B'), 'T1a: dms_closed T1B was not re-queued (fix 3)');
  }

  console.log('=== T1c (no-regress): plain callback failure still rolls back ===');
  {
    resetQ2();
    onboarded('T1C');
    hooks.failCallback = true; // replyV2 dies immediately, no fizzle involved
    await newCmd.execute(cmdIx('new', 'T1C'));
    ok(!queued('T1C'), 'T1c: entry rolled back so a retry starts clean');
    ok(!db.getActiveSessionForUser('T1C'), 'T1c: no session');
  }

  console.log('=== T2 (fix 2): fizzle returns null; find_new no longer lies ===');
  {
    resetQ2();
    onboarded('T2A'); onboarded('T2B');
    matchmaking.addToQueue('T2A', db.getAnonId('T2A'));
    matchmaking.addToQueue('T2B', db.getAnonId('T2B'));
    dm50007('T2B');
    const r = await chat.sweepMatchmaking();
    ok(r === false, 'T2a: sweepMatchmaking() is false on fizzle (was true)');
    ok(!db.getActiveSessionForUser('T2A'), 'T2a: no session for fizzled pair');
  }
  {
    resetQ2();
    onboarded('T2C'); onboarded('T2D');
    matchmaking.addToQueue('T2D', db.getAnonId('T2D'));
    dm50007('T2D');
    await chat.handleChatFindNew(btnIx('chat_find_new', 'T2C', { channelId: 'dm_T2C', messageId: 'm1' }));
    const edit = patchToMsg('T2C', 'm1');
    ok(!!edit && !str(edit.body).includes('Found someone'), 'T2b: card does NOT say "Found someone" for a fizzle');
    ok(!!edit && str(edit.body).includes('Searching for a partner'), 'T2b: card shows the honest searching state');
    ok(queued('T2C'), 'T2b: user left queued');
    ok(!db.getActiveSessionForUser('T2C'), 'T2b: no session');
  }

  console.log('=== T3 (fix 3): dms_closed side is not re-queued after a fizzle ===');
  {
    resetQ2();
    onboarded('T3U'); onboarded('T3P');
    matchmaking.addToQueue('T3U', db.getAnonId('T3U'));
    matchmaking.addToQueue('T3P', db.getAnonId('T3P'));
    dm50007('T3U'); // T3U permanently unreachable
    await chat.sweepMatchmaking();
    ok(!queued('T3U'), 'T3: closed-DM user NOT re-queued (no more infinite fizzle loop)');
    ok(queued('T3P'), 'T3: reachable partner re-queued');
    ok(hasFizzleCard('T3P'), 'T3: reachable partner got the back-in-queue card');
    ok(!hasFizzleCard('T3U'), 'T3: unreachable side got no card (nothing to tell them on)');
  }

  console.log('=== T4 (fix 4): /end mid-formation (DMs succeed) abandons formation ===');
  {
    resetQ2();
    onboarded('T4A'); onboarded('T4B');
    matchmaking.addToQueue('T4A', db.getAnonId('T4A'));
    matchmaking.addToQueue('T4B', db.getAnonId('T4B'));
    hooks.onMessagePost = (uid, url, body) => str(body).includes("You're now chatting") ? 'hang' : null;
    const sweepP = chat.sweepMatchmaking(); // stalls inside the greeting DM window
    for (let i = 0; i < 200 && !db.getActiveSessionForUser('T4A'); i++) await tick();
    ok(!!db.getActiveSessionForUser('T4A'), 'T4 setup: half-born session exists mid-formation');
    await endCmd.execute(cmdIx('end', 'T4A'));
    ok(!db.getActiveSessionForUser('T4A'), 'T4 setup: /end concluded the half-born session');
    hooks.onMessagePost = null;
    releaseHanging(() => true);
    const formed = await sweepP;
    ok(formed === false, 'T4: formation returns null (does not complete into the void)');
    ok(!db.getActiveSessionForUser('T4A') && !db.getActiveSessionForUser('T4B'), 'T4: no session afterwards');
    ok(!queued('T4A') && !queued('T4B'), 'T4: nobody silently re-queued');
    ok(!hasFizzleCard('T4A') && !hasFizzleCard('T4B'), 'T4: no fizzle unwind ran');
  }

  console.log('=== T5 (fix 5): /end mid-formation (DMs fail) does not re-queue the ender ===');
  {
    resetQ2();
    onboarded('T5C'); onboarded('T5D');
    matchmaking.addToQueue('T5C', db.getAnonId('T5C'));
    matchmaking.addToQueue('T5D', db.getAnonId('T5D'));
    hooks.onMessagePost = (uid, url, body) => str(body).includes("You're now chatting") ? 'hang' : null;
    const sweepP = chat.sweepMatchmaking();
    for (let i = 0; i < 200 && !db.getActiveSessionForUser('T5C'); i++) await tick();
    await endCmd.execute(cmdIx('end', 'T5C')); // ender ends the half-born chat
    dm50007('T5D'); // partner unreachable -> would fizzle on release
    hooks.onMessagePost = null;
    releaseHanging(() => true);
    const formed = await sweepP;
    ok(formed === false, 'T5: formation returns null');
    ok(!queued('T5C'), 'T5: ender NOT re-queued by the fizzle path after explicitly ending');
    ok(!queued('T5D'), 'T5: partner not re-queued either (unwind skipped)');
    ok(!hasFizzleCard('T5C'), 'T5: ender got no "back in the queue" card');
  }

  console.log('=== T6 (fix 6): banned user cannot queue via chat_find_new ===');
  {
    resetQ2();
    onboarded('T6A'); onboarded('T6B');
    db.banUser('T6B', 'test ban');
    await chat.handleChatFindNew(btnIx('chat_find_new', 'T6B', { channelId: 'dm_T6B', messageId: 'm1' }));
    ok(!queued('T6B'), 'T6: banned user NOT queued through the component path');
    const edit = patchToMsg('T6B', 'm1');
    ok(!!edit && str(edit.body).includes('not allowed'), 'T6: pressed card shows the denial');
    // allowed user still works
    await chat.handleChatFindNew(btnIx('chat_find_new', 'T6A', { channelId: 'dm_T6A', messageId: 'm1' }));
    ok(queued('T6A'), 'T6: allowed user queues normally');
  }

  console.log('=== T7 (fix 7): find_new while queued keeps the original searching card live ===');
  {
    resetQ2();
    onboarded('T7A');
    await newCmd.execute(cmdIx('new', 'T7A'));
    const live = matchmaking.getSearchingCardId('T7A');
    ok(live === 'orig_1', 'T7 setup: /new recorded the searching card id');
    await chat.handleChatFindNew(btnIx('chat_find_new', 'T7A', { channelId: 'dm_T7A', messageId: 'm9' }));
    ok(matchmaking.getSearchingCardId('T7A') === 'orig_1', 'T7: second press does NOT re-parent the card id');
    await chat.handleQueueCancel(btnIx('queue_cancel', 'T7A', { channelId: 'dm_T7A', messageId: 'orig_1', flags: 64 }));
    ok(!queued('T7A'), 'T7: Cancel on the ORIGINAL card still works (no orphan)');
  }

  console.log('=== T8 (fix 8): fizzle state pruned after TTL ===');
  {
    resetQ2();
    onboarded('T8A'); onboarded('T8B');
    const realNow = Date.now;
    try {
      for (let i = 0; i < 3; i++) {
        matchmaking.addToQueue('T8A', db.getAnonId('T8A'));
        matchmaking.addToQueue('T8B', db.getAnonId('T8B'));
        dm50007('T8B');
        await chat.sweepMatchmaking();
        hooks.failDM.clear();
      }
      ok(chat.fizzlePairBlocked('T8A', 'T8B') === true, 'T8 setup: pair blocked after 3 fizzles');
      ok(chat._fizzleStateSizeForTests() === 1, 'T8 setup: one fizzle entry live');
      ok(chat.fizzleRestoredSeqFor('T8A') > 0, 'T8 setup: informed-restore marker recorded');
      Date.now = () => realNow() + 61 * 60_000; // past the 1h TTL
      await chat.sweepIdleSessions();
      ok(chat._fizzleStateSizeForTests() === 0, 'T8: stale fizzle entry pruned');
      ok(chat.fizzleRestoredSeqFor('T8A') === 0, 'T8: stale restore marker pruned');
      ok(chat.fizzlePairBlocked('T8A', 'T8B') === false, 'T8: block long expired');
    } finally { Date.now = realNow; }
  }

  console.log('=== T8b (no-regress): active block survives the prune ===');
  {
    resetQ2();
    onboarded('T8C'); onboarded('T8D');
    const realNow = Date.now;
    try {
      for (let i = 0; i < 3; i++) {
        matchmaking.addToQueue('T8C', db.getAnonId('T8C'));
        matchmaking.addToQueue('T8D', db.getAnonId('T8D'));
        dm50007('T8D');
        await chat.sweepMatchmaking();
        hooks.failDM.clear();
      }
      Date.now = () => realNow() + 60_000; // 1 min later: still inside the 5-min block
      await chat.sweepIdleSessions();
      ok(chat.fizzlePairBlocked('T8C', 'T8D') === true, 'T8b: unexpired block NOT pruned');
      ok(chat._fizzleStateSizeForTests() === 1, 'T8b: entry retained');
    } finally { Date.now = realNow; }
  }

  console.log('=== Tb2 (b2): sendVoiceNote 403/10003 self-heal ===');
  {
    resetQ2();
    const voiceFile = {
      filename: 'note.ogg', data: Buffer.from('OggS\x00\x02\x00\x00', 'binary'),
      contentType: 'audio/ogg', duration_secs: 3, waveform: 'aGVsbG8=',
    };
    failDM('VN1', 403, 50001, 1); // one stale-channel 403, then healthy
    const r1 = await chat.sendVoiceNote('VN1', voiceFile);
    ok(r1.ok === true, 'Tb2: 403 evict+retry delivers the voice note');
    ok(postsTo('VN1').length === 2, 'Tb2: exactly one retry happened');
    const r2 = await chat.sendVoiceNote('VN1', voiceFile);
    ok(r2.ok === true, 'Tb2: follow-up voice note succeeds on the fresh channel');
  }
  {
    resetQ2();
    const voiceFile = {
      filename: 'note.ogg', data: Buffer.from('OggS\x00\x02\x00\x00', 'binary'),
      contentType: 'audio/ogg', duration_secs: 3, waveform: 'aGVsbG8=',
    };
    failDM('VN3', 404, 10003, 1); // unknown channel once, then healthy
    const r = await chat.sendVoiceNote('VN3', voiceFile);
    ok(r.ok === true, 'Tb2: 10003 evict+retry delivers the voice note');
    ok(postsTo('VN3').length === 2, 'Tb2: exactly one retry on 10003');
  }
  {
    resetQ2();
    const voiceFile = {
      filename: 'note.ogg', data: Buffer.from('OggS\x00\x02\x00\x00', 'binary'),
      contentType: 'audio/ogg', duration_secs: 3, waveform: 'aGVsbG8=',
    };
    dm50007('VN4'); // persistent closed DMs: never retried
    const r = await chat.sendVoiceNote('VN4', voiceFile);
    ok(r.ok === false && r.reason === 'dms_closed', 'Tb2: 50007 still reports dms_closed');
    ok(postsTo('VN4').length === 1, 'Tb2: no retry on permanent 50007');
  }

  console.log('=== Tb3 (b3): fizzle greys the delivered greeting card ===');
  {
    resetQ2();
    failDM('F2', 403, 50007);
    await chat.startChatSession('F1', 'F2', 'anon1', 'anon2');
    const greetPosts = postsTo('F1');
    ok(greetPosts.length >= 1, 'Tb3 setup: F1 greeting card was delivered');
    const dis = patchesTo('F1').find((p) => {
      const comps = str(p.body?.components || []);
      return comps.includes('chat_end') && comps.includes('"disabled":true');
    });
    ok(!!dis, 'Tb3: delivered greeting card got its End/Report buttons disabled');
    ok(!queued('F2'), 'Tb3: dms_closed F2 not re-queued');
  }

  console.log('=== Tb5 (b5): /new refused while the old conclusion is in flight ===');
  {
    resetQ2();
    onboarded('B5A'); onboarded('B5B'); onboarded('B5C');
    const s1 = db.createChatSession('B5A', 'B5B');
    s1.greeting = { B5A: { channelId: 'dm_B5A', messageId: 'g1' }, B5B: { channelId: 'dm_B5B', messageId: 'g2' } };
    const isConclusionPost = (body) => {
      const s = str(body || {});
      return s.includes('Session Overview') || s.includes('You ended the chat') ||
        s.includes('left the conversation') || s.includes('timed out after');
    };
    hooks.onMessagePost = (uid, url, body) => (isConclusionPost(body) ? 'hang' : null);
    const conclP = chat.concludeSession(s1, 'manual', 'B5A', { omitDMFor: 'B5A' });
    await tick(50);
    ok(chat.isUserConcluding('B5A') === true, 'Tb5 setup: conclusion in flight');
    matchmaking.addToQueue('B5C', db.getAnonId('B5C'));
    await newCmd.execute(cmdIx('new', 'B5A'));
    ok(!queued('B5A'), 'Tb5a: /new does NOT queue while concluding');
    ok(!db.getActiveSessionForUser('B5A'), 'Tb5a: no new session formed mid-conclusion');
    const cb = [...sent].reverse().find((s) => /\/callback$/.test(s.url));
    ok(!!cb && str(cb.body).includes('One Moment'), 'Tb5a: /new refused with the finishing-up notice');
    await chat.handleChatFindNew(btnIx('chat_find_new', 'B5A', { channelId: 'dm_B5A', messageId: 'oldcard' }));
    ok(!queued('B5A'), 'Tb5b: find_new does NOT queue while concluding');
    const edit = patchToMsg('B5A', 'oldcard');
    ok(!!edit && str(edit.body).includes('Finishing up'), 'Tb5b: pressed card shows the finishing-up notice');
    hooks.onMessagePost = null;
    releaseHanging(() => true);
    await conclP;
    ok(chat.isUserConcluding('B5A') === false, 'Tb5 setup: conclusion drained');
    sent.length = 0;
    await newCmd.execute(cmdIx('new', 'B5A')); // now allowed; B5C waits -> match forms
    ok(!!db.getActiveSessionForUser('B5A'), 'Tb5: /new works again after the conclusion lands');
  }
}


// ---------------------------------------------------------------------------
// REL. REST timeout + sweep/relay perf regressions.
// Merged from regression-sections/patch-reliability-section.mjs (25 tests);
// ok(name, cond, extra) is retargeted to okRel so accounting flows into the
// suite harness `ok` (suite arg order is (cond, name)).
// ---------------------------------------------------------------------------
{
    // ---- cycle-2 merge prologue: reproduce the section's standalone isolation ----
  {
      const { rmSync: rmDir } = await import('node:fs');
      const { default: nodePath } = await import('node:path');
      const { paths: cfgPaths } = await import('../src/config.js');
      process.env.DATA_DIR = '/tmp/patch-reliability-data';
      rmDir(process.env.DATA_DIR, { recursive: true, force: true });
      cfgPaths.dataDir = nodePath.resolve(process.env.DATA_DIR);
      cfgPaths.dbFile = nodePath.join(cfgPaths.dataDir, 'db.json');
      cfgPaths.mediaDir = nodePath.join(cfgPaths.dataDir, 'media');
    }
    reset();


  const { rmSync } = await import('node:fs');
  rmSync('/tmp/patch-reliability-data', { recursive: true, force: true });

  const TREE = '/home/hatch/workspace/anon-chat-remake-experimental/src';
  const okRel = (name, cond, extra = '') => {
    ok(cond, `[reliability] ${name}${extra ? ' — ' + extra : ''}`);
  };
  const section = (t) => console.log(`\n== ${t} ==`);

  const origTimeout = AbortSignal.timeout.bind(AbortSignal);
  const shortTimeout = (ms) => { AbortSignal.timeout = () => origTimeout(ms); };
  const restoreTimeout = () => { AbortSignal.timeout = origTimeout; };

  // ---------------------------------------------------------------- R1/R2: fetch timeout on Discord REST
  section('R1: rawRequest passes an AbortSignal to fetch');
  {
    let captured = null;
    globalThis.fetch = async (url, opts = {}) => {
      captured = opts;
      return new Response(JSON.stringify({ id: 'u1' }), { status: 200 });
    };
    const { Rest } = await import(`${TREE}/discord/rest.js`);
    await Rest.getUser('U1');
    okRel('fetch receives a signal option', captured && 'signal' in captured);
    okRel('signal is an AbortSignal', captured?.signal instanceof AbortSignal);
  }

  // ---------------------------------------------------------------- R2: a hung connection becomes a rejection
  section('R2: stalled Discord connection aborts (stubbed short timeout)');
  {
    shortTimeout(60);
    globalThis.fetch = (url, opts = {}) => new Promise((_, reject) => {
      opts.signal?.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
    });
    const { Rest } = await import(`${TREE}/discord/rest.js`);
    const t0 = performance.now();
    // Race with a ref'd timer: AbortSignal.timeout() uses an unref'd internal
    // timer, so a bare top-level await would let Node exit early with an
    // "unsettled top-level await" warning. The race timer keeps the loop alive.
    const outcome = await Promise.race([
      Rest.createDM('U9').then(() => 'resolved', (e) => `rejected: ${e.message}`),
      new Promise((res) => setTimeout(() => res('RACE-TIMEOUT'), 5000)),
    ]);
    const dt = performance.now() - t0;
    restoreTimeout();
    okRel('hung REST call rejects instead of hanging forever', outcome.startsWith('rejected:'), outcome.slice(0, 60));
    okRel('rejection is fast (not 15s, not never)', dt < 5000, `${dt.toFixed(0)}ms`);
    okRel('error is wrapped as a network error', /network error/.test(outcome));
  }

  // ---------------------------------------------------------------- R3: concludeSession not wedged by a hung REST call
  section('R3: concludeSession completes when a REST call hangs');
  {
    shortTimeout(60);
    let hangSends = true;
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      const method = (opts.method || 'GET').toUpperCase();
      if (u.endsWith('/users/@me/channels') && method === 'POST') {
        const b = JSON.parse(opts.body);
        return new Response(JSON.stringify({ id: 'dm_' + b.recipient_id }), { status: 200 });
      }
      if (u.match(/\/channels\/dm_[A-Za-z0-9_]+\/messages$/) && method === 'POST') {
        if (hangSends) {
          await new Promise((_, reject) => {
            opts.signal?.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
          });
        }
        return new Response(JSON.stringify({ id: 'm1' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };
    const { db } = await import(`${TREE}/services/database.js`);
    const chat = await import(`${TREE}/services/chat.js`);
    db.load(); db._resetForTests();
    for (const uid of ['W1', 'W2']) {
      db.createProfile({ id: uid, name: uid, dob: '2000-01-01' });
      db.db.dms[uid] = 'dm_' + uid;
    }
    await db.flush();
    const s = db.createChatSession('W1', 'W2');
    const r = await Promise.race([
      chat.concludeSession(s, 'manual', 'W1').then((x) => ({ settled: true, x })),
      new Promise((res) => setTimeout(() => res({ settled: false }), 8000)),
    ]);
    restoreTimeout();
    okRel('concludeSession settles despite hung sends', r.settled === true);
    okRel('concludeSession is not a duplicate-wedge', r.settled && r.x.duplicate !== true);
    okRel('session actually ended', r.settled && db.getActiveSessionForUser('W1') === null);
    hangSends = false;
    await db.flush();
  }

  // ---------------------------------------------------------------- M: matchmaking sweep equivalence + perf
  section('M1: pairing semantics identical after hoisting derived values');
  {
    globalThis.fetch = async () => new Response('{}', { status: 200 });
    const { db } = await import(`${TREE}/services/database.js`);
    const { matchmaking } = await import(`${TREE}/services/matchmaking.js`);
    db.load();

    const setup = async (users) => {
      matchmaking._resetForTests(); db._resetForTests();
      for (const [uid, dob] of users) {
        db.createProfile({ id: uid, name: uid, dob });
        matchmaking.addToQueue(uid, db.getAnonId(uid));
      }
      await db.flush();
    };
    const pairIds = (m) => m ? [m.user1.user_id, m.user2.user_id].sort().join('+') : null;

    // Two minors within 2.0y pair; smallest exact gap wins the sweep.
    await setup([['m1', '2010-06-01'], ['m2', '2011-12-01'], ['m3', '2012-12-01']]);
    okRel('minors within 2.0y pair, smallest gap wins', pairIds(matchmaking.tryMatchWaiters()) === 'm2+m3');

    await setup([['m1', '2010-06-01'], ['m3', '2012-12-01']]); // 2.5y apart
    okRel('minors 2.5y apart do not pair', matchmaking.tryMatchWaiters() === null);

    // Exact 2.0y boundary pairs; just over does not.
    await setup([['b1', '2009-03-01'], ['b2', '2011-03-01']]);
    okRel('exactly 2.0y apart pairs', matchmaking.tryMatchWaiters() !== null);
    await setup([['b1', '2009-02-28'], ['b2', '2011-03-01']]);
    okRel('just over 2.0y does not pair', matchmaking.tryMatchWaiters() === null);

    // Tier wall absolute.
    await setup([['minor1', '2009-06-01'], ['adult1', '2000-06-01']]);
    okRel('minor/adult never pair', matchmaking.tryMatchWaiters() === null);

    // Unknown dob: fail-safe eligible, but sorts last behind a real close pair.
    await setup([['u1', '2000-01-01'], ['u2', '2001-01-01'], ['ux', null]]);
    db.createProfile({ id: 'ux2', name: 'ux2', dob: null });
    const m = matchmaking.tryMatchWaiters();
    okRel('real close pair beats unknown-dob (Infinity gap sorts last)',
      pairIds(m) === 'u1+u2', pairIds(m));

    // Unknown dob alone with a same-tier (minor, fail-safe) user still pairs.
    await setup([['a1', '2010-06-01']]);
    db.createProfile({ id: 'ax', name: 'ax', dob: null });
    matchmaking.addToQueue('ax', db.getAnonId('ax'));
    await db.flush();
    okRel('unknown dob remains eligible', matchmaking.tryMatchWaiters() !== null);

    // Adult gap expansion: 8y apart, fresh joiners (cap 5) -> no; backdated (cap>=8) -> yes.
    await setup([['g1', '1990-01-01'], ['g2', '1998-01-01']]);
    okRel('adults 8y apart, fresh: no match', matchmaking.tryMatchWaiters() === null);
    await setup([['g1', '1990-01-01'], ['g2', '1998-01-01']]);
    const old = Date.now() - 4 * 60_000; // 4 min -> cap 5+8=13
    matchmaking._setJoinedAtForTests('g1', old);
    matchmaking._setJoinedAtForTests('g2', old);
    okRel('adults 8y apart, 4min wait (cap 13): match', matchmaking.tryMatchWaiters() !== null);

    // Smallest gap wins.
    await setup([['c1', '2000-01-01'], ['c2', '2000-06-01'], ['c3', '2005-01-01']]);
    okRel('smallest exact gap wins', pairIds(matchmaking.tryMatchWaiters()) === 'c1+c2');

    // Tie -> longest waiter wins. 1y gaps avoiding leap days so both gaps are
    // exactly 365 days (a 2y span crossing a Feb 29 is NOT an exact tie).
    await setup([['t1', '2001-06-01'], ['t2', '2002-06-01'], ['t3', '2003-06-01']]);
    // t1-t2 and t2-t3 tie at 365d; pair containing earliest joiner (t1) wins.
    const tm = matchmaking.tryMatchWaiters();
    okRel('gap tie goes to longest waiter', tm && [tm.user1.user_id, tm.user2.user_id].includes('t1'),
      tm ? tm.user1.user_id + '+' + tm.user2.user_id : 'null');

    // findMatch prefers the newcomer's best partner (same tier).
    await setup([['n1', '2000-01-01'], ['n2', '2000-03-01'], ['n3', '2000-06-01']]);
    const fm = matchmaking.findMatch('n3');
    okRel('findMatch pairs newcomer with best partner',
      fm !== null && [fm.user1.user_id, fm.user2.user_id].includes('n3')
        && [fm.user1.user_id, fm.user2.user_id].includes('n2'),
      fm ? fm.user1.user_id + '+' + fm.user2.user_id : 'null');

    // Feb 29 birthday (valid leap dob, minor) pairs within the window.
    await setup([['l1', '2012-02-29'], ['l2', '2014-02-28']]);
    okRel('Feb 29 birthday pairs within 2.0y window', matchmaking.tryMatchWaiters() !== null);
    await db.flush();
  }

  section('M2: tryMatchWaiters sweep is no longer O(n^2)-slow');
  {
    const { db } = await import(`${TREE}/services/database.js`);
    const { matchmaking } = await import(`${TREE}/services/matchmaking.js`);
    const dobFor = (i) => {
      const age = 14 + (i % 27);
      return `${2026 - age}-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`;
    };
    const ts = [];
    for (let iter = 0; iter < 5; iter++) {
      matchmaking._resetForTests(); db._resetForTests();
      for (let i = 0; i < 480; i++) {
        const uid = 'P' + String(i).padStart(5, '0');
        db.createProfile({ id: uid, name: 'n' + i, dob: dobFor(i) });
        matchmaking.addToQueue(uid, db.getAnonId(uid));
      }
      await db.flush();
      const a = performance.now();
      matchmaking.tryMatchWaiters();
      ts.push(performance.now() - a);
    }
    ts.sort((a, b) => a - b);
    const p50 = ts[2];
    okRel('n=480 sweep p50 well under the old ~790ms', p50 < 200, `p50=${p50.toFixed(1)}ms`);
  }

  // ---------------------------------------------------------------- L: relay rate-limit array bounded
  section('L1: rate-limit decisions unchanged (8/window allowed, rest dropped)');
  {
    let partnerPosts = 0, warnPosts = 0;
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      const method = (opts.method || 'GET').toUpperCase();
      if (u.endsWith('/users/@me/channels') && method === 'POST')
        return new Response(JSON.stringify({ id: 'dm_ch' }), { status: 200 });
      if (u.includes('/channels/dm_ch/messages') && method === 'POST') {
        const body = JSON.parse(opts.body || '{}');
        const text = JSON.stringify(body.components || '');
        if (text.includes('slow down')) warnPosts++; else partnerPosts++;
        return new Response(JSON.stringify({ id: 'm1' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };
    const { db } = await import(`${TREE}/services/database.js`);
    const chat = await import(`${TREE}/services/chat.js`);
    db.load(); db._resetForTests(); chat._resetRelayForTests();
    db.createProfile({ id: 'SP', name: 's', dob: '2000-01-01' });
    db.createProfile({ id: 'VT', name: 'v', dob: '2000-01-01' });
    db.createChatSession('SP', 'VT');
    db.db.dms['SP'] = 'dm_ch'; db.db.dms['VT'] = 'dm_ch';
    await db.flush();
    const msg = (i) => ({ author: { id: 'SP', bot: false }, channel_id: 'dm_ch', guild_id: null, type: 0, id: 'rl' + i, content: 'hello ' + i, attachments: [], flags: 0 });
    for (let i = 0; i < 12; i++) await chat.handleDirectMessage(msg(i));
    okRel('exactly 8 messages relayed to partner in window', partnerPosts === 8, `relayed=${partnerPosts}`);
    okRel('overflow messages dropped, not relayed', partnerPosts < 12);
    await db.flush();
  }

  section('L2: per-call cost stays flat at depth (array is bounded)');
  {
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      const method = (opts.method || 'GET').toUpperCase();
      if (u.endsWith('/users/@me/channels') && method === 'POST')
        return new Response(JSON.stringify({ id: 'dm_ch' }), { status: 200 });
      return new Response(JSON.stringify({ id: 'm1' }), { status: 200 });
    };
    const { db } = await import(`${TREE}/services/database.js`);
    const chat = await import(`${TREE}/services/chat.js`);
    db.load(); db._resetForTests(); chat._resetRelayForTests();
    db.createProfile({ id: 'DP', name: 's', dob: '2000-01-01' });
    db.createProfile({ id: 'DQ', name: 'v', dob: '2000-01-01' });
    db.createChatSession('DP', 'DQ');
    db.db.dms['DP'] = 'dm_ch'; db.db.dms['DQ'] = 'dm_ch';
    await db.flush();
    const msg = (i) => ({ author: { id: 'DP', bot: false }, channel_id: 'dm_ch', guild_id: null, type: 0, id: 'dp' + i, content: 'x' + i, attachments: [], flags: 0 });
    // Drive the per-user timestamp array deep (old code: grows to the full
    // 200000; new code: capped at RELAY_MAX + 8 = 16).
    for (let i = 0; i < 200000; i++) await chat.handleDirectMessage(msg(i));
    const ds = [];
    for (let i = 200000; i < 200300; i++) {
      const a = performance.now();
      await chat.handleDirectMessage(msg(i));
      ds.push(performance.now() - a);
    }
    ds.sort((a, b) => a - b);
    const p50 = ds[150];
    // Old code re-filters ~200000 timestamps per call here (~0.05ms and growing
    // linearly); bounded code filters at most 16 (~0.001ms, flat).
    okRel('p50 per-message cost flat at depth 200000', p50 < 0.01, `p50=${p50.toFixed(4)}ms`);
    await db.flush();
  }
}


// ---------------------------------------------------------------------------
// GW. router/gateway regressions (429 cap, catch-all webhook, connect-timeout,
// INVALID_SESSION storms, malformed HELLO/READY, start() idempotence).
// ---------------------------------------------------------------------------
{
    // ---- cycle-2 merge prologue: fresh /tmp/bughunt tree + harness reset ----
    {
      const { rmSync: rmDir } = await import('node:fs');
      rmDir('/tmp/bughunt', { recursive: true, force: true });
    }
    reset();
    // Regression section: cycle-2 router/gateway patches (merged from
    // regression-sections/patch-gateway-section.mjs, 9 tests; standalone
    // `export`s stripped for block scope, results feed the suite harness `ok`).
  //
  // Fixes covered:
  //  1. rest.js: 429 retry_after sleep capped at 30s (was uncapped -> wedged the
  //     per-user router chain for the full retry_after).
  //  2. router.js: catch-all "Something Went Wrong" now attempts the webhook
  //     edit-original AS WELL AS the initial callback (was callback-only,
  //     invisible after any defer -> 40060 swallowed by safe()).
  //  3. gateway.js: connect-timeout handler neutralizes ws.onmessage/onopen/
  //     onerror (not just onclose); handleMessage drops frames from a socket
  //     that is no longer this.ws (late-HELLO corruption of the replacement).
  //  4. gateway.js: INVALID_SESSION(d=true) resume storm serialized via an
  //     in-flight flag (was N concurrent sleep->resume chains per flap burst).
  //  5. gateway.js: malformed HELLO (missing/non-numeric heartbeat_interval,
  //     d=null) fails the attempt fast instead of a ~1ms heartbeat hot loop or
  //     a thrown TypeError that burned the full connect timeout.
  //  6. gateway.js: malformed READY (missing d / non-string session_id) clears
  //     session state and identifies fresh instead of throwing with a stale
  //     sessionId that flapped through INVALID_SESSION.
  //  7. gateway.js: Gateway.start() is idempotent (second start() while an
  //     attempt or its reconnect chain is in flight is a no-op).
  //
  // Also asserts the cycle-1 INVALID_SESSION(d=false) seq-reset behavior did
  // not regress.

  const EXP = '/home/hatch/workspace/anon-chat-remake-experimental/src';
    const { paths: gwPaths } = await import('../src/config.js');
    const { default: gwPath } = await import('node:path');

  // ---------------------------------------------------------------------------
  // suite helpers
  // ---------------------------------------------------------------------------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function json(o, status = 200) {
    return new Response(JSON.stringify(o), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  function setupEnv(tag) {
    process.env.DATA_DIR = `/tmp/bughunt/data-${tag}`;
    process.env.APPLICATION_ID = 'app123';
    process.env.DISCORD_TOKEN = 'MOCKTOKEN';
    process.env.LOG_LEVEL = 'error';
    for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy']) delete process.env[k];
    gwPaths.dataDir = gwPath.resolve(process.env.DATA_DIR);
    gwPaths.dbFile = gwPath.join(gwPaths.dataDir, 'db.json');
    gwPaths.mediaDir = gwPath.join(gwPaths.dataDir, 'media');
  }

  async function freshDb(tag) {
    const { rmSync } = await import('node:fs');
    rmSync(process.env.DATA_DIR, { recursive: true, force: true });
    const { db } = await import(`${EXP}/services/database.js`);
    db.load();
    return db;
  }

  function assert(cond, msg) {
    if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  }

  // FakeWS mimics ProxyWebSocket's post-close behavior: close() -> CLOSING,
  // inbound frames still dispatched to onmessage (shim parses until CLOSED).
  function makeFakeWS(instances) {
    return class FakeWS {
      static OPEN = 1;
      constructor(url) {
        this.url = url; this.readyState = 0;
        this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
        this.sentOps = []; this.closeCalls = [];
        instances.push(this);
        setImmediate(() => { this.readyState = 1; });
      }
      send(payload) { try { this.sentOps.push(JSON.parse(payload).op); } catch {} }
      close(code, reason) { this.closeCalls.push([code, reason]); this.readyState = 2; }
      deliver(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
    };
  }

  // ---------------------------------------------------------------------------
  // the regression tests
  // ---------------------------------------------------------------------------

  const tests = [
    {
      name: '1: 429 retry_after=3600 resolves in bounded time (30s cap)',
      async run() {
        let calls = 0;
        globalThis.fetch = async (url) => {
          calls++;
          if (String(url).endsWith('/gateway/bot')) return json({ url: 'ws://mock.invalid', shards: 1 });
          if (calls === 1) return json({ retry_after: 3600 }, 429);
          return json({ ok: true });
        };
        const { request } = await import(`${EXP}/discord/rest.js`);
        const t0 = Date.now();
        const res = await request('GET', '/users/@me');
        const elapsed = Date.now() - t0;
        assert(res.ok === true, 'request should succeed after the capped retry');
        assert(elapsed > 15000 && elapsed < 120000,
          `expected a ~30s capped sleep, got ${elapsed}ms (uncapped would be 3600s+)`);
      },
    },

    {
      name: '2: catch-all error reaches the user after a defer (webhook edit-original)',
      async run() {
        const sent = [];
        const acked = new Set();
        globalThis.fetch = async (url, opts = {}) => {
          const u = String(url);
          if (!u.startsWith('https://discord.com/api/v10')) return json({ id: 'x' });
          const method = (opts.method || 'GET').toUpperCase();
          sent.push({ url: u, method });
          const cbm = u.match(/\/interactions\/([^/]+)\/([^/]+)\/callback$/);
          if (cbm && method === 'POST') {
            if (acked.has(cbm[2])) return json({ message: 'already acknowledged', code: 40060 }, 400);
            acked.add(cbm[2]);
            return json({ id: 'cb1' });
          }
          return json({ id: 'msg1' });
        };
        const db = await freshDb('reg2');
        const { routeInteraction } = await import(`${EXP}/router.js`);
        const uid = 'RG2';
        const n = new Date();
        db.createProfile({ id: uid, name: `user_${uid}`, dob: `${n.getUTCFullYear() - 20}-01-01`, interests: [] });
        const modalIx = {
          id: 'ix9', token: 'tok-reg-2', type: 5,
          user: { id: uid, username: `user_${uid}`, global_name: null },
          data: {
            custom_id: 'profile_update_name_modal',
            components: [{ type: 1, components: [{ type: 4, custom_id: 'profile_name_input', value: 'Bob' }] }],
          },
        };
        const orig = db.updateUserProfile;
        db.updateUserProfile = () => { throw new Error('mock db outage'); };
        let rejected = false;
        try { await routeInteraction(modalIx); } catch { rejected = true; }
        db.updateUserProfile = orig;
        assert(!rejected, 'routeInteraction must not reject');
        const webhookCalls = sent.filter((s) => /\/webhooks\/app123\/tok-reg-2/.test(s.url));
        assert(webhookCalls.length > 0,
          'expected a webhook attempt (edit-original) after the defer, not just the 40060 callback');
      },
    },

    {
      name: '3: connect-timeout neutralizes the dead socket; late HELLO cannot corrupt the replacement',
      async run() {
        globalThis.fetch = async (url) =>
          String(url).endsWith('/gateway/bot') ? json({ url: 'ws://mock.invalid', shards: 1 }) : json({ id: 'x' });
        const instances = [];
        globalThis.WebSocket = makeFakeWS(instances);
        const { Gateway } = await import(`${EXP}/discord/gateway.js`);
        const gw = new Gateway(async () => {});
        gw.connectTimeoutMs = 150;
        gw.connect(false).catch(() => {});
        const t0 = Date.now();
        while (instances.length < 2 && Date.now() - t0 < 8000) await sleep(20);
        const ws1 = instances[0], ws2 = instances[1];
        assert(ws2, 'replacement connection (conn2) should have formed');
        ws1.deliver({ op: 10, d: { heartbeat_interval: 30 } }); // late HELLO on the dead socket
        await sleep(400);
        assert(!ws2.sentOps.includes(2),
          `replacement socket must not IDENTIFY before its own HELLO (sentOps=${JSON.stringify(ws2.sentOps)})`);
        assert(!ws2.closeCalls.some(([, r]) => r === 'zombie'),
          `replacement socket must not be zombie-closed by the dead socket's timer (${JSON.stringify(ws2.closeCalls)})`);
        await gw.stop();
      },
    },

    {
      name: '4: concurrent INVALID_SESSION(d=true) sends exactly one RESUME',
      async run() {
        const { Gateway } = await import(`${EXP}/discord/gateway.js`);
        const sentOps = [];
        const gw = new Gateway(async () => {});
        gw.ws = { readyState: 1, send(p) { try { sentOps.push(JSON.parse(p).op); } catch {} }, close() {} };
        gw.sessionId = 'sess-flap'; gw.resumeUrl = 'ws://127.0.0.1:9'; gw.seq = 42;
        await Promise.all([
          gw.handleMessage(JSON.stringify({ op: 9, d: true })),
          gw.handleMessage(JSON.stringify({ op: 9, d: true })),
          gw.handleMessage(JSON.stringify({ op: 9, d: true })),
        ]);
        const resumes = sentOps.filter((o) => o === 6).length;
        assert(resumes === 1, `expected 1 RESUME, got ${resumes}`);
        assert(gw.invalidSessionAttempts === 1, `expected attempts=1, got ${gw.invalidSessionAttempts}`);
        await gw.stop();
      },
    },

    {
      name: '5a: HELLO without heartbeat_interval fails fast (no hot loop, no zombie suicide)',
      async run() {
        const { Gateway } = await import(`${EXP}/discord/gateway.js`);
        const gw = new Gateway(async () => {});
        const sentOps = [];
        const closeCalls = [];
        gw.ws = { readyState: 1, send(p) { try { sentOps.push(JSON.parse(p).op); } catch {} }, close(c, r) { closeCalls.push([c, r]); } };
        gw._helloResolve = () => {};
        await gw.handleMessage(JSON.stringify({ op: 10, d: {} }));
        await sleep(120);
        gw.clearHeartbeat();
        const beats = sentOps.filter((o) => o === 1).length;
        assert(beats <= 3 && !closeCalls.some(([, r]) => r === 'zombie'),
          `hot loop / zombie suicide detected (beats=${beats}, closes=${JSON.stringify(closeCalls)})`);
        assert(closeCalls.some(([, r]) => r === 'malformed HELLO'),
          'malformed HELLO should close the socket to fail the attempt fast');
        await gw.stop();
      },
    },

    {
      name: '5b: HELLO with d=null does not throw',
      async run() {
        const { Gateway } = await import(`${EXP}/discord/gateway.js`);
        const gw = new Gateway(async () => {});
        gw.ws = { readyState: 1, send() {}, close() {} };
        let threw = null;
        try { await gw.handleMessage(JSON.stringify({ op: 10, d: null })); }
        catch (e) { threw = e; }
        assert(!threw, `handleMessage threw ${threw?.constructor?.name}`);
        await gw.stop();
      },
    },

    {
      name: '6: malformed READY clears session state instead of throwing (no stale resume)',
      async run() {
        const { Gateway } = await import(`${EXP}/discord/gateway.js`);
        // 6b: missing d must not throw, and must not keep the stale sessionId.
        {
          const gw = new Gateway(async () => {});
          gw.onDispatch = async () => {};
          gw.ws = { readyState: 1, send() {}, close() {} };
          gw.sessionId = 'stale-session'; gw.resumeUrl = 'ws://x'; gw.seq = 9;
          let threw = null;
          try { await gw.handleMessage(JSON.stringify({ op: 0, s: 8, t: 'READY' })); }
          catch (e) { threw = e; }
          assert(!threw, `handleMessage threw ${threw?.constructor?.name}`);
          assert(gw.sessionId === null, `stale sessionId survived: ${gw.sessionId}`);
          await gw.stop();
        }
        // 6a: empty d must not throw either (fail-safe to fresh identify).
        {
          const gw = new Gateway(async () => {});
          gw.onDispatch = async () => {};
          gw.ws = { readyState: 1, send() {}, close() {} };
          let threw = null;
          try { await gw.handleMessage(JSON.stringify({ op: 0, s: 7, t: 'READY', d: {} })); }
          catch (e) { threw = e; }
          assert(!threw, `handleMessage threw ${threw?.constructor?.name}`);
          assert(gw.sessionId === null, 'sessionId should be cleared on malformed READY');
          await gw.stop();
        }
      },
    },

    {
      name: '7: Gateway.start() is idempotent',
      async run() {
        const { Gateway } = await import(`${EXP}/discord/gateway.js`);
        const gw = new Gateway(async () => {});
        let calls = 0;
        gw.connect = async () => { calls++; await sleep(120); };
        await Promise.all([gw.start(), gw.start(), gw.start()]);
        await sleep(200);
        assert(calls === 1, `expected 1 connect() call, got ${calls}`);
        await gw.stop();
        let calls2 = 0;
        gw.connect = async () => { calls2++; };
        await gw.start();
        assert(calls2 === 1, 'start() must work again after stop()');
        await gw.stop();
      },
    },

    {
      name: 'cycle-1 no-regression: INVALID_SESSION(d=false) still resets seq and clears session',
      async run() {
        const { Gateway } = await import(`${EXP}/discord/gateway.js`);
        const gw = new Gateway(async () => {});
        gw.ws = { readyState: 1, send() {}, close() {} };
        gw.seq = 42; gw.sessionId = 'sess-x'; gw.resumeUrl = 'ws://x';
        await gw.handleMessage(JSON.stringify({ op: 9, d: false }));
        assert(gw.seq === 0, `seq should reset to 0, got ${gw.seq}`);
        assert(gw.sessionId === null && gw.resumeUrl === null, 'session state should be cleared');
        await gw.stop();
      },
    },
  ];

  // ---------------------------------------------------------------------------
  // runner
  // ---------------------------------------------------------------------------

  async function runAll(tagPrefix = 'reg') {
    setupEnv(`${tagPrefix}-suite`);
    for (let i = 0; i < tests.length; i++) {
      const t = tests[i];
      setupEnv(`${tagPrefix}-${i}`);
      const t0 = Date.now();
      try {
        await t.run();
        console.log(`PASS (${Date.now() - t0}ms) [gateway] ${t.name}`);
        ok(true, `[gateway] ${t.name}`);
      } catch (e) {
        console.log(`FAIL (${Date.now() - t0}ms) [gateway] ${t.name}: ${e.message}`);
        ok(false, `[gateway] ${t.name}: ${e.message}`);
      }
    }
  }

  await runAll();
}




// ---------------------------------------------------------------------------
// MEDIA3. profile media swap safety + HEIF ftyp brand regressions (cycle-3).
// Merged from regression-sections/patch-media3-section.mjs (21 tests); uses
// the suite harness (ok, reset); fs/path/media/attachments via dynamic import.
// ---------------------------------------------------------------------------
{
  // ---- cycle-3 merge prologue: reproduce the section's standalone isolation ----
  {
    const { rmSync: rmDir } = await import('node:fs');
    const { default: nodePath } = await import('node:path');
    const { paths: cfgPaths } = await import('../src/config.js');
    process.env.DATA_DIR = '/tmp/patch-media3-data';
    rmDir(process.env.DATA_DIR, { recursive: true, force: true });
    cfgPaths.dataDir = nodePath.resolve(process.env.DATA_DIR);
    cfgPaths.dbFile = nodePath.join(cfgPaths.dataDir, 'db.json');
    cfgPaths.mediaDir = nodePath.join(cfgPaths.dataDir, 'media');
  }
  reset();

  const fs = (await import('node:fs')).default;
  const path = (await import('node:path')).default;
  const { paths } = await import('../src/config.js');
  const { downloadProfileMedia } = await import('../src/utils/media.js');
  const { sniffCategory, sniffMatches } = await import('../src/services/attachments.js');

  function check(label, actual, expectFn, note = '') {
    ok(expectFn(actual), `[c3-media] ${label}${note ? ' :: ' + note : ''}`);
  }

  const UID = 'section-user-1';
  const dir = path.join(paths.mediaDir, UID);
  const tmpDir = path.join(paths.mediaDir, `${UID}.tmp-${process.pid}`);
  const bakDir = `${dir}.bak-${process.pid}`;

  const PNG = Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753' +
    'de0000000c4944415478620000000000ffff030000060005d30fa000000004945' +
    '4e44ae426082', 'hex');

  const clean = () => {
    for (const d of [dir, tmpDir, bakDir]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
  };
  const seedOldPhoto = () => {
    clean();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'old_photo.png'), PNG);
  };
  // Section-local fetch stub; restored at the end so the block is self-contained.
  const suiteFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, body: null, async arrayBuffer() { return PNG; } });
  const atts = () => ({ a1: { url: 'https://cdn.example/x', filename: 'new.png', content_type: 'image/png', size: PNG.length } });

  // (a) renameSync throws on the tmpDir->dir step: no throw escapes, old
  // gallery restored intact, tmpDir discarded, no leftover .bak.
  {
    seedOldPhoto();
    const realRename = fs.renameSync;
    fs.renameSync = (src, dst) => {
      if (String(src).includes('.tmp-')) throw Object.assign(new Error('ENOTEMPTY: injected'), { code: 'ENOTEMPTY' });
      return realRename(src, dst);
    };
    let threw = null, result = null;
    try { result = await downloadProfileMedia(UID, ['a1'], atts()); }
    catch (e) { threw = e; }
    fs.renameSync = realRename;
    check('mid-swap rename failure: nothing throws out of downloadProfileMedia', threw, (t) => t === null);
    check('mid-swap rename failure: fail() returned', result,
      (r) => r && r.ok === false && typeof r.error === 'string', JSON.stringify(result));
    check('mid-swap rename failure: old photo restored to live dir',
      fs.existsSync(path.join(dir, 'old_photo.png')), (v) => v === true);
    check('mid-swap rename failure: no leftover .bak dir', !fs.existsSync(bakDir), (v) => v === true);
    check('mid-swap rename failure: tmpDir discarded', !fs.existsSync(tmpDir), (v) => v === true);
    clean();
  }

  // (a2) happy path still works: new files land, old gone, no .bak left.
  {
    seedOldPhoto();
    const result = await downloadProfileMedia(UID, ['a1'], atts());
    check('happy path: ok:true', result, (r) => r && r.ok === true, JSON.stringify(result));
    check('happy path: new file in live dir', fs.existsSync(path.join(dir, 'a1_new.png')), (v) => v === true);
    check('happy path: old file replaced', !fs.existsSync(path.join(dir, 'old_photo.png')), (v) => v === true);
    check('happy path: backup removed after swap', !fs.existsSync(bakDir), (v) => v === true);
    check('happy path: tmpDir gone', !fs.existsSync(tmpDir), (v) => v === true);
    clean();
  }

  // (a3) first upload (no live dir yet): rename of missing dir is skipped.
  {
    clean();
    const result = await downloadProfileMedia(UID, ['a1'], atts());
    check('first upload (no live dir): ok:true', result, (r) => r && r.ok === true, JSON.stringify(result));
    check('first upload: file lands in new dir', fs.existsSync(path.join(dir, 'a1_new.png')), (v) => v === true);
    check('first upload: no .bak created', !fs.existsSync(bakDir), (v) => v === true);
    clean();
  }

  // (b) ENOSPC mid-loop: fail() returned, live dir intact, tmpDir discarded.
  {
    seedOldPhoto();
    const realWrite = fs.writeFileSync;
    fs.writeFileSync = () => { throw Object.assign(new Error('ENOSPC: injected'), { code: 'ENOSPC' }); };
    let threw = null, result = null;
    try { result = await downloadProfileMedia(UID, ['a1'], atts()); }
    catch (e) { threw = e; }
    fs.writeFileSync = realWrite;
    check('ENOSPC mid-loop: nothing throws', threw, (t) => t === null);
    check('ENOSPC mid-loop: fail() returned', result, (r) => r && r.ok === false, JSON.stringify(result));
    check('ENOSPC mid-loop: live dir intact', fs.existsSync(path.join(dir, 'old_photo.png')), (v) => v === true);
    check('ENOSPC mid-loop: tmpDir discarded', !fs.existsSync(tmpDir), (v) => v === true);
    clean();
  }

  // (c) ftyp/heif brand sniffs as photo, so the relay accepts it like media.js does.
  {
    const B = (s) => Buffer.from(s, 'binary');
    const heif = Buffer.concat([B('\x00\x00\x00\x18'), B('ftyp'), B('heif'), B('\x00\x00\x00\x00')]);
    check('ftyp/heif sniffs as photo', sniffCategory(heif), (v) => v === 'photo', String(sniffCategory(heif)));
    check("sniffMatches('photo', ftyp/heif) is true", sniffMatches('photo', heif), (v) => v === true);
    const isom = Buffer.concat([B('\x00\x00\x00\x18'), B('ftyp'), B('isom'), B('\x00\x00\x00\x00')]);
    check('ftyp/isom still sniffs as av-container (unchanged)', sniffCategory(isom),
      (v) => v === 'av-container', String(sniffCategory(isom)));
    check('av-container still rejected for declared photo (unchanged)', sniffMatches('photo', isom), (v) => v === false);
    const heic = Buffer.concat([B('\x00\x00\x00\x18'), B('ftyp'), B('heic'), B('\x00\x00\x00\x00')]);
    check('ftyp/heic still sniffs as photo (unchanged)', sniffCategory(heic), (v) => v === 'photo', String(sniffCategory(heic)));
  }

  clean();
  globalThis.fetch = suiteFetch;
}


// ---------------------------------------------------------------------------
// C3-COMMANDS. cycle-3 patch regressions for the experimental bot: blocker
// gets their own conclusion-card role/copy, /report trims fields before
// safety.createReport.
// Merged from regression-sections/patch-commands3-section.mjs (13 tests); uses the
// suite harness (ok, reset); bot modules arrive via dynamic import inside the block.
// ---------------------------------------------------------------------------
{
  // ---- cycle-3 merge prologue: reproduce the section's standalone isolation ----
  {
    const { rmSync: rmDir } = await import('node:fs');
    const { default: nodePath } = await import('node:path');
    const { paths: cfgPaths } = await import('../src/config.js');
    process.env.DATA_DIR = '/tmp/patch-commands3-data';
    rmDir(process.env.DATA_DIR, { recursive: true, force: true });
    cfgPaths.dataDir = nodePath.resolve(process.env.DATA_DIR);
    cfgPaths.dbFile = nodePath.join(cfgPaths.dataDir, 'db.json');
    cfgPaths.mediaDir = nodePath.join(cfgPaths.dataDir, 'media');
  }
  reset();

  const embeds = await import('../src/utils/embeds.js');
  const report = await import('../src/commands/report.js');
  const { db } = await import('../src/services/database.js');
  const { readFileSync: readSrc } = await import('node:fs');

  function check(label, cond, detail = '') {
    ok(cond, `[c3-commands] ${label}${detail ? ' :: ' + detail : ''}`);
  }

  const cardText = (card) => {
    const out = [];
    const walk = (c) => {
      if (!c || typeof c !== 'object') return;
      if (typeof c.content === 'string') out.push(c.content);
      (c.components || []).forEach(walk);
    };
    (card || []).forEach(walk);
    return out.join('\n');
  };

  // ---------- nit 1: blocker role on the conclusion card ----------
  {
    const blocker = cardText(embeds.statusReconnectCard('blocker', 's1'));
    check('blocker role exists and names the block',
      blocker.includes('You blocked this stranger'), `got: ${blocker.slice(0, 80)}`);
    check('blocker role does not reuse the ender copy',
      !blocker.includes('You ended the chat'));
    check('blocker card is one unbroken paragraph', !blocker.includes('\n'));
    check('blocker card keeps /new in backticks', blocker.includes('`/new`'));
    check('blocker card still invites an optional rating',
      blocker.includes('👍') && blocker.includes('👎'));

    const ender = cardText(embeds.statusReconnectCard('ender', 's1'));
    check('ender copy unchanged', ender.includes('You ended the chat'));

    const disconnected = cardText(embeds.statusReconnectCard('disconnected', 's1'));
    check('blocked-partner copy unchanged',
      disconnected.includes('Your chat partner disconnected.') && !disconnected.includes('blocked'));

    const chatSrc = readSrc('./src/services/chat.js', 'utf8');
    const blockLine = chatSrc.split('\n').find((l) => l.includes("trigger === 'block'")) || '';
    check("chat.js maps the blocking actor to role 'blocker'",
      /trigger === 'block'/.test(blockLine) && /'blocker'/.test(blockLine), `line: ${blockLine.trim()}`);
    check("chat.js keeps the blocked partner on 'disconnected'",
      /'disconnected'/.test(blockLine), `line: ${blockLine.trim()}`);
  }

  // ---------- nit 2: report reason/description trimmed before createReport ----------
  {
    db._resetForTests();
    const modalIx = (uid, target, reason, desc, n) => ({
      id: `mint${n}`, token: `mtok${n}`, type: 5,
      user: { id: uid, username: 'r' },
      data: {
        custom_id: `report_modal:${target}`,
        components: [{ type: 1, components: [
          { type: 4, custom_id: 'report_reason', value: reason },
          { type: 4, custom_id: 'report_description', value: desc },
        ] }],
      },
    });

    const before = db.db.reports.length;
    await report.handleInteraction(modalIx('r1', 't1', '  harassment  ', '  some details here  ', 1));
    check('padded report still files (non-empty after trim)',
      db.db.reports.length === before + 1);
    const stored = db.db.reports[db.db.reports.length - 1] || {};
    check('stored reason is trimmed', stored.reason === 'harassment', `got: ${JSON.stringify(stored.reason)}`);
    check('stored description is trimmed',
      stored.description === 'some details here', `got: ${JSON.stringify(stored.description)}`);

    const before2 = db.db.reports.length;
    await report.handleInteraction(modalIx('r2', 't2', '   ', '\t  ', 2));
    check('whitespace-only fields still rejected',
      db.db.reports.length === before2);
  }
}


// ---------------------------------------------------------------------------
// DB3. database.js blocks-cap mixed-`at` comparator + purge persistence +
//      active-session :swaps exemption (cycle-3 persistence hunt).
// Merged from regression-sections/patch-db3-section.mjs (16 tests); uses the
// suite harness (ok, reset, db, rmSync, writeFileSync, mkdirSync, readFileSync).
// ---------------------------------------------------------------------------
{
    // ---- cycle-3 merge prologue: reproduce the section's standalone isolation ----
  {
      const { rmSync: rmDir } = await import('node:fs');
      const { default: nodePath } = await import('node:path');
      const { paths: cfgPaths } = await import('../src/config.js');
      process.env.DATA_DIR = '/tmp/patch-db3-data';
      rmDir(process.env.DATA_DIR, { recursive: true, force: true });
      cfgPaths.dataDir = nodePath.resolve(process.env.DATA_DIR);
      cfgPaths.dbFile = nodePath.join(cfgPaths.dataDir, 'db.json');
      cfgPaths.mediaDir = nodePath.join(cfgPaths.dataDir, 'media');
    }
    reset();
    // The DB2 block neutralized db.save (own-property no-op) for its own disk
    // isolation; B4 below needs real flush() persistence, so restore the
    // prototype method. This also leaves sane state for later blocks.
    delete db.save;

    const path = (await import('node:path')).default;
  const { statSync } = await import('node:fs');
  const DIR = process.env.DATA_DIR;
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });

  const writeDb = (payload) => writeFileSync(path.join(DIR, 'db.json'), JSON.stringify(payload));
  const readDb = () => JSON.parse(readFileSync(path.join(DIR, 'db.json'), 'utf8'));
  const emptyPayload = () => ({
    profiles: {}, bans: {}, blocks: {}, reports: [], shares: {}, dms: {},
    onboard_drafts: {}, recentPartners: {}, reputation: {}, ratedSessions: {},
  });

  // ---- B3: blocks-cap comparator normalizes mixed `at` shapes ----------------
  {
    db._resetForTests();
    const mine = {};
    const base = Date.UTC(2025, 0, 1);
    for (let i = 0; i < 200; i++) mine[`iso_${i}`] = { at: new Date(base + i * 1000).toISOString(), anonId: 'a'.repeat(8) };
    const newestEpoch = Date.now(); // stringifies to "17899…", sorts before "2025-…" raw
    mine.epoch_new = { at: newestEpoch, anonId: 'b'.repeat(8) };
    const p = emptyPayload(); p.blocks = { u1: mine };
    writeDb(p); db.load();
    ok(db.db.blocks.u1.epoch_new !== undefined, '[c3-db] B3: chronologically-newest epoch-ms entry survives the 200 cap');
    ok(db.db.blocks.u1.iso_0 === undefined, '[c3-db] B3: oldest ISO entry is the one evicted');
    ok(Object.keys(db.db.blocks.u1).length === 200, '[c3-db] B3: cap still trims to exactly 200');

    // Missing `at` still evicts first (fail-safe), and a mid-range epoch lands mid-order.
    db._resetForTests();
    const mine2 = {};
    for (let i = 0; i < 199; i++) mine2[`iso_${i}`] = { at: new Date(base + i * 1000).toISOString(), anonId: 'a'.repeat(8) };
    mine2.no_at = { anonId: 'c'.repeat(8) };
    mine2.epoch_mid = { at: base + 50 * 1000, anonId: 'd'.repeat(8) }; // same instant as iso_50
    const p2 = emptyPayload(); p2.blocks = { u1: mine2 };
    writeDb(p2); db.load();
    ok(db.db.blocks.u1.no_at === undefined, '[c3-db] B3: entry with missing `at` is evicted first');
    ok(db.db.blocks.u1.epoch_mid !== undefined, '[c3-db] B3: epoch-ms entry equivalent to iso_50 survives');
    ok(db.db.blocks.u1.iso_0 !== undefined, '[c3-db] B3: with a fail-safe eviction available, the oldest ISO entry survives');
    ok(Object.keys(db.db.blocks.u1).length === 200, '[c3-db] B3: second scenario still trims to exactly 200');
  }

  // ---- B4: load()-time purge of corrupt entries persists ----------------------
  {
    db._resetForTests();
    const p = emptyPayload();
    p.ratedSessions = { good: { u1: 'a', u2: 'b', rated: [], at: '2026-01-01T00:00:00.000Z' }, bad1: null, bad2: 'junk' };
    p.shares = { 's:u': { count: 1, last_share: 1 }, bad3: null, bad4: [1, 2] };
    writeDb(p); db.load();
    await db.flush();
    const onDisk = readDb();
    ok(!('bad1' in onDisk.ratedSessions) && !('bad2' in onDisk.ratedSessions), '[c3-db] B4: corrupt ratedSessions entries gone from db.json after load()');
    ok(!('bad3' in onDisk.shares) && !('bad4' in onDisk.shares), '[c3-db] B4: corrupt shares entries gone from db.json after load()');
    ok('good' in onDisk.ratedSessions && 's:u' in onDisk.shares, '[c3-db] B4: valid entries untouched by the purge');

    // Clean file -> no write happens at load (mtime unchanged).
    const before = statSync(path.join(DIR, 'db.json')).mtimeMs;
    await new Promise((r) => setTimeout(r, 15));
    db.load();
    await db.flush();
    const after = statSync(path.join(DIR, 'db.json')).mtimeMs;
    ok(before === after, '[c3-db] B4: load() with nothing to purge does not rewrite db.json');
  }

  // ---- INT4: active-session `:swaps` keys exempt from the 500-share eviction --
  {
    db._resetForTests();
    const sess = db.createChatSession('uA', 'uB');
    const sid = sess.session_id;
    db.db.shares[`${sid}:swaps`] = { count: 2, last_share: 1000 }; // stale stamp, long-lived session
    for (let i = 0; i < 501; i++) db.db.shares[`other${i}:u${i}`] = { count: 1, last_share: 2000 + i };
    db.recordUsernameShare('noise', 'uZ'); // triggers the 500-cap sweep
    const rec = db.db.shares[`${sid}:swaps`];
    ok(rec !== undefined && rec.count === 2, '[c3-db] INT4: active-session :swaps key survives heavy share traffic');
    ok(Object.keys(db.db.shares).length === 500, '[c3-db] INT4: cap still enforced at 500 total');

    // Ended session's :swaps key is NOT exempt anymore (stale stamp -> evicted).
    db.endChatSession(sid);
    for (let i = 0; i < 40; i++) db.db.shares[`extra${i}:u${i}`] = { count: 1, last_share: 9000 + i };
    db.recordUsernameShare('noise2', 'uY');
    ok(db.db.shares[`${sid}:swaps`] === undefined, '[c3-db] INT4: ended-session :swaps key is evictable again');

    // Live :swaps key with a FRESH stamp also survives and normal keys still trim.
    db._resetForTests();
    const s2 = db.createChatSession('uC', 'uD');
    db.db.shares[`${s2.session_id}:swaps`] = { count: 1, last_share: Date.now() };
    for (let i = 0; i < 500; i++) db.db.shares[`k${i}:u${i}`] = { count: 1, last_share: 3000 + i };
    db.recordUsernameShare('n', 'm');
    ok(db.db.shares[`${s2.session_id}:swaps`] !== undefined, '[c3-db] INT4: fresh active :swaps key untouched');
    ok(Object.keys(db.db.shares).length === 500, '[c3-db] INT4: eviction still trims non-exempt keys first');
  }

  // Drain any debounced save() scheduled above so no timer fires after later
  // blocks repoint cfgPaths to their own DATA_DIR.
  await db.flush();
}


// ---------------------------------------------------------------------------
// C3-SESSION. share/chat session-lifecycle regressions (cycle 3).
// Merged from regression-sections/patch-session3-section.mjs (55 tests); uses the
// suite harness (ok); installs its own globalThis.fetch mock (faithful port of
// /tmp/repro-setup.mjs, incl. setFetchWrapper) and restores the previous mock
// at the end.
// ---------------------------------------------------------------------------
{
    // ---- cycle-3 merge prologue: reproduce the section's standalone isolation ----
  {
      const { rmSync: rmDir } = await import('node:fs');
      const { default: nodePath } = await import('node:path');
      const { paths: cfgPaths } = await import('../src/config.js');
      process.env.DATA_DIR = '/tmp/patch-session3-data';
      rmDir(process.env.DATA_DIR, { recursive: true, force: true });
      cfgPaths.dataDir = nodePath.resolve(process.env.DATA_DIR);
      cfgPaths.dbFile = nodePath.join(cfgPaths.dataDir, 'db.json');
      cfgPaths.mediaDir = nodePath.join(cfgPaths.dataDir, 'media');
    }
    reset();

  // ---- fetch mock (faithful port of /tmp/repro-setup.mjs) -----------------------
  const origFetchS3 = globalThis.fetch;
  const sent = [];
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // Magic bytes served for mocked CDN downloads, keyed by the URL's extension,
  // so the relay's content-sniffing layer sees realistic bytes.
  const magicForUrl = (u) => {
    if (u.includes('spoof')) return Buffer.from('SPOOF TEST FILE\nplain text, no image bytes\n', 'utf8');
    const ext = String(u.split('?')[0].split('.').pop() || '').toLowerCase();
    switch (ext) {
      case 'png': return PNG;
      case 'jpg': case 'jpeg': return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      case 'gif': return Buffer.from('GIF89a', 'ascii');
      case 'mp4': case 'mov': case 'm4v': return Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'ascii')]);
      case 'ogg': case 'opus': case 'oga': return Buffer.from('OggS\x00\x02\x00\x00', 'binary');
      case 'wav': return Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVE', 'ascii')]);
      case 'mp3': return Buffer.from('ID3\x04\x00\x00\x00\x00\x01\x02', 'binary');
      case 'txt': case 'md': return Buffer.from('just a plain text note\n', 'utf8');
      default: return PNG;
    }
  };
  const json = (o, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  let msgSeq = 0;
  const failDMFor = new Set();
  const failDownloadFor = new Set(); // url substring -> CDN download 500s
  // Wrap the mock so individual tests can hang/observe traffic.
  let fetchWrapper = null;
  const setFetchWrapper = (fn) => { fetchWrapper = fn; };

  const mockFetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('https://discord.com/api/v10')) {
      const method = (opts.method || 'GET').toUpperCase();
      let body = null;
      const b = opts.body;
      if (typeof b === 'string') { try { body = JSON.parse(b); } catch {} }
      else if (b && typeof b.get === 'function') { try { body = JSON.parse(b.get('payload_json')); } catch { body = {}; } body._multipart = true; }
      const rec = { url: u, method, body };
      sent.push(rec);
      if (u.endsWith('/users/@me/channels') && method === 'POST') {
        rec.resp = { id: `dm_${body?.recipient_id}` };
        return json(rec.resp);
      }
      const um = u.match(/\/users\/([A-Za-z0-9_]+)$/);
      if (um && method === 'GET') return json({ id: um[1], username: `user_${um[1]}`, global_name: null });
      if (method === 'POST') {
        const cm = u.match(/\/channels\/dm_([A-Za-z0-9_]+)\/messages$/);
        if (cm && failDMFor.has(cm[1])) {
          return json({ message: 'Cannot send messages to this user', code: 50007 }, 403);
        }
      }
      rec.resp = { id: `msg${++msgSeq}` };
      return json(rec.resp);
    }
    if (failDownloadFor.size && [...failDownloadFor].some((m) => u.includes(m))) {
      return new Response('download failed', { status: 500 });
    }
    return new Response(magicForUrl(u), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  };

  globalThis.fetch = async (url, opts = {}) =>
    fetchWrapper ? fetchWrapper(url, opts, mockFetch) : mockFetch(url, opts);

  try {
    // ---- dynamic tree imports -------------------------------------------------
    const { db } = await import('../src/services/database.js');
    const { safety } = await import('../src/services/safety.js');
    const { matchmaking } = await import('../src/services/matchmaking.js');
    const chat = await import('../src/services/chat.js');
    const newCmd = await import('../src/commands/new.js');
    const shareCmd = await import('../src/commands/share.js');
    const blockCmd = await import('../src/commands/block.js');
    const mediaUtils = await import('../src/utils/media.js');

    // ---- helpers --------------------------------------------------------------
    const str = (o) => JSON.stringify(o);
    const tick = (n = 10) => new Promise((res) => { const s = () => (n-- > 0 ? setImmediate(s) : res()); s(); });
    const lastEditOriginal = () => [...sent].reverse().find((s) => s.url.includes('/messages/@original'))?.body;
    const user = (id) => ({ id: String(id), username: `user_${id}`, global_name: null });
    const cmdIx = (name, uid) => ({ id: 'ix', token: 'tok', type: 2, user: user(uid), data: { name } });
    const btnIx = (customId, uid, { channelId = 'dm_x', messageId = 'm1', flags = 0 } = {}) => ({
      id: 'ix', token: 'tok', type: 3, user: user(uid), channel_id: channelId,
      data: { custom_id: customId }, message: { id: messageId, flags },
    });
    function dobForAge(age) {
      const n = new Date();
      let d = n.getUTCDate();
      const m = n.getUTCMonth() + 1;
      if (m === 2 && d === 29) d = 28;
      const y = n.getUTCFullYear() - age;
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    const onboarded = (id) =>
      db.createProfile({ id: String(id), name: `user_${id}`, dob: dobForAge(20), interests: [] });
    async function matchPair(a, b) {
      onboarded(a); onboarded(b);
      await newCmd.execute(cmdIx('new', a));
      sent.length = 0;
      await newCmd.execute(cmdIx('new', b));
      sent.length = 0;
    }
    // Section-local reset (mirrors repro-setup.mjs); the suite harness reset()
    // runs once in the merge prologue above.
    const resetS3 = () => {
      db._resetForTests();
      matchmaking._resetForTests();
      chat._resetRelayForTests();
      chat._resetModForTests();
      chat._resetFizzleForTests();
      if (chat._resetClosedDmForTests) chat._resetClosedDmForTests();
      if (chat._resetClosedDmForTests) chat._resetClosedDmForTests();
      failDMFor.clear();
      failDownloadFor.clear();
      setFetchWrapper(null);
      sent.length = 0;
    };
    const dmPosts = (uid) => sent.filter((s) => s.url.includes(`/channels/dm_${uid}/messages`) && s.method === 'POST');
    const dmPatches = (uid) => sent.filter((s) => s.url.includes(`/channels/dm_${uid}/messages`) && s.method === 'PATCH');
    const dmTexts = (uid) => dmPosts(uid).map((s) => JSON.stringify(s.body)).join('\n');
    const check = (name, cond) => ok(cond, `[c3-session] ${name}`);

    // ================= share.js =================

    // B1: unexpected throw inside the reservation span rolls everything back.
    resetS3();
    await matchPair('A', 'B');
    await shareCmd.execute(cmdIx('share', 'A'));
    const sid1 = db.getActiveSessionForUser('A').session_id;
    const origGetProfile = db.getUserProfile;
    db.getUserProfile = () => { throw new Error('simulated mid-swap throw'); };
    let rejected = null;
    try {
      await shareCmd.handleInteraction(btnIx(`share_accept:${sid1}`, 'B', { channelId: 'dm_B', messageId: 'req1' }));
    } catch (err) { rejected = err; }
    db.getUserProfile = origGetProfile;
    check('B1: unexpected throw is rethrown (not swallowed)', !!rejected);
    check('B1: cap slot rolled back', !db.db.shares[`${sid1}:swaps`]);
    check('B1: requester cooldown rolled back', db.getShareData(sid1, 'A').last_share === 0);
    check('B1: accepter cooldown rolled back', db.getShareData(sid1, 'B').last_share === 0);

    // B2: rollback restores the :swaps record byte-exactly (count + last_share).
    resetS3();
    await matchPair('C', 'D');
    await shareCmd.execute(cmdIx('share', 'C'));
    const sid2 = db.getActiveSessionForUser('C').session_id;
    await shareCmd.handleInteraction(btnIx(`share_accept:${sid2}`, 'D', { channelId: 'dm_D', messageId: 'r1' }));
    const swapsBefore = { ...db.db.shares[`${sid2}:swaps`] };
    check('B2 setup: one swap recorded', swapsBefore.count === 1 && swapsBefore.last_share > 0);
    db.db.shares[`${sid2}:C`].last_share = Date.now() - 61_000;
    db.db.shares[`${sid2}:D`].last_share = Date.now() - 61_000;
    failDMFor.add('C'); // second swap's reveal DM to C fails
    sent.length = 0;
    await shareCmd.execute(cmdIx('share', 'C'));
    await shareCmd.handleInteraction(btnIx(`share_accept:${sid2}`, 'D', { channelId: 'dm_D', messageId: 'r2' }));
    failDMFor.clear();
    const swapsAfter = db.db.shares[`${sid2}:swaps`];
    check('B2: count restored', swapsAfter && swapsAfter.count === 1);
    check('B2: last_share restored byte-exactly', swapsAfter && swapsAfter.last_share === swapsBefore.last_share);

    // B3: partial delivery notifies BOTH sides.
    resetS3();
    await matchPair('E', 'F');
    await shareCmd.execute(cmdIx('share', 'E'));
    const sid3 = db.getActiveSessionForUser('E').session_id;
    failDMFor.add('E');
    sent.length = 0;
    await shareCmd.handleInteraction(btnIx(`share_accept:${sid3}`, 'F', { channelId: 'dm_F', messageId: 'r1' }));
    failDMFor.clear();
    check('B3: failed side gets the failure notice', /couldn't deliver a profile card/.test(dmTexts('E')));
    const fTexts = dmTexts('F');
    check('B3: delivered side is told the partner never got their card back',
      /never (got|saw) your/.test(fTexts));
    check('B3: delivered-side notice mentions retrying with /share', /\/share/.test(fTexts));

    // B4: 5-minute expiry notifies the requester and retires the live card.
    resetS3();
    await matchPair('G', 'H');
    await shareCmd.execute(cmdIx('share', 'G'));
    const sessionG = db.getActiveSessionForUser('G');
    const cardMsgId = dmPosts('H').at(-1).resp.id;
    check('B4 setup: live card location stored on the request', sessionG.shareRequest?.card?.messageId === cardMsgId);
    sessionG.shareRequest.at = Date.now() - 300_001;
    sent.length = 0;
    await shareCmd.execute(cmdIx('share', 'G')); // lazy expiry fires
    await tick();
    check('B4: requester is DM-notified the request expired', /expired/.test(dmTexts('G')));
    check('B4: the live request card is retired', !!dmPatches('H').find((p) => p.url.endsWith(`/messages/${cardMsgId}`)));
    // Boundary: exactly 300.000s is still live, 300.001s is expired.
    resetS3();
    await matchPair('G2', 'H2');
    await shareCmd.execute(cmdIx('share', 'G2'));
    const sessionG2 = db.getActiveSessionForUser('G2');
    sessionG2.shareRequest.at = Date.now() - 300_000;
    sent.length = 0;
    await shareCmd.execute(cmdIx('share', 'G2'));
    check('B4 boundary: 300.000s still live', /already sent a request/.test(str(sent[sent.length - 1]?.body)));
    sessionG2.shareRequest.at = Date.now() - 300_001;
    sent.length = 0;
    await shareCmd.execute(cmdIx('share', 'G2'));
    await tick();
    check('B4 boundary: 300.001s expired with notice', /expired/.test(dmTexts('G2')));

    // B5: bare-tap accept/decline edits the STORED card, not the tap's message.
    resetS3();
    await matchPair('I', 'J');
    await shareCmd.execute(cmdIx('share', 'I'));
    const sid5 = db.getActiveSessionForUser('I').session_id;
    const liveCardMsg = dmPosts('J').at(-1).resp.id;
    sent.length = 0;
    await shareCmd.handleInteraction(btnIx(`share_accept:${sid5}`, 'J', { channelId: 'dm_J', messageId: 'stale-wrong-card' }));
    const editedIds = dmPatches('J').map((p) => p.url.split('/messages/')[1]);
    check('B5: accept edits the STORED request card', editedIds.includes(liveCardMsg));
    check('B5: accept does NOT edit the tap message', !editedIds.includes('stale-wrong-card'));
    resetS3();
    await matchPair('I2', 'J2');
    await shareCmd.execute(cmdIx('share', 'I2'));
    const sid5b = db.getActiveSessionForUser('I2').session_id;
    const liveCardMsgB = dmPosts('J2').at(-1).resp.id;
    sent.length = 0;
    await shareCmd.handleInteraction(btnIx(`share_decline:${sid5b}`, 'J2', { channelId: 'dm_J2', messageId: 'stale-wrong-card' }));
    const editedIdsB = dmPatches('J2').map((p) => p.url.split('/messages/')[1]);
    check('B5: decline edits the STORED request card', editedIdsB.includes(liveCardMsgB));
    check('B5: decline does NOT edit the tap message', !editedIdsB.includes('stale-wrong-card'));

    // B6: block landing in the pre-send window aborts the swap.
    resetS3();
    await matchPair('K', 'L');
    await shareCmd.execute(cmdIx('share', 'K'));
    const sid6 = db.getActiveSessionForUser('K').session_id;
    sent.length = 0;
    let releaseUsers = null;
    setFetchWrapper((url, opts, next) => {
      const u = String(url);
      if (releaseUsers === null && /\/users\/(K|L)$/.test(u) && (opts.method || 'GET').toUpperCase() === 'GET') {
        return new Promise((res) => { releaseUsers = () => res(next(url, opts)); });
      }
      return next(url, opts);
    });
    const acceptP = shareCmd.handleInteraction(btnIx(`share_accept:${sid6}`, 'L', { channelId: 'dm_L', messageId: 'r1' }));
    await tick(5);
    safety.emergencyBlockUser('K', 'L', 'test block', { source: 'chat' });
    releaseUsers();
    await acceptP;
    setFetchWrapper(null);
    check('B6: no identity cards delivered to a blocked pair',
      !dmPosts('K').concat(dmPosts('L')).some((p) => /Here.s the person you.ve been chatting with/.test(str(p.body))));
    check('B6: reservation rolled back', !db.db.shares[`${sid6}:swaps`]);

    // Integration-1: banned user cannot complete a pending swap by button tap.
    resetS3();
    await matchPair('M', 'N');
    await shareCmd.execute(cmdIx('share', 'M'));
    const sidI = db.getActiveSessionForUser('M').session_id;
    db.banUser('N', 'test ban');
    sent.length = 0;
    await shareCmd.handleInteraction(btnIx(`share_accept:${sidI}`, 'N', { channelId: 'dm_N', messageId: 'r1' }));
    check('Int-1: banned accepter refused ephemerally', /not allowed/i.test(str(sent[sent.length - 1]?.body)));
    check('Int-1: no reveal cards go out',
      !dmPosts('M').concat(dmPosts('N')).some((p) => /Here.s the person you.ve been chatting with|They said yes/.test(str(p.body))));
    check('Int-1: pending request untouched', db.getActiveSessionForUser('M')?.shareRequest?.from === 'M');
    check('Int-1: cap untouched', !db.db.shares[`${sidI}:swaps`]);

    // ================= chat.js lifecycle =================

    // BUG 2: /end during the fizzle unwind must not requeue the ender.
    resetS3();
    onboarded('P'); onboarded('Q');
    failDMFor.add('Q'); // Q's greeting DM 50007s -> fizzle unwind
    let releasePatch = null;
    setFetchWrapper((url, opts, next) => {
      const u = String(url);
      if (!releasePatch && /\/messages\//.test(u) && (opts.method || 'GET').toUpperCase() === 'PATCH') {
        return new Promise((res) => { releasePatch = () => res(next(url, opts)); });
      }
      return next(url, opts);
    });
    const formP = chat.startChatSession('P', 'Q', db.getAnonId('P'), db.getAnonId('Q'));
    await tick(5);
    const greetP = sent.find((s) => s.url.includes('/channels/dm_P/messages') && s.method === 'POST');
    check('BUG2 setup: P has a live greeting card', !!greetP?.resp?.id);
    await chat.handleChatEnd(btnIx('chat_end', 'P', { channelId: 'dm_P', messageId: greetP?.resp?.id }));
    releasePatch();
    await formP;
    setFetchWrapper(null);
    failDMFor.clear();
    check('BUG2: ender is NOT silently requeued', !matchmaking.getQueuePosition('P'));
    check('BUG2: no fizzle "back in the queue" card sent to anyone',
      !sent.some((s) => s.method === 'POST' && /back in the queue/i.test(str(s.body))));

    // isSessionConcluding: synchronous in-flight guard.
    resetS3();
    onboarded('R'); onboarded('S');
    const s9 = await chat.startChatSession('R', 'S', db.getAnonId('R'), db.getAnonId('S'));
    const sid9 = s9.session_id;
    check('isSessionConcluding exported', typeof chat.isSessionConcluding === 'function');
    check('isSessionConcluding false when idle', chat.isSessionConcluding(sid9) === false);
    const conclP = chat.concludeSession(s9, 'manual', 'R');
    check('isSessionConcluding true while conclusion in flight', chat.isSessionConcluding(sid9) === true);
    await conclP;
    check('isSessionConcluding false after conclusion', chat.isSessionConcluding(sid9) === false);

    // BUG 5: relay parked mid-send, chat concluded meanwhile -> no delivery
    // reaction, no stats, sender told the chat ended.
    resetS3();
    onboarded('T'); onboarded('U');
    const s10 = await chat.startChatSession('T', 'U', db.getAnonId('T'), db.getAnonId('U'));
    let releaseVoice = null;
    setFetchWrapper((url, opts, next) => {
      const u = String(url);
      const b = opts.body;
      const isMultipart = b && typeof b.get === 'function';
      if (!releaseVoice && isMultipart && u.includes('/channels/dm_U/messages') && (opts.method || 'GET').toUpperCase() === 'POST') {
        return new Promise((res) => { releaseVoice = () => res(next(url, opts)); });
      }
      return next(url, opts);
    });
    const relayP = chat.handleDirectMessage({
      author: { id: 'T', bot: false }, channel_id: 'dm_T', guild_id: undefined, type: 0,
      id: 'mvoice1', content: '', flags: 0,
      attachments: [{
        url: 'https://cdn.discordapp.com/att1/voice.ogg', filename: 'voice.ogg',
        content_type: 'audio/ogg', size: 100, waveform: 'abc', duration_secs: 2,
      }],
    });
    await tick(5);
    await chat.concludeSession(s10, 'manual', 'U');
    releaseVoice();
    await relayP;
    setFetchWrapper(null);
    check('BUG5: no delivery reaction marked on a dead chat',
      !sent.some((s) => s.url.includes('/messages/mvoice1/reactions') && s.method === 'PUT'));
    check('BUG5: dead-chat stats not bumped', (s10.stats?.text || 0) === 0 && (s10.stats?.attachments || 0) === 0);
    check('BUG5: sender is told the chat ended', /ended/.test(dmTexts('T')));

    // ================= chat.js queue / db / media =================

    // Queue 3a: closed-DM users are recorded in the closed-DM set.
    resetS3();
    onboarded('V'); onboarded('W');
    failDMFor.add('V');
    await newCmd.execute(cmdIx('new', 'V'));
    await newCmd.execute(cmdIx('new', 'W'));
    failDMFor.clear();
    check('Q3a: closed-DM user recorded', chat.isClosedDmUser('V') === true);
    check('Q3a: reachable side not recorded', chat.isClosedDmUser('W') === false);

    // Queue 3b (corrected): the fizzle-pair cooldown branch never strands
    // anyone — both sides go back to the queue.
    resetS3();
    onboarded('X'); onboarded('Y');
    failDMFor.add('X');
    await newCmd.execute(cmdIx('new', 'Y'));
    await newCmd.execute(cmdIx('new', 'X')); // fizzle 1
    await newCmd.execute(cmdIx('new', 'X')); // fizzle 2
    await newCmd.execute(cmdIx('new', 'X')); // fizzle 3 -> pair blocked 5 min
    failDMFor.clear();
    check('Q3b setup: pair is fizzle-blocked', chat.fizzlePairBlocked('X', 'Y') === true);
    await newCmd.execute(cmdIx('new', 'X')); // hits the cooldown branch
    check('Q3b: closed-DM side not stranded', !!matchmaking.getQueuePosition('X'));
    check('Q3b: reachable side keeps its place', !!matchmaking.getQueuePosition('Y'));

    // Ban sweep: a ban landing mid-chat concludes it as 'partner_banned'.
    resetS3();
    onboarded('Z1'); onboarded('Z2');
    await chat.startChatSession('Z1', 'Z2', db.getAnonId('Z1'), db.getAnonId('Z2'));
    db.banUser('Z1', 'test ban');
    sent.length = 0;
    await chat.sweepIdleSessions(Date.now());
    check('ban sweep: session concluded (not left to time out)', !db.getActiveSessionForUser('Z2'));
    check('ban sweep: conclusion cards went out', dmPosts('Z2').length >= 1);

    // DB-B1: the DM-channel cache refreshes on hit (LRU, not FIFO).
    resetS3();
    db.db.dms = { u1: 'c1', u2: 'c2', u3: 'c3' };
    await chat.resolveDMChannel('u1');
    check('DB-B1: re-cached entry moves to the back',
      JSON.stringify(Object.keys(db.db.dms)) === JSON.stringify(['u2', 'u3', 'u1']));

    // Media-4: the relay download is byte-bounded (25MB stream rejected).
    resetS3();
    onboarded('M1'); onboarded('M2');
    await chat.startChatSession('M1', 'M2', db.getAnonId('M1'), db.getAnonId('M2'));
    const BIG_URL = 'https://cdn.discordapp.com/bigstream/clip.mp4';
    setFetchWrapper((url, opts, next) => {
      if (String(url) === BIG_URL) {
        const chunk = new Uint8Array(1024 * 1024);
        const ftyp = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
        let n = 0;
        const stream = new ReadableStream({
          pull(c) {
            if (n === 0) c.enqueue(Buffer.concat([ftyp, chunk.subarray(8)]));
            else if (n < 25) c.enqueue(chunk);
            else c.close();
            n++;
          },
        });
        return Promise.resolve(new Response(stream, { status: 200 }));
      }
      return next(url, opts);
    });
    sent.length = 0;
    await chat.handleDirectMessage({
      author: { id: 'M1', bot: false }, channel_id: 'dm_M1', guild_id: undefined, type: 0,
      id: 'mbig1', content: '', flags: 0,
      attachments: [{ url: BIG_URL, filename: 'clip.mp4', content_type: 'video/mp4', size: 100 }],
    });
    setFetchWrapper(null);
    check('Media-4: oversized stream NOT relayed',
      !dmPosts('M2').some((p) => /clip\.mp4/.test(str(p.body)) && p.body._multipart));
    check('Media-4: sender told the download failed', /couldn.t be downloaded/.test(dmTexts('M1')));
    check('Media-4: readBodyBounded exported from media.js', typeof mediaUtils.readBodyBounded === 'function');

    // Media-5: the too-big line is never swallowed; the message is marked.
    resetS3();
    onboarded('N1'); onboarded('N2');
    await chat.startChatSession('N1', 'N2', db.getAnonId('N1'), db.getAnonId('N2'));
    failDownloadFor.add('brokenfile');
    sent.length = 0;
    await chat.handleDirectMessage({
      author: { id: 'N1', bot: false }, channel_id: 'dm_N1', guild_id: undefined, type: 0,
      id: 'mmix1', content: '', flags: 0,
      attachments: [
        { url: 'https://cdn.discordapp.com/x/brokenfile.png', filename: 'brokenfile.png', content_type: 'image/png', size: 100 },
        { url: 'https://cdn.discordapp.com/x/huge.png', filename: 'huge.png', content_type: 'image/png', size: 25 * 1024 * 1024 },
      ],
    });
    failDownloadFor.clear();
    check('Media-5: failed-download notice carries the too-big line',
      /couldn.t be downloaded/.test(dmTexts('N1')) && /too big/.test(dmTexts('N1')));
    check('Media-5: message marked with a reaction',
      sent.filter((x) => x.url.includes('/messages/mmix1/reactions') && x.method === 'PUT').length === 1);
    sent.length = 0;
    await chat.handleDirectMessage({
      author: { id: 'N1', bot: false }, channel_id: 'dm_N1', guild_id: undefined, type: 0,
      id: 'mmix2', content: '', flags: 0,
      attachments: [
        { url: 'https://cdn.discordapp.com/x/huge2.png', filename: 'huge2.png', content_type: 'image/png', size: 25 * 1024 * 1024 },
      ],
    });
    check('Media-5: skippedBig-only path still notifies', /too big/.test(dmTexts('N1')));
    check('Media-5: skippedBig-only path marks the message',
      sent.filter((x) => x.url.includes('/messages/mmix2/reactions') && x.method === 'PUT').length === 1);

    // ================= new.js + block.js =================

    // new.js: caller dropped by attemptMatch gets the closed-DM explainer.
    resetS3();
    onboarded('O1'); onboarded('O2');
    failDMFor.add('O1');
    await newCmd.execute(cmdIx('new', 'O1'));
    await newCmd.execute(cmdIx('new', 'O2'));
    sent.length = 0;
    await newCmd.execute(cmdIx('new', 'O1'));
    failDMFor.clear();
    const editClosed = lastEditOriginal();
    check('new.js: closed-DM user gets the explainer', editClosed && /couldn.t reach you/.test(str(editClosed)) && /\/new/.test(str(editClosed)));
    check('new.js: explainer has no em dashes', editClosed && !/\u2014|\u2013/.test(str(editClosed)));

    // new.js: dropped caller NOT in the closed-DM set gets a terminal state.
    resetS3();
    onboarded('O3');
    const origFind = matchmaking.findMatch;
    matchmaking.findMatch = (uid) => { matchmaking.removeFromQueue(uid); return null; };
    sent.length = 0;
    await newCmd.execute(cmdIx('new', 'O3'));
    matchmaking.findMatch = origFind;
    const editTerminal = lastEditOriginal();
    check('new.js: dropped caller gets a terminal state', editTerminal && /search ended/.test(str(editTerminal)) && /\/new/.test(str(editTerminal)));

    // block.js BUG 1: concludeSession throw is answered honestly.
    resetS3();
    onboarded('B1'); onboarded('B2');
    await newCmd.execute(cmdIx('new', 'B1'));
    await newCmd.execute(cmdIx('new', 'B2'));
    const origEnd = db.endChatSession;
    db.endChatSession = () => { throw new Error('simulated DB-layer throw'); };
    let blockRejected = null;
    sent.length = 0;
    try {
      await blockCmd.execute(cmdIx('block', 'B1'));
    } catch (err) { blockRejected = err; }
    db.endChatSession = origEnd;
    check('block BUG1: interaction does not die unanswered', !blockRejected);
    const lastCb = [...sent].reverse().find((s) => s.url.includes('/interactions/') && s.body?.type)?.body;
    check('block BUG1: honest reply (chat may still be live, try /end)',
      lastCb && /may still be live/.test(str(lastCb)) && /\/end/.test(str(lastCb)));
  } finally {
    globalThis.fetch = origFetchS3; // no mock leakage into later suite sections
  }
}


// ---------------------------------------------------------------------------
// C3. gateway/router/rest/proxy-ws regression (cycle-3 bughunt).
// Merged from regression-sections/patch-gateway3-section.mjs (17 tests, 35
// assertions); feeds the suite harness `ok` (one call per assertion, names
// prefixed `[c3-gateway] `). Standalone isolation reproduced inside the block
// via dynamic `await import(...)` (never touches the suite's top-level
// imports); WebSocket + fetch are mocked per-test and restored at block end
// so nothing leaks.
// ---------------------------------------------------------------------------
{
  // ---- cycle-3 merge prologue: reproduce the section's standalone isolation ----
  {
    const { rmSync: rmDir } = await import('node:fs');
    rmDir('/tmp/patch3', { recursive: true, force: true });
  }
  reset();
  //
  // Fixes covered:
  //  Hunt 2 (B2a/B2b/B2c): INVALID_SESSION flag lifecycle - d=false clears
  //    _resumeInFlight and resets invalidSessionAttempts; the post-sleep resume
  //    is guarded by socket+session identity; the flag is generation-scoped so
  //    a stale chain cannot clobber a newer chain's flag.
  //  Hunt 6 (B6a/B6b/B6c): start()/stop() races - _epoch attempt identity:
  //    connect() captures it (post-fetch supersede check), the connect-timeout
  //    timer only clobbers this.ws on epoch match, scheduleReconnect(epoch)
  //    exits early when the epoch moved, onclose ignores stale sockets.
  //  Hunt 3 R3: heartbeat_interval now has an upper bound (3_600_000).
  //  Hunt 4 R4: router chain steps race against an 8s budget; on timeout the
  //    chain advances while the late step continues in the background.
  //  Hunt 5: catch-all falls back to a followup when callback 40060s AND
  //    edit-original 404s (exactly one visible outcome preserved).
  //  Integration-2: interaction-callback 429s fail fast (no retry); DM-send
  //    429s keep the 30s-capped retry; retry_after=0 sleeps 250ms.
  //  Hunt 8 S8a/S8b: proxy shim stops the handshake / frame dispatch once
  //    close() has been called (CLOSING/CLOSED guard).

  const EXP = '/home/hatch/workspace/anon-chat-remake-experimental/src';

  // ---- save the real globals so mocked WebSocket/fetch cannot leak ----
  const __realWS = globalThis.WebSocket;
  const __realFetch = globalThis.fetch;

  // ---------------------------------------------------------------------------
  // suite helpers
  // ---------------------------------------------------------------------------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function json(o, status = 200) {
    return new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  }
  function section(name) { console.log(`\n## ${name}`); }

  function setupEnv(tag) {
    process.env.DATA_DIR = `/tmp/patch3/data-sec-${tag}`;
    process.env.APPLICATION_ID = 'app123';
    process.env.DISCORD_TOKEN = 'MOCKTOKEN';
    process.env.LOG_LEVEL = 'error';
    for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy']) delete process.env[k];
  }

  function makeFakeWS(instances) {
    return class FakeWS {
      static OPEN = 1; static CONNECTING = 0; static CLOSING = 2; static CLOSED = 3;
      constructor(url) {
        this.url = url; this.readyState = 0;
        this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
        this.sent = []; this.closeCalls = [];
        instances.push(this);
      }
      send(payload) { try { this.sent.push(JSON.parse(payload)); } catch { this.sent.push(payload); } }
      close(code, reason) { this.closeCalls.push([code, reason]); this.readyState = 2; }
      open() { this.readyState = 1; if (this.onopen) this.onopen(); }
      deliver(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
      drop(code = 1006, reason = '') { this.readyState = 3; if (this.onclose) this.onclose({ code, reason }); }
    };
  }
  function fakeLiveSocket() {
    return {
      readyState: 1, sent: [], closeCalls: [],
      send(p) { try { this.sent.push(JSON.parse(p)); } catch {} },
      close(c, r) { this.closeCalls.push([c, r]); },
    };
  }
  async function freshDb(tag) {
    const { rmSync } = await import('node:fs');
    rmSync(process.env.DATA_DIR, { recursive: true, force: true });
    const { db } = await import(`${EXP}/services/database.js`);
    db.load();
    return db;
  }
  async function wireConfig() {
    const path = (await import('node:path')).default;
    const { paths } = await import(`${EXP}/config.js`);
    paths.dataDir = path.resolve(process.env.DATA_DIR);
    paths.dbFile = path.join(paths.dataDir, 'db.json');
    paths.mediaDir = path.join(paths.dataDir, 'media');
  }
  const inv = (d) => JSON.stringify({ op: 9, d });

  const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
  async function makeShim(ProxyWebSocket) {
    const net = (await import('node:net')).default;
    const ws = new ProxyWebSocket('wss://127.0.0.1:9/', 'http://127.0.0.1:1/');
    ws._start = () => {};
    ws._sock = new net.Socket();
    return ws;
  }
  function textFrame(str) {
    const payload = Buffer.from(str, 'utf8');
    const mask = Buffer.from([1, 2, 3, 4]);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
    return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
  }

  // ---------------------------------------------------------------------------
  // the regression tests
  // ---------------------------------------------------------------------------

  const tests = [];
  const t = (name, run) => tests.push({ name, run });

  // -- Hunt 2 ---------------------------------------------------------------

  t('B2a: d=false clears _resumeInFlight; new session d=true starts its own chain', async () => {
    setupEnv('s2a');
    const { Gateway } = await import(`${EXP}/discord/gateway.js`);
    const gw = new Gateway(async () => {});
    gw.ws = fakeLiveSocket(); gw.sessionId = 'sess-A'; gw.seq = 5;
    const chain1 = gw.handleMessage(inv(true));
    await sleep(80);
    ok(gw._resumeInFlight === true, '[c3-gateway] chain1 holds the in-flight flag while sleeping');
    await gw.handleMessage(inv(false));
    ok(gw._resumeInFlight === false, '[c3-gateway] d=false clears _resumeInFlight');
    ok(gw.invalidSessionAttempts === 0, '[c3-gateway] d=false resets invalidSessionAttempts');
    gw.ws = fakeLiveSocket(); gw.sessionId = 'sess-B'; gw.seq = 6;
    const before = gw.invalidSessionAttempts;
    gw.handleMessage(inv(true));
    await sleep(20);
    ok(gw.invalidSessionAttempts === before + 1, "[c3-gateway] new session's d=true is not swallowed as duplicate");
    await chain1;
    await gw.stop();
  });

  t('B2b: stale chain never resumes after d=false (no RESUME {session_id:null} on the fresh socket)', async () => {
    setupEnv('s2b');
    const { Gateway } = await import(`${EXP}/discord/gateway.js`);
    const gw = new Gateway(async () => {});
    gw.ws = fakeLiveSocket(); gw.sessionId = 'sess-old'; gw.seq = 7;
    const chain1 = gw.handleMessage(inv(true));
    await sleep(80);
    await gw.handleMessage(inv(false));
    const ws2 = fakeLiveSocket();
    gw.ws = ws2;
    await chain1;
    await sleep(50);
    ok(ws2.sent.filter((p) => p.op === 6).length === 0, '[c3-gateway] stale chain sent no RESUME on the fresh socket');
    await gw.stop();
  });

  t('B2c: attempts on the new connection do not inherit the stale tally', async () => {
    setupEnv('s2c');
    const { Gateway } = await import(`${EXP}/discord/gateway.js`);
    const gw = new Gateway(async () => {});
    gw.ws = fakeLiveSocket(); gw.sessionId = 'sess-A'; gw.seq = 1;
    for (let i = 0; i < 3; i++) await gw.handleMessage(inv(true));
    await gw.handleMessage(inv(false));
    const ws2 = fakeLiveSocket();
    gw.ws = ws2; gw.sessionId = 'sess-B'; gw.seq = 2;
    for (let i = 0; i < 3; i++) await gw.handleMessage(inv(true));
    await sleep(50);
    ok(!ws2.closeCalls.some(([, r]) => r === 'invalid session retries exhausted'),
      '[c3-gateway] healthy socket not closed by a stale tally');
    await gw.stop();
  });

  t('B2-reg: concurrent d=true still serializes to exactly one RESUME (no regression)', async () => {
    setupEnv('s2r');
    const { Gateway } = await import(`${EXP}/discord/gateway.js`);
    const gw = new Gateway(async () => {});
    gw.ws = fakeLiveSocket(); gw.sessionId = 'sess-flap'; gw.seq = 42;
    await Promise.all([gw.handleMessage(inv(true)), gw.handleMessage(inv(true)), gw.handleMessage(inv(true))]);
    ok(gw.ws.sent.filter((p) => p.op === 6).length === 1, '[c3-gateway] exactly one RESUME for a flap burst');
    ok(gw.invalidSessionAttempts === 1, '[c3-gateway] attempt tally burned once for the burst');
    await gw.stop();
  });

  // -- Hunt 6 ---------------------------------------------------------------

  t('B6a: stop() during in-flight connect, then start() -> exactly 1 healthy socket', async () => {
    setupEnv('s6a');
    const instances = [];
    globalThis.WebSocket = makeFakeWS(instances);
    let releaseFetch1, fetchCalls = 0;
    const gate = new Promise((r) => { releaseFetch1 = r; });
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/gateway/bot')) {
        fetchCalls++;
        if (fetchCalls === 1) { await gate; throw new Error('mock: egress died mid-connect'); }
        return json({ url: 'ws://mock.invalid', shards: 1 });
      }
      return json({ id: 'x' });
    };
    const { Gateway } = await import(`${EXP}/discord/gateway.js`);
    const gw = new Gateway(async () => {});
    gw.connectTimeoutMs = 60000;
    const p1 = gw.start();
    await sleep(80);
    await gw.stop();
    const p2 = gw.start();
    await sleep(80);
    releaseFetch1();
    await sleep(150);
    const ws2 = instances[0];
    ws2.open();
    ws2.deliver({ op: 10, d: { heartbeat_interval: 100000 } });
    await sleep(1600);
    ok(instances.length === 1, `[c3-gateway] exactly 1 socket (got ${instances.length})`);
    ok(gw.ws === ws2, '[c3-gateway] live socket is the healthy replacement');
    await gw.stop();
    await Promise.allSettled([p1, p2]);
  });

  t('B6b: late onclose from the pre-stop socket is ignored', async () => {
    setupEnv('s6b');
    const instances = [];
    globalThis.WebSocket = makeFakeWS(instances);
    globalThis.fetch = async (url) =>
      String(url).endsWith('/gateway/bot') ? json({ url: 'ws://mock.invalid', shards: 1 }) : json({ id: 'x' });
    const { Gateway } = await import(`${EXP}/discord/gateway.js`);
    const gw = new Gateway(async () => {});
    gw.connectTimeoutMs = 60000;
    const p1 = gw.start();
    await sleep(80);
    const ws1 = instances[0];
    ws1.open();
    ws1.deliver({ op: 10, d: { heartbeat_interval: 60 } });
    await sleep(150);
    await gw.stop();
    const p2 = gw.start();
    await sleep(80);
    const ws2 = instances[1];
    ws2.open();
    ws2.deliver({ op: 10, d: { heartbeat_interval: 60 } });
    const ackTimer = setInterval(() => { try { ws2.deliver({ op: 11 }); } catch {} }, 30);
    if (typeof ackTimer.unref === 'function') ackTimer.unref();
    await sleep(150);
    ws1.drop(1006, 'late close from the pre-stop socket');
    await sleep(120);
    ok(gw.ws === ws2, '[c3-gateway] this.ws still the replacement socket');
    ok(gw.heartbeatTimer !== null, '[c3-gateway] replacement heartbeat timer survived the stale onclose');
    await sleep(1400);
    ok(instances.length === 2, `[c3-gateway] no spurious reconnect socket (got ${instances.length})`);
    clearInterval(ackTimer);
    await gw.stop();
    await Promise.allSettled([p1, p2]);
  });

  t('B6c: stale connect-timeout timer cannot clobber the healthy replacement', async () => {
    setupEnv('s6c');
    const instances = [];
    globalThis.WebSocket = makeFakeWS(instances);
    globalThis.fetch = async (url) =>
      String(url).endsWith('/gateway/bot') ? json({ url: 'ws://mock.invalid', shards: 1 }) : json({ id: 'x' });
    const { Gateway } = await import(`${EXP}/discord/gateway.js`);
    const gw = new Gateway(async () => {});
    gw.connectTimeoutMs = 150;
    const p1 = gw.start();
    await sleep(80);
    await gw.stop();
    const p2 = gw.start();
    await sleep(80);
    const ws2 = instances[1];
    ws2.open();
    ws2.deliver({ op: 10, d: { heartbeat_interval: 100000 } });
    await sleep(400);
    ok(gw.ws === ws2, '[c3-gateway] this.ws still the healthy replacement after the stale timer fired');
    await sleep(1200);
    ok(instances.length === 2, `[c3-gateway] no duplicate reconnect socket (got ${instances.length})`);
    await gw.stop();
    await Promise.allSettled([p1, p2]);
  });

  t('B6-reg: rapid start()x2 still yields a single connect (no regression)', async () => {
    setupEnv('s6r');
    const instances = [];
    globalThis.WebSocket = makeFakeWS(instances);
    globalThis.fetch = async (url) =>
      String(url).endsWith('/gateway/bot') ? json({ url: 'ws://mock.invalid', shards: 1 }) : json({ id: 'x' });
    const { Gateway } = await import(`${EXP}/discord/gateway.js`);
    const gw = new Gateway(async () => {});
    gw.connectTimeoutMs = 60000;
    const p1 = gw.start();
    const p2 = gw.start(); // must be a no-op
    await sleep(150);
    ok(instances.length === 1, `[c3-gateway] one connect for two rapid start() calls (got ${instances.length})`);
    await gw.stop();
    await Promise.allSettled([p1, p2]);
  });

  // -- Hunt 3 R3 --------------------------------------------------------------

  t('R3: absurd heartbeat_interval fails fast (no hot loop, no zombie suicide)', async () => {
    setupEnv('sr3');
    const { Gateway } = await import(`${EXP}/discord/gateway.js`);
    const gw = new Gateway(async () => {});
    const ws = fakeLiveSocket();
    gw.ws = ws;
    gw._helloResolve = () => {};
    await gw.handleMessage(JSON.stringify({ op: 10, d: { heartbeat_interval: 1e15 } }));
    await sleep(250);
    gw.clearHeartbeat();
    const beats = ws.sent.filter((p) => p.op === 1).length;
    ok(beats <= 3 && !ws.closeCalls.some(([, r]) => r === 'zombie'), '[c3-gateway] no heartbeat hot loop / zombie suicide');
    ok(ws.closeCalls.some(([, r]) => r === 'malformed HELLO'), '[c3-gateway] attempt failed fast (malformed HELLO close)');
    await gw.stop();
  });

  // -- Hunt 4 R4 --------------------------------------------------------------

  t('R4: wedged chain step does not park the queue; background step still completes', async () => {
    setupEnv('sr4');
    await wireConfig();
    const db = await freshDb('sr4');
    const uid = 'SR4';
    const n = new Date();
    db.createProfile({ id: uid, name: `user_${uid}`, dob: `${n.getUTCFullYear() - 20}-01-01`, interests: [] });
    let calls = 0;
    let slowFinished = false;
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (!u.startsWith('https://discord.com/api/v10')) return json({ id: 'x' });
      calls++;
      if (calls === 1) { await sleep(12000); slowFinished = true; } // stands in for a 429-capped retry
      return json({ id: 'msg1' });
    };
    const { routeInteraction } = await import(`${EXP}/router.js`);
    const mkIx = (tag) => ({
      id: `ix-${tag}`, token: `tok-${tag}`, type: 3,
      user: { id: uid, username: `user_${uid}`, global_name: null },
      data: { custom_id: `nope:${tag}` },
    });
    const p1 = routeInteraction(mkIx('slow'));
    await sleep(150);
    const t2 = Date.now();
    await routeInteraction(mkIx('queued'));
    const queuedElapsed = Date.now() - t2;
    ok(queuedElapsed < 10000, `[c3-gateway] queued interaction answered in ${queuedElapsed}ms (budget ~8s, wedge 12s)`);
    await p1; // note: p1 is the 8s budget race - it resolves BEFORE the wedge finishes
    const deadline = Date.now() + 8000;
    while (!slowFinished && Date.now() < deadline) await sleep(100);
    ok(slowFinished, '[c3-gateway] the wedged background step still ran to completion');
  });

  // -- Hunt 5 -----------------------------------------------------------------

  t('H5: callback 40060 + edit-original 404 -> exactly one followup fallback', async () => {
    setupEnv('sh5');
    await wireConfig();
    const db = await freshDb('sh5');
    const uid = 'SH5';
    const n = new Date();
    db.createProfile({ id: uid, name: `user_${uid}`, dob: `${n.getUTCFullYear() - 20}-01-01`, interests: [] });
    const sent = [];
    const acked = new Set();
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (!u.startsWith('https://discord.com/api/v10')) return json({ id: 'x' });
      const method = (opts.method || 'GET').toUpperCase();
      sent.push({ url: u, method });
      const cbm = u.match(/\/interactions\/([^/]+)\/([^/]+)\/callback$/);
      if (cbm && method === 'POST') {
        if (acked.has(cbm[2])) return json({ message: 'already acknowledged', code: 40060 }, 400);
        acked.add(cbm[2]);
        return json({ id: 'cb1' });
      }
      if (/\/webhooks\/app123\/tok-sh5\/messages\/@original$/.test(u)) {
        return json({ message: 'Unknown Message', code: 10008 }, 404);
      }
      return json({ id: 'msg1' });
    };
    const { routeInteraction } = await import(`${EXP}/router.js`);
    const modalIx = {
      id: 'ixsh5', token: 'tok-sh5', type: 5,
      user: { id: uid, username: `user_${uid}`, global_name: null },
      data: {
        custom_id: 'profile_update_name_modal',
        components: [{ type: 1, components: [{ type: 4, custom_id: 'profile_name_input', value: 'Hunt' }] }],
      },
    };
    const orig = db.updateUserProfile;
    db.updateUserProfile = () => { throw new Error('mock db outage'); };
    let rejected = false;
    try { await routeInteraction(modalIx); } catch { rejected = true; }
    db.updateUserProfile = orig;
    ok(!rejected, '[c3-gateway] routeInteraction does not reject');
    const followups = sent.filter((s) => s.method === 'POST' && /\/webhooks\/app123\/tok-sh5$/.test(s.url));
    ok(followups.length === 1, `[c3-gateway] exactly one followup fallback (got ${followups.length})`);
  });

  t('H5-reg: healthy catch-all path posts no followup (still at most one visible outcome)', async () => {
    setupEnv('sh5r');
    await wireConfig();
    const db = await freshDb('sh5r');
    const uid = 'SH5R';
    const n = new Date();
    db.createProfile({ id: uid, name: `user_${uid}`, dob: `${n.getUTCFullYear() - 20}-01-01`, interests: [] });
    const sent = [];
    const acked = new Set();
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (!u.startsWith('https://discord.com/api/v10')) return json({ id: 'x' });
      const method = (opts.method || 'GET').toUpperCase();
      sent.push({ url: u, method });
      const cbm = u.match(/\/interactions\/([^/]+)\/([^/]+)\/callback$/);
      if (cbm && method === 'POST') {
        if (acked.has(cbm[2])) return json({ message: 'already acknowledged', code: 40060 }, 400);
        acked.add(cbm[2]);
        return json({ id: 'cb1' });
      }
      return json({ id: 'msg1' }); // edit-original succeeds here
    };
    const { routeInteraction } = await import(`${EXP}/router.js`);
    const modalIx = {
      id: 'ixsh5r', token: 'tok-sh5r', type: 5,
      user: { id: uid, username: `user_${uid}`, global_name: null },
      data: {
        custom_id: 'profile_update_name_modal',
        components: [{ type: 1, components: [{ type: 4, custom_id: 'profile_name_input', value: 'Hunt' }] }],
      },
    };
    const orig = db.updateUserProfile;
    db.updateUserProfile = () => { throw new Error('mock db outage'); };
    await routeInteraction(modalIx);
    db.updateUserProfile = orig;
    const followups = sent.filter((s) => s.method === 'POST' && /\/webhooks\/app123\/tok-sh5r$/.test(s.url));
    ok(followups.length === 0, `[c3-gateway] no followup when the edit-original succeeded (got ${followups.length})`);
  });

  // -- Integration-2 ----------------------------------------------------------

  t('I2a: interaction-callback 429 fails fast with no retry', async () => {
    setupEnv('si2a');
    let calls = 0;
    globalThis.fetch = async (url) => {
      if (/\/interactions\/ix1\/tok1\/callback$/.test(String(url))) { calls++; return json({ retry_after: 5 }, 429); }
      return json({ id: 'x' });
    };
    const { Interactions, DiscordAPIError } = await import(`${EXP}/discord/rest.js`);
    const t0 = Date.now();
    let err = null;
    try { await Interactions.callback({ id: 'ix1', token: 'tok1' }, { type: 4, data: {} }); }
    catch (e) { err = e; }
    const elapsed = Date.now() - t0;
    ok(err instanceof DiscordAPIError && err.status === 429, '[c3-gateway] callback 429 surfaces as DiscordAPIError');
    ok(calls === 1, `[c3-gateway] no retry attempted (calls=${calls})`);
    ok(elapsed < 1000, `[c3-gateway] fails fast (${elapsed}ms)`);
  });

  t('I2b: retry_after=0 sleeps ~250ms, not ~1250ms', async () => {
    setupEnv('si2b');
    let calls = 0;
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.endsWith('/channels/chan1/messages')) { calls++; return calls === 1 ? json({ retry_after: 0 }, 429) : json({ id: 'm1' }); }
      return json({ id: 'x' });
    };
    const { Rest } = await import(`${EXP}/discord/rest.js`);
    const t0 = Date.now();
    const res = await Rest.sendMessage('chan1', { content: 'hi' });
    const elapsed = Date.now() - t0;
    ok(res?.id === 'm1', '[c3-gateway] DM send succeeds after the retry');
    ok(elapsed >= 150 && elapsed < 800, `[c3-gateway] retry_after=0 -> ~250ms (got ${elapsed}ms)`);
  });

  t('I2c: non-interaction 429s keep the capped retry', async () => {
    setupEnv('si2c');
    let calls = 0;
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/channels/chan2/messages')) { calls++; return calls === 1 ? json({ retry_after: 1 }, 429) : json({ id: 'm2' }); }
      return json({ id: 'x' });
    };
    const { Rest } = await import(`${EXP}/discord/rest.js`);
    const res = await Rest.sendMessage('chan2', { content: 'hi' });
    ok(res?.id === 'm2' && calls === 2, '[c3-gateway] DM-send 429 is still retried');
  });

  // -- Hunt 8 -----------------------------------------------------------------

  t('S8a: CONNECT 200 after close() does not advance the handshake', async () => {
    const { ProxyWebSocket, WS_CLOSING } = await import(`${EXP}/discord/proxy-ws.js`);
    const ws = await makeShim(ProxyWebSocket);
    const events = [];
    ws.onclose = (e) => events.push(['close', e.code]);
    ws.close(1000, 'test');
    ws._onTunnelData(Buffer.from('HTTP/1.1 200 Connection established\r\n\r\n'));
    ok(ws._phase === 'connect', `[c3-gateway] phase stays 'connect' (got '${ws._phase}')`);
    ok(ws.readyState === WS_CLOSING && events.length === 0, '[c3-gateway] stays CLOSING with no onclose');
  });

  t('S8b: 101 / frames after close() do not open the socket or dispatch', async () => {
    const { ProxyWebSocket, WS_CLOSING, WS_OPEN } = await import(`${EXP}/discord/proxy-ws.js`);
    const crypto = (await import('node:crypto')).default;
    const ws = await makeShim(ProxyWebSocket);
    const events = [];
    const msgs = [];
    ws.onopen = () => events.push('open');
    ws.onmessage = (m) => msgs.push(m.data);
    ws.close(1000, 'test');
    ws._phase = 'ws-handshake';
    const accept = crypto.createHash('sha1').update(ws._wsKey + WS_GUID).digest('base64');
    ws._onTlsData(Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`));
    ok(ws.readyState !== WS_OPEN, '[c3-gateway] readyState not clobbered to OPEN');
    ok(!events.includes('open'), '[c3-gateway] onopen not fired after close()');
    ws._phase = 'frames';
    ws._onTlsData(textFrame('hello'));
    ok(msgs.length === 0, '[c3-gateway] no onmessage dispatch while CLOSING');
    ok(ws.readyState === WS_CLOSING, '[c3-gateway] still CLOSING');
  });

  // ---------------------------------------------------------------------------
  // runner
  // ---------------------------------------------------------------------------

  for (const { name, run } of tests) {
    section(name);
    try { await run(); }
    catch (e) {
      ok(false, `[c3-gateway] ${name} :: THREW: ${e?.message}`);
      console.log(`  THREW: ${e?.stack || e}`);
    }
  }

  // ---- restore the real globals ----
  globalThis.WebSocket = __realWS;
  globalThis.fetch = __realFetch;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
