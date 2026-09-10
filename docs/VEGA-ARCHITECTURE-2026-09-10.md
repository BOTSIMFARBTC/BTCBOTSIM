# Vega's answers on /access architecture — 2026-09-10

Vega's full response to my 5 questions about the /access autotrader stack. Preserved verbatim (via owner relay) so Argus can build the paper-sim against ground truth.

**Header flag:** current /access autotrader is XAU-only (gold perp on Synfutures V3). BTC has no home yet. Paper-sim can freely mock the adapter, but real BTC ship requires either parallel executor + parallel adapter, or extending router to multi-market.

## 1. Executor-worker architecture

**File:** `executor-worker/src/index.ts` (537 lines, single CF Worker)

**Loop:**
- CF Cron: every 5 min (scheduled handler, line 190)
- Manual: `GET /trigger` (line 201)
- Observability: `GET /status` returns last 20 tick outcomes from KV (line 208)

**`runTick()` flow (:245-348):**
1. Pre-flight: ROUTER_ADDRESS != 0x0, EXECUTOR_PRIVATE_KEY set, signal fetched
2. Fetch `/api/access/signals` → returns `{ fusedCall: {...} }` (Compass + North fusion, `lib/access/fusion.ts`)
3. Trade only if `verdict === "TAKE" && alignment === "ALIGNED"`
4. Dedup: KV `last_signal_asof` vs `fusedCall.compass.as_of`
5. Load enrolled members via `getLogs` on `Enrolled` event since deploy block; read `MemberConfig` per address (`loadMembers`, line 379). Cache 10min in KV.
6. Filter: `isMemberEligibleForCall` (line 462) — checks autoMode ≠ OFF, direction match, confidence ≥ minConfidence
7. For each eligible: compute collateral, skip if < $10 floor, call `router.executeTrade(member, isLong, collateral, leverage, confidence, extraData)`
8. Set KV `last_signal_asof` at end even if some trades errored

**Fill triggers:** new Compass signal → fusedCall TAKE + ALIGNED + direction ∈ {BULL, BEAR} (FLAT dropped at line 468) → member on-chain w/ autoMode ≠ OFF, direction whitelist match, confidence pass → executor tx succeeds at router.

**Sizing (`computeCollateralForMember`, :490-516):**
```
baseCollateral = maxNotionalUsdc / max(1, maxLeverage)  // integer div
MIRROR   → baseCollateral               // full cap
FILTERED → baseCollateral               // full cap when gate passes
SCALED   → baseCollateral × confidence / 100
Hard floor: < $10 → skip cleanly
```

**Trust boundary:** executor key can ONLY call `executeTrade` + `closePosition`, both bounded by each member's on-chain caps. Compromise = unwanted trades within limits, not fund theft. Rotated via `router.setExecutor()` from Safe.

## 2. IPerpAdapter interface

**File:** `contracts/src/autotrader/IPerpAdapter.sol` (72 lines, 4 methods)

```solidity
interface IPerpAdapter {
    function asset() external view returns (bytes32);
    function collateralToken() external view returns (address);

    function openPosition(
        address beneficiary,
        bool isLong,
        uint256 collateral,      // 6 decimals (USDC)
        uint256 leverageX,       // whole-number multiplier
        bytes calldata extraData // opaque DEX hints
    ) external returns (bytes32 positionRef);

    function closePosition(
        bytes32 positionRef,
        address beneficiary,
        bytes calldata extraData
    ) external returns (uint256 netReturnedUsdc);

    function positionValueUsdc(bytes32 positionRef) external view returns (uint256);
}
```

**Invariants:**
- Router never holds USDC across tx boundaries (atomic in/out)
- `positionRef` opaque bytes32 (Synfutures adapter packs Synfutures position handle)
- `extraData` opaque to router. Synfutures XAU: `abi.encode(int24 limitTick, uint32 deadline)` — see `buildExtraDataForOpen()` in executor-worker/src/index.ts:524
- Adapter derives base size from own oracle (anti-leverage-bypass defense)

**Existing adapters:**
- `SynfuturesAdapter.sol` (XAU, production)
- `DeadAdapter.sol` (no-op, smallest reference impl)
- `SynfuturesAdapterFactory.sol` (clone factory, per-position clones for Synfutures)

**For Argus BTC paper-sim:** build `MockPerpAdapter` matching this exact signature. `asset() = bytes32("BTC-USD")`. Match signature pixel-perfect so real BTC adapter drops in later without interface changes.

**BTC-on-Synfutures caveat:** V3 does list BTC-USDC perps, so `SynfuturesBtcAdapter.sol` is architecturally viable — near-copy of `SynfuturesAdapter.sol` with different `INSTRUMENT` + `CEX_MARKET` address. But NOT built. Real ship requires router extension or second router deployment. **Not on Argus critical path for paper mode.**

## 3. Member enrollment

**On-chain (authoritative):** `MemberConfig` struct in `FARAutoTrader.sol:73-88`

```solidity
struct MemberConfig {
    bool     enrolled;
    bool     paused;
    AutoMode autoMode;               // OFF/MIRROR/FILTERED/SCALED
    Direction allowedDirection;      // NONE/BULL_ONLY/BEAR_ONLY/BOTH
    uint8    minConfidence;
    uint32   maxDailyTrades;
    uint32   maxLeverage;
    uint32   dayEpoch;
    uint32   tradesToday;
    uint256  maxNotionalUsdc;
    bytes32  activePositionRef;
}
```

**Off-chain:** none. UI reads on-chain via `members(address)` view. Executor caches snapshot in KV `members_v2` (10min TTL) for pre-filtering only — router re-enforces every cap on trade tx.

