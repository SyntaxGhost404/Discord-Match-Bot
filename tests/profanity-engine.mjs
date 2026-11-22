// Verification suite for the tiered profanity filter
// (src/services/profanity.js over src/services/profanity-engine.js).
// Run: node tests/profanity-engine.mjs   (also via: npm test)
// Compares against src/services/profanity.legacy.js (byte-identical copy of
// the old filter, kept read-only as the behavioral benchmark) and against
// the LIVE bot's tiered filter for exact parity. Exits non-zero on failure.
//
// filterText(input, { adultChat }) defaults to a MINOR chat (fail-safe).
// Minor chats flag the full 719-word list; adult chats flag the 603 hard
// words plus 16 mixed sensitive entries with a genuine hard component.

import * as cur from '../src/services/profanity.js';
import * as leg from '../src/services/profanity.legacy.js';
import { SENSITIVE_SOFT } from '../src/services/wordlist.js';
import { MILD_SOFT } from '../src/services/profanity-tiers.js';

let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : (fail++, console.log('FAIL:', name)); };
const { filterText, maskSpan, maskCompoundSpan, MASK } = cur;
const minor = (s) => filterText(s);                 // default: minor chat
const adult = (s) => filterText(s, { adultChat: true });

// ---------------------------------------------------------------------------
// A. Pinned masking shapes: minor chats (contract with chat.js / strikes)
// ---------------------------------------------------------------------------

ok(MASK === '∗', 'MASK is U+2217, never markdown *');
for (const w of ['assfuck', 'fuckass', 'shitfucker', '5hitfuck3r', 'a.s.s.f.u.c.k', 'shitskin', 'fuckshit', 'fuckingshitmotherfucker']) {
  const r = minor(w);
  ok(r.flagged && r.hits === 1, `minor: ${w} flags with exactly one hit`);
}
// Tiering changed the shapes vs legacy: the sensitive component is now
// masked component-wise instead of left readable.
ok(minor('assfuck').text === 'a∗sf∗∗k', 'minor: assfuck -> a∗sf∗∗k');
ok(minor('fuckass').text === 'f∗∗ka∗s', 'minor: fuckass -> f∗∗ka∗s');
ok(minor('shitfucker').text === 's∗∗tfu∗∗er', 'minor: shitfucker -> s∗∗tfu∗∗er');
ok(minor('5hitfuck3r').text === '5∗∗tfu∗∗3r', 'minor: 5hitfuck3r -> 5∗∗tfu∗∗3r');
ok(minor('a.s.s.f.u.c.k').text === 'a.∗.s.f.∗.∗.k', 'minor: a.s.s.f.u.c.k -> a.∗.s.f.∗.∗.k');
ok(minor('shitskin').text === 's∗∗tskin', 'minor: shitskin -> s∗∗tskin');
ok(minor('fuckshit').text === 'f∗∗ks∗∗t', 'minor: fuckshit -> f∗∗ks∗∗t');
ok(minor('fuckingshitmotherfucker').text === 'fu∗∗∗ngs∗∗tmo∗∗∗∗∗∗∗∗er',
  'minor: fuckingshitmotherfucker -> fu∗∗∗ngs∗∗tmo∗∗∗∗∗∗∗∗er');
ok(!adult('fuckshit').flagged && adult('fuckshit').text === 'fuckshit',
  'adult: fuckshit passes clean (not mixed)');
ok(!adult('fuckingshitmotherfucker').flagged,
  'adult: fuckingshitmotherfucker passes clean (not mixed)');
{
  const r = minor('fuck your ass');
  ok(r.flagged && r.hits === 2, 'minor: fuck your ass: one strike, hits counts hard+soft spans');
  ok(r.text === 'f∗∗k your a∗s', 'minor: fuck your ass -> f∗∗k your a∗s');
}
{
  const r = minor('fuck your @ss');
  ok(r.flagged && r.text === 'f∗∗k your @∗s', 'minor: leet soft word upgrades too');
}
ok(minor('fuck this shit').text === 'f∗∗k this s∗∗t', 'minor: fuck this shit -> f∗∗k this s∗∗t');
ok(minor('fuck this crap').text === 'f∗∗k this c∗∗p', 'minor: mild word masked when flaggable');

// ---------------------------------------------------------------------------
// A2. Pinned masking shapes: adult chats
// ---------------------------------------------------------------------------

