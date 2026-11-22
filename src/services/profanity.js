// Profanity filter: engine-backed detection, legacy masking semantics.
//
// Detection is delegated to src/services/profanity-engine.js (ported
// `profanity-filter` library: deep analysis over the tiered hard lists,
// exact matching over the tiered soft lists). Everything about HOW a span is
// masked once flagged lives here, mirroring the live bot's tiering:
//
// Three-tier wordlist (see wordlist.js / profanity-tiers.js), applied per
// chat tier via filterText(input, { adultChat }):
//   - HARD (603): the absolute ban list. Flagged spans are masked inline
//     and flag the message (one strike per flagged message, counted in
//     chat.js) in every chat.
//   - SENSITIVE (116 hard entries + 5 soft words): minor chats censor and
//     flag them exactly like hard words; adult chats skip them entirely,
//     except the 16 MIXED_SENSITIVE entries carrying a genuine hard
//     component, which still flag with only the hard component censored.
//   - MILD (31, incl. the shit-family since 2026-09-21): permitted in
//     isolation in every chat: never matched, never masked, never flagged.
//     When they share a message with flaggable profanity they are masked
//     too ("fuck your ass" -> "f∗∗k your a∗s" in a minor chat, "bitch hell"
//     -> "bi∗ch h∗∗l" in an adult chat).
// Compound rule: a compound word containing a soft/sensitive component is
// still filtered (it flags the message), but masking is component-wise:
// hard components always censored; sensitive components censored in minor
// chats only; mild components censored only when the message is flaggable;
// neutral filler stays readable ("assfuck" -> "a∗sf∗∗k" in a minor chat,
// passes clean in an adult chat). A compound with no flaggable component
// fails safe to full masking. Adult mixed-sensitive entries are the one
// exception to the mild-component rule: only the hard component is ever
// censored there ("shitdick" -> "shitd∗∗k").
//
// Masking shapes (unchanged):
//   - the asterisk operator (U+2217), never markdown '*', so Discord does
//     not collapse it into italics/bold;
//   - ≤2 chars fully masked; 3-4 chars keep first+last 1 ("fuck" -> "f∗∗k");
//     5+ keep first+last 2 ("motherfucker" -> "mo∗∗∗∗∗∗∗∗er");
//   - original casing and separators preserved ("FUCK" -> "F∗∗K",
//     "f.u.c.k" -> "f.∗∗∗.k"); compound spans mask letters only, keeping
//     separators ("a.s.s.f.u.c.k" -> "a.s.s.f.∗.∗.k").
//
// filterText(text, { adultChat }) -> { text, flagged, hits }.
//   text:    the input with every hit masked inline (original untouched when
//           nothing is found). Messages are NEVER deleted or rejected.
//   flagged: true when at least one word was masked.
//   hits:    number of masked spans.
//   adultChat defaults to false (minor, fail-safe).

import { SENSITIVE_WORDS, SENSITIVE_SOFT } from './wordlist.js';
import {
  HARD_TIER, MILD_SOFT, SENSITIVE_ROOTS, MILD_ROOTS, MIXED_SENSITIVE,
} from './profanity-tiers.js';
import { scanHard, sweepEngineCaches } from './profanity-engine.js';

/** Masking symbol: asterisk operator U+2217 (renders cleanly in Discord). */
export const MASK = '∗';

