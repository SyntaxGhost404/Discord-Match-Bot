#!/usr/bin/env node
/**
 * False-positive benchmark: NEW (profanity.js) vs OLD (profanity.legacy.js).
 *
 * A FALSE POSITIVE = flagged === true on an input that must stay clean.
 *
 * Corpora:
 *   A. Ordinary chat      (~300 inputs, template-generated, seeded RNG)
 *   B. Proper nouns       (~60: cities/people with risky substrings)
 *   C. Classic lookalikes (~60)
 *   D. Modern slang       (~40, must stay clean)
 *   E. Soft words in isolation (36 SOFT_WORDS + @ss + 5h1t; must be clean in BOTH)
 *
 * Usage: node fp-benchmark.mjs
 * Reads:  /home/hatch/workspace/anon-chat-remake-experimental/src/services/profanity.js
 *         /home/hatch/workspace/anon-chat-remake-experimental/src/services/profanity.legacy.js
 *         /home/hatch/workspace/profanity-filter-js-experimental/src/data/common_words_en.txt
 * Writes: ./fp-benchmark-results.json (next to this script)
 *
 * NEVER writes to ~/workspace/anon-chat-remake/ or ~/workspace/profanity-filter-js/.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const NEW = await import('/home/hatch/workspace/anon-chat-remake-experimental/src/services/profanity.js');
const OLD = await import('/home/hatch/workspace/anon-chat-remake-experimental/src/services/profanity.legacy.js');

// ---------------------------------------------------------------------------
// Seeded RNG so corpora are stable across runs (re-runnable).
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0xC10A5EED); // "clean seed"
function pick(arr) { return arr[Math.floor(rand() * arr.length)]; }

// ---------------------------------------------------------------------------
// Clean vocabulary for corpus A. Only unambiguous plain words: lowercase,
// 4-12 letters, and containing NONE of the risky substrings (so an FP on a
// generated sentence is genuinely the filter's fault, not a dirty vocab word).
// ---------------------------------------------------------------------------
const RISKY = [
  'ass', 'cum', 'tit', 'fag', 'dic', 'sex', 'hell', 'damn', 'shit', 'piss',
  'fuck', 'cock', 'cunt', 'dick', 'boob', 'slut', 'whore', 'bitch', 'wank',
  'porn', 'hentai', 'nig', 'spic', 'chink', 'twat', 'anus', 'penis', 'vagina',
  'jizz', 'semen', 'orgasm', 'mastur', 'erotic', 'lesbian', 'loli', 'incest',
  'pee', 'poop', 'fart', 'turd', 'crap', 'douche', 'duche', 'doosh', 'bastard',
  'butt', 'arse', 'shart', 'terd', 'shite', 'shitty', 'bdsm', 'fetish',
  // genuine slurs that live in the hard list: flagging them is a TRUE
  // positive, so they must not appear in "clean" generated chat either
  'coon', 'kike', 'gook',
];

const vocabRaw = fs.readFileSync(
  '/home/hatch/workspace/profanity-filter-js-experimental/src/data/common_words_en.txt',
  'utf8',
).split('\n');

const CLEAN_VOCAB = vocabRaw.filter((w) => {
  if (!/^[a-z]{4,12}$/.test(w)) return false;
  const lw = w.toLowerCase();
  return !RISKY.some((r) => lw.includes(r));
});

// ---------------------------------------------------------------------------
// Corpus A: ordinary chat (~300). 20 templates x 15 sampled sentences.
// ---------------------------------------------------------------------------
const A_TEMPLATES = [
  'hey how are you doing today',
  'good morning everyone',
  'what did you have for lunch',
  'i am going to {w} tomorrow',
  'did you finish the {w} homework',
  'my {w} is really {w} today',
  'i love playing {w} with my friends',
  'have you seen the new {w}',
  "let's go to the {w} later",
  'i need to buy some {w} from the store',
  'the weather is so {w} today',
  'what time is the {w} meeting',
  'i am really tired after {w}',
  'can you help me with my {w}',
  'we should plan a {w} for the weekend',
  'my favorite {w} is the {w} one',
  'i watched a {w} movie last night',
  'do you want to play {w} tonight',
  'i have an exam on {w} next week',
  'the {w} at school was so {w}',
];
const corpusA = [];
for (const t of A_TEMPLATES) {
  for (let i = 0; i < 15; i++) {
    corpusA.push(t.replaceAll('{w}', () => pick(CLEAN_VOCAB)));
  }
}
// Sprinkle a few case variants (filters must be case-insensitive-safe).
const corpusA_variants = [
  'Hey how are you doing today',
  'GOOD MORNING EVERYONE',
  'What did you have for lunch',
  "LET'S GO TO THE PARK LATER",
  'I watched a funny movie last night',
  'Do you want to play tonight',
];
const CORPUS_A = [...corpusA, ...corpusA_variants]; // 306

// ---------------------------------------------------------------------------
// Corpus B: proper nouns with risky substrings (~60).
// ---------------------------------------------------------------------------
const CORPUS_B = [
  'Scunthorpe', 'Penistone', 'Manchester', 'Trondheim', 'Charles Dickens',
  'Essex', 'Sussex', 'Middlesex', 'Wessex', 'Assen',
  'Arsen', 'Assiniboia', 'Assiniboine', 'Isle of Cumbrae', 'Fagatogo',
  'Dickson', 'Cockburn', 'Fukushima', 'Titz', 'Arsenal',
  'Arsene Wenger', 'Cumming', 'Cumby', 'Cummins', 'Titchfield',
  'Dickenson County', 'Cocke County', 'Hell, Michigan', "Hell's Kitchen", 'Hellespont',
  'Sexbierum', 'Shitterton', 'Pissouri', 'Pismo Beach', 'Assateague Island',
  'Cumana', 'Titus Andronicus', 'Dickens County', 'Cockermouth', 'Dickinson',
  'Passaic', 'Massapequa', 'Nassau', 'Cassadaga', 'Tallahassee',
  'Hassi Messaoud', 'Glasscock County', 'Lake Titicaca', 'Titisee', 'Tittabawassee River',
  'Basse-Terre', 'Cass County', 'Cumberland Gap', 'Dick Van Dyke', 'Moby Dick',
  'Fagin', 'Fagasa', 'Fagalii', 'Dam Neck', 'Coxsackie',
]; // 60

// ---------------------------------------------------------------------------
// Corpus C: classic lookalikes (~60).
// ---------------------------------------------------------------------------
const CORPUS_C = [
  'class', 'classic', 'c.l.a.s.s', 'sample', 'text', 'lorem', 'ipsum',
  'brown', 'fox', 'cucumber', 'shiitake', 'cocktail', 'peacock', 'cockpit',
  'assist', 'grass', 'glass', 'mass', 'pass', 'password',
  'hello', 'shell', 'smell', 'spell', 'scrap', 'document', 'snicker', 'assassin',
  'CLASS', 'Class', 'c.l.a.s.s.i.c', 'ClAsS',
  'the class was fun', 'classic rock forever', 'a glass of water please',
  'grass is green', 'smell the flowers', 'run a spell check',
  'scrap metal prices', 'read the whole document', 'snickers are tasty',
  'the assassin in the game', 'pass the salt', 'mass times acceleration',
  'peacock feathers', 'cockpit voice recorder', 'can you assist me',
  'sample sale today', 'the brown fox jumps', 'hello world',
  'write a shell script', 'send a text message', 'lorem ipsum dolor sit amet',
  'shiitake mushrooms', 'cucumber salad', 'cocktail dress code',
  'grassroots movement', 'glassblowing workshop', 'passport control',
  'the sample was free',
]; // 60

// ---------------------------------------------------------------------------
// Corpus D: modern slang that must stay clean (~40).
// ---------------------------------------------------------------------------
const CORPUS_D = [
  'a gay friend', 'this sucks', 'screw you', 'lmao', 'wth', 'fam',
  'simp', 'rizz', 'gyat', 'bestie', 'homie', 'ong', 'omw',
  'fomo', 'boomer', 'dislike', 'dismiss', 'sus', 'cap', 'bet',
  'vibe', 'slay',
  'lmao that is funny', 'fam where are you', 'he is my bestie',
  'homie whats up', 'ong thats crazy', 'omw home now',
  'no cap', 'thats cap', 'bet lets go', 'vibe check',
  'slay queen', 'sus behavior', 'i dislike this', 'dismiss the class',
  'boomer energy', 'rizz him up', 'touch grass', 'no thoughts just vibes',
]; // 40

// ---------------------------------------------------------------------------
// Corpus E: soft words in isolation. Product rule: must be clean in BOTH.
// Pulled from the published 36-word SOFT_WORDS list + the two leet variants.
// ---------------------------------------------------------------------------
const SOFT_36 = [
  'shit', 'shite', 'shited', 'shitey', 'shiting', 'shitings', 'shits', 'shitt',
  'shitted', 'shitter', 'shitters', 'shitting', 'shittings', 'shitty',
  'crap', 'ass', 'asses', 'arse', 'arrse', 'damn', 'hell', 'butt', 'fart',
  'piss', 'pee', 'peepee', 'poop', 'douche', 'duche', 'doosh', 'douchey',
  'bastard', 'bastardo', 'turd', 'terd', 'shart',
];
const CORPUS_E = [...SOFT_36, '@ss', '5h1t']; // 38

const CORPORA = [
  { id: 'A', name: 'Ordinary chat', inputs: CORPUS_A },
  { id: 'B', name: 'Proper nouns', inputs: CORPUS_B },
  { id: 'C', name: 'Classic lookalikes', inputs: CORPUS_C },
  { id: 'D', name: 'Modern slang (must stay clean)', inputs: CORPUS_D },
  { id: 'E', name: 'Soft words in isolation', inputs: CORPUS_E },
];

// ---------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------
function check(impl, s) {
  try {
    const r = impl.filterText(s);
    return { flagged: !!r.flagged, text: r.text, hits: r.hits };
  } catch (e) {
    return { flagged: 'ERROR', text: String(e && e.message || e), hits: -1 };
  }
}

const results = [];
let totalOld = 0, totalNew = 0, totalN = 0;

for (const c of CORPORA) {
  const fps = [];
  for (const input of c.inputs) {
    const o = check(OLD, input);
    const n = check(NEW, input);
    const oFp = o.flagged === true;
    const nFp = n.flagged === true;
    if (oFp || nFp || o.flagged === 'ERROR' || n.flagged === 'ERROR') {
      fps.push({ input, old: o, new: n });
    }
  }
  const oldFp = fps.filter((f) => f.old.flagged === true).length;
  const newFp = fps.filter((f) => f.new.flagged === true).length;
  results.push({ ...c, fps, oldFp, newFp });
  totalOld += oldFp; totalNew += newFp; totalN += c.inputs.length;
}

const pct = (x, n) => ((100 * x) / n).toFixed(1) + '%';

// ---------------------------------------------------------------------------
// Report (phone-friendly: table first, then details).
// ---------------------------------------------------------------------------
const L = [];
L.push('# Profanity filter false-positive benchmark');
L.push('');
L.push('**NEW** = `profanity.js` (two-tier soft/hard engine) vs **OLD** = `profanity.legacy.js`.');
L.push('FP = `flagged === true` on an input that must stay clean.');
L.push('');
L.push('| Corpus | n | OLD FPs | OLD rate | NEW FPs | NEW rate | delta (NEW-OLD) |');
L.push('|---|---|---|---|---|---|---|');
for (const r of results) {
  const d = r.newFp - r.oldFp;
  L.push(`| ${r.id}. ${r.name} | ${r.inputs.length} | ${r.oldFp} | ${pct(r.oldFp, r.inputs.length)} | ${r.newFp} | ${pct(r.newFp, r.inputs.length)} | ${d > 0 ? '+' : ''}${d} |`);
}
L.push(`| **Overall** | **${totalN}** | **${totalOld}** | **${pct(totalOld, totalN)}** | **${totalNew}** | **${pct(totalNew, totalN)}** | **${totalNew - totalOld > 0 ? '+' : ''}${totalNew - totalOld}** |`);
L.push('');

const eResult = results.find((r) => r.id === 'E');
const eViolations = eResult.fps.filter((f) => f.old.flagged === true || f.new.flagged === true);
if (eViolations.length) {
  L.push('## CRITICAL: corpus E violations (soft words must be clean in BOTH)');
  for (const f of eViolations) {
    const who = [f.old.flagged === true ? 'OLD' : null, f.new.flagged === true ? 'NEW' : null].filter(Boolean).join('+');
    L.push(`- \`${f.input}\` flagged by **${who}**`);
  }
  L.push('');
}

const regressed = results.filter((r) => r.newFp > r.oldFp);
if (regressed.length) {
  L.push('## REGRESSIONS: corpora where NEW is worse than OLD');
  for (const r of regressed) {
    L.push(`- **${r.id}. ${r.name}**: OLD ${r.oldFp}/${r.inputs.length}, NEW ${r.newFp}/${r.inputs.length}`);
  }
  L.push('');
}

L.push('## False positives (every one)');
for (const r of results) {
  L.push('');
  L.push(`### ${r.id}. ${r.name} — ${r.fps.length} inputs flagged by at least one impl`);
  if (!r.fps.length) { L.push('(none)'); continue; }
  for (const f of r.fps) {
    const tags = [];
    if (f.old.flagged === true) tags.push(`OLD -> \`${f.old.text}\` (${f.old.hits} hits)`);
    else if (f.old.flagged === 'ERROR') tags.push(`OLD ERROR: ${f.old.text}`);
    if (f.new.flagged === true) tags.push(`NEW -> \`${f.new.text}\` (${f.new.hits} hits)`);
    else if (f.new.flagged === 'ERROR') tags.push(`NEW ERROR: ${f.new.text}`);
    L.push(`- input: \`${f.input}\` — ${tags.join(' ; ')}`);
  }
}

L.push('');
L.push('## Methodology');
L.push(`- Date: 2026-09-21. VM: Ubuntu 24.04.5 LTS (Meta hatch box, 2 vCPU). Node: ${process.version}.`);
L.push(`- Corpus A generated from 20 templates x 15 samples (${CORPUS_A.length} total incl. 6 case variants), seeded PRNG mulberry32(0xC10A5EED), vocabulary = common_words_en.txt filtered to [a-z]{4,12} with ${RISKY.length} risky substrings excluded (${CLEAN_VOCAB.length} words survived; genuine slurs like 'coon' excluded as true positives).`);
L.push(`- Corpora B/C/D/E are fixed literal lists (${results.filter((r) => r.id !== 'A').map((r) => r.inputs.length).join('/')}).`);
L.push('- Each input ran through BOTH implementations synchronously via `filterText`; FP = `flagged === true`. Masked output and hit counts recorded per FP.');
L.push(`- Script: \`fp-benchmark.mjs\` (re-runnable, deterministic). Raw results: \`fp-benchmark-results.json\`.`);

const report = L.join('\n');
console.log(report);

fs.writeFileSync(
  path.join(HERE, 'fp-benchmark-results.json'),
  JSON.stringify({
    meta: {
      date: '2026-09-21',
      node: process.version,
      old: 'profanity.legacy.js',
      new: 'profanity.js',
      seed: 'mulberry32(0xC10A5EED)',
      cleanVocabSize: CLEAN_VOCAB.length,
    },
    corpora: results.map((r) => ({
      id: r.id, name: r.name, n: r.inputs.length,
      oldFp: r.oldFp, newFp: r.newFp,
      fps: r.fps.map((f) => ({
        input: f.input,
        old: f.old, new: f.new,
      })),
    })),
    overall: { n: totalN, oldFp: totalOld, newFp: totalNew },
  }, null, 2),
);
console.error(`\n[wrote fp-benchmark-results.json]`);
