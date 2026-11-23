// Live payload check: renders every card the bot can send (with sample data
// and a real uploaded photo), posts each one to a test channel so Discord's
// own validator accepts or rejects it, verifies that stored photos render via
// their unsigned CDN URL, and deletes everything it posted afterwards.
//
//   LIVE_CHECK_CHANNEL_ID=<channel id> npm run live-check
//
// Optional: LIVE_CHECK_DM_USER_ID=<user id> also verifies DM-based photo
// storage (posts one silent DM to that user and deletes it right away).

import { existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { Store } from '../src/db/store.ts';
import { MessageFlags } from '../src/discord/constants.ts';
import type { FileUpload, Message, MessagePayload } from '../src/discord/types.ts';
import { classic, container, gallery, text, v2 } from '../src/discord/components/builders.ts';
import { validateMessagePayload } from '../src/discord/components/validate.ts';
import { photoUrl, type Photo } from '../src/domain/profile.ts';
import { createLogger } from '../src/util/logger.ts';
import { sleep } from '../src/util/async.ts';
import { HOUR } from '../src/util/time.ts';
import { menuPayload } from '../src/features/menu.ts';
import { selfProfilePayload } from '../src/features/profile/handlers.ts';
import { discoverView, likesView, matchDetailView, matchesView } from '../src/features/matching/views.ts';
import { discoverEmptyCard, likeLimitCard, likeNoticeCard, matchCard, unmatchConfirmCard } from '../src/features/matching/ui.ts';
import {
  chatIntroCard,
  chatNotice,
  chatStatusCard,
  connectedCard,
  endedCard,
  icebreakerCard,
  revealCard,
  revealRequestedNotice,
  searchStoppedCard,
  searchingCard,
  summaryPayload,
} from '../src/features/chat/ui.ts';
import { blockedListPayload, settingsPayload } from '../src/features/settings.ts';
import { helpPayload, safetyPayload } from '../src/features/help.ts';
import { reportMessage, reportsListPayload, statsPayload, userCard, evidenceFile } from '../src/features/moderation.ts';
import { confirmAgeCard, photosStepCard, resumeCard, reviewCard, tooYoungCard, welcomeCard } from '../src/features/onboarding.ts';
import { embedNotice, errorPayload, notice, staleButtonPayload } from '../src/ui/common.ts';

const envFile = process.env.ENV_FILE ?? '.env';
if (existsSync(envFile)) process.loadEnvFile(envFile);
const channelId = process.env.LIVE_CHECK_CHANNEL_ID;
if (!channelId) {
  console.error('Set LIVE_CHECK_CHANNEL_ID to a channel the bot can post in.');
  process.exit(1);
}

const config = { ...loadConfig(), databasePath: ':memory:' };
const log = createLogger({ level: 'warn', format: config.log.format });
const app = await createApp({ config, log, store: Store.open(':memory:') });
const { store, api } = app;
const posted: Array<{ channelId: string; id: string }> = [];
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

/** A real 320×320 gradient PNG. */
function samplePng(): Uint8Array {
  const size = 320;
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const b of bytes) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      row[1 + x * 3] = 255;
      row[2 + x * 3] = Math.round((x / size) * 140) + 60;
      row[3 + x * 3] = Math.round((y / size) * 160) + 80;
    }
    rows.push(row);
  }
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]),
  );
}

