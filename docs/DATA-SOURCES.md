# Data sources — free only

All the data Argus needs is available for free. If a source charges money, drop it and find an alternative.

## Price data

### Historical BTC daily (already collected in `data/btc-daily.json`)
- **blockchain.info** — `/charts/market-price?timespan=all&format=json` — 2010-08-18+
- **Binance** — `/api/v3/klines?symbol=BTCUSDT&interval=1d` — 2017-08+ (real OHLC)
- **Coinbase** — `/products/BTC-USD/candles?granularity=86400` — 2015+ (independent OOS)

### Live BTC (for future production integration)
- **Binance** — `/api/v3/ticker/price?symbol=BTCUSDT` — free, no auth
- **CoinGecko** — `/simple/price?ids=bitcoin&vs_currencies=usd` — free, rate-limited

## Macro data

### Free & reliable
- **Yahoo Finance** — `/v8/finance/chart/{SYMBOL}?interval=1d&range=15y`
  - Send browser UA header (Yahoo blocks bare fetches)
  - Symbols: `DX-Y.NYB` (DXY), `^TNX` (US10Y yield), `GC=F` (gold), `^GSPC` (SP500), `^VIX`

### FRED (Federal Reserve Economic Data)
- **Endpoint:** `https://api.stlouisfed.org/fred/series/observations`
- Requires FREE API key (register at https://fred.stlouisfed.org)
- Series worth pulling:
  - `FEDFUNDS` — effective Fed funds rate
  - `DFII10` — 10Y TIPS yield (real yield)
  - `CPIAUCSL` — CPI
  - `UNRATE` — unemployment
  - `DEXUSEU` — EUR/USD
- Argus should get a FRED key from owner if not already provisioned

## News event timeline (Argus builds this)

### Wikipedia timelines (scrape via public API)
- **`en.wikipedia.org/wiki/History_of_bitcoin`** — chronological history with dates
- **`en.wikipedia.org/wiki/Cryptocurrency_regulation`** — regulatory milestones by country
- **`en.wikipedia.org/wiki/Bitcoin_scalability_problem`** — protocol upgrade history
- Wikipedia API: `https://en.wikipedia.org/w/api.php?action=parse&page={PAGE}&format=json`

### GDELT (Global Database of Events, Language, and Tone)
- **Endpoint:** `https://api.gdeltproject.org/api/v2/doc/doc`
- Free, no auth, structured global event data
- Query with `query=bitcoin` or `query=cryptocurrency` filtered by date
- Rate limits are lenient

### CoinGecko news
- **`/news`** endpoint has crypto news
- Free tier is fine for historical periodic pulls

### Manual curation (small file, high signal)
Argus should curate a `data/events.json` of ~100 major events by hand or from Wikipedia scrape:

Major hacks: Mt Gox (Feb 2014), Bitfinex (Aug 2016), Coincheck (Jan 2018), Binance (May 2019), FTX (Nov 2022)

Regulatory milestones: China ban (Sep 2017, May 2021), SEC Bitcoin ETF approval (Jan 2024), MiCA in EU (2023)

Protocol events: Halvings (Nov 2012, Jul 2016, May 2020, Apr 2024), SegWit (Aug 2017), Taproot (Nov 2021)

Macro shocks: COVID crash (Mar 2020), Terra Luna collapse (May 2022), FTX bankruptcy (Nov 2022), Fed pivots

Geopolitical: Russia-Ukraine war (Feb 2022), Israel-Iran escalation (Oct 2023, Apr 2024)

## On-chain data

Argus doesn't NEED live on-chain data for the sim (historical data is enough) but might want to reference:

- **mempool.space** — free BTC blockchain data
- **blockchain.info** — market cap, hash rate, difficulty adjustment
- **BitInfoCharts** — mining stats, address distribution

For Phase 2 (production deployment) on-chain data matters more. For Phase 1 sim, historical events file is enough.

## Rate limits reminder

None of the free sources will rate-limit at Argus's expected volume (~daily fetches for state building, not per-tick queries). If Argus writes an event-collection script that hammers Wikipedia, add 100ms sleep between requests.

## What's NOT free (do not use)

- Bloomberg, Reuters news feeds — paid
- Kaiko, Coinmetrics, Glassnode, CryptoQuant, IntoTheBlock, Nansen — paid tiers past free limits
- Twitter/X API — paid since 2023
- Refinitiv, Factset — paid

If Argus finds herself wanting paid data, flag to owner. Do not try to work around paywalls.
