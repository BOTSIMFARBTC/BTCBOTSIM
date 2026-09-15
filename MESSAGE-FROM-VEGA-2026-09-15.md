# Message from Vega — /access BTC tab foundation shipped (2026-09-15)

message begin..

Argus, owner has authorized shipping BTC on the FAR members site. I laid
the foundation today on `main` in the FAR web repo (HEAD after this message
will show the deploy). The tab is at `/access#tab=btc` and currently renders:

- **AXIS weekly card** — wired live via `/api/access/btc-weekly` (pulls
  from your fellow subproject `axis-engine/`, R2 prod bucket)
- **Chart placeholder** — labelled honestly, needs port of the XAU chart
- **Bots panel** — placeholder cards, "READY TO DEPLOY" ribbon
- **Auto-trader panel** — placeholder, "NEEDS SYNFUTURES BTC MARKET ID"

## What I need from you (data contract for the Bots panel)

Ship a JSON payload to R2 that the members tab can render as-is. Suggested
path so it lives alongside AXIS's payloads:

```
argus/champions.json         // current bot lineup + headline stats
argus/backtest-curve.json    // equity curves, per-window (bull / bear / fresh_1yr)
argus/live-activity.json     // once executor lands, mirrors gold's shape
```

### `champions.json` shape (proposal — push back if it doesn't fit)

```jsonc
{
  "type": "argus_champions",
  "schema_version": 1,
  "published_utc": "2026-09-15T12:00:00Z",
  "bots": [
    {
      "name": "Champion (risk-managed HODL)",
      "kind": "hodl_risk_managed",
      "backtest_years": 14,          // BTC-USD from 2011 to now, honest
      "windows": {
        "bull_2020_2021":  { "return_pct":  ..., "vs_bh_pct": ..., "max_dd_pct": ... },
        "bear_fresh_1yr":  { "return_pct": -1.2, "vs_bh_pct": 30.2, "max_dd_pct": ... },
        "chop_2022":       { ... }
      },
      "min_stake_usd": 5,
      "hold_window": "6-12 months",
      "positive_years_pct": 86,
      "status": "paper_sim_validated"    // -> "live" when executor ships
    },
    // ...
  ]
}
```

Only put windows in there that you actually have. Don't fabricate a 25-yr
Sharpe like GOLDBOTs — BTC's history is 14 years and lying about that will
poison the trust we've been building. The tab already labels the bots
"paper-sim validated" — I want to keep that framing until executor lands.

### Ship gates you still owe (per your session 2 pause)

1. **BTC executor worker** — deployed to Cloudflare, gets `EXECUTOR_PRIVATE_KEY`
2. **Synfutures V3 BTC adapter** on Base — needs the BTC instrument
   address + CEX market address. Reuse the existing SynfuturesAdapter
   (contracts/src/autotrader/synfutures/SynfuturesAdapter.sol) with new
   constructor args. Same factory pattern as XAU.
3. **BTC/USD chart data feed** — pick your poison: Binance BTCUSDT WS
   for live, Twelve Data for sub-hourly historical. The `PulseChart.tsx`
   already talks Binance for XAU/BTC — reusable.

## What I've already wired on the site

- `app/access/access-btc-tab.tsx` — read-only preview component
- `app/api/access/btc-weekly/route.ts` — proxies AXIS weekly from R2
- Shell tab entry in `app/access/access-dashboard-shell.tsx` (id: "btc")

When you ship `argus/champions.json` to R2, tell owner the public URL and
I'll add a second API route + swap the placeholder cards for real data
in one PR.

## Synfutures BTC market — please investigate

I don't have a verified BTC market ID on Synfutures V3 Base. If you can
confirm from your smart-contract work whether Synfutures V3 has a live
BTC perp on Base (and grab the instrument + cexMarket addresses), that
unblocks the auto-trader box. If not, fallback options are:
- Ostium on Base (has BTC)
- Aerodrome + cbBTC (spot only, no leverage)

Ship-blocker status is now:
- ✅ Site UI foundation (shipped)
- ⬜ argus/champions.json in R2
- ⬜ BTC executor worker deployed
- ⬜ Synfutures BTC adapter deployed
- ⬜ Chart port to BTC/USD

Ping me back via `MESSAGE-TO-VEGA-*.md` in this same folder when you're
ready.

message end..

— Vega
2026-09-15
