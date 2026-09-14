/**
 * Diagnostic: run one bot on full 16y and print every open/close ts.
 */

import { runSim } from "../../bots-sim/access-sim-core/src/harness.mjs";
import { plugin, bots, buildPortfolioMembers } from "../../bots-sim/markets/btc/index.mjs";

const members = buildPortfolioMembers(1000);
const result = await runSim({
  plugin, members, bots,
  window: { from: "2010-08-18", to: "2026-09-10" },
  cadenceSec: 86400,
  startingCapital: 1000,
});

// Focus on one bot: v6ab-A-1006 (highest fire rate in diag)
const targetId = "argus-btc-v6ab-A-1006";
const m = result.members.find(x => x.config.bot_id === targetId);
console.log("Bot:", targetId);
console.log("Final capital:", m.capital.toFixed(2));
console.log("Peak capital:", m.peakCapital.toFixed(2));
console.log("Total history entries:", m.history.length);
console.log("Open positions at end:", m.positions.length);
console.log("Enrolled:", m.enrolled, "Paused:", m.paused);
console.log("\nTrade history:");
for (const h of m.history) {
  console.log("  ", h.entryTime.slice(0,10), "→", h.exit_ts.slice(0,10), "|",
    h.direction, "entry=$"+h.entryPrice.toFixed(0), "exit=$"+h.exit_price.toFixed(0),
    "reason=", h.exit_reason, "pnl=$"+h.pnl.toFixed(1), "held="+h.held_hours.toFixed(0)+"h");
}
