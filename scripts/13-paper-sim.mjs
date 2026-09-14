/**
 * Paper-sim runner — feeds the BTC plugin into Vega's access-sim-core
 * harness and reports portfolio metrics. This is the first end-to-end
 * test of Argus's Path X ship candidate through the SAME executor +
 * adapter + behavior model that will run on production /access.
 *
 * Compared to `scripts/12-portfolio-holdout.ts` (direct sim, spot-style
 * fractional-BTC rebalancer), this runner uses:
 *   - Discrete perp opens (BULL / no fractional sizing)
 *   - Executor eligibility gate (autoMode / allowedDirection / etc)
 *   - Adapter SL/TP/gap/timeout checks
 *   - Behavior-model pause-on-losses
 *
 * Expected: direction-of-move parity but NOT numerical equity parity.
 * The v6-ab genomes were tuned for the direct-sim's fractional
 * rebalancer; port to discrete perps will diverge on absolute numbers.
 *
 * Windows tested:
 *   1. HOLDOUT slice: 2026-03-11 → 2026-09-10 (matches direct sim)
 *   2. Fresh 3mo: 2026-06-10 → 2026-09-10 (out-of-out-of-sample)
 *
 * CLI:
 *   node btc-bot-sim/scripts/13-paper-sim.mjs [window=holdout|fresh3mo]
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runSim } from "../../bots-sim/access-sim-core/src/harness.mjs";
import {
  plugin,
  bots,
  buildPortfolioMembers,
} from "../../bots-sim/markets/btc/index.mjs";

const __filename = fileURLToPath(import.meta.url);
const HERE = path.dirname(__filename);
const RESULTS_DIR = path.resolve(HERE, "..", "results");

const WINDOWS = {
  holdout:  { from: "2026-03-11", to: "2026-09-10" },
  fresh3mo: { from: "2026-06-10", to: "2026-09-10" },
  fresh1yr: { from: "2025-09-10", to: "2026-09-10" },
};

async function main() {
  const key = process.argv[2] ?? "holdout";
  const window = WINDOWS[key];
  if (!window) {
    console.error(`Unknown window '${key}'. Choices: ${Object.keys(WINDOWS).join(", ")}`);
    process.exit(1);
  }

  console.log(`\n═══ ARGUS PAPER-SIM (window: ${key} ${window.from} → ${window.to}) ═══`);
  console.log(`Bots registered: ${bots.length}`);

  const members = buildPortfolioMembers(1000);
  console.log(`Virtual members: ${members.length}, starting capital $1000 each`);

  const t0 = Date.now();
  const result = await runSim({
    plugin,
    members,
    bots,
    window,
    cadenceSec: 86400,       // 1 tick per day (matches daily BTC bars)
    startingCapital: 1000,
    verbose: false,
  });
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Ran ${result.summary.tickCount} ticks in ${elapsedSec}s`);
  console.log(`Total opens: ${result.summary.totalOpened}   closes: ${result.summary.totalClosed}`);
  if (result.summary.errors.length > 0) {
    console.log(`Errors (${result.summary.errors.length}):`);
    for (const e of result.summary.errors.slice(0, 5)) console.log(`  ${e}`);
  }

  // ─── Per-member breakdown ────────────────────────────────────────
  console.log("\n" + "═".repeat(100));
  console.log("PER-MEMBER RESULTS");
  console.log("═".repeat(100));
  for (const m of result.summary.memberOutcomes) {
    console.log(
      `  ${m.bot_id.padEnd(30)}  ` +
      `final $${m.finalCapital.toFixed(0).padStart(6)}  ` +
      `ret ${m.returnPct.toFixed(1).padStart(6)}%  ` +
      `DD ${m.drawdownFromPeakPct.toFixed(1).padStart(5)}%  ` +
      `trades ${m.trades.toString().padStart(3)}  ` +
      `WR ${m.winrate.toFixed(0).padStart(3)}%  ` +
      `enrolled=${m.enrolled}`,
    );
  }

  // ─── Portfolio aggregate (equal-weight of member finals) ─────────
  const n = result.summary.memberOutcomes.length;
  const totalFinal = result.summary.memberOutcomes.reduce((a, m) => a + m.finalCapital, 0);
  const meanFinal = totalFinal / n;
  const portReturn = (meanFinal - 1000) / 1000;

  // Compute BH for the window
  const bars = await plugin.priceSeries(window.from, window.to);
  const bhReturn = (bars[bars.length - 1].c - bars[0].c) / bars[0].c;

  const worstDDs = result.summary.memberOutcomes.map((m) => m.drawdownFromPeakPct);
  const meanDD = worstDDs.reduce((a, x) => a + x, 0) / n;
  const maxMemberDD = Math.max(...worstDDs);

  console.log("\n" + "═".repeat(100));
  console.log("PORTFOLIO SUMMARY (equal-weight mean of 10 virtual members)");
  console.log("═".repeat(100));
  console.log(`Mean final capital:  $${meanFinal.toFixed(2)}  (${(portReturn * 100).toFixed(2)}%)`);
  console.log(`Buy-hold same window:  $${(1000 * (1 + bhReturn)).toFixed(2)}  (${(bhReturn * 100).toFixed(2)}%)`);
  console.log(`vs BH: portfolio ${portReturn > bhReturn ? "wins" : "loses"} by ${((portReturn - bhReturn) * 100).toFixed(2)}pp`);
  console.log(`Mean per-member DD: ${meanDD.toFixed(2)}%   Worst member DD: ${maxMemberDD.toFixed(2)}%`);

  // ─── Persist artifact ────────────────────────────────────────────
  await fs.mkdir(RESULTS_DIR, { recursive: true });
  const outPath = path.join(RESULTS_DIR, `paper-sim-${key}.json`);
  await fs.writeFile(outPath, JSON.stringify({
    ranAt: result.ranAt,
    window,
    cadenceSec: 86400,
    elapsedSec: Number(elapsedSec),
    bots: bots.map((b) => b.id),
    summary: result.summary,
    portfolio: {
      meanFinal, portReturn, bhReturn,
      meanDD, maxMemberDD,
    },
  }, null, 2));
  console.log(`\nWrote ${path.relative(process.cwd(), outPath)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