// Pure sensitive compounds pass untouched in adult chats.
for (const w of ['assfuck', 'shitfucker', 'shitfuck']) {
  const r = adult(w);
  ok(!r.flagged && r.text === w, `adult: ${w} passes clean`);
}
// 'shitskin' moved to the hard tier on 2026-09-21: flagged in both tiers.
ok(adult('shitskin').text === 's∗∗tskin', 'adult: shitskin -> s∗∗tskin (hard tier now)');
// Mixed entries (genuine hard component) still flag; only the hard
// component is masked.
ok(adult('pussyfart').text === 'pu∗syf∗∗t', 'adult: pussyfart -> pu∗syf∗∗t');
ok(adult('fuckbitch').text === 'fuckbi∗ch', 'adult: fuckbitch -> fuckbi∗ch');
ok(adult('titfuck').text === 't∗tfuck', 'adult: titfuck -> t∗tfuck');
ok(adult('fannyfucker').text === 'fa∗nyfucker', 'adult: fannyfucker -> fa∗nyfucker');
ok(adult('shitdick').text === 'shitd∗∗k', 'adult: shitdick -> shitd∗∗k');
{
  const r = adult('bitch hell');
  ok(r.flagged && r.hits === 2 && r.text === 'bi∗ch h∗∗l', 'adult: bitch hell -> bi∗ch h∗∗l');
}
ok(!adult('fuck hell').flagged, 'adult: fuck hell passes (sensitive + mild only)');
ok(!adult('ass').flagged && !adult('shit').flagged, 'adult: ass/shit pass in isolation');

// ---------------------------------------------------------------------------
// B. Soft-word tiers: mild (31) vs sensitive-soft (5)
// ---------------------------------------------------------------------------

ok(MILD_SOFT.length === 31, '31 mild words in the contract list');
ok(SENSITIVE_SOFT.length === 5, '5 sensitive-soft words in the contract list');

// B1. Mild words pass untouched in isolation in BOTH chat types.
for (const w of MILD_SOFT) {
  for (const [tier, r] of [['minor', minor(w)], ['adult', adult(w)]]) {
    ok(!r.flagged && r.text === w && r.hits === 0, `${tier}: mild word passes in isolation: ${w}`);
  }
}
ok(!minor('what the hell').flagged && !adult('what the hell').flagged, 'what the hell passes in both tiers');
ok(!minor('you bastard').flagged && !adult('you bastard').flagged, 'you bastard passes in both tiers');

// B2. Sensitive-soft words flag standalone in minor chats, pass in adult.
for (const w of SENSITIVE_SOFT) {
  const m = minor(w);
  const a = adult(w);
  ok(m.flagged && m.hits === 1, `minor: sensitive-soft word flags: ${w}`);
  ok(!a.flagged && a.text === w, `adult: sensitive-soft word passes: ${w}`);
}
ok(minor('@ss').flagged && minor('@ss').text === '@∗s', 'minor: @ss flags -> @∗s');
ok(!minor('5h1t').flagged && minor('5h1t').text === '5h1t', 'minor: 5h1t passes (mild now)');
ok(!adult('@ss').flagged && !adult('5h1t').flagged, 'adult: @ss / 5h1t pass');
{
  const r = minor('@ss and 5h1t');
  ok(r.flagged && r.text === '@∗s and 5∗∗t', 'minor: @ss flags, mild 5h1t upgrades beside it');
  ok(!adult('@ss and 5h1t').flagged, 'adult: @ss and 5h1t passes');
}

// B3. Shit-family reclassification (2026-09-21): standalone shit-family
// words are mild in both chat types, incl. leet folds; they still upgrade
// beside flaggable profanity.
for (const word of ['shit', 'shits', 'shitty', 'shite', 'shart', '5h1t', 'sh1t', 's_h_i_t']) {
  const m = minor(word), a = adult(word);
  ok(!m.flagged && m.text === word, `minor: mild shit-family word passes alone (${word})`);
  ok(!a.flagged && a.text === word, `adult: mild shit-family word passes alone (${word})`);
}
{
  const m = minor('shit bitch'), a = adult('shit bitch');
  ok(m.flagged && m.text === 's∗∗t bi∗ch', 'minor: mild shit upgrades beside a hard word');
  ok(a.flagged && a.text === 's∗∗t bi∗ch', 'adult: mild shit upgrades beside a hard word');
}

// ---------------------------------------------------------------------------
// C. Evasions the port must catch (legacy-missed or legacy-caught)
// ---------------------------------------------------------------------------

for (const w of ['f*ck', 'f**k', 'f.u.c.k', 'fuuuck', 'b00b', 'oofuko', 'a.s.s.f.u.c.k', '5hitfuck3r']) {
  ok(minor(w).flagged, `minor: evasion flagged: ${w}`);
}
ok(minor('f*ck').text === 'f∗∗k', 'minor: f*ck masks to f∗∗k');
ok(minor('f.u.c.k').text === 'f.∗∗∗.k', 'minor: f.u.c.k masks inner span, separators kept at edges');
ok(minor('motherfucker').flagged, 'minor: plain hard word flags');
ok(minor('FUCK').text === 'F∗∗K', 'minor: casing preserved under mask');
// Adult evasions: hard evasions still flag; sensitive-tier evasions
// (f*ck/F*ck/f.u.c.k/a.s.s) pass untouched, matching live (F1 fix).
// ('motherfucker' is a sensitive word: clean in adult chats in both.)
ok(adult('dickhead').flagged, 'adult: dickhead flags');
ok(!adult('f*ck').flagged && !adult('F*ck').flagged, 'adult: f*ck / F*ck pass (sensitive evasion)');
ok(!adult('f.u.c.k').flagged, 'adult: f.u.c.k passes (sensitive evasion)');
ok(!adult('a.s.s').flagged, 'adult: a.s.s passes (sensitive evasion)');

