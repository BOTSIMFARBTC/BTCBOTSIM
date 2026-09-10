---
name: v6 A/B split — Arm A (no macro) wins marginally, macro genes confirmed dead 2026-09-10
description: 20 seeds × 2 arms × 2 min. Arm A mean val Calmar 0.311, Arm B 0.222. Mann-Whitney p=0.81 (not significant). But Arm A produced best individual bot (seed 1016, Calmar 1.189, CAGR 18.1%, DD 15.2%) which passes ship gates 1-4. Macro shrunk from 4 genes (v5) to 2 (v6-B) still no measurable benefit. Time to stop trying macro in this genome family.
type: project
---

# v6 A/B — Arm A wins by nose, macro finally declared dead

## Setup
- 20 seeds per arm, 2 min per seed, 4 realism patches (position cap $10k, gap-through stops, funding 3 bps/day, watchdog validation-divergence)
- Bull-participation SOFT penalty: fitness = geo_mean × min(1, min_capture / 0.30) — smoke test showed hard cliff killed selection pressure
- Arm A: 17g (no macro), Arm B: 19g (17 + 2 composite macro: worst-of-VIX/DXY/^TNX fear + SP500-up-and-VIX-suppressed boost)

## Results

| Arm | n | Mean val Calmar | Median | Best | Worst | Watchdog trips |
|---|---|---|---|---|---|---|
| **A (no macro)** | 20 | **0.311** | 0.236 | **1.189** (seed 1016) | −0.276 | 5/20 |
| **B (composite macro)** | 20 | 0.222 | 0.189 | 0.903 (seed 1111) | −0.209 | 7/20 |

**Mann-Whitney U = 191, z = −0.24, p = 0.81** → NOT statistically significant.

## Interpretation

- Arm A better on all central-tendency measures (mean, median, max) — but distributions overlap heavily. Could be signal, could be noise.
- **Macro genes officially declared dead weight** across v2 (per-category), v5 (4-gene individual), v6-B (2-gene composite). Three swings at macro-conditioning, three misses. Stop.
- Watchdog trips (5+7 = 12/40) demonstrate the divergence-detection saved compute AND prevented overfit-through-time on ~30% of seeds. Real win from Sable's lesson.

## Best-of-A (seed 1016) — SHIP CANDIDATE

Validation-slice performance:
- **Calmar 1.189** ✓ passes gate 1 (≥1.0)
- **Max DD 15.2%** ✓ passes gate 2 (<40%)
- **CAGR +18.1%** ✓ passes gate 3 (≥0)
- 42 trades over 3.2yr ≈ 21 round-trips. Total return $710/21 = $34/trip. On avg $5k notional = **~68 bps net edge** ✓ passes gate 4 (≥20 bps)
- Bull capture 21% — below intent (30% floor). Bot still under-participates in bulls even with soft push.

## Gene shape of best-of-A (from results/v6ab-ab-analysis.json)

Need to read genome + decoded params. TODO after run finishes; add here.

## What v6 confirmed structurally

1. **17-gene shape (v3-lineage) is the right family.** Trend-heavy, low-frequency, patient. Convergent across v3, v4b, v6-A. This is our production DNA.
2. **Macro is a dead branch.** Three attempts (4-gene, 5-gene, 2-gene composite). Give up.
3. **Watchdog worth its cost.** 30% of seeds trip. Prevents overfit-through-time.
4. **Position cap changed the bot's shape.** Prior versions compounded to $18M+ during training which was fantasy. With MAX_POSITION_USD = $10k, bots evolve strategies that work at retail scale.
5. **Funding rate + gap-through don't destroy the edge.** Bot still finds Calmar > 1.0 with realistic frictions.

## Ship-eligibility status

**Passes gates 1, 2, 3, 4 on VALIDATION slice.**
**Gates 5 (bootstrap Sortino CI) and 6 (regime consistency) not yet tested.**

Per PROTOCOL.md p-hacking guard: currently running fresh-seed verification (seeds 2000-2019 Arm A) to confirm best-of-A isn't cherry-picked. If verified, next step is HOLDOUT test (2026-03-11 → today).

## Concerns to address before shipping

1. **Bull capture 21% is low.** Bot might miss the next bull cycle even if it survives bears.
2. **VALIDATION was contaminated** by v1-v5 iteration. True test is HOLDOUT (locked 6mo).
3. **Small trade count.** 42 trades on VAL slice. Bootstrap CI required for statistical confidence.

## Artifacts

- `results/v6ab-ab-analysis.json` — full 40-seed distribution
- `results/v6ab-run.log` — evolution logs
- `scripts/9-evolve-v6-ab.ts` — v6 source
- `results/v6ab-verify-*` — fresh-seed verification (in progress at time of write)
