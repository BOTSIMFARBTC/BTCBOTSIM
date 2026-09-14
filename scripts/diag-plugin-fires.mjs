/**
 * Diagnostic: instrument the plugin's decisionFor path directly and count
 * exactly why entries get blocked.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const HERE = path.dirname(__filename);
const DATA_DIR = path.resolve(HERE, "..", "data");
const PG = path.resolve(HERE, "..", "results", "portfolio-genomes.json");

const rawBars = JSON.parse(readFileSync(path.join(DATA_DIR, "btc-daily.json"), "utf8")).bars;
const bars = rawBars.map((b) => ({
  ts_utc: b.date + "T00:00:00.000Z",
  ts_unix: Math.floor(b.ts / 1000),
  o: b.open, h: b.high, l: b.low, c: b.close,
  date: b.date,
}));
const closes = bars.map(b => b.c);
const N = bars.length;

// RSI, vol20 (same as plugin)
const rsi = new Array(N).fill(50);
for (let i = 14; i < N; i++) {
  let g=0, l=0;
  for (let j=i-13;j<=i;j++) { const d=closes[j]-closes[j-1]; if (d>=0) g+=d; else l-=d; }
  rsi[i] = l===0 ? 100 : 100 - 100/(1+(g/14)/(l/14));
}
const vol20 = new Array(N).fill(0);
for (let i=21;i<N;i++) {
  const rs=[];
  for (let j=i-19;j<=i;j++) rs.push((closes[j]-closes[j-1])/closes[j-1]);
  const m = rs.reduce((a,x)=>a+x,0)/rs.length;
  const v = rs.reduce((a,x)=>a+(x-m)**2,0)/(rs.length-1);
  vol20[i] = Math.sqrt(v);
}
function ma(c,i,p) { if (i<p) return c[i]; let s=0; for (let j=i-p+1;j<=i;j++) s+=c[j]; return s/p; }

const pg = JSON.parse(readFileSync(PG, "utf8"));
const g = pg.top10.find(s => s.label === "v6ab-A-1006").genome;
const p = {
  rsi_oversold: 20+g[0]*20, rsi_overbought: 60+g[1]*30,
  ma_fast: 3+Math.floor(g[2]*12), ma_slow: 20+Math.floor(g[3]*80), ma_trend: 100+Math.floor(g[4]*200),
  entry_thresh: 0.3+g[5]*0.6, base_pos: 0.1+g[6]*0.9, vol_scale: g[7]*2,
  sl: 0.02+g[8]*0.18, tp: 0.05+g[9]*0.95, hold: 5+Math.floor(g[10]*95),
  trend_w: g[11], rsi_w: g[12], momo_w: g[13],
  cooldown: Math.floor(g[14]*20),
};

// Bin fires by year — no event/macro state to isolate
let firesByYear = {};
let sizingZeroByYear = {};
let firesByYearWithSizing = {};

for (let i=0;i<N;i++) {
  if (i < Math.max(p.ma_trend, 30)) continue;
  const maF=ma(closes,i,p.ma_fast), maS=ma(closes,i,p.ma_slow), maT=ma(closes,i,p.ma_trend);
  const r=rsi[i], v=vol20[i], pC=closes[i];
  const r5 = i>=5 ? (pC-closes[i-5])/closes[i-5] : 0;
  const r20 = i>=20 ? (pC-closes[i-20])/closes[i-20] : 0;
  const rS = r<p.rsi_oversold?1:r>p.rsi_overbought?0:(p.rsi_overbought-r)/(p.rsi_overbought-p.rsi_oversold);
  const tS = (pC>maF?0.33:0) + (maF>maS?0.33:0) + (pC>maT?0.34:0);
  const mS = Math.max(0, Math.min(1, 0.5 + (r5+r20)*5));
  const tw = p.rsi_w + p.trend_w + p.momo_w;
  const score = tw>0 ? (p.rsi_w*rS + p.trend_w*tS + p.momo_w*mS)/tw : 0.5;
  const volF = 1 - p.vol_scale * Math.max(0, v - 0.02);
  const sizing = Math.max(0, Math.min(1, p.base_pos * volF));  // no event/macro dampening
  const yr = bars[i].date.slice(0,4);
  if (score >= p.entry_thresh) {
    firesByYear[yr] = (firesByYear[yr]||0) + 1;
    if (sizing <= 0) sizingZeroByYear[yr] = (sizingZeroByYear[yr]||0) + 1;
    else firesByYearWithSizing[yr] = (firesByYearWithSizing[yr]||0) + 1;
  }
}

console.log("Bot v6ab-A-1006: entry_thresh=" + p.entry_thresh.toFixed(2) + " base_pos=" + p.base_pos + " vol_scale=" + p.vol_scale.toFixed(2));
console.log("\nyear   fires  sizing0  fires&sizing>0");
for (const yr of Object.keys(firesByYear).sort()) {
  console.log(yr, String(firesByYear[yr]).padStart(6), String(sizingZeroByYear[yr]||0).padStart(8), String(firesByYearWithSizing[yr]||0).padStart(16));
}
