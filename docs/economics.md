# ArcBounty — Protocol Fee Economics

Version 1.0, sprint 5. Companion document to `TZ §13.5`.

## TL;DR

ArcBounty charges a flat **1% protocol fee** (`feeBps = 100`, hard-capped to 10% by constructor invariant). The fee is deducted from the poster's USDC at `createBounty` time and routed to `feeRecipient` in the same atomic transaction. The remaining 99% (`netReward`) is locked in ERC-8183 escrow and pays the provider on `complete`.

There is **no fee on the provider side**. Providers receive 100% of the displayed `reward` (which is already net of fee in `BountyMeta.reward`).

## Why 1% (and not 0% / 5% / 10%)?

| Platform | Take rate | Notes |
|---|---|---|
| Upwork | 5–20% | Sliding scale + fees both sides |
| Fiverr | 20% | Provider side only |
| Gitcoin Bounties | 5% (sponsor-side) | Plus L1 gas |
| Dework | 3% (treasury) | Multi-chain |
| **ArcBounty** | **1%** | Single side (poster), $0.01 native gas |

We start at the bottom of the market because:

1. **USDC-native gas on Arc is ~$0.01.** A $1 micro-bounty already pays ~1% in gas; doubling the take rate would push the floor reward above $5 and kill the micro-bounty use case that motivates Arc itself.
2. **AI-agent volume strategy.** A successful agent fleet processes 100–1000 small tasks per day. At those volumes, 1% per task compounds to material protocol revenue even at low average reward.
3. **Race-to-zero risk is low.** Competitors with comparable on-chain reputation rails don't exist on Arc; the moat is the ERC-8183/8004 integration, not pricing aggression.

## Break-even analysis

Assumptions:
- Hosted frontend (Vercel): $0 (free tier) → $20/mo (Pro)
- IPFS pinning (Pinata): $0–20/mo at MVP scale
- Expiry-runner gas: ~$0.005 × ~20 expirations/day ≈ $3/mo
- Maintainer time: ignored (open source / grant-funded for year one)

**Fixed costs ≈ $40/mo.**

Average bounty reward (target after 90 days, per TZ §11 metrics): **$15**.
Fee per bounty at 1%: **$0.15**.

Break-even volume: **267 bounties/month ≈ 9/day.** This matches the §11 short-term target of "≥ 30 bounties in the first 30 days" — i.e. we hit operating break-even by month 2 at planned scale.

At the medium-term target (≥ 100 active + ≥ 50 completed by AI/month), with average reward stable at $15:
- Revenue ≈ 100 bounties × $0.15 = **$15/mo** ❌ still below break-even.

The model only works once **average reward × volume × 1% > $40/mo**. Two paths:

### Path A: bigger average reward
Hit average $50 (DAO-funded dev tasks, paid integrations). Then 30 bounties/month = $15 revenue, 100 = $50 — break-even at ~80/month at $50 avg.

### Path B: agent-driven volume
1000 micro-tasks ($2 avg) per month at 1% = $20 — still below. At 3000/mo: $60 → break-even. Requires aggressive SDK adoption (see TZ §11 retention metrics).

**Realistic blended scenario for month 6**: 200 bounties × $20 avg = $4000 GMV → $40 fees → exactly break-even.

## Fee adjustment policy

The current implementation makes `feeBps` **immutable per deployment**. Changing the rate requires redeploying `BountyAdapter` and migrating live state (no live bounties survive migration; users must withdraw via `cancel`/`expire` first).

This is intentional for MVP to avoid a "rug-by-fee-bump" attack vector. A future v2 may:
1. Make `feeBps` settable by `arbitrator` with a 7-day timelock and a hard cap of the current `MAX_FEE_BPS = 1000` (10%).
2. Or make it programmatic — e.g. 1% under $10k monthly GMV, 0.5% above.

For now: **1% forever, replace the contract to change.**

## Fee recipient

`feeRecipient` is also immutable. Best practice is to deploy with a multisig (or even just a 2/3 Gnosis Safe) so the fee stream is governance-controlled, not key-controlled.

## Comparison: cost-to-post a $10 dev bounty

| Platform | Poster pays | Provider gets | Effective take |
|---|---|---|---|
| Gitcoin (Ethereum) | $10 + ~$3 gas = $13 | $9.50 (5% fee) | 27% |
| Dework (Polygon) | $10 + ~$0.05 gas | $9.70 | 3.3% |
| **ArcBounty (Arc)** | **$10 + ~$0.03 gas** | **$9.90** | **1.3%** |

The 1% take + $0.01 gas combination is hard to beat without USDC-native gas.

## Roadmap for fee economics

- **v1.x (sprint 5)** — 1% fixed, immutable.
- **v2.0 (post-audit)** — settable fee with timelock and hard cap; volume-based discount above threshold.
- **v2.1** — fee rebate to ERC-8004 agents with reputation ≥ 80 (loyalty tier).
- **v3.0** — fee split: x% to protocol treasury, y% to arbitration insurance pool.

## Grant-relevant ask

For the Arc Ecosystem Grant, ArcBounty does not request fee subsidies or revenue share — it requests development funding to ship sprint 5–6 (audit + Circle Wallets + mainnet). Protocol fees are the long-term sustainability mechanism, not a grant deliverable.
