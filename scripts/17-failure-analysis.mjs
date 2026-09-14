/**
 * Failure analysis: find the 1/77 negative cohort + per-regime WR.
 *
 * For each cohort, log enroll date, final capital, per-bot trades.
 * Identify the worst cohort, print its trades in detail.
 * Bucket all trades across all cohorts by regime (bull/chop/bear at
 * entry, based on 60d BTC return) and report WR + expectancy per regime.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSim } from "../../bots-sim/access-sim-core/src/harness.mjs";
import { plugin, bots, buildPortfolioMembers } from "../../bots-sim/markets/btc/index.mjs";

const __filename = fileURLToPath(import.meta.url);
const HERE = path.dirname(__filename);
const DATA_DIR = path.resolve(HERE, "..", "data");

const rawBars = JSON.parse(readFileSync(path.join(DATA_DIR, "btc-daily.json"), "utf8")).bars;
const barByDate = new Map(rawBars.map((b, i) => [b.date, { ...b, i }]));

function regimeAt(dateStr) {
  const b = barByDate.get(dateStr);
  if (!b || b.i < 60) return "unknown";
  const past = rawBars[b.i - 60];
  const ret = (b.close - past.close) / past.close;
  if (ret > 0.15) return "strong-bull";
  if (ret > 0.05) return "bull";
  if (ret < -0.15) return "strong-bear";
  if (ret < -0.05) return "bear";
  return "chop";
}

function addMonths(d, m) { const x = new Date(d + "T00:00:00Z"); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); }
function addYears(d, y) { const x = new Date(d + "T00:00:00Z"); x.setUTCFullYear(x.getUTCFullYear() + y); return x.toISOString().slice(0, 10); }

async function main() {
  const HIST_START = "2011-01-01", HIST_END = "2026-09-10";
  const enrollments = [];
  let cur = HIST_START;
  while (addYears(cur, 3) <= HIST_END) { enrollments.push(cur); cur = addMonths(cur, 2); }

  const cohortSummaries = [];
  const regimeBuckets = {}; // regime -> { trades, wins, returns[] }

  for (const enroll of enrollments) {
    const to = addYears(enroll, 3);
    const members = buildPortfolioMembers(1000);
    const r = await runSim({ plugin, members, bots, window: { from: enroll, to }, cadenceSec: 86400, startingCapital: 1000 });
    const meanFinal = r.summary.memberOutcomes.reduce((a, x) => a + x.finalCapital, 0) / r.summary.memberOutcomes.length;
    cohortSummaries.push({ enroll, to, meanFinal, members: r.members });
    for (const m of r.members) {
      for (const h of m.history) {
        if (h.exit_reason === "END_OF_SIM" || h.exit_reason === "PANIC_UNENROLL") continue;
        const reg = regimeAt(h.entryTime.slice(0, 10));
        regimeBuckets[reg] = regimeBuckets[reg] || { trades: 0, wins: 0, returns: [] };
        regimeBuckets[reg].trades++;
        if (h.pnl > 0) regimeBuckets[reg].wins++;
        regimeBuckets[reg].returns.push(h.net_return_pct);
      }
    }
  }

  // Sort worst-to-best
  cohortSummaries.sort((a, b) => a.meanFinal - b.meanFinal);
  console.log("═══ WORST 5 COHORTS ═══");
  console.log("enroll       to           meanFinal   regime@enroll");
  for (const c of cohortSummaries.slice(0, 5)) {
    console.log(`  ${c.enroll}  ${c.to}   $${c.meanFinal.toFixed(0).padStart(5)}   ${regimeAt(c.enroll)}`);
  }
  console.log("\n═══ BEST 5 COHORTS ═══");
  for (const c of cohortSummaries.slice(-5).reverse()) {
    console.log(`  ${c.enroll}  ${c.to}   $${c.meanFinal.toFixed(0).padStart(5)}   ${regimeAt(c.enroll)}`);
  }

  // Detail the losing cohort
  const loser = cohortSummaries[0];
  console.log("\n═══ DETAIL: WORST COHORT (enroll " + loser.enroll + ") ═══");
  console.log("Regime at enroll:", regimeAt(loser.enroll));
  for (const m of loser.members) {
    const t = m.history.filter(h => h.exit_reason !== "END_OF_SIM" && h.exit_reason !== "PANIC_UNENROLL");
    const w = t.filter(h => h.pnl > 0).length;
    console.log(`  ${m.config.bot_id.replace('argus-btc-', '').padEnd(22)}  final $${m.capital.toFixed(0).padStart(5)}  trades ${t.length}  wins ${w}`);
    // Show first 5 trades
    for (const h of t.slice(0, 5)) {
      const reg = regimeAt(h.entryTime.slice(0, 10));
      console.log(`      ${h.entryTime.slice(0,10)} → ${h.exit_ts.slice(0,10)}  ${reg.padEnd(12)}  ${h.exit_reason.padEnd(8)}  pnl $${h.pnl.toFixed(0).padStart(4)}`);
    }
  }

  // Per-regime aggregate
  console.log("\n═══ PER-REGIME AGGREGATE (all cohorts pooled) ═══");
  console.log("regime         trades    WR      exp(bp)");
  const regimeOrder = ["strong-bull", "bull", "chop", "bear", "strong-bear"];
  for (const reg of regimeOrder) {
    const b = regimeBuckets[reg];
    if (!b) { console.log(`  ${reg.padEnd(13)}    0      —        —`); continue; }
    const wr = (b.wins / b.trades * 100);
    const mean = b.returns.reduce((a, x) => a + x, 0) / b.returns.length;
    console.log(`  ${reg.padEnd(13)}  ${String(b.trades).padStart(5)}   ${wr.toFixed(1).padStart(5)}%  ${(mean * 10000).toFixed(0).padStart(6)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
