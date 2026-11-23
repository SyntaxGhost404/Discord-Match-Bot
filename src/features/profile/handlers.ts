// /profile: see yourself as others do, edit everything except your birthday,
// manage photos and pause discovery.

import { button, row, v2 } from '../../discord/components/builders.ts';
import type { MessagePayload } from '../../discord/types.ts';
import { cid } from '../../interactions/custom-id.ts';
import { modalValues, type AnyContext } from '../../interactions/context.ts';
import type { Router } from '../../interactions/router.ts';
import type { App } from '../../core/app.ts';
import type { Profile } from '../../domain/profile.ts';
import { profileCard } from '../../ui/profile-card.ts';
import { Colors } from '../../ui/theme.ts';
import { menuButton, plural } from '../../ui/common.ts';
import { aboutModal, basicsModal, parseAbout, parseBasics, photosModal, type AboutValues } from './forms.ts';
import { photoProblemText } from './photos.ts';

const PENDING_ABOUT_KEY = (userId: string) => `pending_about:${userId}`;
const PENDING_TTL = 15 * 60_000;

export function visibilityLine(profile: Profile): string {
  if (profile.visibility === 'visible') return '🟢 Visible in Discover';
  if (profile.visibility === 'paused') return '⏸️ Paused — hidden from Discover (your matches and chats still work)';
  return '🔒 Hidden while moderators review reports';
}

export function selfProfilePayload(app: App, userId: string, note?: string): MessagePayload {
  const { store } = app;
  const profile = app.matching.profile(userId);
  if (!profile) throw new Error('selfProfilePayload requires a complete profile');
  const feedback = store.chat.feedbackFor(userId);
  const rated = feedback.up + feedback.down;
  const stats = [
    `💌 ${plural(store.swipes.likesReceived(userId), 'like')} received`,
    `🤝 ${plural(store.matches.countActive(userId), 'match', 'matches')}`,
    `🎲 ${plural(store.chat.countFor(userId), 'chat')}`,
    rated ? `👍 ${Math.round((feedback.up / rated) * 100)}% positive chat ratings` : null,
  ].filter(Boolean);
  const paused = profile.visibility === 'paused';
  return v2([
    profileCard(profile, store.photos.list(userId), {
      now: app.clock(),
      header: [`## 👤 Your profile`, `-# ${visibilityLine(profile)}`, note ?? ''].filter(Boolean).join('\n'),
      footer: `${stats.join(' · ')}\n-# Only you can see these numbers. Your birthday can't be changed — contact a moderator if it's wrong.`,
      accent: Colors.profile,
      rows: [
        row(
          button(cid('prof', 'edit_basics'), 'Name & gender', { emoji: '✏️' }),
          button(cid('prof', 'edit_about'), 'Details', { emoji: '📝' }),
          button(cid('prof', 'photos'), 'Photos', { emoji: '📷' }),
        ),
        row(
          paused
            ? button(cid('prof', 'resume'), 'Resume discovery', { emoji: '▶️', style: 'success' })
            : button(cid('prof', 'pause'), 'Pause discovery', { emoji: '⏸️', disabled: profile.visibility === 'hidden' }),
          button(cid('set', 'open'), 'Settings', { emoji: '⚙️' }),
          menuButton(),
        ),
      ],
    }),
  ]);
}

/** Pauses or resumes discovery. Moderation-hidden profiles stay hidden. */
export function setPaused(app: App, userId: string, paused: boolean): 'ok' | 'hidden' {
  const profile = app.matching.profile(userId);
  if (!profile || profile.visibility === 'hidden') return 'hidden';
  app.store.profiles.update(userId, { visibility: paused ? 'paused' : 'visible' }, app.clock());
  return 'ok';
}