async function post(name: string, payload: MessagePayload, files?: FileUpload[]): Promise<Message | null> {
  const local = validateMessagePayload(payload);
  try {
    const message = await api.createMessage(channelId!, { ...payload, flags: (payload.flags ?? 0) | MessageFlags.SuppressNotifications }, files);
    posted.push({ channelId: channelId!, id: message.id });
    results.push({ name, ok: local.length === 0, detail: local.length ? `accepted by Discord, but local validator flagged: ${JSON.stringify(local)}` : undefined });
    await sleep(350);
    return message;
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

// -- sample data ------------------------------------------------------------------

const now = app.clock();
const viewerId = '100000000000000001';
const otherId = '100000000000000002';
const teenId = '100000000000000003';
for (const [id, username] of [
  [viewerId, 'alex'],
  [otherId, 'sam'],
  [teenId, 'kit'],
] as const) {
  store.users.touch({ id, username }, 'en-US', now);
}
store.profiles.createDraft(viewerId, { name: 'Alex', languages: ['en'] }, now);
store.profiles.update(
  viewerId,
  { stage: 'complete', birthDate: '1999-04-12', gender: 'man', interests: ['music', 'gaming', 'coding'], lookingFor: ['friends', 'gaming'], languages: ['en', 'bn'], location: 'Dhaka', bio: 'Night owl, synthwave fan and terrible at chess.', completedAt: now },
  now,
);
store.profiles.createDraft(otherId, { name: 'Sam', languages: ['en'] }, now);
store.profiles.update(
  otherId,
  { stage: 'complete', birthDate: '1998-08-30', gender: 'woman', interests: ['music', 'art', 'travel', 'gaming'], lookingFor: ['friends', 'chat'], languages: ['en'], location: 'Lisbon', bio: 'Illustrator. Ask me about my cat.\nAlways up for a co-op game.', completedAt: now },
  now,
);
store.profiles.createDraft(teenId, { name: 'Kit', languages: ['en'] }, now);
store.profiles.update(teenId, { stage: 'confirm', birthDate: '2010-02-01', gender: 'nonbinary' }, now);

// Upload a photo exactly like the photo pipeline does, and attach it to Sam.
const storage = await post('photo storage message (classic + attachment)', classic({ content: '📸 Profile photos · live check' }), [{ name: 'photo-1.png', data: samplePng(), contentType: 'image/png' }]);
if (storage?.attachments[0]) {
  const a = storage.attachments[0];
  store.photos.replace(otherId, [{ channelId: storage.channel_id, messageId: storage.id, attachmentId: a.id, filename: a.filename, contentType: a.content_type ?? 'image/png', width: a.width ?? null, height: a.height ?? null, size: a.size }], now);
}
const photos: Photo[] = store.photos.list(otherId);
const viewer = app.matching.profile(viewerId)!;
const other = app.matching.profile(otherId)!;

// -- every card ---------------------------------------------------------------------

await post('onboarding: welcome', welcomeCard(app));
await post('onboarding: resume', resumeCard(store.profiles.get(teenId)!));
await post('onboarding: confirm age (teen)', confirmAgeCard(store.profiles.get(teenId)!, now));
await post('onboarding: confirm age (adult)', confirmAgeCard(viewer, now));
await post('onboarding: photos step', photosStepCard(app, 'Example error line'));
await post('onboarding: review', reviewCard(app, other));
await post('onboarding: too young', tooYoungCard(now + 365 * 24 * HOUR));
await post('menu', menuPayload(app, viewerId));
await post('profile (self)', selfProfilePayload(app, otherId, '✅ Saved!'));
const discover = await post('discover card', discoverView(app, viewerId));
await post('discover empty', discoverEmptyCard('✅ Thanks — your report was sent to the moderators.'));
await post('like limit', likeLimitCard(now + 5 * HOUR, 2));
store.swipes.record(otherId, viewerId, 'like', 'Hey! You like synthwave too? 🎶', now);
await post('likes inbox', likesView(app, viewerId));
const { match } = store.matches.create(viewerId, otherId, 'discover', now);
await post('match card', matchCard(other, photos, match, { now, viewer, continueWith: 'discover' }));
await post('matches list', matchesView(app, viewerId, 0));
await post('match detail', matchDetailView(app, viewerId, match.id));
await post('unmatch confirm', unmatchConfirmCard(other, match));
await post('like notification', likeNoticeCard(3));

store.chat.enqueue(viewerId, now);
store.chat.enqueue(otherId, now);
const session = store.chat.createSession(viewerId, otherId, false, now)!;
await post('chat intro', chatIntroCard(false));
await post('chat intro (teen)', chatIntroCard(true));
await post('chat searching', searchingCard(now - 60_000));
await post('chat connected', connectedCard(session, viewer, other));
await post('chat status', chatStatusCard(session, 'a'));
const ended = store.chat.end(session.id, 'ended', otherId, now + 12 * 60_000)!;
await post('chat ended card', endedCard(ended));
await post('chat summary (classic embed)', summaryPayload(ended, 'a', 'partner', { allowFeedback: true }));
await post('chat reveal', revealCard(other, photos, otherId, now));
await post('chat icebreaker', icebreakerCard("What's a song you've had on repeat lately?"));
await post('chat reveal requested', revealRequestedNotice());
await post('chat search stopped', searchStoppedCard('timeout'));
await post('chat notice', chatNotice('🌱 Links are removed in teen chats to keep everyone safe.'));

await app.safety.block(viewerId, teenId, 'chat');
await post('settings', settingsPayload(app, viewerId, '✅ Filters saved.'));
await post('blocked list', blockedListPayload(app, viewerId, 0));
await post('help', helpPayload(app, viewerId));
await post('safety tips', safetyPayload(app, viewerId));

const report = store.reports.create(
  {
    reporterId: viewerId,
    targetId: otherId,
    context: 'chat',
    reason: 'harassment',
    details: 'Kept sending rude messages after I asked them to stop.',
    evidence: [
      { at: now, from: 'reporter', text: 'hi!' },
      { at: now + 1000, from: 'reported', text: 'example message' },
    ],
  },
  now,
);
const file = evidenceFile(report)!;
const reportPayload = reportMessage(app, report);
reportPayload.attachments = [{ id: 0, filename: file.name, description: 'Chat transcript as seen by the reporter' }];
await post('mod: report (classic embed + evidence file)', reportPayload, [file]);
await post('mod: user card', userCard(app, otherId, '🔨 Example note'));
await post('mod: stats', statsPayload(app));
await post('mod: open reports', reportsListPayload(app));
await post('notice (V2)', notice('Example notice', 'success'));
await post('notice (embed)', embedNotice('Example embed notice', 'warning', 'Title'));
await post('error message', errorPayload());
await post('stale button message', staleButtonPayload());

// -- photo rendering through unsigned CDN urls -------------------------------------------

if (discover) {
  await sleep(2500);
  const fetched = await api.getMessage(channelId, discover.id);
  const media = JSON.stringify(fetched.components).match(/"width":(\d+)/);
  results.push({ name: 'photo resolves via unsigned CDN url', ok: Boolean(media), detail: media ? `width ${media[1]}` : 'media item not resolved' });
}

const dmUser = process.env.LIVE_CHECK_DM_USER_ID;
if (dmUser) {
  try {
    const dm = await api.createDm(dmUser);
    const stored = await api.createMessage(dm.id, { content: '🧪 Photo storage check — this message deletes itself in a few seconds.', flags: MessageFlags.SuppressNotifications, attachments: [{ id: 0, filename: 'photo-1.png' }] }, [
      { name: 'photo-1.png', data: samplePng(), contentType: 'image/png' },
    ]);
    const a = stored.attachments[0]!;
    const url = photoUrl({ channelId: dm.id, attachmentId: a.id, filename: a.filename });
    const shown = await post('DM-stored photo shown elsewhere', v2([container([text('DM storage check'), gallery([{ url }])])]));
    await sleep(2500);
    const fetched = shown ? await api.getMessage(channelId, shown.id) : null;
    const ok = Boolean(fetched && /"width":\d+/.test(JSON.stringify(fetched.components)));
    results.push({ name: 'DM-stored photo resolves via unsigned CDN url', ok, detail: ok ? 'resolved' : 'not resolved' });
    await api.deleteMessage(dm.id, stored.id);
  } catch (error) {
    results.push({ name: 'DM-stored photo check', ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

// -- cleanup & report ----------------------------------------------------------------------

if (process.env.LIVE_CHECK_KEEP !== '1') {
  for (const message of posted.reverse()) {
    await api.deleteMessage(message.channelId, message.id).catch(() => {});
    await sleep(1100);
  }
}
let failures = 0;
for (const result of results) {
  if (!result.ok) failures++;
  console.log(`${result.ok ? '✅' : '❌'} ${result.name}${result.detail ? ` — ${result.detail}` : ''}`);
}
console.log(`\n${results.length - failures}/${results.length} checks passed${process.env.LIVE_CHECK_KEEP === '1' ? ' (messages kept)' : ', test messages deleted'}.`);
store.close();
process.exit(failures ? 1 : 0);
