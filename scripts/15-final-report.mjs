/**
 * Final scale-up + statistical report.
 *
 * Runs the walk-forward at maximum-density (2mo step × 3yr window) to
 * generate 1000+ trades per bot, then bootstraps CIs on WR and
 * expectancy so we can say something honest about statistical
 * significance.
 *
 * Also compares realism 80 vs realism 90 side by side.
 *
 * Output: btc-bot-sim/results/final-report.json + console summary.
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

// Deterministic seeded RNG (mulberry32) so bootstraps are reproducible
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

function bootstrapMeanCI(samples, iters = 2000, alpha = 0.05, seed = 42) {
  if (samples.length === 0) return { mean: 0, lo: 0, hi: 0, n: 0 };
  const rng = mulberry32(seed);
  const means = new Array(iters);
  const n = samples.length;
  for (let it = 0; it < iters; it++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += samples[Math.floor(rng() * n)];
    means[it] = sum / n;
  }
  means.sort((a, b) => a - b);
  const mean = samples.reduce((a, x) => a + x, 0) / n;
  return {
    mean,
    lo: means[Math.floor(iters * (alpha / 2))],
    hi: means[Math.floor(iters * (1 - alpha / 2))],
    n,
  };
}

async function runCohortsAt(realismLevel, cohortMonths, windowYears) {
  // Reload plugin with new realism level. Since ES modules cache,
  // set env var and dynamic-import with a cache-busting query param.
  process.env.BTC_REALISM = String(realismLevel);
  const mod = await import(`../../bots-sim/markets/btc/index.mjs?realism=${realismLevel}_${Date.now()}`);
  const { plugin, bots, buildPortfolioMembers } = mod;
  const { runSim } = await import("../../bots-sim/access-sim-core/src/harness.mjs");

  const HIST_START = "2011-01-01";
  const HIST_END = "2026-09-10";
  const enrollments = [];
  let cur = HIST_START;
  while (addYears(cur, windowYears) <= HIST_END) {
    enrollments.push(cur);
    cur = addMonths(cur, cohortMonths);
  }

  const perBot = Object.fromEntries(bots.map(b => [b.id, { trades: 0, wins: 0, returns: [] }]));
  const cohortMeans = [];

  for (const enroll of enrollments) {
    const to = addYears(enroll, windowYears);
    const members = buildPortfolioMembers(1000);
    const r = await runSim({
      plugin, members, bots,
      window: { from: enroll, to },
      cadenceSec: 86400, startingCapital: 1000,
    });
    for (const m of r.members) {
      const bid = m.config.bot_id;
      for (const h of m.history) {
        if (h.exit_reason === "END_OF_SIM" || h.exit_reason === "PANIC_UNENROLL") continue;
        perBot[bid].trades++;
        if (h.pnl > 0) perBot[bid].wins++;
        perBot[bid].returns.push(h.net_return_pct);
      }
    }
    const meanFinal = r.summary.memberOutcomes.reduce((a, x) => a + x.finalCapital, 0) / r.summary.memberOutcomes.length;
    cohortMeans.push(meanFinal);
  }
  return { perBot, cohortMeans, nCohorts: enrollments.length };
}

async function main() {
  const cohortMonths = Number(process.argv[2] ?? 2);
  const windowYears = Number(process.argv[3] ?? 3);
  console.log(`\n═══ FINAL SCALE-UP + REALISM AB ═══`);
  console.log(`Cohort density: every ${cohortMonths}mo, window ${windowYears}yr`);

  const t0 = Date.now();
  console.log(`\n[1/2] Running realism 80 baseline...`);
  const r80 = await runCohortsAt(80, cohortMonths, windowYears);
  console.log(`[2/2] Running realism 90 upgraded...`);
  const r90 = await runCohortsAt(90, cohortMonths, windowYears);
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\nCohorts: ${r80.nCohorts}   elapsed: ${elapsedSec}s`);

  // ─── Per-bot comparison ─────────────────────────────────────────
  console.log("\n" + "═".repeat(120));
  console.log("PER-BOT: REALISM 80 vs 90 (WR + expectancy 95% CI via 2000-sample bootstrap)");
  console.log("═".repeat(120));
  console.log("bot                             |  R80 trades WR%   exp(bp) [95% CI]      |  R90 trades WR%   exp(bp) [95% CI]      | ΔExp");

  const botRows = [];
  const botIds = Object.keys(r80.perBot);
  for (const bid of botIds) {
    const a = r80.perBot[bid], b = r90.perBot[bid];
    const wrA = a.trades > 0 ? (a.wins / a.trades * 100) : 0;
    const wrB = b.trades > 0 ? (b.wins / b.trades * 100) : 0;
    const ciA = bootstrapMeanCI(a.returns.map(x => x * 10000));
    const ciB = bootstrapMeanCI(b.returns.map(x => x * 10000));
    botRows.push({ bid, r80: { trades: a.trades, wr: wrA, exp: ciA }, r90: { trades: b.trades, wr: wrB, exp: ciB } });
    console.log(
      `  ${bid.padEnd(31)} |  ${String(a.trades).padStart(4)}      ${wrA.toFixed(1).padStart(4)}%  ${ciA.mean.toFixed(0).padStart(5)}  [${ciA.lo.toFixed(0).padStart(4)}, ${ciA.hi.toFixed(0).padStart(4)}]   |  ` +
      `${String(b.trades).padStart(4)}      ${wrB.toFixed(1).padStart(4)}%  ${ciB.mean.toFixed(0).padStart(5)}  [${ciB.lo.toFixed(0).padStart(4)}, ${ciB.hi.toFixed(0).padStart(4)}]   |  ${(ciB.mean - ciA.mean).toFixed(0).padStart(5)}bp`
    );
  }

  // ─── Portfolio aggregate: pool all trades ────────────────────────
  const allA = [].concat(...botIds.map(bid => r80.perBot[bid].returns.map(x => x * 10000)));
  const allB = [].concat(...botIds.map(bid => r90.perBot[bid].returns.map(x => x * 10000)));
  const portCiA = bootstrapMeanCI(allA, 5000);
  const portCiB = bootstrapMeanCI(allB, 5000);
  const totalWinsA = botIds.reduce((s, bid) => s + r80.perBot[bid].wins, 0);
  const totalWinsB = botIds.reduce((s, bid) => s + r90.perBot[bid].wins, 0);
  const totalTradesA = botIds.reduce((s, bid) => s + r80.perBot[bid].trades, 0);
  const totalTradesB = botIds.reduce((s, bid) => s + r90.perBot[bid].trades, 0);

  console.log("\n" + "═".repeat(120));
  console.log("PORTFOLIO POOLED (all 10 bots' trades combined)");
  console.log("═".repeat(120));
  console.log(`  R80: ${totalTradesA} trades  WR ${(totalWinsA/totalTradesA*100).toFixed(1)}%  exp ${portCiA.mean.toFixed(0)}bp [95% CI ${portCiA.lo.toFixed(0)}, ${portCiA.hi.toFixed(0)}]`);
  console.log(`  R90: ${totalTradesB} trades  WR ${(totalWinsB/totalTradesB*100).toFixed(1)}%  exp ${portCiB.mean.toFixed(0)}bp [95% CI ${portCiB.lo.toFixed(0)}, ${portCiB.hi.toFixed(0)}]`);
  console.log(`  ΔExp (realism cost): ${(portCiB.mean - portCiA.mean).toFixed(0)}bp per trade`);
  console.log(`  Both CIs excluding zero: ${portCiA.lo > 0 && portCiB.lo > 0 ? "YES — statistically significant positive expectancy" : "NO"}`);

  // ─── Cohort outcome distribution ─────────────────────────────────
  console.log("\n" + "═".repeat(120));
  console.log("COHORT OUTCOME DISTRIBUTION (mean final capital per cohort)");
  console.log("═".repeat(120));
  for (const [label, arr] of [["R80", r80.cohortMeans], ["R90", r90.cohortMeans]]) {
    const s = [...arr].sort((a, b) => a - b);
    const pct = (p) => s[Math.floor(s.length * p)];
    const posN = s.filter(f => f > 1000).length;
    console.log(`  ${label}: n=${s.length}  min $${s[0].toFixed(0)}  p10 $${pct(0.10).toFixed(0)}  med $${pct(0.50).toFixed(0)}  p90 $${pct(0.90).toFixed(0)}  max $${s.at(-1).toFixed(0)}  positive ${posN}/${s.length}`);
  }

  await fs.writeFile(path.join(RESULTS_DIR, "final-report.json"), JSON.stringify({
    ranAt: new Date().toISOString(),
    elapsedSec: Number(elapsedSec),
    params: { cohortMonths, windowYears, nCohorts: r80.nCohorts },
    perBot: botRows,
    portfolio: {
      r80: { trades: totalTradesA, wins: totalWinsA, exp_bp: portCiA },
      r90: { trades: totalTradesB, wins: totalWinsB, exp_bp: portCiB },
    },
    cohorts: {
      r80: r80.cohortMeans,
      r90: r90.cohortMeans,
    },
  }, null, 2));
  console.log(`\nWrote btc-bot-sim/results/final-report.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