// ---------------------------------------------------------------------------
// D. Innocents: whitelist, dotted words, ordinary sentences
// ---------------------------------------------------------------------------

for (const w of ['c.l.a.s.s', 'classic', 'shitake mushrooms', 'cucumber', 'hello world', 'I love my class']) {
  ok(!minor(w).flagged && !adult(w).flagged, `innocent passes in both tiers: ${w}`);
}
ok(!minor('a gay friend').flagged, 'a gay friend passes');
ok(!minor('this sucks and screw you').flagged, 'sucks/screw pass');
ok(!minor('c.l.a.s.s dismissed').flagged, 'c.l.a.s.s dismissed passes');
ok(!minor('that bullshit though').flagged && !adult('that bullshit though').flagged, 'that bullshit though passes in both tiers');

// ---------------------------------------------------------------------------
// E. Edge cases
// ---------------------------------------------------------------------------

{
  const r = minor('');
  ok(!r.flagged && r.text === '' && r.hits === 0, "filterText('') -> empty, clean, 0 hits");
}
ok(!minor(null).flagged && !minor(undefined).flagged, 'null/undefined coerce to empty');
ok(!minor('   ').flagged, 'whitespace-only is clean');
ok(maskSpan('fuck') === 'f∗∗k', 'maskSpan helper');
// maskCompoundSpan is tier-aware: sensitive components mask only in minor.
ok(maskCompoundSpan('assfuck', { adultChat: false }) === 'a∗sf∗∗k', 'maskCompoundSpan minor: assfuck -> a∗sf∗∗k');
ok(maskCompoundSpan('assfuck', { adultChat: true }) === 'as∗∗∗ck', 'maskCompoundSpan adult: assfuck -> as∗∗∗ck');
ok(maskCompoundSpan('fuckbitch', { adultChat: true }) === 'fuckbi∗ch', 'maskCompoundSpan adult: fuckbitch -> fuckbi∗ch');
ok(maskCompoundSpan('pussyfart', { adultChat: false }) === 'pu∗syf∗∗t', 'maskCompoundSpan minor: pussyfart -> pu∗syf∗∗t');
{
  const r = minor('fuck fuck fuck');
  ok(r.flagged && r.hits === 3, 'hits counts every masked span');
}

// ---------------------------------------------------------------------------
// F. NEW-vs-LEGACY differential @ adultChat:false: every diff is an
//    enumerated intended tiering delta, nothing else.
// ---------------------------------------------------------------------------

