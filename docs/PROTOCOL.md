# Argus Simulation Protocol — locked 2026-09-10

Hard rules for how Argus runs experiments and decides what ships. Owner-approved. Only owner can override.

## 1. Three-way data split (LOCKED)

| Slice | Dates | Duration | Role |
|---|---|---|---|
| **TRAIN** | 2010-08-18 → 2022-12-31 | 12.4 yr | GA fitness computation |
| **VALIDATION** | 2023-01-01 → 2026-03-10 | 3.2 yr | Design iteration, version ranking, comparison across attempts |
| **HOLDOUT** | 2026-03-11 → 2026-09-10 | 6 mo (grows over calendar time) | Ship-decision test ONLY. Never touched during iteration. |

- **Contamination status:** VALIDATION has been used to compare v1→v5. Its statistical significance is degraded proportional to number of versions tested against it. Treat as ranking tool, not truth.
- **Holdout invariant:** No code path may read holdout dates during GA fitness eval, design decisions, or A/B testing. Only touched when a **shortlisted ship candidate** needs final validation.
- **Holdout growth:** Start-date frozen at 2026-03-11 forever. End-date advances with wall-clock (data freshness). This grows the sample size for statistical power without introducing selection bias.

## 2. Ship gate (LOCKED)

A bot version is **ship-eligible** only if ALL of these hold on HOLDOUT slice (or synthetic bootstrap of it):

1. **OOS Calmar ≥ 1.0** — return / max DD ratio
2. **OOS Max DD < 40%** — drawdown ceiling
3. **OOS CAGR ≥ 0** — no money loss over the period
4. **Net edge ≥ 20 bps per round-trip** — profit exceeds realistic friction (gas + funding + slippage per Vega's cost profile, 2026-09-10). Below this = inside the noise floor.
5. **Bootstrap 95% CI on Sortino** entirely above 0.5 — statistical significance
6. **Consistency**: positive bot return in each of {bull, chop, bear} regime buckets on validation slice

If ANY criterion fails: not ship-eligible. Continue iteration.

## 3. Kill switch — dynamic early stopping

Every GA run monitors two signals per generation:
- **best_fitness_delta_pct** = (best_gen_now - best_gen_prev_window) / best_gen_prev_window
- **pop_genome_variance** = mean pairwise Hamming/L2 distance across genome vectors

**Kill triggers (any of these):**
1. `best_fitness_delta_pct < 0.001` for `K` consecutive generations
2. `pop_genome_variance < ε` (default ε = 0.01) for `K` consecutive generations
3. Time budget exceeded (last-resort fallback)

`K` scales with genome size: `K = 50 × genome_size` (e.g., 17g → K=850 gens).

**Killed runs are PRESERVED**, not discarded:
- Write `results/killed/{runId}-killed-at-gen-{N}.json` with best genome so far + reason for kill
- Every killed run gets a row in `docs/LAB-NOTEBOOK.md`
- Owner rule: "we never know what will come handy later" → nothing gets deleted

## 4. A/B split rule — when unsure, run both

When a design decision is not obviously one-way (fitness function, genome shape, realism assumption), run BOTH arms:

- **20 seeds per arm** (bootstrap statistical power without prohibitive compute)
- **Same GA config across arms** except the one variable being tested
- **Same VALIDATION slice for evaluation** (never HOLDOUT)
- **Winner declared via Mann-Whitney U test** with p < 0.05 AFTER Bonferroni correction for number of active A/B tests in the current session
- **If tied** (p > 0.05): report inconclusive. Either merge features OR run 20 more seeds each.

## 5. Realism ratchet — monotonic increase

Realism fidelity score tracked in `docs/REALISM.md` on a 0-100 scale. Every new version must include AT LEAST one realism patch that increases the score. **Fidelity may never decrease.**

Current patch history:
- v1: baseline, 0 realism patches (in-sample fitness, same-bar fills, no cost model beyond flat 50 bps)
- v2: +intrabar stops, +next-bar-open fills, +train/test split, +blind event exposure → fidelity ~50/100
- v3: no new realism (structure change only)
- v4: +stochastic slippage (5 + 200·max(0, vol20−0.02) bps) → fidelity ~65/100
- v4b: no new realism (aggregation fix)
- v5: +event visibility 1-day delay, +percentile-normalized macro state (regime-relative) → fidelity ~72/100

Remaining gaps to patch (roadmap):
- Funding rates on perp positions (~-0.01% per 8h avg, ±0.1% extreme) — LOW IMPACT for daily bot, MEDIUM for hourly
- Order-book impact / liquidity (needs volume data)
- Multi-venue execution + fill dispersion
- Fat-tail slippage 1-in-100 events (20-50 bps around news)
- Weekend / low-liquidity hour de-rating
- Real BTC gap risk (partial via intrabar; full requires tick data)

## 6. p-hacking guards

Multiple-comparison hazards escalate with iteration count. Guards:

1. **Locked HOLDOUT** (§1) — final validator, never seen during iteration.
2. **Bonferroni correction** on any claimed p-value: divide by number of versions tested in the current session.
3. **Fresh-seed re-test rule**: any top-2 candidate must be re-validated with 20 FRESH seeds not seen during original evolution. Purpose: confirm the winning genome isn't luck from a specific random-seed path.
4. **LAB-NOTEBOOK.md log**: every run recorded with intent + hypothesis + result. Enables audit: "Was this 'winner' the first thing tried, or the 47th?"

## 7. Compute mandate + when to STOP running

**More sims are always better UNLESS:**
- The GA has provably converged (kill switch triggered) — running longer wastes cycles
- The extra runs are being used to select on VALIDATION (contamination) rather than to reduce variance on a candidate
- The extra runs test a hypothesis with no clear falsification path (wandering)

**Rule of thumb:** if you can't state, in one sentence BEFORE the run, what would make you kill or ship the candidate, don't run it. Log the question, think first.

## 8. Cross-AI coordination

Argus is isolated from other AIs (Vega, Sable, Rook, Knox) per FAR playbook. All communication via owner using `message begin/end` markers.

Argus's GitHub: `BOTSIMFARBTC/BTCBOTSIM` (see memory/reference_argus_github_permanent.md). Never push Argus work to any other remote.

## 9. Amendments

This protocol document is edited only when the owner explicitly authorizes a change. Argus can propose amendments in a memo but does not self-edit rules.

Last locked: 2026-09-10 by owner + Argus.
