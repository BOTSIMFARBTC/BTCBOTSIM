/**
 * WR-priority mutation. Same as multi-gen but objective is:
 *   fitness = WR × 100 + expLowerCI/10
 * i.e. WR matters 10× more per pp than expectancy per 10bp.
 * Should push toward higher-accuracy genomes.
 *
 * Also enforces: mutant must maintain 76+/77 positive cohorts.
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

function addMonths(d, m) { const x = new Date(d + "T00:00:00Z"); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); }
function addYears(d, y) { const x = new Date(d + "T00:00:00Z"); x.setUTCFullYear(x.getUTCFullYear() + y); return x.toISOString().slice(0, 10); }
function mulberry32(seed) { let t = seed >>> 0; return () => { t = (t + 0x6D2B79F5) >>> 0; let r = t; r = Math.imul(r ^ (r >>> 15), r | 1); r ^= r + Math.imul(r ^ (r >>> 7), r | 61); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; }
function gaussian(rng) { let u = 0, v = 0; while (u === 0) u = rng(); while (v === 0) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function mutate(genome, sigma, seed) { const rng = mulberry32(seed); return genome.map(g => Math.max(0, Math.min(1, g + gaussian(rng) * sigma))); }
function bootstrapMean(samples, iters = 2000, alpha = 0.05, seed = 42) {
  if (samples.length === 0) return { mean: 0, lo: 0, hi: 0 };
  const rng = mulberry32(seed);
  const means = new Array(iters); const n = samples.length;
  for (let it = 0; it < iters; it++) { let sum = 0; for (let i = 0; i < n; i++) sum += samples[Math.floor(rng() * n)]; means[it] = sum / n; }
  means.sort((a, b) => a - b);
  return { mean: samples.reduce((a, x) => a + x, 0) / n, lo: means[Math.floor(iters * (alpha / 2))], hi: means[Math.floor(iters * (1 - alpha / 2))] };
}
function confMult(score) { if (score >= CONF_HIGH) return CONF_HIGH_MULT; if (score < CONF_LOW) return CONF_LOW_MULT; return 1; }

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
  const memberCfg = { address: `0xMUT_${label}`, bot_id: bot.id, execution_mode: "independent", autoMode: "MIRROR", minConfidence: 0, allowedDirection: "BULL_ONLY", maxLeverage: 1, maxNotionalUsdc: 500, maxDailyTrades: 999, maxConcurrent: 1, sizingMode: "PCT_OF_CAPITAL", sizingParam: 0.5 };
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
  const fitness = wr * 100 + ci.lo / 10;
  return { trades, wins, wr, ci, fitness, posCohorts: cohortMeans.filter(f => f > 1000).length };
}

async function main() {
  process.env.BTC_BEAR_BOT = "0";
  const N_GENS = 3, N_MUTANTS = 40;
  const SIGMAS = [0.05, 0.03, 0.02];
  const MIN_POS_COH = 76;
  const IMPROVEMENT_MIN = 30; // fitness delta

  const pg = JSON.parse(readFileSync(PG_PATH, "utf8"));
  const parents = pg.top5;
  console.log(`\n═══ WR-PRIORITY MULTI-GEN MUTATION (${N_GENS} gens × ${N_MUTANTS} mutants) ═══`);
  console.log(`fitness = WR × 100 + exp_lower_ci / 10, min_pos_cohorts = ${MIN_POS_COH}\n`);

  const finalWinners = [];
  const t0 = Date.now();
  for (const parentSpec of parents) {
    console.log(`\n╔ Parent: ${parentSpec.label} ═════`);
    let currentGenome = parentSpec.genome, currentLabel = parentSpec.label;
    let currentEval = await evaluate(currentGenome, `orig-${parentSpec.label}`);
    console.log(`  gen0: ${currentEval.trades}t  WR ${currentEval.wr.toFixed(1)}%  exp ${currentEval.ci.mean.toFixed(0)}bp [${currentEval.ci.lo.toFixed(0)}]  pos ${currentEval.posCohorts}/77  fitness ${currentEval.fitness.toFixed(1)}`);

    for (let g = 0; g < N_GENS; g++) {
      const sigma = SIGMAS[g];
      let best = null;
      for (let m = 0; m < N_MUTANTS; m++) {
        const seed = (currentLabel + `_g${g}_m${m}`).split("").reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 0);
        const mutant = mutate(currentGenome, sigma, seed);
        const ev = await evaluate(mutant, `${parentSpec.label}_g${g}_m${m}`);
        if (ev.posCohorts < MIN_POS_COH) continue;
        const gain = ev.fitness - currentEval.fitness;
        if (gain > IMPROVEMENT_MIN && (!best || ev.fitness > best.eval.fitness)) {
          best = { mutant, eval: ev, mIdx: m };
        }
      }
      if (best) {
        currentGenome = best.mutant;
        currentLabel = `${parentSpec.label}-g${g}m${best.mIdx}`;
        currentEval = best.eval;
        console.log(`  gen${g+1} σ=${sigma}: ADOPTED m${best.mIdx}  WR ${currentEval.wr.toFixed(1)}%  exp ${currentEval.ci.mean.toFixed(0)}bp  pos ${currentEval.posCohorts}/77  fitness ${currentEval.fitness.toFixed(1)}`);
      } else {
        console.log(`  gen${g+1} σ=${sigma}: no improvement`);
      }
    }

    finalWinners.push({ parentLabel: parentSpec.label, finalLabel: currentLabel, finalGenome: currentGenome, finalEval: currentEval, improved: currentLabel !== parentSpec.label });
  }
  console.log(`\nElapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const anyImproved = finalWinners.some(w => w.improved);
  if (anyImproved) {
    const newTop5 = finalWinners.map((w, i) => ({ label: w.finalLabel, val_calmar: parents[i].val_calmar, genome: w.finalGenome }));
    writeFileSync(PG_PATH, JSON.stringify({ ...pg, session6_wr_priority: true, top5: newTop5 }, null, 2));
    console.log("Wrote refined portfolio-genomes.json");
  } else {
    console.log("No improvements.");
  }
}
main().catch(e => { console.error(e); process.exit(1); });
