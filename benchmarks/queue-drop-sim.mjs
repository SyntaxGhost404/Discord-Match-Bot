// Empirical probe of the queue lifecycle (read-only w.r.t. the repo).
// Uses the REAL matchmaking.js; replicates the exact async call chains from
//   - src/commands/new.js      (execute -> attemptMatch -> findMatch -> takePair -> startChatSession)
//   - src/services/chat.js     (sweepMatchmaking -> tryMatchWaiters -> takePair -> startChatSession,
//                               startChatSession DM-failure branch)
//   - src/index.js             (30s setInterval)
// with a stubbed DM layer (controllable latency + failure), to see whether a
// waiter can leave the queue with no session and no notice.

import { matchmaking } from '../src/services/matchmaking.js';

const dmLog = [];              // [{ to, kind }]
const dmFailFor = new Set();   // userIds whose DM send fails
const DM_LATENCY_MS = 40;

async function sendDM(userId, kind) {
  await new Promise((r) => setTimeout(r, DM_LATENCY_MS));
  if (dmFailFor.has(String(userId))) return { ok: false, reason: 'dms_closed' };
  dmLog.push({ to: String(userId), kind });
  return { ok: true, channelId: 'c', messageId: 'm' };
}

// ---- faithful replica of chat.startChatSession (chat.js:355-381) ----
const sessions = new Map();
async function startChatSession(u1, u2) {
  const session = { id: `s_${Date.now()}`, u1: String(u1), u2: String(u2) };
  sessions.set(session.id, session);
  const [r1, r2] = await Promise.all([sendDM(u1, 'matched'), sendDM(u2, 'matched')]);
  if (!r1.ok || !r2.ok) {
    sessions.delete(session.id);
    const okId = r1.ok ? u1 : u2;
    await sendDM(okId, 'ended');
  }
  return session;
}

// ---- faithful replica of new.js attemptMatch (new.js:78-90) ----
async function attemptMatch(userId) {
  try {
    const match = matchmaking.findMatch(userId);
    if (match) await startChatSession(match.user1.user_id, match.user2.user_id);
  } catch (e) { console.log('  [attemptMatch swallowed]', e.message); }
}

// ---- faithful replica of chat.sweepMatchmaking (chat.js:88-97) ----
async function sweepMatchmaking() {
  try {
    const match = matchmaking.tryMatchWaiters();
    if (!match) return false;
    await startChatSession(match.user1.user_id, match.user2.user_id);
    return true;
  } catch (e) { console.log('  [sweep swallowed]', e.message); return false; }
}

// ---- faithful replica of new.js execute queue-join tail (new.js:58-70) ----
async function joinQueue(userId) {
  const added = matchmaking.addToQueue(userId, 'anon_' + userId);
  if (!added) return 'already-queued';
  await new Promise((r) => setTimeout(r, 25)); // replyV2 searching-card latency
  await attemptMatch(userId);
  return 'joined';
}

function reset() {
  matchmaking._resetForTests();
  dmLog.length = 0;
  dmFailFor.clear();
  sessions.clear();
}
const pos = (u) => matchmaking.getQueuePosition(u);
const dmsFor = (u) => dmLog.filter((d) => d.to === String(u)).map((d) => d.kind);

// Scenario 1: healthy DMs. A queued, B joins, A+B eligible (unknown dob -> minor tier, gap 0).
reset();
await joinQueue('A');
await joinQueue('B');
console.log('S1 healthy: posA=', pos('A'), 'posB=', pos('B'),
  '| sessions=', sessions.size, '| dmA=', dmsFor('A'), '| dmB=', dmsFor('B'));

// Scenario 2: A's DM fails. A queued, B joins a moment later -> B's /new triggers
// attemptMatch -> tryMatchWaiters pairs A+B -> takePair removes both -> DM to A fails.
reset();
await joinQueue('A');
dmFailFor.add('A');
await joinQueue('B');
console.log('S2 A-DM-fails/B-joins: posA=', pos('A'), 'posB=', pos('B'),
  '| sessions=', sessions.size, '| dmA=', dmsFor('A'), '| dmB=', dmsFor('B'),
  '<- A silently dropped?', pos('A') === null && sessions.size === 0 && dmsFor('A').length === 0);

// Scenario 3: same but via the 30s sweep instead of a join.
reset();
await joinQueue('A');
await joinQueue('B'); // both wait: make them ineligible for each other? they ARE eligible; instead:
reset();
await joinQueue('A');
await joinQueue('C');
dmFailFor.add('A');
await sweepMatchmaking();
console.log('S3 A-DM-fails/sweep: posA=', pos('A'), 'posC=', pos('C'),
  '| sessions=', sessions.size, '| dmA=', dmsFor('A'), '| dmC=', dmsFor('C'),
  '<- A silently dropped?', pos('A') === null && sessions.size === 0 && dmsFor('A').length === 0);

// Scenario 4: startChatSession throws AFTER takePair (hypothetical future regression):
// both waiters are removed, error swallowed by caller, nobody notified.
reset();
await joinQueue('A');
await joinQueue('B');
const match = matchmaking.findMatch('B'); // takePair already ran inside
console.log('S4 takePair-then-throw: posA=', pos('A'), 'posB=', pos('B'),
  '| (entries already gone before any DM is attempted)');
