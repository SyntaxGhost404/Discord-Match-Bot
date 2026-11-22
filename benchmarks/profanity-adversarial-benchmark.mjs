// Adversarial-evasion benchmark: OLD (profanity.legacy.js) vs NEW (profanity.js).
// Re-runnable:  node benchmarks/profanity-adversarial-benchmark.mjs
// Writes benchmarks/results.md and prints the same report to stdout.
// No network, no Discord, no tokens. Both filters are synchronous ESM with
// the identical signature filterText(s) -> { text, flagged, hits }.
//
// NOTE: this file contains profanity and slur spellings (including leet
// variants of wordlist-covered slurs). It is a filter test fixture, never
// user-facing copy.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const NEW = await import(join(HERE, '..', 'src', 'services', 'profanity.js'));
const OLD = await import(join(HERE, '..', 'src', 'services', 'profanity.legacy.js'));

// ---------------------------------------------------------------------------
// Test inputs (hardcoded so the run is deterministic and re-runnable).
// ---------------------------------------------------------------------------

const ZWSP = '​';   // U+200B zero width space
const ZWNJ = '‌';   // U+200C zero width non-joiner
const ZWJ  = '‍';    // U+200D zero width joiner
const SHY  = '­';    // U+00AD soft hyphen
const BOM  = '﻿';    // U+FEFF zero width no-break space
const WJ   = '⁠';    // U+2060 word joiner
const IS   = '⁣';    // U+2063 invisible separator
const FA   = '⁡';    // U+2061 function application
const between = (word, ch) => word.split('').join(ch);

const leet = [
  // shit family
  'sh1t','sh!t','5h1t','$h1t','sh1+','$h!t','5h17','5hit','shi7','sh1t',
  // fuck family
  'f*ck','f**k','f***k','fuc|<',
  // ass family
  '@ss','a$$','4ss','455','a5s','@5$',
  // bitch family
  '8itch','b1tch','81tch','b!tch','b1+ch','81+ch',
  // cunt family
  'c*nt','kun7',
  // cock / dick family
  'c0ck','c()ck','c0c|<','d1ck','d!ck','d1c|<',
  // pussy / tits family
  'pu$$y','p$$y','pu55y','t1ts','71t5','t!ts',
  // whore / slut family
  'wh0re','whor3','wh0r3','sl*t','s1ut','$lut','5lut',
  // fag family
  'f4g','f@g',
  // nigger / nigga family (both spellings are covered by the hard wordlist)
  'n1gg3r','nigg3r','n1gger','n!gger','nigg@','n!gg3r','n1gg4','n!gga',
];

const separator = [
  'f.u.c.k','f-u-c-k','f_u_c_k','f*u*c*k','f|u|c|k','f,u,c,k','f/u/c/k',
  'f..u..c..k','f - u - c - k','f.u-c_k','f u c k',
  's.h.i.t','s-h-i-t','s_h_i_t','s*h*i*t','s|h|i|t','s h i t',
  'a.s.s','a-s-s','a_s_s','a*s*s',
  'b.i.t.c.h','b-i-t-c-h','b_i_t_c_h','b*i*t*c*h',
  'c.u.n.t','c-u-n-t','c_u_n_t','c*u*n*t',
  'p.u.s.s.y','p-u-s-s-y','d.i.c.k','d-i-c-k','t.i.t.s','t-i-t-s',
  'w.h.o.r.e','s.l.u.t','f.a.g','n.i.g.g.e.r','n-i-g-g-a','b.o.o.b.s',
  '.fuck.','<fuck>','f#u#c#k','f^u^c^k','f~u~c~k',
];

const invisible = [
  // full between-letter injection, one invisible type per base word
  between('fuck', ZWSP), between('shit', ZWSP), between('ass', ZWSP),
  between('bitch', ZWSP), between('cunt', ZWSP),
  between('fuck', ZWNJ), between('shit', ZWNJ), between('ass', ZWNJ),
  between('bitch', ZWNJ), between('cunt', ZWNJ),
  between('fuck', ZWJ),  between('shit', ZWJ),  between('ass', ZWJ),
  between('bitch', ZWJ),  between('cunt', ZWJ),
  between('fuck', SHY),  between('shit', SHY),  between('ass', SHY),
  between('bitch', SHY), between('cunt', SHY),
  between('fuck', BOM),  between('shit', BOM),  between('ass', BOM),
  between('bitch', BOM), between('cunt', BOM),
  between('fuck', WJ),   between('shit', WJ),
  between('ass', IS),    between('bitch', IS),
  between('fuck', FA),   between('shit', FA),
  // single / edge placements
  'fu' + ZWSP + 'ck', 'sh' + ZWSP + 'it', 'a' + ZWSP + 'ss',
  'bi' + WJ + 'tch',
  ZWSP + 'fuck', 'fuck' + ZWSP, SHY + 'bitch', BOM + 'fuck',
];

