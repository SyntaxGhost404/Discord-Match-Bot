// Profanity detection engine: adapter over the ported `profanity-filter`
// library (~/workspace/profanity-filter-js-experimental/). Owns the hard
// ProfanityFilter instances, span building, leet folding, the soft-word
// isolation rule, an ordinary-word precision guard, and a per-word verdict
// cache. Synchronous throughout. Tier-aware: scanHard(text, { adultChat })
// implements the channel-aware tiering (see profanity-tiers.js); the
// sensitive-soft and mild scans live in profanity.js as whole-word
// leet-tolerant regex scans mirroring the live bot.
//
// Detection architecture
// ----------------------
// Engine instances are constructed ONCE at module load (never per message;
// cold construct is ~10ms each):
//   - hard (minor chats): custom EN dictionary = WORDS (719: 603 hard +
//     116 sensitive), analyses = {deep} (exact + lemma + fuzzy trie +
//     substring scan), maxRelativeDistance 0.34, exactly as specified.
//   - hardFilterAdult: custom EN dictionary = HARD_TIER (603). The 116
//     sensitive words are excluded; their fuzzy near-misses would otherwise
//     bleed across tiers ("fuck" via hard "fack"), so pure sensitive words
//     are skipped before the fuzzy verdict in adult chats.
//   - mixedFilter (adult chats only): custom EN dictionary =
//     MIXED_SENSITIVE (16): sensitive entries carrying a genuine hard
//     component still flag, with only the hard component masked.
// Scope decision: languages: ['en'] ONLY, multilingual analysis off. The old
// filter was English-only; enabling 'ru' would newly flag Russian messages,
// a product behavior change that was not asked for.
//
// Span building (why not raw groupSpans)
// -------------------------------------
// The library's groupSpans() splits "f.u.c.k" into single-letter spans
// ("f", ".", "u", ...), which the engine cannot rejoin into a verdict, so a
// pinned evasion ("f.u.c.k" must flag) would be missed. The adapter therefore
// builds its own detection spans: maximal runs of word tokens joined by
// separator punctuation from the legacy separator set [.,_*~^-]. Spaces and
// all other punctuation still break runs. Leading/trailing separators are
// trimmed ("*fuck*" -> "fuck").
//   - hard scan: strict join set (separators only). "@ss" splits to "ss"
//     (clean), "@fuck" splits to "fuck" (masked "f**k", "@" untouched).
//   - soft scan: extended join set (separators + leet punctuation
//     @!$+|). Leading leet punctuation is kept ("@ss" must upgrade to
//     "@*s"); trailing leet punctuation is trimmed ("ass!" -> "ass").
//
// Per-span normalization
// ----------------------
// Before detection each span is lowercased and leet-folded. The fold covers
// only UNAMBIGUOUS substitutions (digits, @->$+ etc.): folding 'v'->'u' was
// tried and reverted because it corrupts ordinary words ("gave"->"gaue",
// "canvas"->"canuas", which the fuzzy analysis then flags). Single-char
// substitutions ('v' for 'u', '!' for 'i', '(' for 'c') are left to the
// engine's fuzzy analysis, which handles them without corrupting the input.
// Two forms are derived:
//   - bare:  folded, all non-alphanumerics deleted ("a.s.s" -> "ass").
//            Used for the soft-word isolation check, the ordinary-word
//            guard, the exact-dictionary fast path, and the soft-engine input.
//   - key:   folded, runs of separator punctuation collapsed to a single
//            "*" ("f**k" -> "f*ck", "f.u.c.k" -> "f*u*c*k"). Fed to the hard
//            engine: the letters-stripping lemma recovers "fuck" from
//            "f*u*c*k", and the fuzzy trie bridges single-char evasions
//            ("f*ck" is 1 edit from "fuck").
// Detection NEVER mutates the original text: masking in profanity.js uses
// span.start/span.end (UTF-16 code units tiling the input) on the original.
//
// Soft-word isolation (tier-aware product rule)
// --------------------
// Minor chats: the 31 MILD words pass untouched in isolation: never masked,
// never flagged, never struck. The 5 SENSITIVE_SOFT words flag standalone
// like hard words (scanned by profanity.js). Adult chats: all 36 soft words
// pass untouched in isolation. The engine's substring/fuzzy scan would
// otherwise flag some of them via unrelated hard words ("bastard" via
// "tard", "shitty" via fuzzy "whitey", "piss" via fuzzy "puss"), so any span
// whose bare form is exactly an isolated-exempt word skips the hard engine
// entirely. Compounds ("assfuck" -> bare "assfuck") are unaffected: the
// check is whole-span equality, not substring.
//
// Ordinary-word precision guard
// -----------------------------
// The engine's fuzzy/substring analysis false-positives on ordinary words
// its bundled 48,369-word clean list does not cover, especially inflections
// ("games"->"gai", "kissed"->"fisted", "sucks"->"fucks", "dismissed"->"jism")
// and short words ("gay"->"ghay", "wth"->"wtf", "tots"->"toots"). The old
// filter was whole-word: an ordinary dictionary word was never profanity.
// The guard restores that contract: a span whose bare form (or any stem /
// de-inflected form of it) is an ordinary word, a soft word, or a listed
// exemption skips the engine. It runs AFTER the exact hard-word fast path,
// so exact dictionary hits always flag, and it can only turn would-be flags
// into clean, never the reverse. The engine still sees every non-dictionary
// string, so evasions ("f*ck", "oofuko", "b00b", "f.u.c.k") are unaffected.
// Sources: the library's own clean list (isCommonWord) + the library's
// stemmer + plain de-inflection (the stemmer maps "games"->"gam") +
// LEGACY_WHITELIST (the old filter's 95 safe words, verbatim) + a small
// curated SUPPLEMENT for gaps the clean list misses (documented per word).
//
// Performance (measured 2026-09-21, this VM, warmed caches, 2000 iterations)
// ---------------------------------------------------------
// clean ~165-char message:  p50 0.06ms, p99 2.1ms
// profane message:          p50 0.05ms, p99 0.30ms
// adversarial (leet/seps):  p50 1.94ms, p99 3.13ms
// 2000-char clean (max):    p50 0.64ms, p99 3.13ms, max 10.2ms
// Well inside the 50ms budget with the prescribed engine config untouched:
// two instances constructed once at module load, per-word verdict cache
// (cap 5000), and the exact-dictionary/ordinary-word fast paths that skip
// the trie for most spans.

import { ProfanityFilter } from '../../../profanity-filter-js-experimental/src/profanity-filter.js';
import { tokenize } from '../../../profanity-filter-js-experimental/src/tokenizer.js';
import { isCommonWord } from '../../../profanity-filter-js-experimental/src/common-words.js';
import { stemCandidates } from '../../../profanity-filter-js-experimental/src/lemmatizer.js';
import { WORDS } from './wordlist.js';
import {
  HARD_TIER, MIXED_SENSITIVE, SENSITIVE_ROOTS, MILD_ROOTS,
  WORDS_SET, HARD_TIER_SET, SOFT_SET, MILD_SET, SENSITIVE_SET, SENSITIVE_SOFT_SET,
} from './profanity-tiers.js';

/**
 * Compound-root check: a flagged span whose bare form contains a sensitive
 * or mild root is eligible for component-wise masking (see maskCompoundSpan
 * in profanity.js). Plain (non-leet) forms; spans are leet-folded before
 * this check.
 */
const COMPOUND_ROOTS = [...SENSITIVE_ROOTS, ...MILD_ROOTS];
export function hasCompoundRoot(bare) {
  return COMPOUND_ROOTS.some((r) => bare.includes(r));
}

/**
 * Sensitive-word + hard-word compound check (minor chats): the bare form is
 * an exact concatenation of a sensitive-tier word and a hard-tier word, in
 * either order ("fuckbitch" -> "fuck"+"bitch"). Such spans mask per component
 * via maskCompoundSpan; the root check above misses them because neither
 * part is a bare root. Exact concatenation only — an inflected hard word
 * ("fucking" = "fuck"+"ing") is not a compound, so its full-mask shape is
 * preserved.
 */
