// Benchmark: profanity.js (NEW, engine-backed) vs profanity.legacy.js (OLD, in-house).
// Usage: node bench.mjs <mode> [IMPL]
//   modes: cold | latency | throughput | memory | cache
//   IMPL: NEW | OLD   (cold and cache ignore IMPL)
// Emits one JSON object per line; assemble tables from the results.
//
// RUNS ONLY HERE: ~/workspace/anon-chat-remake-experimental/benchmarks/
// Originals under src/services/ are import-only (never written).

import { execFileSync } from 'node:child_process';

const IMPLS = {
  NEW: '/home/hatch/workspace/anon-chat-remake-experimental/src/services/profanity.js',
  OLD: '/home/hatch/workspace/anon-chat-remake-experimental/src/services/profanity.legacy.js',
};

const ms = () => Number(process.hrtime.bigint()) / 1e6;

// ---------------------------------------------------------------- corpus ---
// (a) clean 165-char chat message
const CLEAN165 = (() => {
  const base = "yo anyone up for some ranked tonight? im free after 8pm and we could run a full squad if enough people join, drop your ign below and ill add you to the lobby queue asap, no toxic vibes";
  return (base + ' '.repeat(165)).slice(0, 165);
})();
// (b) profane: 3 hard words (fuck, cunt, bitch), verified hits=3 on both
const PROFANE = 'fuck this game, that cunt stole my loot and the bitch admin banned me for no reason dude';
// (c) adversarial: leet + separators + Cf (zero-width) chars
const ADV = 'l00k at this f.u.c.king idiot, what a b1tch, go c\u200Bunt yourself rn';
const ADV_LONG = ADV + ' '.repeat(120);
// (d) 2000-char max-length message (clean, worst-case scan)
const MAX2000 = (() => {
  const s = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ';
  return (s.repeat(Math.ceil(2000 / s.length))).slice(0, 2000);
})();
// (e) empty
const EMPTY = '';

const CASES = { clean165: CLEAN165, profane: PROFANE, adversarial: ADV, max2000: MAX2000, empty: EMPTY };

function stats(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((x, y) => x + y, 0) / n;
  const q = (p) => s[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))];
  return {
    n, mean: +mean.toFixed(4), p50: +q(0.5).toFixed(4), p99: +q(0.99).toFixed(4),
    min: +s[0].toFixed(4), max: +s[n - 1].toFixed(4),
  };
}

// ------------------------------------------------------------- 1. cold -----
async function cold() {
  const out = {};
  for (const [name, path] of Object.entries(IMPLS)) {
    const times = [];
    for (let i = 0; i < 5; i++) {
      const code = `const t0=process.hrtime.bigint();const m=await import(${JSON.stringify(path)});m.filterText('hello world');console.log(Number(process.hrtime.bigint()-t0)/1e6);`;
      const r = execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
      times.push(parseFloat(r.trim()));
    }
    out[name] = { samples: times.map((t) => +t.toFixed(2)), ...stats(times) };
  }
  console.log(JSON.stringify({ mode: 'cold', node: process.version, result: out }));
}

// ----------------------------------------------------------- 2. latency ----
async function latency(name) {
  const mod = await import(IMPLS[name]);
  const res = {};
  for (const [caseName, msg] of Object.entries(CASES)) {
    for (let i = 0; i < 200; i++) mod.filterText(msg); // warmup
    const samples = new Float64Array(2000);
    for (let i = 0; i < 2000; i++) {
      const t0 = process.hrtime.bigint();
      mod.filterText(msg);
      samples[i] = Number(process.hrtime.bigint() - t0) / 1e6;
    }
    res[caseName] = stats(samples);
  }
  console.log(JSON.stringify({ mode: 'latency', impl: name, result: res }));
}

// -------------------------------------------------------- 3. throughput ----
function buildMixed(n) {
  const cleans = [
    CLEAN165,
    'gg everyone that was a fun match, shoutout to our support for the clutch heals at the end there',
    'does anyone know when the next patch drops? i heard the new map is coming this weekend maybe',
    'brb grabbing food, keep me in the party and start without me if the queue pops first ok',
    'just hit diamond finally!! took like 40 games this split but we made it lets gooo',
  ];
  const profanes = [
    PROFANE,
    'you fucking suck at this game get good you absolute cunt',
    'bitch please that was mine, fuck off and find your own lobby to troll',
  ];
  const advs = [ADV, ADV_LONG, 'h3ll yeah f_u_c_k the system, what a b1tch move tbh'];
  const msgs = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = i % 10; // deterministic 70/20/10 mix
    if (r < 7) msgs[i] = cleans[i % cleans.length] + (i % 3 === 0 ? ' #' + i : '');
    else if (r < 9) msgs[i] = profanes[i % profanes.length];
    else msgs[i] = advs[i % advs.length];
  }
  return msgs;
}

async function throughput(name) {
  const mod = await import(IMPLS[name]);
  const msgs = buildMixed(10000);
  for (let i = 0; i < 500; i++) mod.filterText(msgs[i]); // warmup
  const t0 = ms();
  for (let i = 0; i < msgs.length; i++) mod.filterText(msgs[i]);
  const total = ms() - t0;
  console.log(JSON.stringify({
    mode: 'throughput', impl: name, n: msgs.length,
    totalSec: +(total / 1000).toFixed(3), msgPerSec: Math.round(msgs.length / (total / 1000)),
  }));
}

// ------------------------------------------------------------ 4. memory -----
async function memory(name) {
  const mod = await import(IMPLS[name]);
  mod.filterText('warmup'); // settle module state
  const afterLoad = process.memoryUsage();
  const msgs = buildMixed(10000);
  for (let i = 0; i < msgs.length; i++) mod.filterText(msgs[i]);
  const afterRun = process.memoryUsage();
  const mb = (b) => +(b / 1048576).toFixed(1);
  console.log(JSON.stringify({
    mode: 'memory', impl: name,
    afterLoad: { heapMB: mb(afterLoad.heapUsed), rssMB: mb(afterLoad.rss) },
    after10k: { heapMB: mb(afterRun.heapUsed), rssMB: mb(afterRun.rss) },
  }));
}

// -------------------------------------------------------------- 5. cache ---
async function cache() {
  const mod = await import(IMPLS['NEW']);
  const msgs = buildMixed(50);
  // pass 1: cold cache
  let t0 = ms();
  for (const m of msgs) mod.filterText(m);
  const pass1 = ms() - t0;
  // pass 2: same messages again (per-word verdict cache warm)
  t0 = ms();
  for (const m of msgs) mod.filterText(m);
  const pass2 = ms() - t0;
  console.log(JSON.stringify({
    mode: 'cache', impl: 'NEW', n: 50,
    pass1ms: +pass1.toFixed(2), pass2ms: +pass2.toFixed(2),
    speedup: +(pass1 / pass2).toFixed(2),
  }));
}

// ------------------------------------------------------------------ main ---
const [mode, impl] = process.argv.slice(2);
if (mode === 'cold') await cold();
else if (mode === 'latency') await latency(impl);
else if (mode === 'throughput') await throughput(impl);
else if (mode === 'memory') await memory(impl);
else if (mode === 'cache') await cache();
else { console.error('usage: node bench.mjs <cold|latency|throughput|memory|cache> [NEW|OLD]'); process.exit(1); }
