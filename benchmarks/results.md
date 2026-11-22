# Profanity filter adversarial-evasion benchmark (2026-09-21)

OLD = `src/services/profanity.legacy.js` (in-house regex/leet filter).
NEW = `src/services/profanity.js` (engine-backed detection, legacy masking semantics).
`filterText(s) -> { text, flagged, hits }` on both; no network, no Discord, no tokens.

## Detection-rate table (higher = better for evasion categories)

| Category | n | OLD flagged | NEW flagged | OLD rate | NEW rate | NEW-only wins | NEW-only misses |
|---|---|---|---|---|---|---|---|
| leet | 57 | 30 | 55 | 52.6% | 96.5% | 25 | 0 |
| separator | 46 | 31 | 41 | 67.4% | 89.1% | 10 | 0 |
| invisible | 39 | 4 | 24 | 10.3% | 61.5% | 20 | 0 |
| case | 28 | 23 | 28 | 82.1% | 100.0% | 5 | 0 |
| elongation | 46 | 23 | 42 | 50.0% | 91.3% | 19 | 0 |
| fuzzy | 50 | 21 | 30 | 42.0% | 60.0% | 9 | 0 |
| compound | 28 | 11 | 18 | 39.3% | 64.3% | 7 | 0 |

## Control category (MUST-STAY-CLEAN; higher clean-rate = better)

| Category | n | OLD clean | NEW clean | OLD clean-rate | NEW clean-rate |
|---|---|---|---|---|---|
| controls | 24 | 24 | 24 | 100.0% | 100.0% |

**CRITICAL control violations:** OLD=0, NEW=0

## Disagreements (flag status differs)

Total: 95 of 318 inputs.

