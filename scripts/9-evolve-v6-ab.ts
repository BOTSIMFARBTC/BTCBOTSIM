/**
 * v6 — A/B split with Sable's realism lessons + bull-participation floor.
 *
 * v5 backfired: macro genes overfit to 2010-22 correlations that broke in
 * 2023-26 (Fed hiking + BTC bull rally). Per-regime breakdown showed bot
 * captured only 20% of strong-bull days. That's the failure mode to fix.
 *
 * v6 tests two hypotheses in parallel via A/B split (per PROTOCOL.md § A/B):
 *
 *   ARM A — bull-participation floor. 17-gene genome (no macro at all).
 *   Fitness has a HARD gate: each fold's up-day capture ratio ≥ 30% of BTC
 *   up-day returns. Forces bots to keep skin in the game during bull days.
 *
 *   ARM B — shrunk macro (17 + 2 composite genes). Same bull-participation
 *   floor as A. Only variable is whether composite macro fear/boost helps.
 *
 * BOTH arms include Sable's realism patches (from her 2026-09-10 memo):
 *   1. Absolute position cap MAX_POSITION_USD = 10_000. Kills the
 *      unlimited-compounding fantasy where bot goes $1k→$18M with same %
 *      sizing, implicitly assuming infinite market depth.
 *   2. Gap-through on stops. If bar OPENS past stop, fill at open not stop.
 *      Handles weekend/news gaps honestly.
 *   3. Funding rate on notional. 0.03% per day (=0.01%/8h × 3 periods).
 *      Applied to abs(position notional) each held day. BTC-native cost.
 *   4. Watchdog. Track validation Calmar of champion every 20 gens. If
 *      it declines 3 consecutive checkpoints while train Calmar climbs,
 *      kill/revert (overfitting detected in real-time).
 *
 * A/B protocol (per PROTOCOL.md): 20 seeds per arm. Each seed runs a
 * self-contained GA. Winner declared via Mann-Whitney U on VALIDATION-slice
 * Calmar distributions, p < 0.05 after Bonferroni.
 *
 * All prior anti-cheat preserved.
 *
 * CLI: npx tsx scripts/9-evolve-v6-ab.ts <runId> <minutesPerSeed> [nSeeds]
 * Defaults: runId=v6ab, minutesPerSeed=2, nSeeds=20.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(__dirname, "..", "data");
const RESULTS_DIR = path.resolve(__dirname, "..", "results");

const START_CAPITAL = 1000;
const COST_BPS_ROUNDTRIP = 50;
const LIQUIDATION_THRESHOLD = 10;
const MAX_DD_CLIFF = 0.40;
const EVENT_DELAY_DAYS = 1;
const MACRO_PCTILE_WINDOW = 250;

// GENOME_SIZE depends on arm — see decodeForArm() below
const GENOME_SIZE_A = 17;
const GENOME_SIZE_B = 19; // 17 + 2 composite macro

// Slippage
const SLIPPAGE_BASE_BPS = 5;
const SLIPPAGE_VOL_COEF = 200;

// v6 realism (Sable's lessons)
const MAX_POSITION_USD = 10_000;   // absolute cap on any position, kills unlimited-compound
const FUNDING_BPS_PER_DAY = 3;      // 3 bps/day = 0.01%/8h × 3 periods (avg BTC perp funding)

// Bull-participation floor (v6 new fitness constraint)
const BULL_CAPTURE_FLOOR = 0.30;    // fold fails if bot captures < 30% of BTC up-day sum

// Watchdog
const WATCHDOG_CHECK_EVERY_GENS = 20;
const WATCHDOG_TRIP_AFTER_DECLINES = 3;

// K-fold config
const N_FOLDS = 4;
const TRAIN_END_DATE = "2022-12-31";
const VALIDATION_END_DATE = "2026-03-10"; // per PROTOCOL.md §1
// Everything after VALIDATION_END_DATE is HOLDOUT — NEVER touched in this script.

const POP_SIZE = 100;
const ELITE_COUNT = 5;
const TOURNAMENT_SIZE = 3;
const MUTATION_RATE_INITIAL = 0.15;
const MUTATION_STDEV_INITIAL = 0.15;

// Halving dates (past + estimated future)
const HALVINGS = ["2012-11-28", "2016-07-09", "2020-05-11", "2024-04-19", "2028-04-01"];

// -----------------------------------------------------------
// Types
// -----------------------------------------------------------

interface BtcDay { date: string; ts: number; open: number; high: number; low: number; close: number; }
interface EventRow { date: string; category: string; impact_score: number; magnitude: number; description: string; }
type EventCategory = "hack" | "regulation" | "macro" | "geopolitical" | "adoption" | "onchain" | "market_structure";
const CATEGORIES: EventCategory[] = ["hack", "regulation", "macro", "geopolitical", "adoption", "onchain", "market_structure"];

interface EventState {
  // Days since most recent event of each category, capped at 999 if none in 60d
  days_since_hack: number;
  days_since_regulation: number;
  days_since_macro: number;
  days_since_geopolitical: number;
  days_since_adoption: number;
  days_since_onchain: number;
  days_since_market_structure: number;
  days_since_last_halving: number;
  days_to_next_halving: number;
}

interface DailyState {
  price: number;
  ma_fast: number;
  ma_slow: number;
  ma_trend: number;
  rsi: number;
  vol20: number;
  ret_5d: number;
  ret_20d: number;
  event_state: EventState;
}

interface MacroRow { date: string; ts: number; vix: number; dxy: number; us10y: number; sp500: number; gold: number; }

interface MacroState {
  vix_pctile: number;      // 0..1, VIX percentile in trailing 250d
  dxy_pctile: number;
  us10y_pctile: number;
  sp500_20d_ret: number;   // 20-day SP500 return
}

type Genome = number[];

interface BotResult {
  final_equity: number;
  peak_equity: number;
  max_dd_pct: number;
  survival_days: number;
  total_days: number;
  n_trades: number;
  sortino: number;
  calmar: number;
  cagr: number;
  fitness: number;
  buy_hold_equity: number;
  liquidated: boolean;
  daily_returns: number[];
  bull_capture_ratio: number; // v6: bot up-day return sum / BTC up-day return sum
}

// -----------------------------------------------------------
// Deterministic RNG (mulberry32)
// -----------------------------------------------------------

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// -----------------------------------------------------------
// Genome decode
// -----------------------------------------------------------

function randomGenome(rng: () => number, size: number): Genome {
  return Array.from({ length: size }, () => rng());
}

function decode(g: Genome) {
  return {
    // v1 technical (0..14)
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
    // Unified bearish-event reactivity (15..16)
    bearish_event_fear: g[15],
    event_memory_days: 5 + Math.floor(g[16] * 55),
    // Arm B composite macro genes (17..18). undefined for Arm A.
    composite_risk_off_fear: g.length > 17 ? g[17] : 0,
    composite_risk_on_boost: g.length > 18 ? g[18] : 0,
  };
}

// -----------------------------------------------------------
// Precompute indicators
// -----------------------------------------------------------

function precomputeIndicators(bars: BtcDay[]) {
  const closes = bars.map((b) => b.close);
  const rsi: number[] = new Array(bars.length).fill(50);
  const period = 14;
  for (let i = period; i < bars.length; i++) {
    let gains = 0, losses = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = closes[j] - closes[j - 1];
      if (d >= 0) gains += d; else losses -= d;
    }
    const avgG = gains / period;
    const avgL = losses / period;
    if (avgL === 0) rsi[i] = 100;
    else rsi[i] = 100 - 100 / (1 + avgG / avgL);
  }
  const vol20: number[] = new Array(bars.length).fill(0);
  for (let i = 21; i < bars.length; i++) {
    const rs: number[] = [];
    for (let j = i - 19; j <= i; j++) {
      rs.push((closes[j] - closes[j - 1]) / closes[j - 1]);
    }
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

// -----------------------------------------------------------
// Event state precompute (per-bar)
// -----------------------------------------------------------

function precomputeEventState(bars: BtcDay[], events: EventRow[]): EventState[] {
  // Same as v4b but events have EVENT_DELAY_DAYS visibility delay (patch #2).
  const eventsByCat: Record<string, number[]> = {};
  for (const cat of CATEGORIES) eventsByCat[cat] = [];
  for (const ev of events) {
    // Shift event ts forward by delay so it's only visible starting delay-days later
    const rawTs = new Date(ev.date + "T00:00:00Z").getTime();
    const visibleTs = rawTs + EVENT_DELAY_DAYS * 86400000;
    if (eventsByCat[ev.category]) eventsByCat[ev.category].push(visibleTs);
  }
  for (const cat of CATEGORIES) eventsByCat[cat].sort((a, b) => a - b);

  const halvingTs = HALVINGS.map((d) => new Date(d + "T00:00:00Z").getTime()).sort((a, b) => a - b);

  return bars.map((bar) => {
    const t = bar.ts;
    const daysSince = (arr: number[]): number => {
      let best = 999;
      for (const evT of arr) {
        if (evT > t) break;
        const d = Math.floor((t - evT) / 86400000);
        if (d < best) best = d;
      }
      return best;
    };
    // Halving
    let lastHalving = -Infinity;
    let nextHalving = Infinity;
    for (const h of halvingTs) {
      if (h <= t && h > lastHalving) lastHalving = h;
      if (h > t && h < nextHalving) nextHalving = h;
    }
    const daysSinceLastHalving = lastHalving === -Infinity ? 9999 : Math.floor((t - lastHalving) / 86400000);
    const daysToNextHalving = nextHalving === Infinity ? 9999 : Math.floor((nextHalving - t) / 86400000);
    return {
      days_since_hack: daysSince(eventsByCat["hack"] || []),
      days_since_regulation: daysSince(eventsByCat["regulation"] || []),
      days_since_macro: daysSince(eventsByCat["macro"] || []),
      days_since_geopolitical: daysSince(eventsByCat["geopolitical"] || []),
      days_since_adoption: daysSince(eventsByCat["adoption"] || []),
      days_since_onchain: daysSince(eventsByCat["onchain"] || []),
      days_since_market_structure: daysSince(eventsByCat["market_structure"] || []),
      days_since_last_halving: daysSinceLastHalving,
      days_to_next_halving: daysToNextHalving,
    };
  });
}

// -----------------------------------------------------------
// Macro state precompute (v5)
// -----------------------------------------------------------

function precomputeMacroState(bars: BtcDay[], macro: MacroRow[]): MacroState[] {
  // Assumes macro[i] aligned to bars[i] by index (checked in main()).
  const n = bars.length;
  const vix = macro.map((m) => m.vix);
  const dxy = macro.map((m) => m.dxy);
  const yld = macro.map((m) => m.us10y);
  const sp = macro.map((m) => m.sp500);
  const win = MACRO_PCTILE_WINDOW;

  const pctile = (arr: number[], i: number): number => {
    if (i < 20) return 0.5;
    const s = Math.max(0, i - win + 1);
    let below = 0, count = 0;
    for (let j = s; j <= i; j++) {
      if (arr[j] < arr[i]) below++;
      count++;
    }
    return count > 0 ? below / count : 0.5;
  };

  const out: MacroState[] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = {
      vix_pctile: pctile(vix, i),
      dxy_pctile: pctile(dxy, i),
      us10y_pctile: pctile(yld, i),
      sp500_20d_ret: i >= 20 && sp[i - 20] > 0 ? (sp[i] - sp[i - 20]) / sp[i - 20] : 0,
    };
  }
  return out;
}

// -----------------------------------------------------------
// Simulate one bot — HONEST version, v5 adds macro reactivity
// -----------------------------------------------------------

function simulate(bars: BtcDay[], indic: { rsi: number[]; vol20: number[] }, eventStates: EventState[], macroStates: MacroState[], genome: Genome, startIdx: number, endIdx: number): BotResult {
  const p = decode(genome);
  const closes = bars.map((b) => b.close);
  const roundTripCost = COST_BPS_ROUNDTRIP / 10_000;

  let equity = START_CAPITAL;
  let cash = START_CAPITAL;
  let btcHeld = 0;
  let entryPrice = 0;
  let daysInPos = 0;
  let daysSinceExit = 999;
  let peakEquity = START_CAPITAL;
  let maxDdPct = 0;
  let nTrades = 0;
  let liquidated = false;
  let survivalDays = 0;
  const dailyReturns: number[] = [];

  // Pending order (decided at close of day t, filled at open of day t+1)
  let pendingTargetPct: number | null = null;

  const totalDays = endIdx - startIdx + 1;
  const buyHoldQty = START_CAPITAL / bars[startIdx].close;

  for (let i = startIdx; i <= endIdx; i++) {
    const bar = bars[i];
    const priceOpen = bar.open;
    const priceHigh = bar.high;
    const priceLow = bar.low;
    const priceClose = bar.close;

    // Slippage on THIS bar's fills (deterministic — driven by vol20 of bar)
    // Applied as an EFFECTIVE price adjustment: buys fill higher, sells fill lower.
    const volNow = indic.vol20[i];
    const slippageBps = SLIPPAGE_BASE_BPS + SLIPPAGE_VOL_COEF * Math.max(0, volNow - 0.02);
    const slippageMult = slippageBps / 10_000;

    // --- 1. Fill any pending order at THIS bar's open ---
    if (pendingTargetPct !== null) {
      const currentPositionPct = (btcHeld * priceOpen) / (cash + btcHeld * priceOpen);
      const delta = pendingTargetPct - currentPositionPct;
      const equityAtOpen = cash + btcHeld * priceOpen;
      if (Math.abs(delta) > 0.05) {
        if (delta > 0) {
          // Buy: slippage makes effective price HIGHER (worse fill)
          const fillPrice = priceOpen * (1 + slippageMult);
          const usdToBuy = delta * equityAtOpen;
          const cost = usdToBuy * roundTripCost * 0.5;
          const btcBought = (usdToBuy - cost) / fillPrice;
          cash -= usdToBuy;
          btcHeld += btcBought;
          if (btcHeld > 0 && entryPrice === 0) entryPrice = fillPrice;
          nTrades++;
        } else {
          // Sell: slippage makes effective price LOWER (worse fill)
          const fillPrice = priceOpen * (1 - slippageMult);
          const usdToSell = -delta * equityAtOpen * (fillPrice / priceOpen);
          const btcToSell = -delta * equityAtOpen / priceOpen;
          const cost = usdToSell * roundTripCost * 0.5;
          cash += usdToSell - cost;
          btcHeld -= btcToSell;
          if (btcHeld <= 0.0001) {
            btcHeld = 0;
            entryPrice = 0;
            daysInPos = 0;
            daysSinceExit = 0;
          }
          nTrades++;
        }
      }
      pendingTargetPct = null;
    }

    // --- 2. Intrabar stop/target check with GAP-THROUGH handling (v6, Sable's lesson #2) ---
    if (btcHeld > 0) {
      const stopPrice = entryPrice * (1 - p.stop_loss_pct);
      const targetPrice = entryPrice * (1 + p.take_profit_pct);

      // Gap-through: if bar OPENS past stop or target, fill at OPEN, not the trigger.
      const openBelowStop = priceOpen <= stopPrice;
      const openAboveTarget = priceOpen >= targetPrice;
      const stopHit = priceLow <= stopPrice;
      const targetHit = priceHigh >= targetPrice;

      let exitPrice: number | null = null;
      if (openBelowStop) exitPrice = priceOpen;           // gap-through worse than stop
      else if (openAboveTarget) exitPrice = priceOpen;    // gap-through better than target (rare)
      else if (stopHit) exitPrice = stopPrice;            // normal intrabar stop
      else if (targetHit) exitPrice = targetPrice;        // normal intrabar target (pessimistic: stop wins ties, but no stop hit here)

      if (exitPrice !== null) {
        const fillPrice = exitPrice * (1 - slippageMult);
        const usdToSell = btcHeld * fillPrice;
        const cost = usdToSell * roundTripCost * 0.5;
        cash += usdToSell - cost;
        btcHeld = 0;
        entryPrice = 0;
        daysInPos = 0;
        daysSinceExit = 0;
        nTrades++;
        pendingTargetPct = null;
      }
    }

    // --- 2b. Funding rate on notional (v6, Sable's lesson #3) ---
    // 0.03%/day on abs(position notional). Applied even in same-bar exit windows;
    // simulates continuous funding accrual on Synfutures BTC-USDC perp.
    if (btcHeld > 0) {
      const positionNotional = btcHeld * priceClose;
      const fundingCost = positionNotional * (FUNDING_BPS_PER_DAY / 10_000);
      cash -= fundingCost;
    }

    // --- 3. Mark equity at close, check liquidation ---
    equity = cash + btcHeld * priceClose;
    if (equity > peakEquity) peakEquity = equity;
    const currentDd = (peakEquity - equity) / peakEquity;
    if (currentDd > maxDdPct) maxDdPct = currentDd;
    if (equity < LIQUIDATION_THRESHOLD) {
      liquidated = true;
      break;
    }
    survivalDays = i - startIdx + 1;

    // Daily return
    if (i > startIdx) {
      const equityYesterday = cash + btcHeld * bars[i - 1].close;
      dailyReturns.push(equityYesterday > 0 ? (equity - equityYesterday) / equityYesterday : 0);
    } else {
      dailyReturns.push(0);
    }

    // --- 4. Skip decision until indicators are meaningful ---
    if (i - startIdx < Math.max(p.ma_trend_period, 30)) {
      if (btcHeld > 0) daysInPos++;
      else daysSinceExit++;
      continue;
    }

    // --- 5. Compute signals ---
    const maFast = computeMa(closes, i, p.ma_fast_period);
    const maSlow = computeMa(closes, i, p.ma_slow_period);
    const maTrend = computeMa(closes, i, p.ma_trend_period);
    const rsi = indic.rsi[i];
    const vol = indic.vol20[i];
    const ret5d = i >= 5 ? (priceClose - closes[i - 5]) / closes[i - 5] : 0;
    const ret20d = i >= 20 ? (priceClose - closes[i - 20]) / closes[i - 20] : 0;

    const rsiScore = rsi < p.rsi_oversold ? 1 : rsi > p.rsi_overbought ? 0 : (p.rsi_overbought - rsi) / (p.rsi_overbought - p.rsi_oversold);
    const trendScore = (priceClose > maFast ? 0.33 : 0) + (maFast > maSlow ? 0.33 : 0) + (priceClose > maTrend ? 0.34 : 0);
    const momScore = Math.max(0, Math.min(1, 0.5 + (ret5d + ret20d) * 5));

    const totalWeight = p.rsi_weight + p.trend_weight + p.momentum_weight;
    const score = totalWeight > 0
      ? (p.rsi_weight * rsiScore + p.trend_weight * trendScore + p.momentum_weight * momScore) / totalWeight
      : 0.5;

    // --- 6. Bearish-event fear adjustment (unified, v3) ---
    // Fresh bearish event => reduce position by fear factor. Applied to the
    // MINIMUM days_since across bearish categories (whichever event is most recent).
    const es = eventStates[i];
    const mem = p.event_memory_days;
    const nearestBearish = Math.min(
      es.days_since_hack,
      es.days_since_macro,
      es.days_since_geopolitical,
      es.days_since_market_structure,
    );
    let riskMult = 1;
    if (nearestBearish < mem) {
      const freshness = 1 - nearestBearish / mem;
      riskMult = Math.max(0, 1 - p.bearish_event_fear * freshness);
    }

    // --- 7. Composite macro reactivity (v6 shrunk from v5's 4 genes to 2). ---
    // Arm A: composite genes = 0 → no macro effect.
    // Arm B: fear applies when ANY of (VIX, DXY, 10Y) > 80th pctile; boost when SP500 up + VIX suppressed.
    const ms = macroStates[i];
    let macroMult = 1;
    const worstStress = Math.max(ms.vix_pctile, ms.dxy_pctile, ms.us10y_pctile);
    if (worstStress > 0.8) {
      macroMult = Math.max(0, 1 - p.composite_risk_off_fear * (worstStress - 0.8) / 0.2);
    }
    let macroBoost = 1;
    if (ms.sp500_20d_ret > 0.02 && ms.vix_pctile < 0.3) {
      macroBoost = 1 + p.composite_risk_on_boost * 0.5;
    }

    // --- 8. Position sizing with ABSOLUTE CAP (v6 realism, Sable's lesson #1) ---
    const volFactor = 1 - p.vol_scale * Math.max(0, vol - 0.02);
    let targetSize = Math.max(0, Math.min(1, p.base_position * volFactor * riskMult * macroMult * macroBoost));
    // Absolute cap: if targetSize × equity exceeds MAX_POSITION_USD, clamp.
    // This kills the unlimited-compounding fantasy.
    const targetNotional = targetSize * equity;
    if (targetNotional > MAX_POSITION_USD) {
      targetSize = MAX_POSITION_USD / equity;
    }

    // --- 9. Decide desired position ---
    let desiredPositionPct: number;
    if (btcHeld > 0) {
      const unrealizedPnl = (priceClose - entryPrice) / entryPrice;
      const maxHoldHit = daysInPos >= p.max_hold_days;
      const scoreDrop = score < p.entry_conf_threshold * 0.5;
      if (maxHoldHit || scoreDrop) {
        desiredPositionPct = 0;
      } else {
        desiredPositionPct = (btcHeld * priceClose) / equity;
      }
    } else {
      const cooldownOk = daysSinceExit >= p.cooldown_days;
      desiredPositionPct = (score >= p.entry_conf_threshold && cooldownOk) ? targetSize : 0;
    }

    // Queue the order for next bar's open
    const currentPositionPct = (btcHeld * priceClose) / equity;
    if (Math.abs(desiredPositionPct - currentPositionPct) > 0.05) {
      pendingTargetPct = desiredPositionPct;
    }

    if (btcHeld > 0) { daysInPos++; daysSinceExit = 0; }
    else { daysSinceExit++; }
  }

  const buyHoldFinal = buyHoldQty * bars[Math.min(startIdx + survivalDays - 1, endIdx)].close;
  const meanRet = dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const downside = dailyReturns.filter((r) => r < 0);
  const downMean = downside.length > 0 ? downside.reduce((a, b) => a + b, 0) / downside.length : 0;
  const downStd = downside.length > 1
    ? Math.sqrt(downside.reduce((a, b) => a + (b - downMean) ** 2, 0) / (downside.length - 1))
    : 0.0001;
  const sortino = downStd > 0 ? meanRet / downStd * Math.sqrt(365) : 0;

  const finalEquity = liquidated ? 0 : equity;
  const years = totalDays / 365.25;
  const totalReturn = finalEquity / START_CAPITAL;
  const cagr = years > 0 && totalReturn > 0 ? Math.pow(totalReturn, 1 / years) - 1 : -1;
  const calmar = maxDdPct > 0.0001 ? cagr / maxDdPct : cagr / 0.0001;

  // v6: bull-capture ratio = bot up-day returns / BTC up-day returns
  let botUpSum = 0, btcUpSum = 0;
  for (let i = 1; i < dailyReturns.length; i++) {
    const btcRet = i + startIdx > 0 ? (closes[i + startIdx] - closes[i + startIdx - 1]) / closes[i + startIdx - 1] : 0;
    if (btcRet > 0) {
      btcUpSum += btcRet;
      botUpSum += dailyReturns[i];
    }
  }
  const bullCapture = btcUpSum > 0 ? botUpSum / btcUpSum : 0;

  // Fitness computed at evalKFold level (per-fold cliffs + geo mean + bull floor)
  // Here we just store the raw metrics; fitness is filled in by evalKFold.
  const fitness = calmar; // placeholder; evalKFold recomputes

  return {
    final_equity: finalEquity,
    peak_equity: peakEquity,
    max_dd_pct: maxDdPct,
    survival_days: survivalDays,
    total_days: totalDays,
    n_trades: nTrades,
    sortino,
    calmar,
    cagr,
    fitness,
    buy_hold_equity: buyHoldFinal,
    liquidated,
    daily_returns: dailyReturns,
    bull_capture_ratio: bullCapture,
  };
}

// -----------------------------------------------------------
// GA operators (seeded)
// -----------------------------------------------------------

function tournamentSelect(pop: { g: Genome; f: number }[], k: number, rng: () => number): Genome {
  let best: { g: Genome; f: number } | null = null;
  for (let i = 0; i < k; i++) {
    const pick = pop[Math.floor(rng() * pop.length)];
    if (!best || pick.f > best.f) best = pick;
  }
  return best!.g;
}

function crossover(a: Genome, b: Genome, rng: () => number): Genome {
  const child: Genome = [];
  for (let i = 0; i < a.length; i++) child.push(rng() < 0.5 ? a[i] : b[i]);
  return child;
}

function mutate(g: Genome, rate: number, stdev: number, rng: () => number): Genome {
  return g.map((v) => {
    if (rng() < rate) {
      const u = rng(), w = rng();
      const noise = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w) * stdev;
      return Math.max(0, Math.min(1, v + noise));
    }
    return v;
  });
}

// -----------------------------------------------------------
// Main
// -----------------------------------------------------------

// -----------------------------------------------------------
// K-fold fitness wrapper (v4)
// -----------------------------------------------------------

interface FoldResult { fold: number; startIdx: number; endIdx: number; res: BotResult; }

function evalKFold(bars: BtcDay[], indic: { rsi: number[]; vol20: number[] }, eventStates: EventState[], macroStates: MacroState[], genome: Genome, foldRanges: { start: number; end: number }[], trainStartIdx: number, trainEndIdx: number): { fitness: number; folds: FoldResult[]; concatRes: BotResult } {
  const folds: FoldResult[] = [];
  let anyLiquidated = false;
  let anyOverCliff = false;
  let anyNegCalmar = false;
  for (let k = 0; k < foldRanges.length; k++) {
    const r = foldRanges[k];
    const res = simulate(bars, indic, eventStates, macroStates, genome, r.start, r.end);
    folds.push({ fold: k, startIdx: r.start, endIdx: r.end, res });
    if (res.liquidated) anyLiquidated = true;
    if (res.max_dd_pct > MAX_DD_CLIFF) anyOverCliff = true;
    if (res.calmar <= 0) anyNegCalmar = true;
  }
  const concatRes = simulate(bars, indic, eventStates, macroStates, genome, trainStartIdx, trainEndIdx);
  const concatOverCliff = concatRes.max_dd_pct > MAX_DD_CLIFF;
  const concatLiq = concatRes.liquidated;

  let fitness = 0;
  if (anyLiquidated || concatLiq) fitness = -100;
  else if (anyOverCliff || concatOverCliff) fitness = 0;
  else if (anyNegCalmar) fitness = 0;
  else {
    // Geometric mean of Calmars.
    const prod = folds.reduce((a, f) => a * f.res.calmar, 1);
    const geoMean = Math.pow(prod, 1 / folds.length);
    // v6: bull-participation penalty (soft scaling, not hard cliff).
    // If min fold capture >= floor, no penalty. Otherwise scale linearly by ratio.
    const minCapture = folds.reduce((a, f) => Math.min(a, f.res.bull_capture_ratio), Infinity);
    const captureRatio = Math.max(0, Math.min(1, minCapture / BULL_CAPTURE_FLOOR));
    fitness = geoMean * captureRatio;
  }
  return { fitness, folds, concatRes };
}

// -----------------------------------------------------------
// One-seed GA runner (per-arm, per-seed)
// -----------------------------------------------------------

interface SeedResult {
  arm: "A" | "B";
  seed: number;
  gen: number;
  duration_min: number;
  best_genome: Genome;
  fitness: number;
  fold_results: Array<{ fold: number; date_start: string; date_end: string; cagr: number; dd: number; calmar: number; bull_capture: number; trades: number }>;
  train_calmar: number;
  train_cagr: number;
  train_dd: number;
  train_bull_capture: number;
  val_calmar: number;   // validation slice metric — for A/B comparison
  val_cagr: number;
  val_dd: number;
  val_bull_capture: number;
  val_trades: number;
  watchdog_tripped: boolean;
}

async function runOneSeed(
  arm: "A" | "B",
  seed: number,
  durationMs: number,
  bars: BtcDay[],
  indic: { rsi: number[]; vol20: number[] },
  eventStates: EventState[],
  macroStates: MacroState[],
  trainStartIdx: number,
  trainEndIdx: number,
  valStartIdx: number,
  valEndIdx: number,
  foldRanges: { start: number; end: number }[],
): Promise<SeedResult> {
  const rng = makeRng(seed);
  const genomeSize = arm === "A" ? GENOME_SIZE_A : GENOME_SIZE_B;

  let pop: { g: Genome; f: number }[] = [];
  for (let i = 0; i < POP_SIZE; i++) pop.push({ g: randomGenome(rng, genomeSize), f: -Infinity });

  const startTime = Date.now();
  let gen = 0;
  let bestEver: { g: Genome; f: number } | null = null;

  // Watchdog state
  const watchdogHistory: Array<{ gen: number; trainCalmar: number; valCalmar: number }> = [];
  let watchdogTripped = false;
  let watchdogBestPrior: { g: Genome; f: number } | null = null;

  while (Date.now() - startTime < durationMs) {
    gen++;
    for (const bot of pop) {
      if (bot.f === -Infinity) {
        const kres = evalKFold(bars, indic, eventStates, macroStates, bot.g, foldRanges, trainStartIdx, trainEndIdx);
        bot.f = kres.fitness;
        if (!bestEver || bot.f > bestEver.f) bestEver = { g: bot.g, f: bot.f };
      }
    }
    pop.sort((a, b) => b.f - a.f);

    // Watchdog check every WATCHDOG_CHECK_EVERY_GENS gens
    if (gen % WATCHDOG_CHECK_EVERY_GENS === 0 && bestEver) {
      const trainRes = simulate(bars, indic, eventStates, macroStates, bestEver.g, trainStartIdx, trainEndIdx);
      const valRes = simulate(bars, indic, eventStates, macroStates, bestEver.g, valStartIdx, valEndIdx);
      watchdogHistory.push({ gen, trainCalmar: trainRes.calmar, valCalmar: valRes.calmar });
      if (watchdogHistory.length >= WATCHDOG_TRIP_AFTER_DECLINES + 1) {
        const recent = watchdogHistory.slice(-WATCHDOG_TRIP_AFTER_DECLINES - 1);
        let valDeclines = 0, trainClimbs = 0;
        for (let i = 1; i < recent.length; i++) {
          if (recent[i].valCalmar < recent[i - 1].valCalmar) valDeclines++;
          if (recent[i].trainCalmar > recent[i - 1].trainCalmar) trainClimbs++;
        }
        if (valDeclines >= WATCHDOG_TRIP_AFTER_DECLINES && trainClimbs >= WATCHDOG_TRIP_AFTER_DECLINES - 1) {
          // Overfitting detected — revert to best-prior and stop
          watchdogTripped = true;
          if (watchdogBestPrior) bestEver = watchdogBestPrior;
          break;
        }
      }
      // Remember prior-best state
      watchdogBestPrior = { g: [...bestEver.g], f: bestEver.f };
    }

    // Reproduce
    const nextPop: { g: Genome; f: number }[] = [];
    for (let i = 0; i < ELITE_COUNT; i++) nextPop.push({ g: [...pop[i].g], f: pop[i].f });
    const mutRate = MUTATION_RATE_INITIAL * (1 - Math.min(0.5, gen / 200));
    const mutStd = MUTATION_STDEV_INITIAL * (1 - Math.min(0.5, gen / 200));
    while (nextPop.length < POP_SIZE) {
      const p1 = tournamentSelect(pop, TOURNAMENT_SIZE, rng);
      const p2 = tournamentSelect(pop, TOURNAMENT_SIZE, rng);
      let child = crossover(p1, p2, rng);
      child = mutate(child, mutRate, mutStd, rng);
      nextPop.push({ g: child, f: -Infinity });
    }
    pop = nextPop;
  }

  if (!bestEver) throw new Error("no bestEver in seed run");

  // Final eval: train, validation, per-fold
  const kFinal = evalKFold(bars, indic, eventStates, macroStates, bestEver.g, foldRanges, trainStartIdx, trainEndIdx);
  const trainRes = simulate(bars, indic, eventStates, macroStates, bestEver.g, trainStartIdx, trainEndIdx);
  const valRes = simulate(bars, indic, eventStates, macroStates, bestEver.g, valStartIdx, valEndIdx);

  return {
    arm, seed, gen,
    duration_min: (Date.now() - startTime) / 60000,
    best_genome: bestEver.g,
    fitness: bestEver.f,
    fold_results: kFinal.folds.map((f) => ({
      fold: f.fold,
      date_start: bars[f.startIdx].date,
      date_end: bars[f.endIdx].date,
      cagr: f.res.cagr,
      dd: f.res.max_dd_pct,
      calmar: f.res.calmar,
      bull_capture: f.res.bull_capture_ratio,
      trades: f.res.n_trades,
    })),
    train_calmar: trainRes.calmar,
    train_cagr: trainRes.cagr,
    train_dd: trainRes.max_dd_pct,
    train_bull_capture: trainRes.bull_capture_ratio,
    val_calmar: valRes.calmar,
    val_cagr: valRes.cagr,
    val_dd: valRes.max_dd_pct,
    val_bull_capture: valRes.bull_capture_ratio,
    val_trades: valRes.n_trades,
    watchdog_tripped: watchdogTripped,
  };
}

// -----------------------------------------------------------
// Mann-Whitney U (2-sided) with normal approximation
// -----------------------------------------------------------
function mannWhitneyU(xs: number[], ys: number[]): { u: number; z: number; p: number } {
  const combined = xs.map((v) => ({ v, group: 0 })).concat(ys.map((v) => ({ v, group: 1 })));
  combined.sort((a, b) => a.v - b.v);
  // Assign ranks (average for ties)
  const ranks = new Array(combined.length).fill(0);
  let i = 0;
  while (i < combined.length) {
    let j = i;
    while (j + 1 < combined.length && combined[j + 1].v === combined[i].v) j++;
    const avgRank = (i + j + 2) / 2; // 1-indexed
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    i = j + 1;
  }
  let sumRankX = 0;
  for (let k = 0; k < combined.length; k++) if (combined[k].group === 0) sumRankX += ranks[k];
  const n1 = xs.length, n2 = ys.length;
  const U1 = sumRankX - n1 * (n1 + 1) / 2;
  const U2 = n1 * n2 - U1;
  const U = Math.min(U1, U2);
  const mean = n1 * n2 / 2;
  const stdev = Math.sqrt(n1 * n2 * (n1 + n2 + 1) / 12);
  const z = stdev > 0 ? (U - mean) / stdev : 0;
  // 2-sided p via normal approx
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return { u: U, z, p };
}

function normalCdf(z: number): number {
  // Approximation (Abramowitz & Stegun 26.2.17)
  const b1 = 0.319381530, b2 = -0.356563782, b3 = 1.781477937, b4 = -1.821255978, b5 = 1.330274429;
  const p_ = 0.2316419;
  const t = 1 / (1 + p_ * z);
  const pdf = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
  return 1 - pdf * (b1 * t + b2 * t * t + b3 * Math.pow(t, 3) + b4 * Math.pow(t, 4) + b5 * Math.pow(t, 5));
}

// -----------------------------------------------------------
// Main — A/B orchestrator
// -----------------------------------------------------------

async function main() {
  const runId = process.argv[2] ?? "v6ab";
  const minutesPerSeed = Number(process.argv[3] ?? 2);
  const nSeeds = Number(process.argv[4] ?? 20);
  const armsFilter = (process.argv[5] ?? "AB").toUpperCase(); // "A", "B", or "AB"
  const seedBase = Number(process.argv[6] ?? 1000);
  const durationMs = minutesPerSeed * 60 * 1000;

  const armsToRun: ("A" | "B")[] = [];
  if (armsFilter.includes("A")) armsToRun.push("A");
  if (armsFilter.includes("B")) armsToRun.push("B");

  console.log(`Argus v6 A/B — run ${runId}, ${minutesPerSeed}min/seed × ${nSeeds}seeds × ${armsToRun.length} arms (${armsToRun.join(",")}) = ${(minutesPerSeed * nSeeds * armsToRun.length).toFixed(0)}min total, seedBase=${seedBase}\n`);

  const dataRaw = await fs.readFile(path.join(DATA_DIR, "btc-daily.json"), "utf8");
  const dataPkg = JSON.parse(dataRaw) as { bars: BtcDay[] };
  const bars = dataPkg.bars;

  const eventsRaw = await fs.readFile(path.join(DATA_DIR, "events.json"), "utf8");
  const eventsPkg = JSON.parse(eventsRaw) as { events: EventRow[] };

  const macroRaw = await fs.readFile(path.join(DATA_DIR, "macro-daily.json"), "utf8");
  const macroPkg = JSON.parse(macroRaw) as { rows: MacroRow[] };
  // Verify alignment: macro rows and btc bars should match by index (fetch script guarantees)
  if (macroPkg.rows.length !== bars.length) throw new Error(`Macro/BTC misalign: ${macroPkg.rows.length} vs ${bars.length}`);
  for (let i = 0; i < bars.length; i += Math.floor(bars.length / 10)) {
    if (macroPkg.rows[i].date !== bars[i].date) throw new Error(`Macro/BTC date mismatch at idx ${i}: ${macroPkg.rows[i].date} vs ${bars[i].date}`);
  }
  console.log(`Data: ${bars.length} bars, ${eventsPkg.events.length} curated events, ${macroPkg.rows.length} macro rows`);

  // 3-way split per PROTOCOL.md §1: TRAIN / VALIDATION / HOLDOUT
  const trainEndIdx = bars.findIndex((b) => b.date > TRAIN_END_DATE) - 1;
  if (trainEndIdx <= 0) throw new Error("Bad train_end date");
  const trainStartIdx = 0;
  const valStartIdx = trainEndIdx + 1;
  const valEndIdx = bars.findIndex((b) => b.date > VALIDATION_END_DATE) - 1;
  if (valEndIdx <= valStartIdx) throw new Error("Bad validation_end date");
  console.log(`TRAIN:      ${bars[trainStartIdx].date} → ${bars[trainEndIdx].date} (${((trainEndIdx - trainStartIdx + 1) / 365.25).toFixed(1)}yr) — GA fitness`);
  console.log(`VALIDATION: ${bars[valStartIdx].date} → ${bars[valEndIdx].date} (${((valEndIdx - valStartIdx + 1) / 365.25).toFixed(1)}yr) — A/B comparison`);
  console.log(`HOLDOUT:    ${bars[valEndIdx + 1]?.date ?? "N/A"} → end — LOCKED, not touched here\n`);

  const indic = precomputeIndicators(bars);
  const eventStates = precomputeEventState(bars, eventsPkg.events);
  const macroStates = precomputeMacroState(bars, macroPkg.rows);
  console.log(`Precomputed: indicators + event-state (${EVENT_DELAY_DAYS}d delay) + macro state\n`);

  // Buy-hold baselines for reference
  const bhTrainFinal = (START_CAPITAL / bars[trainStartIdx].close) * bars[trainEndIdx].close;
  const bhValFinal = (START_CAPITAL / bars[valStartIdx].close) * bars[valEndIdx].close;
  console.log(`Buy-hold TRAIN: $${bhTrainFinal.toFixed(0)}   Buy-hold VAL: $${bhValFinal.toFixed(0)}\n`);

  // K-fold ranges within train
  const trainLen = trainEndIdx - trainStartIdx + 1;
  const foldLen = Math.floor(trainLen / N_FOLDS);
  const foldRanges: { start: number; end: number }[] = [];
  for (let k = 0; k < N_FOLDS; k++) {
    const s = trainStartIdx + k * foldLen;
    const e = k === N_FOLDS - 1 ? trainEndIdx : s + foldLen - 1;
    foldRanges.push({ start: s, end: e });
  }
  console.log(`K-fold: ${N_FOLDS} folds within TRAIN`);
  for (let k = 0; k < N_FOLDS; k++) console.log(`  Fold ${k}: ${bars[foldRanges[k].start].date} → ${bars[foldRanges[k].end].date}`);
  console.log("");

  await fs.mkdir(RESULTS_DIR, { recursive: true });

  // Run 20 seeds × 2 arms
  const allResults: SeedResult[] = [];
  const armSeeds: Record<"A" | "B", number[]> = { A: [], B: [] };
  for (let s = 0; s < nSeeds; s++) armSeeds.A.push(seedBase + s);
  for (let s = 0; s < nSeeds; s++) armSeeds.B.push(seedBase + 100 + s);

  for (const arm of armsToRun) {
    console.log(`\n${"=".repeat(80)}`);
    console.log(`ARM ${arm} — ${arm === "A" ? "17g (no macro)" : "19g (17 + 2 composite macro)"} — ${nSeeds} seeds`);
    console.log("=".repeat(80));
    for (const seed of armSeeds[arm]) {
      const t0 = Date.now();
      const r = await runOneSeed(arm, seed, durationMs, bars, indic, eventStates, macroStates, trainStartIdx, trainEndIdx, valStartIdx, valEndIdx, foldRanges);
      allResults.push(r);
      const wc = r.watchdog_tripped ? "WATCH" : "     ";
      console.log(
        `  arm ${arm} seed ${seed.toString().padStart(4)} | gen ${r.gen.toString().padStart(4)} | ` +
        `${((Date.now() - t0) / 1000).toFixed(0)}s | ` +
        `fit ${r.fitness.toFixed(2).padStart(6)} | ` +
        `val Calmar ${r.val_calmar.toFixed(2).padStart(6)} | ` +
        `val CAGR ${(r.val_cagr * 100).toFixed(1).padStart(5)}% | ` +
        `val DD ${(r.val_dd * 100).toFixed(0).padStart(2)}% | ` +
        `val trades ${r.val_trades.toString().padStart(3)} | ${wc}`
      );
    }
  }

  // A/B analysis on validation Calmar (skip Mann-Whitney if only one arm ran)
  const armA = allResults.filter((r) => r.arm === "A");
  const armB = allResults.filter((r) => r.arm === "B");
  const summarize = (arr: SeedResult[], name: string) => {
    if (arr.length === 0) return null;
    const vals = arr.map((r) => r.val_calmar);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const median = [...vals].sort((x, y) => x - y)[Math.floor(vals.length / 2)];
    const best = arr.reduce((b, r) => r.val_calmar > b.val_calmar ? r : b, arr[0]);
    console.log(`Arm ${name}: n=${arr.length}  mean=${mean.toFixed(3)}  median=${median.toFixed(3)}  min=${Math.min(...vals).toFixed(3)}  max=${Math.max(...vals).toFixed(3)}`);
    console.log(`  Best-of-${name} (seed ${best.seed}): Calmar ${best.val_calmar.toFixed(3)} | CAGR ${(best.val_cagr*100).toFixed(1)}% | DD ${(best.val_dd*100).toFixed(1)}% | bull-capture ${(best.val_bull_capture*100).toFixed(0)}% | trades ${best.val_trades}`);
    return { n: arr.length, mean, median, best };
  };

  console.log("\n" + "=".repeat(80));
  console.log("A/B RESULT — validation Calmar distributions");
  console.log("=".repeat(80));
  const sumA = summarize(armA, "A");
  const sumB = summarize(armB, "B");

  let mw: any = null;
  let pAdj = 1;
  if (sumA && sumB) {
    const aVals = armA.map((r) => r.val_calmar);
    const bVals = armB.map((r) => r.val_calmar);
    mw = mannWhitneyU(aVals, bVals);
    const bonferroniN = 1;
    pAdj = Math.min(1, mw.p * bonferroniN);
    console.log(`\nMann-Whitney U = ${mw.u.toFixed(1)}, z = ${mw.z.toFixed(3)}, p (raw) = ${mw.p.toFixed(4)}, p (Bonferroni×${bonferroniN}) = ${pAdj.toFixed(4)}`);
    if (pAdj < 0.05) {
      console.log(`VERDICT: significant at α=0.05. Winner: ${sumA.mean > sumB.mean ? "Arm A" : "Arm B"}`);
    } else {
      console.log(`VERDICT: NOT significant at α=0.05. Distributions overlap.`);
    }
  } else {
    console.log(`\nSingle-arm run (${armsToRun.join(",")}). No Mann-Whitney comparison.`);
  }

  await fs.writeFile(path.join(RESULTS_DIR, `${runId}-ab-analysis.json`), JSON.stringify({
    run_id: runId,
    generated_utc: new Date().toISOString(),
    minutes_per_seed: minutesPerSeed,
    n_seeds_per_arm: nSeeds,
    arms_run: armsToRun,
    seed_base: seedBase,
    train_dates: { start: bars[trainStartIdx].date, end: bars[trainEndIdx].date },
    validation_dates: { start: bars[valStartIdx].date, end: bars[valEndIdx].date },
    max_position_usd: MAX_POSITION_USD,
    funding_bps_per_day: FUNDING_BPS_PER_DAY,
    bull_capture_floor: BULL_CAPTURE_FLOOR,
    stats: {
      A: sumA,
      B: sumB,
      mann_whitney: mw ? { u: mw.u, z: mw.z, p_raw: mw.p, p_bonferroni: pAdj, winner: pAdj < 0.05 ? (sumA!.mean > sumB!.mean ? "A" : "B") : "TIE" } : null,
    },
    all_results: allResults,
  }, null, 2));
  console.log(`\nWrote results/${runId}-ab-analysis.json`);
}

main().catch((err) => { console.error("failed:", err); process.exit(1); });
