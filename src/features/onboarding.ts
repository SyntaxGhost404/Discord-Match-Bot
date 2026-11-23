// Onboarding: welcome → basics (name, birthday, gender, guidelines) → age
// confirmation → details (interests, goals, languages, location, bio) →
// photos (optional) → review → publish. Progress is saved after every step,
// so people can stop at any point and continue later — even after a restart.

import { button, container, row, separator, text, v2 } from '../discord/components/builders.ts';
import type { MessagePayload } from '../discord/types.ts';
import { cid } from '../interactions/custom-id.ts';
import { modalValues, type AnyContext, type ModalContext } from '../interactions/context.ts';
import type { Router } from '../interactions/router.ts';
import { brand, commandMention, type App } from '../core/app.ts';
import { ageOn, ageGroupOf, dateWhenAge, formatBirthDate, MIN_AGE } from '../domain/age.ts';
import { languageFromLocale } from '../domain/catalog.ts';
import { checkDisplayName, checkFreeText, describeTextProblem, escapeMarkdown, sanitizeLine } from '../domain/text.ts';
import type { Profile } from '../domain/profile.ts';
import { profileCard } from '../ui/profile-card.ts';
import { Colors } from '../ui/theme.ts';
import { DM_HELP, notice } from '../ui/common.ts';
import { discordTimestamp } from '../util/time.ts';
import { aboutModal, basicsModal, parseAbout, parseBasics, photosModal } from './profile/forms.ts';
import { photoProblemText } from './profile/photos.ts';
import { menuPayload } from './menu.ts';

const AGE_GATE_KEY = (userId: string) => `age_gate:${userId}`;

// -- cards ---------------------------------------------------------------------------

export function welcomeCard(app: App): MessagePayload {
  return v2([
    container(
      [
        text(
          [
            `## 👋 Welcome to ${escapeMarkdown(brand(app))}!`,
            'Meet new people on Discord — friends, gaming buddies, study partners, or just someone to talk to.',
            '',
            '**How it works**',
            '🔍 **Discover** — browse profiles and like the people you want to meet',
            "🤝 **Match** — when a like is mutual, you both get each other's Discord",
            '🎲 **Anonymous chat** — talk to a random person, no names attached',
            '',
            '**Safety first**',
            '🛡️ Teens (13–17) only meet teens close to their age; adults only meet adults',
            '🚫 Block or report anyone in one tap — every report is reviewed',
          ].join('\n'),
        ),
        separator(),
        row(
          button(cid('onb', 'start'), 'Create my profile', { style: 'primary', emoji: '✨' }),
          button(cid('help', 'open'), 'How it works', { emoji: '❓' }),
        ),
        text('-# Takes about a minute. Your Discord name stays hidden until you match.'),
      ],
      { accent: Colors.brand },
    ),
  ]);
}

export function resumeCard(profile: Profile): MessagePayload {
  return v2([
    container(
      [
        text(`## 👋 Welcome back${profile.name ? `, ${escapeMarkdown(profile.name)}` : ''}!\nYou started creating your profile — let's finish it. It only takes a moment.`),
        separator(),
        row(button(cid('onb', 'start'), 'Continue', { style: 'primary', emoji: '▶️' })),
      ],
      { accent: Colors.brand },
    ),
  ]);
}

export function confirmAgeCard(profile: Profile, now: number): MessagePayload {
  const birthDate = profile.birthDate!;
  const age = ageOn(birthDate, now);
  const group = ageGroupOf(age);
  const audience =
    group === 'teen'
      ? "You'll only meet other **teens (13–17)** born within 2 years of you."
      : "You'll meet **adults (18+)**. You can choose the age range you see later.";
  return v2([
    container(
      [
        text(
          [
            '## 🎂 Quick check',
            `You were born on **${formatBirthDate(birthDate)}**, so you're **${age}**.`,
            audience,
            '',
            "⚠️ **Your birthday can't be changed later**, so please make sure it's right.",
          ].join('\n'),
        ),
        separator(),
        row(
          button(cid('onb', 'age_ok'), "That's right", { style: 'success', emoji: '✅' }),
          button(cid('onb', 'edit_basics'), 'Fix it', { emoji: '✏️' }),
        ),
      ],
      { accent: Colors.brand },
    ),
  ]);
}