| # | Category | Input | OLD flagged | OLD output | NEW flagged | NEW output |
|---|---|---|---|---|---|---|
| 1 | leet | "sh1t" | false | "sh1t" | true | "s∗∗t" |
| 2 | leet | "sh!t" | false | "sh!t" | true | "s∗∗t" |
| 3 | leet | "5h1t" | false | "5h1t" | true | "5∗∗t" |
| 4 | leet | "$h1t" | false | "$h1t" | true | "$∗∗t" |
| 5 | leet | "sh1+" | false | "sh1+" | true | "s∗∗+" |
| 6 | leet | "$h!t" | false | "$h!t" | true | "$∗∗t" |
| 7 | leet | "5h17" | false | "5h17" | true | "5∗∗7" |
| 8 | leet | "5hit" | false | "5hit" | true | "5∗∗t" |
| 9 | leet | "shi7" | false | "shi7" | true | "s∗∗7" |
| 10 | leet | "sh1t" | false | "sh1t" | true | "s∗∗t" |
| 11 | leet | "f*ck" | false | "f*ck" | true | "f∗∗k" |
| 12 | leet | "f**k" | false | "f**k" | true | "f∗∗k" |
| 13 | leet | "f***k" | false | "f***k" | true | "f*∗*k" |
| 14 | leet | "@ss" | false | "@ss" | true | "@∗s" |
| 15 | leet | "a$$" | false | "a$$" | true | "a∗$" |
| 16 | leet | "4ss" | false | "4ss" | true | "4∗s" |
| 17 | leet | "455" | false | "455" | true | "4∗5" |
| 18 | leet | "a5s" | false | "a5s" | true | "a∗s" |
| 19 | leet | "@5$" | false | "@5$" | true | "@∗$" |
| 20 | leet | "c*nt" | false | "c*nt" | true | "c∗∗t" |
| 21 | leet | "kun7" | false | "kun7" | true | "k∗∗7" |
| 22 | leet | "c0c\|<" | false | "c0c\|<" | true | "c∗c\|<" |
| 23 | leet | "d1c\|<" | false | "d1c\|<" | true | "d∗c\|<" |
| 24 | leet | "p$$y" | false | "p$$y" | true | "p∗∗y" |
| 25 | leet | "sl*t" | false | "sl*t" | true | "s∗∗t" |
| 26 | separator | "s.h.i.t" | false | "s.h.i.t" | true | "s.∗∗∗.t" |
| 27 | separator | "s-h-i-t" | false | "s-h-i-t" | true | "s-∗∗∗-t" |
| 28 | separator | "s_h_i_t" | false | "s_h_i_t" | true | "s_∗∗∗_t" |
| 29 | separator | "s*h*i*t" | false | "s*h*i*t" | true | "s*∗∗∗*t" |
| 30 | separator | "s\|h\|i\|t" | false | "s\|h\|i\|t" | true | "s\|∗∗∗\|t" |
| 31 | separator | "a.s.s" | false | "a.s.s" | true | "a.∗.s" |
| 32 | separator | "a-s-s" | false | "a-s-s" | true | "a-∗-s" |
| 33 | separator | "a_s_s" | false | "a_s_s" | true | "a_∗_s" |
| 34 | separator | "a*s*s" | false | "a*s*s" | true | "a*∗*s" |
| 35 | separator | "f#u#c#k" | false | "f#u#c#k" | true | "f#∗∗∗#k" |
| 36 | invisible | "f​u​c​k" | false | "f​u​c​k" | true | "f​∗∗∗​k" |
| 37 | invisible | "b​i​t​c​h" | false | "b​i​t​c​h" | true | "b​∗∗∗∗∗​h" |
| 38 | invisible | "c​u​n​t" | false | "c​u​n​t" | true | "c​∗∗∗​t" |
| 39 | invisible | "f‌u‌c‌k" | false | "f‌u‌c‌k" | true | "f‌∗∗∗‌k" |
| 40 | invisible | "b‌i‌t‌c‌h" | false | "b‌i‌t‌c‌h" | true | "b‌∗∗∗∗∗‌h" |
| 41 | invisible | "c‌u‌n‌t" | false | "c‌u‌n‌t" | true | "c‌∗∗∗‌t" |
| 42 | invisible | "f‍u‍c‍k" | false | "f‍u‍c‍k" | true | "f‍∗∗∗‍k" |
| 43 | invisible | "b‍i‍t‍c‍h" | false | "b‍i‍t‍c‍h" | true | "b‍∗∗∗∗∗‍h" |
| 44 | invisible | "c‍u‍n‍t" | false | "c‍u‍n‍t" | true | "c‍∗∗∗‍t" |
| 45 | invisible | "f­u­c­k" | false | "f­u­c­k" | true | "f­∗∗∗­k" |
| 46 | invisible | "b­i­t­c­h" | false | "b­i­t­c­h" | true | "b­∗∗∗∗∗­h" |
| 47 | invisible | "c­u­n­t" | false | "c­u­n­t" | true | "c­∗∗∗­t" |
| 48 | invisible | "f﻿u﻿c﻿k" | false | "f﻿u﻿c﻿k" | true | "f﻿∗∗∗﻿k" |
| 49 | invisible | "b﻿i﻿t﻿c﻿h" | false | "b﻿i﻿t﻿c﻿h" | true | "b﻿∗∗∗∗∗﻿h" |
| 50 | invisible | "c﻿u﻿n﻿t" | false | "c﻿u﻿n﻿t" | true | "c﻿∗∗∗﻿t" |
| 51 | invisible | "f⁠u⁠c⁠k" | false | "f⁠u⁠c⁠k" | true | "f⁠∗∗∗⁠k" |
| 52 | invisible | "b⁣i⁣t⁣c⁣h" | false | "b⁣i⁣t⁣c⁣h" | true | "b⁣∗∗∗∗∗⁣h" |
| 53 | invisible | "f⁡u⁡c⁡k" | false | "f⁡u⁡c⁡k" | true | "f⁡∗∗∗⁡k" |
| 54 | invisible | "fu​ck" | false | "fu​ck" | true | "fu∗ck" |
| 55 | invisible | "bi⁠tch" | false | "bi⁠tch" | true | "bi∗∗ch" |
| 56 | case | "SH1T" | false | "SH1T" | true | "S∗∗T" |
| 57 | case | "aSs" | false | "aSs" | true | "a∗s" |
| 58 | case | "SHIT" | false | "SHIT" | true | "S∗∗T" |
| 59 | case | "ASS" | false | "ASS" | true | "A∗S" |
| 60 | case | "aSS" | false | "aSS" | true | "a∗S" |
| 61 | elongation | "fuuuuck" | false | "fuuuuck" | true | "fu∗∗∗ck" |
| 62 | elongation | "fuuuuuck" | false | "fuuuuuck" | true | "fu∗∗∗∗ck" |
| 63 | elongation | "fuuuuuuck" | false | "fuuuuuuck" | true | "fu∗∗∗∗∗ck" |
| 64 | elongation | "fuuuuuuuuuck" | false | "fuuuuuuuuuck" | true | "fu∗∗∗∗∗∗∗∗ck" |
| 65 | elongation | "shiiit" | false | "shiiit" | true | "sh∗∗it" |
| 66 | elongation | "sshit" | false | "sshit" | true | "ss∗it" |
| 67 | elongation | "sshhit" | false | "sshhit" | true | "ss∗∗it" |
| 68 | elongation | "biiiitch" | false | "biiiitch" | true | "bi∗∗∗∗ch" |
| 69 | elongation | "biiiiitch" | false | "biiiiitch" | true | "bi∗∗∗∗∗ch" |
| 70 | elongation | "biiiiiiiiiitch" | false | "biiiiiiiiiitch" | true | "bi∗∗∗∗∗∗∗∗∗∗ch" |
| 71 | elongation | "aaass" | false | "aaass" | true | "aa∗ss" |
| 72 | elongation | "aaasss" | false | "aaasss" | true | "aa∗∗ss" |
| 73 | elongation | "assss" | false | "assss" | true | "as∗ss" |
| 74 | elongation | "aasss" | false | "aasss" | true | "aa∗ss" |
| 75 | elongation | "cuuuunt" | false | "cuuuunt" | true | "cu∗∗∗nt" |
| 76 | elongation | "cuuuuuunt" | false | "cuuuuuunt" | true | "cu∗∗∗∗∗nt" |
| 77 | elongation | "coooock" | false | "coooock" | true | "co∗∗∗ck" |
| 78 | elongation | "diiiick" | false | "diiiick" | true | "di∗∗∗ck" |
| 79 | elongation | "puuuussy" | false | "puuuussy" | true | "pu∗∗∗∗sy" |
| 80 | fuzzy | "oofuko" | false | "oofuko" | true | "oo∗∗ko" |
| 81 | fuzzy | "fukr" | false | "fukr" | true | "f∗∗r" |
| 82 | fuzzy | "fukc" | false | "fukc" | true | "f∗∗c" |
| 83 | fuzzy | "fukkr" | false | "fukkr" | true | "fu∗kr" |
| 84 | fuzzy | "shitt" | false | "shitt" | true | "sh∗tt" |
| 85 | fuzzy | "slutty" | false | "slutty" | true | "sl∗∗ty" |
| 86 | fuzzy | "titz" | false | "titz" | true | "t∗∗z" |
| 87 | fuzzy | "pussie" | false | "pussie" | true | "pu∗∗ie" |
| 88 | fuzzy | "nigge" | false | "nigge" | true | "ni∗ge" |
| 89 | compound | "abcfuck" | false | "abcfuck" | true | "ab∗∗∗ck" |
| 90 | compound | "fuckyou" | false | "fuckyou" | true | "fu∗∗∗ou" |
| 91 | compound | "fuckfuck" | false | "fuckfuck" | true | "fu∗∗∗∗ck" |
| 92 | compound | "dumbfuck" | false | "dumbfuck" | true | "du∗∗∗∗ck" |
| 93 | compound | "cuntface" | false | "cuntface" | true | "cu∗∗∗∗ce" |
| 94 | compound | "bitchslap" | false | "bitchslap" | true | "bi∗∗∗∗∗ap" |
| 95 | compound | "cockblock" | false | "cockblock" | true | "co∗∗∗∗∗ck" |

