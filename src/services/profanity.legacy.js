// Local in-house profanity filter. PurgoMalum-inspired, zero network calls:
// everything runs in memory inside this process.
//
// Two-tier wordlist (see wordlist.js):
//   - SOFT: mild profanities (shit, crap, ass, damn, hell, ...) permitted in
//     isolation: never matched, never masked, never flagged.
//   - HARD (WORDS): the absolute ban list. Standalone hard words match
//     whole-word, are masked inline, and flag the message.
// Compound rule: a hard compound word containing a soft component is still
// filtered (it flags the message), but masking is component-wise: the hard
// components stay censored while the soft components stay readable
// ("assfuck" -> "assf∗∗k", "shitfucker" -> "shitf∗∗∗∗er"). A compound with
// no identifiable hard component fails safe to full masking.
//
// Mechanics (researched from PurgoMalum-style filters):
//   - leetspeak and common character substitutions are folded per letter
//     (@ -> a, 3 -> e, 5 -> s, 0 -> o, 1 -> i/l, $ -> s, + -> t, ...), so
//     "@ss", "fuck", "5h1t" all match the same entry;
//   - repeated letters are tolerated ("fuuuck"), up to 3 per letter;
//   - separator evasion between letters is caught ("f.u.c.k", "f_u_c_k");
//   - matching is whole-word with lookarounds, never substring, so "hello"
//     never trips "hell" and "classic" never trips "ass";
//   - a safe-word whitelist backstops the separator handling, so dotted
//     innocent words ("c.l.a.s.s", "h.e.l.l.o") are never masked;
//   - masking is partial and inline: the first and last 1-2 characters are
//     kept (by word length) and only the inner characters are replaced with
//     the asterisk operator (U+2217), one symbol per replaced character.
//     The operator renders cleanly in Discord; plain asterisks would be
//     collapsed into italics/bold by Markdown ("fuck" -> "f**k").
//
// filterText(text) -> { text, flagged, hits }.
//   text:    the input with every hit masked inline (original untouched when
//           nothing is found). Messages are NEVER deleted or rejected.
//   flagged: true when at least one word was masked.
//   hits:    number of masked spans.

import { WORDS, SOFT_WORDS } from './wordlist.js';

/**
 * Soft profanity stems: never matched standalone, but recognized as readable
 * components inside compound words. Plain (non-leet) forms; the component
 * regexes built below are leet-tolerant like everything else.
 */
const SOFT_ROOTS = [
  'shit', 'crap', 'ass', 'arse', 'damn', 'hell', 'butt', 'fart',
  'piss', 'pee', 'poop', 'douche', 'bastard', 'turd',
];

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

/** Separators allowed BETWEEN letters (evasion like "f.u.c.k"). Spaces are
 *  deliberately excluded: allowing them false-positives across real word
 *  boundaries ("as soon as" would trip "ass"). */
const SEP = '[.,_\\-*~^*]';

/**
 * Safe words: never masked even if a dotted/separated span matches inside
 * them (e.g. someone typing "c.l.a.s.s"). Checked against the full token
 * the match sits in, with separators stripped.
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

/** Masking symbol: asterisk operator U+2217 (renders cleanly in Discord). */
export const MASK = '∗';

