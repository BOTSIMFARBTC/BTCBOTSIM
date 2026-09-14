/**
 * Diagnostic: for each bot, walk the full 16y bar-by-bar and count:
 *   - bars where score computed successfully
 *   - bars where score >= entry_conf_threshold
 *   - unique entry opportunities (score fires when out of position + cooldown clear)
 *
 * Helps explain why paper-sim shows so few trades on full history.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const HERE = path.dirname(__filename);
const DATA_DIR = path.resolve(HERE, "..", "data");

const rawBars = JSON.parse(readFileSync(path.join(DATA_DIR, "btc-daily.json"), "utf8")).bars;
const rawMacro = JSON.parse(readFileSync(path.join(DATA_DIR, "macro-daily.json"), "utf8")).rows;
const rawEvents = JSON.parse(readFileSync(path.join(DATA_DIR, "events.json"), "utf8")).events;
const pg = JSON.parse(readFileSync(path.join(HERE, "..", "results", "portfolio-genomes.json"), "utf8"));

const closes = rawBars.map((b) => b.close);
const N = rawBars.length;

// RSI
const rsi = new Array(N).fill(50);
for (let i = 14; i < N; i++) {
  let g = 0, l = 0;
  for (let j = i - 13; j <= i; j++) { const d = closes[j] - closes[j - 1]; if (d >= 0) g += d; else l -= d; }
  rsi[i] = l === 0 ? 100 : 100 - 100 / (1 + (g/14)/(l/14));
}
// vol20
const vol20 = new Array(N).fill(0);
for (let i = 21; i < N; i++) {
  const rs = [];
  for (let j = i - 19; j <= i; j++) rs.push((closes[j] - closes[j-1]) / closes[j-1]);
  const m = rs.reduce((a,x)=>a+x,0)/rs.length;
  const v = rs.reduce((a,x)=>a+(x-m)**2,0)/(rs.length-1);
  vol20[i] = Math.sqrt(v);
}
function ma(c, i, p) { if (i<p) return c[i]; let s=0; for (let j=i-p+1;j<=i;j++) s+=c[j]; return s/p; }

const CATEGORIES = ["hack","regulation","macro","geopolitical","adoption","onchain","market_structure"];
const byCat = {};
for (const c of CATEGORIES) byCat[c] = [];
for (const ev of rawEvents) {
  const t = new Date(ev.date+"T00:00:00Z").getTime() + 86400000;
  if (byCat[ev.category]) byCat[ev.category].push(t);
}
for (const c of CATEGORIES) byCat[c].sort((a,x)=>a-x);
const evState = rawBars.map(b => {
  const t = b.ts;
  const ds = arr => { let best=999; for (const et of arr) { if (et>t) break; const d=Math.floor((t-et)/86400000); if (d<best) best=d; } return best; };
  return {
    days_since_hack: ds(byCat.hack), days_since_macro: ds(byCat.macro),
    days_since_geopolitical: ds(byCat.geopolitical), days_since_market_structure: ds(byCat.market_structure),
  };
});

// macro state
const vix = rawMacro.map(m=>m.vix), dxy = rawMacro.map(m=>m.dxy), y10 = rawMacro.map(m=>m.us10y), sp = rawMacro.map(m=>m.sp500);
const pctile = (arr, i) => {
  if (i<20) return 0.5;
  const s = Math.max(0, i-249);
  let below=0, count=0;
  for (let j=s;j<=i;j++) { if (arr[j]<arr[i]) below++; count++; }
  return count>0 ? below/count : 0.5;
};
const macroS = rawBars.map((_,i) => ({
  vix_pctile: pctile(vix,i), dxy_pctile: pctile(dxy,i), us10y_pctile: pctile(y10,i),
  sp500_20d_ret: i>=20 && sp[i-20]>0 ? (sp[i]-sp[i-20])/sp[i-20] : 0,
}));

function decode(g) { return {
  rsi_oversold: 20+g[0]*20, rsi_overbought: 60+g[1]*30,
  ma_fast: 3+Math.floor(g[2]*12), ma_slow: 20+Math.floor(g[3]*80), ma_trend: 100+Math.floor(g[4]*200),
  entry_thresh: 0.3+g[5]*0.6, base_pos: 0.1+g[6]*0.9, vol_scale: g[7]*2,
  sl: 0.02+g[8]*0.18, tp: 0.05+g[9]*0.95, hold: 5+Math.floor(g[10]*95),
  trend_w: g[11], rsi_w: g[12], momo_w: g[13],
  cooldown: Math.floor(g[14]*20),
  bearish_event_fear: g[15], event_memory: 5+Math.floor(g[16]*55),
  crof: g.length>17?g[17]:0, cron: g.length>18?g[18]:0,
};}

function scoreAt(p, i) {
  if (i < Math.max(p.ma_trend, 30)) return null;
  const maF = ma(closes,i,p.ma_fast), maS = ma(closes,i,p.ma_slow), maT = ma(closes,i,p.ma_trend);
  const r = rsi[i], v = vol20[i], pC = closes[i];
  const r5 = i>=5 ? (pC-closes[i-5])/closes[i-5] : 0;
  const r20 = i>=20 ? (pC-closes[i-20])/closes[i-20] : 0;
  const rS = r < p.rsi_oversold ? 1 : r > p.rsi_overbought ? 0 : (p.rsi_overbought - r)/(p.rsi_overbought - p.rsi_oversold);
  const tS = (pC>maF?0.33:0) + (maF>maS?0.33:0) + (pC>maT?0.34:0);
  const mS = Math.max(0, Math.min(1, 0.5 + (r5+r20)*5));
  const tw = p.rsi_w + p.trend_w + p.momo_w;
  const score = tw>0 ? (p.rsi_w*rS + p.trend_w*tS + p.momo_w*mS)/tw : 0.5;
  const e = evState[i];
  const nearest = Math.min(e.days_since_hack, e.days_since_macro, e.days_since_geopolitical, e.days_since_market_structure);
  let riskM = 1;
  if (nearest < p.event_memory) riskM = Math.max(0, 1 - p.bearish_event_fear * (1 - nearest/p.event_memory));
  let macroM = 1, macroB = 1;
  if (p.crof || p.cron) {
    const mst = macroS[i];
    const worst = Math.max(mst.vix_pctile, mst.dxy_pctile, mst.us10y_pctile);
    if (worst > 0.8) macroM = Math.max(0, 1 - p.crof * (worst - 0.8)/0.2);
    if (mst.sp500_20d_ret > 0.02 && mst.vix_pctile < 0.3) macroB = 1 + p.cron * 0.5;
  }
  const volF = 1 - p.vol_scale * Math.max(0, v - 0.02);
  const sizing = Math.max(0, Math.min(1, p.base_pos * volF * riskM * macroM * macroB));
  return { score, sizing };
}

// For each bot, count bars where score >= entry_thresh, and simulate open/close/cooldown
console.log('BAR-BY-BAR DIAGNOSTIC across full 16y ('+N+' bars)');
console.log('bot                       validBars scoreFires openOpps opened  fireRate  openRate');
for (const seed of pg.top10) {
  const p = decode(seed.genome);
  let validBars = 0, scoreFires = 0, openOpps = 0, opened = 0;
  let inPos = false, exitAt = -1, entryIdx = -1;
  for (let i = 0; i < N; i++) {
    const s = scoreAt(p, i);
    if (!s) continue;
    validBars++;
    if (s.score >= p.entry_thresh) scoreFires++;
    if (inPos) {
      // simulate exit: SL/TP would happen intrabar, but for diagnostic just count max-hold timeout
      if (i - entryIdx >= p.hold) { inPos = false; exitAt = i; }
      continue;
    }
    if (exitAt >= 0 && (i - exitAt) < p.cooldown) continue;
    if (s.score < p.entry_thresh) continue;
    if (s.sizing <= 0) continue;
    openOpps++;
    // simulate as opened (assume SL/TP resolves by hold time — approximate)
    opened++;
    inPos = true; entryIdx = i;
  }
  const fireRate = (scoreFires / Math.max(1,validBars) * 100).toFixed(1);
  const openRate = (opened / Math.max(1,validBars) * 100).toFixed(2);
  console.log(seed.label.padEnd(25), String(validBars).padStart(5), String(scoreFires).padStart(6), String(openOpps).padStart(6), String(opened).padStart(6), '   ', fireRate.padStart(5)+'%', '  ', openRate+'%');
}
