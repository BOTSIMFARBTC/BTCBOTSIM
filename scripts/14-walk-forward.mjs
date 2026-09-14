/**
 * Walk-forward cohort runner. Enrolls a fresh virtual member every N
 * months across BTC's 16y history, each running for M years, aggregates
 * trade counts per bot across all cohorts.
 *
 * This gives a more realistic member-experience distribution than one
 * long 16y run — different members enroll at different market phases,
 * hit different regimes, and the aggregate trade population is the
 * union of all their trades.
 *
 * Important: overlapping windows do NOT create new information — a bot
 * trading the same 2018 bar in cohort-A and cohort-B is the same bar
 * twice. What we DO get is: (1) more trades per bot for CI purposes if
 * bootstrapped honestly, (2) a distribution of member outcomes as a
 * function of enrollment timing.
 *
 * CLI:
 *   node btc-bot-sim/scripts/14-walk-forward.mjs [cohortMonths=3] [windowYears=4]
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runSim } from "../../bots-sim/access-sim-core/src/harness.mjs";
import { plugin, bots, buildPortfolioMembers } from "../../bots-sim/markets/btc/index.mjs";

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

async function main() {
  const cohortMonths = Number(process.argv[2] ?? 3);
  const windowYears = Number(process.argv[3] ?? 4);
  const HIST_START = "2011-01-01";  // skip 2010 warmup phase
  const HIST_END = "2026-09-10";
  const enrollmentDates = [];
  let cur = HIST_START;
  while (addYears(cur, windowYears) <= HIST_END) {
    enrollmentDates.push(cur);
    cur = addMonths(cur, cohortMonths);
  }

  console.log(`\n═══ WALK-FORWARD (${enrollmentDates.length} cohorts, ${windowYears}yr window, ${cohortMonths}mo step) ═══`);
  console.log(`First enroll: ${enrollmentDates[0]}   Last enroll: ${enrollmentDates.at(-1)}`);

  // Aggregate: trade counts per bot per cohort, plus per-cohort portfolio finals
  const perBotTradeCount = Object.fromEntries(bots.map(b => [b.id, 0]));
  const perBotWinCount = Object.fromEntries(bots.map(b => [b.id, 0]));
  const perBotLossCount = Object.fromEntries(bots.map(b => [b.id, 0]));
  const perBotReturnList = Object.fromEntries(bots.map(b => [b.id, []]));  // per-trade net_return_pct
  const cohortResults = [];

  const t0 = Date.now();
  for (const enroll of enrollmentDates) {
    const to = addYears(enroll, windowYears);
    const members = buildPortfolioMembers(1000);
    const r = await runSim({
      plugin, members, bots,
      window: { from: enroll, to },
      cadenceSec: 86400, startingCapital: 1000,
    });

    let cohortOpens = 0;
    for (const m of r.members) {
      for (const h of m.history) {
        const bid = m.config.bot_id;
        // Filter out END_OF_SIM / PANIC_UNENROLL — they're forced closes not real trade decisions
        if (h.exit_reason === "END_OF_SIM" || h.exit_reason === "PANIC_UNENROLL") continue;
        perBotTradeCount[bid]++;
        if (h.pnl > 0) perBotWinCount[bid]++; else perBotLossCount[bid]++;
        perBotReturnList[bid].push(h.net_return_pct);
        cohortOpens++;
      }
    }
    const meanFinal = r.summary.memberOutcomes.reduce((a, x) => a + x.finalCapital, 0) / r.summary.memberOutcomes.length;
    cohortResults.push({ enroll, to, cohortOpens, meanFinal });
  }
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Ran ${enrollmentDates.length} cohorts in ${elapsedSec}s`);

  // ─── Per-bot aggregate ────────────────────────────────────────────
  console.log("\n" + "═".repeat(100));
  console.log("PER-BOT AGGREGATE (across all cohorts, END_OF_SIM/PANIC excluded)");
  console.log("═".repeat(100));
  const rows = [];
  let totalTrades = 0, totalWins = 0;
  for (const b of bots) {
    const t = perBotTradeCount[b.id];
    const w = perBotWinCount[b.id];
    const l = perBotLossCount[b.id];
    const wr = t > 0 ? (w / t * 100) : 0;
    const rets = perBotReturnList[b.id];
    const meanRet = rets.length > 0 ? rets.reduce((a, x) => a + x, 0) / rets.length : 0;
    const wins = rets.filter(r => r > 0);
    const losses = rets.filter(r => r <= 0);
    const meanWin = wins.length > 0 ? wins.reduce((a, x) => a + x, 0) / wins.length : 0;
    const meanLoss = losses.length > 0 ? losses.reduce((a, x) => a + x, 0) / losses.length : 0;
    // Expectancy per trade in bps
    const expBps = meanRet * 10000;
    rows.push({ id: b.id, trades: t, wins: w, losses: l, wr, meanWinBps: meanWin*10000, meanLossBps: meanLoss*10000, expBps });
    totalTrades += t;
    totalWins += w;
    console.log(
      `  ${b.id.padEnd(30)}  trades ${String(t).padStart(4)}  W ${String(w).padStart(3)}  L ${String(l).padStart(3)}  WR ${wr.toFixed(1).padStart(5)}%  ` +
      `winAvg ${(meanWin*100).toFixed(2).padStart(6)}%  lossAvg ${(meanLoss*100).toFixed(2).padStart(6)}%  exp ${expBps.toFixed(0).padStart(5)}bp`
    );
  }
  const aggWR = totalTrades > 0 ? (totalWins / totalTrades * 100) : 0;
  console.log(`\nTOTAL: ${totalTrades} trades, ${totalWins} wins, aggregate WR ${aggWR.toFixed(1)}%`);

  // ─── Cohort outcome distribution ─────────────────────────────────
  console.log("\n" + "═".repeat(100));
  console.log("COHORT OUTCOME DISTRIBUTION (mean final capital per cohort)");
  console.log("═".repeat(100));
  const finals = cohortResults.map(c => c.meanFinal).sort((a, b) => a - b);
  const pct = (p) => finals[Math.floor(finals.length * p)];
  console.log(`  cohorts: ${finals.length}`);
  console.log(`  min:  $${finals[0].toFixed(0)}   p10: $${pct(0.10).toFixed(0)}   p25: $${pct(0.25).toFixed(0)}   median: $${pct(0.50).toFixed(0)}   p75: $${pct(0.75).toFixed(0)}   p90: $${pct(0.90).toFixed(0)}   max: $${finals.at(-1).toFixed(0)}`);
  const posCohorts = finals.filter(f => f > 1000).length;
  console.log(`  positive: ${posCohorts}/${finals.length} (${(posCohorts/finals.length*100).toFixed(0)}%)`);

  await fs.writeFile(path.join(RESULTS_DIR, "walk-forward-summary.json"), JSON.stringify({
    ranAt: new Date().toISOString(),
    params: { cohortMonths, windowYears, histStart: HIST_START, histEnd: HIST_END, nCohorts: enrollmentDates.length },
    perBot: rows,
    totalTrades, totalWins, aggWR,
    cohortResults,
  }, null, 2));
  console.log(`\nWrote btc-bot-sim/results/walk-forward-summary.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
