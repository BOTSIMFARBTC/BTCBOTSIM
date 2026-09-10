/**
 * v4b — fix v4's fitness aggregation bug.
 *
 * v4 used mean-Calmar across 4 folds. Fold 0 (2010-2017, BTC $0.07→$4700)
 * scored Calmar 597.22 which dominated the mean (149.89 total) and let the GA
 * ignore folds 1/3 that scored <1.0. Net: OOS test CAGR regressed to -2.4%.
 *
 * Fix: fitness = MIN Calmar across folds (worst fold sets the score). Forces
 * every era to be positive. Second guard: concatenated-train DD cliff catches
 * inter-fold DD compounding that per-fold cliffs miss.
 *
 * Everything else identical to v4: 17-gene genome, slippage 5+200*vol bps,
 * intrabar stops, next-bar-open fills, seed 42.
 *
 * CLI: npx tsx scripts/6-evolve-v4b.ts <runId> <minutes> [seed]
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(__dirname, "..", "data");
const RESULTS_DIR = path.resolve(__dirname, "..", "results");

const START_CAPITAL = 1000;
const COST_BPS_ROUNDTRIP = 50;
const LIQUIDATION_THRESHOLD = 10;
const GENOME_SIZE = 17;
const MAX_DD_CLIFF = 0.40; // DD above this => fitness = 0 (per-fold too)

// Slippage (v4 realism patch #1). Applied to every fill (entry + intrabar).
const SLIPPAGE_BASE_BPS = 5;
const SLIPPAGE_VOL_COEF = 200; // 200 * max(0, vol20 - 0.02) bps of extra slippage

// K-fold config
const N_FOLDS = 4;
const TRAIN_END_DATE = "2022-12-31";

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

type Genome = number[];

interface BotResult {
  final_equity: number;
  peak_equity: number;
  max_dd_pct: number;
  survival_days: number;
  total_days: number;
  n_trades: number;
  sortino: number;
  calmar: number; // CAGR / max_dd
  cagr: number;
  fitness: number;
  buy_hold_equity: number;
  liquidated: boolean;
  daily_returns: number[];
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

function randomGenome(rng: () => number): Genome {
  return Array.from({ length: GENOME_SIZE }, () => rng());
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
    // v3 unified event reactivity (15..16). Applied to ANY bearish-category event.
    // fear=0 ignores all events, fear=1 exits fully on any recent bearish event.
    bearish_event_fear: g[15],
    event_memory_days: 5 + Math.floor(g[16] * 55), // 5-60 days
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
  // For each bar, find days_since most recent event of each category (up to 999 if none in 999d)
  // and days to/from nearest halving.
  const eventsByCat: Record<string, number[]> = {};
  for (const cat of CATEGORIES) eventsByCat[cat] = [];
  for (const ev of events) {
    const ts = new Date(ev.date + "T00:00:00Z").getTime();
    if (eventsByCat[ev.category]) eventsByCat[ev.category].push(ts);
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
// Simulate one bot — HONEST version
// -----------------------------------------------------------

function simulate(bars: BtcDay[], indic: { rsi: number[]; vol20: number[] }, eventStates: EventState[], genome: Genome, startIdx: number, endIdx: number): BotResult {
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

    // --- 2. Intrabar stop/target check (only if holding) ---
    if (btcHeld > 0) {
      const stopPrice = entryPrice * (1 - p.stop_loss_pct);
      const targetPrice = entryPrice * (1 + p.take_profit_pct);
      const stopHit = priceLow <= stopPrice;
      const targetHit = priceHigh >= targetPrice;
      // Pessimistic: if both hit, assume stop first
      let exitPrice: number | null = null;
      if (stopHit) exitPrice = stopPrice;
      else if (targetHit) exitPrice = targetPrice;
      if (exitPrice !== null) {
        // Slippage on stop/target fills (typically worse — thin liquidity at extremes)
        const fillPrice = exitPrice * (1 - slippageMult);
        const usdToSell = btcHeld * fillPrice;
        const cost = usdToSell * roundTripCost * 0.5;
        cash += usdToSell - cost;
        btcHeld = 0;
        entryPrice = 0;
        daysInPos = 0;
        daysSinceExit = 0;
        nTrades++;
        pendingTargetPct = null; // cancel any queued adjust
      }
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

    // --- 7. Position sizing (halving boost removed in v3) ---
    const volFactor = 1 - p.vol_scale * Math.max(0, vol - 0.02);
    const targetSize = Math.max(0, Math.min(1, p.base_position * volFactor * riskMult));

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

  // Fitness: Calmar with hard DD cliff
  let fitness = 0;
  if (liquidated) fitness = -100;
  else if (maxDdPct > MAX_DD_CLIFF) fitness = 0; // hard cliff
  else fitness = calmar;

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
  for (let i = 0; i < GENOME_SIZE; i++) child.push(rng() < 0.5 ? a[i] : b[i]);
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

function evalKFold(bars: BtcDay[], indic: { rsi: number[]; vol20: number[] }, eventStates: EventState[], genome: Genome, foldRanges: { start: number; end: number }[], trainStartIdx: number, trainEndIdx: number): { fitness: number; folds: FoldResult[]; concatRes: BotResult } {
  const folds: FoldResult[] = [];
  let anyLiquidated = false;
  let anyOverCliff = false;
  for (let k = 0; k < foldRanges.length; k++) {
    const r = foldRanges[k];
    const res = simulate(bars, indic, eventStates, genome, r.start, r.end);
    folds.push({ fold: k, startIdx: r.start, endIdx: r.end, res });
    if (res.liquidated) anyLiquidated = true;
    if (res.max_dd_pct > MAX_DD_CLIFF) anyOverCliff = true;
  }
  // Also simulate concatenated train slice to catch inter-fold DD compounding
  const concatRes = simulate(bars, indic, eventStates, genome, trainStartIdx, trainEndIdx);
  const concatOverCliff = concatRes.max_dd_pct > MAX_DD_CLIFF;
  const concatLiq = concatRes.liquidated;

  let fitness = 0;
  if (anyLiquidated || concatLiq) fitness = -100;
  else if (anyOverCliff || concatOverCliff) fitness = 0;
  else {
    // v4b: MIN Calmar across folds (worst-fold gates fitness)
    // Any fold with negative Calmar collapses fitness to that negative number.
    const minCalmar = folds.reduce((a, f) => Math.min(a, f.res.calmar), Infinity);
    fitness = minCalmar;
  }
  return { fitness, folds, concatRes };
}

async function main() {
  const runId = process.argv[2] ?? "v4b";
  const durationMin = Number(process.argv[3] ?? 10);
  const seed = Number(process.argv[4] ?? 42);
  const durationMs = durationMin * 60 * 1000;
  const rng = makeRng(seed);

  console.log(`Argus v4b (min-Calmar K-fold + concat DD cliff + slippage) — run ${runId}, budget ${durationMin} min, seed ${seed}\n`);

  const dataRaw = await fs.readFile(path.join(DATA_DIR, "btc-daily.json"), "utf8");
  const dataPkg = JSON.parse(dataRaw) as { bars: BtcDay[] };
  const bars = dataPkg.bars;

  const eventsRaw = await fs.readFile(path.join(DATA_DIR, "events.json"), "utf8");
  const eventsPkg = JSON.parse(eventsRaw) as { events: EventRow[] };
  console.log(`Data: ${bars.length} bars, ${eventsPkg.events.length} curated events`);

  // Compute train/test split indices
  const trainEndIdx = bars.findIndex((b) => b.date > TRAIN_END_DATE) - 1;
  if (trainEndIdx <= 0) throw new Error("Bad train_end date");
  const trainStartIdx = 0;
  const testStartIdx = trainEndIdx + 1;
  const testEndIdx = bars.length - 1;
  console.log(`Train: ${bars[trainStartIdx].date} → ${bars[trainEndIdx].date} (${trainEndIdx - trainStartIdx + 1} bars, ${((trainEndIdx - trainStartIdx + 1) / 365.25).toFixed(1)}yr)`);
  console.log(`Test:  ${bars[testStartIdx].date} → ${bars[testEndIdx].date} (${testEndIdx - testStartIdx + 1} bars, ${((testEndIdx - testStartIdx + 1) / 365.25).toFixed(1)}yr)`);

  const indic = precomputeIndicators(bars);
  const eventStates = precomputeEventState(bars, eventsPkg.events);
  console.log("Indicators + event-state precomputed\n");

  // Buy-hold baselines
  const bhTrainFinal = (START_CAPITAL / bars[trainStartIdx].close) * bars[trainEndIdx].close;
  const bhTestFinal = (START_CAPITAL / bars[testStartIdx].close) * bars[testEndIdx].close;
  console.log(`Buy-hold train: $${START_CAPITAL} → $${bhTrainFinal.toFixed(0)}`);
  console.log(`Buy-hold test:  $${START_CAPITAL} → $${bhTestFinal.toFixed(0)}\n`);

  // Build K-fold ranges within train slice
  const trainLen = trainEndIdx - trainStartIdx + 1;
  const foldLen = Math.floor(trainLen / N_FOLDS);
  const foldRanges: { start: number; end: number }[] = [];
  for (let k = 0; k < N_FOLDS; k++) {
    const s = trainStartIdx + k * foldLen;
    const e = k === N_FOLDS - 1 ? trainEndIdx : s + foldLen - 1;
    foldRanges.push({ start: s, end: e });
  }
  console.log(`K-fold: ${N_FOLDS} folds within train slice`);
  for (let k = 0; k < N_FOLDS; k++) {
    const r = foldRanges[k];
    console.log(`  Fold ${k}: ${bars[r.start].date} → ${bars[r.end].date} (${r.end - r.start + 1} bars)`);
  }
  console.log("");

  // Init population
  let pop: { g: Genome; f: number }[] = [];
  for (let i = 0; i < POP_SIZE; i++) pop.push({ g: randomGenome(rng), f: -Infinity });

  await fs.mkdir(RESULTS_DIR, { recursive: true });

  const startTime = Date.now();
  let gen = 0;
  let bestEver: { g: Genome; f: number } | null = null;
  const genLog: any[] = [];

  while (Date.now() - startTime < durationMs) {
    gen++;
    for (const bot of pop) {
      if (bot.f === -Infinity) {
        const kres = evalKFold(bars, indic, eventStates, bot.g, foldRanges, trainStartIdx, trainEndIdx);
        bot.f = kres.fitness;
        if (!bestEver || bot.f > bestEver.f) bestEver = { g: bot.g, f: bot.f };
      }
    }
    pop.sort((a, b) => b.f - a.f);

    // Log per-fold best
    const kBest = evalKFold(bars, indic, eventStates, pop[0].g, foldRanges, trainStartIdx, trainEndIdx);
    genLog.push({
      gen, best_fit: Number(pop[0].f.toFixed(4)),
      median_fit: Number(pop[Math.floor(POP_SIZE / 2)].f.toFixed(4)),
      fold_calmars: kBest.folds.map((f) => Number(f.res.calmar.toFixed(2))),
      fold_dds: kBest.folds.map((f) => Number((f.res.max_dd_pct * 100).toFixed(1))),
      fold_trades: kBest.folds.map((f) => f.res.n_trades),
    });

    if (gen % 5 === 1 || gen < 3) {
      const calmars = kBest.folds.map((f) => f.res.calmar.toFixed(2).padStart(5)).join("/");
      const dds = kBest.folds.map((f) => (f.res.max_dd_pct * 100).toFixed(0).padStart(2)).join("/");
      console.log(
        `Gen ${gen.toString().padStart(4)} | fit ${pop[0].f.toFixed(3).padStart(7)} | ` +
        `fold Calmar ${calmars} | fold DD ${dds}%`
      );
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

  console.log(`\nEvolution complete: ${gen} gens, ${((Date.now() - startTime) / 60000).toFixed(1)} min`);

  if (!bestEver) return;

  // Re-eval best bot on per-fold AND full train AND held-out test
  const kBestFinal = evalKFold(bars, indic, eventStates, bestEver.g, foldRanges, trainStartIdx, trainEndIdx);
  const trainRes = simulate(bars, indic, eventStates, bestEver.g, trainStartIdx, trainEndIdx);
  const testRes = simulate(bars, indic, eventStates, bestEver.g, testStartIdx, testEndIdx);
  const p = decode(bestEver.g);

  console.log("\n" + "=".repeat(80));
  console.log("BEST BOT — PER FOLD (GA optimized mean Calmar across these)");
  console.log("=".repeat(80));
  for (let k = 0; k < N_FOLDS; k++) {
    const r = kBestFinal.folds[k].res;
    console.log(`Fold ${k} (${bars[foldRanges[k].start].date} → ${bars[foldRanges[k].end].date}): CAGR ${(r.cagr*100).toFixed(1)}% | DD ${(r.max_dd_pct*100).toFixed(1)}% | Calmar ${r.calmar.toFixed(2)} | trades ${r.n_trades} | ${r.liquidated?"☠":"✓"}`);
  }

  console.log("\n" + "=".repeat(80));
  console.log("BEST BOT — FULL TRAIN slice (concatenated 2010-2022)");
  console.log("=".repeat(80));
  console.log(`Fitness (mean Calmar across folds w/ cliffs): ${bestEver.f.toFixed(3)}`);
  console.log(`Final equity: $${trainRes.final_equity.toFixed(0)} | Peak: $${trainRes.peak_equity.toFixed(0)}`);
  console.log(`CAGR: ${(trainRes.cagr * 100).toFixed(1)}% | Max DD: ${(trainRes.max_dd_pct * 100).toFixed(1)}% | Sortino: ${trainRes.sortino.toFixed(2)} | Calmar: ${trainRes.calmar.toFixed(2)}`);
  console.log(`Trades: ${trainRes.n_trades} | Survived: ${trainRes.survival_days}/${trainRes.total_days} | Liquidated: ${trainRes.liquidated ? "YES" : "NO"}`);
  console.log(`vs Buy-hold: $${trainRes.buy_hold_equity.toFixed(0)} — ${trainRes.final_equity > trainRes.buy_hold_equity ? "BOT WINS" : "BUY-HOLD WINS"}`);

  console.log("\n" + "=".repeat(80));
  console.log("BEST BOT — TEST slice (HELD OUT, honest OOS)");
  console.log("=".repeat(80));
  console.log(`Final equity: $${testRes.final_equity.toFixed(0)} | Peak: $${testRes.peak_equity.toFixed(0)}`);
  console.log(`CAGR: ${(testRes.cagr * 100).toFixed(1)}% | Max DD: ${(testRes.max_dd_pct * 100).toFixed(1)}% | Sortino: ${testRes.sortino.toFixed(2)} | Calmar: ${testRes.calmar.toFixed(2)}`);
  console.log(`Trades: ${testRes.n_trades} | Survived: ${testRes.survival_days}/${testRes.total_days} | Liquidated: ${testRes.liquidated ? "YES" : "NO"}`);
  console.log(`vs Buy-hold: $${testRes.buy_hold_equity.toFixed(0)} — ${testRes.final_equity > testRes.buy_hold_equity ? "BOT WINS" : "BUY-HOLD WINS"}`);

  console.log("\nEvolved genome:");
  console.log(`  RSI ${p.rsi_oversold.toFixed(1)}/${p.rsi_overbought.toFixed(1)} | MA ${p.ma_fast_period}/${p.ma_slow_period}/${p.ma_trend_period}d`);
  console.log(`  Entry threshold ${p.entry_conf_threshold.toFixed(2)} | Base pos ${(p.base_position * 100).toFixed(0)}% | Vol scale ${p.vol_scale.toFixed(2)}`);
  console.log(`  Stop ${(p.stop_loss_pct * 100).toFixed(1)}% | Target ${(p.take_profit_pct * 100).toFixed(0)}% | Hold ${p.max_hold_days}d | Cool ${p.cooldown_days}d`);
  console.log(`  Weights trend ${p.trend_weight.toFixed(2)} RSI ${p.rsi_weight.toFixed(2)} momo ${p.momentum_weight.toFixed(2)}`);
  console.log(`  Bearish event fear ${p.bearish_event_fear.toFixed(2)} memory ${p.event_memory_days}d`);

  await fs.writeFile(path.join(RESULTS_DIR, `${runId}-best-bot.json`), JSON.stringify({
    run_id: runId,
    generated_utc: new Date().toISOString(),
    generations_run: gen,
    duration_min: (Date.now() - startTime) / 60000,
    seed,
    train_end: TRAIN_END_DATE,
    n_folds: N_FOLDS,
    max_dd_cliff: MAX_DD_CLIFF,
    slippage_base_bps: SLIPPAGE_BASE_BPS,
    slippage_vol_coef: SLIPPAGE_VOL_COEF,
    fitness_function: "kfold_min_calmar_with_percut_and_concat_dd_cliff",
    best_genome: bestEver.g,
    decoded_params: p,
    fold_results: kBestFinal.folds.map((f) => ({
      fold: f.fold,
      date_start: bars[f.startIdx].date,
      date_end: bars[f.endIdx].date,
      result: f.res,
    })),
    train_result: trainRes,
    test_result: testRes,
    buy_hold_train_final: bhTrainFinal,
    buy_hold_test_final: bhTestFinal,
    generation_log: genLog,
  }, null, 2));
  console.log(`\nWrote ${runId}-best-bot.json`);
}

main().catch((err) => { console.error("failed:", err); process.exit(1); });