function escapeClassChars(s) {
  return s.replace(/[\\\][\[^-]/g, '\\$&');
}

/** Per-letter leetspeak / substitution variants (lowercase matching). */
const LEET = {
  a: ['a', '@', '4'],
  b: ['b', '8'],
  c: ['c', '(', '<', '[', '{'],
  d: ['d'],
  e: ['e', '3'],
  f: ['f'],
  g: ['g', '9', '6'],
  h: ['h'],
  i: ['i', '1', '!', '|'],
  j: ['j'],
  k: ['k'],
  l: ['l', '1', '|'],
  m: ['m'],
  n: ['n'],
  o: ['o', '0'],
  p: ['p'],
  q: ['q', '9'],
  r: ['r'],
  s: ['s', '5', '$'],
  t: ['t', '7', '+'],
  u: ['u', 'v'],
  v: ['v', 'u'],
  w: ['w'],
  x: ['x'],
  y: ['y'],
  z: ['z', '2'],
};

/** Separators allowed BETWEEN letters (evasion like "f.u.c.k"). */
const SEP = '[.,_\\-*~^*]';

function letterClass(variants) {
  return `(?:[${escapeClassChars(variants.join(''))}]){1,3}`;
}

function wordRegex(word, wholeWord = true) {
  const body = [...word].map((ch) => letterClass(LEET[ch] || [ch])).join(`${SEP}*`);
  // Substring variant (wholeWord = false) is used for component analysis
  // inside already-flagged compound spans.
  return wholeWord
    ? new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`, 'g')
    : new RegExp(body, 'g');
}

/** Substring leet-tolerant matchers for component analysis. Sensitive
 *  components are split into roots and words (see maskCompoundSpan). */
const sensRootSubRes = SENSITIVE_ROOTS.map((r) => wordRegex(r, false));
const sensWordSubRes = SENSITIVE_WORDS.map((w) => wordRegex(w, false));
const hardSubRes = HARD_TIER.map((w) => wordRegex(w, false));
const mildSubRes = MILD_ROOTS.map((r) => wordRegex(r, false));

/**
 * Whole-word leet-tolerant matchers for the tier scans below. Minor chats
 * scan the 5 sensitive-soft words standalone (they flag like hard words);
 * both chat types run the 31 mild words as an upgrade scan, gated on the
 * message already being flaggable. Mirrors the live bot's tier indexes.
 */
const sensSoftRes = SENSITIVE_SOFT.map((w) => wordRegex(w, true));
const mildRes = MILD_SOFT.map((w) => wordRegex(w, true));

/**
 * Safe words: never masked even if a dotted/separated span matches inside
 * them (e.g. someone typing "c.l.a.s.s"). Checked against the full token
 * the match sits in, with separators stripped. Mirrors the live bot.
 */
const WHITELIST = new Set([
  'class', 'classes', 'classic', 'classics', 'classroom',
  'pass', 'passes', 'passed', 'passing', 'password', 'passwords',
  'grass', 'grasses', 'grassy',
  'glass', 'glasses', 'glassy',
  'mass', 'masses', 'massive',
  'assign', 'assigns', 'assigned', 'assignment', 'assignments',
  'assist', 'assists', 'assisted', 'assistant', 'assistants',
  'assemble', 'assembly', 'asset', 'assets',
  'associate', 'associates', 'association',
  'assume', 'assumes', 'assumed', 'assure', 'assured',
  'compass', 'compasses', 'embarrass', 'embarrassed', 'embarrassing',
  'harass', 'harassed', 'harassment', 'amass', 'amassed',
  'bass', 'canvas', 'canvases', 'molasses', 'cutlass',
  'arsenal', 'parse', 'parsed', 'parcel',
  'hello', 'hellos', 'shell', 'shells', 'smell', 'smells', 'spell', 'spells',
  'swell', 'dwell',
  'scrap', 'scraps', 'scrappy',
  'cucumber', 'cucumbers', 'document', 'documents', 'documentary',
  'accumulate', 'accumulated',
  'shiitake', 'shitake',
  'title', 'titles', 'titan', 'titanic',
  'cocktail', 'cocktails', 'peacock', 'peacocks', 'cockpit',
  'dickens', 'booby', 'boobies',
]);

const TOKEN_CHAR = /[a-z0-9.,_\-*~^*]/i;

/** Expand a match to the full dotted token it sits in, then strip every
 *  separator: "c.l.a.s.s" -> "class". Used for the whitelist check. */
function tokenCore(text, start, end) {
  let s = start;
  let e = end;
  while (s > 0 && TOKEN_CHAR.test(text[s - 1])) s -= 1;
  while (e < text.length && TOKEN_CHAR.test(text[e])) e += 1;
  return text.slice(s, e).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Whole-word scan of one tier's regexes over the lowercased text. */
function scanTierWords(res, text) {
  const lower = text.toLowerCase();
  const raw = [];
  for (const re of res) {
    re.lastIndex = 0;
    for (const m of lower.matchAll(re)) {
      if (m[0] && m.index != null) {
        raw.push({ start: m.index, end: m.index + m[0].length, compound: false });
      }
    }
  }
  return raw;
}

/** Longest match wins at each position; overlapping shorter ones are
 *  dropped ("fucking" masks as one span, not "fuck" + "ing"). Extra span
 *  fields (compound) are preserved. */
function longestWinsSpans(lists) {
  const raw = lists.flat();
  raw.sort((a, b) => a.start - b.start || b.end - a.end);
  const spans = [];
  let lastEnd = -1;
  for (const m of raw) {
    if (m.start < lastEnd) continue;
    spans.push(m);
    lastEnd = m.end;
  }
  return spans;
}

/**
 * Partial inline mask. Keeps the first and last character for short words
 * (3-4 chars) and the first and last two for longer words, replacing only
 * the inner characters with one MASK symbol each ("fuck" -> "f**k" with the
 * asterisk operator).
 */
export function maskSpan(span) {
  // Code-point-indexed: the old UTF-16 slicing split astral chars into lone
  // surrogates ("f😀uck" -> "f\uD83D∗∗ck"). BMP-only spans are unchanged.
  const cps = [...span];
  const n = cps.length;
  if (n <= 2) return MASK.repeat(n);
  const keep = n <= 4 ? 1 : 2;
  const inner = n - keep * 2;
  if (inner <= 0) return MASK.repeat(n);
  return cps.slice(0, keep).join('') + MASK.repeat(inner) + cps.slice(n - keep).join('');
}

export function filterText(input, options = {}) {
  const adultChat = options?.adultChat === true;
  const text = String(input ?? '');
  const clean = { text, flagged: false, hits: 0 };
  if (!text) return clean;

  // Hard/sensitive scan via the detection engine (tier-aware: the full 719
  // in minor chats, HARD_TIER + the 16 mixed entries in adult chats).
  const hardHits = scanHard(text, { adultChat });

  // Sensitive-soft scan (minor chats only): the 5 ass-family words flag
  // standalone, exactly like hard words. Whole-word leet-tolerant regexes
  // with the whitelist backstop, mirroring the live bot.
  let softHits = [];
  if (!adultChat) {
    softHits = scanTierWords(sensSoftRes, text).filter(
      (m) => !WHITELIST.has(tokenCore(text, m.start, m.end)),
    );
  }

  // Longest-wins across the engine spans and the regex spans.
  const flaggable = longestWinsSpans([hardHits, softHits]);

  if (flaggable.length) {
    // Mild-word upgrade (both chat types): a mild profanity sharing the
    // message with flaggable profanity is masked too ("bitch hell" ->
    // "bi∗ch h∗∗l"). Longest-wins, skipping anything overlapping a
    // flaggable hit, with the same whitelist backstop.
    const mildRaw = scanTierWords(mildRes, text).filter(
      (m) => !WHITELIST.has(tokenCore(text, m.start, m.end)),
    );
    const overlapsFlaggable = (s, e) => flaggable.some((h) => s < h.end && h.start < e);
    for (const m of longestWinsSpans([mildRaw])) {
      if (overlapsFlaggable(m.start, m.end)) continue;
      flaggable.push(m);
    }
    flaggable.sort((a, b) => a.start - b.start);
  }
  if (!flaggable.length) return clean;

  let out = text;
  for (let i = flaggable.length - 1; i >= 0; i--) {
    const m = flaggable[i];
    const span = out.slice(m.start, m.end);
    // Adult mixed-sensitive entries censor only the hard component: their
    // mild components stay readable ("shitdick" -> "shitd∗∗k"). The engine
    // marks those hits (m.mixed); every other flaggable compound still
    // censors mild components (the upgrade rule).
    const masked = m.compound
      ? maskCompoundSpan(span, { adultChat, flaggable: !m.mixed })
      : maskSpan(span);
    out = out.slice(0, m.start) + masked + out.slice(m.end);
  }
  return { text: out, flagged: true, hits: flaggable.length };
}

/** Longest-wins substring matches of the given regexes inside a span.
 *  `keep` pre-filters candidates before dedup (so a dropped whole-span
 *  match cannot swallow the genuine components underneath it). */
function collectSubMatches(span, res, keep = () => true) {
  const lower = span.toLowerCase();
  const raw = [];
  for (const re of res) {
    re.lastIndex = 0;
    for (const m of lower.matchAll(re)) {
      if (m[0] && m.index != null) {
        const mm = { start: m.index, end: m.index + m[0].length };
        if (keep(mm)) raw.push(mm);
      }
    }
  }
  raw.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let lastEnd = -1;
  for (const m of raw) {
    if (m.start < lastEnd) continue;
    out.push(m);
    lastEnd = m.end;
  }
  return out;
}

const countLetters = (s) => (s.match(/[a-z0-9]/gi) || []).length;

/**
 * Component-wise masking for compound words (the compound rule), tier-aware:
 * hard components are always censored; sensitive components are censored in
 * minor chats only; mild components are censored only when the message is
 * flaggable (the upgrade rule); neutral filler stays readable. The gentlest
 * tier wins overlaps. Falls back to full maskSpan when no flaggable
 * component is found, so a compound the engine flagged is never silently
 * unblocked by a segmentation miss.
 *
 * options: { adultChat = false, flaggable = true }. Called with no options
 * (the historical signature) it behaves as a minor-chat flaggable message.
 */
export function maskCompoundSpan(span, options = {}) {
  const adultChat = options?.adultChat === true;
  const flaggable = options?.flaggable !== false;
  const overlaps = (a, b) => a.start < b.end && b.start < a.end;

  // Fix E: segment on a pictograph/mark-stripped copy of the span. The
  // regex tiers match letters, so stripping Extended_Pictographic chars
  // and combining marks first lets "a😀ssbitch" segment as "ass"+"bitch"
  // (previously the emoji offset the segmentation: "ssbitch" masked as one
  // component). Stripped-unit offsets map back to original-unit offsets
  // before masking, so the emoji itself is never censored and the verdict
  // is unchanged. The map is the identity when there is nothing to strip,
  // so BMP-only spans behave exactly as before.
  const segUnits = []; // stripped UTF-16 unit index -> original unit index
  let segSpan = '';
  for (let u = 0; u < span.length; ) {
    const cp = span.codePointAt(u);
    const ch = String.fromCodePoint(cp);
    const ulen = cp > 0xffff ? 2 : 1;
    if (!/\p{Extended_Pictographic}/u.test(ch) && !/\p{M}/u.test(ch)) {
      for (let k = 0; k < ulen; k++) segUnits.push(u + k);
      segSpan += ch;
    }
    u += ulen;
  }
  segUnits.push(span.length);
  const toOrig = (m) => ({ start: segUnits[m.start], end: segUnits[m.end] });

  const spanLetters = countLetters(segSpan);
  const notWholeSpan = (h) => countLetters(segSpan.slice(h.start, h.end)) !== spanLetters;

  // Mild roots anchor the segmentation just like sensitive roots do: a mild
  // component is claimed before sensitive words are segmented, so a longer
  // sensitive word spanning it (e.g. "shitfuck" inside "shitfucker") cannot
  // swallow it. The final mild spans still lose overlaps against sensitive
  // and hard spans below (gentlest tier wins). All segmentation below runs
  // on the stripped copy (fix E); offsets map back to the original span
  // when the `on` list is built.
  const mildAnchor = collectSubMatches(segSpan, mildSubRes);
  const noMildOverlap = (m) => !mildAnchor.some((r) => m.start < r.end && r.start < m.end);

  const sensSpans = (() => {
    // Roots anchor the segmentation and win overlaps against sensitive
    // words: "fuckass" segments as fuck+ass (not the spurious "fucka"),
    // while a word overlapped by a root is dropped only when it truly
    // collides (longest-wins still applies within each pass).
    const roots = collectSubMatches(segSpan, sensRootSubRes, notWholeSpan);
    const noRootOverlap = (m) => !roots.some((r) => m.start < r.end && r.start < m.end);
    const words = collectSubMatches(segSpan, sensWordSubRes, (m) => notWholeSpan(m) && noRootOverlap(m) && noMildOverlap(m));
    return [...roots, ...words].sort((a, b) => a.start - b.start || b.end - a.end);
  })();
  const hardSpans = collectSubMatches(segSpan, hardSubRes, (h) =>
    notWholeSpan(h) && !sensSpans.some((s) => overlaps(h, s)),
  );
  const mildSpans = mildAnchor.filter((m) =>
    !sensSpans.some((s) => overlaps(m, s)) && !hardSpans.some((h) => overlaps(m, h)),
  );

  const on = [
    ...hardSpans,
    ...(!adultChat ? sensSpans : []),
    ...(flaggable ? mildSpans : []),
  ].map(toOrig);
  if (!on.length) return maskSpan(span);

  // Code-point-consistent masking: matchAll offsets (h.start/h.end) are
  // UTF-16 code units on the stripped copy, mapped back to the original
  // span's units above (fix E), but the mask is applied per code point, so
  // an astral char before a component would shift the window ("😀fuckass"
  // masked the wrong letters). Convert every match to code-point indices
  // once via a unit->code-point map. BMP-only spans map unit i to code
  // point i, so their output is unchanged.
  const cps = [...span];
  const unitToCp = new Array(span.length + 1);
  {
    let cp = 0;
    let u = 0;
    while (u < span.length) {
      unitToCp[u] = cp;
      const cu = span.charCodeAt(u);
      u += cu >= 0xd800 && cu <= 0xdbff && u + 1 < span.length ? 2 : 1;
      cp++;
    }
    unitToCp[span.length] = cp;
  }
  const censored = new Array(cps.length).fill(false);
  for (const h of on) {
    const letters = [];
    const cs = unitToCp[h.start];
    const ce = unitToCp[h.end];
    for (let i = cs; i < ce; i++) {
      if (/[a-z0-9]/i.test(cps[i])) letters.push(i);
    }
    const n = letters.length;
    const keep = n <= 2 ? 0 : n <= 4 ? 1 : 2;
    for (let j = keep; j < n - keep; j++) censored[letters[j]] = true;
  }
  return cps.map((ch, i) => (censored[i] ? MASK : ch)).join('');
}

// Re-exported for tests: the mixed-sensitive entries that still flag in
// adult chats via their hard component.
export { MIXED_SENSITIVE };
export { sweepEngineCaches };