## Same-flag but different masked output

Total: 3.

| # | Category | Input | OLD output | NEW output |
|---|---|---|---|---|
| 1 | leet | "nigg@" | "ni∗g@" | "n∗∗g@" |
| 2 | compound | "assfuck" | "assf∗∗k" | "a∗sf∗∗k" |
| 3 | compound | "shitskin" | "sh∗∗∗∗in" | "s∗∗tskin" |

## Verdict

- NEW-only wins (NEW flagged, OLD missed): **95** inputs.
- NEW-only misses (OLD flagged, NEW missed): **0** inputs -- none, no blocker.
- Control violations: OLD=0, NEW=0 -- none.

### NEW-only miss patterns (verified by targeted probing, 2026-09-21)

1. **`$` is not folded to `s` by NEW.** OLD folds `$ -> s` (`$lut` -> `slut`,
   `pu$$y` -> `pussy`, `$$lut` -> `slut` all flagged); NEW misses every `$`-form
   (`$lut`, `$$lut`, `pu$$y`, `PU$$Y`) while handling `5 -> s` fine (`5lut`,
   `pu55y` both flagged). The ported engine's leet map appears to lack the
   `$ -> s` substitution OLD had. Concrete, fixable: add `$` to the `s` class.
2. **Exactly-doubled letters are missed by NEW.** OLD tolerates up to 3 repeats
   per letter and catches `fucck`, `fuuk`, `whorre`, `cuunt`, `faag`; NEW misses
   all of them yet catches 3+ repeats (`fuuuck`, `fuuuuuck`, `cuuuunt`, `faaag`,
   `puuuussy`). The fuzzy/elongation tolerance kicks in only at 3+ repeats,
   leaving the most common real-world typo shape (one doubled letter) open.
   Concrete, fixable: extend repeat-tolerance down to 2.
