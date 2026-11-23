// Reports and the moderator action log.

import { fromJsonArray, toJson, type Database } from '../database.ts';

export type ReportStatus = 'open' | 'actioned' | 'dismissed';
export type ReportContext = 'profile' | 'like' | 'match' | 'chat';

export interface EvidenceLine {
  at: number;
  from: 'reporter' | 'reported';
  text: string;
}

export interface ReportRecord {
  id: number;
  reporterId: string;
  targetId: string;
  context: ReportContext;
  reason: string;
  details: string;
  evidence: EvidenceLine[];
  status: ReportStatus;
  modChannelId: string | null;
  modMessageId: string | null;
  resolvedBy: string | null;
  resolvedAt: number | null;
  resolution: string | null;
  createdAt: number;
}

interface ReportRow {
  id: number;
  reporter_id: string;
  target_id: string;
  context: ReportContext;
  reason: string;
  details: string;
  evidence: string | null;
  status: ReportStatus;
  mod_channel_id: string | null;
  mod_message_id: string | null;
  resolved_by: string | null;
  resolved_at: number | null;
  resolution: string | null;
  created_at: number;
}

const toReport = (r: ReportRow): ReportRecord => ({
  id: r.id,
  reporterId: r.reporter_id,
  targetId: r.target_id,
  context: r.context,
  reason: r.reason,
  details: r.details,
  evidence: fromJsonArray<EvidenceLine>(r.evidence),
  status: r.status,
  modChannelId: r.mod_channel_id,
  modMessageId: r.mod_message_id,
  resolvedBy: r.resolved_by,
  resolvedAt: r.resolved_at,
  resolution: r.resolution,
  createdAt: r.created_at,
});

export class ReportsRepo {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  create(input: { reporterId: string; targetId: string; context: ReportContext; reason: string; details: string; evidence: EvidenceLine[] }, now: number): ReportRecord {
    const row = this.db.get<ReportRow>(
      `INSERT INTO reports (reporter_id, target_id, context, reason, details, evidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      [input.reporterId, input.targetId, input.context, input.reason, input.details, input.evidence.length ? toJson(input.evidence) : null, now],
    )!;
    return toReport(row);
  }

  get(id: number): ReportRecord | null {
    const row = this.db.get<ReportRow>('SELECT * FROM reports WHERE id = ?', [id]);
    return row ? toReport(row) : null;
  }

  setModMessage(id: number, channelId: string, messageId: string): void {
    this.db.run('UPDATE reports SET mod_channel_id = ?, mod_message_id = ? WHERE id = ?', [channelId, messageId, id]);
  }

  /** Resolves an open report; returns false if it was already resolved. */
  resolve(id: number, status: Exclude<ReportStatus, 'open'>, by: string, resolution: string, now: number): boolean {
    return (
      this.db.run(`UPDATE reports SET status = ?, resolved_by = ?, resolution = ?, resolved_at = ? WHERE id = ? AND status = 'open'`, [status, by, resolution, now, id])
        .changes > 0
    );
  }

  /** Resolves every open report against a user (after a ban, for example). */
  resolveAllAgainst(targetId: string, status: Exclude<ReportStatus, 'open'>, by: string, resolution: string, now: number): ReportRecord[] {
    return this.db
      .all<ReportRow>(
        `UPDATE reports SET status = ?, resolved_by = ?, resolution = ?, resolved_at = ? WHERE target_id = ? AND status = 'open' RETURNING *`,
        [status, by, resolution, now, targetId],
      )
      .map(toReport);
  }

  distinctOpenReportersSince(targetId: string, since: number): number {
    return this.db.get<{ n: number }>(
      `SELECT COUNT(DISTINCT reporter_id) AS n FROM reports WHERE target_id = ? AND status = 'open' AND created_at > ?`,
      [targetId, since],
    )!.n;
  }

  countByReporterSince(reporterId: string, since: number): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ? AND created_at > ?', [reporterId, since])!.n;
  }

  against(targetId: string, limit: number): ReportRecord[] {
    return this.db.all<ReportRow>('SELECT * FROM reports WHERE target_id = ? ORDER BY created_at DESC LIMIT ?', [targetId, limit]).map(toReport);
  }

  countAgainst(targetId: string): { total: number; open: number } {
    const row = this.db.get<{ total: number; open: number | null }>(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open FROM reports WHERE target_id = ?`,
      [targetId],
    )!;
    return { total: row.total, open: row.open ?? 0 };
  }

  listOpen(limit: number): ReportRecord[] {
    return this.db.all<ReportRow>(`SELECT * FROM reports WHERE status = 'open' ORDER BY created_at DESC LIMIT ?`, [limit]).map(toReport);
  }

  countOpen(): number {
    return this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM reports WHERE status = 'open'`)!.n;
  }
}

export interface ModActionRecord {
  id: number;
  moderatorId: string;
  targetId: string;
  action: string;
  reason: string | null;
  reportId: number | null;
  createdAt: number;
}

export class ModActionsRepo {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  log(input: { moderatorId: string; targetId: string; action: string; reason?: string | null; reportId?: number | null }, now: number): void {
    this.db.run(
      'INSERT INTO mod_actions (moderator_id, target_id, action, reason, report_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [input.moderatorId, input.targetId, input.action, input.reason ?? null, input.reportId ?? null, now],
    );
  }

  forTarget(targetId: string, limit: number): ModActionRecord[] {
    return this.db
      .all<{ id: number; moderator_id: string; target_id: string; action: string; reason: string | null; report_id: number | null; created_at: number }>(
        'SELECT * FROM mod_actions WHERE target_id = ? ORDER BY created_at DESC LIMIT ?',
        [targetId, limit],
      )
      .map((r) => ({
        id: r.id,
        moderatorId: r.moderator_id,
        targetId: r.target_id,
        action: r.action,
        reason: r.reason,
        reportId: r.report_id,
        createdAt: r.created_at,
      }));
  }
}
