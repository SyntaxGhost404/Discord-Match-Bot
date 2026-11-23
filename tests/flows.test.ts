// End-to-end flows through the real App, with a fake Discord that validates
// every payload against the documented limits.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Harness, MOD_CHANNEL, findCustomId, buttonIds, modalFrom, shown, textOf, type TestUser } from './harness.ts';
import { MessageFlags } from '../src/discord/constants.ts';
import { syncCommands } from '../src/core/commands.ts';
import { handleDispatch } from '../src/app.ts';
import { MINUTE, SECOND } from '../src/util/time.ts';

const noIssues = (h: Harness) => assert.deepEqual(h.discord.issues, [], 'every payload must pass validation');

async function adults(h: Harness) {
  const alice = h.user('alice');
  const bob = h.user('bob');
  await h.onboard(alice, { birthday: '15.03.1998', gender: 'woman', photo: true });
  await h.onboard(bob, { birthday: '02.09.1999', gender: 'man', interests: ['music', 'coding'] });
  return { alice, bob };
}

test('onboarding builds a complete profile, strips photo metadata and lands on the menu', async () => {
  const h = await Harness.create();
  const alice = h.user('alice');
  const menu = await h.onboard(alice, { birthday: '15.03.1998', photo: true });
  const profile = h.app.store.profiles.get(alice.id)!;
  assert.equal(profile.stage, 'complete');
  assert.equal(profile.birthDate, '1998-03-15');
  assert.deepEqual(profile.interests, ['gaming', 'music']);
  assert.match(textOf(menu), /You're all set, alice/);

  const photos = h.app.store.photos.list(alice.id);
  assert.equal(photos.length, 1);
  const stored = h.discord.find(photos[0]!.channelId, photos[0]!.messageId)!;
  assert.ok(stored.flags! & MessageFlags.SuppressNotifications, 'storage message does not ping');
  const bytes = Buffer.from(h.discord.uploads.get(stored.attachments[0]!.url)!);
  assert.equal(bytes.includes(Buffer.from('tEXt')), false, 'PNG text metadata removed before upload');
  noIssues(h);
});

test('onboarding validates input and refuses under-13s', async () => {
  const h = await Harness.create();
  const kid = h.user('kid');
  const welcome = shown(await kid.command('start'));
  const modal = modalFrom(await kid.click(welcome, 'onb:start'));
  const noAgree = shown(await kid.submit(modal, { name: 'Kiddo', birthday: '01.01.2000', gender: 'man', agree: false }, welcome));
  assert.match(textOf(noAgree), /agree to the community guidelines/);
  const retry = modalFrom(await kid.click(noAgree, findCustomId(noAgree, 'onb:edit_basics')));
  const refused = shown(await kid.submit(retry, { name: 'Kiddo', birthday: '01.01.2016', gender: 'man', agree: true }, noAgree));
  assert.match(textOf(refused), /at least 13/);
  assert.equal(h.app.store.profiles.get(kid.id), null, 'no profile is kept');
  const again = await kid.click(refused, 'onb:start');
  assert.ok(!again.some((r) => r.type === 9), 'the age gate stays closed');
  noIssues(h);
});

test('like → notification → like back → match, with identities revealed only on match', async () => {
  const h = await Harness.create();
  const { alice, bob } = await adults(h);

  const card = shown(await alice.command('discover'));
  assert.match(textOf(card), /bob, 27/);
  for (const id of buttonIds(card)) assert.ok(!id.includes(bob.id), `custom_id "${id}" must not contain a Discord id before matching`);
  assert.ok(!textOf(card).includes(bob.id));

  const after = shown(await alice.click(card, findCustomId(card, 'dsc:like')));
  assert.match(textOf(after), /seen everyone/);

  h.advance(10 * SECOND);
  await h.runJobs();
  const notice = bob.last();
  assert.match(textOf(notice), /1 new like/);

  const likes = shown(await bob.click(notice, findCustomId(notice, 'lk:open')));
  assert.match(textOf(likes), /alice liked you/);
  assert.ok(!textOf(likes).includes(alice.id));

  const match = shown(await bob.click(likes, findCustomId(likes, 'lk:yes')));
  assert.match(textOf(match), /It's a match/);
  assert.ok(textOf(match).includes(`<@${alice.id}>`), 'match reveals the Discord account');

  await h.runJobs();
  const aliceMatch = alice.last();
  assert.match(textOf(aliceMatch), /It's a match/);
  assert.ok(textOf(aliceMatch).includes(`<@${bob.id}>`));

  const list = shown(await alice.command('matches'));
  assert.match(textOf(list), /bob/);
  const detail = shown(await alice.click(list, findCustomId(list, 'mt:view')));
  const confirm = shown(await alice.click(detail, findCustomId(detail, 'mt:unmatch')));
  const done = shown(await alice.click(confirm, findCustomId(confirm, 'mt:unmatch_yes')));
  assert.match(textOf(done), /Unmatched/);
  assert.equal(h.app.store.matches.countActive(alice.id), 0);
  noIssues(h);
});

test('likes can carry a note, and notes are moderated', async () => {
  const h = await Harness.create();
  const { alice, bob } = await adults(h);
  const card = shown(await alice.command('discover'));
  const modal = modalFrom(await alice.click(card, findCustomId(card, 'dsc:note')));
  const rejected = shown(await alice.submit(modal, { note: 'add me at discord.gg/spam' }, card));
  assert.match(textOf(rejected), /Links and invites/);
  assert.match(textOf(rejected), /bob/, 'the same person is shown again');
  const modal2 = modalFrom(await alice.click(rejected, findCustomId(rejected, 'dsc:note')));
  await alice.submit(modal2, { note: 'You like coding too? 👋' }, rejected);
  const likes = shown(await bob.command('likes'));
  assert.match(textOf(likes), /You like coding too/);
  noIssues(h);
});

test('teens and adults never see each other; teens only see teens within two years', async () => {
  const h = await Harness.create();
  const teen = h.user('teen');
  const peer = h.user('peer');
  const young = h.user('young');
  const adult = h.user('adult');
  await h.onboard(teen, { birthday: '01.06.2010' }); // 16
  await h.onboard(peer, { birthday: '01.01.2011' }); // 15
  await h.onboard(young, { birthday: '01.01.2013' }); // 13, more than 2 years younger
  await h.onboard(adult, { birthday: '01.01.2007' }); // 19

  const teenCard = shown(await teen.command('discover'));
  assert.match(textOf(teenCard), /peer/);
  const next = shown(await teen.click(teenCard, findCustomId(teenCard, 'dsc:skip')));
  assert.match(textOf(next), /seen everyone/, 'neither the adult nor the 13-year-old is shown');

  const adultCard = shown(await adult.command('discover'));
  assert.match(textOf(adultCard), /seen everyone/);
  noIssues(h);
});

test('daily like limit is enforced', async () => {
  const h = await Harness.create({ LIKES_PER_DAY: '1' });
  const { alice } = await adults(h);
  const carol = h.user('carol');
  await h.onboard(carol, { birthday: '01.01.1997' });
  const card = shown(await alice.command('discover'));
  const next = shown(await alice.click(card, findCustomId(card, 'dsc:like')));
  assert.match(textOf(next), /all your likes for today/);
  noIssues(h);
});

/** The live "connected" card in a participant's DM. */
function chatCard(h: Harness, sessionId: number, user: TestUser) {
  const session = h.app.store.chat.get(sessionId)!;
  const cardId = session.userA === user.id ? session.aCardId : session.bCardId;
  const card = h.discord.find(user.dm, cardId!);
  assert.ok(card, `chat card for ${user.username}`);
  return card!;
}

async function connect(h: Harness, a: TestUser, b: TestUser) {
  await a.command('chat');
  const intro = a.last();
  await a.click(intro, findCustomId(intro, 'chat:start'));
  await b.command('chat');
  const introB = b.last();
  await b.click(introB, findCustomId(introB, 'chat:start'));
  const session = h.app.store.chat.activeFor(a.id);
  assert.ok(session, 'paired');
  return session!;
}

test('anonymous chat relays text, replies, edits, deletes, reactions and typing', async () => {
  const h = await Harness.create();
  const { alice, bob } = await adults(h);
  await connect(h, alice, bob);
  assert.match(textOf(alice.last()), /You're connected/);
  assert.match(textOf(bob.last()), /You're connected/);

  const hello = await alice.say('hello there');
  const copy = bob.last();
  assert.equal(copy.content, 'hello there');
  assert.ok(copy.flags! & MessageFlags.SuppressEmbeds);

  await bob.say('hey!', { message_reference: { message_id: copy.id } });
  const replyCopy = alice.last();
  assert.equal(replyCopy.content, 'hey!');
  assert.equal(replyCopy.message_reference?.message_id, hello.id, 'reply points at the original message');

  await h.app.relay.onMessageUpdate({ ...hello, content: 'hello there, friend', edited_timestamp: new Date().toISOString() });
  assert.equal(h.discord.find(bob.dm, copy.id)?.content, 'hello there, friend');

  await bob.say('what the fuck');
  assert.match(alice.last().content, /what the \*+/, 'profanity masked for the recipient');

  await h.app.relay.onReaction({ user_id: bob.id, channel_id: bob.dm, message_id: copy.id, emoji: { id: null, name: '👍' } }, true);
  assert.deepEqual(h.discord.reactions.at(-1), { channelId: alice.dm, messageId: hello.id, emoji: '👍', added: true });

  await h.app.relay.onTyping({ channel_id: alice.dm, user_id: alice.id, timestamp: 0 });
  assert.ok(h.discord.typing.includes(bob.dm));

  await h.app.relay.onMessageDelete({ id: hello.id, channel_id: alice.dm });
  assert.equal(h.discord.find(bob.dm, copy.id), undefined, 'unsent for the partner');
  noIssues(h);
});

test('ending a chat sends summaries; feedback is recorded once', async () => {
  const h = await Harness.create();
  const { alice, bob } = await adults(h);
  const session = await connect(h, alice, bob);
  await alice.say('hi');
  const card = chatCard(h, session.id, alice);
  await alice.click(card, findCustomId(card, 'chat:end'));
  assert.equal(h.app.store.chat.activeFor(alice.id), null);
  const summaryA = alice.last();
  const summaryB = bob.last();
  assert.match(textOf(summaryA), /You ended the chat/);
  assert.match(textOf(summaryB), /Your partner ended the chat/);
  await bob.click(summaryB, findCustomId(summaryB, 'chat:rate'));
  assert.deepEqual(h.app.store.chat.feedbackFor(alice.id), { up: 1, down: 0 });
  assert.match(textOf(h.discord.find(bob.dm, summaryB.id)!), /Thanks for the feedback/);
  noIssues(h);
});

test('teen chats are text-only and remove links', async () => {
  const h = await Harness.create();
  const t1 = h.user('t1');
  const t2 = h.user('t2');
  await h.onboard(t1, { birthday: '01.06.2010' });
  await h.onboard(t2, { birthday: '01.01.2011' });
  const session = await connect(h, t1, t2);
  assert.equal(session.teen, true);
  await t1.say('join www.example.com please');
  assert.equal(t2.last().content, 'join [link removed] please');
  await t1.say('', { attachments: [{ id: '1', filename: 'x.png', size: 10, url: 'https://cdn.test/x.png', content_type: 'image/png' }] });
  assert.match(textOf(t1.last()), /Only text can be shared in teen chats/);
  noIssues(h);
});

test('profiles are revealed only when both people agree', async () => {
  const h = await Harness.create();
  const { alice, bob } = await adults(h);
  const session = await connect(h, alice, bob);
  const cardA = chatCard(h, session.id, alice);
  await alice.click(cardA, findCustomId(cardA, 'chat:reveal'));
  assert.match(textOf(bob.last()), /would like to reveal profiles/);
  assert.equal(h.app.store.matches.between(alice.id, bob.id), null);
  const cardB = chatCard(h, session.id, bob);
  await bob.click(cardB, findCustomId(cardB, 'chat:reveal'));
  assert.ok(h.app.store.matches.between(alice.id, bob.id), 'they become matches');
  assert.ok(textOf(alice.last()).includes(`<@${bob.id}>`));
  assert.ok(textOf(bob.last()).includes(`<@${alice.id}>`));
  noIssues(h);
});

test('reporting from a chat sends evidence to moderators, and a ban locks the user out', async () => {
  const h = await Harness.create();
  const { alice, bob } = await adults(h);
  const mod = h.user('mod');
  h.makeModerator(mod);
  const session = await connect(h, alice, bob);
  await alice.say('hi');
  await bob.say('you are awful');
  const card = chatCard(h, session.id, alice);
  const modal = modalFrom(await alice.click(card, findCustomId(card, 'chat:report')));
  await alice.submit(modal, { reason: 'harassment', details: 'rude' }, card);
  assert.equal(h.app.store.chat.activeFor(alice.id), null, 'reporting closes the chat');
  assert.ok(h.app.store.blocks.eitherWay(alice.id, bob.id), 'and blocks by default');

  const report = h.app.store.reports.listOpen(5)[0]!;
  assert.equal(report.reason, 'harassment');
  assert.deepEqual(report.evidence.map((e) => [e.from, e.text]), [
    ['reporter', 'hi'],
    ['reported', 'you are awful'],
  ]);

  await h.runJobs();
  const posted = h.discord.botMessages(MOD_CHANNEL).at(-1)!;
  assert.match(textOf(posted), /Report #1/);
  assert.equal(posted.attachments[0]?.filename, 'report-1-evidence.txt');

  const banModal = modalFrom(await mod.click(posted, findCustomId(posted, 'mod:ban'), undefined, 'guild'));
  await mod.submit(banModal, { reason: 'Harassment', duration: '7d', notify: true }, posted, 'guild');
  assert.ok(h.app.store.users.activeBan(bob.id, h.now));
  assert.match(textOf(h.discord.find(MOD_CHANNEL, posted.id)!), /banned 7d/);

  const blocked = shown(await bob.command('discover'));
  assert.match(textOf(blocked), /suspended/);
  noIssues(h);
});

test('non-moderators cannot use moderator buttons', async () => {
  const h = await Harness.create();
  const { alice, bob } = await adults(h);
  const card = shown(await alice.command('discover'));
  const modal = modalFrom(await alice.click(card, findCustomId(card, 'dsc:report')));
  await alice.submit(modal, { reason: 'spam' }, card);
  await h.runJobs();
  const posted = h.discord.botMessages(MOD_CHANNEL).at(-1)!;
  const result = shown(await bob.click(posted, findCustomId(posted, 'mod:dismiss'), undefined, 'guild'));
  assert.match(textOf(result), /only available to moderators/);
  assert.equal(h.app.store.reports.listOpen(5).length, 1);
  noIssues(h);
});

test('settings: filters, alerts, blocking with opaque references, and data deletion', async () => {
  const h = await Harness.create();
  const { alice, bob } = await adults(h);
  const settings = shown(await alice.command('settings'));
  const filters = modalFrom(await alice.click(settings, findCustomId(settings, 'set:filters')));
  const saved = shown(await alice.submit(filters, { age_min: '30', age_max: '40', show: ['man'], same_language: true }, settings));
  assert.match(textOf(saved), /Filters saved/);
  const profile = h.app.store.profiles.get(alice.id)!;
  assert.deepEqual([profile.ageMin, profile.ageMax, profile.showGenders, profile.sameLanguageOnly], [30, 40, ['man'], true]);

  const toggled = shown(await alice.click(saved, findCustomId(saved, 'set:toggle:likes')));
  assert.equal(h.app.store.profiles.get(alice.id)!.likeAlerts, false);

  await h.app.safety.block(alice.id, bob.id, 'profile');
  const list = shown(await alice.click(toggled, findCustomId(toggled, 'set:blocked')));
  const select = findCustomId(list, 'set:unblock');
  const optionValue = String(h.app.store.refs.refFor(bob.id));
  assert.ok(!JSON.stringify(list.components).includes(bob.id), 'blocked list never exposes Discord ids');
  await alice.click(list, select, [optionValue]);
  assert.equal(h.app.store.blocks.eitherWay(alice.id, bob.id), false);

  const fresh = shown(await alice.command('settings'));
  const del = modalFrom(await alice.click(fresh, findCustomId(fresh, 'set:delete')));
  const wrong = shown(await alice.submit(del, { confirm: 'nope!!' }, fresh));
  assert.match(textOf(wrong), /Nothing was deleted/);
  const del2 = modalFrom(await alice.click(wrong, findCustomId(wrong, 'set:delete')));
  await alice.submit(del2, { confirm: 'DELETE' }, wrong);
  assert.equal(h.app.store.profiles.get(alice.id), null);
  assert.equal(h.app.store.photos.listAll(alice.id).length, 0);
  noIssues(h);
});

test('a pairing unwinds cleanly when one person cannot receive DMs', async () => {
  const h = await Harness.create();
  const { alice, bob } = await adults(h);
  await alice.command('chat');
  const intro = alice.last();
  await alice.click(intro, findCustomId(intro, 'chat:start'));
  h.discord.closedDms.add(bob.id);
  await bob.command('chat', [], 'guild');
  const intro2 = h.discord.botMessages('1300000000000000005').at(-1)!;
  const result = shown(await bob.click(intro2, findCustomId(intro2, 'chat:start'), undefined, 'guild'));
  assert.match(textOf(result), /can't message you in DMs/);
  assert.equal(h.app.store.chat.activeFor(alice.id), null);
  assert.ok(h.app.store.chat.queueEntry(alice.id), 'alice is still waiting');
  noIssues(h);
});

test('idle chats end automatically and stale searches time out', async () => {
  const h = await Harness.create({ CHAT_IDLE_MINUTES: '5', CHAT_QUEUE_TIMEOUT_MINUTES: '3' });
  const { alice, bob } = await adults(h);
  await connect(h, alice, bob);
  h.advance(6 * MINUTE);
  await h.app.chat.sweep();
  assert.equal(h.app.store.chat.activeFor(alice.id), null);
  assert.match(textOf(alice.last()), /a while without messages/);

  const carol = h.user('carol');
  await h.onboard(carol, { birthday: '01.01.1990' }); // too far in age for alice/bob defaults
  await carol.command('chat');
  const intro = carol.last();
  await carol.click(intro, findCustomId(intro, 'chat:start'));
  h.advance(4 * MINUTE);
  await h.app.chat.sweep();
  assert.equal(h.app.store.chat.queueEntry(carol.id), null);
  assert.match(textOf(carol.last()), /Nobody was free/);
  noIssues(h);
});

test('messages sent while the bot was offline are relayed on reconnect', async () => {
  const h = await Harness.create();
  const { alice, bob } = await adults(h);
  await connect(h, alice, bob);
  // Simulate offline: the message lands in the DM without a gateway event.
  h.discord.channel(alice.dm).push({
    id: '1499999999999999999',
    channel_id: alice.dm,
    author: alice.user,
    content: 'sent while you were away',
    timestamp: new Date().toISOString(),
    edited_timestamp: null,
    attachments: [],
    embeds: [],
    type: 0,
  });
  await h.app.relay.catchUp();
  assert.equal(bob.last().content, 'sent while you were away');
  noIssues(h);
});

test('gateway dispatch hides photos flagged by content scanning', async () => {
  const h = await Harness.create();
  const alice = h.user('alice');
  await h.onboard(alice, { birthday: '15.03.1998', photo: true });
  const photo = h.app.store.photos.list(alice.id)[0]!;
  const stored = h.discord.find(photo.channelId, photo.messageId)!;
  handleDispatch(h.app, 'MESSAGE_UPDATE', { ...stored, attachments: stored.attachments.map((a) => ({ ...a, flags: 1 << 4 })) }, 0);
  assert.equal(h.app.store.photos.list(alice.id).length, 0);
  await h.runJobs();
  assert.match(textOf(alice.last()), /safety filter flagged/);
  noIssues(h);
});

test('command sync only writes when definitions change', async () => {
  const h = await Harness.create();
  await syncCommands(h.app);
  const first = h.discord.putCount;
  const ids = await syncCommands(h.app);
  assert.equal(h.discord.putCount, first, 'second sync is a no-op');
  assert.ok(ids.get('discover'));
  assert.ok(ids.get('mod'), 'moderator commands registered in the mod guild');
});

test('stale and unknown buttons get a friendly answer', async () => {
  const h = await Harness.create();
  const { alice } = await adults(h);
  const card = shown(await alice.command('start'));
  const result = shown(await alice.click(card, 'chat_end'));
  assert.match(textOf(result), /older message/);
  noIssues(h);
});
