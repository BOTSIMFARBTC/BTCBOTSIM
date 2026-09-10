# Argus Lab Notebook

Every experiment logged here with intent + hypothesis + result. Purpose: audit trail against p-hacking and preserve knowledge from killed runs.

Format: newest entries at top.

## Column definitions
- **ID**: runId (e.g., v3, v4b) or exp-N for numbered experiments
- **Config**: genome size, fitness fn, key realism patches
- **Intent**: what were we trying to learn?
- **Hypothesis**: what did we predict?
- **Result**: what actually happened?
- **Ship-eligible?**: passes all 6 gates in PROTOCOL.md § Ship Gate?
- **Kept for**: reason to preserve even if killed/failed

---

## Entries

### exp-06 · v6ab (2026-09-10)
- **Config**: 17g Arm A / 19g Arm B (17 + 2 composite macro). K-fold geo-mean Calmar × soft bull-participation penalty. Realism patches: position cap $10k, gap-through stops, funding 3 bps/day, watchdog validation-divergence. Deterministic seeds 1000-1019 (A), 1100-1119 (B). Mann-Whitney U with Bonferroni.
- **Intent**: (1) test whether COMPOSITE macro (shrunk from v5's 4 to 2 genes) provides measurable benefit over no-macro baseline; (2) apply Sable's 4 realism lessons to base sim; (3) find a ship-eligible bot via bull-participation floor.
- **Hypothesis**: composite macro might rescue what v5's individual macro genes overfit. Bull floor forces bots to catch bulls.
- **Result**: **Arm A wins narrow** — mean val Calmar 0.311 vs 0.222. Mann-Whitney p=0.81, NOT significant. Best-of-A (seed 1016): **val Calmar 1.189, CAGR 18.1%, DD 15.2%, ~68 bps net edge, 42 trades**. Passes ship gates 1-4 on validation. Bull capture still 21% (below intent).
- **Ship-eligible**: Preliminary YES on gates 1-4. Gates 5 (bootstrap CI) + 6 (regime consistency) not yet tested. Fresh-seed verification in flight (seeds 2000-2019 Arm A).
- **Kept for**: current strongest ship candidate. Macro genes officially declared dead (3 attempts, 3 failures). Watchdog rule validated by 12/40 trips.
- **Artifacts**: `results/v6ab-ab-analysis.json`, `results/v6ab-run.log`, `memory/v6ab_arm_a_wins_inconclusive_2026_09_10.md`

### exp-05 · v5 (2026-09-10)
- **Config**: 21-gene (17 + 4 macro), K-fold geo-mean Calmar, 4 folds, event delay 1d, macro percentile state, slippage
- **Intent**: does macro state (VIX/DXY/^TNX/SP500 percentiles) let bot condition behavior on regime rather than blur across regimes?
- **Hypothesis**: macro-aware bot rides bulls harder in low-VIX / low-DXY / rising-SP500 conditions; better OOS CAGR than v4b
- **Result**: OOS CAGR **-3.2%** (WORSE than v4b +4.8%). Per-regime attribution shows bot captured only 20% of strong-bull days. GA learned "high VIX + high yields = exit" from 2010-22 which broke in 2023-26 Fed-hiking bull rally.
- **Ship-eligible**: ❌ fails gates 1, 3, 4 (Calmar <0, CAGR <0, edge negative)
- **Kept for**: **per-regime attribution methodology** — the diagnostic breakdown is the most valuable finding of the session. Also validates the "adding state without matching training conditions = brittle" lesson.
- **Artifacts**: `results/v5-best-bot.json`, `memory/v5_macro_overfit_2026_09_10.md`, commit `fed86a9`

### exp-04 · v4b (2026-09-10)
- **Config**: 17g, K-fold **min-Calmar** + concat DD cliff, slippage
- **Intent**: fix v4's fitness aggregation gaming (fold-0 dominance)
- **Hypothesis**: min-Calmar forces every era to be positive; OOS returns to positive
- **Result**: every fold Calmar > 5, OOS CAGR **+4.8%**, DD 21.5%. Bot became patient (44 test trades). Regime-robust but OOS Calmar 0.22 (below ship gate).
- **Ship-eligible**: ❌ fails gate 1 (Calmar < 1.0), passes 2/3/4/6, gate 5 not tested
- **Kept for**: regime-robust baseline. Second-best OOS bot; use as fallback candidate.
- **Artifacts**: `results/v4b-best-bot.json`, `memory/v4_and_v4b_kfold_2026_09_10.md`

### exp-03 · v4 (2026-09-10)
- **Config**: 17g, K-fold **mean-Calmar** + slippage
- **Intent**: force regime robustness via K-fold splitting
- **Hypothesis**: mean-Calmar rewards consistency across BTC eras
- **Result**: **FAILURE** — fold 0 (2010-17 BTC $0.07→$4700) scored Calmar 597 which dominated the mean. GA ignored folds 1/3 (<1.0 Calmar). Bot regressed to aggressive shape, OOS CAGR **-2.4%**.
- **Ship-eligible**: ❌
- **Kept for**: methodological lesson — **fitness aggregation choice IS strategy choice**. Mean-across-folds rewards moonshot-bots; min-across-folds rewards survive-all-eras bots. Also shows per-fold cliffs miss inter-fold DD compounding (concat DD 52%).
- **Artifacts**: `results/v4-best-bot.json`

### exp-02 · v3 (2026-09-10)
- **Config**: 17g (v2 minus per-category fears + halving-boost, plus 1 generic bearish-event-fear + memory), Calmar+cliff, single-slice fitness, intrabar/next-bar/split
- **Intent**: reduce genome flexibility to cut v2's overfit
- **Hypothesis**: fewer genes = harder to memorize = better OOS
- **Result**: train→test CAGR collapse cut 156× → 11×. OOS CAGR **+19.9%**, Calmar **0.68** (highest OOS Calmar of any version so far). 82 train trades / 45 test trades.
- **Ship-eligible**: ❌ fails gate 1 (Calmar 0.68 < 1.0), passes 2/3/4/6, gate 5 not tested. **CANDIDATE — closest to ship**.
- **Kept for**: current best OOS bot. Genome interpretation matters: trend-heavy (weight 0.92), patient, single fear knob.
- **Caveat**: might be lucky — no regime-robustness proof. v4b provides that at cost of raw return.
- **Artifacts**: `results/v3-best-bot.json`, `memory/v3_reduced_genome_2026_09_10.md`

### exp-01 · v2 (2026-09-10)
- **Config**: 23g (v1's 15 + 5 per-category news fears + 3 halving-boost), Calmar+cliff, first anti-cheat env (split/intrabar/next-bar/blind events)
- **Intent**: enrich world model with news + halving cycle awareness
- **Hypothesis**: more world-state → smarter bot
- **Result**: train CAGR 297.9% → **test CAGR 1.9%** (156× collapse). Severe overfit. Anti-cheat pipeline correctly exposed it.
- **Ship-eligible**: ❌
- **Kept for**: proves the pipeline works. v1's Sortino 10.65 in-sample number was measurement not skill; OOS revealed it.
- **Artifacts**: `results/v2-best-bot.json`, `memory/v2_honest_oos_overfit_2026_09_10.md`

### exp-00 · v1 (2026-09-10, Vega baseline)
- **Config**: 15g, Sortino×survival, no OOS split, all-history fitness, same-bar fills, no cost realism beyond 50 bps
- **Intent**: reproduce Vega's baseline GA
- **Result**: Sortino 10.65 (in-sample), final $20.8k (+1979%), Max DD **66.6%** (ship-blocker). Buy-hold beats by 53,700×.
- **Ship-eligible**: ❌ (no OOS = no legitimate ship signal at all)
- **Kept for**: baseline reproduction of Vega's handoff. Establishes methodology contrast (in-sample Sortino illusion vs OOS Calmar reality).
- **Artifacts**: `results/v1-best-bot.json`, `memory/v1_analysis_2026_09_10.md`
