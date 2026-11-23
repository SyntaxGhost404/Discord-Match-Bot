// /chat, /next, /stop and the buttons on chat cards.

import { button, row } from '../../discord/components/builders.ts';
import type { AnyContext, ComponentContext } from '../../interactions/context.ts';
import { cid } from '../../interactions/custom-id.ts';
import type { Router } from '../../interactions/router.ts';
import type { App } from '../../core/app.ts';
import { groupOf } from '../../domain/compatibility.ts';
import { partnerOf, sideOf } from '../../db/repos/chat.ts';
import { isV2Message, notice } from '../../ui/common.ts';
import { DAY } from '../../util/time.ts';
import { reportModal } from '../safety/ui.ts';
import type { JoinOutcome } from './service.ts';
import { chatIntroCard, chatStatusCard, endedCard, searchStoppedCard, searchingCard, summaryRows, summaryUpdated } from './ui.ts';

const sessionArg = (args: string[]): number | null => {
  const id = Number(args[0]);
  return Number.isInteger(id) && id > 0 ? id : null;
};

export function registerChat(app: App, router: Router): void {
  const { store } = app;

  const cancelRow = () => row(button(cid('chat', 'cancel'), 'Cancel search', { emoji: '✖️' }));

  /** Shows the right card for "you are now searching". */
  async function showSearching(ctx: AnyContext, joinedAt: number): Promise<void> {
    if (!ctx.inBotDm) {
      await ctx.update(notice("🔎 **Searching…** I'll ping you in our DMs as soon as you're connected — the chat happens there.", 'info', [cancelRow()]));
      return;
    }
    const payload = searchingCard(joinedAt);
    const source = ctx.sourceMessage;
    if (source && isV2Message(source.flags) && ctx.ackState !== 'deferred-reply') {
      await ctx.update(payload);
      app.chat.setQueueCard(ctx.user.id, source.channel_id, source.id);
    } else {
      await ctx.reply(payload, { withMessage: true });
      if (ctx.responseMessageId && ctx.channelId) app.chat.setQueueCard(ctx.user.id, ctx.channelId, ctx.responseMessageId);
    }
  }

  async function presentJoin(ctx: AnyContext, outcome: JoinOutcome): Promise<void> {
    switch (outcome.kind) {
      case 'connected':
      case 'already_chatting': {
        const where = ctx.inBotDm ? 'Your chat is right below — say hi!' : 'Head to our DMs — your chat is waiting there.';
        const lead = outcome.kind === 'connected' ? "🎉 **You're connected!**" : "💬 **You're already in a chat.**";
        return ctx.update(notice(`${lead} ${where}`, 'success'));
      }
      case 'queued':
      case 'already_queued':
        return showSearching(ctx, outcome.entry.joinedAt);
      case 'dm_closed':
        return ctx.update(searchStoppedCard('unreachable', app.config.supportServerUrl));
      case 'unavailable':
        return ctx.update(notice('Anonymous chat needs a finished profile. Use `/start` to create one.', 'warning'));
    }
  }

  async function start(ctx: AnyContext): Promise<void> {
    await presentJoin(ctx, await app.chat.join(ctx.user.id, { announceInDm: !ctx.inBotDm }));
  }

  async function openPanel(ctx: AnyContext): Promise<void> {
    const state = app.chat.state(ctx.user.id);
    if (state.kind === 'chatting') return ctx.update(chatStatusCard(state.session, sideOf(state.session, ctx.user.id)!));
    if (state.kind === 'queued') return showSearching(ctx, state.entry.joinedAt);
    const profile = app.matching.profile(ctx.user.id)!;
    await ctx.update(chatIntroCard(groupOf(profile, app.clock()) === 'teen'));
  }

  async function stop(ctx: AnyContext): Promise<void> {
    const state = app.chat.state(ctx.user.id);
    if (state.kind === 'chatting') {
      await ctx.deferReply();
      await app.chat.end(state.session.id, 'ended', ctx.user.id);
      return ctx.reply(notice('⏹️ **Chat ended.** Thanks for chatting!', 'info'));
    }
    if (state.kind === 'queued') {
      const entry = app.chat.leave(ctx.user.id);
      if (entry?.cardChannelId && entry.cardMessageId) await app.dm.edit(entry.cardChannelId, entry.cardMessageId, searchStoppedCard('cancelled'));
      return ctx.reply(notice('✖️ Search cancelled.', 'info'));
    }
    await ctx.reply(notice("You're not in a chat or searching right now. Use `/chat` to start one.", 'info'));
  }

  async function next(ctx: AnyContext): Promise<void> {
    const state = app.chat.state(ctx.user.id);
    if (state.kind !== 'chatting') return start(ctx);
    // Ending + searching makes several API calls: acknowledge first.
    await ctx.deferReply();
    const { join } = await app.chat.next(ctx.user.id, !ctx.inBotDm);
    await presentJoin(ctx, join);
  }

  /** The live session behind a chat-card button, or null (and a notice) if it's over. */
  async function liveSession(ctx: ComponentContext, args: string[]) {
    const id = sessionArg(args);
    const session = store.chat.activeFor(ctx.user.id);
    if (!id || !session || session.id !== id) {
      const ended = id ? store.chat.get(id) : null;
      await ctx.update(ended?.endedAt && isV2Message(ctx.sourceMessage?.flags) ? endedCard(ended) : notice('This chat has already ended.', 'info'));
      return null;
    }
    return session;
  }

  // -- commands ------------------------------------------------------------------------

  router.command({ name: 'chat', gate: 'profile', run: (ctx) => openPanel(ctx) });
  router.command({ name: 'next', gate: 'profile', run: (ctx) => next(ctx) });
  router.command({ name: 'stop', gate: 'profile', run: (ctx) => stop(ctx) });

  // -- buttons -------------------------------------------------------------------------

  router.component({ ns: 'chat', action: 'open', gate: 'profile', run: (ctx) => openPanel(ctx) });
  router.component({ ns: 'chat', action: 'start', gate: 'profile', run: (ctx) => start(ctx) });

  router.component({
    ns: 'chat',
    action: 'cancel',
    gate: 'profile',
    run: async (ctx) => {
      const entry = app.chat.leave(ctx.user.id);
      if (!entry) {
        const state = app.chat.state(ctx.user.id);
        if (state.kind === 'chatting') return ctx.update(chatStatusCard(state.session, sideOf(state.session, ctx.user.id)!));
        return ctx.update(searchStoppedCard('cancelled'));
      }
      if (entry.cardChannelId && entry.cardMessageId && entry.cardMessageId !== ctx.interaction.message.id) {
        await app.dm.edit(entry.cardChannelId, entry.cardMessageId, searchStoppedCard('cancelled'));
      }
      await ctx.update(searchStoppedCard('cancelled'));
    },
  });

  router.component({ ns: 'chat', action: 'next', gate: 'profile', run: (ctx) => next(ctx) });

  router.component({
    ns: 'chat',
    action: 'end',
    gate: 'profile',
    run: async (ctx, args) => {
      const session = await liveSession(ctx, args);
      if (!session) return;
      await ctx.deferUpdate();
      const ended = await app.chat.end(session.id, 'ended', ctx.user.id);
      await ctx.update(ended ? endedCard(ended) : notice('This chat has already ended.', 'info'));
    },
  });

  router.component({
    ns: 'chat',
    action: 'reveal',
    gate: 'profile',
    run: async (ctx, args) => {
      const session = await liveSession(ctx, args);
      if (!session) return;
      await ctx.deferUpdate();
      const result = await app.chat.reveal(session.id, ctx.user.id);
      const fresh = store.chat.get(session.id);
      if (result === 'not_found' || !fresh || fresh.endedAt) return ctx.update(notice('This chat has already ended.', 'info'));
      if (result === 'requested') {
        await ctx.followUp(notice("🤝 Reveal requested. Nothing is shared unless your partner agrees too.", 'info'), { ephemeral: true });
      }
      await ctx.update(chatStatusCard(fresh, sideOf(fresh, ctx.user.id)!));
    },
  });

  router.component({
    ns: 'chat',
    action: 'ice',
    gate: 'profile',
    run: async (ctx, args) => {
      const session = await liveSession(ctx, args);
      if (!session) return;
      const result = await app.chat.icebreaker(session.id, ctx.user.id);
      if (result === 'cooldown') return ctx.reply(notice('One icebreaker at a time — try again in a few seconds.', 'info'), { ephemeral: true });
      await ctx.deferUpdate();
    },
  });

  router.component({
    ns: 'chat',
    action: 'report',
    gate: 'profile',
    run: async (ctx, args) => {
      const id = sessionArg(args);
      const session = id ? store.chat.get(id) : null;
      const isParticipant = session && sideOf(session, ctx.user.id);
      const tooOld = session?.endedAt && app.clock() - session.endedAt > DAY;
      if (!session || !isParticipant || tooOld) return ctx.reply(notice('This chat can no longer be reported.', 'info'), { ephemeral: true });
      await ctx.showModal(reportModal('chat', session.id));
    },
  });

  router.component({
    ns: 'chat',
    action: 'rate',
    gate: 'profile',
    run: async (ctx, args) => {
      const id = sessionArg(args);
      const rating = args[1] === 'up' ? 1 : args[1] === 'down' ? -1 : null;
      if (!id || !rating) return ctx.deferUpdate();
      const result = app.chat.rate(id, ctx.user.id, rating);
      const note = result === 'ok' ? 'Thanks for the feedback! 💛' : result === 'already' ? 'You already rated this chat.' : 'This chat is no longer available.';
      await ctx.update(summaryUpdated(ctx.interaction.message.embeds, note, summaryRows(id, { rate: false, block: true, report: true })));
    },
  });

  router.component({
    ns: 'chat',
    action: 'block',
    gate: 'profile',
    run: async (ctx, args) => {
      const id = sessionArg(args);
      const session = id ? store.chat.get(id) : null;
      if (!session || !sideOf(session, ctx.user.id)) return ctx.deferUpdate();
      await ctx.deferUpdate();
      await app.safety.block(ctx.user.id, partnerOf(session, ctx.user.id), 'chat');
      const rows = summaryRows(session.id, { rate: false, block: false, report: true });
      if (isV2Message(ctx.interaction.message.flags)) return ctx.update(notice("🚫 **Blocked.** You won't be paired again.", 'success'));
      await ctx.update(summaryUpdated(ctx.interaction.message.embeds, "Blocked — you won't be paired again.", rows));
    },
  });
}
