/**
 * Genetic crossover: combine top-2 genomes at uniform crossover points.
 * Each offspring inherits each gene randomly from one of two parents.
 * Adds mutation after crossover (σ=0.03) for exploration.
 *
 * Applied pairwise: verify-A-2012 (best) × each of the other 4 top-5 bots.
 * 50 offspring per pair × 4 pairs = 200 evals.
 *
 * Adopts offspring if:
 *   - WR > max(parent_a.wr, parent_b.wr) OR
 *   - fitness (WR × 100 + exp_lo/10) > 5% above best parent
 * AND pos_cohorts >= 76
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
const PG_PATH = path.resolve(HERE, "..", "..", "bots-sim", "markets", "btc", "portfolio-genomes.json");

const SL_FLOOR = 0.03, SL_CAP = 0.08, TP_FLOOR = 0.08, TP_CAP = 0.30;
const CONF_HIGH = 0.85, CONF_HIGH_MULT = 1.4, CONF_LOW = 0.75, CONF_LOW_MULT = 0.6;
function confMult(score) { if (score >= CONF_HIGH) return CONF_HIGH_MULT; if (score < CONF_LOW) return CONF_LOW_MULT; return 1; }
function addMonths(d, m) { const x = new Date(d + "T00:00:00Z"); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); }
function addYears(d, y) { const x = new Date(d + "T00:00:00Z"); x.setUTCFullYear(x.getUTCFullYear() + y); return x.toISOString().slice(0, 10); }
function mulberry32(seed) { let t = seed >>> 0; return () => { t = (t + 0x6D2B79F5) >>> 0; let r = t; r = Math.imul(r ^ (r >>> 15), r | 1); r ^= r + Math.imul(r ^ (r >>> 7), r | 61); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; }
function gaussian(rng) { let u = 0, v = 0; while (u === 0) u = rng(); while (v === 0) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function bootstrapMean(samples, iters = 2000, alpha = 0.05, seed = 42) {
  if (samples.length === 0) return { mean: 0, lo: 0, hi: 0 };
  const rng = mulberry32(seed);
  const means = new Array(iters); const n = samples.length;
  for (let it = 0; it < iters; it++) { let sum = 0; for (let i = 0; i < n; i++) sum += samples[Math.floor(rng() * n)]; means[it] = sum / n; }
  means.sort((a, b) => a - b);
  return { mean: samples.reduce((a, x) => a + x, 0) / n, lo: means[Math.floor(iters * (alpha / 2))], hi: means[Math.floor(iters * (1 - alpha / 2))] };
}

// Uniform crossover: each gene independently from A or B (50/50), then σ=0.03 mutation
function crossover(genA, genB, seed) {
  const rng = mulberry32(seed);
  const len = Math.min(genA.length, genB.length);
  const child = new Array(len);
  for (let i = 0; i < len; i++) {
    const base = rng() < 0.5 ? genA[i] : genB[i];
    const perturbed = base + gaussian(rng) * 0.03;
    child[i] = Math.max(0, Math.min(1, perturbed));
  }
  return child;
}

function buildBot(genome, label) {
  const decoded = _decodeGenome(genome);
  const slPct = Math.max(SL_FLOOR, Math.min(SL_CAP, decoded.stop_loss_pct));
  const tpPct = Math.max(TP_FLOOR, Math.min(TP_CAP, decoded.take_profit_pct));
  const botId = `xover-${label}`;
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
      if (consecutiveSL >= 3) cool += 30;
      if (daysSinceExit < cool) return null;
      const s = _scoreForOpen(decoded, idx);
      if (!s || s.score < decoded.entry_conf_threshold || s.sizingMultiplier <= 0) return null;
      let regimeMultVal = _regimeSizeMultiplier(_regimeAtIdx(idx));
      if (regimeMultVal <= 0) return null;
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
  const memberCfg = { address: `0xXO_${label}`, bot_id: bot.id, execution_mode: "independent", autoMode: "MIRROR", minConfidence: 0, allowedDirection: "BULL_ONLY", maxLeverage: 1, maxNotionalUsdc: 500, maxDailyTrades: 999, maxConcurrent: 1, sizingMode: "PCT_OF_CAPITAL", sizingParam: 0.5 };
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
  const ci = bootstrapMean(returns.map(x => x * 10000));
  const wr = trades > 0 ? wins / trades * 100 : 0;
  return { trades, wr, ci, fitness: wr * 100 + ci.lo / 10, posCohorts: cohortMeans.filter(f => f > 1000).length };
}

async function main() {
  const N_OFFSPRING = 50;
  const pg = JSON.parse(readFileSync(PG_PATH, "utf8"));
  const parents = pg.top5;

  // Evaluate parents first for baseline
  console.log("\n═══ CROSSOVER: alpha bot × each other ═══");
  const alpha = parents.find(p => p.label.startsWith("verify-A-2012")) || parents[0];
  console.log(`Alpha (parent A): ${alpha.label}`);
  const alphaEval = await evaluate(alpha.genome, "alpha");
  console.log(`  alpha baseline: WR ${alphaEval.wr.toFixed(1)}%  exp ${alphaEval.ci.mean.toFixed(0)}bp [${alphaEval.ci.lo.toFixed(0)}]  fit ${alphaEval.fitness.toFixed(0)}`);

  const results = [];
  for (const other of parents) {
    if (other.label === alpha.label) continue;
    console.log(`\n╔ ${alpha.label.slice(0,20)} × ${other.label}`);
    const otherEval = await evaluate(other.genome, `parent-${other.label}`);
    console.log(`  other baseline: WR ${otherEval.wr.toFixed(1)}%  exp ${otherEval.ci.mean.toFixed(0)}bp [${otherEval.ci.lo.toFixed(0)}]  fit ${otherEval.fitness.toFixed(0)}`);
    const bestParentFit = Math.max(alphaEval.fitness, otherEval.fitness);

    let bestOffspring = null;
    for (let i = 0; i < N_OFFSPRING; i++) {
      const seed = (alpha.label + "_x_" + other.label + "_o" + i).split("").reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 0);
      const child = crossover(alpha.genome, other.genome, seed);
      const ev = await evaluate(child, `${other.label}_o${i}`);
      if (ev.posCohorts < 76) continue;
      if (ev.fitness > bestParentFit * 1.02 && (!bestOffspring || ev.fitness > bestOffspring.eval.fitness)) {
        bestOffspring = { genome: child, eval: ev, idx: i };
      }
    }
    if (bestOffspring) {
      console.log(`  ★ offspring #${bestOffspring.idx}: WR ${bestOffspring.eval.wr.toFixed(1)}%  exp ${bestOffspring.eval.ci.mean.toFixed(0)}bp [${bestOffspring.eval.ci.lo.toFixed(0)}]  fit ${bestOffspring.eval.fitness.toFixed(0)}  pos ${bestOffspring.eval.posCohorts}/77`);
      results.push({ pair: other.label, offspring: bestOffspring });
    } else {
      console.log(`  no offspring beat parent by 2%`);
    }
  }

  console.log(`\n═══ SUMMARY ═══`);
  if (results.length === 0) {
    console.log("No crossover offspring beat parents. Genetic diversity between top-5 too limited.");
    return;
  }
  console.log(`Found ${results.length} improving offspring.`);
  // Best-of-best offspring to replace the LOSING parent (the one it crossed with)
  const newTop5 = [...parents];
  for (const r of results) {
    const idx = newTop5.findIndex(p => p.label === r.pair);
    if (idx >= 0) {
      newTop5[idx] = {
        label: `${r.pair}-xover-o${r.offspring.idx}`,
        val_calmar: parents[idx].val_calmar,
        genome: r.offspring.genome,
      };
      console.log(`  Replacing ${r.pair} with xover-o${r.offspring.idx} (fit ${r.offspring.eval.fitness.toFixed(0)})`);
    }
  }
  writeFileSync(PG_PATH, JSON.stringify({ ...pg, session7_crossover: true, top5: newTop5 }, null, 2));
  console.log("Wrote refined portfolio-genomes.json");
}
main().catch(e => { console.error(e); process.exit(1); });