export function photosStepCard(app: App, error?: string): MessagePayload {
  return v2([
    container(
      [
        text(
          [
            '## 📸 Add some photos (optional)',
            `Profiles with photos get far more likes. Add up to ${app.config.media.maxPhotos} — clear photos of you work best.`,
            "-# Photos go through Discord's safety filters, and location data is removed before they're stored.",
            error ? `\n⚠️ ${error}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        ),
        separator(),
        row(
          button(cid('onb', 'photos'), 'Add photos', { style: 'primary', emoji: '📷' }),
          button(cid('onb', 'skip_photos'), 'Skip for now'),
        ),
      ],
      { accent: Colors.brand },
    ),
  ]);
}

export function reviewCard(app: App, profile: Profile, error?: string): MessagePayload {
  const photos = app.store.photos.list(profile.userId);
  return v2([
    profileCard(profile, photos, {
      now: app.clock(),
      header: `## 👀 Here's how others will see you${error ? `\n⚠️ ${error}` : ''}`,
      footer: 'Your Discord name stays hidden until you match with someone.',
      accent: Colors.brand,
      rows: [
        row(
          button(cid('onb', 'finish'), 'Publish my profile', { style: 'success', emoji: '✅' }),
          button(cid('onb', 'edit_basics'), 'Basics', { emoji: '✏️' }),
          button(cid('onb', 'edit_about'), 'Details', { emoji: '✏️' }),
          button(cid('onb', 'photos'), 'Photos', { emoji: '📷' }),
        ),
      ],
    }),
  ]);
}

export function tooYoungCard(until: number): MessagePayload {
  return notice(
    `**Sorry — you need to be at least ${MIN_AGE} to use this bot.** That's Discord's own minimum age too. You're welcome to come back ${discordTimestamp(until, 'D')}. 💛`,
    'warning',
  );
}

function retryCard(message: string, action: 'edit_basics' | 'edit_about'): MessagePayload {
  return notice(message, 'warning', [row(button(cid('onb', action), 'Try again', { style: 'primary', emoji: '↩️' }))]);
}

// -- flow ----------------------------------------------------------------------------

/** Shown whenever someone without a finished profile uses the bot. */
export async function promptOnboarding(app: App, ctx: AnyContext): Promise<void> {
  const profile = app.store.profiles.get(ctx.user.id);
  await ctx.reply(profile && profile.stage !== 'complete' ? resumeCard(profile) : welcomeCard(app));
}

function draftFor(app: App, ctx: AnyContext): Profile {
  const existing = app.store.profiles.get(ctx.user.id);
  if (existing) return existing;
  const suggested = sanitizeLine(ctx.user.global_name ?? ctx.user.username, 32);
  return app.store.profiles.createDraft(
    ctx.user.id,
    { name: checkDisplayName(suggested) ? '' : suggested, languages: [languageFromLocale(ctx.locale) ?? 'en'] },
    app.clock(),
  );
}

function ageGateUntil(app: App, userId: string): number | null {
  const until = Number(app.store.kv.get(AGE_GATE_KEY(userId)) ?? 0);
  return until > app.clock() ? until : null;
}

async function alreadyDone(app: App, ctx: AnyContext): Promise<void> {
  await ctx.update(menuPayload(app, ctx.user.id, { header: "## ✅ You're already set up!" }));
}

async function continueFrom(app: App, ctx: AnyContext, profile: Profile): Promise<void> {
  switch (profile.stage) {
    case 'basics':
      return ctx.showModal(basicsModal(cid('onb', 'basics'), profile, { onboarding: true }));
    case 'confirm':
      return ctx.update(confirmAgeCard(profile, app.clock()));
    case 'about':
      return ctx.showModal(aboutModal(cid('onb', 'about'), profile, 'Create your profile · 2/2'));
    case 'photos':
      return ctx.update(photosStepCard(app));
    case 'review':
      return ctx.update(reviewCard(app, profile));
    case 'complete':
      return alreadyDone(app, ctx);
  }
}

export function registerOnboarding(app: App, router: Router): void {
  const { store } = app;

  router.component({
    ns: 'onb',
    action: 'start',
    gate: 'account',
    run: async (ctx) => {
      const gate = ageGateUntil(app, ctx.user.id);
      if (gate) return ctx.update(tooYoungCard(gate));
      await continueFrom(app, ctx, draftFor(app, ctx));
    },
  });

  router.component({
    ns: 'onb',
    action: 'edit_basics',
    gate: 'account',
    run: async (ctx) => {
      const profile = draftFor(app, ctx);
      if (profile.stage === 'complete') return alreadyDone(app, ctx);
      await ctx.showModal(basicsModal(cid('onb', 'basics'), profile, { onboarding: true }));
    },
  });

  router.modal({
    ns: 'onb',
    action: 'basics',
    gate: 'account',
    run: async (ctx: ModalContext) => {
      const now = app.clock();
      const profile = draftFor(app, ctx);
      if (profile.stage === 'complete') return alreadyDone(app, ctx);
      const result = parseBasics(modalValues(ctx), { onboarding: true, now: new Date(now) });
      if (!result.ok) {
        store.profiles.update(ctx.user.id, result.partial, now);
        return ctx.update(retryCard(result.error, 'edit_basics'));
      }
      const age = ageOn(result.birthDate!, now);
      if (age < MIN_AGE) {
        const until = dateWhenAge(result.birthDate!, MIN_AGE);
        store.kv.set(AGE_GATE_KEY(ctx.user.id), String(until), now);
        store.profiles.delete(ctx.user.id);
        app.log.info('Under-age sign-up refused', { userId: ctx.user.id });
        return ctx.update(tooYoungCard(until));
      }
      const updated = store.profiles.update(
        ctx.user.id,
        { name: result.name, gender: result.gender, birthDate: result.birthDate, guidelinesAcceptedAt: now, stage: 'confirm' },
        now,
      );
      await ctx.update(confirmAgeCard(updated, now));
    },
  });

  router.component({
    ns: 'onb',
    action: 'age_ok',
    gate: 'account',
    run: async (ctx) => {
      const profile = draftFor(app, ctx);
      if (profile.stage === 'complete') return alreadyDone(app, ctx);
      if (!profile.birthDate) return ctx.showModal(basicsModal(cid('onb', 'basics'), profile, { onboarding: true }));
      if (profile.interests.length && profile.languages.length && profile.lookingFor.length) {
        return ctx.update(reviewCard(app, store.profiles.update(ctx.user.id, { stage: 'review' }, app.clock())));
      }
      const updated = store.profiles.update(ctx.user.id, { stage: 'about' }, app.clock());
      await ctx.showModal(aboutModal(cid('onb', 'about'), updated, 'Create your profile · 2/2'));
    },
  });

  router.component({
    ns: 'onb',
    action: 'edit_about',
    gate: 'account',
    run: async (ctx) => {
      const profile = draftFor(app, ctx);
      if (profile.stage === 'complete') return alreadyDone(app, ctx);
      await ctx.showModal(aboutModal(cid('onb', 'about'), profile, 'Create your profile · 2/2'));
    },
  });

  router.modal({
    ns: 'onb',
    action: 'about',
    gate: 'account',
    run: async (ctx) => {
      const now = app.clock();
      const profile = draftFor(app, ctx);
      if (profile.stage === 'complete') return alreadyDone(app, ctx);
      if (!profile.birthDate) return ctx.update(retryCard('Please fill in your basics first.', 'edit_basics'));
      const { values, error } = parseAbout(modalValues(ctx));
      // Keep what they typed (drafts are private) so a retry doesn't lose it.
      if (profile.stage === 'confirm') {
        const saved = store.profiles.update(ctx.user.id, values, now);
        return ctx.update(confirmAgeCard(saved, now));
      }
      const nextStage = error ? profile.stage : profile.stage === 'review' ? 'review' : 'photos';
      const updated = store.profiles.update(ctx.user.id, { ...values, stage: nextStage }, now);
      if (error) return ctx.update(retryCard(error, 'edit_about'));
      await ctx.update(updated.stage === 'review' ? reviewCard(app, updated) : photosStepCard(app));
    },
  });

  router.component({
    ns: 'onb',
    action: 'photos',
    gate: 'account',
    run: async (ctx) => {
      const profile = draftFor(app, ctx);
      if (profile.stage === 'complete') return alreadyDone(app, ctx);
      const hasPhotos = store.photos.list(ctx.user.id).length > 0;
      await ctx.showModal(photosModal(cid('onb', 'photos_up'), { maxPhotos: app.config.media.maxPhotos, hasPhotos, onboarding: true }));
    },
  });

  router.modal({
    ns: 'onb',
    action: 'photos_up',
    gate: 'account',
    run: async (ctx) => {
      const profile = draftFor(app, ctx);
      if (profile.stage === 'complete') return alreadyDone(app, ctx);
      const values = modalValues(ctx);
      const attachments = values.attachments('photos');
      if (attachments.length) {
        await ctx.deferUpdate();
        const result = await app.photos.ingest(ctx.user.id, attachments);
        if (!result.ok) return ctx.update(profile.stage === 'review' ? reviewCard(app, profile, photoProblemText(result.problem, app)) : photosStepCard(app, photoProblemText(result.problem, app)));
        const removed = store.photos.replace(ctx.user.id, result.photos, app.clock());
        await app.photos.discard(removed);
      } else if (values.checked('remove_all')) {
        await app.photos.discard(store.photos.removeAll(ctx.user.id));
      }
      await ctx.update(reviewCard(app, store.profiles.update(ctx.user.id, { stage: 'review' }, app.clock())));
    },
  });

  router.component({
    ns: 'onb',
    action: 'skip_photos',
    gate: 'account',
    run: async (ctx) => {
      const profile = draftFor(app, ctx);
      if (profile.stage === 'complete') return alreadyDone(app, ctx);
      await ctx.update(reviewCard(app, store.profiles.update(ctx.user.id, { stage: 'review' }, app.clock())));
    },
  });

  router.component({
    ns: 'onb',
    action: 'finish',
    gate: 'account',
    run: async (ctx) => {
      const now = app.clock();
      const profile = draftFor(app, ctx);
      if (profile.stage === 'complete') return alreadyDone(app, ctx);
      const missing = !profile.birthDate
        ? 'edit_basics'
        : checkDisplayName(profile.name)
          ? 'edit_basics'
          : !profile.interests.length || !profile.languages.length || !profile.lookingFor.length
            ? 'edit_about'
            : null;
      if (missing) return ctx.update(retryCard('A few details are still missing.', missing));
      const about = parseAboutCheck(profile);
      if (about) return ctx.update(reviewCard(app, profile, about));

      store.profiles.update(ctx.user.id, { stage: 'complete', visibility: 'visible', completedAt: now, lastActiveAt: now }, now);
      app.log.info('Profile published', { userId: ctx.user.id });

      let header = `## 🎉 You're all set, ${escapeMarkdown(profile.name)}!\nYour profile is live. I'll DM you when someone likes you or you get a match.`;
      if (!ctx.inBotDm) {
        const dm = await app.dm.send(
          ctx.user.id,
          notice(`**Hi ${escapeMarkdown(profile.name)}!** This is where I'll let you know about likes and matches, and where anonymous chats happen. Use ${commandMention(app, 'start')} any time to open the menu.`, 'success'),
        );
        if (!dm.ok) {
          header += `\n⚠️ **I can't DM you yet**, so you'd miss matches and chats. ${DM_HELP}`;
        }
      }
      await ctx.update(menuPayload(app, ctx.user.id, { header }));
    },
  });
}

/** Re-validates free text at publish time (drafts may hold rejected text). */
function parseAboutCheck(profile: Profile): string | null {
  const location = checkFreeText(profile.location);
  if (location) return describeTextProblem(location, 'location');
  const bio = checkFreeText(profile.bio);
  return bio ? describeTextProblem(bio, 'bio') : null;
}