const caseGames = [
  'FuCk','SH1T','fUcK','aSs','BiTcH','FUCK','SHIT','b1TcH','c0CK','PU$$Y',
  'sLuT','fAg','NIGGER','nIgGeR','NIGGA','nIgGa','WHORE','wHoRe','cUnT',
  'Dick','T1TS','ASS','aSS','pUsSy','CuNt','C0cK','B!tCh','SlUt',
];

const elongation = [
  'fuuuck','fuuuuck','fuuuuuck','fuuuuuuck','fuuuuuuuuuck',
  'shiiit','shiiiit','shiiiiit','shiiiiiiit','sshit','sshhit',
  'biiitch','biiiitch','biiiiitch','biiiiiiiiiitch','bbitch',
  'aaass','aaasss','assss','aasss','aaaaassss',
  'cuuunt','cuuuunt','cuuuuuunt',
  'cooock','coooock','diiick','diiiick',
  'puuussy','puuuussy','puuusssy',
  'boooob','booooob','boooobs',
  'whooore','whoreee','sluuut','sluttt',
  'faaag','faggg','tiiits','titss',
  'niggger','nigggger','niiigger','nigggga',
];

const fuzzy = [
  // NOTE: fuker, fack, phuk, phuck, hore are literal HARD wordlist entries;
  // shitt is a literal SOFT entry (soft words pass in isolation by design).
  'oofuko','fukkk','fucck','fuker','fukr','fukc','fock','fack','phuk','phuck',
  'phok','fuk','fuuk','fucc','fukkr',
  'shyt','shiet','shitt','shytte','sheit','shti','shte',
  'bich','bitsh','btich','bichh',
  'hore','whor','hoor','whorre',
  'slutty','slutt',
  'dik','cok','cokk','titz',
  'cuntt','cuunt',
  'dic','dickk','cockk',
  'titts','fagg','faag',
  'pusy','pussyy','pussie',
  'niger','nigge','niggerr',
];

const compound = [
  // absent from wordlist (task: note these) -- substring behavior under test
  'abcfuck','fuckyou','fuckfuck','shitshow2',
  // HARD entries -- both must catch; checks the new engine keeps exact+substring matching
  'fuckoff','fucker','fuckface','bitches','niggers','assfuck',
  'shitskin','fuckwit','fucktard','dickhead','motherfucker',
  // absent -- deeper compound/substring probing
  'dumbfuck','shitface','shithole','asshole','shitshow','cuntface','bitchslap',
  'asshat','cockblock','bullshit','horseshit','shitfaced','shithead',
];

const controls = [
  // MUST-STAY-CLEAN: any flag here is CRITICAL
  'stoppp','games','kissed','contest','canvas','gave','lmao','wth',
  'hello class','pass the salt','classic rock','cucumber salad',
  'she sells seashells','assist me please','the document','data analysis',
  'bass guitar','grass is green','Scunthorpe','arsenal','hello world',
  'good game','well played','nice shot',
];

const CATEGORIES = { leet, separator, invisible, case: caseGames, elongation, fuzzy, compound, controls };

// ---------------------------------------------------------------------------
// Run both filters over every input.
// ---------------------------------------------------------------------------

const runs = [];
for (const [cat, inputs] of Object.entries(CATEGORIES)) {
  for (const input of inputs) {
    let n, o;
    try { n = NEW.filterText(input); } catch (e) { n = { error: String(e) }; }
    try { o = OLD.filterText(input); } catch (e) { o = { error: String(e) }; }
    runs.push({ cat, input, n, o });
  }
}

// ---------------------------------------------------------------------------
// Aggregate.
// ---------------------------------------------------------------------------

const esc = (s) => s.replace(/\|/g, '\\|');
const show = (s) => JSON.stringify(s);

let report = '';
const L = (s = '') => { report += s + '\n'; };

