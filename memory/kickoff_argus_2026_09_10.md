---
name: Argus mission kickoff 2026-09-10 — BTC bot delegated from Vega
description: Argus (many-eyed watchman) owns BTC trading bot simulation. Vega handed off v1 GA baseline. Mission = world-close simulation with news/war/macro/on-chain integrated, evolve until robust, then deploy on FAR website.
type: project
---

**Argus is Claude Code AI agent for BTC trading bot simulation** at FAR Action Radar. Named for the many-eyed watchman of Greek mythology — the bot must see all factors that move BTC price, not just charts.

**Workspace:** `web-btc-bot-sim/` git worktree on branch `btc-bot-sim`. Main FAR codebase at `web/` (main branch) is Vega's territory — do not touch.

**Owner directives (2026-09-10):**
- Build a BTC trader in a simulated world close to reality
- Include news, wars, macro shocks, on-chain events as bot-visible state
- Start with $1000 capital, evolve via genetic algorithm
- Continue until owner satisfied → deploy on FAR website for member on-chain trading
- Two-way street: Argus's findings should inform Vega's AXIS engine

**How to apply:**
- Read `btc-bot-sim/docs/MISSION.md`, `ARCHITECTURE.md`, `HANDOFF-FROM-VEGA.md`, `DATA-SOURCES.md` in order
- Set `.agent-name = argus` in this worktree for commit trailers
- Wait for v1 evolution (running in Vega's session) to finish → read `results/v1-best-bot.json`
- Interpret v1 evolved parameters, then enrich world model with news/macro/geopolitical
- Iterate v2, v3, ... until success criteria met (see MISSION.md § Success)
- Save all decisions + findings to `memory/` files as you go

**v1 baseline (delivered by Vega):**
- 3951 daily BTC bars (2010-08-18 → 2026-09-10), blockchain.info + Binance
- 15-gene GA, 100-bot population, Sortino × survival fitness, 50 bps cost, $10 liquidation
- Preliminary convergence: Sortino ~10.5, ~$12k final equity (12x), 925 trades, not liquidated
- Underperforms buy-and-hold by orders of magnitude (buy-hold from 2010 = $1B+ from $1k) — expected, BTC's early era was hold-only

**Immediate next steps (session 1):**
1. Wait for v1 result file → interpret
2. Save `v1_analysis.md` in memory with evolved genes + strategy interpretation
3. Plan v2 world-model enrichment (news + macro state + expanded genome)
4. Start building `data/events.json` from Wikipedia + curated event list

**Hard rules (inherited from FAR playbook):**
- Isolation from other AIs — communicate via owner only, wrap messages in "message begin/end" markers
- No fake numbers — validate every claimed improvement on truly OOS data
- Data loss unacceptable — commit + push results after every run
- Update memory at session end
- Free-only data sources (per owner's cost constraint)

**Cross-refs:**
- Vega mission (AXIS engine on `main`): `../web/axis-engine/`
- Sable mission (FAR bots on `bots-sim` branch): `../web-bots-sim/`
- FAR agent isolation rules: `../web/AGENT_OWNERSHIP.md`
