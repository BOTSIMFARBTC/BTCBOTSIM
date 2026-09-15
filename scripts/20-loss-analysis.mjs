/**
 * Deep dive into losing trades — segment by:
 *   - Regime at entry
 *   - Score at entry
 *   - Bar range at entry (proxy for vol)
 *   - Day-of-week
 *   - Days since last win
 *   - Trade held-hours before SL
 *
 * Identify features that correlate with losses → filter candidates.
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
  const enrollments = [];
  let cur = "2011-01-01";
  while (addYears(cur, 3) <= "2026-09-10") { enrollments.push(cur); cur = addMonths(cur, 2); }

  const allTrades = [];
  for (const enroll of enrollments) {
    const to = addYears(enroll, 3);
    const members = buildPortfolioMembers(1000);
    const r = await runSim({ plugin, members, bots, window: { from: enroll, to }, cadenceSec: 86400, startingCapital: 1000 });
    for (const m of r.members) {
      for (const h of m.history) {
        if (h.exit_reason === "END_OF_SIM" || h.exit_reason === "PANIC_UNENROLL") continue;
        const entryBar = barByDate.get(h.entryTime.slice(0, 10));
        if (!entryBar) continue;
        allTrades.push({
          botId: m.config.bot_id,
          entryDate: h.entryTime.slice(0, 10),
          exitReason: h.exit_reason,
          pnl: h.pnl,
          netReturnPct: h.net_return_pct,
          heldHours: h.held_hours,
          confidence: h.confidence ?? 100,
          entryBar,
          regime: regimeAt(h.entryTime.slice(0, 10)),
          dow: new Date(h.entryTime).getUTCDay(),  // 0=Sunday
          rangePct: (entryBar.high - entryBar.low) / entryBar.close,
        });
      }
    }
  }
  console.log(`Total trades: ${allTrades.length}`);

  const wins = allTrades.filter(t => t.pnl > 0);
  const losses = allTrades.filter(t => t.pnl < 0);
  console.log(`Wins: ${wins.length}  Losses: ${losses.length}  WR: ${(wins.length/allTrades.length*100).toFixed(1)}%`);

  const segmentBy = (arr, key) => {
    const map = new Map();
    for (const t of arr) {
      const k = typeof key === "function" ? key(t) : t[key];
      const b = map.get(k) ?? { n: 0, wins: 0, meanRet: 0 };
      b.n++;
      if (t.pnl > 0) b.wins++;
      b.meanRet += t.netReturnPct;
      map.set(k, b);
    }
    for (const [k, v] of map) { v.wr = v.wins / v.n * 100; v.meanRet /= v.n; }
    return map;
  };

  console.log("\n═══ BY REGIME ═══");
  const byReg = segmentBy(allTrades, "regime");
  for (const [k, v] of [...byReg].sort((a, b) => a[1].wr - b[1].wr)) {
    console.log(`  ${k.padEnd(13)}  n=${String(v.n).padStart(5)}  WR ${v.wr.toFixed(1).padStart(5)}%  meanRet ${(v.meanRet*100).toFixed(2).padStart(6)}%`);
  }

  console.log("\n═══ BY BAR RANGE % AT ENTRY (vol proxy) ═══");
  const byRange = segmentBy(allTrades, t => t.rangePct < 0.02 ? "0-2%" : t.rangePct < 0.04 ? "2-4%" : t.rangePct < 0.06 ? "4-6%" : t.rangePct < 0.10 ? "6-10%" : "10%+");
  for (const [k, v] of [...byRange].sort((a, b) => a[1].wr - b[1].wr)) {
    console.log(`  range ${k.padEnd(6)}  n=${String(v.n).padStart(5)}  WR ${v.wr.toFixed(1).padStart(5)}%  meanRet ${(v.meanRet*100).toFixed(2).padStart(6)}%`);
  }

  console.log("\n═══ BY CONFIDENCE (entry score) ═══");
  const byConf = segmentBy(allTrades, t => {
    const c = t.confidence;
    return c < 70 ? "<70" : c < 75 ? "70-74" : c < 80 ? "75-79" : c < 85 ? "80-84" : c < 90 ? "85-89" : "90+";
  });
  for (const [k, v] of [...byConf].sort()) {
    console.log(`  conf ${k.padEnd(6)}  n=${String(v.n).padStart(5)}  WR ${v.wr.toFixed(1).padStart(5)}%  meanRet ${(v.meanRet*100).toFixed(2).padStart(6)}%`);
  }

  console.log("\n═══ BY DAY OF WEEK ═══");
  const dows = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const byDow = segmentBy(allTrades, "dow");
  for (const [k, v] of [...byDow].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${dows[k].padEnd(6)}  n=${String(v.n).padStart(5)}  WR ${v.wr.toFixed(1).padStart(5)}%  meanRet ${(v.meanRet*100).toFixed(2).padStart(6)}%`);
  }

  console.log("\n═══ BY EXIT REASON ═══");
  const byExit = segmentBy(allTrades, "exitReason");
  for (const [k, v] of [...byExit].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${k.padEnd(10)}  n=${String(v.n).padStart(5)}  WR ${v.wr.toFixed(1).padStart(5)}%  meanRet ${(v.meanRet*100).toFixed(2).padStart(6)}%`);
  }

  console.log("\n═══ BY HELD-HOURS BEFORE EXIT ═══");
  const byHold = segmentBy(allTrades, t => {
    const h = t.heldHours;
    return h < 24 ? "<1d" : h < 72 ? "1-3d" : h < 168 ? "3-7d" : h < 336 ? "1-2w" : h < 720 ? "2-4w" : "4w+";
  });
  for (const [k, v] of [...byHold]) {
    console.log(`  hold ${k.padEnd(6)}  n=${String(v.n).padStart(5)}  WR ${v.wr.toFixed(1).padStart(5)}%  meanRet ${(v.meanRet*100).toFixed(2).padStart(6)}%`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
