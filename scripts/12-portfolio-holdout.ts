/**
 * Portfolio-of-bots HOLDOUT test (Option 4 from v7 debrief).
 *
 * v6 showed that best-of-single-bot on val is cherry-picking (mean val Calmar
 * 0.33, best-of-40 got 1.19 by luck, holdout Calmar -1.05). v7 confirmed no
 * single bot beats BH on risk-adjusted alpha in the 2023-26 bull era.
 *
 * Hypothesis for portfolio: individual bots are noisy, but a portfolio of
 * top-N evolved bots might have LOWER variance and thus better Sortino/Calmar
 * even if same mean return. Classical diversification.
 *
 * Approach:
 *   1. Load all genomes from v6ab + v6ab-verify (60 seeds total).
 *   2. Rank by val Calmar. Take top-N (default 10).
 *   3. Run each on HOLDOUT slice (2026-03-11 → today).
 *   4. Compute portfolio = mean(bot_daily_returns) per day, equal-weighted.
 *   5. Compute correlation matrix between bots (diagnoses diversification benefit).
 *   6. Report all 6 ship gates on portfolio metrics.
 *
 * CLI: npx tsx scripts/12-portfolio-holdout.ts [topN=10]
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

const SHIP_GATE = { minCalmar: 1.0, maxDD: 0.40, minCAGR: 0.0, minEdgeBps: 20, minSortinoLower: 0.5, minRegimes: 2 };

interface BtcDay { date: string; ts: number; open: number; high: number; low: number; close: number; }
interface EventRow { date: string; category: string; impact_score: number; magnitude: number; description: string; }
interface MacroRow { date: string; ts: number; vix: number; dxy: number; us10y: number; sp500: number; gold: number; }
type Genome = number[];

const CATEGORIES = ["hack", "regulation", "macro", "geopolitical", "adoption", "onchain", "market_structure"];

function decode(g: Genome) {
  return {
    rsi_oversold: 20 + g[0] * 20, rsi_overbought: 60 + g[1] * 30,
    ma_fast_period: 3 + Math.floor(g[2] * 12), ma_slow_period: 20 + Math.floor(g[3] * 80),
    ma_trend_period: 100 + Math.floor(g[4] * 200), entry_conf_threshold: 0.3 + g[5] * 0.6,
    base_position: 0.1 + g[6] * 0.9, vol_scale: g[7] * 2,
    stop_loss_pct: 0.02 + g[8] * 0.18, take_profit_pct: 0.05 + g[9] * 0.95,
    max_hold_days: 5 + Math.floor(g[10] * 95),
    trend_weight: g[11], rsi_weight: g[12], momentum_weight: g[13],
    cooldown_days: Math.floor(g[14] * 20),
    bearish_event_fear: g[15], event_memory_days: 5 + Math.floor(g[16] * 55),
    composite_risk_off_fear: g.length > 17 ? g[17] : 0,
    composite_risk_on_boost: g.length > 18 ? g[18] : 0,
  };
}

function precomputeIndicators(bars: BtcDay[]) {
  const closes = bars.map((b) => b.close);
  const rsi: number[] = new Array(bars.length).fill(50);
  for (let i = 14; i < bars.length; i++) {
    let g = 0, l = 0;
    for (let j = i - 13; j <= i; j++) { const d = closes[j] - closes[j - 1]; if (d >= 0) g += d; else l -= d; }
    const avgG = g / 14, avgL = l / 14;
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
      days_since_hack: daysSince(byCat.hack || []), days_since_regulation: daysSince(byCat.regulation || []),
      days_since_macro: daysSince(byCat.macro || []), days_since_geopolitical: daysSince(byCat.geopolitical || []),
      days_since_adoption: daysSince(byCat.adoption || []), days_since_onchain: daysSince(byCat.onchain || []),
      days_since_market_structure: daysSince(byCat.market_structure || []),
    };
  });
}

function precomputeMacroState(bars: BtcDay[], macro: MacroRow[]): MacroState[] {
  const vix = macro.map((m) => m.vix), dxy = macro.map((m) => m.dxy), yld = macro.map((m) => m.us10y), sp = macro.map((m) => m.sp500);
  const pctile = (arr: number[], i: number) => {
    if (i < 20) return 0.5;
    const s = Math.max(0, i - MACRO_PCTILE_WINDOW + 1);
    let below = 0, count = 0;
    for (let j = s; j <= i; j++) { if (arr[j] < arr[i]) below++; count++; }
    return count > 0 ? below / count : 0.5;
  };
  return bars.map((_, i) => ({
    vix_pctile: pctile(vix, i), dxy_pctile: pctile(dxy, i), us10y_pctile: pctile(yld, i),
    sp500_20d_ret: i >= 20 && sp[i - 20] > 0 ? (sp[i] - sp[i - 20]) / sp[i - 20] : 0,
  }));
}

// Simulate — with the HOLDOUT-appropriate warmup logic (full-history index)
function simulateHoldout(bars: BtcDay[], indic: { rsi: number[]; vol20: number[] }, evs: EventState[], ms: MacroState[], genome: Genome, startIdx: number, endIdx: number) {
  const p = decode(genome);
  const closes = bars.map((b) => b.close);
  const rt = COST_BPS_ROUNDTRIP / 10000;
  let equity = START_CAPITAL, cash = START_CAPITAL, btcHeld = 0, entryPrice = 0;
  let daysInPos = 0, daysSinceExit = 999;
  let peakEquity = START_CAPITAL, maxDdPct = 0, nTrades = 0, liquidated = false;
  const dailyReturns: number[] = [];
  let pending: number | null = null;

  for (let i = startIdx; i <= endIdx; i++) {
    const bar = bars[i];
    const { open: pO, high: pH, low: pL, close: pC } = bar;
    const slip = (SLIPPAGE_BASE_BPS + SLIPPAGE_VOL_COEF * Math.max(0, indic.vol20[i] - 0.02)) / 10000;

    if (pending !== null) {
      const curPct = (btcHeld * pO) / (cash + btcHeld * pO);
      const delta = pending - curPct;
      const eq = cash + btcHeld * pO;
      if (Math.abs(delta) > 0.05) {
        if (delta > 0) {
          const fp = pO * (1 + slip), usd = delta * eq;
          cash -= usd; btcHeld += (usd - usd * rt * 0.5) / fp;
          if (btcHeld > 0 && entryPrice === 0) entryPrice = fp;
          nTrades++;
        } else {
          const fp = pO * (1 - slip);
          const btcToSell = -delta * eq / pO;
          cash += btcToSell * fp * (1 - rt * 0.5);
          btcHeld -= btcToSell;
          if (btcHeld <= 0.0001) { btcHeld = 0; entryPrice = 0; daysInPos = 0; daysSinceExit = 0; }
          nTrades++;
        }
      }
      pending = null;
    }

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

    if (btcHeld > 0) cash -= btcHeld * pC * (FUNDING_BPS_PER_DAY / 10000);

    equity = cash + btcHeld * pC;
    if (equity > peakEquity) peakEquity = equity;
    const dd = (peakEquity - equity) / peakEquity;
    if (dd > maxDdPct) maxDdPct = dd;
    if (equity < LIQUIDATION_THRESHOLD) { liquidated = true; break; }

    if (i > startIdx) {
      const eqY = cash + btcHeld * bars[i - 1].close;
      dailyReturns.push(eqY > 0 ? (equity - eqY) / eqY : 0);
    } else dailyReturns.push(0);

    // HOLDOUT: use FULL-history bar index for warmup check (production has all history)
    if (i < Math.max(p.ma_trend_period, 30)) { if (btcHeld > 0) daysInPos++; else daysSinceExit++; continue; }

    const maF = computeMa(closes, i, p.ma_fast_period), maS = computeMa(closes, i, p.ma_slow_period), maT = computeMa(closes, i, p.ma_trend_period);
    const rsi = indic.rsi[i], vol = indic.vol20[i];
    const r5 = i >= 5 ? (pC - closes[i - 5]) / closes[i - 5] : 0;
    const r20 = i >= 20 ? (pC - closes[i - 20]) / closes[i - 20] : 0;
    const rS = rsi < p.rsi_oversold ? 1 : rsi > p.rsi_overbought ? 0 : (p.rsi_overbought - rsi) / (p.rsi_overbought - p.rsi_oversold);
    const tS = (pC > maF ? 0.33 : 0) + (maF > maS ? 0.33 : 0) + (pC > maT ? 0.34 : 0);
    const mS = Math.max(0, Math.min(1, 0.5 + (r5 + r20) * 5));
    const tw = p.rsi_weight + p.trend_weight + p.momentum_weight;
    const score = tw > 0 ? (p.rsi_weight * rS + p.trend_weight * tS + p.momentum_weight * mS) / tw : 0.5;

    const e = evs[i];
    const nearest = Math.min(e.days_since_hack, e.days_since_macro, e.days_since_geopolitical, e.days_since_market_structure);
    let riskM = 1;
    if (nearest < p.event_memory_days) riskM = Math.max(0, 1 - p.bearish_event_fear * (1 - nearest / p.event_memory_days));

    let macroM = 1, macroB = 1;
    if (genome.length > 17) {
      const mst = ms[i];
      const worst = Math.max(mst.vix_pctile, mst.dxy_pctile, mst.us10y_pctile);
      if (worst > 0.8) macroM = Math.max(0, 1 - p.composite_risk_off_fear * (worst - 0.8) / 0.2);
      if (mst.sp500_20d_ret > 0.02 && mst.vix_pctile < 0.3) macroB = 1 + p.composite_risk_on_boost * 0.5;
    }

    const volF = 1 - p.vol_scale * Math.max(0, vol - 0.02);
    let targetSize = Math.max(0, Math.min(1, p.base_position * volF * riskM * macroM * macroB));
    if (targetSize * equity > MAX_POSITION_USD) targetSize = MAX_POSITION_USD / equity;

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

  return { finalEquity: liquidated ? 0 : equity, maxDdPct, nTrades, dailyReturns, liquidated };
}

function computeMetrics(dailyReturns: number[], years: number, startEquity: number, finalEquity: number, maxDdPct: number) {
  const totalR = finalEquity / startEquity;
  const cagr = years > 0 && totalR > 0 ? Math.pow(totalR, 1 / years) - 1 : -1;
  const calmar = maxDdPct > 0.0001 ? cagr / maxDdPct : cagr / 0.0001;
  const meanR = dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const down = dailyReturns.filter((r) => r < 0);
  const dm = down.length > 0 ? down.reduce((a, b) => a + b, 0) / down.length : 0;
  const ds = down.length > 1 ? Math.sqrt(down.reduce((a, b) => a + (b - dm) ** 2, 0) / (down.length - 1)) : 0.0001;
  const sortino = ds > 0 ? meanR / ds * Math.sqrt(365) : 0;
  return { cagr, calmar, sortino };
}

function pearsonCorr(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = a.slice(0, n).reduce((x, y) => x + y, 0) / n;
  const mb = b.slice(0, n).reduce((x, y) => x + y, 0) / n;
  let num = 0, da2 = 0, db2 = 0;
  for (let i = 0; i < n; i++) {
    const dA = a[i] - ma, dB = b[i] - mb;
    num += dA * dB;
    da2 += dA * dA;
    db2 += dB * dB;
  }
  return da2 > 0 && db2 > 0 ? num / Math.sqrt(da2 * db2) : 0;
}

async function main() {
  const topN = Number(process.argv[2] ?? 10);

  // Load all seed results
  const v6Analysis = JSON.parse(await fs.readFile(path.join(RESULTS_DIR, "v6ab-ab-analysis.json"), "utf8"));
  const verifyAnalysis = JSON.parse(await fs.readFile(path.join(RESULTS_DIR, "v6ab-verify-ab-analysis.json"), "utf8"));

  const allSeeds: Array<{ label: string; genome: Genome; val_calmar: number; val_cagr: number; val_dd: number }> = [];
  for (const r of v6Analysis.all_results ?? []) {
    allSeeds.push({ label: `v6ab-${r.arm}-${r.seed}`, genome: r.best_genome, val_calmar: r.val_calmar, val_cagr: r.val_cagr, val_dd: r.val_dd });
  }
  for (const r of verifyAnalysis.all_results ?? []) {
    allSeeds.push({ label: `verify-${r.arm}-${r.seed}`, genome: r.best_genome, val_calmar: r.val_calmar, val_cagr: r.val_cagr, val_dd: r.val_dd });
  }
  console.log(`Loaded ${allSeeds.length} evolved bots from v6ab + verify`);

  // Rank by val Calmar, take top-N
  allSeeds.sort((a, b) => b.val_calmar - a.val_calmar);
  const shortlist = allSeeds.slice(0, topN);
  console.log(`\nTop-${topN} by val Calmar:`);
  for (const s of shortlist) console.log(`  ${s.label.padEnd(20)} val Calmar ${s.val_calmar.toFixed(3)}  CAGR ${(s.val_cagr*100).toFixed(1)}%  DD ${(s.val_dd*100).toFixed(1)}%`);

  // Load data
  const bars = (JSON.parse(await fs.readFile(path.join(DATA_DIR, "btc-daily.json"), "utf8")) as { bars: BtcDay[] }).bars;
  const events = (JSON.parse(await fs.readFile(path.join(DATA_DIR, "events.json"), "utf8")) as { events: EventRow[] }).events;
  const macro = (JSON.parse(await fs.readFile(path.join(DATA_DIR, "macro-daily.json"), "utf8")) as { rows: MacroRow[] }).rows;

  const holdoutStart = bars.findIndex((b) => b.date > VALIDATION_END_DATE);
  const holdoutEnd = bars.length - 1;
  const holdoutBars = holdoutEnd - holdoutStart + 1;
  console.log(`\nHOLDOUT: ${bars[holdoutStart].date} → ${bars[holdoutEnd].date} (${holdoutBars} bars, ${(holdoutBars / 30).toFixed(1)} mo)`);
  const bhFinal = (START_CAPITAL / bars[holdoutStart].close) * bars[holdoutEnd].close;
  const bhReturns: number[] = [];
  for (let i = holdoutStart + 1; i <= holdoutEnd; i++) bhReturns.push((bars[i].close - bars[i - 1].close) / bars[i - 1].close);
  console.log(`Buy-hold HOLDOUT: $${START_CAPITAL} → $${bhFinal.toFixed(0)} (${((bhFinal / START_CAPITAL - 1) * 100).toFixed(1)}%)`);

  const indic = precomputeIndicators(bars);
  const evs = precomputeEventState(bars, events);
  const ms = precomputeMacroState(bars, macro);

  // Run each bot on holdout
  console.log(`\nRunning ${topN} bots on HOLDOUT…`);
  const botRuns: { label: string; final: number; dd: number; nTrades: number; returns: number[]; liq: boolean }[] = [];
  for (const s of shortlist) {
    const r = simulateHoldout(bars, indic, evs, ms, s.genome, holdoutStart, holdoutEnd);
    botRuns.push({ label: s.label, final: r.finalEquity, dd: r.maxDdPct, nTrades: r.nTrades, returns: r.dailyReturns, liq: r.liquidated });
  }

  // Individual bot metrics table
  console.log("\n" + "=".repeat(100));
  console.log("INDIVIDUAL HOLDOUT RESULTS");
  console.log("=".repeat(100));
  const years = holdoutBars / 365.25;
  for (const b of botRuns) {
    const m = computeMetrics(b.returns, years, START_CAPITAL, b.final, b.dd);
    console.log(`  ${b.label.padEnd(20)}  final $${b.final.toFixed(0).padStart(5)}  CAGR ${(m.cagr*100).toFixed(1).padStart(6)}%  DD ${(b.dd*100).toFixed(1).padStart(5)}%  Calmar ${m.calmar.toFixed(2).padStart(6)}  Sortino ${m.sortino.toFixed(2).padStart(6)}  trades ${b.nTrades.toString().padStart(3)}`);
  }

  // Portfolio: equal-weight combined daily returns
  const nBots = botRuns.length;
  const nDays = botRuns[0].returns.length;
  const portReturns: number[] = new Array(nDays).fill(0);
  for (let i = 0; i < nDays; i++) {
    let sum = 0;
    for (const b of botRuns) sum += b.returns[i] ?? 0;
    portReturns[i] = sum / nBots;
  }
  // Reconstruct portfolio equity (start $1000, compound daily returns)
  let portEquity = START_CAPITAL;
  let portPeak = START_CAPITAL, portMaxDD = 0;
  for (const r of portReturns) {
    portEquity *= (1 + r);
    if (portEquity > portPeak) portPeak = portEquity;
    const dd = (portPeak - portEquity) / portPeak;
    if (dd > portMaxDD) portMaxDD = dd;
  }
  const portMetrics = computeMetrics(portReturns, years, START_CAPITAL, portEquity, portMaxDD);

  // Excess-Sortino vs BH on portfolio
  const excessReturns = portReturns.map((r, i) => r - (bhReturns[i] ?? 0));
  const eMean = excessReturns.length > 0 ? excessReturns.reduce((a, b) => a + b, 0) / excessReturns.length : 0;
  const eDown = excessReturns.filter((r) => r < 0);
  const eDMean = eDown.length > 0 ? eDown.reduce((a, b) => a + b, 0) / eDown.length : 0;
  const eDStd = eDown.length > 1 ? Math.sqrt(eDown.reduce((a, b) => a + (b - eDMean) ** 2, 0) / (eDown.length - 1)) : 0.0001;
  const excessSortino = eDStd > 0 ? eMean / eDStd * Math.sqrt(365) : 0;

  console.log("\n" + "=".repeat(100));
  console.log("PORTFOLIO (equal-weighted, " + nBots + " bots)");
  console.log("=".repeat(100));
  console.log(`Final: $${portEquity.toFixed(2)} (${((portEquity / START_CAPITAL - 1) * 100).toFixed(2)}%)   CAGR: ${(portMetrics.cagr * 100).toFixed(2)}%   DD: ${(portMaxDD * 100).toFixed(2)}%`);
  console.log(`Calmar: ${portMetrics.calmar.toFixed(3)}   Sortino: ${portMetrics.sortino.toFixed(3)}   Excess-Sortino vs BH: ${excessSortino.toFixed(3)}`);
  console.log(`vs Buy-hold: portfolio ${portEquity > bhFinal ? "wins" : "loses"} by $${Math.abs(portEquity - bhFinal).toFixed(2)}`);

  // Correlation matrix (sample: report mean and max)
  const corrs: number[] = [];
  for (let i = 0; i < nBots; i++) {
    for (let j = i + 1; j < nBots; j++) {
      corrs.push(pearsonCorr(botRuns[i].returns, botRuns[j].returns));
    }
  }
  const meanCorr = corrs.length > 0 ? corrs.reduce((a, b) => a + b, 0) / corrs.length : 0;
  const maxCorr = corrs.length > 0 ? Math.max(...corrs) : 0;
  const minCorr = corrs.length > 0 ? Math.min(...corrs) : 0;
  console.log(`\nBot pairwise correlations: mean ${meanCorr.toFixed(3)}  min ${minCorr.toFixed(3)}  max ${maxCorr.toFixed(3)}`);
  console.log(`(Lower mean = more diversification benefit. 0 = independent bots. 1 = same bot.)`);

  // Per-regime portfolio breakdown
  const closes = bars.map((b) => b.close);
  const buckets: Record<string, { d: number; sum: number }> = { bull: { d: 0, sum: 0 }, chop: { d: 0, sum: 0 }, bear: { d: 0, sum: 0 } };
  for (let i = 0; i < portReturns.length; i++) {
    const idx = holdoutStart + 1 + i;
    if (idx < 60) continue;
    const b60 = (closes[idx] - closes[idx - 60]) / closes[idx - 60];
    const k = b60 > 0.05 ? "bull" : b60 < -0.05 ? "bear" : "chop";
    buckets[k].d++;
    buckets[k].sum += portReturns[i];
  }
  console.log("\nPortfolio per-regime:");
  const posReg: string[] = [];
  for (const k of ["bull", "chop", "bear"]) {
    const b = buckets[k];
    if (b.d === 0) { console.log(`  ${k.padEnd(4)}: 0 days`); continue; }
    console.log(`  ${k.padEnd(4)}: ${b.d.toString().padStart(3)}d | total ret ${(b.sum * 100).toFixed(2)}%`);
    if (b.sum > 0) posReg.push(k);
  }

  // Ship-gate against portfolio
  const roundTrips = Math.floor(botRuns.reduce((a, b) => a + b.nTrades, 0) / nBots / 2);
  const perTrip = roundTrips > 0 ? (portEquity - START_CAPITAL) / roundTrips : 0;
  const edgeBps = roundTrips > 0 ? (perTrip / 5000) * 10000 : 0;

  console.log("\n" + "=".repeat(100));
  console.log("PORTFOLIO SHIP GATE REPORT");
  console.log("=".repeat(100));
  const gates = [
    { name: `1. Calmar >= ${SHIP_GATE.minCalmar}`, ok: portMetrics.calmar >= SHIP_GATE.minCalmar, val: portMetrics.calmar.toFixed(3) },
    { name: `2. MaxDD < ${SHIP_GATE.maxDD*100}%`, ok: portMaxDD < SHIP_GATE.maxDD, val: `${(portMaxDD*100).toFixed(1)}%` },
    { name: `3. CAGR >= 0`, ok: portMetrics.cagr >= SHIP_GATE.minCAGR, val: `${(portMetrics.cagr*100).toFixed(1)}%` },
    { name: `4. Edge >= ${SHIP_GATE.minEdgeBps} bps/RT`, ok: edgeBps >= SHIP_GATE.minEdgeBps, val: `${edgeBps.toFixed(0)} bps (avg ${roundTrips} RTs)` },
    { name: `5. Excess-Sortino vs BH > 0`, ok: excessSortino > 0, val: excessSortino.toFixed(3) },
    { name: `6. Positive in >= ${SHIP_GATE.minRegimes}/3 regimes`, ok: posReg.length >= SHIP_GATE.minRegimes, val: `${posReg.length}/3 (${posReg.join("+")})` },
  ];
  for (const g of gates) console.log(`  ${g.ok ? "OK " : "FAIL"} ${g.name.padEnd(40)} -> ${g.val}`);
  const allPass = gates.every((g) => g.ok);
  console.log(`\nOVERALL: ${allPass ? "PORTFOLIO SHIPS on holdout" : "PORTFOLIO FAILS holdout — architecture exhausted"}`);

  await fs.writeFile(path.join(RESULTS_DIR, `portfolio-holdout.json`), JSON.stringify({
    topN, n_bots: nBots,
    holdout_dates: { start: bars[holdoutStart].date, end: bars[holdoutEnd].date },
    buy_hold_final: bhFinal,
    portfolio: { final: portEquity, cagr: portMetrics.cagr, dd: portMaxDD, calmar: portMetrics.calmar, sortino: portMetrics.sortino, excess_sortino: excessSortino, daily_returns: portReturns },
    individual: botRuns.map((b, i) => ({ label: b.label, val_calmar: shortlist[i].val_calmar, final: b.final, dd: b.dd, n_trades: b.nTrades })),
    correlations: { mean: meanCorr, min: minCorr, max: maxCorr },
    ship_gate: { gates, all_passed: allPass },
  }, null, 2));
  console.log(`\nWrote results/portfolio-holdout.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
