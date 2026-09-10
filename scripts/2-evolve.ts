/**
 * Step 2: evolve BTC trading bots via genetic algorithm.
 *
 * Simulation setup:
 *   Starting capital: $1000
 *   Position size: 0-100% of current equity in BTC (continuous)
 *   Costs: 50 bps roundtrip (25 bps in, 25 bps out)
 *   Data: full 16yr BTC daily from blockchain.info + Binance
 *   Liquidation: equity < $10 → bot dies (fitness = -infinity)
 *
 * Bot genome (15 genes, all floats in normalized [0,1] internally):
 *   [0] rsi_oversold      → 20 + gene * 20 (20 to 40)
 *   [1] rsi_overbought    → 60 + gene * 30 (60 to 90)
 *   [2] ma_fast_period    → 3 + int(gene * 12) (3 to 15)
 *   [3] ma_slow_period    → 20 + int(gene * 80) (20 to 100)
 *   [4] ma_trend_period   → 100 + int(gene * 200) (100 to 300)
 *   [5] entry_conf_thr    → 0.3 + gene * 0.6 (0.3 to 0.9)
 *   [6] base_position     → 0.1 + gene * 0.9 (10% to 100%)
 *   [7] vol_scale         → gene * 2 (0 to 2)
 *   [8] stop_loss_pct     → 0.02 + gene * 0.18 (2% to 20%)
 *   [9] take_profit_pct   → 0.05 + gene * 0.95 (5% to 100%)
 *   [10] max_hold_days    → 5 + int(gene * 95) (5 to 100)
 *   [11] trend_weight     → gene (0 to 1)
 *   [12] rsi_weight       → gene (0 to 1)
 *   [13] momentum_weight  → gene (0 to 1)
 *   [14] cooldown_days    → int(gene * 20) (0 to 20)
 *
 * Fitness: Sortino ratio × survival_fraction
 *   - Sortino = mean_daily_return / downside_stddev
 *   - Survival = fraction of simulation days bot stayed above $10
 *   - Bots that die early get penalized
 *
 * Evolution:
 *   - Population: 100 bots
 *   - Elitism: top 5 bots preserved each generation
 *   - Selection: tournament of 3, winner reproduces
 *   - Crossover: single-point + uniform mix
 *   - Mutation: gaussian noise with per-gene amplitude
 *   - Adaptive mutation: rate decays over generations
 *
 * Runs for as long as user allows (target 30-60 min per session).
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(__dirname, "..", "data");
const RESULTS_DIR = path.resolve(__dirname, "..", "results");

const START_CAPITAL = 1000;
const COST_BPS_ROUNDTRIP = 50;
const LIQUIDATION_THRESHOLD = 10;
const GENOME_SIZE = 15;

const POP_SIZE = 100;
const ELITE_COUNT = 5;
const TOURNAMENT_SIZE = 3;
const MUTATION_RATE_INITIAL = 0.15;
const MUTATION_STDEV_INITIAL = 0.15;

interface BtcDay { date: string; ts: number; open: number; high: number; low: number; close: number; }
interface DailyState {
  price: number;
  ma_fast: number;
  ma_slow: number;
  ma_trend: number;
  rsi: number;
  vol20: number;
  ret_5d: number;
  ret_20d: number;
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
  fitness: number;
  buy_hold_equity: number; // for comparison
  liquidated: boolean;
  daily_returns: number[]; // returns on each day
}

/** Random genome ∈ [0,1]^15 */
function randomGenome(): Genome {
  return Array.from({ length: GENOME_SIZE }, () => Math.random());
}

/** Decode genome into named params. */
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
  };
}

// -----------------------------------------------------------
// Precompute technical indicators for the whole price series
// -----------------------------------------------------------

