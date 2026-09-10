/**
 * Fetch daily macro data from Yahoo Finance for BTC world-state.
 *
 * Series pulled:
 *   ^VIX     — CBOE volatility index (fear gauge)
 *   DX-Y.NYB — US Dollar Index (dollar strength)
 *   ^TNX     — CBOE 10-Year Treasury Yield Index
 *   ^GSPC    — S&P 500 (risk sentiment)
 *   GC=F     — Gold futures (safe haven)
 *
 * All series aligned to btc-daily dates (forward-fill weekends/holidays).
 * Output: data/macro-daily.json
 *
 * CLI: npx tsx scripts/7-fetch-macro.ts
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(__dirname, "..", "data");

const SYMBOLS = {
  vix: "%5EVIX",
  dxy: "DX-Y.NYB",
  us10y: "%5ETNX",
  sp500: "%5EGSPC",
  gold: "GC%3DF",
};

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120";
const RANGE = "20y"; // Yahoo caps at 15-20y; adequate for 2010+

interface YahooChart {
  chart: {
    result: [{
      timestamp: number[];
      indicators: { quote: [{ close: (number | null)[] }] };
    }] | null;
    error?: { code: string; description: string };
  };
}

async function fetchSeries(symbol: string): Promise<{ ts: number; close: number }[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=${RANGE}`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Yahoo ${symbol} ${res.status}`);
  const data = (await res.json()) as YahooChart;
  if (data.chart.error) throw new Error(`Yahoo ${symbol} err ${data.chart.error.code}`);
  const r = data.chart.result?.[0];
  if (!r) throw new Error(`Yahoo ${symbol}: no result`);
  const out: { ts: number; close: number }[] = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const c = r.indicators.quote[0].close[i];
    if (c != null) out.push({ ts: r.timestamp[i] * 1000, close: c });
  }
  return out;
}

function toDateKey(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

async function main() {
  // Load BTC daily to know target dates
  const btcRaw = await fs.readFile(path.join(DATA_DIR, "btc-daily.json"), "utf8");
  const btcPkg = JSON.parse(btcRaw) as { bars: { date: string; ts: number }[] };
  const btcDates = btcPkg.bars.map((b) => b.date);
  const btcDateSet = new Set(btcDates);
  console.log(`Target dates: ${btcDates[0]} → ${btcDates[btcDates.length - 1]} (${btcDates.length} bars)`);

  const seriesMap: Record<string, Map<string, number>> = {};

  for (const [name, sym] of Object.entries(SYMBOLS)) {
    process.stdout.write(`Fetching ${name} (${sym.replace(/%5E/g, "^").replace(/%3D/g, "=")})... `);
    const data = await fetchSeries(sym);
    const byDate = new Map<string, number>();
    for (const p of data) byDate.set(toDateKey(p.ts), p.close);
    seriesMap[name] = byDate;
    console.log(`${data.length} points`);
    await new Promise((r) => setTimeout(r, 300)); // be nice to Yahoo
  }

  // Align to BTC dates with forward-fill
  const aligned = btcDates.map((d, idx) => {
    const row: any = { date: d, ts: btcPkg.bars[idx].ts };
    for (const name of Object.keys(SYMBOLS)) {
      const s = seriesMap[name];
      // Find latest series value on or before d
      let val: number | null = null;
      // Walk backwards from d up to 10 days
      const [yy, mm, dd] = d.split("-").map(Number);
      const baseTs = Date.UTC(yy, mm - 1, dd);
      for (let off = 0; off < 10; off++) {
        const t = baseTs - off * 86400000;
        const k = new Date(t).toISOString().slice(0, 10);
        if (s.has(k)) { val = s.get(k)!; break; }
      }
      row[name] = val;
    }
    return row;
  });

  // Report coverage
  for (const name of Object.keys(SYMBOLS)) {
    const covered = aligned.filter((r) => r[name] != null).length;
    console.log(`  ${name}: ${covered}/${aligned.length} covered (${((covered / aligned.length) * 100).toFixed(1)}%)`);
  }

  // Sample rows
  console.log("\nFirst row:", JSON.stringify(aligned[0]));
  console.log("Mid row:", JSON.stringify(aligned[Math.floor(aligned.length / 2)]));
  console.log("Last row:", JSON.stringify(aligned[aligned.length - 1]));

  await fs.writeFile(path.join(DATA_DIR, "macro-daily.json"), JSON.stringify({
    generated_utc: new Date().toISOString(),
    n_rows: aligned.length,
    date_start: aligned[0].date,
    date_end: aligned[aligned.length - 1].date,
    fields: ["date", "ts", ...Object.keys(SYMBOLS)],
    rows: aligned,
  }));
  console.log(`\nWrote data/macro-daily.json (${aligned.length} rows)`);
}

main().catch((err) => { console.error("failed:", err); process.exit(1); });
