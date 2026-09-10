/**
 * HOLDOUT-slice test for a shortlisted ship candidate.
 *
 * Reads a genome from results/<runId>-ab-analysis.json (best_of_a or best_of_b)
 * and runs it on the HOLDOUT slice (2026-03-11 → today) with bootstrap
 * Sortino CI. Reports all 6 PROTOCOL.md ship-gate criteria.
 *
 * CLI: npx tsx scripts/10-test-holdout.ts <runId> [arm=A|B] [bootstrapN=10000]
 *
 * PROTOCOL.md compliance: this script is the ONLY place HOLDOUT is touched
 * during iteration. Not called from GA fitness. Not called from A/B analysis.
 * Only invoked when a shortlisted candidate is ready to face the locked slice.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(__dirname, "..", "data");
const RESULTS_DIR = path.resolve(__dirname, "..", "results");

const START_CAPITAL = 1000;
const COST_BPS_ROUNDTRIP = 50;
const LIQUIDATION_THRESHOLD = 10;
const SLIPPAGE_BASE_BPS = 5;
const SLIPPAGE_VOL_COEF = 200;
const MAX_POSITION_USD = 10_000;
const FUNDING_BPS_PER_DAY = 3;
const EVENT_DELAY_DAYS = 1;
const MACRO_PCTILE_WINDOW = 250;

const VALIDATION_END_DATE = "2026-03-10";

const SHIP_GATE = {
  minCalmar: 1.0,
  maxDD: 0.40,
  minCAGR: 0.0,
  minEdgeBpsPerRoundtrip: 20,
  minBootstrapSortinoCILower: 0.5,
  minRegimesPositive: 2, // out of 3 (bull, chop, bear)
};

// Types
interface BtcDay { date: string; ts: number; open: number; high: number; low: number; close: number; }
interface EventRow { date: string; category: string; impact_score: number; magnitude: number; description: string; }
interface MacroRow { date: string; ts: number; vix: number; dxy: number; us10y: number; sp500: number; gold: number; }
type Genome = number[];

const CATEGORIES = ["hack", "regulation", "macro", "geopolitical", "adoption", "onchain", "market_structure"];

function decode(g: Genome) {
  return {
    rsi_oversold: 20 + g[0] * 20,
    rsi_overbought: 60 + g[1] * 30,
    ma_fast_period: 3 + Math.floor(g[2] * 12),
    ma_slow_period: 20 + Math.floor(g[3] * 80),
    ma_trend_period: 100 + Math.floor(g[4] * 200),
    entry_conf_threshold: 0.3 + g[5] * 0.6,
    base_position: 0.1 + g[6] * 0.9,
    vol_scale: g[7] * 2,
    stop_loss_pct: 0.02 + g[8] * 0.18,
    take_profit_pct: 0.05 + g[9] * 0.95,
    max_hold_days: 5 + Math.floor(g[10] * 95),
    trend_weight: g[11],
    rsi_weight: g[12],
    momentum_weight: g[13],
    cooldown_days: Math.floor(g[14] * 20),
    bearish_event_fear: g[15],
    event_memory_days: 5 + Math.floor(g[16] * 55),
    composite_risk_off_fear: g.length > 17 ? g[17] : 0,
    composite_risk_on_boost: g.length > 18 ? g[18] : 0,
  };
}

function precomputeIndicators(bars: BtcDay[]) {
  const closes = bars.map((b) => b.close);
  const rsi: number[] = new Array(bars.length).fill(50);
  const period = 14;
  for (let i = period; i < bars.length; i++) {
    let g = 0, l = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = closes[j] - closes[j - 1];
      if (d >= 0) g += d; else l -= d;
    }
    const avgG = g / period, avgL = l / period;
    rsi[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  const vol20: number[] = new Array(bars.length).fill(0);
  for (let i = 21; i < bars.length; i++) {
    const rs: number[] = [];
    for (let j = i - 19; j <= i; j++) rs.push((closes[j] - closes[j - 1]) / closes[j - 1]);
    const m = rs.reduce((a, b) => a + b, 0) / rs.length;
    const v = rs.reduce((a, b) => a + (b - m) ** 2, 0) / (rs.length - 1);
    vol20[i] = Math.sqrt(v);
  }
  return { rsi, vol20 };
}

function computeMa(closes: number[], i: number, period: number): number {
  if (i < period) return closes[i];
  let sum = 0;
  for (let j = i - period + 1; j <= i; j++) sum += closes[j];
  return sum / period;
}

interface EventState {
  days_since_hack: number; days_since_regulation: number; days_since_macro: number;
  days_since_geopolitical: number; days_since_adoption: number; days_since_onchain: number;
  days_since_market_structure: number;
}
interface MacroState { vix_pctile: number; dxy_pctile: number; us10y_pctile: number; sp500_20d_ret: number; }

function precomputeEventState(bars: BtcDay[], events: EventRow[]): EventState[] {
  const byCat: Record<string, number[]> = {};
  for (const c of CATEGORIES) byCat[c] = [];
  for (const ev of events) {
    const t = new Date(ev.date + "T00:00:00Z").getTime() + EVENT_DELAY_DAYS * 86400000;
    if (byCat[ev.category]) byCat[ev.category].push(t);
  }
  for (const c of CATEGORIES) byCat[c].sort((a, b) => a - b);
  return bars.map((bar) => {
    const t = bar.ts;
    const daysSince = (arr: number[]) => {
      let best = 999;
      for (const evT of arr) { if (evT > t) break; const d = Math.floor((t - evT) / 86400000); if (d < best) best = d; }
      return best;
    };
    return {
      days_since_hack: daysSince(byCat.hack || []),
      days_since_regulation: daysSince(byCat.regulation || []),
      days_since_macro: daysSince(byCat.macro || []),
      days_since_geopolitical: daysSince(byCat.geopolitical || []),
      days_since_adoption: daysSince(byCat.adoption || []),
      days_since_onchain: daysSince(byCat.onchain || []),
      days_since_market_structure: daysSince(byCat.market_structure || []),
    };
  });
}

function precomputeMacroState(bars: BtcDay[], macro: MacroRow[]): MacroState[] {
  const vix = macro.map((m) => m.vix);
  const dxy = macro.map((m) => m.dxy);
  const yld = macro.map((m) => m.us10y);
  const sp = macro.map((m) => m.sp500);
  const win = MACRO_PCTILE_WINDOW;
  const pctile = (arr: number[], i: number) => {
    if (i < 20) return 0.5;
    const s = Math.max(0, i - win + 1);
    let below = 0, count = 0;
    for (let j = s; j <= i; j++) { if (arr[j] < arr[i]) below++; count++; }
    return count > 0 ? below / count : 0.5;
  };
  return bars.map((_, i) => ({
    vix_pctile: pctile(vix, i),
    dxy_pctile: pctile(dxy, i),
    us10y_pctile: pctile(yld, i),
    sp500_20d_ret: i >= 20 && sp[i - 20] > 0 ? (sp[i] - sp[i - 20]) / sp[i - 20] : 0,
  }));
}

function simulate(bars: BtcDay[], indic: { rsi: number[]; vol20: number[] }, evs: EventState[], ms: MacroState[], genome: Genome, startIdx: number, endIdx: number) {
  const p = decode(genome);
  const closes = bars.map((b) => b.close);
  const rt = COST_BPS_ROUNDTRIP / 10000;
  let equity = START_CAPITAL, cash = START_CAPITAL, btcHeld = 0, entryPrice = 0;
  let daysInPos = 0, daysSinceExit = 999;
  let peakEquity = START_CAPITAL, maxDdPct = 0, nTrades = 0, liquidated = false, survivalDays = 0;
  const dailyReturns: number[] = [];
  let pending: number | null = null;

  for (let i = startIdx; i <= endIdx; i++) {
    const bar = bars[i];
    const { open: pO, high: pH, low: pL, close: pC } = bar;
    const slipBps = SLIPPAGE_BASE_BPS + SLIPPAGE_VOL_COEF * Math.max(0, indic.vol20[i] - 0.02);
    const slip = slipBps / 10000;

    // Fill pending
    if (pending !== null) {
      const curPct = (btcHeld * pO) / (cash + btcHeld * pO);
      const delta = pending - curPct;
      const eq = cash + btcHeld * pO;
      if (Math.abs(delta) > 0.05) {
        if (delta > 0) {
          const fp = pO * (1 + slip), usd = delta * eq;
          const cost = usd * rt * 0.5;
          cash -= usd; btcHeld += (usd - cost) / fp;
          if (btcHeld > 0 && entryPrice === 0) entryPrice = fp;
          nTrades++;
        } else {
          const fp = pO * (1 - slip);
          const btcToSell = -delta * eq / pO;
          const usdOut = btcToSell * fp;
          cash += usdOut - usdOut * rt * 0.5;
          btcHeld -= btcToSell;
          if (btcHeld <= 0.0001) { btcHeld = 0; entryPrice = 0; daysInPos = 0; daysSinceExit = 0; }
          nTrades++;
        }
      }
      pending = null;
    }

    // Intrabar stop/target + gap-through
    if (btcHeld > 0) {
      const sp_ = entryPrice * (1 - p.stop_loss_pct), tp_ = entryPrice * (1 + p.take_profit_pct);
      let exit: number | null = null;
      if (pO <= sp_) exit = pO;
      else if (pO >= tp_) exit = pO;
      else if (pL <= sp_) exit = sp_;
      else if (pH >= tp_) exit = tp_;
      if (exit !== null) {
        const fp = exit * (1 - slip);
        cash += btcHeld * fp * (1 - rt * 0.5);
        btcHeld = 0; entryPrice = 0; daysInPos = 0; daysSinceExit = 0; nTrades++;
        pending = null;
      }
    }

    // Funding
    if (btcHeld > 0) cash -= btcHeld * pC * (FUNDING_BPS_PER_DAY / 10000);

    // Mark
    equity = cash + btcHeld * pC;
    if (equity > peakEquity) peakEquity = equity;
    const dd = (peakEquity - equity) / peakEquity;
    if (dd > maxDdPct) maxDdPct = dd;
    if (equity < LIQUIDATION_THRESHOLD) { liquidated = true; break; }
    survivalDays = i - startIdx + 1;

    if (i > startIdx) {
      const eqY = cash + btcHeld * bars[i - 1].close;
      dailyReturns.push(eqY > 0 ? (equity - eqY) / eqY : 0);
    } else dailyReturns.push(0);

    if (i - startIdx < Math.max(p.ma_trend_period, 30)) {
      if (btcHeld > 0) daysInPos++; else daysSinceExit++;
      continue;
    }

    // Signals
    const maF = computeMa(closes, i, p.ma_fast_period);
    const maS = computeMa(closes, i, p.ma_slow_period);
    const maT = computeMa(closes, i, p.ma_trend_period);
    const rsi = indic.rsi[i];
    const vol = indic.vol20[i];
    const r5 = i >= 5 ? (pC - closes[i - 5]) / closes[i - 5] : 0;
    const r20 = i >= 20 ? (pC - closes[i - 20]) / closes[i - 20] : 0;
    const rS = rsi < p.rsi_oversold ? 1 : rsi > p.rsi_overbought ? 0 : (p.rsi_overbought - rsi) / (p.rsi_overbought - p.rsi_oversold);
    const tS = (pC > maF ? 0.33 : 0) + (maF > maS ? 0.33 : 0) + (pC > maT ? 0.34 : 0);
    const mS = Math.max(0, Math.min(1, 0.5 + (r5 + r20) * 5));
    const tw = p.rsi_weight + p.trend_weight + p.momentum_weight;
    const score = tw > 0 ? (p.rsi_weight * rS + p.trend_weight * tS + p.momentum_weight * mS) / tw : 0.5;

    // Event fear
    const e = evs[i];
    const nearest = Math.min(e.days_since_hack, e.days_since_macro, e.days_since_geopolitical, e.days_since_market_structure);
    let riskM = 1;
    if (nearest < p.event_memory_days) riskM = Math.max(0, 1 - p.bearish_event_fear * (1 - nearest / p.event_memory_days));

    // Composite macro (only if genome has those genes)
    let macroM = 1, macroB = 1;
    if (genome.length > 17) {
      const mst = ms[i];
      const worst = Math.max(mst.vix_pctile, mst.dxy_pctile, mst.us10y_pctile);
      if (worst > 0.8) macroM = Math.max(0, 1 - p.composite_risk_off_fear * (worst - 0.8) / 0.2);
      if (mst.sp500_20d_ret > 0.02 && mst.vix_pctile < 0.3) macroB = 1 + p.composite_risk_on_boost * 0.5;
    }

    // Position sizing with cap
    const volF = 1 - p.vol_scale * Math.max(0, vol - 0.02);
    let targetSize = Math.max(0, Math.min(1, p.base_position * volF * riskM * macroM * macroB));
    if (targetSize * equity > MAX_POSITION_USD) targetSize = MAX_POSITION_USD / equity;

    // Decision
    let desired: number;
    if (btcHeld > 0) {
      const maxH = daysInPos >= p.max_hold_days;
      const scoreDrop = score < p.entry_conf_threshold * 0.5;
      desired = (maxH || scoreDrop) ? 0 : (btcHeld * pC) / equity;
    } else {
      const cool = daysSinceExit >= p.cooldown_days;
      desired = (score >= p.entry_conf_threshold && cool) ? targetSize : 0;
    }

    const cur = (btcHeld * pC) / equity;
    if (Math.abs(desired - cur) > 0.05) pending = desired;
    if (btcHeld > 0) { daysInPos++; daysSinceExit = 0; } else daysSinceExit++;
  }

  const finalEquity = liquidated ? 0 : equity;
  const years = (endIdx - startIdx + 1) / 365.25;
  const totalR = finalEquity / START_CAPITAL;
  const cagr = years > 0 && totalR > 0 ? Math.pow(totalR, 1 / years) - 1 : -1;
  const calmar = maxDdPct > 0.0001 ? cagr / maxDdPct : cagr / 0.0001;
  const meanR = dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const down = dailyReturns.filter((r) => r < 0);
  const downMean = down.length > 0 ? down.reduce((a, b) => a + b, 0) / down.length : 0;
  const downStd = down.length > 1 ? Math.sqrt(down.reduce((a, b) => a + (b - downMean) ** 2, 0) / (down.length - 1)) : 0.0001;
  const sortino = downStd > 0 ? meanR / downStd * Math.sqrt(365) : 0;

  return { final_equity: finalEquity, max_dd_pct: maxDdPct, n_trades: nTrades, sortino, calmar, cagr, liquidated, daily_returns: dailyReturns, survival_days: survivalDays };
}

// -----------------------------------------------------------
// Bootstrap Sortino CI
// -----------------------------------------------------------
function bootstrapSortino(dailyReturns: number[], nBoot: number, rng: () => number): { lower: number; upper: number; mean: number } {
  const sortinos: number[] = [];
  const n = dailyReturns.length;
  if (n < 10) return { lower: NaN, upper: NaN, mean: NaN };
  for (let b = 0; b < nBoot; b++) {
    const sample: number[] = [];
    for (let i = 0; i < n; i++) sample.push(dailyReturns[Math.floor(rng() * n)]);
    const m = sample.reduce((a, x) => a + x, 0) / n;
    const dn = sample.filter((x) => x < 0);
    const dm = dn.length > 0 ? dn.reduce((a, x) => a + x, 0) / dn.length : 0;
    const ds = dn.length > 1 ? Math.sqrt(dn.reduce((a, x) => a + (x - dm) ** 2, 0) / (dn.length - 1)) : 0.0001;
    sortinos.push(ds > 0 ? m / ds * Math.sqrt(365) : 0);
  }
  sortinos.sort((a, b) => a - b);
  return {
    lower: sortinos[Math.floor(nBoot * 0.025)],
    upper: sortinos[Math.floor(nBoot * 0.975)],
    mean: sortinos.reduce((a, b) => a + b, 0) / nBoot,
  };
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const runId = process.argv[2] ?? "v6ab";
  const arm = (process.argv[3] ?? "A").toUpperCase();
  const bootN = Number(process.argv[4] ?? 10000);

  const analysisPath = path.join(RESULTS_DIR, `${runId}-ab-analysis.json`);
  const analysis = JSON.parse(await fs.readFile(analysisPath, "utf8"));
  const bestKey = arm === "A" ? "best_of_a" : "best_of_b";
  const best = analysis.stats?.[arm]?.best ?? analysis[bestKey];
  if (!best) throw new Error(`No ${bestKey} in ${analysisPath}`);
  const genome: Genome = best.best_genome;
  console.log(`Testing best-of-${arm} from ${runId} (seed ${best.seed}, ${genome.length}-gene)`);
  console.log(`Validation Calmar seen during A/B: ${best.val_calmar.toFixed(3)}\n`);

  // Load data
  const bars = (JSON.parse(await fs.readFile(path.join(DATA_DIR, "btc-daily.json"), "utf8")) as { bars: BtcDay[] }).bars;
  const events = (JSON.parse(await fs.readFile(path.join(DATA_DIR, "events.json"), "utf8")) as { events: EventRow[] }).events;
  const macro = (JSON.parse(await fs.readFile(path.join(DATA_DIR, "macro-daily.json"), "utf8")) as { rows: MacroRow[] }).rows;

  // Find HOLDOUT slice: after VALIDATION_END_DATE
  const holdoutStart = bars.findIndex((b) => b.date > VALIDATION_END_DATE);
  if (holdoutStart < 0) throw new Error("No holdout data");
  const holdoutEnd = bars.length - 1;
  const holdoutBars = holdoutEnd - holdoutStart + 1;
  console.log(`HOLDOUT slice: ${bars[holdoutStart].date} → ${bars[holdoutEnd].date} (${holdoutBars} bars, ${(holdoutBars / 30).toFixed(1)} months)`);

  const bhFinal = (START_CAPITAL / bars[holdoutStart].close) * bars[holdoutEnd].close;
  console.log(`Buy-hold HOLDOUT: $${START_CAPITAL} → $${bhFinal.toFixed(0)} (${((bhFinal / START_CAPITAL - 1) * 100).toFixed(1)}%)\n`);

  const indic = precomputeIndicators(bars);
  const evs = precomputeEventState(bars, events);
  const ms = precomputeMacroState(bars, macro);

  console.log("Running bot on HOLDOUT slice…");
  const r = simulate(bars, indic, evs, ms, genome, holdoutStart, holdoutEnd);

  console.log("\n" + "=".repeat(80));
  console.log("HOLDOUT RESULT");
  console.log("=".repeat(80));
  console.log(`Final equity: $${r.final_equity.toFixed(2)} (${((r.final_equity / START_CAPITAL - 1) * 100).toFixed(1)}%)`);
  console.log(`CAGR: ${(r.cagr * 100).toFixed(2)}% | Max DD: ${(r.max_dd_pct * 100).toFixed(2)}% | Sortino: ${r.sortino.toFixed(3)} | Calmar: ${r.calmar.toFixed(3)}`);
  console.log(`Trades: ${r.n_trades} | Survived: ${r.survival_days}/${holdoutBars} | Liquidated: ${r.liquidated ? "YES" : "NO"}`);
  console.log(`vs Buy-hold: bot ${r.final_equity > bhFinal ? "wins" : "loses"} by ${Math.abs(r.final_equity - bhFinal).toFixed(0)}`);

  console.log(`\nBootstrap Sortino CI (${bootN} resamples)…`);
  const boot = bootstrapSortino(r.daily_returns, bootN, makeRng(42));
  console.log(`  Mean: ${boot.mean.toFixed(3)}   95% CI: [${boot.lower.toFixed(3)}, ${boot.upper.toFixed(3)}]`);

  // Per-regime breakdown
  const closes = bars.map((b) => b.close);
  const buckets: Record<string, { d: number; sum: number }> = { bull: { d: 0, sum: 0 }, chop: { d: 0, sum: 0 }, bear: { d: 0, sum: 0 } };
  for (let i = 0; i < r.daily_returns.length; i++) {
    const idx = holdoutStart + i;
    if (idx < 60) continue;
    const btc60 = (closes[idx] - closes[idx - 60]) / closes[idx - 60];
    const k = btc60 > 0.05 ? "bull" : btc60 < -0.05 ? "bear" : "chop";
    buckets[k].d++;
    buckets[k].sum += r.daily_returns[i];
  }
  console.log("\nHOLDOUT per-regime breakdown:");
  const posRegimes = ["bull", "chop", "bear"].filter((k) => buckets[k].d > 0 && buckets[k].sum > 0);
  for (const k of ["bull", "chop", "bear"]) {
    const b = buckets[k];
    if (b.d === 0) { console.log(`  ${k.padEnd(4)}: 0 days`); continue; }
    console.log(`  ${k.padEnd(4)}: ${b.d.toString().padStart(3)}d | total ret ${(b.sum * 100).toFixed(2)}%`);
  }

  // Compute edge per round-trip
  const roundTrips = Math.floor(r.n_trades / 2);
  const profit = r.final_equity - START_CAPITAL;
  const perTrip = roundTrips > 0 ? profit / roundTrips : 0;
  const avgNotional = 5000; // rough proxy; real value depends on position sizing over time
  const edgeBps = roundTrips > 0 ? (perTrip / avgNotional) * 10000 : 0;

  // Ship-gate report
  console.log("\n" + "=".repeat(80));
  console.log("SHIP GATE REPORT (PROTOCOL.md § Ship Gate)");
  console.log("=".repeat(80));
  const gates = [
    { name: "1. OOS Calmar ≥ 1.0", ok: r.calmar >= SHIP_GATE.minCalmar, val: r.calmar.toFixed(3) },
    { name: "2. OOS Max DD < 40%", ok: r.max_dd_pct < SHIP_GATE.maxDD, val: `${(r.max_dd_pct * 100).toFixed(1)}%` },
    { name: "3. OOS CAGR ≥ 0", ok: r.cagr >= SHIP_GATE.minCAGR, val: `${(r.cagr * 100).toFixed(1)}%` },
    { name: `4. Net edge ≥ ${SHIP_GATE.minEdgeBpsPerRoundtrip} bps/RT`, ok: edgeBps >= SHIP_GATE.minEdgeBpsPerRoundtrip, val: `${edgeBps.toFixed(0)} bps (rough, ${roundTrips} RTs)` },
    { name: `5. Bootstrap Sortino CI lower ≥ ${SHIP_GATE.minBootstrapSortinoCILower}`, ok: boot.lower >= SHIP_GATE.minBootstrapSortinoCILower, val: boot.lower.toFixed(3) },
    { name: `6. Positive in ≥ ${SHIP_GATE.minRegimesPositive}/3 regimes`, ok: posRegimes.length >= SHIP_GATE.minRegimesPositive, val: `${posRegimes.length}/3 (${posRegimes.join("+")})` },
  ];
  for (const g of gates) console.log(`  ${g.ok ? "✓" : "✗"} ${g.name.padEnd(45)} → ${g.val}`);
  const allPassed = gates.every((g) => g.ok);
  console.log(`\nOVERALL: ${allPassed ? "✓ SHIP-ELIGIBLE — proceed to paper-sim" : "✗ NOT ship-eligible — iterate further"}`);

  await fs.writeFile(path.join(RESULTS_DIR, `${runId}-holdout-${arm}.json`), JSON.stringify({
    run_id: runId, arm, seed: best.seed, genome, decoded: decode(genome),
    holdout_dates: { start: bars[holdoutStart].date, end: bars[holdoutEnd].date },
    holdout_bars: holdoutBars, buy_hold_final: bhFinal,
    result: r, bootstrap_sortino: boot, regime_breakdown: buckets,
    ship_gate: { gates, all_passed: allPassed },
  }, null, 2));
  console.log(`\nWrote results/${runId}-holdout-${arm}.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
