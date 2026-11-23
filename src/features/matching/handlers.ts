// /discover, /likes, /matches and their buttons.

import { modalValues, type ComponentContext, type ModalContext } from '../../interactions/context.ts';
import type { Router } from '../../interactions/router.ts';
import type { App } from '../../core/app.ts';
import { checkFreeText, describeTextProblem, sanitizeMultiline } from '../../domain/text.ts';
import { reportModal } from '../safety/ui.ts';
import { profileName } from '../../ui/profile-card.ts';
import { likeNoteModal, matchCard, NOTE_MAX, unmatchConfirmCard } from './ui.ts';
import { candidateView, discoverView, likesView, matchDetailView, matchesView } from './views.ts';

const matchArg = (args: string[]): number | null => {
  const id = Number(args[0]);
  return Number.isInteger(id) && id > 0 ? id : null;
};

export function registerMatching(app: App, router: Router): void {
  const { store } = app;
  /** Buttons carry opaque profile references, never Discord ids. */
  const targetArg = (args: string[]): string | null => {
    const userId = args[0] ? store.refs.userFor(args[0]) : null;
    return userId && userId !== '' ? userId : null;
  };

  /** Records a like and shows the outcome on the card the button lives on. */
  async function likeAndShow(ctx: ComponentContext | ModalContext, targetId: string, options: { note?: string; fromInbox: boolean }): Promise<void> {
    const result = app.matching.like(ctx.user.id, targetId, { note: options.note, fromInbox: options.fromInbox, notifyActor: !ctx.inBotDm });
    const next = () => (options.fromInbox ? likesView(app, ctx.user.id) : discoverView(app, ctx.user.id));
    if (result.status === 'match') {
      const other = store.profiles.get(targetId);
      const me = app.matching.profile(ctx.user.id);
      if (!other || !me) return ctx.update(next());
      const extra = ctx.inBotDm ? undefined : 'I also sent you the details in DMs.';
      return ctx.update(
        matchCard(other, store.photos.list(targetId), result.match, {
          now: app.clock(),
          viewer: me,
          continueWith: options.fromInbox ? 'likes' : 'discover',
          intro: extra ? `You and **${profileName(other)}** liked each other. ${extra}` : undefined,
        }),
      );
    }
    if (result.status === 'limit') return ctx.update(discoverView(app, ctx.user.id));
    if (result.status === 'unavailable') {
      return ctx.update(options.fromInbox ? likesView(app, ctx.user.id, '-# That person is no longer available.') : discoverView(app, ctx.user.id));
    }
    await ctx.update(next());
  }

  // -- discover ----------------------------------------------------------------------------

  router.command({ name: 'discover', gate: 'profile', run: (ctx) => ctx.reply(discoverView(app, ctx.user.id)) });
  router.component({ ns: 'dsc', action: 'open', gate: 'profile', run: (ctx) => ctx.update(discoverView(app, ctx.user.id)) });

  router.component({
    ns: 'dsc',
    action: 'like',
    gate: 'profile',
    run: async (ctx, args) => {
      const target = targetArg(args);
      if (!target) return ctx.update(discoverView(app, ctx.user.id));
      await likeAndShow(ctx, target, { fromInbox: false });
    },
  });

  router.component({
    ns: 'dsc',
    action: 'note',
    gate: 'profile',
    run: async (ctx, args) => {
      const target = targetArg(args);
      if (!target) return ctx.update(discoverView(app, ctx.user.id));
      if (app.matching.likesLeft(ctx.user.id).left === 0) return ctx.update(discoverView(app, ctx.user.id));
      await ctx.showModal(likeNoteModal(store.refs.refFor(target)));
    },
  });

  router.modal({
    ns: 'dsc',
    action: 'note',
    gate: 'profile',
    run: async (ctx, args) => {
      const target = targetArg(args);
      if (!target) return ctx.update(discoverView(app, ctx.user.id));
      const note = sanitizeMultiline(modalValues(ctx).text('note'), NOTE_MAX, 6);
      const problem = note ? checkFreeText(note) : 'too_short';
      if (problem) return ctx.update(candidateView(app, ctx.user.id, target, `⚠️ ${problem === 'too_short' ? 'Your note was empty.' : describeTextProblem(problem, 'note')}`));
      await likeAndShow(ctx, target, { note, fromInbox: false });
    },
  });

  router.component({
    ns: 'dsc',
    action: 'skip',
    gate: 'profile',
    run: async (ctx, args) => {
      const target = targetArg(args);
      if (target) app.matching.pass(ctx.user.id, target);
      await ctx.update(discoverView(app, ctx.user.id));
    },
  });

  router.component({
    ns: 'dsc',
    action: 'report',
    gate: 'profile',
    run: async (ctx, args) => {
      const target = targetArg(args);
      if (!target) return ctx.update(discoverView(app, ctx.user.id));
      await ctx.showModal(reportModal('profile', store.refs.refFor(target)));
    },
  });

  // -- likes inbox ---------------------------------------------------------------------------

  router.command({ name: 'likes', gate: 'profile', run: (ctx) => ctx.reply(likesView(app, ctx.user.id)) });
  router.component({ ns: 'lk', action: 'open', gate: 'profile', run: (ctx) => ctx.update(likesView(app, ctx.user.id)) });

  router.component({
    ns: 'lk',
    action: 'yes',
    gate: 'profile',
    run: async (ctx, args) => {
      const target = targetArg(args);
      if (!target) return ctx.update(likesView(app, ctx.user.id));
      await likeAndShow(ctx, target, { fromInbox: true });
    },
  });

  router.component({
    ns: 'lk',
    action: 'no',
    gate: 'profile',
    run: async (ctx, args) => {
      const target = targetArg(args);
      if (target) app.matching.pass(ctx.user.id, target);
      await ctx.update(likesView(app, ctx.user.id));
    },
  });

  router.component({
    ns: 'lk',
    action: 'report',
    gate: 'profile',
    run: async (ctx, args) => {
      const target = targetArg(args);
      if (!target) return ctx.update(likesView(app, ctx.user.id));
      await ctx.showModal(reportModal('like', store.refs.refFor(target)));
    },
  });

  // -- matches -----------------------------------------------------------------------------------

  router.command({ name: 'matches', gate: 'profile', run: (ctx) => ctx.reply(matchesView(app, ctx.user.id, 0)) });
  router.component({
    ns: 'mt',
    action: 'list',
    gate: 'profile',
    run: (ctx, args) => ctx.update(matchesView(app, ctx.user.id, Number(args[0]) || 0)),
  });

  router.component({
    ns: 'mt',
    action: 'view',
    gate: 'profile',
    run: async (ctx, args) => {
      const id = matchArg(args);
      await ctx.update(id ? matchDetailView(app, ctx.user.id, id) : matchesView(app, ctx.user.id, 0));
    },
  });

  router.component({
    ns: 'mt',
    action: 'unmatch',
    gate: 'profile',
    run: async (ctx, args) => {
      const id = matchArg(args);
      const found = id ? app.matching.activeMatchFor(id, ctx.user.id) : null;
      if (!found) return ctx.update(matchesView(app, ctx.user.id, 0, '⚠️ That match is no longer available.'));
      await ctx.update(unmatchConfirmCard(store.profiles.get(found.otherId), found.match));
    },
  });

  router.component({
    ns: 'mt',
    action: 'unmatch_yes',
    gate: 'profile',
    run: async (ctx, args) => {
      const id = matchArg(args);
      const ended = id ? app.matching.unmatch(id, ctx.user.id) : null;
      await ctx.update(matchesView(app, ctx.user.id, 0, ended ? '💔 Unmatched.' : '⚠️ That match is no longer available.'));
    },
  });

  router.component({
    ns: 'mt',
    action: 'report',
    gate: 'profile',
    run: async (ctx, args) => {
      const id = matchArg(args);
      const found = id ? app.matching.activeMatchFor(id, ctx.user.id) : null;
      if (!found) return ctx.update(matchesView(app, ctx.user.id, 0, '⚠️ That match is no longer available.'));
      await ctx.showModal(reportModal('match', found.match.id));
    },
  });

}
