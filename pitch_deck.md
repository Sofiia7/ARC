# Pitch Deck: ArcBounty

**Slide 1: Title**
**ArcBounty**
A live reference marketplace for agentic work on Arc: ERC-8183 escrow, ERC-8004 identity, USDC-native settlement, and task-backed agent reputation.
*We build on ERC-8183 + ERC-8004 as the foundation, not a wrapper*
July 2026

**Slide 2: Problem**
- AI agents can already do work, but they **can't earn** USDC autonomously
- Existing bounty platforms (Gitcoin, Dework) aren't built for agents, and gas is expensive
- No single on-chain venue where a human and an agent compete for the same job on equal terms

**Slide 3: Solution**
ArcBounty — a decentralized bounty board **native to Arc**
- 100% built on ERC-8183 (AgenticCommerce)
- ERC-8004 Identity + Reputation
- One facade contract + an SDK for agents

**Slide 4: Why now (Arc's edge)**
- USDC as native gas → micro-bounties from $1 are realistic
- Sub-second finality + $0.01 tx cost
- ERC-8183 / ERC-8004 standards already deployed and maintained by the Arc team
→ No custom escrow, minimal risk

**Slide 5: How it works (Demo Flow)**
AI agent → scans → takes → does the work off-chain → submits to IPFS → gets paid USDC + reputation
**Proof of life (not a mockup), re-run on the live V4.4:** a real AI agent — agentId `847205` — took the bond-required listing jobId `155220` (V4 worker bond posted, refunded at submit) plus jobId `155219`, submitted real work, and was paid **0.99 USDC** of each 1 USDC (1% protocol fee, not a rounding error) through the canonical ERC-8183 escrow. Earlier proofs: the same flow on V4.3/V4.2/V4.1, jobId `145613` / agentId `844730` (V3.2 era), and the Circle-wallet run on Slide 8.
🔗 [testnet.arcscan.app/address/0x538CD4…409F](https://testnet.arcscan.app/address/0x538CD48789667168bfb36f838Af8476237F9409F)

**Slide 6: Technical architecture**
- `BountyAdapter.sol` — a thin facade over ERC-8183, **we don't write our own escrow**
- Non-trivial design: the adapter holds all 3 AC roles; payout to the real worker is forwarded via **balance-delta accounting** (details in [`ARCHITECTURE.md`](ARCHITECTURE.md))
- V4: on-chain anti-Sybil economics — opt-in **worker bond** + **uniquePosterCount** reputation signal (see Slide 8); V4.1 hardens the bond against honeypot listings (24h min deadline) and bounds late rejections; V4.2 closes the same two guards' mirror-image gaps (late disputes, take-near-deadline bond honeypot); V4.3 fixes a reputation-registry interface mismatch — `giveFeedback` had the wrong selector and silently reverted since the first integration, so agent reputation now actually writes on-chain; V4.4 (current) removes the protocol fee from the neutral arbitrator-timeout split — users are no longer charged for arbitration the protocol failed to deliver
- Next.js 14 (Vercel) + arcbounty-agent-sdk (npm) + **MCP server** (ArcBounty as tools for any MCP agent runtime) + IPFS
- **90 unit tests + 2 stateful invariants (92 total, 8,192 fuzz calls, 0 reverts)**, 98% line coverage, Slither: 0 findings, **CI green** (incl. a fork test against live Arc Testnet)

**Slide 7: Target users**
- Posters: DAOs, protocols, developers
- Workers: freelancers + AI agents
- Protocols: automated bounty creation
→ A public good for the whole Arc ecosystem

**Slide 8: Competitive advantage**
**To my knowledge, ArcBounty is one of the first projects using BOTH standards together, plus an agent SDK**
While ACN and other hackathon projects tackle agent-to-agent interaction, ArcBounty is one of the first open marketplaces where a human and an AI agent work side by side on one UI, with categories, tags, and reputation visible to everyone.
**On Arc today:**
- A full **Dispute V2 with a challenge window** — a poster can't instantly reject an honest agent's correct work (worker protection built into the contract).
- **Passkey-SCA login** (Porto connector) for humans — gas paid in USDC, no extension, sponsored tx — **plus a real Circle Developer-Controlled Wallets integration for agents**, not just Porto. An agent signs through Circle's MPC custody with zero private key in its process; verified live end to end (agentId `845036` registered, took bounty `145786`, submitted work, and was paid via Circle's wallet — independently confirmed on-chain).
- **Task-backed reputation, not a raw rating.** A recent ERC-8004 study ([arxiv.org/abs/2606.26028](https://arxiv.org/abs/2606.26028)) found that 59–91% of reviews in real ERC-8004 registries are Sybil patterns, with feedback ungrounded in verifiable transactions. In ArcBounty, `giveFeedback` is called **only** by the adapter, **only** after a bounty has actually been paid out with an evidence CID — reputation is backed by money and completed work, not an arbitrary review.
- **On-chain anti-Sybil economics (V4, live).** `uniquePosterCount(agentId)` — faking "reputation across many counterparties" costs N distinct funded wallets, not one alt account — plus an opt-in **worker bond** (`max($0.50, 15% of reward)`, refunded at submit) that prices out free bounty-squatting. Both deployed and covered by live listings today.
- **MCP server** — ArcBounty as native tools for any MCP-compatible agent runtime (Claude Desktop, Claude Code, …): browse/take/submit with zero custom integration. Plus an SDK `protect()` watchdog so an autonomous agent can't lose a dispute or forfeit a payout just by being offline.

**Slide 9: Current progress & Roadmap**
- ✅ Contract V4.4 deployed and **verified** on Arc Testnet (`claimArbitratorTimeout` closes the last dispute-liveness gap; worker bond + `uniquePosterCount` close the two economic gaps; V4.1 adds the bond-honeypot guard, the late-rejection bound, and `withdrawRejection`; V4.2 closes both fixes' mirror-image gaps; V4.3 fixes a reputation-registry interface mismatch that had silently broken `giveFeedback` since the first integration; V4.4 removes the protocol fee from the neutral arbitrator-timeout split — all self-found or found in review, pre-external-audit)
- ✅ Frontend in production (arcbounty.app), CSP/HSTS, real-time events, on-chain `/stats` dashboard + Sybil-resistant leaderboard score (V4 Proposal B2 — shipped)
- ✅ SDK published on npm (`arcbounty-agent-sdk`) + demo agent, full poster/worker/arbitrator surface + `protect()` watchdog
- ✅ MCP server: ArcBounty as tools for any MCP agent runtime, smoke-tested against the live contract
- ✅ CI green: forge fmt/test/snapshot, Slither, fork test, frontend, sdk, mcp-server
- ✅ 14 open bounties on testnet across all 5 categories, including bond-required listings — plus 2 completed end-to-end by a real agent on the live V4.4 (bond posted → refunded → paid)
- ✅ Circle Developer-Controlled Wallets integration shipped and verified live (agent-side; see Slide 8) — ahead of the grant milestone below
- ✅ Arbitrator role held by a Safe (`0x4892…1BC6`, SafeL2 v1.4.1) — the two-step transfer is re-run per deployment (completed on V4.1–V4.3; re-initiated on the live V4.4); infrastructure for progressive decentralization is live
- ⚠️ Known risk (disclosed openly, not hidden): the Safe is 2-of-3 today (raised 1-of-1 → 2-of-2 on 2026-07-09 → 2-of-3 on 2026-07-10) — no single signer can rule a dispute, and losing any one signer no longer deadlocks the role, but there's still no formal dispute runbook. Plan: write it before mainnet → decentralized escalation (Kleros/UMA) on the roadmap.
- 🔜 Pre-mainnet: external audit, real N-of-M multisig signers, dispute decentralization
- 🔜 Mainnet — in lockstep with Arc mainnet (summer 2026)

**Slide 10: Grant request — by milestone**
**Requesting: $38,000 USDC**, tied to 6 verifiable milestones (not just "N months of salary"):

| # | Milestone | Deliverable | Budget |
|---|---|---|---|
| 1 | Real multisig arbitrator + security runbook | ✅ Arbitrator already moved to a Safe, raised to 2-of-3 (2026-07-09 → 2026-07-10); funds a formal, documented dispute runbook | $4k |
| 2 | External audit | BountyAdapter (~590 LOC + fund custody paths) — reputable boutique firm or funded contest pool (Sherlock / Code4rena / Cantina), priced at market rate; public report | $12k |
| 3 | Circle Wallets — frontend + Gas Station | ✅ Developer-controlled (agent-side) already shipped & verified live; grant funds the remaining User-Controlled Wallets flow for human posters/workers in the frontend, plus Gas Station sponsorship | $6k |
| 4 | 3 production demo agents | Real agents (translation, code review, data) running autonomously on a mainnet-like flow | $5k |
| 5 | Early Adopter Developer Subsidy | 50+ live bounties (14 today) whose rewards pay real humans and agents for real completed work — the budget funds the workers, not the listings. Publicly reported per jobId + payout tx; on-chain `uniquePosterCount` and wallet identities make self-dealing verifiable by anyone | $6k |
| 6 | Indexer + monitoring | Replace O(n) scans with an indexer, monitor the keeper cron, add alerting. ✅ The reward-weighted leaderboard score (V4 Proposal B2) already shipped ahead of the grant | $5k |

**Deliverables in 8 weeks:**
- ✅ Deployed on Testnet (done)
- ✅ SDK on npm (done)
- 50+ live bounties (14 today)
- 3 working demo agents

**Slide 11: Why we'll win the grant**
- Direct fit with the Agentic Economy Group (Circle)
- Real infrastructure, not another demo
- Open-source + public good
- Solo developer → low overhead, fast delivery

**Slide 12: Thank you + Contact**
ArcBounty — the first real AI labor market on Arc
Let's make it so AI agents can **actually earn** on Arc.

GitHub: github.com/Sofiia7/ARC · Live: arcbounty.app · Contract: testnet.arcscan.app/address/0x538CD48789667168bfb36f838Af8476237F9409F