function pendingAbout(app: App, userId: string): AboutValues | null {
  const raw = app.store.kv.get(PENDING_ABOUT_KEY(userId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { at: number; values: AboutValues };
    return app.clock() - parsed.at < PENDING_TTL ? parsed.values : null;
  } catch {
    return null;
  }
}

async function show(app: App, ctx: AnyContext, note?: string): Promise<void> {
  await ctx.update(selfProfilePayload(app, ctx.user.id, note));
}

export function registerProfile(app: App, router: Router): void {
  const { store } = app;

  router.command({ name: 'profile', gate: 'profile', run: (ctx) => ctx.reply(selfProfilePayload(app, ctx.user.id)) });
  router.component({ ns: 'prof', action: 'view', gate: 'profile', run: (ctx) => show(app, ctx) });

  router.component({
    ns: 'prof',
    action: 'edit_basics',
    gate: 'profile',
    run: (ctx) => ctx.showModal(basicsModal(cid('prof', 'basics'), app.matching.profile(ctx.user.id)!, { onboarding: false })),
  });

  router.modal({
    ns: 'prof',
    action: 'basics',
    gate: 'profile',
    run: async (ctx) => {
      const result = parseBasics(modalValues(ctx), { onboarding: false, now: new Date(app.clock()) });
      if (!result.ok) return show(app, ctx, `⚠️ ${result.error}`);
      store.profiles.update(ctx.user.id, { name: result.name, gender: result.gender }, app.clock());
      await show(app, ctx, '✅ Saved!');
    },
  });

  router.component({
    ns: 'prof',
    action: 'edit_about',
    gate: 'profile',
    run: async (ctx) => {
      const profile = app.matching.profile(ctx.user.id)!;
      const pending = pendingAbout(app, ctx.user.id);
      await ctx.showModal(aboutModal(cid('prof', 'about'), pending ? { ...profile, ...pending } : profile, 'Edit your details'));
    },
  });

  router.modal({
    ns: 'prof',
    action: 'about',
    gate: 'profile',
    run: async (ctx) => {
      const now = app.clock();
      const { values, error } = parseAbout(modalValues(ctx));
      if (error) {
        // Never publish rejected text, but remember it so the next attempt is prefilled.
        store.kv.set(PENDING_ABOUT_KEY(ctx.user.id), JSON.stringify({ at: now, values }), now);
        return show(app, ctx, `⚠️ ${error} Press **Details** to fix it — what you typed is kept.`);
      }
      store.transaction(() => {
        store.profiles.update(ctx.user.id, values, now);
        store.kv.delete(PENDING_ABOUT_KEY(ctx.user.id));
      });
      await show(app, ctx, '✅ Saved!');
    },
  });

  router.component({
    ns: 'prof',
    action: 'photos',
    gate: 'profile',
    run: (ctx) =>
      ctx.showModal(
        photosModal(cid('prof', 'photos_up'), { maxPhotos: app.config.media.maxPhotos, hasPhotos: store.photos.list(ctx.user.id).length > 0, onboarding: false }),
      ),
  });

  router.modal({
    ns: 'prof',
    action: 'photos_up',
    gate: 'profile',
    run: async (ctx) => {
      const values = modalValues(ctx);
      const attachments = values.attachments('photos');
      if (attachments.length) {
        await ctx.deferUpdate();
        const result = await app.photos.ingest(ctx.user.id, attachments);
        if (!result.ok) return show(app, ctx, `⚠️ ${photoProblemText(result.problem, app)}`);
        await app.photos.discard(store.photos.replace(ctx.user.id, result.photos, app.clock()));
        return show(app, ctx, `✅ ${plural(result.photos.length, 'photo')} saved!`);
      }
      if (values.checked('remove_all')) {
        await app.photos.discard(store.photos.removeAll(ctx.user.id));
        return show(app, ctx, '✅ Your photos were removed.');
      }
      await show(app, ctx);
    },
  });

  for (const [action, paused] of [
    ['pause', true],
    ['resume', false],
  ] as const) {
    router.component({
      ns: 'prof',
      action,
      gate: 'profile',
      run: async (ctx) => {
        const result = setPaused(app, ctx.user.id, paused);
        await show(app, ctx, result === 'hidden' ? '🔒 Your profile is under review, so it stays hidden for now.' : paused ? '⏸️ Paused. Nobody will see you in Discover until you resume.' : '▶️ Welcome back! You are visible in Discover again.');
      },
    });
  }
}