const CORPUS = [
  // ordinary chat sentences (must stay clean)
  'hey how are you', 'what is up my dude', 'lol that was funny', 'brb getting food',
  'omg no way really', 'idk man sounds rough', 'tbh i agree with you', 'smh my head',
  'fyi the meeting moved', 'btw did you see that', 'gg well played', 'glhf everyone',
  'nvm figured it out', 'imo its fine', 'dm me later', 'that is so sus bro',
  'no cap fr fr', 'bet see you there', 'ong that is crazy', 'bruh moment fr',
  'whats good fam', 'she is my best friend', 'we went to the movies', 'the game was insane',
  'i love this song', 'playing games all night', 'kissed the homie goodnight',
  'the ducks are cute', 'all the clocks stopped', 'tots are the best snack',
  'the titles are wrong', 'gave it to charity', 'i dislike broccoli', 'case dismissed',
  'sounded like fun', 'scoops of ice cream', 'this sucks honestly', 'screw this homework',
  'a gay friend of mine', 'lmao that killed me', 'wth just happened',
  'penistone is a town', 'classic scunthorpe problem', 'i love my class',
  'cucumber and shitake mushrooms', 'hello world program', 'what the hell man',
  'shit happens sometimes', 'this is crap quality', 'you bastard lol', 'fart jokes rule',
  'my butt hurts', 'damn that is hot', 'holy hell dude', 'piss poor wifi',
  // whitelist words
  'class', 'classes', 'classic', 'classroom', 'pass', 'passes', 'passed', 'passing',
  'password', 'grass', 'grassy', 'glass', 'glasses', 'mass', 'massive',
  'assign', 'assigned', 'assignment', 'assist', 'assistant', 'assemble', 'assembly',
  'asset', 'assets', 'associate', 'association', 'assume', 'assumed', 'assure',
  'compass', 'embarrass', 'embarrassed', 'embarrassing', 'harass', 'harassed',
  'harassment', 'amass', 'bass', 'canvas', 'canvases', 'molasses', 'cutlass',
  'arsenal', 'parse', 'parcel', 'hello', 'shell', 'smell', 'spell', 'spells',
  'swell', 'dwell', 'scrap', 'scraps', 'scrappy', 'cucumber', 'document',
  'documentary', 'accumulate', 'shiitake', 'shitake', 'title', 'titles',
  'titan', 'titanic', 'cocktail', 'peacock', 'cockpit', 'dickens', 'booby',
  // dotted / separated innocents
  'c.l.a.s.s', 'p.a.s.s', 'h.e.l.l.o', 's.h.e.l.l',
  // soft words in isolation (subset; full lists covered in B)
  'shit', 'crap', 'ass', 'damn', 'hell', 'butt', 'fart', 'piss', 'poop', 'douche',
  '@ss', '5h1t', 'sh!t', 'a$$',
  // standard hard profanity (both must flag)
  'fuck', 'shitfucker', 'motherfucker', 'assfuck', 'fuckass', 'bitch',
  'dick', 'pussy', 'cunt', 'whore', 'slut', 'bastard fuck', 'fucking idiot',
  'you are a fuck', 'shut the fuck up', 'what the fuck',
  // punctuation / casing edge cases
  'FUCK', 'FuCk', 'fuck!', '(fuck)', '"fuck"', 'fuck?', '...fuck...',
  'well, fuck me', 'fuck, fuck, fuck',
  // clean lookalikes
  'duck', 'luck', 'suck', 'truck', 'stuck', 'cluck',
  'passion', 'compassion', 'classy', 'glassy',
  'arsenal fan', 'parse the json', 'shell script', 'spelling bee',
  // more ordinary chat (verdict parity)
  'good morning everyone', 'anyone up for valorant', 'that stream was awesome',
  'my dog is sleeping', 'homework is killing me', 'weekend plans anyone',
  'the wifi is trash today', 'i am so tired lol', 'birthday party tonight',
  'new phone who dis', 'that movie sucked bad', 'screw it lets go',
  'dismissed the notification', 'gay straight alliance club', 'lmao stoppp',
  'wth was that noise', 'ong we won', 'fam dinner tonight', 'hey homie',
  'bestie you good', 'got no rizz', 'do not simp for her', 'ok boomer lol',
  'omw be there soon', 'major fomo right now', 'gyat damn son',
  'kissed by a rose', 'games night friday', 'gave blood today',
  'sounded great tbh', 'titles got messed up', 'scoops for dessert',
  'ducks in a row', 'clocks go forward', 'tots and fries',
  'c.l.a.s.s president', 'p.a.s.s the aux', 's.h.e.l.l yeah',
  'sh!t happens', 'a$$ whooping', '@ss kicking contest',
  'motherfucking right', 'bitch please lol', 'dumb slut era',
  'horny on main', 'thirsty texting', 'nsfw warning here',
];
ok(CORPUS.length >= 200, `differential corpus has ${CORPUS.length} inputs (>= 200)`);

// The full enumerated set of intended tiering deltas vs legacy @ minor.
// Bucket 1 (verdict): sensitive-soft words flag standalone in minor chats.
// Bucket 2 (mask text): sensitive components of compounds are masked in
// minor chats instead of left readable.
// (2026-09-21: the shit-family left SENSITIVE_SOFT for the mild tier, so
// 'shit', '5h1t', 'sh!t' and their sentences no longer differ from legacy.)
const EXPECTED_LEGACY_DIFFS = new Set([
  // bucket 1: sensitive-soft standalone now flags
  'my butt hurts', 'ass', 'butt',
  '@ss', 'a$$', 'a$$ whooping', '@ss kicking contest',
  // bucket 2: sensitive components now masked in compounds
  'shitfucker', 'assfuck', 'fuckass',
]);
const TEXT_DIFFS = new Set(['shitfucker', 'assfuck', 'fuckass']); // both flag, mask differs

{
  const actual = new Set();
  for (const input of CORPUS) {
    const a = minor(input);
    const b = leg.filterText(input);
    if (a.flagged !== b.flagged || (a.flagged && a.text !== b.text)) actual.add(input);
  }
  const missing = [...EXPECTED_LEGACY_DIFFS].filter((x) => !actual.has(x));
  const extra = [...actual].filter((x) => !EXPECTED_LEGACY_DIFFS.has(x));
  ok(missing.length === 0, `no expected tiering delta missing: ${JSON.stringify(missing)}`);
  ok(extra.length === 0, `no unexpected legacy diff: ${JSON.stringify(extra)}`);
  for (const input of TEXT_DIFFS) {
    const a = minor(input), b = leg.filterText(input);
    ok(a.flagged && b.flagged && a.text !== b.text, `text-only delta, both flag: ${input}`);
  }
  for (const input of [...EXPECTED_LEGACY_DIFFS].filter((x) => !TEXT_DIFFS.has(x))) {
    const a = minor(input), b = leg.filterText(input);
    ok(a.flagged && !b.flagged, `verdict delta (new flags, legacy clean): ${input}`);
  }
  console.log(`legacy differential: ${CORPUS.length} inputs, diffs: ${actual.size} (all enumerated tiering deltas)`);
}

