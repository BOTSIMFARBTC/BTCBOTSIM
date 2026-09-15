/**
 * Re-evaluate the 5 dropped-from-top10 bots with session-6 infrastructure
 * (realism 90 + regime filter + full-bear-skip + conf-sizing + clamped
 * TP/SL). Any that clear top-5 metrics could expand portfolio to 6-7 bots.
 */

import { readFileSync } from "node:fs";
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
function bootstrapMean(samples, iters = 2000, alpha = 0.05, seed = 42) {
  if (samples.length === 0) return { mean: 0, lo: 0, hi: 0 };
  const rng = mulberry32(seed);
  const means = new Array(iters); const n = samples.length;
  for (let it = 0; it < iters; it++) { let sum = 0; for (let i = 0; i < n; i++) sum += samples[Math.floor(rng() * n)]; means[it] = sum / n; }
  means.sort((a, b) => a - b);
  return { mean: samples.reduce((a, x) => a + x, 0) / n, lo: means[Math.floor(iters * (alpha / 2))], hi: means[Math.floor(iters * (1 - alpha / 2))] };
}

function buildBot(genome, label) {
  const decoded = _decodeGenome(genome);
  const slPct = Math.max(SL_FLOOR, Math.min(SL_CAP, decoded.stop_loss_pct));
  const tpPct = Math.max(TP_FLOOR, Math.min(TP_CAP, decoded.take_profit_pct));
  const botId = `reeval-${label}`;
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
  const memberCfg = { address: `0xREV_${label}`, bot_id: bot.id, execution_mode: "independent", autoMode: "MIRROR", minConfidence: 0, allowedDirection: "BULL_ONLY", maxLeverage: 1, maxNotionalUsdc: 500, maxDailyTrades: 999, maxConcurrent: 1, sizingMode: "PCT_OF_CAPITAL", sizingParam: 0.5 };
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
  const pg = JSON.parse(readFileSync(PG_PATH, "utf8"));
  const top10 = pg.top10;
  const top5Labels = new Set(pg.top5.map(x => x.label.split("-mut")[0].split("-g")[0]));
  const droppedSeeds = top10.filter(s => !top5Labels.has(s.label));
  console.log(`\n═══ RE-EVAL DROPPED SEEDS (${droppedSeeds.length}) WITH SESSION-6 INFRA ═══`);
  console.log("Bench (top-5 min): WR ~54%, exp lower-CI ~820bp, pos 65+/77\n");

  const t0 = Date.now();
  console.log("label                  trades  WR       exp(bp)      95% CI       pos/77");
  console.log("─".repeat(90));
  const evals = [];
  for (const seed of droppedSeeds) {
    const ev = await evaluate(seed.genome, seed.label);
    evals.push({ label: seed.label, ...ev });
    const flag = (ev.wr >= 50 && ev.ci.lo >= 500 && ev.posCohorts >= 70) ? "★ candidate" : "";
    console.log(`  ${seed.label.padEnd(22)} ${String(ev.trades).padStart(5)}  ${ev.wr.toFixed(1).padStart(5)}%  ${ev.ci.mean.toFixed(0).padStart(5)}  [${ev.ci.lo.toFixed(0).padStart(4)},${ev.ci.hi.toFixed(0).padStart(4)}]  ${ev.posCohorts}/77   ${flag}`);
  }
  console.log(`\nElapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Rank
  console.log("\n═══ RANKED (by lower-CI expectancy) ═══");
  evals.sort((a, b) => b.ci.lo - a.ci.lo);
  for (const ev of evals) {
    console.log(`  ${ev.label.padEnd(22)} WR ${ev.wr.toFixed(1)}%  exp ${ev.ci.mean.toFixed(0)}bp [${ev.ci.lo.toFixed(0)}]  pos ${ev.posCohorts}/77`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
