// Report submissions from every place a report can be filed.

import { modalValues, type ModalContext } from '../../interactions/context.ts';
import type { Router } from '../../interactions/router.ts';
import type { App } from '../../core/app.ts';
import { REPORT_REASONS } from '../../domain/catalog.ts';
import { sanitizeMultiline } from '../../domain/text.ts';
import type { ReportContext } from '../../db/repos/moderation.ts';
import { partnerOf } from '../../db/repos/chat.ts';
import { otherUser } from '../../db/repos/social.ts';
import { DAY } from '../../util/time.ts';
import { isV2Message, notice } from '../../ui/common.ts';
import { discoverView, likesView, matchesView } from '../matching/views.ts';
import { summaryRows, summaryUpdated } from '../chat/ui.ts';

const THANKS = '✅ **Thanks — your report was sent to the moderators.**';

export function registerSafety(app: App, router: Router): void {
  const { store } = app;

  const resolveTarget = (ctx: ModalContext, context: ReportContext, ref: string | undefined): { targetId: string; sessionId?: number; note?: string | null } | null => {
    const userId = ctx.user.id;
    if (context === 'profile' || context === 'like') {
      const targetId = ref ? store.refs.userFor(ref) : null;
      if (!targetId || targetId === userId) return null;
      return { targetId, note: context === 'like' ? (store.swipes.get(targetId, userId)?.note ?? null) : null };
    }
    const id = Number(ref);
    if (!Number.isInteger(id) || id <= 0) return null;
    if (context === 'match') {
      const match = store.matches.get(id);
      if (!match || (match.userLow !== userId && match.userHigh !== userId)) return null;
      return { targetId: otherUser(match, userId) };
    }
    const session = store.chat.get(id);
    if (!session || (session.userA !== userId && session.userB !== userId)) return null;
    // Reports are accepted during the chat and for a day after it ended.
    if (session.endedAt !== null && app.clock() - session.endedAt > DAY) return null;
    return { targetId: partnerOf(session, userId), sessionId: session.id };
  };

  for (const context of ['profile', 'like', 'match', 'chat'] as const) {
    router.modal({
      ns: 'rep',
      action: context,
      gate: 'profile',
      run: async (ctx, args) => {
        const target = resolveTarget(ctx, context, args[0]);
        if (!target) return ctx.reply(notice('That person or chat is no longer available to report.', 'warning'), { ephemeral: true });
        const values = modalValues(ctx);
        const reasonRaw = values.radio('reason') ?? 'other';
        const reason = REPORT_REASONS.some((r) => r.key === reasonRaw) ? reasonRaw : 'other';
        const outcome = await app.safety.report({
          reporterId: ctx.user.id,
          targetId: target.targetId,
          context,
          reason,
          details: sanitizeMultiline(values.text('details'), 1000, 20),
          block: values.checked('block'),
          sessionId: target.sessionId,
          note: target.note,
        });
        if (!outcome.ok) {
          const text = outcome.reason === 'limit' ? "You've sent a lot of reports today. Please wait a bit before sending more." : "You can't report yourself.";
          return ctx.reply(notice(text, 'warning'), { ephemeral: true });
        }
        const thanks = values.checked('block') ? `${THANKS} They're blocked, too.` : THANKS;
        if (context === 'profile') return ctx.update(discoverView(app, ctx.user.id, thanks));
        if (context === 'like') return ctx.update(likesView(app, ctx.user.id, thanks));
        if (context === 'match') return ctx.update(matchesView(app, ctx.user.id, 0, thanks));
        // Chat: the source is either the live chat card (V2) or the summary (classic).
        if (ctx.sourceMessage && !isV2Message(ctx.sourceMessage.flags)) {
          return ctx.update(summaryUpdated(ctx.sourceMessage.embeds, 'Reported — thanks for keeping chats safe.', summaryRows(target.sessionId!, { rate: false, block: false, report: false })));
        }
        await ctx.update(notice(`${thanks} The chat is closed.`, 'success'));
      },
    });
  }
}
