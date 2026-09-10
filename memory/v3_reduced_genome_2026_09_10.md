---
name: v3 Step A — reduced genome (17 genes) cuts overfit 14× vs v2 2026-09-10
description: Anti-cheat env unchanged; genome shrunk 23→17 by dropping per-category fears + halving-boost. Train→test CAGR collapse dropped 156× → 11×. First bot with actual OOS edge (+19.9% CAGR on 2023-2026 unseen).
type: project
---

# v3 = Step A of the A/B/C plan — shrink the genome

## Genome change vs v2
- Dropped: 4 per-category fear genes (hack/reg/macro/geo), news_memory_days, 3 halving genes = **7 removed**
- Added: 1 generic `bearish_event_fear` + 1 `event_memory_days` = **2 added**
- Net: 23 → 17 genes (v1's 15 + 2 event genes)
- Bearish fear applies to any event in: hack, macro, geopolitical, market_structure
- Halving boost REMOVED entirely (overfit vector: cycles 1-3 not representative of 2024)

## Head-to-head (same env, same seed 42)

| slice | v2 (23-gene) | v3 (17-gene) | Δ |
|---|---|---|---|
| Train CAGR | 297.9% | 222.8% | −25% |
| Train MaxDD | 28.4% | **16.2%** | −43% |
| Train Calmar | 10.50 | **13.78** | +31% |
| Train trades | 376 | **82** | −78% |
| **Test CAGR** | 1.9% | **19.9%** | **+948%** |
| Test MaxDD | 35.6% | 29.2% | −18% |
| **Test Calmar** | 0.05 | **0.68** | **+1260%** |
| **Train→test CAGR collapse** | 156× | **11×** | 14× less overfit |

## v3 evolved genome
- Technical: RSI 28/73, MA 13/35/172d, entry thr 0.73, base pos 100%, vol scale 0.00
- Stops: 3.6% loss / 70% target, 38-day max hold, 12-day cool
- Weights: trend 0.92 (dominant), RSI 0.35, momentum 0.44
- Bearish event fear 1.00 memory 8d (full exit for 8d after any bearish event)

## Ship verdict
**Still blocked.** OOS Calmar 0.68 < 1.0 gate. Test MaxDD 29.2% is comfortable but ceiling proximity noted. But this is the first version with real OOS edge — v3 made $954 profit over 3.7 unseen years while v2 essentially broke even.

## Lessons
1. **Genome flexibility was the primary overfit source.** Cutting 6 genes (net) cut overfit 14×.
2. **Halving-cycle genes are dangerous.** 4 halvings in dataset, only 3 in train, 1 in test — GA had to memorize.
3. **Per-category fear = hidden lookup table.** Even without impact_score, having 4 separate fear knobs let GA distinguish "how bad was 2014-02-24 vs 2022-11-11". Collapsing to 1 knob forced generalization.
4. **Selectivity generalizes.** v3's 82-trade / 12.4yr rate transferred cleanly to 45-trade / 3.7yr (same 6.6-12/yr band). v2's 376 trades did not.

## Next
- **Realism patch #1: slippage.** Current 50 bps roundtrip = flat exchange fee. Add stochastic slippage per trade, boost during high-vol bars. Applies to v4+ (K-fold Step B).
- **Step B (v4): K-fold fitness.** 5 rolling folds within train slice, fitness = mean Calmar. Kills any strategy that only works in 1 regime.

## Artifacts
- `results/v3-best-bot.json`
- `results/v3-run.log`
- `scripts/4-evolve-v3.ts`