// ---------------------------------------------------------------------------
// F2. NEW-vs-LIVE differential across BOTH tiers: parity except the engine's
// documented fuzzy/substring improvements (caught evasions live misses).
// ---------------------------------------------------------------------------

{
  const F2_CORPUS = CORPUS.concat(['F*ck', 'f*ck', 'f**k', 'oofuko', 'abcfuck', 'fuckyou', 'dicks']);
  // Every expected engine-vs-live diff: the engine flags, live passes.
  const EXPECTED_LIVE_DIFFS = new Set([
    'minor:f*ck', 'minor:f**k', 'minor:F*ck', 'minor:oofuko',
    'minor:abcfuck', 'minor:fuckyou', 'minor:dicks',
    'adult:dicks',
  ]);
  const actual = new Set();
  let liveModule;
  try {
    liveModule = await import('../../anon-chat-remake/src/services/profanity.js');
  } catch {
    liveModule = null;
  }
  if (!liveModule) {
    ok(false, 'live bot profanity module unreachable for F2 differential');
  } else {
    for (const tier of ['minor', 'adult']) {
      const liveFilter = (s) => liveModule.filterText(s, { adultChat: tier === 'adult' });
      const newFilter = tier === 'adult' ? adult : minor;
      for (const input of F2_CORPUS) {
        const a = newFilter(input);
        const b = liveFilter(input);
        if (a.flagged !== b.flagged || (a.flagged && a.text !== b.text)) {
          actual.add(`${tier}:${input}`);
          if (!EXPECTED_LIVE_DIFFS.has(`${tier}:${input}`)) {
            console.log('unexpected live diff:', tier, JSON.stringify(input),
              'new:', a.flagged, JSON.stringify(a.text), '| live:', b.flagged, JSON.stringify(b.text));
          }
        }
      }
    }
    const missing = [...EXPECTED_LIVE_DIFFS].filter((x) => !actual.has(x));
    const extra = [...actual].filter((x) => !EXPECTED_LIVE_DIFFS.has(x));
    ok(missing.length === 0, `no expected improvement missing: ${JSON.stringify(missing)}`);
    ok(extra.length === 0, `no unexpected live diff: ${JSON.stringify(extra)}`);
    console.log(`live differential: ${F2_CORPUS.length} inputs x 2 tiers, diffs: ${actual.size} (all documented improvements)`);
  }
}

// ---------------------------------------------------------------------------
// G. Documented intentional deltas (new filter catches evasions legacy missed)
// ---------------------------------------------------------------------------

const INTENTIONAL = [
  ['f*ck', true], ['f**k', true], ['oofuko', true], ['dicks', true],
];
// ('b00b' and 'f.u.c.k' are flagged by BOTH filters; legacy already caught
// those evasions, so they live in section C, not here.)
for (const [input, expected] of INTENTIONAL) {
  const a = minor(input).flagged;
  const b = leg.filterText(input).flagged;
  ok(a === expected && b === false, `intentional delta (new flags, legacy missed): ${input}`);
}

// ---------------------------------------------------------------------------
// H. Regression: proper-noun guard (2026-09-21 FP regression)
// ---------------------------------------------------------------------------
// Substring-only solid hits ("cum" in "Cumana", "tit" in "Titz", "cock" in
// "Cockburn", "fag" in "Fagatogo", "fuk" in "Fukushima") must not flag when
// the span starts with an uppercase letter. These 16 were NEW-only false
// positives before the guard landed in scanHard.
// ---------------------------------------------------------------------------

for (const w of [
  'Isle of Cumbrae', 'Fagatogo', 'Cockburn', 'Fukushima', 'Titz', 'Cumby',
  'Cummins', 'Titchfield', 'Cocke County', 'Cumana', 'Cockermouth',
  'Glasscock County', 'Titisee', 'Tittabawassee River', 'Fagasa', 'Fagalii',
]) {
  ok(!minor(w).flagged, `proper noun stays clean: ${w}`);
}
// Extra risky proper nouns.
for (const w of ['Scunthorpe', 'Penistone', 'Middlesex', 'Cockfosters']) {
  ok(!minor(w).flagged, `proper noun stays clean: ${w}`);
}
// The guard never applies to exact/lemma hits: exact slurs flag in any
// casing, matching OLD. ("Cumming" is an exact hard word, so it flags in
// both — parity, not a regression.)
for (const w of ['Cock', 'DICK', 'Cumming', 'Dick Van Dyke', 'Moby Dick']) {
  const a = minor(w).flagged;
  const b = leg.filterText(w).flagged;
  ok(a && b, `exact slur still flags in both: ${w}`);
}
// "Fucking, Austria": "fucking" is an exact hard word, so it flags in BOTH
// (parity with legacy). The proper-noun guard only gates substring-only
// hits, never exact ones — a capitalized exact slur is still a slur.
{
  const a = minor('Fucking, Austria');
  const b = leg.filterText('Fucking, Austria');
  ok(a.flagged && b.flagged, 'Fucking, Austria flags in both (exact-word parity)');
}
ok(minor('fucking').flagged, 'bare fucking still flags');
// Lowercase substring compounds keep flagging (NEW improvements over OLD).
for (const w of ['abcfuck', 'fuckyou']) {
  ok(minor(w).flagged, `lowercase substring compound flags: ${w}`);
}
// Evasion-shaped spans always flag regardless of case.
ok(minor('F*ck').flagged, 'F*ck flags (evasion shape, capitalized)');

