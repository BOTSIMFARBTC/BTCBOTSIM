/**
 * TP/SL sensitivity sweep on the top-5 portfolio.
 *
 * Grid: SL floor ∈ {3, 4, 5}%, TP cap ∈ {15, 20, 25, 30}%
 * = 12 configs. Same 77-cohort × 3yr walk-forward at realism 90 each.
 *
 * Ranks configs by pooled portfolio expectancy lower-CI (conservative).
 * Winner = ship config.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const HERE = path.dirname(__filename);
const RESULTS_DIR = path.resolve(HERE, "..", "results");

function addMonths(dateStr, months) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}
function addYears(dateStr, years) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function bootstrapMean(samples, iters = 2000, alpha = 0.05, seed = 42) {
  if (samples.length === 0) return { mean: 0, lo: 0, hi: 0 };
  const rng = mulberry32(seed);
  const means = new Array(iters);
  const n = samples.length;
  for (let it = 0; it < iters; it++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += samples[Math.floor(rng() * n)];
    means[it] = sum / n;
  }
  means.sort((a, b) => a - b);
  return {
    mean: samples.reduce((a, x) => a + x, 0) / n,
    lo: means[Math.floor(iters * (alpha / 2))],
    hi: means[Math.floor(iters * (1 - alpha / 2))],
  };
}

async function runConfig({ sl_floor, sl_cap, tp_floor, tp_cap }) {
  process.env.BTC_REALISM = "90";
  process.env.BTC_SL_FLOOR = String(sl_floor);
  process.env.BTC_SL_CAP = String(sl_cap);
  process.env.BTC_TP_FLOOR = String(tp_floor);
  process.env.BTC_TP_CAP = String(tp_cap);
  const mod = await import(`../../bots-sim/markets/btc/index.mjs?cfg=${sl_floor}_${sl_cap}_${tp_floor}_${tp_cap}_${Date.now()}`);
  const { plugin, bots, buildPortfolioMembers } = mod;
  const { runSim } = await import("../../bots-sim/access-sim-core/src/harness.mjs");

  const HIST_START = "2011-01-01";
  const HIST_END = "2026-09-10";
  const enrollments = [];
  let cur = HIST_START;
  while (addYears(cur, 3) <= HIST_END) {
    enrollments.push(cur);
    cur = addMonths(cur, 2);
  }

  const returns = [];
  let trades = 0, wins = 0;
  const cohortMeans = [];

  for (const enroll of enrollments) {
    const to = addYears(enroll, 3);
    const members = buildPortfolioMembers(1000);
    const r = await runSim({
      plugin, members, bots,
      window: { from: enroll, to },
      cadenceSec: 86400, startingCapital: 1000,
    });
    for (const m of r.members) {
      for (const h of m.history) {
        if (h.exit_reason === "END_OF_SIM" || h.exit_reason === "PANIC_UNENROLL") continue;
        trades++;
        if (h.pnl > 0) wins++;
        returns.push(h.net_return_pct);
      }
    }
    cohortMeans.push(r.summary.memberOutcomes.reduce((a, x) => a + x.finalCapital, 0) / r.summary.memberOutcomes.length);
  }
  const ci = bootstrapMean(returns.map(x => x * 10000), 3000);
  const posCohorts = cohortMeans.filter(f => f > 1000).length;
  const sorted = [...cohortMeans].sort((a, b) => a - b);
  return {
    sl_floor, sl_cap, tp_floor, tp_cap,
    trades, wins, wr: trades > 0 ? wins/trades*100 : 0,
    exp: ci,
    cohorts: {
      n: cohortMeans.length,
      positive: posCohorts,
      min: sorted[0],
      median: sorted[Math.floor(sorted.length/2)],
      max: sorted.at(-1),
    },
  };
}

async function main() {
  const grid = [];
  for (const sl_floor of [0.03, 0.04, 0.05]) {
    for (const tp_cap of [0.15, 0.20, 0.25, 0.30]) {
      grid.push({ sl_floor, sl_cap: 0.08, tp_floor: 0.08, tp_cap });
    }
  }
  console.log(`\n═══ TP/SL SENSITIVITY SWEEP (top-5, realism 90, ${grid.length} configs) ═══`);

  const results = [];
  const t0 = Date.now();
  for (const cfg of grid) {
    const r = await runConfig(cfg);
    results.push(r);
    console.log(
      `  SL[${(cfg.sl_floor*100).toFixed(0)}-${(cfg.sl_cap*100).toFixed(0)}] TP[${(cfg.tp_floor*100).toFixed(0)}-${(cfg.tp_cap*100).toFixed(0)}]  ` +
      `trades ${String(r.trades).padStart(5)}  WR ${r.wr.toFixed(1).padStart(5)}%  exp ${r.exp.mean.toFixed(0).padStart(4)}bp [${r.exp.lo.toFixed(0)}, ${r.exp.hi.toFixed(0)}]  ` +
      `coh ${r.cohorts.positive}/${r.cohorts.n} med $${r.cohorts.median.toFixed(0)}`
    );
  }
  console.log(`Elapsed: ${((Date.now()-t0)/1000).toFixed(1)}s`);

  // Rank by lower CI (most conservative)
  const ranked = [...results].sort((a, b) => b.exp.lo - a.exp.lo);
  console.log("\n" + "═".repeat(100));
  console.log("WINNER (highest lower-CI expectancy):");
  console.log("═".repeat(100));
  const w = ranked[0];
  console.log(`  SL floor ${(w.sl_floor*100).toFixed(0)}%  SL cap ${(w.sl_cap*100).toFixed(0)}%  TP floor ${(w.tp_floor*100).toFixed(0)}%  TP cap ${(w.tp_cap*100).toFixed(0)}%`);
  console.log(`  ${w.trades} trades, WR ${w.wr.toFixed(1)}%, exp ${w.exp.mean.toFixed(0)}bp [95% CI ${w.exp.lo.toFixed(0)}, ${w.exp.hi.toFixed(0)}]`);
  console.log(`  Cohorts positive: ${w.cohorts.positive}/${w.cohorts.n}, median $${w.cohorts.median.toFixed(0)}`);

  await fs.writeFile(path.join(RESULTS_DIR, "tpsl-grid.json"), JSON.stringify({
    ranAt: new Date().toISOString(),
    grid: results,
    winner: w,
  }, null, 2));
  console.log(`\nWrote btc-bot-sim/results/tpsl-grid.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
