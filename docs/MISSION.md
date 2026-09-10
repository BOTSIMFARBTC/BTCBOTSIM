# Argus mission — BTC trading bot for FAR Action Radar

## The vision (owner's words)

> "I want an AI bot to be set up in a large BTC simulation... training in an error-and-learn state with $1000 capital, treating it as a real BTC trader, simulating from 2009 in real-time-like sequential, letting AI trade based on real data. Let it learn from errors, evolve, keep it going until it gets fully liquidated or survives to today. Record results. Make version 2 that learns from v1 but doesn't have exact memory of the chart. Reset and run again. Keep going until we're satisfied with results. Then two things: (a) see what it discovered that can help our AXIS algo, (b) deploy it on the website so members can use it for on-chain BTC trading."

## What "close to our reality" means

The bot's simulation world should include the factors that actually moved BTC price in the real world:

**Market data (already available):**
- Daily OHLC price from 2010-08-18 onward
- Volume, volatility, technical indicators

**News events the bot should know about (must integrate):**
- SEC actions (2013 Bitcoin trust, 2017 ICO crackdown, 2024 ETF approvals)
- Exchange collapses (Mt Gox 2014, Bitfinex hack 2016, FTX Nov 2022)
- Regulatory decisions per country (China bans 2013/2017/2021, US treatment)
- Major hacks and rug pulls with dollar amounts
- Halvings (2012, 2016, 2020, 2024)

**Geopolitical events:**
- Wars (Ukraine 2022 = risk-off; Israel-Iran = flight to safety)
- Sanctions (Russia 2022, Iran)
- Elections (US 2024, other majors)
- Central bank interventions

**Macro:**
- FOMC meetings + rate decisions
- CPI prints
- Employment data
- DXY, real yields, gold, S&P — the macro correlations that matter for BTC

**On-chain:**
- Halvings (huge supply shock events)
- Protocol upgrades (SegWit, Taproot)
- Miner difficulty adjustments (major transitions)
- Whale wallet movements (only if free data available)

## The two-phase deployment goal

**Phase 1: Learning phase**
- Bot evolves through many generations in simulation
- Each version (v1, v2, v3...) inherits learned strategy but not chart memory
- Continue until performance is consistent + robust across regimes
- Owner reviews and approves for phase 2

**Phase 2: Deployment**
- Bot integrated into FAR Action Radar website
- Members can enroll and let the bot trade BTC on-chain for them
- Executor-worker style deployment (like existing FAR autotrader)
- Real capital at stake — must be trustworthy

## Success criteria for phase 1

The bot is ready for deployment when it demonstrates:

1. **Consistency across regimes** — positive returns in bull, chop, AND bear markets
2. **Risk discipline** — max drawdown < 40% in worst simulated period
3. **Realistic edge** — Sortino ratio > 1.0 at realistic 50 bps roundtrip cost
4. **Robustness** — performance holds up on independent OOS validation (Coinbase price series, or a completely different sample slice)
5. **Interpretability** — the evolved strategy makes some intuitive sense (we can explain why it works)
6. **Statistical significance** — Monte Carlo bootstrap 95% CI on edge should be entirely positive

Owner sets the final bar. These are the objective floor.

## What NOT to do

- Do not optimize purely for total returns — buy-and-hold on BTC since 2010 returns 1,000,000× and no bot beats that in raw returns. Optimize for risk-adjusted returns.
- Do not deploy to members without owner approval + shadow-mode validation
- Do not overfit — every improvement must be validated OOS
- Do not touch anything in `web/` — that's Vega
- Do not skip commits — every meaningful run should commit + push
- Do not silence bad findings — if v3 is worse than v2, report it honestly

## What DOES help (from FAR memory patterns)

- The V2 intrabar-reality-check lesson: measurement artifacts can look like edge. Always sim exactly what a real trader would see.
- Walk-forward validation, not just single splits
- Block bootstrap for realistic confidence intervals (not naive independent-trade assumption)
- Test regime-conditional performance (bull vs chop vs bear separately)
- Test cost sensitivity (does edge survive at 100 bps? 150?)
- Independent OOS validation on a different price series

Vega's AXIS work found that all of these matter. Same discipline applies here.
