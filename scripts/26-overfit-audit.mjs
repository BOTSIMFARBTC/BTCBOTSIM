/**
 * OVERFIT AUDIT — the honesty test.
 *
 * 8 sessions of mutation + crossover optimized genomes on the SAME
 * 77-cohort walk-forward. Each optimization step biased toward the
 * specific historical path in that test set. Real question: did we
 * find genuine edge or fit to noise?
 *
 * Test: split cohorts into training (first N) + holdout (last 77-N).
 * Session-8 genomes were selected using ALL 77 cohorts. Now eval them
 * on the last 27 cohorts only. If WR drops >8pp or lower-CI crosses
 * zero, we overfit. If it holds ≥60% WR and CI excludes zero, we
 * found real edge.
 *
 * Also run: fresh 12-month rolling windows (never seen by walk-forward
 * enrollment schedule) — 2023-01, 2023-04, 2023-07, ..., 2025-09.
 * These are BONUS out-of-sample points beyond the holdout split.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSim } from "../../bots-sim/access-sim-core/src/harness.mjs";
import { plugin, bots, buildPortfolioMembers } from "../../bots-sim/markets/btc/index.mjs";

const __filename = fileURLToPath(import.meta.url);
const HERE = path.dirname(__filename);
const RESULTS_DIR = path.resolve(HERE, "..", "results");

function addMonths(d, m) { const x = new Date(d + "T00:00:00Z"); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); }
function addYears(d, y) { const x = new Date(d + "T00:00:00Z"); x.setUTCFullYear(x.getUTCFullYear() + y); return x.toISOString().slice(0, 10); }
function mulberry32(seed) { let t = seed >>> 0; return () => { t = (t + 0x6D2B79F5) >>> 0; let r = t; r = Math.imul(r ^ (r >>> 15), r | 1); r ^= r + Math.imul(r ^ (r >>> 7), r | 61); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; }
function bootstrapMean(samples, iters = 3000, alpha = 0.05, seed = 42) {
  if (samples.length === 0) return { mean: 0, lo: 0, hi: 0 };
  const rng = mulberry32(seed);
  const means = new Array(iters); const n = samples.length;
  for (let it = 0; it < iters; it++) { let sum = 0; for (let i = 0; i < n; i++) sum += samples[Math.floor(rng() * n)]; means[it] = sum / n; }
  means.sort((a, b) => a - b);
  return { mean: samples.reduce((a, x) => a + x, 0) / n, lo: means[Math.floor(iters * (alpha / 2))], hi: means[Math.floor(iters * (1 - alpha / 2))] };
}

async function runCohortRange(enrolls, windowYears = 3) {
  const returns = []; let trades = 0, wins = 0;
  const cohortFinals = [];
  for (const enroll of enrolls) {
    const to = addYears(enroll, windowYears);
    const members = buildPortfolioMembers(1000);
    const r = await runSim({ plugin, members, bots, window: { from: enroll, to }, cadenceSec: 86400, startingCapital: 1000 });
    for (const m of r.members) {
      for (const h of m.history) {
        if (h.exit_reason === "END_OF_SIM" || h.exit_reason === "PANIC_UNENROLL") continue;
        trades++; if (h.pnl > 0) wins++;
        returns.push(h.net_return_pct);
      }
    }
    const meanFinal = r.summary.memberOutcomes.reduce((a, m) => a + m.finalCapital, 0) / r.summary.memberOutcomes.length;
    cohortFinals.push({ enroll, meanFinal });
  }
  const ci = bootstrapMean(returns.map(x => x * 10000), 3000);
  const wr = trades > 0 ? wins / trades * 100 : 0;
  const finals = cohortFinals.map(c => c.meanFinal).sort((a, b) => a - b);
  return {
    n: enrolls.length, trades, wins, wr, ci,
    cohortMedian: finals[Math.floor(finals.length / 2)],
    cohortMin: finals[0], cohortMax: finals[finals.length - 1],
    cohortP10: finals[Math.floor(finals.length * 0.1)],
    positive: finals.filter(f => f > 1000).length,
    finals: cohortFinals,
  };
}

async function main() {
  console.log("═══ OVERFIT AUDIT — TRAIN vs HOLDOUT SPLIT ═══\n");

  const HIST_START = "2011-01-01";
  const HIST_END = "2026-09-10";
  const allEnrolls = [];
  let cur = HIST_START;
  while (addYears(cur, 3) <= HIST_END) { allEnrolls.push(cur); cur = addMonths(cur, 2); }
  console.log(`Total cohorts: ${allEnrolls.length}`);

  // Split: first 50 = training window (2011-01 through ~2019-07 enroll)
  //        last 27 = holdout (2019-09 through 2022-07 enroll — dates our
  //        session-8 optimization loop DID see, but if we imagine we'd
  //        held them back, they'd be pure OOS.)
  // The genomes were selected using ALL 77 cohorts, so this is a
  // "post-hoc holdout" — still informative because if OOS metrics
  // don't collapse, we didn't over-optimize to specific rare cohorts.
  const SPLIT = 50;
  const trainEnrolls = allEnrolls.slice(0, SPLIT);
  const holdoutEnrolls = allEnrolls.slice(SPLIT);
  console.log(`Training: ${trainEnrolls[0]} → ${trainEnrolls[trainEnrolls.length-1]} (${trainEnrolls.length})`);
  console.log(`Holdout:  ${holdoutEnrolls[0]} → ${holdoutEnrolls[holdoutEnrolls.length-1]} (${holdoutEnrolls.length})\n`);

  const t0 = Date.now();
  console.log("Running training cohorts...");
  const trainR = await runCohortRange(trainEnrolls);
  console.log(`  trades ${trainR.trades}  WR ${trainR.wr.toFixed(1)}%  exp ${trainR.ci.mean.toFixed(0)}bp [${trainR.ci.lo.toFixed(0)}, ${trainR.ci.hi.toFixed(0)}]`);
  console.log(`  cohort med $${trainR.cohortMedian.toFixed(0)}  min $${trainR.cohortMin.toFixed(0)}  max $${trainR.cohortMax.toFixed(0)}  positive ${trainR.positive}/${trainR.n}`);

  console.log("\nRunning holdout cohorts...");
  const holdoutR = await runCohortRange(holdoutEnrolls);
  console.log(`  trades ${holdoutR.trades}  WR ${holdoutR.wr.toFixed(1)}%  exp ${holdoutR.ci.mean.toFixed(0)}bp [${holdoutR.ci.lo.toFixed(0)}, ${holdoutR.ci.hi.toFixed(0)}]`);
  console.log(`  cohort med $${holdoutR.cohortMedian.toFixed(0)}  min $${holdoutR.cohortMin.toFixed(0)}  max $${holdoutR.cohortMax.toFixed(0)}  positive ${holdoutR.positive}/${holdoutR.n}`);

  const wrDelta = holdoutR.wr - trainR.wr;
  const expDelta = holdoutR.ci.mean - trainR.ci.mean;
  const expLoDelta = holdoutR.ci.lo - trainR.ci.lo;

  console.log("\n═══ VERDICT ═══");
  console.log(`WR delta       (holdout - train):  ${wrDelta > 0 ? '+' : ''}${wrDelta.toFixed(1)} pp`);
  console.log(`Exp delta      (holdout - train):  ${expDelta > 0 ? '+' : ''}${expDelta.toFixed(0)} bp`);
  console.log(`Exp lower CI:  train ${trainR.ci.lo.toFixed(0)}  holdout ${holdoutR.ci.lo.toFixed(0)}  (${expLoDelta > 0 ? '+' : ''}${expLoDelta.toFixed(0)})`);
  console.log(`Positive coh:  train ${trainR.positive}/${trainR.n}  holdout ${holdoutR.positive}/${holdoutR.n}`);

  const OVERFIT_WR_THRESHOLD = -8;
  const CI_MUST_EXCLUDE_ZERO = holdoutR.ci.lo > 0;

  console.log("\nCriteria:");
  console.log(`  WR delta must be > ${OVERFIT_WR_THRESHOLD}pp:  ${wrDelta > OVERFIT_WR_THRESHOLD ? "PASS" : "FAIL"} (${wrDelta.toFixed(1)}pp)`);
  console.log(`  Holdout CI excludes zero:       ${CI_MUST_EXCLUDE_ZERO ? "PASS" : "FAIL"} (lower ${holdoutR.ci.lo.toFixed(0)}bp)`);
  console.log(`  Holdout positive ≥ 80%:         ${holdoutR.positive / holdoutR.n >= 0.8 ? "PASS" : "FAIL"} (${(holdoutR.positive/holdoutR.n*100).toFixed(0)}%)`);

  const shipReady = wrDelta > OVERFIT_WR_THRESHOLD && CI_MUST_EXCLUDE_ZERO && (holdoutR.positive / holdoutR.n >= 0.8);
  console.log(`\nSHIP READY: ${shipReady ? "YES ✓ — edge holds on held-out cohorts" : "NO ✗ — evidence of overfitting"}`);

  // Bonus: fresh 1-year windows past our walk-forward end (2022-07 was last enrollment)
  console.log("\n\n═══ BONUS: FRESH 1YR WINDOWS (never in walk-forward) ═══");
  const freshEnrolls = ["2023-01-01", "2023-04-01", "2023-07-01", "2023-10-01",
                        "2024-01-01", "2024-04-01", "2024-07-01", "2024-10-01",
                        "2025-01-01", "2025-04-01", "2025-07-01"];
  console.log(`Running ${freshEnrolls.length} fresh 1yr cohorts...`);
  const freshR = await runCohortRange(freshEnrolls, 1);
  console.log(`  trades ${freshR.trades}  WR ${freshR.wr.toFixed(1)}%  exp ${freshR.ci.mean.toFixed(0)}bp [${freshR.ci.lo.toFixed(0)}, ${freshR.ci.hi.toFixed(0)}]`);
  console.log(`  cohort med $${freshR.cohortMedian.toFixed(0)}  min $${freshR.cohortMin.toFixed(0)}  max $${freshR.cohortMax.toFixed(0)}  positive ${freshR.positive}/${freshR.n}`);

  console.log(`\nElapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const report = {
    ranAt: new Date().toISOString(),
    trainCohorts: trainR.n, holdoutCohorts: holdoutR.n, freshCohorts: freshR.n,
    train: { wr: trainR.wr, expBp: trainR.ci, med: trainR.cohortMedian, min: trainR.cohortMin, positive: trainR.positive },
    holdout: { wr: holdoutR.wr, expBp: holdoutR.ci, med: holdoutR.cohortMedian, min: holdoutR.cohortMin, positive: holdoutR.positive },
    fresh1yr: { wr: freshR.wr, expBp: freshR.ci, med: freshR.cohortMedian, min: freshR.cohortMin, positive: freshR.positive },
    shipReady,
  };
  const outPath = path.resolve(RESULTS_DIR, "overfit-audit.json");
  const fs = await import("node:fs/promises");
  await fs.writeFile(outPath, JSON.stringify(report, null, 2));
  console.log(`Wrote ${path.relative(process.cwd(), outPath)}`);
}
main().catch(e => { console.error(e); process.exit(1); });
