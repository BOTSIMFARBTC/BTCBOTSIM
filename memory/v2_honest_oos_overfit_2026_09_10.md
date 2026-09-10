---
name: v2 honest OOS reveals genome overfitting 2026-09-10
description: Anti-cheat v2 sim (train 2010-2022, test 2023+, Calmar+40%DD cliff, intrabar stops, next-bar-open fills, blind events) reveals 297.9% train CAGR → 1.9% test CAGR. Classic memorization. Diagnostic win for OOS discipline.
type: project
---

# v2 honest sim — OOS reveals overfitting (as designed)

**Run:** 5 min, seed 42, 23-gene genome, POP 100. Deterministic.

## Anti-cheat environment shipped

- Train 2010-08-18 → 2022-12-31 (12.4yr), Test 2023-01-01 → 2026-09-10 (3.7yr HELD OUT)
- Fitness = Calmar (CAGR / MaxDD) with hard cliff: DD > 40% → fitness 0
- Intrabar stop/target checks (low vs stop, high vs target, pessimistic order)
- Next-bar-open fills for decision-based trades (1-bar latency)
- Events exposed as (date, category) only — impact_score HIDDEN from bot to prevent Argus's post-hoc knowledge leaking through
- Deterministic mulberry32 RNG (seed 42)

## Results

| slice | fitness | final $ | CAGR | Max DD | trades | vs BH |
|---|---|---|---|---|---|---|
| Train (GA saw) | 10.50 Calmar | $18,721,858 | 297.9% | 28.4% | 376 | BH wins 12× |
| **Test (HELD OUT)** | — | **$1,071** | **1.9%** | 35.6% | 165 | BH wins 4.4× |

**Train-to-test collapse: 156× CAGR degradation. Classic overfit.**

## Evolved genome

Technical: RSI 28/80, MA 7/90/137d, entry thr 0.65, base pos 71%, vol scale 1.99, stop 2%, target 100%, hold 14d, cool 0d.

Weights: trend 0.87, RSI 0.22, momo 0.93. (Unlike v1 which ignored trend at 0.13; v2 uses it.)

**News-fear (the suspect):** hack 1.00, regulation 0.30, macro 1.00, geo 1.00, memory 10d.
→ Bot learned to exit fully on hack/macro/geo events. Almost certainly memorizing Mt Gox / COVID / Terra / FTX shocks specifically. Untrained on the 2024-2026 events (Yen carry, Trump tariffs, Israel-Iran, GENIUS Act) which fire the same category triggers but not the same reaction pattern.

**Halving boost:** 349d × 1.92× post-halving. Captures 2012/2016/2020 post-halving bull cycles. Failed on 2024 halving which was pre-priced by ETFs and led to grinding chop.

## What we learned

1. **Anti-cheat pipeline works.** v1 shipped with "Sortino 10.65" as headline number. Applied to v2 with OOS split → 1.9% CAGR on unseen years. The v1 number was measurement, not skill.
2. **23 genes on 12.4yr = search space too large for the data.** GA has too many degrees of freedom to find "lucky" rules that fit noise.
3. **Categorical event genes are the most suspect.** Each per-category fear gene lets the bot memorize specific event responses. Should collapse to a single generic event-fear gene or drop entirely.
4. **Trend/momentum shift v1→v2 is real signal.** With OOS discipline forcing rules that generalize, GA moved away from v1's momentum-only strategy toward a trend-follow blend. Direction of change is trustworthy even if magnitudes overfit.

## Deployment status

**BLOCKED.** Test CAGR 1.9% at Max DD 35.6% is nowhere near ship. Owner's success criteria (MISSION.md):
- ❌ Consistency across regimes (bombed the OOS bull-and-chop period)
- ⚠ Risk discipline (35.6% test DD, close to 40% ceiling)
- ❌ Realistic edge (Calmar 0.05 on OOS)
- ❌ Robustness on independent OOS (obvious)

## Next moves — v3 hypotheses to test

1. **Reduce genome flexibility** — drop per-category fear genes, use 1 generic event_fear + 1 event_memory_days = 17 genes total
2. **K-fold or walk-forward as fitness** — instead of single train slice, fitness = mean of K folds' Calmar. Slower but robust.
3. **Add richer generalizable state** — macro (VIX, DXY, yields) via Yahoo Finance, less prone to event-specific overfitting
4. **Bootstrap OOS confidence intervals** — instead of single test period, resample 3.7yr windows within test slice → distribution of outcomes
5. **Population scaling** — POP 500 + longer run per compute mandate; more diversity might find different local optima

## Ship-gate rule going forward

**Every version must beat: OOS Calmar > 1.0 AND OOS max DD < 40% AND OOS trades ≥ 30/yr.**

If a version overfits, log it honestly. Do NOT re-tune fitness to make train numbers look better. Do NOT reduce OOS to make numbers look better.

## Artifacts

- `results/v2-best-bot.json` — genome + train+test result + generation log
- `results/v2-run.log` — full stdout
- `scripts/3-evolve-v2.ts` — the sim engine (source of truth)
- `data/events.json` — 71 curated events (blind exposure only)