const SENSITIVE_TIER_SET = new Set([...SENSITIVE_SET, ...SENSITIVE_SOFT_SET]);
function isSensitiveHardCompound(bare) {
  for (let i = 1; i < bare.length; i++) {
    const left = bare.slice(0, i);
    const right = bare.slice(i);
    if (
      (SENSITIVE_TIER_SET.has(left) && HARD_TIER_SET.has(right)) ||
      (HARD_TIER_SET.has(left) && SENSITIVE_TIER_SET.has(right))
    ) {
      return true;
    }
  }
  return false;
}

const FILTER_OPTS_DEEP = {
  languages: ['en'],
  analyses: new Set(['deep']),
  maxRelativeDistance: 0.34,
};

const hardFilter = new ProfanityFilter({
  ...FILTER_OPTS_DEEP,
  customProfaneWordDictionaries: { en: WORDS },
});

/**
 * Adult-chat hard instance: HARD_TIER (603) only. Sensitive words are
 * excluded here; the MIXED_SENSITIVE entries carrying a genuine hard
 * component are scanned by mixedFilter below.
 */
const hardFilterAdult = new ProfanityFilter({
  ...FILTER_OPTS_DEEP,
  customProfaneWordDictionaries: { en: HARD_TIER },
});

/** Adult-only: the 16 sensitive entries that still flag via a hard component. */
const mixedFilter = new ProfanityFilter({
  ...FILTER_OPTS_DEEP,
  customProfaneWordDictionaries: { en: [...MIXED_SENSITIVE] },
});

/**
 * Adult-chat fuzzy-bleed guard: the (non-mixed) sensitive words, scanned with
 * the same deep-fuzzy options as the hard engine. The hard verdict is
 * tier-blind, so an evasion-shaped span it flags may actually be a
 * sensitive-tier evasion ("f*ck" via hard "fack"); when this filter also
 * flags the span, the sensitive tier wins the ambiguity and the span passes
 * untouched in adult chats. Mixed entries are excluded — they keep their own
 * adult handling (mixedFilter + the mixed pass in scanHard) and must never
 * be suppressed here.
 */
const sensitiveFilter = new ProfanityFilter({
  ...FILTER_OPTS_DEEP,
  customProfaneWordDictionaries: {
    en: [...SENSITIVE_SET].filter((w) => !MIXED_SENSITIVE.has(w)),
  },
});

/**
 * The old filter's safe-word list, verbatim. The engine's clean list +
 * guard already covers nearly all of these; they are listed explicitly
 * because they are the old product contract, so a future regression has a
 * documented home. Checked on the bare form, so dotted variants
 * ("c.l.a.s.s") are covered too. Order note: the tier dictionary is consulted
 * first, so an exact tier word always flags even if it somehow appeared here.
 */
