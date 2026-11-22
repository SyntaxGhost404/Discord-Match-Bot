// Profanity tier derivation: the three-tier wordlist split (2026-09-21),
// shared by the detection engine (profanity-engine.js) and the masking
// adapter (profanity.js). Mirrors the live bot's tiering semantics exactly:
//   - HARD_TIER (603): WORDS minus SENSITIVE_WORDS. The absolute ban list:
//     censored + flagged in every chat.
//   - SENSITIVE (116): SENSITIVE_WORDS. Minor chats: censored + flagged
//     exactly like hard words. Adult chats: skipped entirely, EXCEPT the
//     MIXED_SENSITIVE entries carrying a genuine hard component.
//   - SENSITIVE_SOFT (5): minor chats censored + flagged like hard words;
//     adult chats skipped entirely.
//   - MILD_SOFT (31, incl. the shit-family since 2026-09-21): SOFT_WORDS
//     minus SENSITIVE_SOFT. Permitted in isolation in every chat; masked
//     (not additionally struck) only when the message is already flaggable
//     (the upgrade rule).

import { WORDS, SOFT_WORDS, SENSITIVE_WORDS, SENSITIVE_SOFT } from './wordlist.js';

const sensitiveSet = new Set(SENSITIVE_WORDS);
const sensitiveSoftSet = new Set(SENSITIVE_SOFT);

/** HARD tier: always censored + flagged, both chat types. */
export const HARD_TIER = WORDS.filter((w) => !sensitiveSet.has(w));
/** MILD tier: pass untouched in isolation; masked (not additionally struck)
 *  when the message is already flaggable. */
export const MILD_SOFT = SOFT_WORDS.filter((w) => !sensitiveSoftSet.has(w));

{
  if (HARD_TIER.length !== WORDS.length - SENSITIVE_WORDS.length) {
    throw new Error(`HARD_TIER derivation broke: ${HARD_TIER.length} entries`);
  }
  if (MILD_SOFT.length !== SOFT_WORDS.length - SENSITIVE_SOFT.length) {
    throw new Error(`MILD_SOFT derivation broke: ${MILD_SOFT.length} entries`);
  }
}

/**
 * Sensitive component stems: censored inside compounds in minor chats,
 * readable in adult chats. Plain (non-leet) forms; the component regexes
 * built in profanity.js are leet-tolerant like everything else.
 *
 * (2026-09-21: 'shit' was reclassified to the mild tier and moved to
 * MILD_ROOTS; only the ass-family stems stay sensitive here.)
 */
export const SENSITIVE_ROOTS = ['ass', 'arse', 'butt'];

/**
 * Mild component stems: readable in isolation everywhere; masked inside
 * compounds only when the message is flaggable (the upgrade rule).
 */
export const MILD_ROOTS = [
  'crap', 'damn', 'hell', 'fart', 'piss',
  'pee', 'poop', 'douche', 'bastard', 'turd',
  'shit',
];

/**
 * Sensitive entries that carry a genuine hard component: a HARD_TIER word
 * forming a clean prefix or suffix, with the remainder carrying a sensitive
 * or mild component (MILD_SOFT joined the remainder check on 2026-09-21
 * when the shit-family moved to the mild tier, so "shitdick" still qualifies
 * via its hard "dick" component). These are the only sensitive entries still
 * scanned in adult chats (e.g. "fuckbitch" via "bitch" -> "fuckbi∗ch");
 * everything else sensitive passes clean there. The prefix/suffix
 * requirement keeps incidental substrings (like "stfu" inside "fistfuck")
 * from qualifying.
 */
export const MIXED_SENSITIVE = new Set(
  SENSITIVE_WORDS.filter((w) => {
    for (const h of HARD_TIER) {
      if (h.length >= w.length) continue;
      let rest = null;
      if (w.startsWith(h)) rest = w.slice(h.length);
      else if (w.endsWith(h)) rest = w.slice(0, w.length - h.length);
      else continue;
      if (!rest) continue;
      const carriesSensitive = [...SENSITIVE_WORDS, ...SENSITIVE_SOFT, ...MILD_SOFT].some(
        (s) => s.length < w.length && rest.includes(s),
      );
      if (carriesSensitive) return true;
    }
    return false;
  }),
);

// The derivation above must reproduce the 16 mixed entries the live bot
// ships with; anything else means the wordlist drifted from the live tree.
const EXPECTED_MIXED = new Set([
  'fannyfucker', 'fuckbitch', 'fucktard', 'fuckwad', 'muthafecker',
  'muthafuckaz', 'muthafucker', 'muthafuckker', 'mutherfucker',
  'mutherfucking', 'penisfucker', 'titfuck', 'tittiefucker', 'tittyfuck',
  'tittyfucker', 'shitdick',
]);
{
  const missing = [...EXPECTED_MIXED].filter((w) => !MIXED_SENSITIVE.has(w));
  const extra = [...MIXED_SENSITIVE].filter((w) => !EXPECTED_MIXED.has(w));
  if (missing.length || extra.length || MIXED_SENSITIVE.size !== 16) {
    throw new Error(
      `MIXED_SENSITIVE derivation drifted (missing: ${missing}, extra: ${extra})`,
    );
  }
}

// Set views for the engine's exact/lemma/substring evidence paths.
export const WORDS_SET = new Set(WORDS);
export const HARD_TIER_SET = new Set(HARD_TIER);
export const SENSITIVE_SET = new Set(SENSITIVE_WORDS);
export const SOFT_SET = new Set(SOFT_WORDS);
export const SENSITIVE_SOFT_SET = new Set(SENSITIVE_SOFT);
export const MILD_SET = new Set(MILD_SOFT);
