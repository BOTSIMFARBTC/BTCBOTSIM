/**
 * Per-bot overfit test. Run each of the 5 bots separately on holdout
 * cohorts + fresh 1yr windows. Identify which bots generalize vs
 * which collapse.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSim } from "../../bots-sim/access-sim-core/src/harness.mjs";
import { plugin, bots, buildPortfolioMembers } from "../../bots-sim/markets/btc/index.mjs";

const __filename = fileURLToPath(import.meta.url);
const HERE = path.dirname(__filename);

function addMonths(d, m) { const x = new Date(d + "T00:00:00Z"); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); }
function addYears(d, y) { const x = new Date(d + "T00:00:00Z"); x.setUTCFullYear(x.getUTCFullYear() + y); return x.toISOString().slice(0, 10); }
function mulberry32(seed) { let t = seed >>> 0; return () => { t = (t + 0x6D2B79F5) >>> 0; let r = t; r = Math.imul(r ^ (r >>> 15), r | 1); r ^= r + Math.imul(r ^ (r >>> 7), r | 61); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; }
function bootstrap(samples, iters = 2000, seed = 42) {
  if (samples.length === 0) return { mean: 0, lo: 0, hi: 0 };
  const rng = mulberry32(seed);
  const means = new Array(iters); const n = samples.length;
  for (let it = 0; it < iters; it++) { let sum = 0; for (let i = 0; i < n; i++) sum += samples[Math.floor(rng() * n)]; means[it] = sum / n; }
  means.sort((a, b) => a - b);
  return { mean: samples.reduce((a, x) => a + x, 0) / n, lo: means[Math.floor(iters * 0.025)], hi: means[Math.floor(iters * 0.975)] };
}

async function runPerBot(enrolls, windowYears, label) {
  const perBot = Object.fromEntries(bots.map(b => [b.id, { returns: [], trades: 0, wins: 0, cohortFinals: [] }]));
  for (const enroll of enrolls) {
    const to = addYears(enroll, windowYears);
    const members = buildPortfolioMembers(1000);
    const r = await runSim({ plugin, members, bots, window: { from: enroll, to }, cadenceSec: 86400, startingCapital: 1000 });
    for (const m of r.members) {
      const bid = m.config.bot_id;
      const b = perBot[bid];
      for (const h of m.history) {
        if (h.exit_reason === "END_OF_SIM" || h.exit_reason === "PANIC_UNENROLL") continue;
        b.trades++; if (h.pnl > 0) b.wins++;
        b.returns.push(h.net_return_pct);
      }
      b.cohortFinals.push(m.capital);
    }
  }
  console.log(`\n═══ ${label} (${enrolls.length} cohorts × ${windowYears}yr) ═══`);
  console.log("bot                                                 trades   WR     exp(bp) [95% CI]    med    pos");
  console.log("─".repeat(115));
  const rows = [];
  for (const bid of Object.keys(perBot)) {
    const b = perBot[bid];
    const wr = b.trades > 0 ? b.wins / b.trades * 100 : 0;
    const ci = bootstrap(b.returns.map(x => x * 10000));
    const finals = [...b.cohortFinals].sort((a, x) => a - x);
    const med = finals[Math.floor(finals.length / 2)];
    const pos = finals.filter(f => f > 1000).length;
    rows.push({ bid, trades: b.trades, wr, ci, med, pos, n: finals.length });
    console.log(`  ${bid.slice(0, 50).padEnd(50)}  ${String(b.trades).padStart(4)}  ${wr.toFixed(1).padStart(5)}%  ${ci.mean.toFixed(0).padStart(5)} [${ci.lo.toFixed(0).padStart(4)},${ci.hi.toFixed(0).padStart(4)}]  ${med.toFixed(0).padStart(5)}  ${pos}/${finals.length}`);
  }
  return rows;
}

async function main() {
  const allEnrolls = [];
  let cur = "2011-01-01";
  while (addYears(cur, 3) <= "2026-09-10") { allEnrolls.push(cur); cur = addMonths(cur, 2); }
  const trainEnrolls = allEnrolls.slice(0, 50);
  const holdoutEnrolls = allEnrolls.slice(50);
  const freshEnrolls = ["2023-01-01", "2023-04-01", "2023-07-01", "2023-10-01",
                        "2024-01-01", "2024-04-01", "2024-07-01", "2024-10-01",
                        "2025-01-01", "2025-04-01", "2025-07-01"];

  const trainRows = await runPerBot(trainEnrolls, 3, "TRAINING");
  const holdoutRows = await runPerBot(holdoutEnrolls, 3, "HOLDOUT");
  const freshRows = await runPerBot(freshEnrolls, 1, "FRESH 1YR");

  console.log("\n═══ GENERALIZATION SCORECARD (train vs fresh 1yr) ═══");
  console.log("bot                                                 WR:train→fresh    exp lower CI: train→fresh");
  console.log("─".repeat(105));
  for (let i = 0; i < trainRows.length; i++) {
    const t = trainRows[i], f = freshRows.find(r => r.bid === t.bid);
    const wrDelta = f.wr - t.wr;
    const ciDelta = f.ci.lo - t.ci.lo;
    const flag = f.ci.lo > 0 && wrDelta > -15 ? "GENERALIZES" : "SHAKY";
    console.log(`  ${t.bid.slice(0, 50).padEnd(50)}  ${t.wr.toFixed(1).padStart(5)}% → ${f.wr.toFixed(1).padStart(5)}%  (${wrDelta.toFixed(1).padStart(5)}pp)   ${t.ci.lo.toFixed(0).padStart(5)} → ${f.ci.lo.toFixed(0).padStart(5)}   ${flag}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
