/**
 * Multi-generation mutation search. Each generation:
 *   - Generate N_MUTANTS mutants from current parent (gaussian σ)
 *   - Evaluate all on 77-cohort walk-forward
 *   - Best mutant that beats parent by > threshold becomes next-gen parent
 *   - σ decays across generations for finer exploration
 *
 * Also enforces: mutant must maintain positive-cohort count within
 * TOLERANCE of parent (don't trade cohort-safety for edge).
 *
 * CLI: node 19-multi-gen-mutation.mjs [gens=3] [mutantsPerGen=30]
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
const CONF_ENABLED = Number(process.env.BTC_CONF_SIZING ?? 1) === 1;
const CONF_HIGH = Number(process.env.BTC_CONF_HIGH ?? 0.85);
const CONF_HIGH_MULT = Number(process.env.BTC_CONF_HIGH_MULT ?? 1.4);
const CONF_LOW = Number(process.env.BTC_CONF_LOW ?? 0.75);
const CONF_LOW_MULT = Number(process.env.BTC_CONF_LOW_MULT ?? 0.6);
function confMult(score) {
  if (!CONF_ENABLED) return 1;
  if (score >= CONF_HIGH) return CONF_HIGH_MULT;
  if (score < CONF_LOW) return CONF_LOW_MULT;
  return 1;
}

function addMonths(d, m) { const x = new Date(d + "T00:00:00Z"); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); }
function addYears(d, y) { const x = new Date(d + "T00:00:00Z"); x.setUTCFullYear(x.getUTCFullYear() + y); return x.toISOString().slice(0, 10); }
function mulberry32(seed) { let t = seed >>> 0; return () => { t = (t + 0x6D2B79F5) >>> 0; let r = t; r = Math.imul(r ^ (r >>> 15), r | 1); r ^= r + Math.imul(r ^ (r >>> 7), r | 61); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; }
function bootstrapMean(samples, iters = 2000, alpha = 0.05, seed = 42) {
  if (samples.length === 0) return { mean: 0, lo: 0, hi: 0 };
  const rng = mulberry32(seed);
  const means = new Array(iters); const n = samples.length;
  for (let it = 0; it < iters; it++) { let sum = 0; for (let i = 0; i < n; i++) sum += samples[Math.floor(rng() * n)]; means[it] = sum / n; }
  means.sort((a, b) => a - b);
  return { mean: samples.reduce((a, x) => a + x, 0) / n, lo: means[Math.floor(iters * (alpha / 2))], hi: means[Math.floor(iters * (1 - alpha / 2))] };
}
function gaussian(rng) { let u = 0, v = 0; while (u === 0) u = rng(); while (v === 0) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function mutate(genome, sigma, seed) {
  const rng = mulberry32(seed);
  return genome.map(g => Math.max(0, Math.min(1, g + gaussian(rng) * sigma)));
}

function buildBot(genome, label) {
  const decoded = _decodeGenome(genome);
  const slPct = Math.max(SL_FLOOR, Math.min(SL_CAP, decoded.stop_loss_pct));
  const tpPct = Math.max(TP_FLOOR, Math.min(TP_CAP, decoded.take_profit_pct));
  const botId = `mutant-${label}`;
  return {
    id: botId, execution_mode: "independent",
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
      let regimeMultVal = 1;
      if (REGIME_FILTER) { regimeMultVal = _regimeSizeMultiplier(_regimeAtIdx(idx)); if (regimeMultVal <= 0) return null; }
      member._pendingMult = regimeMultVal * confMult(s.score);
      return {
        direction: "BULL", confidence: Math.round(s.score * 100),
        sl_pct: slPct, tp_pct: tpPct, maxHoldHours: decoded.max_hold_days * 24,
        strategyName: botId, sourceSignalId: `${botId}_${bar.date}`,
      };
    },
  };
}

async function evaluate(genome, label) {
  const enrollments = [];
  let cur = "2011-01-01";
  while (addYears(cur, 3) <= "2026-09-10") { enrollments.push(cur); cur = addMonths(cur, 2); }
  const bot = buildBot(genome, label);
  const memberCfg = {
    address: `0xMUT_${label}`, bot_id: bot.id,
    execution_mode: "independent", autoMode: "MIRROR", minConfidence: 0,
    allowedDirection: "BULL_ONLY", maxLeverage: 1, maxNotionalUsdc: 500,
    maxDailyTrades: 999, maxConcurrent: 1, sizingMode: "PCT_OF_CAPITAL", sizingParam: 0.5,
  };
  const returns = []; let trades = 0, wins = 0;
  const cohortMeans = [];
  for (const enroll of enrollments) {
    const to = addYears(enroll, 3);
    const r = await runSim({ plugin, members: [memberCfg], bots: [bot], window: { from: enroll, to }, cadenceSec: 86400, startingCapital: 1000 });
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
  const N_GENS = Number(process.argv[2] ?? 3);
  const N_MUTANTS = Number(process.argv[3] ?? 30);
  const SIGMAS = [0.06, 0.04, 0.025].slice(0, N_GENS);
  const IMPROVEMENT_THRESHOLD = 0.03;   // 3% lower-CI
  const POS_COH_TOLERANCE = 2;          // mutant may lose up to 2 positive cohorts vs parent

  const pg = JSON.parse(readFileSync(PG_PATH, "utf8"));
  const parents = pg.top5;
  console.log(`\n═══ MULTI-GEN MUTATION (${N_GENS} gens × ${N_MUTANTS} mutants, σ decay ${SIGMAS.join('→')}) ═══`);

  const t0 = Date.now();
  const finalWinners = [];

  for (const parentSpec of parents) {
    console.log(`\n╔ Parent: ${parentSpec.label} ═════════════════════════════`);
    let currentGenome = parentSpec.genome;
    let currentLabel = parentSpec.label;
    let currentEval = await evaluate(currentGenome, `orig-${parentSpec.label}`);
    console.log(`  gen0 (parent): ${currentEval.trades}t  WR ${currentEval.wr.toFixed(1)}%  exp ${currentEval.ci.mean.toFixed(0)}bp [${currentEval.ci.lo.toFixed(0)}]  pos ${currentEval.posCohorts}/77`);
    let totalImprovementBp = 0;

    for (let g = 0; g < N_GENS; g++) {
      const sigma = SIGMAS[g];
      let bestMutant = null, bestEval = currentEval;
      for (let m = 0; m < N_MUTANTS; m++) {
        const seed = (currentLabel + `_g${g}_m${m}`).split("").reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 0);
        const mutant = mutate(currentGenome, sigma, seed);
        const ev = await evaluate(mutant, `${parentSpec.label}_g${g}_m${m}`);
        const lowerCiGain = ev.ci.lo - currentEval.ci.lo;
        const gainPct = lowerCiGain / Math.max(1, Math.abs(currentEval.ci.lo));
        const cohortCost = currentEval.posCohorts - ev.posCohorts;
        // Accept only if:
        //  - lower-CI improved by > threshold
        //  - AND positive-cohort count didn't drop more than tolerance
        if (gainPct > IMPROVEMENT_THRESHOLD && cohortCost <= POS_COH_TOLERANCE && ev.ci.lo > bestEval.ci.lo) {
          bestMutant = { mutant, ev, mIdx: m };
          bestEval = ev;
        }
      }
      if (bestMutant) {
        totalImprovementBp += (bestMutant.ev.ci.lo - currentEval.ci.lo);
        currentGenome = bestMutant.mutant;
        currentLabel = `${parentSpec.label}-g${g}m${bestMutant.mIdx}`;
        currentEval = bestMutant.ev;
        console.log(`  gen${g+1} (σ=${sigma}): ADOPTED m${bestMutant.mIdx}  → ${currentEval.trades}t  WR ${currentEval.wr.toFixed(1)}%  exp ${currentEval.ci.mean.toFixed(0)}bp [${currentEval.ci.lo.toFixed(0)}]  pos ${currentEval.posCohorts}/77`);
      } else {
        console.log(`  gen${g+1} (σ=${sigma}): no improvement`);
      }
    }

    console.log(`  ═> total improvement: ${totalImprovementBp.toFixed(0)}bp lower-CI (${(totalImprovementBp / Math.max(1, Math.abs(parents.find(p=>p.label===parentSpec.label) ? 0 : 1)) * 100).toFixed(1)}%)`);
    finalWinners.push({
      parentLabel: parentSpec.label,
      finalLabel: currentLabel,
      finalGenome: currentGenome,
      finalEval: currentEval,
      improvedFromParent: currentLabel !== parentSpec.label,
    });
  }
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nElapsed: ${elapsedSec}s (${(N_GENS * N_MUTANTS * parents.length)} evals)`);

  // Update portfolio-genomes.json if any winners improved
  const anyImproved = finalWinners.some(w => w.improvedFromParent);
  if (anyImproved) {
    const newTop5 = finalWinners.map((w, i) => ({
      label: w.finalLabel,
      val_calmar: parents[i].val_calmar,
      genome: w.finalGenome,
    }));
    writeFileSync(PG_PATH, JSON.stringify({ ...pg, session5_multigen: true, top5: newTop5 }, null, 2));
    console.log(`Wrote refined portfolio-genomes.json`);
  } else {
    console.log(`No improvements — genomes unchanged.`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