// ---------------------------------------------------------------------------
// I. Regression: `$`->`s` span joining + doubled-letter variants (2026-09-21
// adversarial-benchmark NEW-only misses)
// ---------------------------------------------------------------------------
// The FOLD map always had `$`->`s`; the miss was strict-mode span building
// splitting `$` off the span ("$lut" -> span "lut"). Fixed in buildSpans.
for (const w of ['$lut', '$$lut', 'pu$$y', 'PU$$Y']) {
  ok(minor(w).flagged, `minor: $ evasion flags: ${w}`);
}
ok(minor('pu$$y').text === 'pu∗$y', 'minor: pu$$y masks to pu∗$y');
ok(minor('PU$$Y').text === 'PU∗$Y', 'minor: PU$$Y masks to PU∗$Y');
ok(!minor('ca$h').flagged, 'ca$h stays clean (ordinary word)');
ok(!adult('ca$h').flagged, 'adult: ca$h stays clean (ordinary word)');
// Doubled-letter evasions: OLD's {1,3} letter classes caught these; NEW
// missed them until the variant-expansion branch landed in scanHard.
for (const w of ['fucck', 'fuuk', 'whorre', 'cuunt', 'faag']) {
  ok(minor(w).flagged, `minor: doubled-letter evasion flags: ${w}`);
}
ok(minor('fucck').text === 'fu∗ck', 'minor: fucck masks to fu∗ck');
ok(minor('whorre').text === 'wh∗∗re', 'minor: whorre masks to wh∗∗re');
// Innocent doubled-letter words stay clean (ordinary-word guard runs first).
for (const w of ['letter', 'hello', 'bookkeeper', 'committee']) {
  ok(!minor(w).flagged, `innocent doubled-letter word stays clean: ${w}`);
}


