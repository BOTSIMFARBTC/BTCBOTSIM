/**
 * Mutation micro-search: perturb each of the 5 top genomes and see if
 * any mutant beats its parent's expectancy (lower CI) on the 77-cohort
 * walk-forward.
 *
 * Gaussian σ=0.03 per dimension, 25 mutants per parent = 125 evals.
 * Uses realism 90 + regime filter + trailing stops + SL cooldown.
 *
 * If any mutant wins by > 5% lower-CI expectancy, replace parent in
 * portfolio-genomes.json.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSim } from "../../bots-sim/access-sim-core/src/harness.mjs";
import {
  plugin,
  _scoreForOpen, _regimeAtIdx, _regimeSizeMultiplier, _barIdxByDate, _decodeGenome,
} from "../../bots-sim/markets/btc/index.mjs";

const __filename = fileURLToPath(import.meta.url);
const HERE = path.dirname(__filename);
const RESULTS_DIR = path.resolve(HERE, "..", "results");
const PG_PATH = path.resolve(HERE, "..", "..", "bots-sim", "markets", "btc", "portfolio-genomes.json");

const SL_FLOOR = Number(process.env.BTC_SL_FLOOR ?? 0.03);
const SL_CAP   = Number(process.env.BTC_SL_CAP   ?? 0.08);
const TP_FLOOR = Number(process.env.BTC_TP_FLOOR ?? 0.08);
const TP_CAP   = Number(process.env.BTC_TP_CAP   ?? 0.30);
const REGIME_FILTER = Number(process.env.BTC_REGIME_FILTER ?? 1) === 1;
const SL_COOLDOWN = Number(process.env.BTC_SL_COOLDOWN ?? 1) === 1;

function addMonths(d, m) { const x = new Date(d + "T00:00:00Z"); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); }
function addYears(d, y) { const x = new Date(d + "T00:00:00Z"); x.setUTCFullYear(x.getUTCFullYear() + y); return x.toISOString().slice(0, 10); }

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => { t = (t + 0x6D2B79F5) >>> 0; let r = t; r = Math.imul(r ^ (r >>> 15), r | 1); r ^= r + Math.imul(r ^ (r >>> 7), r | 61); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
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
  return { mean: samples.reduce((a, x) => a + x, 0) / n, lo: means[Math.floor(iters * (alpha / 2))], hi: means[Math.floor(iters * (1 - alpha / 2))] };
}
function gaussian(rng) { let u = 0, v = 0; while (u === 0) u = rng(); while (v === 0) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function mutate(genome, sigma, seed) {
  const rng = mulberry32(seed);
  return genome.map((g) => Math.max(0, Math.min(1, g + gaussian(rng) * sigma)));
}

// Build a single-bot registration matching the plugin's decisionFor logic
function buildBotForGenome(genome, label) {
  const decoded = _decodeGenome(genome);
  const slPct = Math.max(SL_FLOOR, Math.min(SL_CAP, decoded.stop_loss_pct));
  const tpPct = Math.max(TP_FLOOR, Math.min(TP_CAP, decoded.take_profit_pct));
  const botId = `mutant-${label}`;
  return {
    id: botId,
    execution_mode: "independent",
    async decisionFor(member, bar, tickTs) {
      if (member.positions.length > 0) return null;
      const idx = _barIdxByDate().get(bar.date ?? bar.ts_utc?.slice(0, 10));
      if (idx == null) return null;
      let daysSinceExit = 999, consecutiveSL = 0;
      for (let i = member.history.length - 1; i >= 0; i--) {
        const h = member.history[i];
        if (h.strategy !== botId) continue;
        if (daysSinceExit === 999) daysSinceExit = Math.floor((new Date(tickTs).getTime() - new Date(h.exit_ts).getTime()) / 86400000);
        const isSL = h.exit_reason === "SL" || h.exit_reason === "GAP_SL" || h.exit_reason === "SL_TIE";
        if (isSL) consecutiveSL++; else break;
      }
      let cool = decoded.cooldown_days;
      if (SL_COOLDOWN && consecutiveSL >= 3) cool += 30;
      if (daysSinceExit < cool) return null;
      const s = _scoreForOpen(decoded, idx);
      if (!s || s.score < decoded.entry_conf_threshold || s.sizingMultiplier <= 0) return null;
      let regimeMult = 1;
      if (REGIME_FILTER) {
        regimeMult = _regimeSizeMultiplier(_regimeAtIdx(idx));
        if (regimeMult <= 0) return null;
      }
      return {
        direction: "BULL", confidence: Math.round(s.score * 100),
        sl_pct: slPct, tp_pct: tpPct, maxHoldHours: decoded.max_hold_days * 24,
        strategyName: botId, sourceSignalId: `${botId}_${bar.date}`,
        _regimeMult: regimeMult,
      };
    },
  };
}

async function evaluate(genome, label) {
  const HIST_START = "2011-01-01", HIST_END = "2026-09-10";
  const enrollments = [];
  let cur = HIST_START;
  while (addYears(cur, 3) <= HIST_END) { enrollments.push(cur); cur = addMonths(cur, 2); }

  const bot = buildBotForGenome(genome, label);
  const memberCfg = {
    address: `0xMUT_${label}`, bot_id: bot.id,
    execution_mode: "independent",
    autoMode: "MIRROR", minConfidence: 0, allowedDirection: "BULL_ONLY",
    maxLeverage: 1, maxNotionalUsdc: 500, maxDailyTrades: 999,
    maxConcurrent: 1, sizingMode: "PCT_OF_CAPITAL", sizingParam: 0.5,
  };
  const returns = [];
  let trades = 0, wins = 0;
  const cohortMeans = [];
  for (const enroll of enrollments) {
    const to = addYears(enroll, 3);
    const r = await runSim({
      plugin, members: [memberCfg], bots: [bot],
      window: { from: enroll, to }, cadenceSec: 86400, startingCapital: 1000,
    });
    for (const m of r.members) {
      for (const h of m.history) {
        if (h.exit_reason === "END_OF_SIM" || h.exit_reason === "PANIC_UNENROLL") continue;
        trades++; if (h.pnl > 0) wins++;
        returns.push(h.net_return_pct);
      }
    }
    cohortMeans.push(r.summary.memberOutcomes[0]?.finalCapital ?? 1000);
  }
  return {
    trades, wins, wr: trades > 0 ? wins / trades * 100 : 0,
    ci: bootstrapMean(returns.map(x => x * 10000)),
    posCohorts: cohortMeans.filter(f => f > 1000).length,
    cohortMedian: [...cohortMeans].sort((a, b) => a - b)[Math.floor(cohortMeans.length / 2)],
  };
}

async function main() {
  const N_MUTANTS = 25;
  const SIGMA = 0.03;
  const IMPROVEMENT_THRESHOLD = 0.05; // 5% lower-CI expectancy

  const pg = JSON.parse(readFileSync(PG_PATH, "utf8"));
  const parents = pg.top5;
  console.log(`\n═══ MUTATION MICRO-SEARCH (${N_MUTANTS} mutants × ${parents.length} parents, σ=${SIGMA}) ═══`);

  const t0 = Date.now();
  const results = [];
  let anyImproved = false;

  for (const parent of parents) {
    console.log(`\nParent: ${parent.label}`);
    const parentEval = await evaluate(parent.genome, `parent-${parent.label}`);
    console.log(`  parent: ${parentEval.trades} trades, WR ${parentEval.wr.toFixed(1)}%, exp ${parentEval.ci.mean.toFixed(0)}bp [${parentEval.ci.lo.toFixed(0)}, ${parentEval.ci.hi.toFixed(0)}]  pos ${parentEval.posCohorts}/77  med $${parentEval.cohortMedian.toFixed(0)}`);
    let best = { ci: parentEval.ci, eval: parentEval, genome: parent.genome, label: `parent` };
    for (let i = 0; i < N_MUTANTS; i++) {
      const seed = (parent.label + "_" + i).split("").reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 0);
      const mutant = mutate(parent.genome, SIGMA, seed);
      const ev = await evaluate(mutant, `${parent.label}_m${i}`);
      if (ev.ci.lo > best.ci.lo) {
        best = { ci: ev.ci, eval: ev, genome: mutant, label: `mutant-${i}` };
        console.log(`  ${best.label.padEnd(12)}: ${ev.trades} trades, WR ${ev.wr.toFixed(1)}%, exp ${ev.ci.mean.toFixed(0)}bp [${ev.ci.lo.toFixed(0)}, ${ev.ci.hi.toFixed(0)}]  pos ${ev.posCohorts}/77`);
      }
    }
    const improvedBy = (best.ci.lo - parentEval.ci.lo) / Math.max(1, Math.abs(parentEval.ci.lo));
    console.log(`  → winner: ${best.label}  Δlower-CI ${(best.ci.lo - parentEval.ci.lo).toFixed(0)}bp (${(improvedBy * 100).toFixed(1)}%)`);
    results.push({ parentLabel: parent.label, parentCi: parentEval.ci, best });
    if (improvedBy > IMPROVEMENT_THRESHOLD) {
      anyImproved = true;
      console.log(`  ★ IMPROVEMENT ADOPTED (> ${IMPROVEMENT_THRESHOLD*100}% threshold)`);
    } else {
      console.log(`  (no improvement above threshold; keeping parent)`);
    }
  }
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nElapsed: ${elapsedSec}s`);

  if (anyImproved) {
    // Update portfolio-genomes.json with adopted mutants
    const newTop5 = results.map((r, i) => {
      const parent = parents[i];
      const improved = (r.best.ci.lo - r.parentCi.lo) / Math.max(1, Math.abs(r.parentCi.lo)) > IMPROVEMENT_THRESHOLD;
      return {
        label: improved ? `${parent.label}-mut${r.best.label.split('-')[1]}` : parent.label,
        val_calmar: parent.val_calmar,
        genome: improved ? r.best.genome : parent.genome,
      };
    });
    const updated = { ...pg, session3_5_mutation: true, top5: newTop5 };
    writeFileSync(PG_PATH, JSON.stringify(updated, null, 2));
    console.log(`\nWrote refined portfolio-genomes.json`);
  } else {
    console.log(`\nNo mutants improved parents by > ${IMPROVEMENT_THRESHOLD*100}% — genomes unchanged.`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
