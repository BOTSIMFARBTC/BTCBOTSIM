---
name: v4 mean-Calmar failure + v4b min-Calmar fix 2026-09-10
description: K-fold Step B. v4 mean-Calmar was gamed by 2010-17 fold (Calmar 597) so bot regressed OOS to -2.4% CAGR. v4b swapped to min-Calmar (worst fold gates fitness) + added concat-train DD cliff. Every fold Calmar >5, OOS positive again (+4.8% CAGR, 21.5% DD).
type: project
---

# v4 (broken) + v4b (fixed) — K-fold aggregation matters a lot

## v4 setup
- 17-gene v3 genome
- 4-fold train split (2010-2017 / 2017-2019 / 2019-2021 / 2021-2022)
- Fitness = MEAN(Calmar per fold), per-fold DD > 40% => 0
- Realism patch #1: slippage 5+200*max(0, vol20-0.02) bps on every fill

## v4 failure
Fold 0 (2010-17, BTC $0.07→$4700) got Calmar 597.22. Mean fitness = 149.89. GA optimized for that moonshot; folds 1/3 stayed <1.0. Bot went aggressive (100% pos, 2% stop, cool 0, 456 trades). Full-train DD 52% (per-fold cliffs don't stop inter-fold compounding). **OOS test: -2.4% CAGR.**

## v4b fix (single change + one guard)
- Fitness = MIN(Calmar per fold) instead of MEAN
- Added: concat-train DD > 40% => fitness 0 (guards against inter-fold DD compounding)
- Everything else identical (17-gene, slippage, K-fold ranges, seed 42)

## v4b results

| slice | CAGR | MaxDD | Calmar | trades |
|---|---|---|---|---|
| Fold 0 (2010-17) | 277.1% | 13.3% | **20.78** | 32 |
| Fold 1 (2017-19) | 28.8% | 5.5% | **5.25** | 6 |
| Fold 2 (2019-21) | 98.9% | 11.0% | **8.98** | 24 |
| Fold 3 (2021-22) | 14.5% | 2.8% | **5.25** | 2 |
| Full train concat | 87.9% | 19.9% | 4.41 | 98 |
| **OOS TEST 2023-26** | 4.8% | 21.5% | **0.22** | 44 |

Every fold Calmar > 5. Full-train DD comfortably under 40%. OOS positive.

## v4b evolved genome
- RSI 38.9/60.6 (narrower), MA 6/45/197d
- Entry threshold 0.89 (very selective), base pos 100%, vol scale 0
- Stop 2.5% / target 50% / hold 14d / cool 14d
- Weights trend 0.65 / RSI 0.01 (ignored) / momo 0.46
- Bearish event fear 1.00 memory 60d (max long risk-off)

## Comparison — v3 vs v4b (the interesting choice)

| aspect | v3 (single train slice) | v4b (K-fold min-Calmar) |
|---|---|---|
| Fitness gate | Calmar on full 12.4yr | worst of 4 folds AND concat |
| Regime guarantee | none — one era only | every era Calmar > 5 |
| OOS CAGR | 19.9% (higher raw) | 4.8% (lower but safer) |
| OOS MaxDD | 29.2% | 21.5% |
| OOS Calmar | 0.68 (still better) | 0.22 |
| Trust level | might be lucky | provably robust across BTC eras |

## Lessons
1. **Aggregation choice = strategy choice.** Mean-across-folds rewards bots that crush one era; min-across-folds rewards bots that survive all eras. Very different bots emerge.
2. **Per-fold cliffs miss concat DD.** Bot can pass 4 individual fold cliffs yet compound to 52% DD across boundaries. Always cliff both.
3. **Robust ≠ maximum-return.** v4b's guaranteed 4-fold positivity cost raw return vs v3. This is the "expensive" cost of not-getting-lucky.
4. **17-gene shape is validated by both v3 and v4b.** Trend-heavy, low-frequency, patient. This confirms the reduced genome is the right structural choice.

## Ship gate
- v4b OOS Calmar 0.22 < 1.0 gate ❌
- OOS DD 21.5% ✓ (well under 40%)
- OOS CAGR 4.8% positive but weak

## Next
Step C (v5): add macro state (Yahoo DXY / VIX / ^TNX / gold / SP500) so bot reacts to conditions, not just events. Plus realism patch #2 (event visibility 1-day delay + dynamic halving trim). Bet: macro-aware bot might find bigger edge in OOS era (rate cycle, ETF flows).

## Artifacts
- `results/v4-best-bot.json` (v4 broken, kept for reference)
- `results/v4b-best-bot.json` (current best K-fold bot)
- `scripts/5-evolve-v4.ts` (v4 mean-Calmar, kept)
- `scripts/6-evolve-v4b.ts` (v4b min-Calmar, source of truth)
