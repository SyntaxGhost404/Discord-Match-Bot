import { fromJsonArray, toJson, type Database, type SqlInput } from '../database.ts';
import type { Profile, ProfileStage, Visibility } from '../../domain/profile.ts';
import type { Gender } from '../../domain/catalog.ts';

interface ProfileRow {
  user_id: string;
  stage: ProfileStage;
  visibility: Visibility;
  name: string;
  birth_date: string | null;
  gender: Gender;
  bio: string;
  location: string;
  languages: string;
  interests: string;
  looking_for: string;
  show_genders: string;
  age_min: number | null;
  age_max: number | null;
  same_language_only: number;
  like_alerts: number;
  chat_filter: number;
  guidelines_at: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  last_active_at: number;
}

export const toProfile = (r: ProfileRow): Profile => ({
  userId: r.user_id,
  stage: r.stage,
  visibility: r.visibility,
  name: r.name,
  birthDate: r.birth_date,
  gender: r.gender,
  bio: r.bio,
  location: r.location,
  languages: fromJsonArray(r.languages),
  interests: fromJsonArray(r.interests),
  lookingFor: fromJsonArray(r.looking_for),
  showGenders: fromJsonArray<Gender>(r.show_genders),
  ageMin: r.age_min,
  ageMax: r.age_max,
  sameLanguageOnly: r.same_language_only === 1,
  likeAlerts: r.like_alerts === 1,
  chatFilter: r.chat_filter === 1,
  guidelinesAcceptedAt: r.guidelines_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  completedAt: r.completed_at,
  lastActiveAt: r.last_active_at,
});

export type ProfilePatch = Partial<Omit<Profile, 'userId' | 'createdAt' | 'updatedAt'>>;

const COLUMNS: Record<keyof ProfilePatch, { column: string; encode?: (v: never) => SqlInput }> = {
  stage: { column: 'stage' },
  visibility: { column: 'visibility' },
  name: { column: 'name' },
  birthDate: { column: 'birth_date' },
  gender: { column: 'gender' },
  bio: { column: 'bio' },
  location: { column: 'location' },
  languages: { column: 'languages', encode: (v: string[]) => toJson(v) },
  interests: { column: 'interests', encode: (v: string[]) => toJson(v) },
  lookingFor: { column: 'looking_for', encode: (v: string[]) => toJson(v) },
  showGenders: { column: 'show_genders', encode: (v: string[]) => toJson(v) },
  ageMin: { column: 'age_min' },
  ageMax: { column: 'age_max' },
  sameLanguageOnly: { column: 'same_language_only' },
  likeAlerts: { column: 'like_alerts' },
  chatFilter: { column: 'chat_filter' },
  guidelinesAcceptedAt: { column: 'guidelines_at' },
  completedAt: { column: 'completed_at' },
  lastActiveAt: { column: 'last_active_at' },
};

const ACTIVE_USER = '(u.banned_until IS NULL OR u.banned_until <= :now)';
const NOT_BLOCKED = (a: string, b: string) =>
  `NOT EXISTS (SELECT 1 FROM blocks bl WHERE (bl.blocker_id = ${a} AND bl.blocked_id = ${b}) OR (bl.blocker_id = ${b} AND bl.blocked_id = ${a}))`;

export interface PendingLike {
  profile: Profile;
  note: string | null;
  likedAt: number;
}

export class ProfilesRepo {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  get(userId: string): Profile | null {
    const row = this.db.get<ProfileRow>('SELECT * FROM profiles WHERE user_id = ?', [userId]);
    return row ? toProfile(row) : null;
  }

  getMany(userIds: string[]): Map<string, Profile> {
    const out = new Map<string, Profile>();
    if (!userIds.length) return out;
    const placeholders = userIds.map(() => '?').join(',');
    for (const row of this.db.all<ProfileRow>(`SELECT * FROM profiles WHERE user_id IN (${placeholders})`, userIds)) {
      out.set(row.user_id, toProfile(row));
    }
    return out;
  }

  createDraft(userId: string, defaults: { name: string; languages: string[] }, now: number): Profile {
    this.db.run(
      `INSERT OR IGNORE INTO profiles (user_id, stage, name, languages, created_at, updated_at, last_active_at)
       VALUES (?, 'basics', ?, ?, ?, ?, ?)`,
      [userId, defaults.name, toJson(defaults.languages), now, now, now],
    );
    return this.get(userId)!;
  }

