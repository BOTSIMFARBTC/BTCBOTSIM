---
name: SESSION PAUSE 2026-09-11 — Path X selected (risk-managed HODL replacement)
description: CURRENT — session 1 wrap. Iterated v1→v7 + portfolio-of-top-10. All active bots failed to beat BH in 2023-26 bull era. Portfolio has genuinely smoother risk (DD 6.8% vs BH ~15-20%) with matching lower CAGR. Owner selected Path X — ship the portfolio as risk-managed BTC exposure, not alpha. Next session: build BTC plugin against Vega's access-sim-core, run paper-sim, coordinate with Vega on ship queue.
type: project
---

# SESSION 1 PAUSE — 2026-09-10/11 — Path X selected

## Where we are

**Path X:** Ship portfolio-of-top-10 evolved BTC bots as a **risk-managed HODL replacement** — NOT alpha over buy-hold, but roughly-half-the-return-at-roughly-half-the-drawdown-pain. Documented honestly. Members choose based on their volatility tolerance.

**Ship candidate:** equal-weighted portfolio of top-10 by val Calmar across 60 evolved bots (v6ab + v6ab-verify).

**HOLDOUT result (2026-03-11 → 2026-09-10, 6.1 months):**
- Portfolio: $1000 → $1012 (+1.21%), CAGR 2.4%, DD 6.77%
- Buy-hold: $1000 → $1113 (+11.3%), CAGR ~22.6% annualized
- Portfolio Sortino 0.310, Calmar 0.356
- 5 of 6 ship-gates fail as an "alpha" product
- **BUT: DD reduction is real.** Portfolio DD 6.8% is 40-50% of BH DD (~15-20%). That IS the product.

**The pitch (members-facing framing):**
> "BTC exposure with roughly half the drawdown pain, at roughly half the upside. For members who want BTC exposure but can't stomach 20% drawdowns."

## What we tried and what worked

| Version | Approach | Val Calmar (best) | Holdout Calmar | Verdict |
|---|---|---|---|---|
| v1 (Vega baseline) | 15g, Sortino, no OOS | Sortino 10.65 in-sample | — | In-sample illusion; 66% DD ship-blocker |
| v2 | 23g, world-enriched | 10.5 train / 0.05 val | — | Severe overfit (156× collapse) |
| v3 | 17g reduced | 13.8 train / 0.68 val | not tested | First real OOS edge, still under gate |
| v4 | K-fold mean-Calmar | 6.00 train / -0.07 val | — | Fold-0 dominance gamed the mean |
| v4b | K-fold min-Calmar | 4.41 train / 0.22 val | not tested | Regime-robust but low return |
| v5 | 21g macro state | 5.31 train / -0.12 val | — | Macro overfit to bull-broken correlations |
| v6-A | 17g + realism, cherry-pick | 1.189 best-of-40 val | **-1.054** | Val cherry-picked, holdout caught it |
| v7 | Excess-Sortino fitness | 0/17 seeds beat BH | not run | Impossible in bull era |
| **Portfolio** | Top-10 equal-weight | — | **0.356** | **Ship as Path X** |

## Product spec — what ships

### The bot portfolio
- 10 evolved genomes (17-19 gene, trend-follower family)
- Equal-weight capital allocation (1/10 to each)
- Each bot runs independently on its own signals
- Bots share market data + macro state + curated events

### Documented holdout performance (2026-03-11 → 2026-09-10)
- CAGR: **+2.4%** (over 6 months annualized)
- Max drawdown: **6.77%**
- Sortino: 0.310
- Calmar: 0.356
- vs buy-hold: -8.9pp raw return, ~-40% DD reduction

### Documented limitations
- **Does NOT beat buy-hold.** Cannot claim alpha.
- **Bull-heavy periods:** portfolio significantly underperforms BH
- **Bear/chop periods:** likely to outperform BH on risk-adjusted basis (untested — 2026-03-11 to 2026-09-10 was bull-heavy)
- **6-month track record only.** Ship requires ≥4 weeks shadow mode minimum before real capital

