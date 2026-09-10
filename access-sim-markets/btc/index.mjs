/**
 * BTC plugin for /access-sim-core (Argus).
 *
 * Current status: SKELETON. Full implementation pending v6-A fresh-seed
 * verification landing (background task buz25cn12). Once verified best-of-A
 * genome is confirmed, this file gets filled in and moved to the FAR
 * repo's `bots-sim/markets/btc/index.mjs` on the btc-bot-sim branch.
 *
 * Design notes:
 * - Argus's BTC bot is INDEPENDENT execution mode (no upstream signal
 *   engine like Compass for BTC). Bot generates its own long/flat
 *   decisions from priceSeries + macroSeries + events + evolved genome.
 * - No signal_triggered support here yet — if a BTC-Compass analog ever
 *   gets built, add it as a second bot registration.
 * - Cost profile uses Vega's production BTC-USDC estimates:
 *     gasUsdPerTrade = $0.005 (Base L2)
 *     fundingBpsPer8h = 1 (avg BTC perp funding, ±0.01% typical)
 *     slippageFn = vol-conditional: 2 + range% × 500 bps
 *     gapModelFn: gaps > 1% treated as real fill impact
 *     tpSlSupported = true (per full-platform-assumption rule)
 * - MockPerpAdapter subclass:
 *     - 24/7 funding accrual (BTC perps don't sleep)
 *     - Wider wick tolerance than XAU (BTC daily wicks are more extreme)
 *     - Absolute position cap $10k (Argus PROTOCOL, kills unlimited-compound)
 */

import { MockPerpAdapter } from "../../../../web/bots-sim/access-sim-core/src/adapter.mjs";

// ─── BTC MockPerpAdapter ────────────────────────────────────────────

class BtcMockAdapter extends MockPerpAdapter {
  constructor() {
    super({
      assetSymbol: "BTC-USDC",
      costProfile: {
        gasUsdPerTrade: 0.005,
        fundingBpsPer8h: 1,                    // ±0.01% typical for BTC perp
        slippageFn: (bar) => {
          const rangePct = (bar.h - bar.l) / bar.c;
          return Math.min(20, 2 + rangePct * 500);
        },
        gapModelFn: (prevClose, open) => {
          const gapPct = Math.abs(open - prevClose) / prevClose;
          return gapPct > 0.01 ? (open - prevClose) : null;  // gap-through on ≥1%
        },
        tpSlSupported: true,
      },
    });
  }

  // BTC-specific: use bar open as fill price for entries (matches sim v6)
  openFillPrice(bar, _direction) {
    return bar.o;
  }

  // Position cap enforcement (matches sim v6 MAX_POSITION_USD)
  clampPositionNotional(_member, requestedUsd) {
    return Math.min(requestedUsd, 10_000);
  }
}

// ─── Genome decode (mirrors scripts/9-evolve-v6-ab.ts:decode()) ─────

function decodeGenome(g) {
  return {
    rsi_oversold: 20 + g[0] * 20,
    rsi_overbought: 60 + g[1] * 30,
    ma_fast_period: 3 + Math.floor(g[2] * 12),
    ma_slow_period: 20 + Math.floor(g[3] * 80),
    ma_trend_period: 100 + Math.floor(g[4] * 200),
    entry_conf_threshold: 0.3 + g[5] * 0.6,
    base_position: 0.1 + g[6] * 0.9,
    vol_scale: g[7] * 2,
    stop_loss_pct: 0.02 + g[8] * 0.18,
    take_profit_pct: 0.05 + g[9] * 0.95,
    max_hold_days: 5 + Math.floor(g[10] * 95),
    trend_weight: g[11],
    rsi_weight: g[12],
    momentum_weight: g[13],
    cooldown_days: Math.floor(g[14] * 20),
    bearish_event_fear: g[15],
    event_memory_days: 5 + Math.floor(g[16] * 55),
  };
}

// ─── Plugin export ──────────────────────────────────────────────────

export const plugin = {
  assetSymbol: "BTC-USDC",

  async priceSeries(_from, _to, _resolution) {
    // TODO: load from ../../data/btc-daily.json, filter to [from, to] window
    // Return Bar[] shape: { ts_utc, o, h, l, c }
    throw new Error("priceSeries not yet implemented — pending v6 verification");
  },

  async macroSeries(_from, _to) {
    // TODO: load from ../../data/macro-daily.json, filter to [from, to]
    // Return synced with priceSeries index-by-index
    throw new Error("macroSeries not yet implemented");
  },

  async signalSource(_tickTs) {
    // BTC has no upstream signal engine — independent mode only.
    return null;
  },

  costProfile: {
    gasUsdPerTrade: 0.005,
    fundingBpsPer8h: 1,
    slippageFn: (bar) => Math.min(20, 2 + ((bar.h - bar.l) / bar.c) * 500),
    gapModelFn: (prevClose, open) => {
      const gapPct = Math.abs(open - prevClose) / prevClose;
      return gapPct > 0.01 ? (open - prevClose) : null;
    },
    tpSlSupported: true,
  },

  mockAdapter: new BtcMockAdapter(),
};

// ─── Bot registrations ──────────────────────────────────────────────

export const bots = [
  {
    id: "argus-v6-best-of-a",
    execution_mode: "independent",
    genome: null,  // TODO: paste winner genome from results/v6ab-ab-analysis.json after verification
    async decisionFor(_member, _bar, _tickTs) {
      // TODO: port per-tick decision logic from scripts/9-evolve-v6-ab.ts:simulate()
      // Returns { direction, confidence, sl_pct, tp_pct, maxHoldHours } or null
      throw new Error("decisionFor not yet implemented — pending v6 verification");
    },
  },
];
