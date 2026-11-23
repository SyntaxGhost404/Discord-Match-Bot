import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { InteractionsServer } from '../src/discord/http/server.ts';
import { ConfigError, loadConfig } from '../src/config.ts';
import { Router } from '../src/interactions/router.ts';
import { silentLogger } from '../src/util/logger.ts';
import { classic } from '../src/discord/components/builders.ts';
import { Harness, findCustomId, modalFrom, shown, textOf } from './harness.ts';
import { SECOND } from '../src/util/time.ts';

test('HTTP endpoint answers PING, rejects bad signatures and hands interactions to the router', async (t) => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const hex = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('hex');
  const received: unknown[] = [];
  const server = new InteractionsServer({ publicKey: hex, host: '127.0.0.1', port: 0, path: '/interactions', logger: silentLogger, onInteraction: (i) => received.push(i) });
  await server.start();
  t.after(() => server.stop());
  const address = (server as unknown as { server: { address(): { port: number } } }).server.address();
  const url = `http://127.0.0.1:${address.port}/interactions`;

  const post = (body: string, signed = true) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signed ? sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(body)]), privateKey).toString('hex') : '00'.repeat(64);
    return fetch(url, { method: 'POST', body, headers: { 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp, 'content-type': 'application/json' } });
  };

  const ping = await post('{"type":1}');
  assert.equal(ping.status, 200);
  assert.deepEqual(await ping.json(), { type: 1 });
  assert.equal((await post('{"type":1}', false)).status, 401);
  const accepted = await post('{"type":2,"id":"1","token":"t","data":{"name":"help"}}');
  assert.equal(accepted.status, 202);
  assert.equal(received.length, 1);
  assert.equal((await fetch(url.replace('/interactions', '/health'))).status, 200);
});

test('the watchdog acknowledges slow handlers before the 3-second deadline', async () => {
  const h = await Harness.create();
  const calls: number[] = [];
  const api = h.discord;
  const original = api.createInteractionResponse.bind(api);
  api.createInteractionResponse = async (...args) => {
    calls.push(args[2].type);
    return original(...args);
  };
  const router = new Router({
    services: { api, log: silentLogger, validatePayloads: true },
    log: silentLogger,
    guard: async () => true,
    unknown: async () => {},
    errorMessage: () => classic({ content: 'error' }),
    retryMessage: () => classic({ content: 'retry' }),
    watchdogMs: 50,
  });
  router.command({
    name: 'slow',
    gate: 'none',
    run: async (ctx) => {
      await new Promise((r) => setTimeout(r, 120));
      await ctx.reply(classic({ content: 'done' }));
    },
  });
  const user = h.user('slowpoke');
  h.discord.interactionChannel.set('999', user.dm);
  await router.handle({ id: '999', application_id: '1', type: 2, token: 'tok-slow', version: 1, context: 1, user: user.user, data: { id: '1', name: 'slow', type: 1 } } as never);
  assert.deepEqual(calls, [5], 'deferred automatically');
  const edited = h.discord.log.find((r) => r.kind === 'edit_original');
  assert.equal(edited?.payload?.content, 'done', 'the late reply became an edit of the deferred response');
});

test('a double click on Like records one like and one notification', async () => {
  const h = await Harness.create();
  const alice = h.user('alice');
  const bob = h.user('bob');
  await h.onboard(alice, { birthday: '15.03.1998' });
  await h.onboard(bob, { birthday: '02.09.1999', gender: 'man' });
  const card = shown(await alice.command('discover'));
  const like = findCustomId(card, 'dsc:like');
  await Promise.all([alice.click(card, like), alice.click(card, like)]);
  assert.equal(h.app.store.swipes.likesGivenSince(alice.id, 0), 1);
  h.advance(30 * SECOND);
  await h.runJobs();
  assert.equal(bob.inbox().filter((m) => /You have 1 new like/.test(textOf(m))).length, 1);
  assert.deepEqual(h.discord.issues, []);
});

test('profile editing keeps rejected text for the next attempt and never publishes it', async () => {
  const h = await Harness.create();
  const alice = h.user('alice');
  await h.onboard(alice, { birthday: '15.03.1998' });
  const card = shown(await alice.command('profile'));
  const about = modalFrom(await alice.click(card, findCustomId(card, 'prof:edit_about')));
  const rejected = shown(await alice.submit(about, { bio: 'follow me on https://spam.example' }, card));
  assert.match(textOf(rejected), /Links and invites/);
  assert.equal(h.app.store.profiles.get(alice.id)!.bio, 'Hi there!');
  const retry = modalFrom(await alice.click(rejected, findCustomId(rejected, 'prof:edit_about')));
  const bioInput = JSON.stringify(retry.components);
  assert.match(bioInput, /spam\.example/, 'what they typed is prefilled');
  const saved = shown(await alice.submit(retry, { bio: 'Love music and long walks' }, rejected));
  assert.match(textOf(saved), /Saved/);

  const basics = modalFrom(await alice.click(saved, findCustomId(saved, 'prof:edit_basics')));
  assert.ok(!JSON.stringify(basics.components).includes('birthday'), 'birthday cannot be edited after onboarding');
  const renamed = shown(await alice.submit(basics, { name: 'Alice B', gender: 'nonbinary' }, saved));
  assert.match(textOf(renamed), /Alice B/);

  const paused = shown(await alice.click(renamed, findCustomId(renamed, 'prof:pause')));
  assert.equal(h.app.store.profiles.get(alice.id)!.visibility, 'paused');
  await alice.click(paused, findCustomId(paused, 'prof:resume'));
  assert.equal(h.app.store.profiles.get(alice.id)!.visibility, 'visible');
  assert.deepEqual(h.discord.issues, []);
});

test('menu, help and every command render valid payloads', async () => {
  const h = await Harness.create();
  const alice = h.user('alice');
  const newcomer = h.user('newcomer');
  await h.onboard(alice, { birthday: '15.03.1998' });
  for (const name of ['start', 'discover', 'likes', 'matches', 'profile', 'chat', 'next', 'stop', 'settings', 'help']) {
    await alice.command(name);
  }
  await alice.command('stop');
  const help = shown(await newcomer.command('help'));
  assert.ok(findCustomId(help, 'onb:start'), 'people without a profile get a create button');
  const gated = shown(await newcomer.command('discover'));
  assert.match(textOf(gated), /Welcome to TestBot/);
  assert.deepEqual(h.discord.issues, []);
});

test('configuration errors are reported all at once', () => {
  assert.throws(
    () => loadConfig({ DISCORD_TOKEN: 'nope', INTERACTIONS_MODE: 'http', MAX_PHOTOS: '99', MOD_GUILD_ID: 'abc' }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /DISCORD_TOKEN does not look like a bot token/);
      assert.match(error.message, /DISCORD_PUBLIC_KEY is required/);
      assert.match(error.message, /MAX_PHOTOS/);
      assert.match(error.message, /MOD_GUILD_ID/);
      return true;
    },
  );
  const ok = loadConfig({ DISCORD_TOKEN: 'MTAwMDAwMDAwMDAwMDAwMDAw.GxxxxX.abcdefghijklmnopqrstuvwxyz0123456789ab' });
  assert.equal(ok.interactions.mode, 'gateway');
  assert.equal(ok.limits.likesPerDay, 60);
});
