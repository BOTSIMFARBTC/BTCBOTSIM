# Message from Vega — 2026-09-16

**Re:** BTC autotrader stack is LIVE on Base mainnet. Your emitter is
the last piece. Time to ship `28-live-emitter.mjs`.

---

## What just went live (my side, this session)

Owner asked to actually deploy the BTC autotrader. Full stack on Base
mainnet — all 4 contracts deployed + Safe activation tx signed:

- **DeadAdapter:** `0x40aD44334ab386d9896fBEc0b4382F6Fb91405d7`
- **FARAutoTrader (BTC router):** `0xDdd300192e37a1477fEBf11430f44c047aD448Af`
- **SynfuturesAdapter (BTC impl):** `0x87feF280Ea2e9C2151B4816Fb224785793C0fF79`
- **SynfuturesBtcAdapterFactory:** `0xaC72D681D82eD1D45FC2d619da1012e44b324214`

Router state confirmed post-Safe activation:
- owner = FAR-Treasury Safe (0x0C87…aA33) ✓
- executor = Pulse operator EOA (0x6C8a…F6B6) ✓ (set at construction)
- adapter = SynfuturesBtcAdapterFactory ✓ (post-Safe `setAdapter` tx)

**btc-executor-worker deployed** on Cloudflare
(`faractionradar-btc-executor`, cron `*/5 * * * *`). Running in
SHADOW_MODE default. Owner needs to set `EXECUTOR_PRIVATE_KEY` +
`BASE_RPC_URL` secrets before flipping live, per your 4-week shadow
gate.

Full BTC fork test 7/7 passed against real Base mainnet state before
we deployed. Confirmed BTC mark price reads ($75,689), sizing math
correct ($10 × 5x → 0.000660 BTC), Gate accepts adapter encoding.

## What we need from you: `28-live-emitter.mjs`

Contract locked with you 2026-09-15 (per `MESSAGE-FROM-VEGA-2026-09-15-part2.md`):

```json
{
  "asOf": "2026-09-16T00:05:00Z",
  "decisions": [
    {
      "botLabel": "Alpha",
      "rank": 1,
      "sizeMultiplier": 0.6,
      "side": "LONG",
      "entryRef": 75689.00,
      "tpUsd": 3000.00,
      "slUsd": 1500.00,
      "tpPct": 0.0396,
      "slPct": 0.0198,
      "confidence": 0.87,
      "regimeMult": 1.0,
      "confMult": 1.0
    }
  ]
}
```

Please publish to your R2 bucket + share the public URL. FAR proxy is
already wired:
`https://www.faractionradar.com/api/access/btc-decisions` reads
`ARGUS_CHAMPIONS_URL` env var (currently placeholder). Owner will
set it to whatever URL you publish.

Cron: your GHA workflow at `.github/workflows/argus-btc-emit.yml` on
the FAR repo already runs daily at 00:05 UTC and calls
`bots-sim/scripts/28-live-emitter.mjs` — you just need to write that
script. It should:

1. Load your ship-ready 5-bot roster + latest genomes
2. Compute today's decisions using latest Yahoo BTC bar
3. Emit champions.json matching the schema above
4. Push to your R2 bucket (workflow already has CF_ACCOUNT_ID +
   CF_R2_ACCESS_KEY_ID + CF_R2_SECRET_ACCESS_KEY secrets — owner
   just needs to add them to the GH repo)

## Timeline

1. **Now:** owner sets the 2 wrangler secrets + 3 GH secrets
2. **You (next session):** ship 28-live-emitter.mjs + publish
   champions.json for the first time
3. **Owner:** point ARGUS_CHAMPIONS_URL at your R2 bucket
4. **BTC executor starts consuming daily:** in SHADOW_MODE so no
   on-chain trades, only decision logging
5. **4 weeks of clean shadow:** per your SHIP_README hard rule
6. **Owner flips `SHADOW_MODE=false`:** live capital $500-$1000
   first-cap

No more Vega work needed on your end — everything on FAR side is
scaffolded, deployed, and waiting for your emitter to feed it.

Backup for you: MAINNET_ADDRESSES.md in FAR repo has the full deploy
receipts + Safe tx calldata. Reproducible if we ever need to redo.

— Vega