const LEGACY_WHITELIST = new Set([
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

/**
 * Ordinary words the engine's fuzzy analysis false-positives on, found by
 * differential fuzzing (legacy vs engine) and reviewed individually. Each is
 * unambiguously innocent in ordinary chat; without these the fuzzy analysis
 * would strike/terminate users for "gay", "games", "wth", etc.
 * (Reviewed 2026-09-21.)
 */
const SUPPLEMENT = new Set([
  'gay', 'gays',            // fuzzy "ghay"
  'wth',                   // fuzzy "wtf"; "what the hell", ubiquitous
  'lmao',                  // fuzzy "lmfao"; ubiquitous acronym
  'dislike',               // fuzzy "spik" via substring
  'dismiss',               // fuzzy "jism" via substring; base of dismissed/...
  'penistone',             // substring "penis" (town name; Scunthorpe case)
  'scunthorpe',            // substring "cunt" (town name; classic case)
  // Chat slang the fuzzy analysis collides with (each verified: legacy
  // clean, engine flags via a 1-2 edit near-miss). All are ubiquitous,
  // non-profane chat vocabulary; flagging them would strike innocent users.
  'ong', 'fam', 'homie', 'bestie', 'rizz', 'gyat', 'simp', 'boomer',
  'omw', 'fomo',
]);

/**
 * Unambiguous leet substitutions only. Deliberately NOT folding: v->u
 * ("gave"->"gaue"), (->c / [->c ("(ock" corrupts "(ok"), which the fuzzy
 * analysis handles without corrupting ordinary words.
 */
const FOLD = {
  '@': 'a', '4': 'a',
  '8': 'b',
  '3': 'e',
  '9': 'g', '6': 'g',
  '1': 'i', '!': 'i', '|': 'i',
  '7': 't', '+': 't',
  '0': 'o',
  '5': 's', '$': 's',
  '2': 'z',
};

/** Punctuation allowed BETWEEN letters (legacy separator set). */
const MERGE_SEPS = new Set(['.', ',', '_', '-', '*', '~', '^']);
/** Punctuation that is also a leet substitution (soft scan only). */
const LEET_PUNCT = new Set(['@', '!', '|', '+', '$']);

const SEP_RUN_RE = /[.,_*~^\-]+/g;
const NON_ALNUM_RE = /[^a-z0-9]/g;

function foldLower(s) {
  return [...s.toLowerCase()].map((ch) => FOLD[ch] ?? ch).join('');
}

/** Folded form with separator runs collapsed: the hard engine's input. */
function engineKey(spanText) {
  return foldLower(spanText).replace(SEP_RUN_RE, '*');
}

/** Folded alphanumeric-only form: isolation, guard, fast path, soft input. */
function bareForm(spanText) {
  return foldLower(spanText).replace(NON_ALNUM_RE, '');
}

/** Base-form candidates: the library stemmer plus plain de-inflection
 *  (the stemmer maps "games"->"gam", missing the obvious "game"). */
function stemForms(bare) {
  const out = new Set([bare, ...stemCandidates(bare)]);
  if (bare.endsWith('ies') && bare.length > 4) out.add(`${bare.slice(0, -3)}y`);
  if (bare.endsWith('es') && bare.length > 4) out.add(bare.slice(0, -2));
  if (bare.endsWith('s') && bare.length > 3 && !bare.endsWith('ss')) out.add(bare.slice(0, -1));
  if (bare.endsWith('ed') && bare.length > 4) out.add(bare.slice(0, -2));
  if (bare.endsWith('ing') && bare.length > 5) out.add(bare.slice(0, -3));
  if (bare.endsWith('d') && bare.length > 3) out.add(bare.slice(0, -1));
  return out;
}

/**
 * Ordinary-word precision guard (see header). True when the span is an
 * ordinary dictionary word, an inflected/soft form of one, or a listed
 * exemption. Only ever converts would-be engine flags to clean.
 */
function isOrdinaryWord(bare) {
  for (const form of stemForms(bare)) {
    if (isCommonWord(form, 'en')) return true;
    if (SOFT_SET.has(form)) return true;
    if (SUPPLEMENT.has(form)) return true;
    if (LEGACY_WHITELIST.has(form)) return true;
  }
  return false;
}

function isSepToken(t) {
  return t.type === 'punct' && [...t.text].every((ch) => MERGE_SEPS.has(ch));
}

function isLeetToken(t) {
  return t.type === 'punct' && [...t.text].every((ch) => LEET_PUNCT.has(ch));
}

/**
 * `$` folds to `s` (unambiguous leet, same as `5`->`s`) but the library
 * tokenizer only glues it inside a word token when it sits between letters
 * ("ca$h"); a leading or inter-word `$` ("$lut", "pu$$y") arrives as a
 * separate punct token. Strict-mode span building must join it explicitly,
 * or the evasion is missed entirely (OLD folded `$`->`s` globally before
 * matching, so `$lut`/`$$lut`/`pu$$y`/`PU$$Y` all flagged). `$` is
 * letter-like: it may LEAD a span and is never trimmed at span edges
 * (unlike separators). `@` deliberately keeps the old split behavior
 * ("@ss" -> span "ss", "@" untouched).
 */
function isDollarToken(t) {
  return t.type === 'punct' && [...t.text].every((ch) => ch === '$');
}

/**
 * Invisible format characters (Cf) the library tokenizer glues inside word
 * tokens (spaCy keeps them in words). At span edges they must not count
 * toward maskSpan's keep-first/last budget, or they shift the mask window
 * ("<ZWSP>fuck" -> "<ZWSP>f∗ck" instead of "<ZWSP>f∗∗k"). Trimmed here so
 * masking agrees with legacy maskSpan semantics; detection is unaffected
 * (bareForm already strips them via NON_ALNUM_RE).
 */
const INVISIBLE_EDGE_START_RE = /^[\u200b\u200c\u200d\u2060\ufeff\u00ad]+/;
const INVISIBLE_EDGE_END_RE = /[\u200b\u200c\u200d\u2060\ufeff\u00ad]+$/;

/** Punct tokens made solely of combining marks (zalgo): they glue word
 *  tokens together in buildSpans; the analyzed form strips them. */
const MN_RE = /\p{Mn}/u;
function isMnToken(t) {
  return t.type === 'punct' && t.text.length > 0 && [...t.text].every((ch) => MN_RE.test(ch));
}

/**
 * Gap-glue predicate (C3/C4/C5/C7/C10): word spans separated ONLY by glue
 * characters rejoin into one detection span in buildSpans' post-hoc pass.
 * Glue = the legacy separator set, any Unicode punctuation (Po/Pd/Ps/Pe),
 * math/currency symbols (Sm/Sc), other symbols (So, incl. BMP pictographs
 * like ✈♥☠★), combining marks (Me/Mc/Mn: zalgo), Extended_Pictographic
 * (emoji, any plane — fix C), backtick, ZWJ/ZWNJ, or whitespace other than
 * the ASCII space (tabs, newlines, NBSP, U+2028/2029, ...). The ASCII space
 * is deliberately NOT glue (it would fuse "fuck your ass" into one
 * over-masked span); "@" is not glue either ("@ss" keeps its documented
 * split).
 */
const GLUE_PUNCT_RE = /[\p{Po}\p{Pd}\p{Ps}\p{Pe}\p{Sm}\p{Sc}\p{So}\p{Me}\p{Mc}\p{Mn}\p{Extended_Pictographic}`]/u;
function isGlueChar(ch) {
  if (ch === '@' || ch === ' ') return false;
  if (MERGE_SEPS.has(ch)) return true;
  if (ch === '\u200d' || ch === '\u200c') return true; // ZWJ / ZWNJ
  if (/\s/u.test(ch)) return true; // Zs/Zl/Zp (excl. ASCII space), \t\n\r...
  return GLUE_PUNCT_RE.test(ch);
}

/**
 * Single-char confusable folds (non-decomposable homoglyphs). Applied in
 * analyzedForm AFTER NFKD, so NFKD already handled everything decomposable
 * (accents, fullwidth, ſ->s, ᵘ->u). Each entry is an unambiguous visual
 * lookalike of one ASCII letter (Cyrillic/Greek/Cherokee); accented Latin
 * never appears here. Small and curated on purpose: the fuzzy analysis plus
 * the C2 non-ASCII-letter evasion signal catch the rest.
 */
const CONFUSABLES = {
  а: 'a', А: 'A', // CYRILLIC A
  ɑ: 'a', // LATIN ALPHA
  е: 'e', Е: 'E', // CYRILLIC IE
  о: 'o', О: 'O', // CYRILLIC O
  ο: 'o', Ο: 'O', // GREEK OMICRON
  с: 'c', С: 'C', // CYRILLIC ES
  υ: 'u', Υ: 'U', // GREEK UPSILON
  і: 'i', І: 'I', // CYRILLIC BYELORUSSIAN-UKRAINIAN I
  // NOTE: LATIN DOTLESS I (ı U+0131) is deliberately NOT folded. Folding
  // it would turn the fuzzy-catchable "fıck" into the non-word "fick" and
  // destroy the signal; left unfolded, the deep analysis bridges ı/i and
  // the C2 non-ASCII-letter evasion check trusts that verdict. (ι→i is
  // kept: it folds onto real words, "bιtch"->"bitch" exact.)
  ι: 'i', Ι: 'I', // GREEK IOTA
  Ꭰ: 'd', // CHEROKEE A (D-lookalike)
  р: 'p', Р: 'P', // CYRILLIC ER (p-lookalike)
  ρ: 'p', Ρ: 'P', // GREEK RHO
  х: 'x', Х: 'X', // CYRILLIC HA (x-lookalike)
  χ: 'x', Χ: 'X', // GREEK CHI
  у: 'y', У: 'Y', // CYRILLIC U (y-lookalike)
  η: 'n', Η: 'N', // GREEK ETA (n-lookalike)
  κ: 'k', Κ: 'K', // GREEK KAPPA
  τ: 't', Τ: 'T', // GREEK TAU
  ν: 'v', Ν: 'V', // GREEK NU (v-lookalike)
  ϳ: 'j', Ј: 'J', // CYRILLIC JE
  // M5 (2026-09-21): high-value twins the two-substitution fuzzing caught.
  // Each is an unambiguous visual lookalike of one ASCII letter; the fuzzy
  // threshold is NOT lowered (precision cost), the table is extended.
  в: 'b', В: 'B', // CYRILLIC VE (b-lookalike)
  т: 't', Т: 'T', // CYRILLIC TE (t-lookalike)
  ѕ: 's', Ѕ: 'S', // CYRILLIC DZE (s-lookalike)
  ս: 'u', Ս: 'U', // ARMENIAN SEH (u-lookalike)
  ϲ: 'c', Ϲ: 'C', // GREEK LUNATE SIGMA (c-lookalike)
  һ: 'h', Һ: 'H', // CYRILLIC SHHA (h-lookalike)
  ш: 'w', Ш: 'W', // CYRILLIC SHA (w-lookalike)
  ч: 'y', Ч: 'Y', // CYRILLIC CHE (y-lookalike)
  п: 'n', П: 'N', // CYRILLIC PE (n-lookalike)
  м: 'm', М: 'M', // CYRILLIC EM (m-lookalike)
  ε: 'e', Ε: 'E', // GREEK EPSILON (e-lookalike)
  ς: 's', // GREEK FINAL SIGMA (s-lookalike; M1: "aςs" -> "ass")
};

// Invisible format controls stripped from the analyzed form. They never
// carry lexical content (ZWJ/ZWNJ strip via isGlueChar instead).
const INVISIBLE_CF_RE = /[\u200b\u2060\ufeff\u00ad\u202a-\u202e\u2066-\u2069]/u;

/** Bidi override controls: when the span text carries these, scanHard also
 *  exact-checks the reversed bare form (C8: "‮kcuf" renders as "fuck"). */
const BIDI_RE = /[\u202a-\u202e\u2066-\u2069]/u;

/**
 * Detection form of a span: NFKD-normalized (C1: full-width "ｆｕｃｋ" ->
 * "fuck" still folds, and accented "bîtch" decomposes to base+mark so the
 * mark-strip below yields "bitch"), gap-glue characters stripped (emoji,
 * BMP pictographs, exotic spaces, ZWJ/ZWNJ, ...), invisible Cf controls
 * stripped, single-char confusable homoglyphs folded, combining marks
 * removed (zalgo). Preserved: MERGE_SEPS (the fuzzy key path: "f.u.c.k"
 * keeps its dots), the ASCII space (C6 space-joins), and FOLD punctuation
 * ("$lut" keeps "$"->"s", "sh!t" keeps "!"->"i"). Pure ASCII spans return
 * unchanged (fast path; also keeps every existing span byte-identical).
 * Original offsets are untouched: masking in profanity.js still slices
 * span.start/span.end on the original text.
 */
function analyzedForm(spanText, folds = CONFUSABLES) {
  if (!/[^\x00-\x7F]/u.test(spanText)) return spanText;
  const out = [];
  // Per ORIGINAL character: a non-ASCII char whose NFKD is a single ASCII
  // FOLD punctuation (fullwidth "！" -> "!") is a foreign separator, not a
  // leet letter — strip it (B10: "f！u！c！k" -> "fuck" exact). The ASCII
  // original keeps its FOLD mapping ("b!tch" -> "bitch" still flags), and
  // fullwidth MERGE_SEPS ("．" -> ".") stay separators via the branch below.
  for (const ch of spanText) {
    // The fold table maps the character AS WRITTEN: NFKD can destroy the
    // visual identity the fold is built on ("ϲ" U+03F2 decomposes to "ς"
    // U+03C2, which would then mis-fold to 's' instead of 'c').
    if (folds[ch]) {
      out.push(folds[ch]);
      continue;
    }
    const nfkd = ch.normalize('NFKD');
    if (
      ch !== nfkd &&
      nfkd.length === 1 && nfkd.charCodeAt(0) < 128 &&
      FOLD[nfkd] &&
      !MERGE_SEPS.has(nfkd)
    ) {
      continue;
    }
    for (const c of nfkd) {
      if (MERGE_SEPS.has(c) || c === ' ' || FOLD[c]) {
        out.push(c);
        continue;
      }
      if (isGlueChar(c) || INVISIBLE_CF_RE.test(c)) continue;
      out.push(folds[c] ?? c);
    }
  }
  return out.join('').replace(/\p{Mn}/gu, '');
}

/**
 * M1 residual: ambiguous lookalikes with no single unambiguous fold. The
 * lunate sigma (ϲ U+03F2) reads as 'c' in most fonts (CONFUSABLES maps it
 * there: "ϲսnt" -> "cunt") but as 's' in others ("aϲs" reads as "ass").
 * Tried as an exact-only variant in scanHard: the alternative-folded bare
 * must EXACTLY hit the tier dictionary (or the minor soft set), so
 * innocent words can never flag here. Precedent: hasLeetVariantHit's
 * exact-only v->u / bracket->c variants.
 */
const AMBIGUOUS_FOLDS = { ϲ: 's', Ϲ: 'S' };
const ALT_FOLDS = { ...CONFUSABLES, ...AMBIGUOUS_FOLDS };
const AMBIGUOUS_RE = /[ϲϹ]/;

/**
 * M3: enclosed alphanumerics (ⓕⓤⓒⓚ, ①②, ...) are So punct to the
 * tokenizer, so no word spans ever form and NFKD never runs on them.
 * Map the U+2460–U+24FF block 1:1 to ASCII BEFORE tokenizing. Every char
 * in the block is one BMP code point; only single-ASCII-char NFKD
 * decompositions are mapped (⑳ -> "20" is left alone), so the output is
 * exactly one UTF-16 unit per input unit and every span offset still
 * indexes the original text.
 */
function foldEnclosed(text) {
  if (!/[\u2460-\u24ff]/.test(text)) return text;
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x2460 && cp <= 0x24ff) {
      const d = ch.normalize('NFKD');
      out += d.length === 1 && d.charCodeAt(0) < 128 ? d : ch;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * M4: regional indicators (🇫🇺🇨🇰 renders as "FUCK") are
 * Extended_Pictographic to the tokenizer and NFKD-identity, so they are
 * invisible to detection. Map each RI (one surrogate pair = 2 UTF-16
 * units) to its ASCII letter + ZWSP (also 2 units): the letter makes it a
 * word char, the ZWSP is already in the engine's word-char class, and
 * offsets into the original text are preserved. Real flags (🇫🇷 -> "fr")
 * never form dictionary words, so they stay clean.
 */
function foldRegionalIndicators(text) {
  if (!/[\u{1f1e6}-\u{1f1ff}]/u.test(text)) return text;
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x1f1e6 && cp <= 0x1f1ff) {
      out += String.fromCharCode(0x61 + cp - 0x1f1e6) + '​';
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Maximal runs of word tokens joined by separator punctuation. In extended
 * (soft-scan) mode leet punctuation also joins, and a leading leet-punct
 * token may start a run ("@ss"); it never does in strict mode (except `$`,
 * see isDollarToken).
 */
export function buildSpans(text, extended = false) {
  const spans = [];
  let toks = [];
  // M3/M4: fold enclosed alphanumerics and regional indicators to ASCII
  // for TOKENIZING only. Both folds preserve UTF-16 length, so offsets
  // index the original text; span.text/span.start/span.end always slice
  // the ORIGINAL (for masking), while span.analyzed is computed on the
  // folded slice (for detection).
  const scanText = foldRegionalIndicators(foldEnclosed(text));
  const joiner = (t) =>
    t.type === 'punct' &&
    [...t.text].every((ch) => MERGE_SEPS.has(ch) || ch === '$' || (extended && LEET_PUNCT.has(ch)));
  const flush = () => {
    let a = 0;
    let b = toks.length;
    while (a < b && isSepToken(toks[a])) a++;
    while (b > a && isSepToken(toks[b - 1])) b--;
    if (extended) {
      while (b > a && isLeetToken(toks[b - 1])) b--;
    }
    if (a < b && toks.slice(a, b).some((t) => t.type === 'word')) {
      let start = toks[a].start;
      let end = toks[b - 1].end;
      let spanText = text.slice(start, end);
      const lead = (spanText.match(INVISIBLE_EDGE_START_RE) || [''])[0].length;
      if (lead) {
        spanText = spanText.slice(lead);
        start += lead;
      }
      if (spanText) {
        const trail = (spanText.match(INVISIBLE_EDGE_END_RE) || [''])[0].length;
        if (trail) {
          spanText = spanText.slice(0, spanText.length - trail);
          end -= trail;
        }
      }
      if (spanText) spans.push({ start, end, text: spanText, analyzed: analyzedForm(scanText.slice(start, end)) });
    }
    toks = [];
  };
  for (const t of tokenize(scanText)) {
    if (t.type === 'word') {
      toks.push(t);
    } else if (joiner(t) && (toks.length > 0 || (extended && isLeetToken(t)) || isDollarToken(t))) {
      toks.push(t);
    } else if (isMnToken(t) && toks.length > 0) {
      // Combining marks bridge word tokens (zalgo "f\u0301u\u0327c\u0302k\u0308"):
      // they can only continue a run, never start one, so stray marks alone
      // still flush. analyzedForm strips them for detection.
      toks.push(t);
    } else {
      flush();
    }
  }
  flush();
  // Re-glue word spans split only by glue characters (C3/C4/C5/C7/C10):
  // "f😀uck", "f✈uck" and "f․u․c․k" tokenize as word/punct/word. The gap
  // must be non-empty and consist solely of glue chars (isGlueChar), so
  // emoji-only messages and emoji between real words (spaces or "@" in the
  // gap) are unaffected. span.start/end keep original UTF-16 offsets for
  // masking; analyzed is recomputed on the joined text.
  const glued = [];
  for (const s of spans) {
    const prev = glued[glued.length - 1];
    if (prev) {
      const gap = text.slice(prev.end, s.start);
      if (gap && [...gap].every(isGlueChar)) {
        prev.end = s.end;
        prev.text = text.slice(prev.start, prev.end);
        prev.analyzed = analyzedForm(scanText.slice(prev.start, prev.end));
        continue;
      }
    }
    glued.push(s);
  }
  return glued;
}

/** Collapse runs of 3+ identical letters to `to` copies ("stoppp"->"stop",
 *  "boooob"->"boob"). Used to recognize elongated emphasis. */
function collapseRepeats(bare, to) {
  return bare.replace(/(.)\1{2,}/g, `$1`.repeat(to));
}

/**
 * Exact/lemma (non-fuzzy) evidence that `bare` is profane: a dictionary hit
 * on the bare form itself or a stem/lemma of it. Trusted unconditionally
 * in scanHard: exact slurs flag in any casing ("Cock", "DICK", "Cumming"),
 * matching OLD. `set` is the tier-appropriate dictionary (full WORDS in
 * minor chats, HARD_TIER in adult chats, MIXED_SENSITIVE for the adult
 * mixed pass).
 */
function hasExactOrLemmaHit(bare, set) {
  if (set.has(bare)) return true;
  for (const lemma of stemCandidates(bare)) {
    if (set.has(lemma)) return true;
  }
  return false;
}

/**
 * Substring-only evidence: a 3+ letter dictionary word embedded as a
 * substring of `bare` (the whole-string match counts, so exact mixed
 * entries are found here too). Weaker evidence — capitalized proper nouns
 * collide constantly ("cum" in "Cumana", "tit" in "Titz", "cock" in
 * "Cockburn", "fag" in "Fagatogo", "fuk" in "Fukushima") — so scanHard
 * applies a proper-noun guard before trusting it.
 */
function hasSubstringOnlyHit(bare, set) {
  // Inner loop bounded at the longest dictionary entry (23 chars): a longer
  // substring can never be a dictionary word, so the bound is exact and
  // keeps long-span substring scans cheap (fix A calls this on full spans).
  for (let i = 0; i < bare.length; i++) {
    for (let j = i + 3; j <= bare.length && j <= i + 23; j++) {
      if (set.has(bare.slice(i, j))) return true;
    }
  }
  return false;
}

/**
 * Doubled-letter variant expansion. OLD's per-letter `{1,3}` classes match
 * 1-3 repeats, so "fuuk" matched "fuk", "cuunt" matched "cunt", "whorre"
 * matched "whore", "faag" matched "fag". NEW's collapseRepeats only fires
 * on runs of 3+, and the fuzzy analysis does not bridge exactly-doubled
 * letters. For spans with runs of exactly 2 identical letters, generate
 * every variant with each 2-run collapsed to 1 copy (2^k combinations,
 * capped at k=4 runs; more runs than that fall through to the engine) and
 * flag on EXACT dictionary membership only — no fuzzy on variants, so
 * innocent doubled-letter words ("letter"->"leter", "hello"->"helo") can
 * never flag here. Runs after the ordinary-word guard, so ordinary words
 * never reach it anyway. `set` is the tier-appropriate dictionary.
 */
function hasDoubledVariantHit(bare, set) {
  const runs = [];
  for (let i = 0; i < bare.length;) {
    let j = i + 1;
    while (j < bare.length && bare[j] === bare[i]) j++;
    if (j - i === 2) runs.push(i);
    i = j;
  }
  if (!runs.length || runs.length > 4) return false;
  const n = 1 << runs.length;
  for (let mask = 0; mask < n; mask++) {
    let v = '';
    let prev = 0;
    for (let r = 0; r < runs.length; r++) {
      const at = runs[r];
      v += bare.slice(prev, at);
      v += (mask & (1 << r)) ? bare[at] : bare.slice(at, at + 2);
      prev = at + 2;
    }
    v += bare.slice(prev);
    if (set.has(v)) return true;
  }
  return false;
}

/**
 * v->u / bracket->c leet variant expansion. FOLD deliberately omits these
 * substitutions (they corrupt ordinary words: "gave"->"gaue", "(ok"->"cok"),
 * and the fuzzy analysis does not bridge them ("fvck", "(ock" sail through).
 * Try the substitutions as explicit variants, but accept ONLY exact
 * dictionary hits — the hasDoubledVariantHit precedent — so innocent words
 * can never flag here. Substitution variants are also run through the
 * doubled-letter collapse and the plain repeat collapses (fix B:
 * "fvvvck"->"fuuuck"->"fuck", the way legacy's {1,3} classes matched it);
 * still exact-hit-only. `set` is the tier-appropriate dictionary, so a
 * sensitive fold ("fvck"->"fuck") still passes untouched in adult chats.
 *
 * A bracket directly before the span is reattached and folded to "c"
 * (fix D: "(", "<", "[", "{" — legacy folded all four). The tokenizer
 * splits it off the span, so it is reattached from the text just before the
 * span start (adjacent only). Accepted narrow change: a word char directly
 * before the bracket ("X(ock") now glues the bracket away in buildSpans
 * instead of reattaching it.
 */
const BRACKET_LEET = new Set(['(', '<', '[', '{']);
function hasLeetVariantHit(text, span, set) {
  const prevCh = span.start > 0 ? text[span.start - 1] : '';
  const raw =
    (BRACKET_LEET.has(prevCh) ? prevCh : '') +
    foldLower(span.analyzed ?? span.text);
  const positions = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 'v' || BRACKET_LEET.has(raw[i])) positions.push(i);
  }
  // More substitution sites than the doubled fix allows fall through to the
  // engine, the same as over-long doubled runs do.
  if (!positions.length || positions.length > 4) return false;
  const n = 1 << positions.length;
  for (let mask = 1; mask < n; mask++) {
    // mask 0 is the already-checked bare form; every other combination of
    // v->u / bracket->c substitutions is tried, each with doubled-letter
    // and repeat collapse. Exact dictionary membership only.
    const chars = [...raw];
    for (let p = 0; p < positions.length; p++) {
      if (mask & (1 << p)) chars[positions[p]] = raw[positions[p]] === 'v' ? 'u' : 'c';
    }
    const candidate = chars.join('').replace(NON_ALNUM_RE, '');
    if (!candidate) continue;
    if (
      set.has(candidate) ||
      set.has(collapseRepeats(candidate, 1)) ||
      set.has(collapseRepeats(candidate, 2)) ||
      hasDoubledVariantHit(candidate, set)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the span looks like an evasion attempt (C2). The engine's fuzzy
 * verdicts are trusted on evasion-shaped spans ("f*ck"); on plain words
 * only solid evidence flags (otherwise "stoppp" would strike for fuzzy
 * "pcp"). Each signal is checked on the form where it is visible:
 *   - ASCII separators/digits/leet on the ORIGINAL span text ("f*ck" —
 *     pre-strip, so "f😀*ck" still shows its "*");
 *   - 3+ repeated letters on the bare form ("boooob");
 *   - pictographs in the original span text, any plane (fix C: BMP "✈♥☠★"
 *     as well as astral emoji — "f😀ck" is evasion-shaped);
 *   - non-ASCII letters surviving in the analyzed form (homoglyphs like
 *     "fυck": NFKD+Mn-strip already folded genuine accents, so whatever
 *     remains is a lookalike, not an accent);
 *   - gap-glue characters inside the span text (ZWJ, exotic spaces, ...):
 *     the span only exists because buildSpans re-glued across them.
 */
function evasionShaped(span, analyzed, bare) {
  const text = span.text;
  if (/[.,_*~^\-@!|$+0-9]/.test(text)) return true;
  if (/(.)\1\1/.test(bare)) return true;
  if (/\p{Extended_Pictographic}/u.test(text)) return true;
  if (/(?=[^\x00-\x7F])\p{L}/u.test(analyzed)) return true;
  return [...text].some(isGlueChar);
}

/**
 * BUG1: a glue picto must not manufacture suspicion by itself. The cycle-2
 * glue pass rejoins spans across emoji ("happy😊birthday" -> one span),
 * and the picto then counted as evasion evidence, so the library's fuzzy
 * verdict — aggressive on long concatenations ("happybirthday",
 * "thankyou", "rockon" all read profane to it) — was trusted. This is the
 * same signal set as evasionShaped with glue pictographs stripped: when
 * the span is evasion-shaped ONLY via pictographs, the fuzzy verdict is
 * corroborated with a tight edit-distance check on the de-glued form
 * ("fck" is 1 edit from "fuck" -> still flags; "happybirthday" is far
 * from every dict word -> clean).
 */
function evasionShapedIgnoringPicto(span, analyzed, bare) {
  const text = span.text.replace(/\p{Extended_Pictographic}/gu, '');
  if (/[.,_*~^\-@!|$+0-9]/.test(text)) return true;
  if (/(.)\1\1/.test(bare)) return true;
  if (/(?=[^\x00-\x7F])\p{L}/u.test(analyzed)) return true;
  return [...text].some(isGlueChar);
}

/** Bounded Levenshtein (code-point safe) for the BUG1 corroboration. */
function levenshtein(a, b) {
  const as = [...a];
  const bs = [...b];
  if (!as.length) return bs.length;
  if (!bs.length) return as.length;
  let prev = new Array(bs.length + 1);
  let cur = new Array(bs.length + 1);
  for (let j = 0; j <= bs.length; j++) prev[j] = j;
  for (let i = 1; i <= as.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= bs.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (as[i - 1] === bs[j - 1] ? 0 : 1),
      );
    }
    [prev, cur] = [cur, prev];
  }
  return prev[bs.length];
}

/**
 * BUG1 corroboration: is `bare` within the engine's relative fuzzy
 * threshold of any tier-dict word, by direct edit distance? Only consulted
 * for picto-only evasion-shaped spans (rare), so the 719-word scan is off
 * the hot path.
 */
function nearDictWord(bare, dict) {
  const maxRel = FILTER_OPTS_DEEP.maxRelativeDistance;
  for (const w of dict) {
    const denom = Math.max(bare.length, w.length);
    if (Math.abs(bare.length - w.length) / denom > maxRel) continue;
    if (levenshtein(bare, w) / denom <= maxRel) return true;
  }
  return false;
}

/** Per-word verdict cache: avoids re-running the trie on repeated words. */
const verdictCache = new Map();
const VERDICT_CACHE_CAP = 5000;

function cachedVerdict(key, compute) {
  const hit = verdictCache.get(key);
  if (hit !== undefined) return hit;
  const value = compute();
  verdictCache.set(key, value);
  if (verdictCache.size > VERDICT_CACHE_CAP) {
    verdictCache.delete(verdictCache.keys().next().value);
  }
  return value;
}

/**
 * DoS guard for the deep fuzzy analysis below. The library's deep analysis
 * enumerates O(n^2) substrings of its input and runs a Levenshtein-automaton
 * intersection per distinct substring, so its cost explodes with span length:
 * a 200-char unspaced span costs ~20-35s and freezes the single-threaded
 * event loop (relay slices messages at 2000 chars, which does not help).
 * Spans longer than FUZZY_SPAN_CAP feed only their leading window to the
 * fuzzy analysis; exact/simple evidence (exact, doubled-letter, leet and
 * substring matches, the proper-noun guard) still runs on the full span, and
 * spans at or under the cap are byte-identical to before.
 */
const FUZZY_SPAN_CAP = 12;

/**
 * M2: the inter-span gap may be ASCII spaces mixed with invisible format
 * chars ("f \u200Bu\u200Bc\u200Bk"). Pure-invisible gaps never occur
 * between spans (the tokenizer glues Cf inside word tokens), so at least
 * one ASCII space is required; the merge itself stays exact-only.
 */
const SPACE_GAP_RE = /^(?=.* )[ \u200b\u200c\u200d\u2060\ufeff\u00ad]+$/;

/**
 * C6: space-separated evasions ("f u c k", "bi tch"). The ASCII space is
 * deliberately NOT a general glue char (tests pin "fuck your ass" -> 2
 * hits with the space unmasked), so this runs as an exact-only pre-pass
 * over the built spans: maximal runs of spans joined solely by SPACE_GAP_RE;
 * at each position the LONGEST subrun whose concatenated bare form is an
 * exact tier-dict hit becomes one merged span (masking then covers the
 * spaces: "f u c k" -> "f ∗∗∗ k"). Exact-only — never fuzzy — so innocent
 * word sequences can never fuse ("hello world" stays two spans). "f\nck"
 * (D4) is handled by the general gap glue instead (newline is glue).
 *
 * BUG2: the merge trigger also covers the sensitive-soft words ("a s s",
 * "b u t t" in minor chats): they flag standalone via scanHard's
 * SENSITIVE_SOFT_SET branch but are regex-tier, not WORDS_SET, so the
 * dict-only trigger missed them. BUG3: the never-fuse early-out below is
 * extended to those same words, so "ass fuck" and "fuck ass" both yield 2
 * hits (order-independent); "fuck me" keeps its unmerged shape.
 */
function mergeSpaceEvasions(text, spans, dict, adultChat = false) {
  const scanText = foldRegionalIndicators(foldEnclosed(text));
  const out = [];
  let i = 0;
  while (i < spans.length) {
    let j = i;
    while (
      j + 1 < spans.length &&
      SPACE_GAP_RE.test(text.slice(spans[j].end, spans[j + 1].start))
    ) {
      j++;
    }
    const run = spans.slice(i, j + 1);
    if (run.length === 1) {
      out.push(run[0]);
    } else {
      const bares = run.map((sp) => bareForm(sp.analyzed ?? sp.text));
      const bareLens = bares.map((b) => b.length);
      let s = 0;
      while (s < run.length) {
        // A span that is already an exact dictionary hit on its own is
        // never fused with its neighbours ("fuck me" keeps the live
        // "f∗∗k me" shape; only genuinely split words rejoin). BUG3: in
        // minor chats a standalone sensitive-soft word ("ass") is also a
        // hit on its own via scanHard's soft branch, so it early-outs too.
        const standalone =
          dict.has(bares[s]) || (!adultChat && SENSITIVE_SOFT_SET.has(bares[s]));
        if (standalone) {
          out.push(run[s]);
          s++;
          continue;
        }
        // Longest-first subrun search, bounded: a dictionary word is at
        // most 23 chars, so a concatenation longer than that can never hit
        // (keeps a 2000-char spaced message linear instead of cubic).
        let maxLen = 1;
        let acc = 0;
        while (s + maxLen <= run.length && maxLen <= 24) {
          acc += bareLens[s + maxLen - 1];
          if (acc > 23) break;
          maxLen++;
        }
        maxLen--;
        let hitLen = 0;
        for (let len = Math.min(maxLen, run.length - s); len > 1; len--) {
          const concat = bares.slice(s, s + len).join('');
          // BUG2: the trigger covers sensitive-soft words in minor chats.
          if (dict.has(concat) || (!adultChat && SENSITIVE_SOFT_SET.has(concat))) {
            hitLen = len;
            break;
          }
        }
        if (hitLen > 1) {
          const first = run[s];
          const last = run[s + hitLen - 1];
          const slice = text.slice(first.start, last.end);
          out.push({
            start: first.start,
            end: last.end,
            text: slice,
            analyzed: analyzedForm(scanText.slice(first.start, last.end)),
          });
          s += hitLen;
        } else {
          out.push(run[s]);
          s++;
        }
      }
    }
    i = j + 1;
  }
  return out;
}

/**
 * Hard scan: returns flagged spans { start, end, text, compound, mixed }.
 * `compound` marks spans eligible for component-wise masking (their bare
 * form contains a sensitive or mild root, e.g. "assfuck"); profanity.js
 * applies tier-aware maskCompoundSpan to those (which fails safe to a full
 * mask when no flaggable component is identifiable). `mixed` marks spans
 * the adult mixed pass attributed to a MIXED_SENSITIVE entry (e.g.
 * "shitdick" in an adult chat); the adapter masks only the hard component
 * there.
 *
 * Tiering (options.adultChat, default false = minor, fail-safe):
 *   - minor: the full WORDS dictionary (603 hard + 116 sensitive) scans as
 *     one tier, exactly like the old filter; only the 31 MILD words keep
 *     the isolation exemption.
 *   - adult: HARD_TIER (603) scans; the 116 SENSITIVE words are skipped
 *     entirely EXCEPT the 16 MIXED_SENSITIVE entries carrying a genuine
 *     hard component, which flag with compound=true so only the hard
 *     component is masked. All 36 soft words keep the isolation exemption.
 */
export function scanHard(text, options = {}) {
  const adultChat = options?.adultChat === true;
  // Tier-appropriate dictionary and engine instance. The verdict cache key
  // is tier-prefixed: the same span can be profane in a minor chat and
  // clean in an adult one.
  const dict = adultChat ? HARD_TIER_SET : WORDS_SET;
  const inst = adultChat ? hardFilterAdult : hardFilter;
  const isoExempt = adultChat ? SOFT_SET : MILD_SET;
  const pfx = adultChat ? 'a:' : 'm:';
  const hits = [];
  // C6 space-evasion pre-pass runs on the built spans (exact-only merges).
  const spans = mergeSpaceEvasions(text, buildSpans(text, false), dict, adultChat);
  for (const span of spans) {
    // analyzed: the detection form (emoji stripped, NFKC, combining marks
    // removed). span.text keeps the original for offsets, the proper-noun
    // case guard, and masking.
    const analyzed = span.analyzed ?? span.text;
    const bare = bareForm(analyzed);
    if (!bare) continue;
    // Soft-word isolation: mild words (both tiers) / all soft words
    // (adult chats) pass untouched in isolation.
    if (isoExempt.has(bare)) continue;
    // Minor-chat compound gap: a sensitive-word + hard-word concatenation
    // ("fuckbitch") masks per component via maskCompoundSpan; the root check
    // misses it. Adult chats are excluded — mixed entries are already forced
    // compound by the mixed pass below, and other adult spans keep their
    // existing masks.
    const compound =
      hasCompoundRoot(bare) || (!adultChat && isSensitiveHardCompound(bare));
    if (dict.has(bare)) {
      hits.push({ ...span, compound });
      continue;
    }
    // Ambiguous-lookalike variants (M1 residual): re-fold the original
    // span text with the ambiguous mapping winning, exact hits only.
    if (AMBIGUOUS_RE.test(span.text)) {
      const altBare = bareForm(analyzedForm(span.text, ALT_FOLDS));
      if (altBare !== bare) {
        if (dict.has(altBare)) {
          hits.push({ ...span, compound });
          continue;
        }
        if (!adultChat && SENSITIVE_SOFT_SET.has(altBare)) {
          hits.push({ ...span, compound: false });
          continue;
        }
      }
    }
    // C8: bidi override ("‮kcuf" renders as "fuck"): when the span text
    // carries bidi controls, also exact-check the reversed bare form
    // against the tier dictionary.
    if (BIDI_RE.test(span.text)) {
      const reversed = [...bare].reverse().join('');
      if (reversed !== bare && dict.has(reversed)) {
        hits.push({ ...span, compound });
        continue;
      }
    }
    // Minor chats: sensitive-soft words ("ass") flag standalone. The regex
    // soft scan in profanity.js catches the plain/leet forms; this branch
    // catches the confusable-homoglyph forms ("аss" -> analyzed "ass") the
    // fold produces. Non-compound, so masking stays maskSpan-identical to
    // the regex path; longest-wins dedups against the regex hit.
    if (!adultChat && SENSITIVE_SOFT_SET.has(bare)) {
      hits.push({ ...span, compound: false });
      continue;
    }
    // Elongated emphasis of a hard word ("boooob" -> "boob", "fuuuck" -> "fuk").
    const c1 = collapseRepeats(bare, 1);
    const c2 = collapseRepeats(bare, 2);
    if (c1 !== bare && (dict.has(c1) || dict.has(c2))) {
      hits.push({ ...span, compound });
      continue;
    }
    // Ordinary words (and elongated ordinary words: "stoppp" -> "stop") are
    // never profanity, no matter what the fuzzy analysis guesses.
    // M1: the guard's vocabulary is ASCII-only by construction. When the
    // analyzed span contains non-ASCII letters, its bare form is a
    // deletion-mangled remnant ("вitch" -> "itch"), so the guard must not
    // judge it — skip the guard and let the fuzzy engine (trusted via the
    // C2 evasion signal the surviving letters provide) decide. Pure-ASCII
    // spans behave byte-identically to before.
    const asciiOnlySpan = !/(?=[^\x00-\x7F])\p{L}/u.test(analyzed);
    if (asciiOnlySpan && (isOrdinaryWord(bare) || (c1 !== bare && isOrdinaryWord(c1)))) continue;
    // Doubled-letter evasions ("fuuk" -> "fuk", "cuunt" -> "cunt"): OLD's
    // {1,3} letter classes matched these; the 3+-collapse above and the
    // fuzzy analysis both miss them. Exact dictionary membership only.
    if (hasDoubledVariantHit(bare, dict)) {
      hits.push({ ...span, compound });
      continue;
    }
    // v->u / (->c leet variants ("fvck" -> "fuck", "(ock" -> "cock"):
    // exact-dictionary-only, so innocent words can never flag here. Runs on
    // the tier dictionary, so sensitive folds stay clean in adult chats.
    if (hasLeetVariantHit(text, span, dict)) {
      hits.push({ ...span, compound });
      continue;
    }
    // Adult-only mixed pass: sensitive entries carrying a genuine hard
    // component still flag, with compound=true so only the hard component
    // is masked, and mixed=true so the masking adapter knows to censor the
    // hard component only (mirrors the live filter's MIXED_SENSITIVE word
    // check at mask time). Runs before the fuzzy verdict so a mixed word
    // the fuzzy analysis also sees is attributed correctly.
    if (adultChat) {
      if (MIXED_SENSITIVE.has(bare)) {
        hits.push({ ...span, compound: true, mixed: true });
        continue;
      }
      if (c1 !== bare && (MIXED_SENSITIVE.has(c1) || MIXED_SENSITIVE.has(c2))) {
        hits.push({ ...span, compound: true, mixed: true });
        continue;
      }
      if (hasDoubledVariantHit(bare, MIXED_SENSITIVE)) {
        hits.push({ ...span, compound: true, mixed: true });
        continue;
      }
      // Pure sensitive words (non-mixed, both tiers) never flag in adult
      // chats: the fuzzy analysis below is tier-blind and would otherwise
      // bleed across tiers ("fuck" via hard "fack"). Live's per-word regexes
      // have no fuzzy component, so they stay clean there too. Mixed entries
      // were handled above and never reach this skip.
      if (SENSITIVE_SET.has(bare) || SENSITIVE_SOFT_SET.has(bare)) continue;
    }
    // NOTE on cache keying: the verdict cache below is keyed by the
    // tier-prefixed engine key of each fuzzy window, and the proper-noun
    // guard in the final branch runs OUTSIDE the cached call on the
    // original-case span text, so the cache stays correct. The fuzzy input
    // is collapsed and capped at FUZZY_SPAN_CAP code points per window (DoS
    // guard, see above); the verdict cache key follows the windowed input,
    // so it stays correct too. Fix A adds full-span substring evidence for
    // capped spans without widening the fuzzy input.
    //
    // C9: collapse 3+ letter runs BEFORE capping, so "aaaaaaaaafuck" and
    // "afuck" feed the same fuzzy input; capped spans feed their leading-12
    // AND trailing-12 windows (code-point-safe slices — fix G). The
    // trailing window catches profanity past the cap ("loremipsumd*ck").
    // Proper-noun-conservative: a span starting with an uppercase letter
    // skips the collapse AND the trailing window, so the fuzzy sees exactly
    // the pre-patch leading-12 input ("AAAAAAAAAAAAfuck" stays clean; the
    // collapse would forge "Afuck" and the trailing window would catch the
    // "fuck" the pre-patch cap hid).
    // M6: the exemption is ASCII-only. A leading non-ASCII uppercase
    // (Cyrillic "АААА...fuck") must not inherit the proper-noun pass that
    // protects "Cumana"/"Fukushima": homoglyph capitals are an evasion
    // signal, not a place name. Latin all-caps/Titlecase behavior is
    // unchanged.
    const properNounish = /^\p{Lu}/u.test(span.text) && !/[^\x00-\x7F]/.test(span.text);
    const collapsed = properNounish ? analyzed : collapseRepeats(analyzed, 1);
    const collapsedCps = [...collapsed];
    const capped = collapsedCps.length > FUZZY_SPAN_CAP;
    const fuzzyInputs = capped && !properNounish
      ? [
          collapsedCps.slice(0, FUZZY_SPAN_CAP).join(''),
          collapsedCps.slice(-FUZZY_SPAN_CAP).join(''),
        ]
      : [collapsedCps.slice(0, FUZZY_SPAN_CAP).join('')];
    // Pure-digit spans never take the fuzzy verdict: FOLD maps every digit
    // to a letter, and the deep analysis then false-positives on the folded
    // string ("987654321098765432"), mangling snowflake IDs and burning a
    // minor-chat strike per pasted ID. Only spans with no pre-fold letters
    // skip; "5h1t"/"sh1t" (real letters) keep the full pipeline.
    let profane = false;
    let profaneKey = null;
    if (/[a-z]/i.test(analyzed)) {
      for (const input of fuzzyInputs) {
        const k = engineKey(input);
        const verdict = cachedVerdict(pfx + k, () => {
          if (inst.censorWord(k).isProfane) return true;
          return adultChat && mixedFilter.censorWord(k).isProfane;
        });
        if (verdict) {
          profane = true;
          profaneKey = k;
          break;
        }
      }
    }
    // Fix A: the fuzzy verdict above only saw the capped windows; a hard
    // word past the cap ("aaaaaaaaaaaafuck") is missed. OR in full-span
    // substring evidence (proper-noun gated, so "Tittabawassee River" stays
    // clean) before giving up on the span.
    if (
      !profane &&
      capped &&
      !properNounish &&
      (hasSubstringOnlyHit(bare, dict) ||
        (adultChat && hasSubstringOnlyHit(bare, MIXED_SENSITIVE)))
    ) {
      profane = true;
    }
    if (!profane) continue;
    // The engine is sure about exact/lemma/substring matches; its fuzzy
    // guesses are only trusted on evasion-shaped spans. A plain word the
    // fuzzy analysis flags without solid evidence ("contest" via "cunts")
    // stays clean.
    //
    // Proper-noun guard: a SUBSTRING-only solid hit is not trusted when the
    // original span starts with an uppercase letter ("Cumana", "Cockburn",
    // "Fukushima", "Titz" — all collide with short hard words). The guard
    // is case-gated only here:
    //   - evasion-shaped spans always flag (proper nouns contain no
    //     @$*.0-9 or separator runs, so "F*ck" still flags);
    //   - exact/lemma hits always flag ("Cock", "DICK", "Cumming" alone
    //     still flag, matching OLD);
    //   - lowercase substring compounds keep flagging ("abcfuck",
    //     "fuckyou" — the NEW improvements over OLD).
    // Evasion analysis: an attacker smuggling profanity as a capitalized
    // substring ("Fuckyou") now passes — but OLD missed it entirely too,
    // and the lowercase form is still caught, so strict parity-or-better
    // vs OLD holds. Exact slurs in any casing still flag.
    //
    // In adult chats the evidence set also covers the mixed entries, and a
    // mixed-only hit is forced compound so maskCompoundSpan censors just
    // the hard component.
    const mixedEvidence =
      adultChat &&
      (hasExactOrLemmaHit(bare, MIXED_SENSITIVE) ||
        hasSubstringOnlyHit(bare, MIXED_SENSITIVE) ||
        hasDoubledVariantHit(bare, MIXED_SENSITIVE));
    const tierCompound = compound || !!mixedEvidence;
    // mixed marks hits the engine attributed to a MIXED_SENSITIVE entry:
    // the masking adapter censors only the hard component there (the live
    // filter's MIXED_SENSITIVE word check at mask time).
    const mixedHit = adultChat && !!mixedEvidence;
    // C2: the fuzzy verdict is only trusted on evasion-shaped spans now.
    // evasionShaped checks each signal on the form where it is visible
    // (ASCII seps/digits on the original text, 3+ runs on bare, picto or
    // glue in the original text, non-ASCII letters in analyzed).
    // BUG1: when the span is evasion-shaped ONLY via glue pictographs,
    // the picto must not manufacture suspicion by itself: corroborate
    // with nearDictWord on the de-glued form. Otherwise the C2 distrust
    // rule applies and only exact/lemma/substring evidence can flag.
    const shaped = evasionShaped(span, analyzed, bare);
    const pictoOnly =
      shaped && !evasionShapedIgnoringPicto(span, analyzed, bare);
    const trustedEvasion = shaped && (!pictoOnly || nearDictWord(bare, dict));
    if (trustedEvasion) {
      // Adult-chat fuzzy bleed: the hard verdict above is tier-blind, so an
      // evasion-shaped span it flags may be a sensitive-tier evasion ("f*ck"
      // via hard "fack"). When the span is also within the engine's fuzzy
      // threshold of a (non-mixed) sensitive word, the sensitive tier wins
      // the ambiguity and the span passes untouched in adult chats. Mixed-
      // entry evasions ("f*ckbitch") are exempt: mixedFilter owns them, so
      // they keep their adult flag. Minor chats are unaffected: sensitive
      // evasions flag+mask there either way.
      // Fix-A spans carry no fuzzy key of their own; fall back to the
      // leading-window key for the bleed guard.
      const bleedKey = profaneKey ?? engineKey(fuzzyInputs[0]);
      let mixedVerdict = false;
      if (adultChat) {
        mixedVerdict = cachedVerdict('mx:' + bleedKey, () =>
          mixedFilter.censorWord(bleedKey).isProfane,
        );
        if (
          !mixedVerdict &&
          cachedVerdict('s:' + bleedKey, () => sensitiveFilter.censorWord(bleedKey).isProfane)
        ) {
          continue;
        }
      }
      // Fix F: an adult mixed entry ("f*ckbitch") is a compound hit even
      // when the verdict came from the evasion branch: only the hard
      // component is masked ("f*ckbi∗ch"), the sensitive part stays
      // readable. The minor-chat path below is untouched.
      const isMixedCompound = adultChat && mixedVerdict;
      hits.push({
        ...span,
        compound: tierCompound || isMixedCompound,
        mixed: mixedHit || isMixedCompound,
      });
    } else if (hasExactOrLemmaHit(bare, dict) || mixedEvidence) {
      hits.push({ ...span, compound: tierCompound, mixed: mixedHit });
    } else if (
      (hasSubstringOnlyHit(bare, dict) || mixedEvidence) &&
      !properNounish
    ) {
      hits.push({ ...span, compound: tierCompound, mixed: mixedHit });
    }
    // else: probable proper noun — skip.
  }
  return hits;
}

/**
 * LOAD-1: the vendored filter library keeps two UNCAPPED caches per
 * instance (`_censoredWords`, `_wordsWithNoProfanityInside`) that grow
 * with every distinct input over the bot's lifetime. The library is
 * off-limits, so this engine-side sweep resets them. Call it from the
 * existing periodic sweep path (next to pruneRelayState/pruneFizzleState
 * in chat.js's sweepIdleSessions): the engine's own capped verdict cache
 * (VERDICT_CACHE_CAP) absorbs the recompute cost, so verdicts and
 * performance are unchanged.
 */
export function sweepEngineCaches() {
  hardFilter.clearCache();
  hardFilterAdult.clearCache();
  mixedFilter.clearCache();
  sensitiveFilter.clearCache();
}
