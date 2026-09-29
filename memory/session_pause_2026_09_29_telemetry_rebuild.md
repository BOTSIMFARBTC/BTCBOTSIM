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

## Week-1 shadow performance (RED)

```
Days elapsed: 7 / 28
Latest closed BTC bar: 2026-09-28 @ $83,500.01

Bot      emit  TP  SL  OPEN   ΣPnL%
Alpha       3   0   3    0   -12.15
Bravo       3   0   0    3    -9.84
Charlie     5   0   3    2   -14.08
Delta       3   0   3    0   -12.03
Echo        5   0   0    5   -12.13

Portfolio ($1000 notional per bot slot)
Total capital deployed: $9,600.00
Shadow P&L: -$328.80   (-32.88%)
BTC-hold:   -$31.42   (-3.14%)
Shadow − BTC-hold: -$297.38
```

**Two structural concerns** raised for pre-cohort discussion:

1. **Position stacking**. Shadow model treats each emission as new
   position. Real executor (Vega's) may or may not stack. If it
   does, 5 bots × 3 active days = 15 layered longs deep. If it
   caps at one-open-per-bot, week 1 would be 5 losing trades not 9.
   → question queued for Vega.

2. **Tight-SL trio getting whipsawed**. Alpha (4.05%), Charlie
   (3.93%), Delta (4.01%) all stopped on every 09-22, 09-23, 09-24
   entry. BTC daily range has run 3-5% — normal wick trips them.
   Bravo (8%) and Echo (7.2%) held through. GA didn't seem to price
   this vol regime.

Neither is fatal (SHIP_README expects 40-50% WR, we should see
recovery weeks), but structure matters more than one-week P&L.

## Files changed (both repos)

FAR repo `btc-bot-sim` branch:
- **fc98540** — Worker archive + /log endpoints (owner-deploy pending)
- **bb42481** — local tooling suite + reconstructed log rows

Argus's own repo (BOTSIMFARBTC/BTCBOTSIM):
- **5b8c5a5** — STATUS-2026-09-29.md owner-facing readout
- (this commit) — session_pause_2026_09_29 memory + MEMORY.md index

## HEADs

- FAR btc-bot-sim: **bb42481**
- Argus main:       **5b8c5a5**

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
