// /settings: discovery filters, notifications, chat filter, privacy, blocked
// people and data deletion.

import {
  button,
  checkbox,
  checkboxGroup,
  choice,
  container,
  label,
  modal,
  option,
  row,
  section,
  separator,
  stringSelect,
  text,
  textInput,
  v2,
} from '../discord/components/builders.ts';
import type { MessagePayload, Modal } from '../discord/types.ts';
import { cid } from '../interactions/custom-id.ts';
import { modalValues, selectedValues, type AnyContext } from '../interactions/context.ts';
import type { Router } from '../interactions/router.ts';
import type { App } from '../core/app.ts';
import { GENDERS, type Gender } from '../domain/catalog.ts';
import { adultAgeRange, groupOf } from '../domain/compatibility.ts';
import { ADULT_AGE, MAX_AGE } from '../domain/age.ts';
import { profileHeadline } from '../ui/profile-card.ts';
import { Colors } from '../ui/theme.ts';
import { menuButton, notice, plural } from '../ui/common.ts';
import { discordTimestamp } from '../util/time.ts';
import { profileAge } from '../domain/profile.ts';
import { setPaused, visibilityLine } from './profile/handlers.ts';
import type { CompleteProfile } from './matching/service.ts';

const BLOCKS_PAGE = 10;
const SHOWABLE: Gender[] = ['woman', 'man', 'nonbinary'];

function showMeText(profile: CompleteProfile): string {
  if (!profile.showGenders.length) return 'Everyone';
  return profile.showGenders.map((g) => GENDERS.find((x) => x.key === g)?.plural ?? g).join(', ');
}

export function settingsPayload(app: App, userId: string, note?: string): MessagePayload {
  const profile = app.matching.profile(userId);
  if (!profile) throw new Error('settingsPayload requires a complete profile');
  const now = app.clock();
  const teen = groupOf(profile, now) === 'teen';
  const range = teen ? null : adultAgeRange(profile, now);
  const blocked = app.store.blocks.count(userId);
  const discovery = [
    teen ? 'Teens born within 2 years of you' : `Ages ${range!.min}–${range!.max}`,
    showMeText(profile),
    profile.sameLanguageOnly ? 'Shared language only' : 'Any language',
  ].join(' · ');
  const paused = profile.visibility === 'paused';

  return v2([
    container(
      [
        text(['## ⚙️ Settings', note ?? ''].filter(Boolean).join('\n')),
        separator(),
        section(['🎯 **Discovery filters**', `-# ${discovery}`], button(cid('set', 'filters'), 'Edit')),
        section(
          ['🔔 **Like alerts**', `-# ${profile.likeAlerts ? 'On — I DM you when someone likes you' : 'Off — check /likes yourself'}`],
          button(cid('set', 'toggle', 'likes'), profile.likeAlerts ? 'Turn off' : 'Turn on'),
        ),
        section(
          ['🧼 **Profanity filter in chats**', `-# ${teen ? 'Always on in teen chats' : profile.chatFilter ? 'On — swear words are masked' : 'Off'}`],
          button(cid('set', 'toggle', 'filter'), teen ? 'Always on' : profile.chatFilter ? 'Turn off' : 'Turn on', { disabled: teen }),
        ),
        section(
          ['👁️ **Profile visibility**', `-# ${visibilityLine(profile)}`],
          paused
            ? button(cid('set', 'resume'), 'Resume', { style: 'success' })
            : button(cid('set', 'pause'), 'Pause', { disabled: profile.visibility === 'hidden' }),
        ),
        section(['🚫 **Blocked people**', `-# ${blocked ? plural(blocked, 'person', 'people') : 'Nobody'}`], button(cid('set', 'blocked', 0), 'Manage', { disabled: !blocked })),
        section(['🗑️ **Delete my data**', '-# Removes your profile, photos, likes and matches'], button(cid('set', 'delete'), 'Delete…', { style: 'danger' })),
        separator(),
        row(button(cid('prof', 'view'), 'Profile', { emoji: '👤' }), menuButton()),
      ],
      { accent: Colors.settings },
    ),
  ]);
}