const today = new Date().toISOString().slice(0, 10);
L(`# Profanity filter adversarial-evasion benchmark (${today})`);
L('');
L('OLD = `src/services/profanity.legacy.js` (in-house regex/leet filter).');
L('NEW = `src/services/profanity.js` (engine-backed detection, legacy masking semantics).');
L('`filterText(s) -> { text, flagged, hits }` on both; no network, no Discord, no tokens.');
L('');
L('## Detection-rate table (higher = better for evasion categories)');
L('');
L('| Category | n | OLD flagged | NEW flagged | OLD rate | NEW rate | NEW-only wins | NEW-only misses |');
L('|---|---|---|---|---|---|---|---|');
const perCat = {};
for (const [cat, inputs] of Object.entries(CATEGORIES)) {
  if (cat === 'controls') continue;
  const rs = runs.filter(r => r.cat === cat);
  const nN = rs.length;
  const oF = rs.filter(r => r.o.flagged).length;
  const nF = rs.filter(r => r.n.flagged).length;
  const wins = rs.filter(r => r.n.flagged && !r.o.flagged).length;
  const misses = rs.filter(r => r.o.flagged && !r.n.flagged).length;
  perCat[cat] = { nN, oF, nF, wins, misses };
  L(`| ${cat} | ${nN} | ${oF} | ${nF} | ${(100*oF/nN).toFixed(1)}% | ${(100*nF/nN).toFixed(1)}% | ${wins} | ${misses} |`);
}
L('');
L('## Control category (MUST-STAY-CLEAN; higher clean-rate = better)');
L('');
L('| Category | n | OLD clean | NEW clean | OLD clean-rate | NEW clean-rate |');
L('|---|---|---|---|---|---|');
{
  const rs = runs.filter(r => r.cat === 'controls');
  const nN = rs.length;
  const oC = rs.filter(r => !r.o.flagged).length;
  const nC = rs.filter(r => !r.n.flagged).length;
  perCat.controls = { nN, oC, nC };
  L(`| controls | ${nN} | ${oC} | ${nC} | ${(100*oC/nN).toFixed(1)}% | ${(100*nC/nN).toFixed(1)}% |`);
}
L('');
const critOld = runs.filter(r => r.cat === 'controls' && r.o.flagged);
const critNew = runs.filter(r => r.cat === 'controls' && r.n.flagged);
L(`**CRITICAL control violations:** OLD=${critOld.length}, NEW=${critNew.length}`);
for (const r of critOld) L(`- CRITICAL (OLD): ${show(r.input)} -> OLD masked ${show(r.o.text)}`);
for (const r of critNew) L(`- CRITICAL (NEW): ${show(r.input)} -> NEW masked ${show(r.n.text)}`);
L('');
L('## Disagreements (flag status differs)');
L('');
const dis = runs.filter(r => !!r.n.flagged !== !!r.o.flagged);
L(`Total: ${dis.length} of ${runs.length} inputs.`);
L('');
L('| # | Category | Input | OLD flagged | OLD output | NEW flagged | NEW output |');
L('|---|---|---|---|---|---|---|');
dis.forEach((r, i) => {
  L(`| ${i+1} | ${r.cat} | ${esc(show(r.input))} | ${r.o.flagged} | ${esc(show(r.o.text))} | ${r.n.flagged} | ${esc(show(r.n.text))} |`);
});
L('');
L('## Same-flag but different masked output');
L('');
const diffOut = runs.filter(r => !!r.n.flagged === !!r.o.flagged && r.n.flagged && r.n.text !== r.o.text);
L(`Total: ${diffOut.length}.`);
L('');
L('| # | Category | Input | OLD output | NEW output |');
L('|---|---|---|---|---|');
diffOut.forEach((r, i) => {
  L(`| ${i+1} | ${r.cat} | ${esc(show(r.input))} | ${esc(show(r.o.text))} | ${esc(show(r.n.text))} |`);
});
L('');
L('## Verdict');
L('');
const totalWins = Object.values(perCat).reduce((a, c) => a + (c.wins || 0), 0);
const totalMisses = Object.values(perCat).reduce((a, c) => a + (c.misses || 0), 0);
L(`- NEW-only wins (NEW flagged, OLD missed): **${totalWins}** inputs.`);
L(`- NEW-only misses (OLD flagged, NEW missed): **${totalMisses}** inputs${totalMisses > 0 ? ' -- POTENTIAL BLOCKER, see rows above' : ' -- none, no blocker'}.`);
L(`- Control violations: OLD=${critOld.length}, NEW=${critNew.length}${critOld.length + critNew.length > 0 ? ' -- CRITICAL' : ' -- none'}.`);
L('');
L('### NEW-only miss patterns (verified by targeted probing, 2026-09-21)');
L('');
L('1. **`$` is not folded to `s` by NEW.** OLD folds `$ -> s` (`$lut` -> `slut`,');
L('   `pu$$y` -> `pussy`, `$$lut` -> `slut` all flagged); NEW misses every `$`-form');
L('   (`$lut`, `$$lut`, `pu$$y`, `PU$$Y`) while handling `5 -> s` fine (`5lut`,');
L('   `pu55y` both flagged). The ported engine\'s leet map appears to lack the');
L('   `$ -> s` substitution OLD had. Concrete, fixable: add `$` to the `s` class.');
L('2. **Exactly-doubled letters are missed by NEW.** OLD tolerates up to 3 repeats');
L('   per letter and catches `fucck`, `fuuk`, `whorre`, `cuunt`, `faag`; NEW misses');
L('   all of them yet catches 3+ repeats (`fuuuck`, `fuuuuuck`, `cuuuunt`, `faaag`,');
L('   `puuuussy`). The fuzzy/elongation tolerance kicks in only at 3+ repeats,');
L('   leaving the most common real-world typo shape (one doubled letter) open.');
L('   Concrete, fixable: extend repeat-tolerance down to 2.');
L('Both patterns are regressions against OLD behavior on inputs OLD already');
L('caught -- treat as blockers for shipping NEW as the live filter.');
L('');
L('### Masking-shape drift (same flag, different output -- cosmetic, not blocking)');
L('');
L('- `f***k` -> NEW emits `f*∗*k` (one mask symbol covering two replaced chars;');
L('  looks like a span-collapse bug in the masking layer).');
L('- `nigg@` -> OLD `ni∗g@` vs NEW `n∗∗g@` (different span kept/masked).');
L('- Invisible-adjacent words: leading/trailing ZWSP/BOM/SHY shift the masked span');
L('  (`​fuck`: OLD `​f∗∗k` vs NEW `​f∗ck`; `fuck​`: OLD `f∗∗k​` vs NEW `fu∗k​`;');
L('  `­bitch`: OLD `­bi∗ch` vs NEW `­b∗∗ch`). Flagging agrees; only the mask');
L('  window differs.');
L('');
L('## Methodology');
L('');
L('- Both filters imported as ESM from `src/services/profanity.js` (NEW) and');
L('  `src/services/profanity.legacy.js` (OLD); identical `filterText(s)` signature,');
L('  synchronous, in-process, zero network.');
L('- Adversarial inputs hardcoded in this script (deterministic, re-runnable):');
L('  leet substitutions, separator insertion, invisible/format characters');
L('  (ZWSP U+200B, ZWNJ U+200C, ZWJ U+200D, soft hyphen U+00AD, BOM U+FEFF,');
L('  word joiner U+2060, invisible separator U+2063, function application U+2061),');
L('  case games, letter elongation, fuzzy/typo evasions, substring compounds,');
L('  and MUST-STAY-CLEAN controls (Scunthorpe-style + elongated clean words).');
L('- Slur spellings used are limited to forms covered by the wordlist under test');
L('  (e.g. leet variants of `nigger`/`nigga`); the fixture is a test artifact, not');
L('  user-facing copy.');
L('- "Detection" for evasion categories = `flagged === true`. Some fuzzy inputs');
L('  (oofuko, shyt, bich, dik, cok, titz, ...) and some compounds (abcfuck,');
L('  fuckyou, shitshow2, ...) are not literal wordlist entries, so a non-flag');
L('  there reflects each engine\'s fuzzy/substring reach rather than a pure miss.');
L('  A handful of "fuzzy" inputs ARE literal HARD entries (fuker, fack, phuk,');
L('  phuck, hore) and both filters are expected to catch them; `shitt` is a');
L('  literal SOFT entry and must stay clean in isolation by design.');
L('- Disagreement = flag status differs. Masked-output differences with the same');
L('  flag status are listed separately (masking-shape drift).');
L('- Controls: any `flagged === true` is reported as CRITICAL.');

// ---------------------------------------------------------------------------
// Write + print.
// ---------------------------------------------------------------------------

writeFileSync(join(HERE, 'results.md'), report);
process.stdout.write(report);
