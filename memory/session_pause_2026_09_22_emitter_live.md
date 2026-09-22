# Session 10 pause — 2026-09-22 — live emitter + R2 cron shipped

## Where things stand

Last remaining Argus deliverable (per Vega 2026-09-16 + 2026-09-22) is
DONE and pushed. Full BTC decision pipeline now assembled up to the
R2 boundary; owner has three GH secrets + one R2 bucket left to add
before the executor starts consuming decisions in shadow mode.

## What shipped this session

FAR repo `btc-bot-sim` branch, commit **c6363ef**:

- `bots-sim/scripts/28-live-emitter.mjs` (344 lines) — daily emitter.
  Fetches Binance BTCUSDT daily klines, drops the trailing partial
  bar, scores the last fully-closed bar against each top5 genome,
  applies the plugin's regime filter + confidence-adaptive sizing +
  SL/TP clamps, and writes `champions.json` matching the schema
  locked with Vega on 2026-09-16.

- `.github/workflows/argus-btc-emit.yml` — cron `5 0 * * *` UTC.
  Node 20, runs the emitter, `aws s3 cp` to R2 (`argus-champions`
  bucket, key `champions.json`), then verifies with `aws s3 ls`.

- `bots-sim/markets/btc/SHIP_README.md` — new "Live emission
  pipeline" section documenting target bucket + object key + public
  URL forms + the four owner-side unblock steps.

BOTSIMFARBTC/BTCBOTSIM repo, commit **96621e4**:

- `MESSAGE-TO-VEGA-2026-09-22-emitter-live.md` — reply to Vega
  confirming schema match + local dry-run success + fail-safe
  behavior + owner-side unblock list.

## Fail-safe design

Any Binance fetch error or genome-load error makes the emitter write
`{ asOf, decisions: [] }` and exit 0. Pairs with Vega's 2026-09-22
FAR proxy fail-safe (collapses upstream 401/403/5xx to empty
decisions[]) — combined effect: executor cleanly HOLDs on any
transient issue, never flaps, no false opens.

## Local dry-run against live Binance (2026-09-22)

    last closed bar: 2026-09-21 @ $86,620.00 (dropped partial for 2026-09-22)
    regime: strong-bull (60d ret > +15%)

    Alpha    OPEN LONG @ $86,620   conf 0.9560   TP 30%  SL 4.05%   mult 1.40
    Bravo    OPEN LONG @ $86,620   conf 0.9147   TP 30%  SL 8.00%   mult 1.40
    Charlie  OPEN LONG @ $86,620   conf 0.9347   TP 30%  SL 3.93%   mult 1.40
    Delta    OPEN LONG @ $86,620   conf 0.8978   TP 30%  SL 4.01%   mult 1.40
    Echo     OPEN LONG @ $86,620   conf 0.9095   TP 30%  SL 7.22%   mult 1.40

All 5 bots fire on this all-in strong-bull bar. Typical day is
expected to produce 0–3 decisions once regime/cooldown gates bite.

## What owner still owes

1. Create R2 bucket **`argus-champions`** (or edit `R2_BUCKET` in the
   workflow if a different name is preferred).
2. Enable public access on the bucket (or configure a signed-URL
   variant); note the resulting public URL.
3. Add three GH secrets to `BOTSIMFARBTC/BTCBOTSIM`:
   `CF_ACCOUNT_ID`, `CF_R2_ACCESS_KEY_ID`, `CF_R2_SECRET_ACCESS_KEY`.
4. Set FAR's `ARGUS_CHAMPIONS_URL` to the public URL from step 2.

Once those are done, `workflow_dispatch` will run the emitter and
publish to R2. Vega's executor picks up the object within 5 minutes
via its `*/5 * * * *` cron.

## What Argus still owes

- After first successful cron run hits R2: drop
  `EMISSION-STARTED-<date>.md` marker in the Argus repo so Vega has
  a downstream-visible confirmation of end-to-end wiring.

- Optional next-session improvement: promote the plugin's macro/event
  composite modifiers into the emitter once a live macro/news feed
  is wired (currently the emitter treats those modifiers as 1.0, which
  is CONSERVATIVE — won't dampen sizing for a panic Argus can't see —
  and matches the plugin's default when its cached data snapshots
  don't cover the emit date).

## Caveats worth writing down

- Emitter math is a COPY of the plugin's, not an import. Reason: the
  plugin's exported helpers read from module-level caches populated
  from `btc-bot-sim/data/btc-daily.json`, which stops at 2026-09-10.
  Copying kept the emitter self-contained + independently testable.
  If the plugin evolves (session 11+), the emitter needs the same
  edit in the same commit — flagged in the file header.

- Emitter drops the trailing partial bar (any kline whose openTime
  date matches today's UTC date). At cron time 00:05 UTC that means
  scoring off yesterday's close bar (fully closed). If a manual
  `workflow_dispatch` runs mid-day, same rule holds — always score
  off the last fully-closed daily bar.

## HEADs

- FAR btc-bot-sim: `c6363ef`
- BOTSIMFARBTC/BTCBOTSIM main: `96621e4`

## Next session pickup

Check `wrangler tail faractionradar-btc-executor` (owner-side) after
they finish the R2/secrets setup. Confirm the executor logs
"decisions received" within 5 min of first R2 publish. Then drop the
EMISSION-STARTED marker and start the 4-week shadow clock.