// ---------------------------------------------------------------------------
// EV3. Evasion-class regressions, cycle-2 patch (C1-C10 + bughunt fixes A-F).
// Merged from regression-sections/patch-evasion3-section.mjs (54 tests); uses
// the suite's `ok` helper; dynamic import only (no new static imports).
// ---------------------------------------------------------------------------
{
  // ---------------------------------------------------------------------------
  // X. Evasion-class regressions (cycle-2 patch: C1–C10 + bughunt fixes A–F).
  // Append to tests/profanity-engine.mjs. Uses the suite's `ok` helper;
  // dynamic import only (no new static imports). Relative path assumes the
  // tests/ location.
  // ---------------------------------------------------------------------------
  {
    const { filterText: ft3 } = await import('../src/services/profanity.js');
    const mn3 = (s) => ft3(s);
    const ad3 = (s) => ft3(s, { adultChat: true });

    // C1: NFKD normalization (accents / fullwidth fold before detection).
    for (const w of ['bîtch', 'cünt', 'dïck', 'whöre', 'ｆｕｃｋ']) {
      ok(mn3(w).flagged, `C1: minor ${w} flags`);
    }

    // C2: fuzzy verdicts trusted only on evasion-shaped spans.
    ok(mn3('fυck').flagged, 'C2: minor fυck (homoglyph) flags');
    ok(mn3('fıck').flagged, 'C2: minor fıck (dotless i, fuzzy-caught) flags');
    ok(!mn3('stoppp').flagged, 'C2: minor stoppp stays clean (no bleed)');
    ok(!mn3('sh!t happens').flagged, 'C2: minor "sh!t happens" stays clean');

    // C3–C5: exotic whitespace / line-separator glue.
    for (const w of ['f uck', 'f uck', 'f　uck', 'f uck', 'f uck', 'f uck']) {
      ok(mn3(w).flagged, `C3/C4/C5: minor ${JSON.stringify(w)} flags`);
    }

    // C6: space-split evasion (exact-only pre-pass); real word pairs untouched.
    ok(mn3('f u c k').flagged, 'C6: minor "f u c k" flags');
    ok(mn3('bi tch').flagged, 'C6: minor "bi tch" flags');
    ok(mn3('fuck your ass').hits === 2, 'C6: minor "fuck your ass" still 2 hits');
    ok(mn3('fuck your ass').text === 'f∗∗k your a∗s', 'C6: "fuck your ass" shape pinned');
    ok(mn3('fuck me').text === 'f∗∗k me', 'C6: "fuck me" not fused');

    // C7: BMP pictograph glue.
    for (const w of ['f✈uck', 'f♥uck', 'f☠uck', 'f★uck']) {
      ok(mn3(w).flagged, `C7: minor ${w} flags`);
    }

    // C8: bidi override (renders as the slur).
    ok(mn3('‮kcuf').flagged, 'C8: minor RLO+kcuf flags');

    // C9: repeat collapse + leading/trailing fuzzy windows + proper-noun gate.
    ok(mn3('a'.repeat(20) + 'fuck').flagged, 'C9: minor a*20+fuck flags');
    ok(mn3('a'.repeat(12) + 'fuck').flagged, 'C9: minor a*12+fuck flags');
    ok(mn3('loremipsumd*ck').flagged, 'C9: minor loremipsumd*ck flags (trailing window)');
    ok(!mn3('A'.repeat(12) + 'fuck').flagged, 'C9: minor A*12+fuck stays clean (proper-noun gate)');

    // C10: astral emoji glue (incl. mixed with BMP separators).
    ok(mn3('f😀uck').flagged, 'C10: minor f😀uck flags');
    ok(mn3('f․u😀c․k').flagged, 'C10: minor f․u😀c․k flags');
    ok(mn3('f😀*ck').flagged, 'C10: minor f😀*ck flags');
    ok(mn3('f😀ck').flagged, 'C10: minor f😀ck flags');
    ok(!ad3('f😀ck').flagged, 'C10: adult f😀ck passes (sensitive tier)');

    // Fix A: hard word past the fuzzy cap (substring evidence, gated).
    ok(mn3('x'.repeat(20) + 'fuck').flagged, 'A: minor x*20+fuck still flags');
    ok(!mn3('a'.repeat(12) + 'shit').flagged, 'A: minor a*12+shit stays clean (shit not hard)');

    // Fix B: v->u / bracket->c variants through repeat collapse (exact only).
    ok(mn3('fvvvck').flagged, 'B: minor fvvvck flags');
    ok(mn3('fvvvck').text === 'fv∗∗ck', 'B: minor fvvvck shape pinned');
    ok(!mn3('fck').flagged, 'B: minor fck stays clean (evasion gate parity)');

    // Fix C: pictograph evasion signal on any plane.
    ok(mn3('f✈ck').flagged, 'C-fix: minor f✈ck flags (BMP picto evasion)');

    // Fix D: all four bracket leets reattach as 'c'.
    for (const w of ['[ock', '<ock', '{ock', '(ock']) {
      ok(mn3(w).flagged, `D: minor ${w} flags`);
    }
    ok(mn3('[ock').text === '[o∗k', 'D: minor [ock shape pinned');

    // Fix E: compound segmentation on the picto-stripped copy.
    ok(mn3('a😀ssbitch').text === 'a😀∗sbi∗ch', 'E: minor a😀ssbitch shape pinned');

    // Fix F: adult mixed-entry evasions mask only the hard component.
    ok(ad3('f*ckbitch').text === 'f*ckbi∗ch', 'F: adult f*ckbitch shape pinned');
    ok(ad3('sh*tdick').text === 'sh*td∗∗k', 'F: adult sh*tdick shape pinned');
    ok(mn3('f*ckbitch').flagged, 'F: minor f*ckbitch still flags');

    // Confusable folds (A3/A7) + fullwidth separator (B10) boundaries.
    ok(mn3('аss').flagged, 'fold: minor аss (Cyrillic a) flags');
    ok(mn3('ɑss').flagged, 'fold: minor ɑss (Latin alpha) flags');
    ok(mn3('f！u！c！k').flagged, 'fold: minor f！u！c！k (fullwidth !) flags');
    ok(mn3('b!tch').flagged, 'fold: minor b!tch (ASCII !) still flags');
    ok(!mn3('f!u!c!k').flagged, 'fold: minor f!u!c!k (ASCII) behavior unchanged');
  }
}




