---
name: v5 Step C — macro state backfires + per-regime attribution 2026-09-10
description: Added VIX/DXY/^TNX/SP500 macro state + 4 reactivity genes + geo-mean K-fold + event delay. Bot became elite at bear-defense but failed to participate in bulls. OOS regressed to -3.2% CAGR. Per-regime breakdown shows bot captured only 20% of strong-bull days.
type: project
---

# v5 — macro state + geo-mean fitness + event delay = OOS regression

## Setup
- 21-gene genome (17 v4b + 4 macro: vix_fear, dxy_fear, yield_fear, riskon_boost)
- Fitness = **geometric mean** of Calmars across 4 folds w/ all cliffs
- Realism patch #2: event visibility 1-day delay
- Macro state: percentile-normalized VIX/DXY/^TNX (250d window) + SP500 20d return
- Everything else preserved from v4b (slippage, intrabar, next-bar-open, seed 42)

## Results

| slice | CAGR | MaxDD | Calmar | trades |
|---|---|---|---|---|
| Fold 0 (2010-17) | 591.5% | 20.5% | 28.80 | 27 |
| Fold 1 (2017-19) | 35.7% | 8.3% | 4.28 | 14 |
| Fold 2 (2019-21) | 138.1% | 8.4% | 16.44 | 17 |
| Fold 3 (2021-22) | 19.7% | 7.4% | 2.65 | 8 |
| Full train concat | 156.9% | 29.5% | 5.31 | 78 |
| **OOS TEST 2023-26** | **-3.2%** | 27.2% | **-0.12** | 41 |

Geo-mean fitness = 8.56 (working as designed — every fold Calmar > 2).

## THE DIAGNOSTIC — per-regime OOS breakdown

| Regime | Days | Bot ret/day | BTC ret/day | Verdict |
|---|---|---|---|---|
| Strong bull (>20%/60d) | 381 | +0.127% | +0.620% | 20% capture — grossly underparticipating |
| Mild bull (5-20%) | 311 | -0.007% | +0.190% | LOSING while BTC rises |
| Chop | 255 | -0.079% | -0.010% | Bleeding fees in flat markets |
| Mild bear (-20..-5) | 291 | -0.002% | -0.202% | Elite defense (flat) |
| Strong bear (<-20%) | 111 | 0.000% | -0.384% | Perfect defense |

**OOS window is 692 bull days vs 402 bear/chop days. Bot is bear-optimized but OOS is bull-heavy.** Defense is why train Calmar looks good; missed offense is why OOS lost.

## Evolved genome (macro genes revealing)
- Technical: RSI 29.5/61.8, MA 14/41/123d, entry thr 0.70, base pos 88%, vol scale 2.00, stop 8.9%, target 100%, hold 30d, cool 14d
- Signal weights: trend 0.91, RSI 0.17, momentum 0.00 (fully ignored!)
- Bearish event fear 0.96 memory 60d
- **Macro: vix_fear 1.00 (MAX), dxy_fear 0.31, yield_fear 0.73, riskon_boost 1.00**

## Why the macro genes overfitted

The GA discovered: in the training data (2010-2022), high VIX + high yields = BTC risk-off. Bot learned "if VIX > 80th pctile OR 10Y yields > 80th pctile, exit."

**But 2023-2026 broke this correlation:**
- Fed hiking cycle raised yields to 20yr highs while BTC rallied (ETF, Trump, halving)
- Post-COVID VIX spikes uncorrelated with BTC direction
- Bot's rule "yields up → exit" was actively wrong for this regime

## The permanent lesson

**Adding state without matching training conditions makes bots MORE brittle, not less.**

The bot needed to see cross-asset relationships that broke during the OOS window. Without exposure to the Fed-hiking-with-bull-rally regime in training, the bot's macro rules encode the WRONG lesson. Blind OOS was the honest referee — as intended.

## Comparison of one-genome bots

| version | Method | OOS CAGR | Notable |
|---|---|---|---|
| v3 | Single train, 17g | +19.9% | Accidentally suited OOS bull |
| v4b | K-fold min, 17g | +4.8% | Cautious but participates in bulls |
| v5 | K-fold geo-mean, 21g +macro | -3.2% | Macro overfit → fails in bulls |

## v6 hypotheses

**A. Bull-participation floor in fitness.** Add "must capture ≥30% of BTC up-day returns" as constraint. Forces skin in the game.

**B. Shrink macro (or drop).** 4 macro genes may be too many. Try 1 composite macro-fear + 1 composite risk-on. Or ablate: rerun v5 setup minus macro genes to isolate what the macro added.

**C. Reweight fitness across regimes.** Currently fitness treats all fold days equally. Weight bull days more (BTC's actual population is bull-heavy over 15yr).

## Artifacts
- `results/v5-best-bot.json`
- `results/v5-run.log`
- `scripts/8-evolve-v5.ts` (v5 source of truth)
- `data/macro-daily.json` (Yahoo pulls, 100% coverage)
- `scripts/7-fetch-macro.ts` (macro fetcher)