function precomputeIndicators(bars: BtcDay[]) {
  const closes = bars.map((b) => b.close);
  const rsi: number[] = new Array(bars.length).fill(50);
  // Wilder's RSI(14)
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
  // 20-day return volatility (stdev of daily % returns)
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
// Simulate one bot over the full dataset
// -----------------------------------------------------------

function simulate(bars: BtcDay[], indic: { rsi: number[]; vol20: number[] }, genome: Genome): BotResult {
  const p = decode(genome);
  const closes = bars.map((b) => b.close);
  const roundTripCost = COST_BPS_ROUNDTRIP / 10_000;

  let equity = START_CAPITAL;
  let cash = START_CAPITAL;
  let btcHeld = 0;             // BTC quantity
  let entryPrice = 0;
  let daysInPos = 0;
  let daysSinceExit = 999;
  let peakEquity = START_CAPITAL;
  let maxDdPct = 0;
  let nTrades = 0;
  let liquidated = false;
  let survivalDays = 0;
  const dailyReturns: number[] = [];

  const totalDays = bars.length;
  const buyHoldQty = START_CAPITAL / bars[0].close;

  for (let i = 0; i < totalDays; i++) {
    const price = closes[i];
    // Mark-to-market equity
    equity = cash + btcHeld * price;
    if (equity > peakEquity) peakEquity = equity;
    const currentDd = (peakEquity - equity) / peakEquity;
    if (currentDd > maxDdPct) maxDdPct = currentDd;

    // Check liquidation
    if (equity < LIQUIDATION_THRESHOLD) {
      liquidated = true;
      break;
    }
    survivalDays = i + 1;

    // Skip early days until indicators are meaningful
    if (i < Math.max(p.ma_trend_period, 30)) {
      dailyReturns.push(0);
      if (btcHeld > 0) daysInPos++;
      else daysSinceExit++;
      continue;
    }

    // Compute indicators for today
    const maFast = computeMa(closes, i, p.ma_fast_period);
    const maSlow = computeMa(closes, i, p.ma_slow_period);
    const maTrend = computeMa(closes, i, p.ma_trend_period);
    const rsi = indic.rsi[i];
    const vol = indic.vol20[i];
    const ret5d = i >= 5 ? (price - closes[i - 5]) / closes[i - 5] : 0;
    const ret20d = i >= 20 ? (price - closes[i - 20]) / closes[i - 20] : 0;

    // Decision logic — compute an entry-signal score in [0,1]
    // Component 1: RSI mean-reversion — high when RSI oversold, LOW when overbought
    const rsiScore = rsi < p.rsi_oversold ? 1 : rsi > p.rsi_overbought ? 0 : (p.rsi_overbought - rsi) / (p.rsi_overbought - p.rsi_oversold);
    // Component 2: trend — 1 when price > all MAs
    const trendScore = (price > maFast ? 0.33 : 0) + (maFast > maSlow ? 0.33 : 0) + (price > maTrend ? 0.34 : 0);
    // Component 3: momentum — 5d and 20d returns
    const momScore = Math.max(0, Math.min(1, 0.5 + (ret5d + ret20d) * 5));

    const totalWeight = p.rsi_weight + p.trend_weight + p.momentum_weight;
    const score = totalWeight > 0
      ? (p.rsi_weight * rsiScore + p.trend_weight * trendScore + p.momentum_weight * momScore) / totalWeight
      : 0.5;

    // Position sizing: base × vol adjustment
    const volFactor = 1 - p.vol_scale * Math.max(0, vol - 0.02);
    const targetSize = Math.max(0, Math.min(1, p.base_position * volFactor));

    // Decide action
    let desiredPositionPct = 0;
    if (btcHeld > 0) {
      const unrealizedPnl = (price - entryPrice) / entryPrice;
      const stopHit = unrealizedPnl <= -p.stop_loss_pct;
      const targetHit = unrealizedPnl >= p.take_profit_pct;
      const maxHoldHit = daysInPos >= p.max_hold_days;
      const scoreDrop = score < p.entry_conf_threshold * 0.5;
      if (stopHit || targetHit || maxHoldHit || scoreDrop) {
        desiredPositionPct = 0; // exit
      } else {
        desiredPositionPct = (btcHeld * price) / equity; // hold
      }
    } else {
      const cooldownOk = daysSinceExit >= p.cooldown_days;
      if (score >= p.entry_conf_threshold && cooldownOk) {
        desiredPositionPct = targetSize;
      } else {
        desiredPositionPct = 0;
      }
    }

    // Execute: adjust position toward desired
    const currentPositionPct = (btcHeld * price) / equity;
    const delta = desiredPositionPct - currentPositionPct;
    if (Math.abs(delta) > 0.05) {
      if (delta > 0) {
        // Buying more
        const usdToBuy = delta * equity;
        const cost = usdToBuy * roundTripCost * 0.5; // 25 bps entry cost
        const btcBought = (usdToBuy - cost) / price;
        cash -= usdToBuy;
        btcHeld += btcBought;
        if (btcHeld > 0 && entryPrice === 0) entryPrice = price;
        nTrades++;
      } else {
        // Selling
        const usdToSell = -delta * equity;
        const btcToSell = usdToSell / price;
        const cost = usdToSell * roundTripCost * 0.5; // 25 bps exit cost
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

    if (btcHeld > 0) { daysInPos++; daysSinceExit = 0; }
    else { daysSinceExit++; }

    // Daily return in %
    if (i > 0) {
      const equityYesterday = i > 0 ? cash + btcHeld * closes[i - 1] : START_CAPITAL;
      const dr = (equity - equityYesterday) / equityYesterday;
      dailyReturns.push(dr);
    } else {
      dailyReturns.push(0);
    }
  }

  const buyHoldFinal = buyHoldQty * closes[Math.min(survivalDays - 1, bars.length - 1)];
  const meanRet = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const downside = dailyReturns.filter((r) => r < 0);
  const downMean = downside.length > 0 ? downside.reduce((a, b) => a + b, 0) / downside.length : 0;
  const downStd = downside.length > 1
    ? Math.sqrt(downside.reduce((a, b) => a + (b - downMean) ** 2, 0) / (downside.length - 1))
    : 0.0001;
  const sortino = downStd > 0 ? meanRet / downStd * Math.sqrt(365) : 0;

  const survivalFrac = survivalDays / totalDays;
  const finalEquity = liquidated ? 0 : equity;
  // Fitness: sortino × survival, penalize liquidation heavily
  const fitness = liquidated ? -100 * (1 - survivalFrac) : sortino * survivalFrac;

  return {
    final_equity: finalEquity,
    peak_equity: peakEquity,
    max_dd_pct: maxDdPct,
    survival_days: survivalDays,
    total_days: totalDays,
    n_trades: nTrades,
    sortino: sortino,
    fitness,
    buy_hold_equity: buyHoldFinal,
    liquidated,
    daily_returns: dailyReturns,
  };
}

// -----------------------------------------------------------
// Genetic algorithm
// -----------------------------------------------------------

function tournamentSelect(pop: { g: Genome; f: number }[], k: number): Genome {
  let best: { g: Genome; f: number } | null = null;
  for (let i = 0; i < k; i++) {
    const pick = pop[Math.floor(Math.random() * pop.length)];
    if (!best || pick.f > best.f) best = pick;
  }
  return best!.g;
}

function crossover(a: Genome, b: Genome): Genome {
  const child: Genome = [];
  for (let i = 0; i < GENOME_SIZE; i++) {
    child.push(Math.random() < 0.5 ? a[i] : b[i]);
  }
  return child;
}

function mutate(g: Genome, rate: number, stdev: number): Genome {
  return g.map((v) => {
    if (Math.random() < rate) {
      const noise = randomNormal() * stdev;
      return Math.max(0, Math.min(1, v + noise));
    }
    return v;
  });
}

function randomNormal(): number {
  // Box-Muller
  const u = Math.random(), v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// -----------------------------------------------------------
// Main evolution loop
// -----------------------------------------------------------

async function main() {
  const runId = process.argv[2] ?? "v1";
  const durationMinArg = process.argv[3];
  const durationMs = durationMinArg ? Number(durationMinArg) * 60 * 1000 : 45 * 60 * 1000; // default 45 min
  const seedGenomeFile = process.argv[4]; // optional path to seed genome for v2+

  console.log(`AXIS bot evolution — run ${runId}, budget ${(durationMs / 60000).toFixed(0)} minutes\n`);

  const dataRaw = await fs.readFile(path.join(DATA_DIR, "btc-daily.json"), "utf8");
  const dataPkg = JSON.parse(dataRaw) as { bars: BtcDay[] };
  const bars = dataPkg.bars;
  console.log(`Data: ${bars.length} daily bars (${bars[0].date} → ${bars[bars.length - 1].date})`);

  const indic = precomputeIndicators(bars);
  console.log("Indicators precomputed\n");

  // Initialize population
  let pop: { g: Genome; f: number }[] = [];
  if (seedGenomeFile) {
    console.log(`Seeding from ${seedGenomeFile} + fresh mutation`);
    const seedRaw = await fs.readFile(seedGenomeFile, "utf8");
    const seed = JSON.parse(seedRaw) as { best_genome: Genome };
    for (let i = 0; i < POP_SIZE; i++) {
      const g = i === 0 ? seed.best_genome : mutate(seed.best_genome, 0.5, 0.2);
      pop.push({ g, f: -Infinity });
    }
  } else {
    for (let i = 0; i < POP_SIZE; i++) pop.push({ g: randomGenome(), f: -Infinity });
  }

  await fs.mkdir(RESULTS_DIR, { recursive: true });

  // Buy-hold baseline
  const bhFinal = (START_CAPITAL / bars[0].close) * bars[bars.length - 1].close;
  console.log(`Buy-and-hold baseline: $${START_CAPITAL} → $${bhFinal.toFixed(0)} (${((bhFinal / START_CAPITAL - 1) * 100).toFixed(0)}% total return)\n`);

  const startTime = Date.now();
  let gen = 0;
  let bestEver: { g: Genome; f: number; result: BotResult } | null = null;
  const genLog: { gen: number; best_fit: number; median_fit: number; best_equity: number; best_sortino: number; best_trades: number }[] = [];

  while (Date.now() - startTime < durationMs) {
    gen++;
    // Evaluate all bots
    for (const bot of pop) {
      if (bot.f === -Infinity) {
        const res = simulate(bars, indic, bot.g);
        bot.f = res.fitness;
        if (!bestEver || bot.f > bestEver.f) {
          bestEver = { g: bot.g, f: bot.f, result: res };
        }
      }
    }
    pop.sort((a, b) => b.f - a.f);

    const bestFit = pop[0].f;
    const medFit = pop[Math.floor(POP_SIZE / 2)].f;
    const bestBotResult = simulate(bars, indic, pop[0].g);
    genLog.push({
      gen,
      best_fit: Number(bestFit.toFixed(4)),
      median_fit: Number(medFit.toFixed(4)),
      best_equity: Number(bestBotResult.final_equity.toFixed(0)),
      best_sortino: Number(bestBotResult.sortino.toFixed(3)),
      best_trades: bestBotResult.n_trades,
    });

    // Log every 5 generations
    if (gen % 5 === 1 || gen < 3) {
      console.log(
        `Gen ${gen.toString().padStart(3)} | best fit ${bestFit.toFixed(3).padStart(8)} | ` +
        `equity $${bestBotResult.final_equity.toFixed(0).padStart(8)} | ` +
        `sortino ${bestBotResult.sortino.toFixed(2)} | ` +
        `trades ${bestBotResult.n_trades.toString().padStart(3)} | ` +
        `${bestBotResult.liquidated ? "☠ LIQUIDATED" : "✓ SURVIVED"}`
      );
    }

    // Selection + reproduction
    const nextPop: { g: Genome; f: number }[] = [];
    // Elitism
    for (let i = 0; i < ELITE_COUNT; i++) nextPop.push({ g: [...pop[i].g], f: pop[i].f });
    // Reproduce
    const mutRate = MUTATION_RATE_INITIAL * (1 - Math.min(0.5, gen / 200));
    const mutStd = MUTATION_STDEV_INITIAL * (1 - Math.min(0.5, gen / 200));
    while (nextPop.length < POP_SIZE) {
      const p1 = tournamentSelect(pop, TOURNAMENT_SIZE);
      const p2 = tournamentSelect(pop, TOURNAMENT_SIZE);
      let child = crossover(p1, p2);
      child = mutate(child, mutRate, mutStd);
      nextPop.push({ g: child, f: -Infinity });
    }
    pop = nextPop;
  }

  console.log(`\nEvolution complete: ${gen} generations, ${((Date.now() - startTime) / 60000).toFixed(1)} min`);

  if (bestEver) {
    const r = bestEver.result;
    const p = decode(bestEver.g);
    console.log("\n" + "=".repeat(80));
    console.log("BEST BOT EVOLVED");
    console.log("=".repeat(80));
    console.log(`Fitness: ${bestEver.f.toFixed(4)}`);
    console.log(`Final equity: $${r.final_equity.toFixed(0)} (${(r.final_equity / START_CAPITAL - 1) * 100 >= 0 ? "+" : ""}${((r.final_equity / START_CAPITAL - 1) * 100).toFixed(0)}%)`);
    console.log(`Peak equity: $${r.peak_equity.toFixed(0)}`);
    console.log(`Max drawdown: ${(r.max_dd_pct * 100).toFixed(1)}%`);
    console.log(`Sortino ratio (annualized): ${r.sortino.toFixed(2)}`);
    console.log(`Survival: ${r.survival_days}/${r.total_days} days (${(r.survival_days / r.total_days * 100).toFixed(0)}%)`);
    console.log(`Trades executed: ${r.n_trades}`);
    console.log(`Buy-and-hold comparison: $${r.buy_hold_equity.toFixed(0)}`);
    console.log(`Bot vs buy-hold: ${r.final_equity > r.buy_hold_equity ? "BOT WINS" : "BUY-HOLD WINS"}`);
    console.log(`Liquidated: ${r.liquidated ? "YES" : "NO"}`);
    console.log("\nEvolved parameters:");
    console.log(`  RSI oversold: ${p.rsi_oversold.toFixed(1)}, overbought: ${p.rsi_overbought.toFixed(1)}`);
    console.log(`  MA fast: ${p.ma_fast_period}d, slow: ${p.ma_slow_period}d, trend: ${p.ma_trend_period}d`);
    console.log(`  Entry confidence threshold: ${p.entry_conf_threshold.toFixed(2)}`);
    console.log(`  Base position size: ${(p.base_position * 100).toFixed(0)}%`);
    console.log(`  Stop loss: ${(p.stop_loss_pct * 100).toFixed(1)}%, take profit: ${(p.take_profit_pct * 100).toFixed(0)}%`);
    console.log(`  Max hold: ${p.max_hold_days} days, cooldown: ${p.cooldown_days} days`);
    console.log(`  Signal weights: trend ${p.trend_weight.toFixed(2)}, RSI ${p.rsi_weight.toFixed(2)}, momentum ${p.momentum_weight.toFixed(2)}`);

    await fs.writeFile(path.join(RESULTS_DIR, `${runId}-best-bot.json`), JSON.stringify({
      run_id: runId,
      generated_utc: new Date().toISOString(),
      generations_run: gen,
      duration_min: (Date.now() - startTime) / 60000,
      best_genome: bestEver.g,
      decoded_params: p,
      result: r,
      buy_hold_final: bhFinal,
      generation_log: genLog,
    }, null, 2));

    console.log(`\nWrote ${path.join(RESULTS_DIR, `${runId}-best-bot.json`)}`);
  }
}

main().catch((err) => { console.error("failed:", err); process.exit(1); });