function escapeClassChars(s) {
  return s.replace(/[\\\][\[^-]/g, '\\$&');
}

function letterClass(variants) {
  return `(?:[${escapeClassChars(variants.join(''))}]){1,3}`;
}

function wordRegex(word, wholeWord = true) {
  const body = [...word].map((ch) => letterClass(LEET[ch] || [ch])).join(`${SEP}*`);
  // Whole-word only: no letter/digit may touch either end of the match.
  // Substring variant (wholeWord = false) is used for component analysis
  // inside already-matched compound words.
  return wholeWord
    ? new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`, 'g')
    : new RegExp(body, 'g');
}

// Precompile once at load. Indexed by every possible first character so a
// message only runs the patterns that could plausibly match it. Each entry
// carries its word so the compound rule can be applied at mask time.
const firstCharIndex = new Map(); // char -> { re, word }[]
for (const word of WORDS) {
  const entry = { re: wordRegex(word, true), word };
  for (const ch of LEET[word[0]] || [word[0]]) {
    if (!firstCharIndex.has(ch)) firstCharIndex.set(ch, []);
    firstCharIndex.get(ch).push(entry);
  }
}

/**
 * Hard words containing a soft stem: the compound rule applies when they
 * match (component-wise masking, but the message is still flagged).
 */
const COMPOUND_WORDS = new Set(
  WORDS.filter((w) => SOFT_ROOTS.some((r) => w.includes(r))),
);

/** Substring leet-tolerant matchers for component analysis. */
const softSubRes = SOFT_ROOTS.map((r) => wordRegex(r, false));
const hardSubRes = WORDS.map((w) => wordRegex(w, false));

/**
 * Soft-word patterns: consulted only when a message already contains a hard
 * hit. Soft profanities stay readable in isolation, but when they share a
 * message with hard profanity ("fuck your ass") they are masked as well:
 * soft means "permitted when used individually", not "permitted next to
 * hard profanity".
 */
const softFirstCharIndex = new Map(); // char -> { re, word }[]
for (const word of SOFT_WORDS) {
  const entry = { re: wordRegex(word, true), word };
  for (const ch of LEET[word[0]] || [word[0]]) {
    if (!softFirstCharIndex.has(ch)) softFirstCharIndex.set(ch, []);
    softFirstCharIndex.get(ch).push(entry);
  }
}

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

/**
 * Partial inline mask. Keeps the first and last character for short words
 * (3-4 chars) and the first and last two for longer words, replacing only
 * the inner characters with one MASK symbol each ("fuck" -> "f**k" with the
 * asterisk operator).
 */
export function maskSpan(span) {
  const n = span.length;
  if (n <= 2) return MASK.repeat(n);
  const keep = n <= 4 ? 1 : 2;
  const inner = n - keep * 2;
  if (inner <= 0) return MASK.repeat(n);
  return span.slice(0, keep) + MASK.repeat(inner) + span.slice(n - keep);
}

export function filterText(input) {
  const text = String(input ?? '');
  const clean = { text, flagged: false, hits: 0 };
  if (!text) return clean;
  const lower = text.toLowerCase();

  const candidates = new Set();
  for (const ch of lower) {
    const arr = firstCharIndex.get(ch);
    if (arr) for (const re of arr) candidates.add(re);
  }
  if (!candidates.size) return clean;

  const raw = [];
  for (const { re, word } of candidates) {
    re.lastIndex = 0;
    for (const m of lower.matchAll(re)) {
      if (m[0] && m.index != null) raw.push({ start: m.index, end: m.index + m[0].length, word });
    }
  }
  if (!raw.length) return clean;

  // Longest match wins at each position; overlapping shorter ones are dropped
  // ("fucking" masks as one span, not "fuck" + "ing").
  raw.sort((a, b) => a.start - b.start || b.end - a.end);
  const spans = [];
  let lastEnd = -1;
  for (const m of raw) {
    if (m.start < lastEnd) continue;
    spans.push(m);
    lastEnd = m.end;
  }

  let hits = spans.filter((m) => !WHITELIST.has(tokenCore(text, m.start, m.end)));
  if (hits.length) {
    // Soft-word upgrade: a soft profanity sharing the message with hard
    // profanity is masked too ("fuck your ass" -> "f∗∗k your a∗s").
    // Longest-wins, skipping anything overlapping a hard hit, with the same
    // whitelist backstop as the main pipeline.
    const softCandidates = new Set();
    for (const ch of lower) {
      const arr = softFirstCharIndex.get(ch);
      if (arr) for (const entry of arr) softCandidates.add(entry);
    }
    const softRaw = [];
    for (const { re, word } of softCandidates) {
      re.lastIndex = 0;
      for (const m of lower.matchAll(re)) {
        if (m[0] && m.index != null) softRaw.push({ start: m.index, end: m.index + m[0].length, word });
      }
    }
    softRaw.sort((a, b) => a.start - b.start || b.end - a.end);
    const overlapsHard = (s, e) => hits.some((h) => s < h.end && h.start < e);
    let lastEnd = -1;
    for (const m of softRaw) {
      if (m.start < lastEnd || overlapsHard(m.start, m.end)) continue;
      if (WHITELIST.has(tokenCore(text, m.start, m.end))) continue;
      hits.push(m);
      lastEnd = m.end;
    }
    hits.sort((a, b) => a.start - b.start);
  }
  if (!hits.length) return clean;

  let out = text;
  for (let i = hits.length - 1; i >= 0; i--) {
    const m = hits[i];
    const span = out.slice(m.start, m.end);
    const masked = COMPOUND_WORDS.has(m.word) ? maskCompoundSpan(span) : maskSpan(span);
    out = out.slice(0, m.start) + masked + out.slice(m.end);
  }
  return { text: out, flagged: true, hits: hits.length };
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
 * Component-wise masking for compound words (the compound rule): hard
 * components stay censored, soft components and neutral filler stay
 * readable. Soft wins any overlap. Falls back to full maskSpan when no hard
 * component is found, so a compound the audit kept hard is never silently
 * unblocked by a segmentation miss.
 */
export function maskCompoundSpan(span) {
  const softSpans = collectSubMatches(span, softSubRes);
  const spanLetters = countLetters(span);
  const overlaps = (a, b) => a.start < b.end && b.start < a.end;
  const hardSpans = collectSubMatches(span, hardSubRes, (h) => {
    // The compound's own full-span match is not a component (checked before
    // dedup so it cannot swallow the genuine components underneath it).
    if (countLetters(span.slice(h.start, h.end)) === spanLetters) return false;
    // Soft components stay uncensored even under a hard overlap.
    return !softSpans.some((s) => overlaps(h, s));
  });
  if (!hardSpans.length) return maskSpan(span);

  const censored = new Array(span.length).fill(false);
  for (const h of hardSpans) {
    const letters = [];
    for (let i = h.start; i < h.end; i++) {
      if (/[a-z0-9]/i.test(span[i])) letters.push(i);
    }
    const n = letters.length;
    const keep = n <= 2 ? 0 : n <= 4 ? 1 : 2;
    for (let j = keep; j < n - keep; j++) censored[letters[j]] = true;
  }
  return [...span].map((ch, i) => (censored[i] ? MASK : ch)).join('');
}
