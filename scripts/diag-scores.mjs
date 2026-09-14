/**
 * Diagnostic: dump the distribution of scores at bot-fire moments.
 * Helps set the confidence-adaptive sizing thresholds.
 */

import { runSim } from "../../bots-sim/access-sim-core/src/harness.mjs";
import { plugin, bots, buildPortfolioMembers } from "../../bots-sim/markets/btc/index.mjs";

process.env.BTC_SCORE_MARGIN = "0";
process.env.BTC_CONF_SIZING = "0";

const scores = [];
// Wrap decisionFor on all bots to capture score
for (const bot of bots) {
  const orig = bot.decisionFor.bind(bot);
  bot.decisionFor = async (m, b, ts) => {
    const r = await orig(m, b, ts);
    if (r) scores.push(r.confidence / 100);
    return r;
  };
}

const members = buildPortfolioMembers(1000);
await runSim({
  plugin, members, bots,
  window: { from: "2011-01-01", to: "2026-09-10" },
  cadenceSec: 86400, startingCapital: 1000,
});

scores.sort((a, b) => a - b);
console.log(`n scores captured: ${scores.length}`);
const pct = (p) => scores[Math.floor(scores.length * p)];
console.log(`  min:   ${scores[0].toFixed(3)}`);
console.log(`  p10:   ${pct(0.10).toFixed(3)}`);
console.log(`  p25:   ${pct(0.25).toFixed(3)}`);
console.log(`  p50:   ${pct(0.50).toFixed(3)}`);
console.log(`  p75:   ${pct(0.75).toFixed(3)}`);
console.log(`  p90:   ${pct(0.90).toFixed(3)}`);
console.log(`  max:   ${scores[scores.length - 1].toFixed(3)}`);

console.log('\nHistogram (10 buckets):');
for (let b = 0; b < 10; b++) {
  const lo = b / 10, hi = (b + 1) / 10;
  const n = scores.filter(s => s >= lo && s < hi).length;
  const pct = (n / scores.length * 100).toFixed(1);
  const bar = '#'.repeat(Math.floor(n / 5));
  console.log(`  ${lo.toFixed(1)}-${hi.toFixed(1)}: ${String(n).padStart(4)} (${pct.padStart(4)}%)  ${bar}`);
}
