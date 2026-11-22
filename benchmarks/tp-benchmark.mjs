// TRUE-POSITIVE benchmark: NEW (profanity.js, engine-backed) vs OLD (profanity.legacy.js).
//
// True positive = flagged === true on input containing real profanity.
// Corpora:
//   A. Hard wordlist sweep: every WORDS entry (718), bare + sentence template.
//   B. Inflections (~80): English inflections + Russian sanity sample (EN-only
//      engine is expected to pass Russian clean; that's scope, not a failure).
//   C. Pinned compound cases: assert flagged===true in BOTH, record exact masks.
//   D. Soft-tier rules: SOFT_WORDS alone -> clean in BOTH; hard+soft mixes ->
//      flagged in BOTH with soft masked; record masks.
//   E. Miss list: every input where flagged differs between implementations.
//
// Run: node tp-benchmark.mjs
// Writes: tp-results.json (same dir) + prints the old-vs-new table.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WORDS, SOFT_WORDS } from '../src/services/wordlist.js';

const NEW = await import('../src/services/profanity.js');
const OLD = await import('../src/services/profanity.legacy.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const MASK = '∗'; // U+2217, shared by both filters

const SENT = (w) => `He said ${w} to me.`; // neutral sentence template

// ---------- corpora ----------
const corpusA = WORDS.map((w) => ({ id: `A:${w}`, input: w, form: 'bare' }))
  .concat(WORDS.map((w) => ({ id: `A:${w}:sent`, input: SENT(w), form: 'sentence' })));

const INFLECTIONS = [
  // pinned by the task brief
  'fucking', 'fuckers', 'fucker', 'fucked', 'fucks',
  'motherfucker', 'motherfuckers', 'motherfucking', 'motherfucked',
  'shits', 'shitting', 'shitted', 'shitter',
  'bitches', 'bitch', 'bitchy',
  'dicks', 'dickhead', 'dickheads', 'dickish',
  'assholes', 'asshole', 'asses',
  'bastards', 'bastard',
  // cocksucker variants
  'cocksucker', 'cocksuckers', 'cocksucking', 'cocksucked', 'cocksuck',
  'c0cksucker', 'cock-sucker', 'cock sucker',
  // more inflection coverage across the list
  'pissing', 'pissed', 'pisser', 'pisses',
  'farting', 'farted', 'farter',
  'wanking', 'wanked', 'wanker', 'wankers',
  'sluts', 'slutty', 'sluttier', 'sluttiest',
  'whores', 'whoring', 'whored',
  'cumming', 'cummed', 'cummer', 'cums',
  'jizzing', 'jizzed',
  'tits', 'titties', 'titty',
  'boobs', 'boobies',
  'suckers', 'sucking', 'sucked',
  'dildos', 'dildo',
  'penises', 'penis',
  'vaginas', 'vagina',
  'anuses', 'anus',
  'testicles', 'testicle',
  'nipples', 'nipple',
  'orgasms', 'orgasm',
  'pornos', 'porn',
  'raping', 'raped', 'rapist',
  'prostitutes', 'prostitute',
  'pimps', 'pimping',
  'condoms', 'condom',
  'erections', 'erection',
];
const RUSSIAN = ['блядь', 'хуй', 'пизда', 'ебать'];
const corpusB = INFLECTIONS.map((w) => ({ id: `B:${w}`, input: w, kind: 'inflection' }))
  .concat(RUSSIAN.map((w) => ({ id: `B:ru:${w}`, input: w, kind: 'russian' })));

const COMPOUNDS = ['assfuck', 'fuckass', 'shitfucker', '5hitfuck3r', 'a.s.s.f.u.c.k', 'shitfuck', 'shitskin'];
const corpusC = COMPOUNDS.map((w) => ({ id: `C:${w}`, input: w }));

const corpusD = SOFT_WORDS.map((w) => ({ id: `D:soft:${w}`, input: w, kind: 'soft-alone' }))
  .concat([
    { id: 'D:mix:fuck-shit', input: 'fuck shit', kind: 'mix' },
    { id: 'D:mix:fuck-your-ass', input: 'fuck your ass', kind: 'mix' },
    { id: 'D:mix:fuck-your-butt', input: 'i wanna fuck your butt', kind: 'mix' },
  ]);

// ---------- runner ----------
function runAll(corpus) {
  return corpus.map((c) => {
    let nr, or;
    try { nr = NEW.filterText(c.input); } catch (e) { nr = { error: String(e) }; }
    try { or = OLD.filterText(c.input); } catch (e) { or = { error: String(e) }; }
    return { ...c, newR: nr, oldR: or };
  });
}

const rows = [...runAll(corpusA), ...runAll(corpusB), ...runAll(corpusC), ...runAll(corpusD)];

const corpusOf = (r) => r.id.split(':')[0];
const byCorpus = {};
for (const r of rows) (byCorpus[corpusOf(r)] ??= []).push(r);

// ---------- corpus A: per-word detection (bare / sentence / combined) ----------
const perWord = WORDS.map((w) => {
  const bare = rows.find((r) => r.id === `A:${w}`);
  const sent = rows.find((r) => r.id === `A:${w}:sent`);
  return {
    word: w,
    newBare: !!bare.newR.flagged, oldBare: !!bare.oldR.flagged,
    newSent: !!sent.newR.flagged, oldSent: !!sent.oldR.flagged,
  };
});
const aStats = {
  n: WORDS.length,
  oldBare: perWord.filter((p) => p.oldBare).length,
  newBare: perWord.filter((p) => p.newBare).length,
  oldSent: perWord.filter((p) => p.oldSent).length,
  newSent: perWord.filter((p) => p.newSent).length,
  oldEither: perWord.filter((p) => p.oldBare || p.oldSent).length,
  newEither: perWord.filter((p) => p.newBare || p.newSent).length,
  newBareMisses: perWord.filter((p) => !p.newBare).map((p) => p.word),
  oldBareMisses: perWord.filter((p) => !p.oldBare).map((p) => p.word),
  newSentMisses: perWord.filter((p) => !p.newSent).map((p) => p.word),
  oldSentMisses: perWord.filter((p) => !p.oldSent).map((p) => p.word),
};

// ---------- corpus B ----------
const bInf = rows.filter((r) => r.id.startsWith('B:') && !r.id.startsWith('B:ru:'));
const bRu = rows.filter((r) => r.id.startsWith('B:ru:'));
const bStats = {
  n: INFLECTIONS.length,
  oldDetected: bInf.filter((r) => r.oldR.flagged).length,
  newDetected: bInf.filter((r) => r.newR.flagged).length,
  newMisses: bInf.filter((r) => !r.newR.flagged).map((r) => r.input),
  oldMisses: bInf.filter((r) => !r.oldR.flagged).map((r) => r.input),
};
const bRuStats = bRu.map((r) => ({ input: r.input, newFlagged: !!r.newR.flagged, oldFlagged: !!r.oldR.flagged }));

// ---------- corpus C: assert flagged in BOTH, record masks ----------
const cRows = rows.filter((r) => r.id.startsWith('C:'));
const cStats = cRows.map((r) => ({
  input: r.input,
  newFlagged: !!r.newR.flagged, oldFlagged: !!r.oldR.flagged,
  newText: r.newR.text ?? null, oldText: r.oldR.text ?? null,
  maskDelta: (r.newR.text ?? null) !== (r.oldR.text ?? null),
}));

// ---------- corpus D ----------
const dSoft = rows.filter((r) => r.kind === 'soft-alone');
const dMix = rows.filter((r) => r.kind === 'mix');
const dStats = {
  n: SOFT_WORDS.length,
  oldClean: dSoft.filter((r) => !r.oldR.flagged).length,
  newClean: dSoft.filter((r) => !r.newR.flagged).length,
  newFlaggedSoft: dSoft.filter((r) => r.newR.flagged).map((r) => r.input),
  oldFlaggedSoft: dSoft.filter((r) => r.oldR.flagged).map((r) => r.input),
  mixes: dMix.map((r) => ({
    input: r.input,
    newFlagged: !!r.newR.flagged, oldFlagged: !!r.oldR.flagged,
    newText: r.newR.text ?? null, oldText: r.oldR.text ?? null,
    maskDelta: (r.newR.text ?? null) !== (r.oldR.text ?? null),
  })),
};

// ---------- corpus E: miss list (flagged differs) ----------
const eRows = rows
  .filter((r) => !!r.newR.flagged !== !!r.oldR.flagged)
  .map((r) => ({
    id: r.id, input: r.input,
    newFlagged: !!r.newR.flagged, oldFlagged: !!r.oldR.flagged,
    newText: r.newR.text ?? null, oldText: r.oldR.text ?? null,
  }));

// ---------- results ----------
const results = {
  methodology: {
    note: 'True positive = flagged === true on input containing real profanity. Each input run once through NEW.filterText and OLD.filterText (synchronous ESM, identical {text, flagged, hits} signature).',
    corpora: {
      A: `every WORDS entry (${WORDS.length}), bare + sentence template "He said {w} to me."`,
      B: `${INFLECTIONS.length} English inflections + ${RUSSIAN.length} Russian sanity samples (EN-only engine scope)`,
      C: `${COMPOUNDS.length} pinned compound cases`,
      D: `${SOFT_WORDS.length} SOFT_WORDS alone + 3 hard+soft mixes`,
    },
    vm: { node: process.version, platform: process.platform, arch: process.arch },
    newModule: '../src/services/profanity.js',
    oldModule: '../src/services/profanity.legacy.js',
    wordlist: '../src/services/wordlist.js',
  },
  A: aStats, B: bStats, B_russian: bRuStats, C: cStats, D: dStats,
  E_missList: eRows, E_missCount: eRows.length,
};

writeFileSync(join(HERE, 'tp-results.json'), JSON.stringify(results, null, 2));

// ---------- console table ----------
const pct = (d, n) => `${(100 * d / n).toFixed(2)}%`;
const line = (s = '') => console.log(s);
line('=== TRUE-POSITIVE BENCHMARK: NEW (engine) vs OLD (legacy) ===');
line(`Node ${process.version} on ${process.platform}/${process.arch}`);
line('');
line('| corpus | n | OLD detected | OLD rate | NEW detected | NEW rate |');
line('|---|---|---|---|---|---|');
line(`| A. wordlist, bare word | ${aStats.n} | ${aStats.oldBare} | ${pct(aStats.oldBare, aStats.n)} | ${aStats.newBare} | ${pct(aStats.newBare, aStats.n)} |`);
line(`| A. wordlist, sentence "He said {w} to me." | ${aStats.n} | ${aStats.oldSent} | ${pct(aStats.oldSent, aStats.n)} | ${aStats.newSent} | ${pct(aStats.newSent, aStats.n)} |`);
line(`| A. wordlist, flagged in either form | ${aStats.n} | ${aStats.oldEither} | ${pct(aStats.oldEither, aStats.n)} | ${aStats.newEither} | ${pct(aStats.newEither, aStats.n)} |`);
line(`| B. English inflections | ${bStats.n} | ${bStats.oldDetected} | ${pct(bStats.oldDetected, bStats.n)} | ${bStats.newDetected} | ${pct(bStats.newDetected, bStats.n)} |`);
line(`| C. pinned compounds | ${cStats.length} | ${cStats.filter((c) => c.oldFlagged).length} | ${pct(cStats.filter((c) => c.oldFlagged).length, cStats.length)} | ${cStats.filter((c) => c.newFlagged).length} | ${pct(cStats.filter((c) => c.newFlagged).length, cStats.length)} |`);
line(`| D. soft alone -> clean (no flag) | ${dStats.n} | ${dStats.oldClean} | ${pct(dStats.oldClean, dStats.n)} | ${dStats.newClean} | ${pct(dStats.newClean, dStats.n)} |`);
line(`| D. hard+soft mixes -> flagged | ${dStats.mixes.length} | ${dStats.mixes.filter((m) => m.oldFlagged).length} | ${pct(dStats.mixes.filter((m) => m.oldFlagged).length, dStats.mixes.length)} | ${dStats.mixes.filter((m) => m.newFlagged).length} | ${pct(dStats.mixes.filter((m) => m.newFlagged).length, dStats.mixes.length)} |`);
line('');
line('--- Corpus C: compound masks (assert flagged in BOTH) ---');
for (const c of cStats) {
  line(`  ${c.input}: flagged NEW=${c.newFlagged} OLD=${c.oldFlagged} | NEW->${JSON.stringify(c.newText)} | OLD->${JSON.stringify(c.oldText)}${c.maskDelta ? '  <-- MASK DELTA' : ''}`);
}
line('');
line('--- Corpus D: hard+soft mixes ---');
for (const m of dStats.mixes) {
  line(`  "${m.input}": flagged NEW=${m.newFlagged} OLD=${m.oldFlagged} | NEW->${JSON.stringify(m.newText)} | OLD->${JSON.stringify(m.oldText)}${m.maskDelta ? '  <-- MASK DELTA' : ''}`);
}
line('');
line('--- Corpus B: Russian sanity (EN-only scope for NEW) ---');
for (const r of bRuStats) line(`  ${r.input}: NEW flagged=${r.newFlagged} | OLD flagged=${r.oldFlagged}`);
line('');
line(`--- Corpus E: miss list (flagged differs), ${eRows.length} total ---`);
const NEW_MISS = eRows.filter((e) => !e.newFlagged && e.oldFlagged);
const OLD_MISS = eRows.filter((e) => e.newFlagged && !e.oldFlagged);
line(`  NEW misses but OLD catches (${NEW_MISS.length}):`);
for (const e of NEW_MISS) line(`    [${e.id}] ${JSON.stringify(e.input)}  OLD->${JSON.stringify(e.oldText)}`);
line(`  OLD misses but NEW catches (${OLD_MISS.length}):`);
for (const e of OLD_MISS) line(`    [${e.id}] ${JSON.stringify(e.input)}  NEW->${JSON.stringify(e.newText)}`);
line('');
line('Full detail: benchmarks/tp-results.json');
