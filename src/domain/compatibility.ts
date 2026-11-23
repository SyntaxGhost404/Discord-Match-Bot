// Who may see / be paired with whom. Pure functions, exhaustively unit tested.
//
// Order of checks matters for safety: the age-group wall comes first and can
// never be overridden by preferences.

import { ageOn, ageGroupOf, defaultAdultRange, TEEN_MAX_GAP_YEARS, withinYears, type AgeGroup } from './age.ts';
import type { Gender } from './catalog.ts';
import { DAY } from '../util/time.ts';

export interface Matchable {
  userId: string;
  birthDate: string;
  gender: Gender;
  languages: readonly string[];
  interests: readonly string[];
  lookingFor: readonly string[];
  showGenders: readonly Gender[];
  ageMin: number | null;
  ageMax: number | null;
  sameLanguageOnly: boolean;
}

export function groupOf(p: Pick<Matchable, 'birthDate'>, now: number): AgeGroup | null {
  const group = ageGroupOf(ageOn(p.birthDate, now));
  return group === 'child' ? null : group;
}

/** The ages an adult wants to see (their own setting or a sensible default). */
export function adultAgeRange(p: Pick<Matchable, 'birthDate' | 'ageMin' | 'ageMax'>, now: number): { min: number; max: number } {
  const fallback = defaultAdultRange(ageOn(p.birthDate, now));
  const min = Math.max(18, p.ageMin ?? fallback.min);
  const max = Math.min(100, p.ageMax ?? fallback.max);
  return min <= max ? { min, max } : fallback;
}

export function sharedKeys(a: readonly string[], b: readonly string[]): string[] {
  const set = new Set(b);
  return a.filter((key) => set.has(key));
}

/** Whether `viewer`'s own preferences accept `candidate` (one direction only). */
export function acceptsCandidate(viewer: Matchable, candidate: Matchable, now: number): boolean {
  if (viewer.showGenders.length && !viewer.showGenders.includes(candidate.gender)) return false;
  if (viewer.sameLanguageOnly && sharedKeys(viewer.languages, candidate.languages).length === 0) return false;
  if (groupOf(viewer, now) === 'adult') {
    const range = adultAgeRange(viewer, now);
    const age = ageOn(candidate.birthDate, now);
    if (age < range.min || age > range.max) return false;
  }
  return true;
}

/** Mutual compatibility. The age wall is checked before any preference. */
export function compatible(a: Matchable, b: Matchable, now: number): boolean {
  if (a.userId === b.userId) return false;
  const groupA = groupOf(a, now);
  const groupB = groupOf(b, now);
  if (!groupA || !groupB || groupA !== groupB) return false;
  if (groupA === 'teen' && !withinYears(a.birthDate, b.birthDate, TEEN_MAX_GAP_YEARS)) return false;
  return acceptsCandidate(a, b, now) && acceptsCandidate(b, a, now);
}

export interface ScoreExtras {
  likedViewer: boolean;
  photoCount: number;
  lastActiveAt: number;
  now: number;
  random?: () => number;
}

/** Ranking for Discover: shared ground first, then activity, with a little randomness. */
export function discoverScore(viewer: Matchable, candidate: Matchable, extras: ScoreExtras): number {
  const random = extras.random ?? Math.random;
  let score = 0;
  score += 3 * sharedKeys(viewer.interests, candidate.interests).length;
  score += 2 * sharedKeys(viewer.lookingFor, candidate.lookingFor).length;
  score += sharedKeys(viewer.languages, candidate.languages).length ? 4 : 0;
  if (extras.photoCount > 0) score += 2;
  if (extras.likedViewer) score += 6;
  const idle = extras.now - extras.lastActiveAt;
  if (idle < DAY) score += 3;
  else if (idle < 7 * DAY) score += 1.5;
  else if (idle > 30 * DAY) score -= 3;
  return score + random() * 3;
}

/** Ranking for anonymous chat partners (shared language matters most). */
export function chatScore(a: Matchable, b: Matchable): number {
  return 5 * Math.min(1, sharedKeys(a.languages, b.languages).length) + sharedKeys(a.interests, b.interests).length;
}
