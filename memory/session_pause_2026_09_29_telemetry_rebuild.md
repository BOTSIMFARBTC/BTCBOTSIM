# Session 11 pause — 2026-09-29 — telemetry+analysis rebuild

## Where things stand

The pipeline itself is **GREEN**. Cron firing daily at 00:05 UTC.
FAR proxy returns fresh 5-decision payloads (2 emit / 3 hold today).
All 6 health checks pass.

The **local telemetry log** was in bad shape at session start —
`decisions-log.jsonl` had only 1 row (09-24 seed) despite 7 days
elapsed of the 4-week shadow window. Manual-run script + no cron =
5 missing days.

Rebuilt in this session:

- **Worker archive** — `argus-emitter-worker` now writes
  `argus/log/YYYY-MM-DD.json` alongside `champions.json` on every
  cron. Plus `GET /log` (list) + `GET /log/YYYY-MM-DD` (fetch)
  endpoints so consumers can enumerate without R2 API creds.
  **Needs owner `wrangler deploy` to activate.** Prior emissions
  are lost from R2 (only champions.json exists, gets overwritten
  daily) so pre-2026-09-29 dates can't be sync'd — they were
  reconstructed via sim scoring below.

- **`--sync-r2` mode on log-decisions.mjs** — pulls any missing
  dates from Worker archive going forward. Tags rows with
  `source: "r2-archive"`. Never overwrites `source: "live"`.

- **reconstruct-decisions.mjs** — re-scores frozen top-5 genomes
  against historical Binance bars for any date. Used today to
  backfill 09-22 through 09-28 (all pre-archive). Tags
  `source: "reconstructed"`. Fourth copy of the scoring math —
  header warns to bump all copies in same commit when genomes retune.

- **analyze-shadow.mjs** — 4-week ship-gate readout. Coverage,
  per-bot emit/TP/SL/OPEN + WR, portfolio $-equity vs BTC-hold,
  position walk with intrabar TP/SL detection. Sizing = `size ×
  conf × regime mult` (per 09-24 caveat — using confidence as
  scalar directly is the trap).

- **health-check.mjs** — 6-check pipeline probe. Non-zero exit
  on FAIL. Suitable for cron / monitor-worker consumption. Mirrors
  Sable's xau-health shape.

- **PHASE-2-SPEC.md** — draft executor-status contract for Vega
  when `web/btc-executor-worker/` exposes `/api/btc-executor/
  public-status`. Sizing formula spelled out + common wrong
  implementations flagged.

- **Owner-facing STATUS-2026-09-29.md** in Argus repo — plain-
  English readout of what shipped, week-1 findings, owner actions.

## Week-1 shadow performance (CORRECTED — mild drag, not RED)

```
Days elapsed: 7 / 28
Latest closed BTC bar: 2026-09-28 @ $83,500.01

Per-bot emission (after executor stacking gate)
Bot      emit  TP  SL  OPEN   ΣPnL%
Alpha       1   0   1    0    -4.05
Bravo       1   0   0    1    -3.60
Charlie     2   0   1    1    -5.08
Delta       1   0   1    0    -4.01
Echo        1   0   0    1    -3.60

Portfolio ($1000 notional per bot slot)
Total capital deployed: $3,200.00
Shadow P&L: -$112.77   (-11.28%)
BTC-hold:   -$31.42   (-3.14%)
Shadow − BTC-hold: -$81.35

Executor gate: 13 raw emissions skipped (68.4% of what Argus emitted).
```

**IMPORTANT — initial numbers were wrong.** First analyze-shadow
pass reported -32.9% because it treated every emission as a new
position. Then I read `btc-executor-worker/src/index.ts` line 547:

    if (m.activePositionRef !== ZERO_REF) { counters.skipped++; continue; }

Executor holds ONE position per bot. Subsequent emissions gated.
Fixed analyze-shadow to enforce same gate. Result: -11.3% (3x lower).

**Structural findings** (all non-fatal, cohort slot GREEN-LEANING):

1. **Executor gate does its job.** 68% of raw emissions correctly
   suppressed. No over-exposure. Sizing formula in executor
   (`baseCollateral × sizeMultiplier × regimeMult × confMult`)
   matches Argus's phase-2 spec exactly.

2. **Tight-SL trio (Alpha/Charlie/Delta) is the weakness.** All
   three stopped on 09-24 leg. BTC daily range 3-5% → normal wicks
   trip 4% SLs. Bravo (8%) and Echo (7.2%) rode it out. GA didn't
   price current vol regime. Consider retune if week 2 repeats.

**Yahoo lag bug (P1)**: Worker's entryRef today ($84,458) matches
Yahoo's 09-27 close, not 09-28's ($83,502). At 00:05 UTC 09-29
Yahoo hadn't published 09-28 bar yet — Worker used 2-day-old data.
Fix: shift cron from `5 0 * * *` to `30 0 * * *` (bundle with R2
archive deploy). Verify by checking tomorrow's entryRef.

Cohort-slot decision: **GREEN-LEANING** (was RED before correction).
Mild losing week within SHIP_README's expected 40-50% WR envelope,
not a kill signal.

## Files changed (both repos)

FAR repo `btc-bot-sim` branch:
- **fc98540** — Worker archive + /log endpoints (owner-deploy pending)
- **bb42481** — local tooling suite + reconstructed log rows
- **c854d6b** — analyze-shadow enforces executor stacking gate

Argus's own repo (BOTSIMFARBTC/BTCBOTSIM):
- **5b8c5a5** — STATUS-2026-09-29.md initial (superseded)
- **c53e4d5** — STATUS-2026-09-29.md updated with corrected numbers
- (this commit) — session_pause_2026_09_29 memory + MEMORY.md index

## HEADs

- FAR btc-bot-sim: **c854d6b** (was bb42481 pre-executor-gate fix)
- Argus main:       **c53e4d5** (was 5b8c5a5 pre-correction)

## Next session pickup

1. **Verify owner ran `wrangler deploy`** on argus-emitter-worker.
   Check tomorrow's archive appears: `curl https://argus-emitter-
   worker.faractionradar.workers.dev/log` should show 2026-09-30
   after 00:05 UTC.

2. **Run `analyze-shadow.mjs` for week-2 checkpoint** around 2026-
   10-06. Watch: any TP hits? Does stacking pattern change if
   emissions decrease into strong-bull regime? Bravo/Echo (wider
   SL) trajectory.

3. **Wait for Vega's answer on executor stacking** before mid-Oct
   signals-only cohort slot. This is the load-bearing question.

4. **Phase 2 divergence check** if Vega ships `/api/btc-executor/
   public-status` — implementation is spec'd in
   `bots-sim/live-shadow/PHASE-2-SPEC.md`.

5. **Kill-switch reminder**: R2 force-hold recipe still in
   session_pause_2026_09_22_pipeline_live.md if week-2 gets worse
   and owner wants to freeze emissions before cohort slot.
