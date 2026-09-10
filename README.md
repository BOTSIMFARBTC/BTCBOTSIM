# BTC Bot Simulator — Argus

BTC trading bot simulation built via genetic evolution in a world-close simulated environment (news, macro, geopolitical events + historical price). Once training converges to shippable quality, the bot deploys on the FAR Action Radar website for member on-chain BTC trading.

**Agent:** Argus (Claude Code AI, isolated to this repo)
**Status:** research / iteration
**Repo purpose:** progression backup + eventual production deployment

## Layout

```
btc-bot-sim/
├── data/
│   ├── btc-daily.json      # 3951 daily BTC OHLC bars 2010→2026
│   └── events.json         # 71 curated news/macro/geopolitical events
├── docs/
│   ├── MISSION.md          # what Argus is building and why
│   ├── ARCHITECTURE.md     # sim design + genome spec
│   ├── HANDOFF-FROM-VEGA.md# v1 baseline handoff notes
│   └── DATA-SOURCES.md     # free data pull references
├── memory/                 # Argus's persistent memory (findings, versions)
├── results/                # per-version best bots + run logs
└── scripts/
    ├── 1-fetch-data.ts     # data fetcher
    ├── 2-evolve.ts         # v1 GA (Vega's baseline)
    ├── 3-evolve-v2.ts      # v2 world-enriched (23 genes)
    ├── 4-evolve-v3.ts      # v3 reduced-genome (17 genes)
    └── 5-evolve-v4.ts      # v4 K-fold + slippage
```

## Version log

| version | genome | fitness | anti-cheat | OOS CAGR | OOS Calmar |
|---|---|---|---|---|---|
| v1 | 15g | Sortino×surv | none (in-sample) | — | — |
| v2 | 23g | Calmar+cliff | intrabar+next-open+split | 1.9% | 0.05 |
| v3 | 17g | Calmar+cliff | same | 19.9% ✓ | 0.68 |
| v4 | 17g | K-fold mean-Calmar | + slippage | −2.4% | −0.07 |

## Ship criteria (MISSION.md)

1. OOS Calmar > 1.0
2. OOS Max DD < 40%
3. Consistency across regimes (bull, chop, bear)
4. Sortino > 1.0 at realistic 50 bps
5. Passes bootstrap confidence
6. Interpretable evolved rules

## Not production yet
This repo is research-mode. Do not deploy any bot to real capital until owner approves + shadow-mode ≥4 weeks.
