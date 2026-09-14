/**
 * Wrap the plugin's decisionFor for ONE bot and count exactly what happens.
 */

import { runSim } from "../../bots-sim/access-sim-core/src/harness.mjs";
import { plugin, bots, buildPortfolioMembers } from "../../bots-sim/markets/btc/index.mjs";

const TARGET = "argus-btc-v6ab-A-1006";
const counters = { callsTotal: 0, posOpen: 0, cooldownBlock: 0, scoreLow: 0, sizingZero: 0, fired: 0, byYear: {} };

// Monkey-patch decisionFor to count fire attempts
const targetBot = bots.find(b => b.id === TARGET);
const origFn = targetBot.decisionFor.bind(targetBot);
targetBot.decisionFor = async (member, bar, tickTs) => {
  counters.callsTotal++;
  const yr = (bar.date ?? bar.ts_utc?.slice(0,10)).slice(0,4);
  counters.byYear[yr] = counters.byYear[yr] || { calls:0, pos:0, cool:0, low:0, zero:0, fire:0 };
  counters.byYear[yr].calls++;
  if (member.positions.length > 0) { counters.posOpen++; counters.byYear[yr].pos++; return null; }
  const r = await origFn(member, bar, tickTs);
  if (r) { counters.fired++; counters.byYear[yr].fire++; }
  return r;
};

// Also wrap the adapter to see which fires get rejected downstream
const adapter = plugin.mockAdapter;
const origTry = adapter.tryOpenPosition.bind(adapter);
const openStats = { attempts: 0, opened: 0, rejects: {} };
adapter.tryOpenPosition = (member, sig, bar, ts) => {
  if (member.config.bot_id !== TARGET) return origTry(member, sig, bar, ts);
  openStats.attempts++;
  const r = origTry(member, sig, bar, ts);
  if (r.opened) openStats.opened++;
  else openStats.rejects[r.reason] = (openStats.rejects[r.reason]||0)+1;
  return r;
};

const members = buildPortfolioMembers(1000);
await runSim({
  plugin, members, bots,
  window: { from: "2010-08-18", to: "2026-09-10" },
  cadenceSec: 86400, startingCapital: 1000,
});

console.log("Target bot:", TARGET);
console.log("\nDecisionFor counters:");
console.log("  total calls:", counters.callsTotal);
console.log("  blocked by open position:", counters.posOpen);
console.log("  fired (returned signal):", counters.fired);

console.log("\nAdapter tryOpen for this bot:");
console.log("  attempts:", openStats.attempts);
console.log("  opened:", openStats.opened);
console.log("  reject reasons:", openStats.rejects);

console.log("\nPer-year:");
console.log("year  calls  posOpen  fired");
for (const yr of Object.keys(counters.byYear).sort()) {
  const y = counters.byYear[yr];
  console.log(yr, String(y.calls).padStart(5), String(y.pos).padStart(7), String(y.fire).padStart(5));
}
