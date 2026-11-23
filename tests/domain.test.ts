import test from 'node:test';
import assert from 'node:assert/strict';
import { addYears, ageGroupOf, ageOn, formatBirthDate, parseBirthDate, withinYears } from '../src/domain/age.ts';
import { acceptsCandidate, adultAgeRange, compatible, type Matchable } from '../src/domain/compatibility.ts';
import { censorProfanity, checkDisplayName, containsLink, escapeMarkdown, sanitizeLine, sanitizeMultiline, stripLinks } from '../src/domain/text.ts';
import { languageFromLocale, normalizeKeys, INTERESTS } from '../src/domain/catalog.ts';

const NOW = Date.UTC(2026, 10, 23, 12); // 23 Nov 2026
const today = new Date(NOW);

test('birthdays: accepts the formats people type', () => {
  for (const input of ['24.07.2006', '24/7/2006', '24-07-2006', '2006-07-24', '24 July 2006', 'July 24, 2006', '24th jul 2006', '07/24/2006']) {
    assert.deepEqual(parseBirthDate(input, today), { ok: true, date: '2006-07-24' }, input);
  }
});

test('birthdays: rejects nonsense, impossible and future dates', () => {
  assert.deepEqual(parseBirthDate('yesterday', today), { ok: false, reason: 'format' });
  assert.deepEqual(parseBirthDate('31.02.2006', today), { ok: false, reason: 'invalid' });
  assert.deepEqual(parseBirthDate('29.02.2007', today), { ok: false, reason: 'invalid' });
  assert.deepEqual(parseBirthDate('29.02.2008', today), { ok: true, date: '2008-02-29' });
  assert.deepEqual(parseBirthDate('01.01.2030', today), { ok: false, reason: 'future' });
  assert.deepEqual(parseBirthDate('01.01.1900', today), { ok: false, reason: 'too_old' });
});

test('age is computed live and handles leap-day birthdays', () => {
  assert.equal(ageOn('2008-11-23', NOW), 18); // birthday today
  assert.equal(ageOn('2008-11-24', NOW), 17); // tomorrow
  assert.equal(ageOn('2008-02-29', Date.UTC(2027, 1, 27)), 18);
  assert.equal(ageOn('2008-02-29', Date.UTC(2027, 1, 28)), 19); // counts on Feb 28 in common years
  assert.equal(ageGroupOf(12), 'child');
  assert.equal(ageGroupOf(13), 'teen');
  assert.equal(ageGroupOf(17), 'teen');
  assert.equal(ageGroupOf(18), 'adult');
  assert.equal(formatBirthDate('2006-07-24'), '24 July 2006');
});

test('withinYears is calendar exact', () => {
  assert.equal(withinYears('2010-05-01', '2012-05-01', 2), true);
  assert.equal(withinYears('2010-05-01', '2012-05-02', 2), false);
  assert.equal(withinYears('2012-05-02', '2010-05-01', 2), false);
  assert.equal(addYears('2008-02-29', 1), '2009-02-28');
});

const person = (userId: string, birthDate: string, extra: Partial<Matchable> = {}): Matchable => ({
  userId,
  birthDate,
  gender: 'woman',
  languages: ['en'],
  interests: ['music'],
  lookingFor: ['friends'],
  showGenders: [],
  ageMin: null,
  ageMax: null,
  sameLanguageOnly: false,
  ...extra,
});

test('the teen/adult wall can never be crossed', () => {
  const teen = person('1', '2009-01-01'); // 17
  const adult = person('2', '2008-11-01'); // 18
  assert.equal(compatible(teen, adult, NOW), false);
  assert.equal(compatible(adult, teen, NOW), false);
  // Even an adult who explicitly asks for young ages can't see teens.
  assert.equal(compatible(teen, person('3', '2008-01-01', { ageMin: 18, ageMax: 18 }), NOW), false);
});

test('teens only meet teens born at most two years apart', () => {
  const a = person('1', '2011-03-10');
  assert.equal(compatible(a, person('2', '2013-03-10'), NOW), true);
  assert.equal(compatible(a, person('3', '2013-03-11'), NOW), false);
  assert.equal(compatible(a, person('4', '2009-03-10'), NOW), true);
  assert.equal(compatible(a, person('5', '2009-03-09'), NOW), false);
  // Teen age preferences are ignored: the window can't be widened.
  assert.equal(compatible(person('6', '2011-03-10', { ageMin: 13, ageMax: 99 }), person('7', '2008-12-01'), NOW), false);
});

test('adult preferences must match both ways', () => {
  const a = person('1', '1996-01-01', { ageMin: 25, ageMax: 35 }); // 30
  const b = person('2', '2000-01-01'); // 26, default range 19-33
  assert.equal(compatible(a, b, NOW), true);
  const c = person('3', '2004-01-01'); // 22 — outside a's range
  assert.equal(compatible(a, c, NOW), false);
  const d = person('4', '1986-01-01'); // 40, default 33-47 excludes a (30)
  assert.equal(acceptsCandidate(a, d, NOW), false);
  assert.deepEqual(adultAgeRange(person('5', '2008-01-01'), NOW), { min: 18, max: 25 });
});

test('gender and language filters', () => {
  const a = person('1', '1996-01-01', { showGenders: ['man'] });
  assert.equal(compatible(a, person('2', '1996-01-01', { gender: 'woman' }), NOW), false);
  assert.equal(compatible(a, person('3', '1996-01-01', { gender: 'man' }), NOW), true);
  assert.equal(compatible(a, person('4', '1996-01-01', { gender: 'unspecified' }), NOW), false);
  const b = person('5', '1996-01-01', { sameLanguageOnly: true, languages: ['bn'] });
  assert.equal(compatible(b, person('6', '1996-01-01', { languages: ['en'] }), NOW), false);
  assert.equal(compatible(b, person('7', '1996-01-01', { languages: ['en', 'bn'] }), NOW), true);
  assert.equal(compatible(a, a, NOW), false);
});

test('text hygiene', () => {
  assert.equal(sanitizeLine('  hi​ there\n\tfriend  ', 50), 'hi there friend');
  assert.equal(sanitizeLine('a'.repeat(40), 32).length, 32);
  assert.equal(sanitizeMultiline('line 1\n\n\n\nline 2\n\n', 100), 'line 1\n\nline 2');
  assert.equal(escapeMarkdown('**bold** <@123> [x](y)'), '\\*\\*bold\\*\\* \\<\\@123\\> \\[x\\]\\(y\\)');
  assert.equal(containsLink('add me discord.gg/abc'), true);
  assert.equal(containsLink('see https://example.org'), true);
  assert.equal(containsLink('I like node and music'), false);
  assert.deepEqual(stripLinks('go to www.example.com now'), { text: 'go to [link removed] now', removed: 1 });
  assert.equal(censorProfanity('what the fuck').censored, true);
  assert.equal(censorProfanity('class assignment in Scunthorpe').censored, false);
  assert.equal(checkDisplayName('Alex'), null);
  assert.equal(checkDisplayName('a'), 'too_short');
  assert.equal(checkDisplayName('@everyone'), 'mention');
  assert.equal(checkDisplayName('1234'), 'no_letters');
});

test('catalog helpers', () => {
  assert.equal(languageFromLocale('pt-BR'), 'pt');
  assert.equal(languageFromLocale('sv-SE'), null);
  assert.deepEqual(normalizeKeys(INTERESTS, ['music', 'nope', 'gaming', 'music']), ['gaming', 'music']);
});