Both patterns are regressions against OLD behavior on inputs OLD already
caught -- treat as blockers for shipping NEW as the live filter.

### Masking-shape drift (same flag, different output -- cosmetic, not blocking)

- `f***k` -> NEW emits `f*∗*k` (one mask symbol covering two replaced chars;
  looks like a span-collapse bug in the masking layer).
- `nigg@` -> OLD `ni∗g@` vs NEW `n∗∗g@` (different span kept/masked).
- Invisible-adjacent words: leading/trailing ZWSP/BOM/SHY shift the masked span
  (`​fuck`: OLD `​f∗∗k` vs NEW `​f∗ck`; `fuck​`: OLD `f∗∗k​` vs NEW `fu∗k​`;
  `­bitch`: OLD `­bi∗ch` vs NEW `­b∗∗ch`). Flagging agrees; only the mask
  window differs.

## Methodology

- Both filters imported as ESM from `src/services/profanity.js` (NEW) and
  `src/services/profanity.legacy.js` (OLD); identical `filterText(s)` signature,
  synchronous, in-process, zero network.
- Adversarial inputs hardcoded in this script (deterministic, re-runnable):
  leet substitutions, separator insertion, invisible/format characters
  (ZWSP U+200B, ZWNJ U+200C, ZWJ U+200D, soft hyphen U+00AD, BOM U+FEFF,
  word joiner U+2060, invisible separator U+2063, function application U+2061),
  case games, letter elongation, fuzzy/typo evasions, substring compounds,
  and MUST-STAY-CLEAN controls (Scunthorpe-style + elongated clean words).
- Slur spellings used are limited to forms covered by the wordlist under test
  (e.g. leet variants of `nigger`/`nigga`); the fixture is a test artifact, not
  user-facing copy.
- "Detection" for evasion categories = `flagged === true`. Some fuzzy inputs
  (oofuko, shyt, bich, dik, cok, titz, ...) and some compounds (abcfuck,
  fuckyou, shitshow2, ...) are not literal wordlist entries, so a non-flag
  there reflects each engine's fuzzy/substring reach rather than a pure miss.
  A handful of "fuzzy" inputs ARE literal HARD entries (fuker, fack, phuk,
  phuck, hore) and both filters are expected to catch them; `shitt` is a
  literal SOFT entry and must stay clean in isolation by design.
- Disagreement = flag status differs. Masked-output differences with the same
  flag status are listed separately (masking-shape drift).
- Controls: any `flagged === true` is reported as CRITICAL.
