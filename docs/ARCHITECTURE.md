# Architecture — BTC bot simulation world

## The simulation environment

The bot doesn't just see price. It sees a **world state** at each simulated day, containing everything that a real trader on that day would have known.

### Daily state passed to the bot

```typescript
interface WorldState {
  // Time
  date: string;              // YYYY-MM-DD (bot's "now")
  btc_days_since_genesis: number;

  // Price + technical
  btc_price: number;         // close
  btc_ohlc: OHLC;            // full day
  btc_rsi14: number;
  btc_ma_fast: number;       // period from genome
  btc_ma_slow: number;
  btc_ma_trend: number;      // 200d
  btc_vol20: number;         // 20d realized volatility
  btc_ret_5d: number;
  btc_ret_20d: number;
  btc_ret_90d: number;
  btc_drawdown_from_ath: number;

  // Macro (from FRED/Yahoo)
  dxy_price: number;
  dxy_20d_chg_pct: number;
  us10y_yield: number;
  us10y_20d_chg_bps: number;
  gold_price: number;
  sp500_price: number;
  sp500_20d_chg_pct: number;
  vix_level: number;

  // On-chain events (discrete, boolean or count)
  days_since_last_halving: number;
  next_halving_in_days: number;

  // News events (score buckets)
  recent_news_events: NewsEvent[];  // events in past 30 days
  regulation_regime: "loose" | "tightening" | "tight" | "crackdown";
  major_hack_recent: boolean;       // last 30d
  major_hack_impact_usd: number;    // if recent, magnitude

  // Geopolitical (Argus builds these)
  active_war: boolean;
  war_impact_score: number;          // 0-1
  major_election_upcoming: boolean;

  // Bot's own state
  current_position_pct: number;      // 0-1
  cash_usd: number;
  btc_held: number;
  unrealized_pnl_pct: number;
  days_in_position: number;
  days_since_last_trade: number;
  equity_usd: number;
  peak_equity_usd: number;
}

interface NewsEvent {
  date: string;
  category: "regulation" | "hack" | "adoption" | "macro" | "geopolitical" | "onchain";
  impact_score: number;   // -1 (very bearish) to +1 (very bullish)
  magnitude: number;      // 0-1 (how big a deal)
  description: string;
}
```

### The bot's action space

Continuous position size: **0.0 (flat) to 1.0 (100% in BTC)**, plus 3 optional discrete meta-actions:
- HOLD — no change
- REBALANCE_TO(target_pct) — adjust to target
- EMERGENCY_EXIT — flatten immediately (for panic events)

### The bot's genome

Starting point (from Vega's v1) is 15 genes controlling technical indicators + position sizing. Argus should **expand this** to include news-reactivity, geopolitical-reactivity, etc.

Suggested expanded genome (~30 genes):

**Technical (15 — inherited from v1):**
- RSI oversold/overbought thresholds
- MA periods (fast/slow/trend)
- Signal weights (trend/RSI/momentum)
- Position sizing base + vol adjustment
- Stop-loss, take-profit, max hold
- Cooldown, entry confidence threshold

**Macro (5 — new):**
- DXY reactivity weight (how much to reduce position on DXY spike)
- Yield reactivity weight
- VIX threshold for de-risking
- Gold correlation weight
- SP500 correlation weight

**News (5 — new):**
- Hack fear factor (position reduction on hack news)
- Regulation fear factor
- Adoption boost factor (position increase on positive news)
- Days-until-forgotten (memory decay for news events)
- News magnitude threshold (ignore small news)

**Geopolitical (3 — new):**
- War risk-off factor
- Election uncertainty factor
- Sanctions impact factor

**Halving-cycle (2 — new):**
- Pre-halving accumulation aggression
- Post-halving distribution timing

## Data pipeline

### Price data
- **blockchain.info** — full history 2010+ (weighted daily close, 1467 points)
- **Binance** — daily OHLCV 2017+ (3312 bars, better quality)
- **Coinbase** — daily OHLCV 2015+ (independent OOS validation)

### Macro data
- **Yahoo Finance** — DXY, ^TNX (10Y yield), GC=F (gold), ^GSPC (S&P), ^VIX
- **FRED** — official Fed data (requires free API key, get one)
- All from 2010+ where available

### News event timeline
Argus builds this from public sources:

1. **Wikipedia timelines**
   - "History of Bitcoin" — has hack list, price milestones
   - "Cryptocurrency regulation" — regulatory events by country
   - "War in Ukraine" and other geopolitical

2. **GDELT** — free global event database, structured news events

3. **Fed calendar** — FOMC meeting dates + rate decisions (public)

4. **CoinDesk / Bitcoin.org milestones** — halvings, protocol upgrades

5. **Manual curation** — a JSON file with ~100 major events + estimated impact scores

Suggested structure for `btc-bot-sim/data/events.json`:
```json
{
  "events": [
    {
      "date": "2014-02-24",
      "category": "hack",
      "description": "Mt Gox halts withdrawals; would announce bankruptcy 4 days later",
      "impact_score": -0.9,
      "magnitude": 1.0,
      "usd_impact": 850_000_000
    },
    {
      "date": "2020-05-11",
      "category": "onchain",
      "description": "3rd Bitcoin halving; block reward 12.5 → 6.25 BTC",
      "impact_score": 0.6,
      "magnitude": 0.8
    }
  ]
}
```

## Evolution engine (inherited from v1)

Vega's v1 uses:
- Population 100 bots
- Elitism 5
- Tournament selection (size 3)
- Uniform crossover
- Gaussian mutation with adaptive rate
- Fitness = Sortino × survival_fraction

Argus improvements to consider:
- **Multi-objective fitness** — Pareto-front on (returns, Sortino, max DD, robustness) instead of scalar
- **Novelty search** — reward bots that discover new strategies, not just performant ones
- **Curriculum learning** — start bots on easy periods, gradually expose to full history
- **Ensemble** — final production bot = weighted ensemble of top 5 evolved bots

## v1 → v2 → vN progression

Owner wants each version to inherit the previous version's LEARNED STRATEGY but not memorize specific chart movements.

**Implementation:**

- v2 population initialized with mutated copies of v1's best genome (50% mutation rate the first generation)
- v2 evolution runs on the SAME data but different random seed
- Divergence from v1 shows what patterns are ROBUST vs COINCIDENTAL
- If v2 converges to similar genome as v1 → the strategy is robust (real edge)
- If v2 diverges significantly → v1 was overfit to specific chart events

**Argus's job:** track this cross-version convergence. Report to owner.

## Deployment path (Phase 2)

When owner approves:

1. Best evolved bot genome exported as `btc-bot-sim/results/production-genome.json`
2. Vega picks it up, wires it into `web/executor-worker/` (or a new bot-worker)
3. Bot lives on Cloudflare, checks BTC state every hour (or daily), executes trades via Synfutures / member wallets (same architecture as existing FAR autotrader)
4. Member enrollment mirror what /access has today
5. Shadow mode 4 weeks minimum before real capital
6. Ongoing performance monitoring; auto-pause if rolling 30-emit performance drops > 5 pts below simulation expectation

Argus doesn't implement Phase 2 — but should design the bot so its rules are exportable to a stateless per-hour/per-day query. The evolved genome should be enough to run the bot in production.
