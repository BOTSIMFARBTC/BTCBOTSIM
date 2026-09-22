# Emission started — 2026-09-22

Argus's BTC decision pipeline is now live from R2 through FAR's proxy.

## End-to-end confirmation

- **Bucket:** `argus-signals` (Cloudflare R2, public dev URL enabled)
- **Object key:** `argus/champions.json`
- **Public URL:** `https://pub-a820b577c4d242d38461fbf62e2c16f8.r2.dev/argus/champions.json`
- **FAR proxy:** `https://www.faractionradar.com/api/access/btc-decisions` reads it via `ARGUS_CHAMPIONS_URL` env var (set on the `faractionradar` worker).
- **Emitter:** Cloudflare Worker **`argus-emitter-worker`** at
  `https://argus-emitter-worker.faractionradar.workers.dev`.
  Cron trigger: `5 0 * * *` UTC (five minutes after Binance daily-kline close).
  R2 binding writes directly to `argus-signals/argus/champions.json`.

## First non-empty emission (2026-09-22 08:56 UTC)

Manual dispatch via `POST /dispatch` (auth: `x-argus-dispatch-token`)
produced 5 valid decisions on the last fully-closed bar:

    last closed bar: 2026-09-21 @ $86,602.91 (Yahoo BTC-USD)
    regime: strong-bull (60d ret > +15%)

    Alpha    OPEN LONG @ $86,603   conf 0.9561  TP 30%  SL 4.05%  mult 1.40
    Bravo    OPEN LONG @ $86,603   conf 0.9149  TP 30%  SL 8.00%  mult 1.40
    Charlie  OPEN LONG @ $86,603   conf 0.9350  TP 30%  SL 3.93%  mult 1.40
    Delta    OPEN LONG @ $86,603   conf 0.8981  TP 30%  SL 4.01%  mult 1.40
    Echo     OPEN LONG @ $86,603   conf 0.9099  TP 30%  SL 7.22%  mult 1.40

Verified `curl https://www.faractionradar.com/api/access/btc-decisions`
returns the same payload — proxy is reading R2 successfully.

## Data source note

The Worker fetches Yahoo Finance BTC-USD daily bars (range=2y, ~500
bars — deepest genome needs ma_trend_period up to 300). Binance is
blocked at HTTP 403 from CF Worker IPs, so Yahoo is the CF-friendly
primary. The local emitter script (`bots-sim/scripts/28-live-emitter.mjs`)
still uses Binance for developer smoke-tests where CF IP blocking
doesn't apply.

Cross-source price parity confirmed at emit time: Binance $86,620 vs
Yahoo $86,602.91 — $17 diff (~2 bp), within normal cross-exchange
variance. Decision output (regime, side, conf ranking) identical.

## Automation

No GitHub Actions, no third-party R2 API tokens. The Worker's own R2
binding writes directly to the bucket. Owner does not need to add
`CF_ACCOUNT_ID` / `CF_R2_*` GH secrets — the plumbing is CF-native
end to end.

Cron will next fire at **00:05 UTC on 2026-09-23**.

## Kill-switch

If Argus needs to force the executor into HOLD-across-the-board:

    npx wrangler r2 object put "argus-signals/argus/champions.json" \
      --file /dev/stdin \
      --remote \
      --content-type application/json \
      <<< '{"asOf": null, "decisions": [], "note": "force-hold"}'

The FAR proxy propagates the empty decisions[] within its 60s revalidate
window, executor no-ops on the next `*/5` tick.

— Argus
2026-09-22
