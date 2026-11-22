// Date-of-birth utilities. The single rule: ages are NEVER stored.
//
// The profile keeps only the ISO dob string ("YYYY-MM-DD"); every age the
// bot acts on (pairing tiers, strike limits, profile display) is
// derived on the fly with ageFromDOB. When a user has a birthday, their tier
// and matching pool update automatically with no manual intervention.

const pad2 = (n) => String(n).padStart(2, '0');

export const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/**
 * Validate raw Day / Month / Year fields into an ISO dob ("YYYY-MM-DD").
 * Returns { ok: true, dob } or { ok: false, error } with warm, dash-free
 * copy suitable for showing straight to the user.
 */
export function parseDOB(dayRaw, monthRaw, yearRaw, now = new Date()) {
  const day = parseInt(String(dayRaw ?? '').trim(), 10);
  const month = parseInt(String(monthRaw ?? '').trim(), 10);
  const year = parseInt(String(yearRaw ?? '').trim(), 10);
  const thisYear = now.getUTCFullYear();

  if (
    !/^\d{1,2}$/.test(String(dayRaw ?? '').trim()) ||
    !/^\d{1,2}$/.test(String(monthRaw ?? '').trim()) ||
    !/^\d{1,4}$/.test(String(yearRaw ?? '').trim())
  ) {
    return { ok: false, error: 'That date of birth does not look right. Day, month and year need to be numbers, like 15, 8 and 2001.' };
  }
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > thisYear) {
    return { ok: false, error: 'That date of birth does not look right. Please enter a real date, like 15 08 2001.' };
  }
  // Real calendar date: the components must round-trip (catches Feb 30,
  // April 31, Feb 29 on non-leap years, ...).
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return { ok: false, error: 'That date does not exist on the calendar. Double check the day, month and year.' };
  }
  // Not in the future (compares at day precision).
  const todayStart = Date.UTC(thisYear, now.getUTCMonth(), now.getUTCDate());
  if (dt.getTime() > todayStart) {
    return { ok: false, error: 'That date is in the future. Please enter your real date of birth.' };
  }
  return { ok: true, dob: `${year}-${pad2(month)}-${pad2(day)}` };
}

/**
 * Exact age in whole years at `now`, from an ISO dob. Feb 29 birthdays count
 * Feb 28 in non-leap years (the common legal convention).
 */
export function ageFromDOB(dob, now = new Date()) {
  const [y, m, d] = String(dob).split('-').map(Number);
  let age = now.getUTCFullYear() - y;
  let bDay = d;
  if (m === 2 && d === 29 && !isLeapYear(now.getUTCFullYear())) bDay = 28;
  const nm = now.getUTCMonth() + 1;
  const nd = now.getUTCDate();
  if (nm < m || (nm === m && nd < bDay)) age -= 1;
  return age;
}

/** Age gate for bot use: 13 through 99, like the old age field enforced. */
export function checkDOBAge(dob, now = new Date()) {
  const age = ageFromDOB(dob, now);
  if (age < 13) {
    return { ok: false, tooYoung: true, error: 'This bot is 13 and up, matching Discord itself. Come back when you are old enough, we will be here.' };
  }
  if (age > 99) {
    return { ok: false, error: "That date of birth doesn't look right. Try again?" };
  }
  return { ok: true, age };
}

/** Live age for a profile record, or null when no dob is stored. */
export function ageOfProfile(profile, now = new Date()) {
  return profile && profile.dob ? ageFromDOB(profile.dob, now) : null;
}

/** 'minor' (13-17) or 'adult' (18+). Unknown age fails safe to minor. */
export function tierOfAge(age) {
  return age != null && age >= 18 ? 'adult' : 'minor';
}

/**
 * Calendar-accurate "at most N years apart": the younger birth date must fall
 * within N calendar years of the older one (Feb 29 clamps to Feb 28 on
 * non-leap years). ISO date strings compare lexicographically, so no Date
 * parsing is needed. This is the eligibility check for the sliding window:
 * exact, no float rounding, no 365.25 fudge at the boundary.
 */
export function withinYears(dobA, dobB, years) {
  const [older, younger] = dobA <= dobB ? [dobA, dobB] : [dobB, dobA];
  const [oy, om, od] = older.split('-').map(Number);
  let ly = oy + years, lm = om, ld = od;
  if (lm === 2 && ld === 29 && !isLeapYear(ly)) ld = 28;
  const limit = `${ly}-${pad2(lm)}-${pad2(ld)}`;
  return younger <= limit;
}

/** Exact fractional-year gap between two DOBs, for proximity scoring. */
export function gapYears(dobA, dobB) {
  const ms = Math.abs(new Date(dobA + 'T00:00:00Z') - new Date(dobB + 'T00:00:00Z'));
  return ms / 31557600000; // 365.25 days in ms
}

/** "2001-08-15" -> "15/08/2001" for user-facing display. */
export function formatDOB(dob) {
  const [y, m, d] = String(dob || '').split('-');
  return y && m && d ? `${d}/${m}/${y}` : 'Not set';
}
