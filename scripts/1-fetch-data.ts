/**
 * Step 1: fetch max-history BTC daily data from best free source.
 *
 * blockchain.info /charts/market-price?timespan=all → daily prices back to
 * 2010-08-18. That's the deepest free daily BTC price history available.
 *
 * Enrich with Binance daily 2017+ (higher quality, hourly-resolution close)
 * for the modern era so the bot has cleaner recent data.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(__dirname, "..", "data");

interface BtcDay {
  date: string;   // YYYY-MM-DD
  ts: number;     // ms epoch
  open: number;
  high: number;
  low: number;
  close: number;
  source: string;
}

async function fetchBlockchainInfo(): Promise<BtcDay[]> {
  console.log("Fetching blockchain.info full-history market-price...");
  const url = "https://api.blockchain.info/charts/market-price?timespan=all&format=json";
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`blockchain.info HTTP ${res.status}`);
  const body = await res.json() as { values: { x: number; y: number }[] };
  const points = (body.values ?? []).filter((p) => p.y > 0);
  console.log(`  Got ${points.length} points from blockchain.info`);
  // blockchain.info returns weighted-avg close; treat as OHLC=close
  return points.map((p) => ({
    date: new Date(p.x * 1000).toISOString().slice(0, 10),
    ts: p.x * 1000,
    open: p.y, high: p.y, low: p.y, close: p.y,
    source: "blockchain.info",
  }));
}

async function fetchBinanceDaily(): Promise<BtcDay[]> {
  console.log("Fetching Binance BTCUSDT daily (2017+)...");
  const out: BtcDay[] = [];
  const nowMs = Date.now();
  let cursor = new Date("2017-08-17").getTime();
  while (cursor < nowMs) {
    const url = new URL("https://api.binance.com/api/v3/klines");
    url.searchParams.set("symbol", "BTCUSDT");
    url.searchParams.set("interval", "1d");
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("limit", "1000");
    const res = await fetch(url.toString(), { headers: { accept: "application/json" } });
    if (!res.ok) break;
    const rows = (await res.json()) as unknown[][];
    if (!rows.length) break;
    for (const row of rows) {
      out.push({
        date: new Date(Number(row[0])).toISOString().slice(0, 10),
        ts: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        source: "binance",
      });
    }
    cursor = Number(rows[rows.length - 1][6]) + 1;
    await new Promise((r) => setTimeout(r, 50));
  }
  console.log(`  Got ${out.length} Binance daily bars`);
  return out;
}

async function main() {
  const [bcRaw, binRaw] = await Promise.all([
    fetchBlockchainInfo(),
    fetchBinanceDaily(),
  ]);

  // Merge — prefer Binance (has real OHLC) where dates overlap
  const byDate = new Map<string, BtcDay>();
  for (const d of bcRaw) byDate.set(d.date, d);
  for (const d of binRaw) byDate.set(d.date, d); // Binance overwrites

  const merged = Array.from(byDate.values()).sort((a, b) => a.ts - b.ts);
  console.log(`\nMerged: ${merged.length} unique daily bars`);
  console.log(`Range: ${merged[0]?.date} → ${merged[merged.length - 1]?.date}`);
  const yearsCovered = ((merged[merged.length - 1]?.ts - merged[0]?.ts) / (365.25 * 86400000)).toFixed(1);
  console.log(`Coverage: ${yearsCovered} years`);

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(DATA_DIR, "btc-daily.json"), JSON.stringify({
    generated_utc: new Date().toISOString(),
    n_bars: merged.length,
    date_start: merged[0]?.date,
    date_end: merged[merged.length - 1]?.date,
    bars: merged,
  }));
  console.log(`\nWrote ${path.join(DATA_DIR, "btc-daily.json")}`);
}

main().catch((err) => { console.error("failed:", err); process.exit(1); });