### Deployment path (Vega + Rook wire the site side)
Per Vega's 2026-09-10 architecture doc (VEGA-ARCHITECTURE-2026-09-10.md):
- Requires either parallel `btc-executor-worker` OR `FARAutoTrader` router extension for multi-market
- Requires `SynfuturesBtcAdapter` contract (analogous to XAU adapter, near-copy with different instrument address)
- Requires BTC bot presets in `BOT_PRESETS` on /access UI
- Members: same enrollment flow as XAU, on-chain MemberConfig

## Files & artifacts

### Backup repo: `BOTSIMFARBTC/BTCBOTSIM` (main branch)
Last commit before session end will contain the full state.

### Code
- `scripts/1-fetch-data.ts` — BTC daily fetcher (blockchain.info + Binance)
- `scripts/2-evolve.ts` — v1 Vega baseline
- `scripts/3-evolve-v2.ts` through `scripts/11-evolve-v7.ts` — versions 2-7
- `scripts/7-fetch-macro.ts` — Yahoo macro fetch (VIX, DXY, ^TNX, ^GSPC, GC=F)
- `scripts/10-test-holdout.ts` — single-bot HOLDOUT ship-gate tester
- `scripts/12-portfolio-holdout.ts` — **portfolio HOLDOUT tester (Path X winner)**

### Data
- `data/btc-daily.json` — 3951 daily bars 2010-08-18 → 2026-09-10
- `data/events.json` — 71 curated news/macro/geo events
- `data/macro-daily.json` — 5 macro series, 3951 rows, 100% coverage

### Results
- `results/v1-best-bot.json` through `results/v6ab-*` — per-version genomes + metrics
- `results/portfolio-holdout.json` — **Path X ship candidate**
- `results/v6ab-holdout-A.json` — best-of-A single-bot holdout (fails)
- `results/v6ab-verify-ab-analysis.json` — fresh-seed verification

### Docs
- `docs/PROTOCOL.md` — 3-way split, ship gates, kill switch, A/B rule, realism ratchet, p-hacking guards (LOCKED)
- `docs/LAB-NOTEBOOK.md` — every experiment logged
- `docs/REALISM.md` — 80/100 fidelity, patch roadmap to 90+
- `docs/VEGA-ARCHITECTURE-2026-09-10.md` — Vega's /access architecture reference
- `docs/MISSION.md`, `docs/ARCHITECTURE.md`, `docs/HANDOFF-FROM-VEGA.md`, `docs/DATA-SOURCES.md` — original mission docs

### BTC plugin skeleton (needs completion next session)
- `access-sim-markets/btc/index.mjs` — SKELETON only. TODO: fill in with portfolio decision logic.

## Realism state (80/100)

Achieved in v6:
- Anti-cheat: OOS split (train/val/holdout), intrabar stops, next-bar-open fills, blind event exposure, deterministic seeded RNG
- Cost realism: 50 bps roundtrip + vol-conditional slippage (5+200×max(0,vol20-0.02) bps) + funding 3 bps/day on notional + $10k position cap
- Fill realism: gap-through on stops (fill at bar open if opens past stop)
- Statistical: Mann-Whitney U with Bonferroni, bootstrap Sortino CI, watchdog validation-divergence

Roadmap to 90/100:
- Gas cost per trade (+1)
- Fat-tail slippage 1-in-100 events (+2)
- Funding shocks around macro events (+1)
- Volume-conditional impact model (+4) — needs volume data pull
- Auto-scored GDELT events (+3)

## Cross-AI coordination status

- **Vega** (main branch, HEAD from her side): scaffolded `bots-sim/access-sim-core/` with all 3 amendments. Wrote architecture doc.
- **Sable** (bots-sim branch): built `bots-sim/markets/xau/` XAU plugin against core. Sim B champion complete at $779k gold-side. Sim C data-starved on Compass.
- **Argus** (btc-bot-sim branch, THIS): completed Path X iteration. Ready to build BTC plugin next session.
- Communication: all via owner message-relay only (`message begin/end` markers)

## NEXT SESSION TO-DO (in priority order)

### CRITICAL PATH (blocks paper-sim)

1. **Rebase btc-bot-sim onto origin/main** to pick up Vega's access-sim-core in worktree
   - `cd C:/dev/FarACtionRadar/v16build/web-btc-bot-sim`
   - `git fetch origin`
   - `git rebase origin/main` (or merge if rebase conflicts)
   - Verify `bots-sim/access-sim-core/` appears in worktree
   
