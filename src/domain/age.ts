// Birthdays and age rules.
//
// Only the birth date is stored; ages are always computed live, so a
// birthday automatically moves someone into the right age group.
//
// Safety rules (absolute, checked before anything else):
//   * minimum age is 13 (Discord's own minimum)
//   * teens (13-17) and adults (18+) are never shown to or paired with each other
//   * teens are only matched with teens born at most 2 years apart
//     (calendar-exact, not rounded), and that window can never be widened

export const MIN_AGE = 13;
export const ADULT_AGE = 18;
export const MAX_AGE = 100;
export const TEEN_MAX_GAP_YEARS = 2;
export const ADULT_DEFAULT_SPREAD = 7;

export type AgeGroup = 'teen' | 'adult';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const isLeapYear = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const pad = (n: number) => String(n).padStart(2, '0');

function validDate(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1) return false;
  const days = [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
  return d <= days;
}

export type BirthDateResult =
  | { ok: true; date: string }
  | { ok: false; reason: 'format' | 'invalid' | 'future' | 'too_old' };

/**
 * Accepts the formats people actually type: 24.07.2006, 24/7/2006, 24-07-2006,
 * 2006-07-24, "24 July 2006", "July 24, 2006". Day-first is assumed for
 * numeric dates unless that is impossible (e.g. 07/24/2006 → 24 July).
 */
export function parseBirthDate(input: string, today: Date = new Date()): BirthDateResult {
  const raw = input.trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1');
  let y: number | undefined;
  let m: number | undefined;
  let d: number | undefined;

  let match = /^(\d{4})[-./ ](\d{1,2})[-./ ](\d{1,2})$/.exec(raw);
  if (match) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = /^(\d{1,2})[-./ ]+(\d{1,2})[-./ ]+(\d{4})$/.exec(raw))) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    y = Number(match[3]);
    if (b > 12 && a <= 12) [m, d] = [a, b]; // only month-first makes sense
    else [d, m] = [a, b];
  } else if ((match = /^(\d{1,2})[ .-]*([a-z]{3,})\.?[ ,.-]*(\d{4})$/.exec(raw))) {
    d = Number(match[1]);
    m = monthFromName(match[2]!);
    y = Number(match[3]);
  } else if ((match = /^([a-z]{3,})\.?[ .-]*(\d{1,2})[ ,.-]+(\d{4})$/.exec(raw))) {
    m = monthFromName(match[1]!);
    d = Number(match[2]);
    y = Number(match[3]);
  } else {
    return { ok: false, reason: 'format' };
  }

  if (m === undefined || !validDate(y!, m, d!)) return { ok: false, reason: 'invalid' };
  const iso = `${y}-${pad(m)}-${pad(d!)}`;
  if (iso > todayIso(today)) return { ok: false, reason: 'future' };
  if (ageOn(iso, today) > MAX_AGE) return { ok: false, reason: 'too_old' };
  return { ok: true, date: iso };
}

function monthFromName(name: string): number | undefined {
  const index = MONTHS.indexOf(name.slice(0, 3));
  return index >= 0 ? index + 1 : undefined;
}

export function todayIso(now: Date | number = new Date()): string {
  const date = typeof now === 'number' ? new Date(now) : now;
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Age in whole years on a given day. Feb 29 birthdays count on Feb 28 in common years. */
export function ageOn(birthDate: string, at: Date | number = new Date()): number {
  const [y, m, d] = birthDate.split('-').map(Number) as [number, number, number];
  const now = typeof at === 'number' ? new Date(at) : at;
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const day = now.getUTCDate();
  const birthdayDay = m === 2 && d === 29 && !isLeapYear(year) ? 28 : d;
  let age = year - y;
  if (month < m || (month === m && day < birthdayDay)) age--;
  return age;
}

export function ageGroupOf(age: number): AgeGroup | 'child' {
  if (age < MIN_AGE) return 'child';
  return age >= ADULT_AGE ? 'adult' : 'teen';
}

/** The date `years` after `date` (Feb 29 → Feb 28 when needed). */
export function addYears(date: string, years: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const year = y + years;
  const day = m === 2 && d === 29 && !isLeapYear(year) ? 28 : d;
  return `${year}-${pad(m)}-${pad(day)}`;
}

/** True when the two birth dates are at most `years` apart (calendar-exact). */
export function withinYears(a: string, b: string, years: number): boolean {
  const [older, younger] = a <= b ? [a, b] : [b, a];
  return younger <= addYears(older, years);
}

/** Default "show me ages" window for adults. */
export function defaultAdultRange(age: number): { min: number; max: number } {
  return { min: Math.max(ADULT_AGE, age - ADULT_DEFAULT_SPREAD), max: Math.min(MAX_AGE, age + ADULT_DEFAULT_SPREAD) };
}

/** "24 July 2006" */
export function formatBirthDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTH_NAMES[m - 1]} ${y}`;
}

/** Epoch ms of the next birthday after `now` (used for "you can join on…"). */
export function dateWhenAge(birthDate: string, age: number): number {
  const target = addYears(birthDate, age);
  return Date.parse(`${target}T00:00:00Z`);
}