  update(userId: string, patch: ProfilePatch, now: number): Profile {
    const sets: string[] = ['updated_at = :updated_at'];
    const params: Record<string, SqlInput> = { user_id: userId, updated_at: now };
    for (const [key, value] of Object.entries(patch) as Array<[keyof ProfilePatch, unknown]>) {
      if (value === undefined) continue;
      const spec = COLUMNS[key];
      sets.push(`${spec.column} = :${spec.column}`);
      params[spec.column] = spec.encode ? spec.encode(value as never) : (value as SqlInput);
    }
    const result = this.db.run(`UPDATE profiles SET ${sets.join(', ')} WHERE user_id = :user_id`, params);
    if (result.changes === 0) throw new Error(`No profile for user ${userId}`);
    return this.get(userId)!;
  }

  touchActive(userId: string, now: number): void {
    this.db.run('UPDATE profiles SET last_active_at = ? WHERE user_id = ?', [now, userId]);
  }

  delete(userId: string): void {
    this.db.run('DELETE FROM profiles WHERE user_id = ?', [userId]);
  }

  /**
   * SQL pre-filter for Discover: complete & visible profiles in a birth-date
   * window that the viewer hasn't liked, recently passed, or blocked (either
   * way), whose owners aren't banned. Final compatibility is decided in code.
   */
  discoverCandidates(params: { viewerId: string; birthMin: string; birthMax: string; passCutoff: number; now: number; limit: number }): Profile[] {
    return this.db
      .all<ProfileRow>(
        `SELECT p.* FROM profiles p JOIN users u ON u.id = p.user_id
         WHERE p.stage = 'complete' AND p.visibility = 'visible'
           AND p.user_id <> :viewer
           AND p.birth_date BETWEEN :birth_min AND :birth_max
           AND ${ACTIVE_USER}
           AND ${NOT_BLOCKED(':viewer', 'p.user_id')}
           AND NOT EXISTS (
             SELECT 1 FROM swipes s WHERE s.actor_id = :viewer AND s.target_id = p.user_id
               AND (s.kind = 'like' OR s.created_at > :pass_cutoff))
         ORDER BY p.last_active_at DESC
         LIMIT :limit`,
        {
          viewer: params.viewerId,
          birth_min: params.birthMin,
          birth_max: params.birthMax,
          pass_cutoff: params.passCutoff,
          now: params.now,
          limit: params.limit,
        },
      )
      .map(toProfile);
  }

  /** People who liked `userId` and haven't been answered yet (oldest first). */
  pendingLikes(userId: string, now: number, limit: number): PendingLike[] {
    const rows = this.db.all<ProfileRow & { note: string | null; liked_at: number }>(
      `SELECT p.*, s.note AS note, s.created_at AS liked_at
       FROM swipes s
       JOIN profiles p ON p.user_id = s.actor_id
       JOIN users u ON u.id = s.actor_id
       WHERE s.target_id = :me AND s.kind = 'like'
         AND p.stage = 'complete' AND p.visibility <> 'hidden'
         AND ${ACTIVE_USER}
         AND NOT EXISTS (SELECT 1 FROM swipes r WHERE r.actor_id = :me AND r.target_id = s.actor_id)
         AND ${NOT_BLOCKED(':me', 's.actor_id')}
       ORDER BY s.created_at ASC
       LIMIT :limit`,
      { me: userId, now, limit },
    );
    return rows.map((row) => ({ profile: toProfile(row), note: row.note, likedAt: row.liked_at }));
  }

  countComplete(): { total: number; visible: number; teens: number } {
    const row = this.db.get<{ total: number; visible: number }>(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN visibility = 'visible' THEN 1 ELSE 0 END) AS visible
       FROM profiles WHERE stage = 'complete'`,
    )!;
    const teenCutoff = new Date();
    teenCutoff.setUTCFullYear(teenCutoff.getUTCFullYear() - 18);
    const teens = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM profiles WHERE stage = 'complete' AND birth_date > ?`,
      [teenCutoff.toISOString().slice(0, 10)],
    )!.n;
    return { total: row.total, visible: row.visible ?? 0, teens };
  }
}