// ---------------------------------------------------------------------------
// C3E. Engine regressions, cycle-3 patch (M1-M6, BUG1-3, LOAD-1).
// Merged from regression-sections/patch-engine3-section.mjs (30 tests); uses
// the suite's `ok` helper; dynamic import only (no new static imports).
// ---------------------------------------------------------------------------
{
  const { scanHard, sweepEngineCaches } = await import('../src/services/profanity-engine.js');
  const { maskSpan } = await import('../src/services/profanity.js');
  const flags = (text, adult) =>
    scanHard(text, { adultChat: adult }).map((h) => h.text);
  const masked = (text, adult) => {
    const hits = scanHard(text, { adultChat: adult });
    let out = text;
    for (const h of [...hits].sort((a, b) => b.start - a.start)) {
      out = out.slice(0, h.start) + maskSpan(h.text) + out.slice(h.end);
    }
    return out;
  };

  // M1: homoglyph spans must not be laundered by the ordinary-word guard.
  ok(flags('вitch', false).length === 1, '[c3-engine] M1: вitch (VE) flags minor');
  ok(flags('тits', false).length === 1, '[c3-engine] M1: тits (TE) flags minor');
  ok(flags('aςs', false).length === 1, '[c3-engine] M1: aςs (final sigma) flags minor');
  ok(flags('aϲs', false).length === 1, '[c3-engine] M1: aϲs (lunate sigma) flags minor via ambiguous variant');
  ok(flags('ϲսnt', false).length === 1, '[c3-engine] M1/M5: ϲսnt still folds lunate->c (cunt)');

  // M2: mixed ASCII-space + invisible gaps merge ("f u c k" shapes).
  ok(flags('f \u200bu\u200bc\u200bk', false).length === 1, '[c3-engine] M2: f + space + ZWSP-gap f-u-c-k flags minor');
  ok(flags('f \u200bu \u200bc \u200bk', false).length === 1, '[c3-engine] M2: mixed space/ZWSP gaps merge');
  ok(masked('f u c k', false) === 'f ∗∗∗ k', '[c3-engine] M2: merged span masks across spaces');

  // M3: enclosed alphanumerics.
  ok(flags('ⓕⓤⓒⓚ', false).length === 1, '[c3-engine] M3: ⓕⓤⓒⓚ flags minor');
  ok(masked('ⓕⓤⓒⓚ', false) === 'ⓕ∗∗ⓚ', '[c3-engine] M3: masking covers the original chars');

  // M4: regional indicators.
  ok(flags('\u{1F1EB}\u{1F1FA}\u{1F1E8}\u{1F1F0}', false).length === 1, '[c3-engine] M4: 🇫🇺🇨🇰 flags minor');
  ok(flags('\u{1F1EB}\u{1F1F7}', false).length === 0, '[c3-engine] M4: 🇫🇷 (fr) stays clean');

  // M5: homoglyph twins.
  ok(flags('вiтch', false).length === 1, '[c3-engine] M5: вiтch (VE+TE) flags minor');
  ok(flags('ѕlսt', false).length === 1, '[c3-engine] M5: ѕlսt (DZE+SEH) flags minor');
  ok(flags('ϲսnt', false).length === 1, '[c3-engine] M5: ϲսnt (lunate+SEH) flags minor');
  ok(flags('аss', false).length === 1, '[c3-engine] M5: аss (Cyrillic a) flags minor');

  // M6: non-ASCII leading capitals get no proper-noun exemption.
  ok(flags('ААААfuck', false).length === 1, '[c3-engine] M6: Cyrillic-caps + fuck flags minor');

  // BUG1: picto-only evasion-shaped spans corroborated, not auto-trusted.
  ok(flags('happy😊birthday', false).length === 0, '[c3-engine] BUG1: happy😊birthday clean in minor');
  ok(flags('f😀ck', false).length === 1, '[c3-engine] BUG1: f😀ck flags minor (nearDictWord)');
  ok(flags('f😀ck', true).length === 0, '[c3-engine] BUG1: f😀ck passes in adult (sensitive-soft)');

  // BUG2: space-split sensitive-soft words merge in minor chats.
  ok(flags('a s s', false).length === 1, '[c3-engine] BUG2: a s s merges and flags minor');
  ok(flags('a s s', true).length === 0, '[c3-engine] BUG2: a s s passes in adult');

  // BUG3: standalone hits never fuse, order-independent.
  ok(flags('ass fuck', false).length === 2, '[c3-engine] BUG3: ass fuck -> 2 hits');
  ok(flags('fuck ass', false).length === 2, '[c3-engine] BUG3: fuck ass -> 2 hits');
  ok(masked('fuck me', false) === 'f∗∗k me', '[c3-engine] BUG3: fuck me keeps unmerged shape');

  // LOAD-1: cache sweep is exported and callable.
  ok(typeof sweepEngineCaches === 'function', '[c3-engine] LOAD-1: sweepEngineCaches exported');
  sweepEngineCaches();
  ok(flags('fuck', false).length === 1, '[c3-engine] LOAD-1: engine still flags after sweep');

  // Guard rails: innocent text stays clean.
  ok(flags('hello world', false).length === 0, '[c3-engine] clean: hello world');
  ok(flags('Cumana is a city', false).length === 0, '[c3-engine] clean: Cumana (proper noun)');
  ok(flags('fuck your ass', false).length === 2, '[c3-engine] shape: fuck your ass -> 2 hits, space unmasked');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
