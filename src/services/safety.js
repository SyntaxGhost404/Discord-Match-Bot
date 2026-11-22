// Safety service: ban checks, emergency blocks, and user reports.
// Mirrors the reference services/safety.js surface.

import { db } from './database.js';
import { nowIso } from '../util.js';

export const safety = {
  /**
   * checkUserSafetyStatus(userId) -> { isAllowed, reason }.
   * Banned users are denied with the stored reason; everyone else is allowed.
   */
  checkUserSafetyStatus(userId) {
    const ban = db.db.bans[String(userId)];
    if (ban) {
      return { isAllowed: false, reason: ban.reason || 'This account is not allowed to use the bot.' };
    }
    return { isAllowed: true, reason: null };
  },

  /**
   * emergencyBlockUser(userId, partnerId, reason, meta): record a block
   * between the pair. The caller ends the chat session separately (see
   * commands/block.js). meta.source is 'chat' (live /block) or 'recent'
   * (blocking the last partner after the chat ended).
   */
  emergencyBlockUser(userId, partnerId, reason, meta = {}) {
    db.blockUser(userId, partnerId, meta);
    return true;
  },

  /**
   * createReport(reporterId, targetId, reason, description, history=[]) ->
   * the new report's id string. Persisted for later review.
   */
  createReport(reporterId, targetId, reason, description, history = []) {
    const report = {
      id: `rp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      reporterId: String(reporterId),
      targetId: String(targetId),
      reason: String(reason || ''),
      description: String(description || ''),
      history: Array.isArray(history) ? history : [],
      at: nowIso(),
      status: 'open',
    };
    db.addReport(report);
    return report.id;
  },
};