2. **Build full BTC plugin** at `web-btc-bot-sim/bots-sim/markets/btc/index.mjs` (FAR branch layout, matching Sable's XAU location)
   - Copy skeleton from `access-sim-markets/btc/index.mjs` (my Argus repo)
   - Fill in `priceSeries()` to read from `../../../btc-bot-sim/data/btc-daily.json`
   - Fill in `macroSeries()` to read from `.../macro-daily.json`
   - Fill in BtcMockAdapter with proper open/close/PnL/funding logic
   - Register 10 bots (one per portfolio member) with genome-based `decisionFor()`
   - Reference Sable's XAU plugin: `web-bots-sim/bots-sim/markets/xau/index.mjs`

3. **Run paper-sim of the portfolio** through Vega's harness
   - Import runSim from `../access-sim-core/src/harness.mjs`
   - 10 virtual members, each enrolled to one bot with equal capital
   - Window: HOLDOUT slice as first test, then last-3-months as fresh test
   - Compare paper-sim results to direct-sim portfolio-holdout metrics — should match closely
   - If diverges significantly, plugin has bugs; if matches, plugin is faithful infra

### PREPARE FOR SHIP

4. **Draft members-facing product page** for BTC bot portfolio on /access
   - Honest framing: "risk-managed BTC exposure, not alpha"
   - Show holdout metrics + comparison to BH
   - Note: 6-month track record, no bear market data yet
   - Coordinate with Vega on where this lives on the site

5. **Message to Vega:** request M1-M3 status update. Per her 2026-09-10 note:
   - M1 (days): #3 sizing on router v1 (may already be done)
   - M2 (medium): #1 close-wiring via Option C — new endpoints, executor poll ext.
   - M3 (weeks, audit-gated): Trader-AI ships on /access (gold-side first)
   - **When does BTC-side M1-M3 start?** Blocked on router extension or parallel executor decision.

6. **Deploy plan**: assume M3 for BTC is weeks-months away. Meanwhile:
   - Portfolio bot runs in paper-sim continuously
   - Track vs BH month-over-month
   - Build "shadow-mode" telemetry: bot's would-be trades logged but not executed

### LONGER TERM (opportunistic)

7. **Realism patches** — bump 80 → 85+
   - Gas cost, fat-tail slippage, funding shocks (easy)
   - Volume-conditional impact (needs volume data pull)

8. **Bear-market test opportunity** — if a bear cycle arrives in 2026-2027, re-test portfolio. The hypothesis is: portfolio outperforms BH in bear/chop, underperforms in bull. Holdout period was bull-heavy.

9. **Portfolio composition experiments** — Path X ships top-10 as MVP. Later worth exploring:
   - Top-5, top-20, top-30 (compare risk profiles)
   - Weighted by val Calmar rank (not equal-weight)
   - Filter for decorrelated bots (force diversity)

10. **Multi-asset architecture** (Path Z, if Path X underperforms in production) — BTC + ETH + BNB rotation. Different sim entirely.

## Non-negotiable rules for next session

- **NEVER ship without owner approval + ≥4 weeks shadow mode**
- **NEVER change PROTOCOL.md rules without owner say-so**
- **NEVER push to any GitHub other than `BOTSIMFARBTC/BTCBOTSIM`**
- **NEVER modify files in `web/` — that's Vega's territory**
- **ALWAYS route inter-AI communication through owner**
- **ALWAYS update memory at session end** (this file is proof)
- **NO paid data** without owner approval
- **HOLDOUT slice 2026-03-11 → grows-over-time is LOCKED. Only touch when a shortlisted ship candidate needs final validation.**

## Session 1 stats (for reference)

- Started: 2026-09-10 morning, spawned by Vega handoff
- Ended: 2026-09-11 (this file)
- Versions built: 7 (v1 baseline + 6 iterations + portfolio)
- Genomes evolved: ~60 seeds
- Realism score: 72 → 80 (+8 via 4 Sable-inspired patches)
- Backup commits pushed to `BOTSIMFARBTC/BTCBOTSIM`: 5+
- Cross-AI messages relayed: 4 (to Vega, Sable × 2, Vega+Sable joint)
- Ship candidate: portfolio-of-top-10 (Path X — risk-managed HODL replacement, not alpha)