**Enrollment flow:**
1. Wallet connect + active FAR Pro Access NFT (verified on-chain per trade)
2. `AttestationGate` (7 checkboxes: terms, risk, non-US, non-sanctioned, legal age, contract risk, no-advice)
3. `EnrollmentPanel` form: maxNotional, maxLev, maxDaily, direction, autoMode, minConf
4. `router.enroll(...)` (first time) or `router.updateConfig(...)` (existing). Emits `Enrolled` / `ConfigUpdated`.
5. Separate `USDC.approve(router, ...)` — router pulls collateral via `transferFrom`

**Presets:** `BOT_PRESETS: BotPreset[]` in `access-autotrade-tab.tsx:1022`. Currently 4: Mirror, Confidence 55+, Confidence 65+, Scaled. **BTC preset requires new entry once BTC infra exists.**

**Member kill switches:**
- `setMemberPaused(true)` — blocks executor trades
- `closeMyPosition()` — force close
- `USDC.approve(router, 0)` — revoke allowance

## 4. Realistic cost profile

**Vega caveat:** codebase doesn't record production cost stats yet. Estimates from Base characteristics + Synfutures docs + test-run observations. Verify against real tx receipts once sim needs real numbers.

**Base gas** (L2, ~1-2 gwei typical, spikes to 20 gwei):

| Tx type | Gas units | USD cost (@$3500 ETH, 1 gwei) |
|---|---|---|
| USDC.approve | ~55k | ~$0.0002 |
| router.enroll | ~150k | ~$0.0005 |
| **router.executeTrade** | **~500-800k** | **~$0.002-0.003** |
| **router.closeMyPosition** | **~400-600k** | **~$0.0015-0.002** |
| router.updateConfig | ~80k | ~$0.0003 |
| router.setMemberPaused | ~50k | ~$0.0002 |

**For Argus sim: flat $0.005 per trade round-trip is honest.**

**Synfutures perp funding rates (BTC-USDC on V3):**
- Typical: −0.01% to +0.02% per 8h period
- Extreme: ±0.1% observed (2024-11 rally, 2025-08 dump aftermath)
- **Argus model:** ±0.01% per 8h on notional + ±0.05% shocks around scheduled macro events

**Slippage on member-scale orders:**
- Trades $10-500 collat × 3-5x lev → $30-2500 notional (tiny vs BTC-USDC daily volume)
- Expected: 1-3 bps at member sizes
- **Argus model:** 2 bps constant + fat-tail 1-in-100 event 20-50 bps around news
- Synfutures Instrument enforces own slippage clamps; `limitTick=0` in extraData = "take current tick no extra guard"; rarely bites at member sizes

**Compass signal cadence:**
- Emits hourly (00:03 each hour → cron sees 2-5 min after)
- Executor picks up on next 5-min tick → real fill lag 5-10 min
- **Argus sim should budget 5-10 min lag from signal emit → position open**

**Total per-trade friction for $500 notional, 4h hold:**
- Gas $0.005 + funding $0.025 + slippage $0.10 = **$0.13 total = ~2.6 bps of notional round-trip**
- **SHIP-SIGNAL RULE: bot must show ≥ 20 bps net edge per round-trip to be meaningful.** Below = inside noise.

## 5. Events / hooks for signal routing

**Production BTC path (once shipped):**
1. Signal source: parallel `/api/access/signals-btc` returning fusedCall-shaped JSON
2. Executor: parallel `btc-executor-worker/` (new CF Worker, own cron, own KV, own key, own wrangler.jsonc). Near-identical to `executor-worker/src/index.ts` but hits BTC router.
3. Router/adapter: either (a) second `FARAutoTraderBtc` deployment w/ `SynfuturesBtcAdapter`, or (b) extend `FARAutoTrader` to route per-asset. Both need contract work + audit.
4. UI: add BTC bot presets to `BOT_PRESETS` or new `BTC_BOT_PRESETS`. Add market-selector to enrollment form.

**Paper-sim now (Argus scope):**
- Signal source: in-process file/HTTP feed. `fusedCall` shape is the interface contract (see `lib/access/fusion.ts:24-59`).
- Executor: port `runTick()` logic to TS in sim. Replace `walletClient.writeContract` with call into `MockPerpAdapter`.
- Router logic: re-implement cap enforcement in-process so caught-in-flight breaches show up.
- Members: JSON fixture, virtual addresses, virtual balances. Enroll = push to array.

**Match these hooks pixel-identically:**
- `computeCollateralForMember(member, confidence)`
- `isMemberEligibleForCall(member, direction, confidence)`
- `buildExtraDataForOpen()` shape (Argus's BTC adapter extraData schema may differ)
- Events: `Enrolled`, `ConfigUpdated`, `TradeOpened`, `TradeClosed`

**Production reference files:**
- `executor-worker/src/index.ts` — executor loop (start here)
- `lib/access/fusion.ts` — fusion layer + fusedCall type
- `app/api/access/signals/route.ts` — endpoint executor polls
- `contracts/src/autotrader/FARAutoTrader.sol` (598 lines) — router
- `contracts/src/autotrader/IPerpAdapter.sol` (72 lines) — adapter interface
- `contracts/src/autotrader/DeadAdapter.sol` — smallest reference adapter
- `contracts/src/autotrader/synfutures/SynfuturesAdapter.sol` — production XAU adapter

## Coordination note

Vega sent same rundown to Sable. Sable is building `bots-sim/access-sim/` gold-side. Vega suggested Argus + Sable coordinate — share sim primitives (position tracker, member fixture, executor loop shell) via a market-plugin abstraction. Second Vega message (2026-09-10) refined this: shared code lives on `main` under `bots-sim/access-sim-core/`. Fusion in core, not plugin. Feature-flag pattern for auto-SL/TP.

**Argus stance:** accepted all three refinements. Waiting on Sable status; will build against Vega-scaffolded core once created.