function filtersModal(profile: CompleteProfile, teen: boolean, now: number): Modal {
  const range = teen ? null : adultAgeRange(profile, now);
  const shown = new Set(profile.showGenders);
  return modal(cid('set', 'filters'), 'Discovery filters', [
    !teen && label('Youngest age to show', textInput('age_min', { min: 2, max: 3, required: true, value: String(range!.min), placeholder: String(ADULT_AGE) })),
    !teen && label('Oldest age to show', textInput('age_max', { min: 2, max: 3, required: true, value: String(range!.max), placeholder: String(MAX_AGE) })),
    label(
      'Show me',
      checkboxGroup(
        'show',
        SHOWABLE.map((g) => {
          const item = GENDERS.find((x) => x.key === g)!;
          return choice(g, `${item.emoji} ${item.plural}`, { selected: shown.has(g) });
        }),
        { min: 0, max: SHOWABLE.length, required: false },
      ),
      'Tick none to see everyone',
    ),
    label('Only people who share a language', checkbox('same_language', profile.sameLanguageOnly)),
  ]);
}

function deleteModal(): Modal {
  return modal(cid('set', 'delete'), 'Delete my data', [
    text('⚠️ This permanently deletes your profile, photos, likes and matches, and ends any chat. This cannot be undone.'),
    label('Type DELETE to confirm', textInput('confirm', { min: 6, max: 6, required: true, placeholder: 'DELETE' })),
  ]);
}

/** The blocked-people list. Select values are opaque references, never Discord ids. */
export function blockedListPayload(app: App, userId: string, page: number, note?: string): MessagePayload {
  const { store } = app;
  const total = store.blocks.count(userId);
  const pages = Math.max(1, Math.ceil(total / BLOCKS_PAGE));
  const safePage = Math.min(Math.max(0, page), pages - 1);
  const blocks = store.blocks.list(userId, safePage * BLOCKS_PAGE, BLOCKS_PAGE);
  const profiles = store.profiles.getMany(blocks.map((b) => b.blockedId));
  const now = app.clock();

  // People blocked from an anonymous chat stay anonymous here too.
  const describe = (blockedId: string, context: string | null, plain = false) => {
    if (context?.includes('chat')) return '🎲 Anonymous chat partner';
    const profile = profiles.get(blockedId);
    if (!profile) return 'Deleted account';
    return plain ? `${profile.name}, ${profileAge(profile, now) ?? '?'}` : profileHeadline(profile, now);
  };

  const lines = blocks.map((b) => `• **${describe(b.blockedId, b.context)}** · blocked ${discordTimestamp(b.createdAt, 'R')}`);
  return v2([
    container(
      [
        text([note ?? '', '## 🚫 Blocked people', total ? lines.join('\n') : 'You have not blocked anyone.'].filter(Boolean).join('\n')),
        blocks.length > 0 &&
          row(
            stringSelect(
              cid('set', 'unblock', safePage),
              blocks.map((b) => option(String(store.refs.refFor(b.blockedId)), `Unblock: ${describe(b.blockedId, b.context, true)}`.slice(0, 100))),
              { placeholder: 'Choose someone to unblock', min: 1, max: 1 },
            ),
          ),
        separator(),
        row(
          pages > 1 && button(cid('set', 'blocked', Math.max(0, safePage - 1)), 'Previous', { emoji: '◀️', disabled: safePage === 0 }),
          pages > 1 && button(cid('set', 'blocked', Math.min(pages - 1, safePage + 1)), 'Next', { emoji: '▶️', disabled: safePage >= pages - 1 }),
          button(cid('set', 'open'), 'Back to settings', { emoji: '⚙️' }),
        ),
      ],
      { accent: Colors.settings },
    ),
  ]);
}

