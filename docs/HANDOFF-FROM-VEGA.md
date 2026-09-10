# Handoff from Vega — what's already built

## Status at handoff (2026-09-10)

Vega set up the initial simulation and started v1 evolution before handing off to Argus. Everything is in this worktree at `btc-bot-sim/`.

## Files delivered

### Data (`btc-bot-sim/data/`)
- **`btc-daily.json`** — 3951 daily BTC OHLC bars (2010-08-18 → 2026-09-10, 16.1 years)
  - Merged from blockchain.info (2010+, weighted-avg close, treated as OHLC=close) and Binance (2017+, real OHLC)
  - Vega's fetch script at `btc-bot-sim/scripts/1-fetch-data.ts` — re-runnable for updates

### Scripts (`btc-bot-sim/scripts/`)
- **`1-fetch-data.ts`** — data fetcher (already run, output in `data/`)
- **`2-evolve.ts`** — genetic algorithm engine, 100-bot population, 15-gene bot

### Results (`btc-bot-sim/results/`)
- **`v1-best-bot.json`** — v1's best evolved bot (written when the currently-running v1 finishes ~45 min after handoff time; check date_end field to see when)
  - If Argus arrives before v1 finishes, the file won't exist yet — wait or read the running progress via the process output

## v1 setup summary

- **Starting capital:** $1000
- **Cost model:** 50 bps roundtrip (25 bps in, 25 bps out) — validated realistic per Vega's earlier cost stress-test
- **Liquidation threshold:** equity < $10 → bot dies (fitness = -100 × survival_deficit)
- **Fitness:** Sortino ratio (annualized, computed from daily returns) × survival_fraction

### 15-gene genome (v1 baseline)

Position | Gene | Range | Meaning
---|---|---|---
[0] | rsi_oversold | 20-40 | RSI threshold for oversold
[1] | rsi_overbought | 60-90 | RSI threshold for overbought
[2] | ma_fast_period | 3-15 | Fast MA period (days)
[3] | ma_slow_period | 20-100 | Slow MA period
[4] | ma_trend_period | 100-300 | Trend MA period
[5] | entry_conf_threshold | 0.3-0.9 | Min signal score for entry
[6] | base_position | 10-100% | Base position size when entering
[7] | vol_scale | 0-2 | How much to reduce position on high vol
[8] | stop_loss_pct | 2-20% | Stop-loss from entry
[9] | take_profit_pct | 5-100% | Take-profit from entry
[10] | max_hold_days | 5-100 | Force exit after N days
[11] | trend_weight | 0-1 | Weight of trend signal
[12] | rsi_weight | 0-1 | Weight of RSI signal
[13] | momentum_weight | 0-1 | Weight of momentum signal
[14] | cooldown_days | 0-20 | Days after exit before new entry allowed

### GA parameters

- Population: 100 bots per generation
- Elitism: top 5 bots preserved unchanged
- Selection: tournament (size 3)
- Crossover: uniform (50% prob per gene from each parent)
- Mutation: 15% rate initial, decays with generations; Gaussian noise stdev 0.15
- Fitness horizon: full 16 years (bot must survive from 2010 to 2026)

## v1 preliminary observations (from live run)

By generation ~50, best bot was converging to:
- Sortino ~10.5 (excellent risk-adjusted)
- Final equity ~$12,000 (12x return over 16 years)
- ~925 trades executed
- Not liquidated
- **Massively underperforming buy-and-hold** (buy-and-hold: $1000 → $1.1B)

This is expected because BTC's 2010-2013 era rewarded pure HOLD. Any bot that traded frequently in those years paid costs on every trade and missed the parabolic gains.

**Question for Argus:** is Sortino-optimizing the right thing? Buy-and-hold has essentially infinite Sortino for BTC over this era. Alternative fitness functions worth exploring:
1. Sharpe ratio (mean/stdev, less penalty for upside vol)
2. Calmar ratio (return / max drawdown)
3. Multi-objective: Pareto-front on (return, Sortino, max DD)
4. **Novelty search** — reward bots that find strategies different from previous winners

## What Argus should do next

### Immediate (session 1)

1. **Wait for v1 to finish**, read `results/v1-best-bot.json`
2. **Interpret v1's evolved parameters** — what strategy did evolution converge on?
3. **Save initial memory entries** in `btc-bot-sim/memory/` — v1 findings + planned next steps
4. **Set `.agent-name` = `argus` in this worktree** (for git commit trailers)

### Session 2+ (world model enrichment)

5. **Build the events database** — `btc-bot-sim/data/events.json` with ~100 major BTC-relevant events (Mt Gox, halvings, ETF, hacks, wars, etc.)
6. **Extend the state passed to the bot** to include news + macro (add fields per ARCHITECTURE.md)
7. **Extend the genome** to include news-reactivity genes (~15 more, total ~30)
8. **Run v2** with expanded state + genome — does the bot learn to react to events?
9. **Compare v1 vs v2** — does news awareness improve performance?

### Longer term

10. **Explore alternative fitness functions** (Calmar, multi-objective, novelty)
11. **Try curriculum learning** — start bots on easier periods
12. **Independent OOS validation** — hold out 2024-2026 as strict validation set
13. **Report findings to owner** when v2, v3 converge

## What Argus should NOT do

- Do NOT modify anything in `../web/` (Vega's territory)
- Do NOT deploy the bot to production — that's Phase 2, requires Vega + owner
- Do NOT skip validation on new versions — every claim needs backing
- Do NOT interpret "buy-and-hold wins" as the bot failing — buy-and-hold on BTC has an unbeatable 16-year sample, and the bot's job is risk-adjusted trading not raw beta chase

## Communication

Vega and Argus don't talk directly. If Argus needs Vega for something (data pull, AXIS-adjacent question, coordination), draft a message in the CLAUDE.md protocol and owner relays.

Vega has an interest in Argus's findings because evolved strategies might inform AXIS's rule design. When Argus discovers something significant, send it Vega's way via owner.

Good luck. Trust the process, iterate honestly, don't chase buy-and-hold ghost returns.

— Vega
2026-09-10
