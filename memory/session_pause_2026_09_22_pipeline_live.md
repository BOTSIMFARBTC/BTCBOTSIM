# Session 10 pause (extended) — 2026-09-22 — pipeline LIVE end-to-end

## Where things stand

The full BTC decision pipeline is **LIVE end-to-end**. No owner
unblock steps remain. The Cloudflare Worker emitter runs on cron
`5 0 * * *` UTC and writes to R2 via native binding; the FAR proxy
reads from R2 via `ARGUS_CHAMPIONS_URL`; the btc-executor-worker
picks it up on its `*/5` cron.

**Next cron fire: 00:05 UTC on 2026-09-23** — that's the first
autonomous emission. First manual emission already sitting in R2
from today's session (Alpha–Echo, all 5 bots OPEN LONG on the
2026-09-21 close bar @ Yahoo BTC-USD $86,602.91).

## Full pipeline map

    argus-emitter-worker (cron 5 0 * * *)
        └─ Yahoo BTC-USD (2y daily bars, ~500)
        └─ score last fully-closed bar with each of 5 top5 genomes
        └─ R2 binding → argus-signals/argus/champions.json
                        (public: https://pub-a820b577c4d242d38461fbf62e2c16f8.r2.dev/argus/champions.json)
                            ↓
          faractionradar worker (Vega)
            /api/access/btc-decisions
              ↳ fetch(ARGUS_CHAMPIONS_URL) → collapse-to-empty on error
                            ↓
          btc-executor-worker (Vega, cron */5 * * * *)
              ↳ if decisions[] non-empty → SHADOW_MODE opens/logs
              ↳ if empty → HOLD across the board

## What shipped

FAR repo `btc-bot-sim` branch:

- **c6363ef** — Session 10 first pass:
    - `bots-sim/scripts/28-live-emitter.mjs` (local dev emitter, Binance)
    - `.github/workflows/argus-btc-emit.yml` (later deleted)
    - SHIP_README "Live emission pipeline" section (later rewritten)

- **b6b6ca6** — Session 10 extended (this session's back-half):
    - `argus-emitter-worker/src/index.js` — Cloudflare Worker with
      cron + R2 binding + POST /dispatch (auth-gated manual trigger).
    - `argus-emitter-worker/wrangler.jsonc` — cron `5 0 * * *`,
      R2 binding to `argus-signals`.
    - Deleted `.github/workflows/argus-btc-emit.yml`.
    - Rewrote SHIP_README Live-emission section to document Worker.

BOTSIMFARBTC/BTCBOTSIM repo:

- **96621e4** — reply to Vega
- **5043ea8** — earlier session-10 memory
- (pending this commit) — EMISSION-STARTED-2026-09-22.md marker +
  this extended memory file

## Owner-side operations done this session

- Created R2 bucket `argus-signals` (public dev URL enabled).
- Deleted intermediate `argus-champions` bucket (redundant naming).
- Uploaded first `argus/champions.json` via wrangler r2 object put.
- Deployed `argus-emitter-worker` (5.38 sec upload).
- Set `DISPATCH_TOKEN` secret on the emitter worker.
- Set `ARGUS_CHAMPIONS_URL` secret on the FAR `faractionradar` worker.
- Verified `curl https://www.faractionradar.com/api/access/btc-decisions`
  returns the 5-decision payload.

No third-party auth needed — Worker owns its own R2 write via
binding. No GHA secrets required, no dashboard steps.

## Vega-facing signals

- `MESSAGE-TO-VEGA-2026-09-22-emitter-live.md` (session 10 first-pass
  reply) is now partially superseded by this session's extended work
  — bucket is `argus-signals` not `argus-champions`, primary automation
  is Worker not GHA. Follow-up reply drafted separately if needed.
- `EMISSION-STARTED-2026-09-22.md` marker landed in Argus repo — the
  downstream signal Vega asked for. She can confirm via
  `wrangler tail faractionradar-btc-executor` within 5 min of the
  first `*/5` tick after 00:05 UTC 2026-09-23.

## Kill-switch

    npx wrangler r2 object put "argus-signals/argus/champions.json" \
      --file /dev/stdin \
      --remote \
      --content-type application/json \
      <<< '{"asOf": null, "decisions": [], "note": "force-hold"}'

Propagates HOLD through the proxy within 60s (proxy revalidate window).

## Kept for reference

- Local dev emitter `bots-sim/scripts/28-live-emitter.mjs` — Binance-
  based, works from residential IPs. Useful for smoke-tests when
  editing genomes or scoring rules before letting the Worker's
  daily cron ship. Prints the same schema. Verify locally → commit
  genome/math changes → next Worker cron ships automatically.

- Binance is blocked at HTTP 403 from CF Worker IPs (data-center
  range). Yahoo Finance BTC-USD is CF-friendly. Cross-source parity
  confirmed today: Yahoo $86,602.91 vs Binance $86,620 (~2 bp diff,
  decision output identical). If Yahoo ever breaks, next fallback
  candidates are Coinbase Exchange OHLC or Kraken public OHLC.

## HEADs

- FAR btc-bot-sim: **b6b6ca6**
- BOTSIMFARBTC/BTCBOTSIM main: (this commit)

## Next session pickup

1. Confirm the 00:05 UTC 2026-09-23 cron fired successfully — check
   `wrangler tail argus-emitter-worker` or `wrangler r2 object get
   argus-signals/argus/champions.json` and verify `asOf` matches
   ~2026-09-23T00:05.
2. Start monitoring the 4-week shadow window (per SHIP_README).
   First-week metrics: portfolio equity vs BTC-hold, per-bot WR
   rolling 30, exec error rate, slippage vs sim.
3. When shadow clears, owner flips `SHADOW_MODE=false` on
   btc-executor-worker → live capital $500-$1000 first-cap.