export function registerSettings(app: App, router: Router): void {
  const { store } = app;
  const show = (ctx: AnyContext, note?: string) => ctx.update(settingsPayload(app, ctx.user.id, note));

  router.command({ name: 'settings', gate: 'profile', run: (ctx) => ctx.reply(settingsPayload(app, ctx.user.id)) });
  router.component({ ns: 'set', action: 'open', gate: 'profile', run: (ctx) => show(ctx) });

  router.component({
    ns: 'set',
    action: 'filters',
    gate: 'profile',
    run: (ctx) => {
      const profile = app.matching.profile(ctx.user.id)!;
      const now = app.clock();
      return ctx.showModal(filtersModal(profile, groupOf(profile, now) === 'teen', now));
    },
  });

  router.modal({
    ns: 'set',
    action: 'filters',
    gate: 'profile',
    run: async (ctx) => {
      const profile = app.matching.profile(ctx.user.id)!;
      const now = app.clock();
      const values = modalValues(ctx);
      const showGenders = values.values('show').filter((g): g is Gender => (SHOWABLE as string[]).includes(g));
      const patch: Parameters<typeof store.profiles.update>[1] = { showGenders, sameLanguageOnly: values.checked('same_language') };
      if (groupOf(profile, now) === 'adult') {
        const min = Number(values.text('age_min'));
        const max = Number(values.text('age_max'));
        if (!Number.isInteger(min) || !Number.isInteger(max) || min < ADULT_AGE || max > MAX_AGE || min > max) {
          return show(ctx, `⚠️ Ages must be whole numbers between ${ADULT_AGE} and ${MAX_AGE}, youngest first.`);
        }
        patch.ageMin = min;
        patch.ageMax = max;
      }
      store.profiles.update(ctx.user.id, patch, now);
      await show(ctx, '✅ Filters saved.');
    },
  });

  router.component({
    ns: 'set',
    action: 'toggle',
    gate: 'profile',
    run: async (ctx, args) => {
      const profile = app.matching.profile(ctx.user.id)!;
      const now = app.clock();
      if (args[0] === 'likes') {
        store.profiles.update(ctx.user.id, { likeAlerts: !profile.likeAlerts }, now);
        return show(ctx, profile.likeAlerts ? '🔕 Like alerts are off.' : '🔔 Like alerts are on.');
      }
      if (args[0] === 'filter' && groupOf(profile, now) === 'adult') {
        store.profiles.update(ctx.user.id, { chatFilter: !profile.chatFilter }, now);
        return show(ctx, profile.chatFilter ? 'Profanity filter is off.' : '🧼 Profanity filter is on.');
      }
      await show(ctx);
    },
  });

  for (const [action, paused] of [
    ['pause', true],
    ['resume', false],
  ] as const) {
    router.component({
      ns: 'set',
      action,
      gate: 'profile',
      run: (ctx) => show(ctx, setPaused(app, ctx.user.id, paused) === 'hidden' ? '🔒 Your profile is under review and stays hidden for now.' : undefined),
    });
  }

  router.component({
    ns: 'set',
    action: 'blocked',
    gate: 'profile',
    run: (ctx, args) => ctx.update(blockedListPayload(app, ctx.user.id, Number(args[0]) || 0)),
  });

  router.component({
    ns: 'set',
    action: 'unblock',
    gate: 'profile',
    run: async (ctx, args) => {
      const ref = selectedValues(ctx)[0];
      const blockedId = ref ? store.refs.userFor(ref) : null;
      const removed = blockedId ? app.safety.unblock(ctx.user.id, blockedId) : false;
      await ctx.update(blockedListPayload(app, ctx.user.id, Number(args[0]) || 0, removed ? '✅ Unblocked.' : undefined));
    },
  });

  router.component({ ns: 'set', action: 'delete', gate: 'profile', run: (ctx) => ctx.showModal(deleteModal()) });

  router.modal({
    ns: 'set',
    action: 'delete',
    gate: 'profile',
    run: async (ctx) => {
      if (modalValues(ctx).text('confirm').trim().toUpperCase() !== 'DELETE') {
        return show(ctx, '⚠️ Nothing was deleted — the confirmation word did not match.');
      }
      await ctx.deferUpdate();
      await app.accounts.delete(ctx.user.id);
      await ctx.update(notice('🗑️ **Your data has been deleted.** Thanks for being here — you can create a new profile any time with `/start`.', 'success'));
    },
  });
}
