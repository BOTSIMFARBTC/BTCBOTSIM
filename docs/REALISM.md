# Sim Fidelity Score — monotonic ratchet

Argus's simulation fidelity vs real production trading. Score never decreases (per PROTOCOL.md §5). Every new version bumps this at least +1 point.

## Current score: **72 / 100**

## Score breakdown

| Category | Weight | Current | Details |
|---|---|---|---|
| **Look-ahead prevention** | 20 | **19/20** | ✓ Train/val/holdout split. ✓ Indicators only use bar[i] closes. ✓ Blind event exposure. −1 for hand-curated events (my selection = weak survivorship bias) |
| **Fill realism** | 15 | **13/15** | ✓ Next-bar-open fills for decisions. ✓ Intrabar stop/target checks (pessimistic ordering). −2 for no fat-tail slippage events. |
| **Cost realism** | 15 | **11/15** | ✓ 50 bps roundtrip base (conservative vs Vega's 2.6 bps prod estimate — safe direction). ✓ Vol-dependent slippage 5+200·max(0,vol20−0.02) bps. −4: no funding rates on perp positions, no gas cost per tx, no rebates. |
| **Market microstructure** | 15 | **6/15** | ✓ OHLC bars. −9: no volume data, no order book, no liquidity/impact model, no bid-ask spread, no market maker inventory. |
| **World-state fidelity** | 15 | **10/15** | ✓ 71 curated events, ✓ 5 macro series aligned, ✓ percentile-normalized regime state, ✓ event visibility delay 1d. −5: manually curated (should scrape GDELT + auto-scored). |
| **Statistical validity** | 10 | **8/10** | ✓ Deterministic seed. ✓ K-fold fitness (v4+). ✓ Blind holdout locked. −2 for A/B split only being 20 seeds (Sable-style 100-seed grid would be full). |
| **Cross-asset correlations** | 10 | **5/10** | ✓ Bot sees VIX/DXY/^TNX/SP500. −5: no gold, no ETH, no BTC dominance, no funding-rate history, no ETF flow proxies. |

## Roadmap — planned patches

Ordered by expected fidelity gain per unit of implementation effort:

### High-priority (large gain, low effort)
1. **Funding rate model** (+3 points, cost realism) — ±0.01% per 8h avg on notional, ±0.1% during known event windows. Straightforward add to simulate() using timestamp calendar.
2. **Gas cost per trade** (+1 point, cost realism) — flat $0.005 round-trip per Vega's Base gas profile. One-line change.
3. **Fat-tail slippage events** (+2 points, fill realism) — 1-in-100 bar has 20-50 bps slippage regardless of vol20. Simulates news-window liquidity gap.

### Medium-priority (medium gain, medium effort)
4. **Volume-conditional impact model** (+4 points, microstructure) — requires pulling daily volume data. Impact = k × sqrt(order_size / bar_volume). Matters for large-member portfolio simulation but not for GA fitness.
5. **Auto-scored event stream from GDELT** (+3 points, world-state) — replace hand-curated events.json with automated pipeline. Reduces Argus-bias.
6. **BTC dominance + ETH price** (+2 points, cross-asset) — Yahoo has both. Cheap to add.

### Lower-priority (large effort or ambiguous impact)
7. **ETF flow proxy** (+3 points, cross-asset) — requires paid data or crude proxy via GBTC premium history.
8. **Real bid-ask + order book** (+5 points, microstructure) — requires paid data or exchange snapshot dumps. Blocked on data budget.
9. **Multi-venue execution** (+3 points, microstructure) — model routing across Binance/Coinbase/Bybit/Synfutures. Complex.

## Ship-quality benchmark

At **72/100** we're above the ship-eligibility floor (I'd argue ~60/100 is defensible for a paper-trading gate). At **85+/100** we're at institutional-quant-fund standards.

## Path from 72 → 85

Bumps 1+2+3 (funding + gas + fat-tail slippage) = +6 → 78
Bump 4 (volume-impact) = +4 → 82
Bump 5 (auto events) = +3 → 85

That's the natural roadmap. Should land alongside v6/v7/v8.

## Path from 85 → 100

Only two more meaningful upgrades: real bid-ask/order-book data (paid) and multi-venue execution modeling. Both require data budget approval + significant implementation. Not chasing yet.
