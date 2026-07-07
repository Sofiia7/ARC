# ArcBounty — Arc Ecosystem Grant Application

**ArcBounty is a live reference marketplace for agentic work on Arc: ERC-8183 escrow, ERC-8004 identity, USDC-native settlement, and task-backed agent reputation.**

Requested amount: **$38,000 USDC** · Team: solo developer · Status: live on Arc Testnet

---

## The problem

AI agents can already do useful work, but they can't autonomously *earn* USDC for it. Existing bounty platforms (Gitcoin, Dework) aren't built for agents and run on expensive-gas chains. There's no on-chain venue where a human and an AI agent compete for the same job, on the same terms, with reputation that means something.

## Why Arc

- **USDC as native gas** — a worker holds one token: gets paid in it, pays gas in it. Micro-bounties from $1 are economically real.
- **Sub-second finality, ~$0.01 per transaction** — no "pending" limbo, no gas eating a $5 bounty.
- **ERC-8183 (AgenticCommerce) and ERC-8004 (Identity + Reputation) are already deployed and maintained by the Arc team** — ArcBounty builds on them directly instead of writing its own escrow, cutting the project's own attack surface to a single ~590-line facade contract.

## Why Circle

This is a direct fit for the Agentic Economy Group's stated focus: agentic commerce and AI-mediated marketplaces on Arc. ArcBounty is the first open marketplace using **both** ERC-8183 and ERC-8004 together, with a public agent SDK, rather than a single-purpose demo. It's also a public good — any Arc protocol or DAO can post bounties programmatically, and any agent developer gets a working reference integration for free.

## What's live today

- **Frontend**: [arcbounty.app](https://arcbounty.app) — production, CSP/HSTS, real-time on-chain events, passkey login (Porto connector)
- **Agent SDK also supports Circle Developer-Controlled Wallets** — an agent can sign through Circle's MPC custody with zero private key in its process, not just Porto
- **Contract**: `BountyAdapter` V4.1 at [`0x83117287A0C1eCBCF33B0F11aD5BD8Ae9F379887`](https://testnet.arcscan.app/address/0x83117287A0C1eCBCF33B0F11aD5BD8Ae9F379887) — deployed and **source-verified** on ArcScan. V4 = V3.3's `claimArbitratorTimeout` (30-day neutral 50/50 split if a dispute has a response but the arbitrator never rules — closes the last liveness gap, self-found before external review) and replaceable `feeRecipient`, **plus two on-chain anti-Sybil mechanisms**: an opt-in worker bond (`max($0.50, 15% of reward)`, refunded at submit, forfeited on take-and-vanish) and `uniquePosterCount(agentId)` — a reputation signal that costs N distinct funded wallets to fake, not one alt account. **V4.1 adds three more self-found fixes from the pre-audit internal review**: a 24h minimum deadline on bond bounties (closes a bond-farming honeypot against auto-taking agents), a bound on late rejections (a poster can no longer reject right before `autoApprove` fires to buy free delay), and `withdrawRejection` (a poster can back out of a mistaken rejection)
- **Arbitrator is a Safe**: the arbitrator role on the live contract is held by a Gnosis Safe (`0x4892…1BC6`), transferred via the contract's two-step handshake — 1-of-1 today, N-of-M signers are Milestone 1
- **SDK**: [`arcbounty-agent-sdk`](https://www.npmjs.com/package/arcbounty-agent-sdk) — published on npm, full poster/worker/arbitrator surface, plus a `protect()` watchdog so an autonomous agent can never lose a dispute or forfeit a payout just by being offline
- **MCP server** (`mcp-server/`): ArcBounty exposed as Model Context Protocol tools — any MCP-compatible runtime (Claude Desktop, Claude Code, and other agent hosts) can browse, take, and submit bounties with zero custom integration; read-only mode needs no credentials at all
- **GitHub**: `github.com/Sofiia7/ARC` (private repo — access available on request as part of this application)
- **Marketplace state**: 17 open bounties on testnet ($1–$5 rewards), across all 5 categories (dev, design, content, data, other), including live listings using the V4 worker bond — plus 2 already completed end-to-end by an AI agent on the current V4.1 deployment (see proof-of-life below)
- **On-chain stats dashboard**: [arcbounty.app/stats](https://arcbounty.app/stats) — every number computed from contract events in the visitor's own browser; the leaderboard ships the Sybil-resistant "ArcBounty score" (sqrt-of-reward-weighted) and per-agent unique-poster counts

## Proof of life — a real agent, not a mockup

Three independent runs, the freshest on the **currently live V4.1** contract:

- **Current deployment (V4.1, 2026-07-07): jobIds `151017` + `151016`, agentId `847205`** — an agent registered in ERC-8004, took the bond-required listing `151017` (posted the V4 worker bond at take, got it refunded at submit — the full bond cycle on-chain), took `151016`, submitted real work to IPFS, and was paid **0.99 USDC** of each 1 USDC reward by the poster's approval, incrementing `uniquePosterCount(847205)`. Reproducible via `scripts/agent-proof-of-life.ts` in the repo.
- **Original proof (V3.2-era): jobId `145613`, agentId `844730`** (raw private key) — took a bounty, submitted work, and was paid **0.99 USDC** of a 1 USDC reward (the difference is the 1% protocol fee, not a rounding artifact) through the canonical ERC-8183 escrow. This specifically exercised the payout path that was broken in V3.1: the live Arc ERC-8004 reputation registry can revert on `giveFeedback`, which used to block payout to agent workers entirely. V3.2 (and every version since, V4.1 included) wraps that call in `try/catch` so payout can never be blocked by a reputation-write failure — verified end-to-end on-chain, not just in a unit test.
- **A Circle Developer-Controlled Wallet proof** — **jobId `145786`**, **agentId `845036`**, wallet `0x3996…ba101` — ran the exact same register → take → submit → approve → pay cycle with no private key anywhere in the process, signing entirely through Circle's API/MPC custody. Paid **0.99 USDC** of 1 USDC, confirmed independently on-chain.

## Engineering discipline (verifiable, not just claimed)

- **84 unit tests + 2 stateful invariants** (86 total; +1 fork test against live Arc Testnet = 87 with an RPC configured), **8,192 fuzz calls, 0 reverts**
- **Coverage**: 98.12% lines / 95.69% statements / 92.86% functions on `BountyAdapter.sol` (`forge coverage --ir-minimum`, re-run on the deployed V4.1 code)
- **Slither**: 0 findings (3 detector classes reviewed and triaged in `contracts/SLITHER.md`, not blanket-silenced)
- **CI**: green on every push — `forge fmt/build/test/snapshot`, Slither gate, a fork test against live Arc Testnet, frontend lint+build, SDK typecheck+build, and a docs-consistency + gitleaks gate

## Known risks — disclosed, not hidden

| Risk | Current state | Mitigation plan |
|---|---|---|
| **Arbitrator Safe is 1-of-1 today** | The arbitrator role on the live V4.1 contract **is** the Safe (`0x4892…1BC6`), transferred via the two-step `transferArbitrator`/`acceptArbitrator` handshake (completed 2026-07-07) — but it currently has a single signer, so it is infrastructure for decentralization rather than decentralization itself. Its power is also time-bounded on-chain: even a dead or compromised arbitrator can only delay a dispute 30 days before `claimArbitratorTimeout` resolves it permissionlessly. | Milestone 1: add independent co-signers + raise the threshold inside the Safe (no contract change needed), then a decentralized-escalation path (Kleros/UMA) |
| **Arbitrator liveness gap (self-found, fixed — now live)** | A dispute where the respondent replied but the arbitrator never ruled had no recovery path prior to V3.3 — `resolveDispute` is arbitrator-only, and funds could freeze forever. Fixed via `claimArbitratorTimeout` (30-day neutral 50/50 split, no reputation penalty); **live in the deployed V4.1** | Closed — external audit (Milestone 2) reviews the fixed version, not V3.2 |
| **Solo maintainer (bus factor)** | One developer holds the deployer key and the Safe's single signature today. Crucially, the protocol itself does not need the maintainer to stay solvent for users: every terminal state is reachable permissionlessly (`autoApprove`, `finalizeRejection`, `claimDefaultRuling`, `claimArbitratorTimeout`), so funds can always be settled even if the maintainer disappears — the worst case is dispute rulings degrading to the neutral 30-day 50/50 split. | Milestone 1's independent Safe co-signers remove the single-human dependency for dispute quality as well; the contract is non-upgradeable, MIT-licensed, and fully documented for handover |
| **Circle Wallets — partially shipped** | Agent-side (Developer-Controlled Wallets) is live and verified (see proof-of-life above). The frontend still uses the Porto passkey-SCA connector for humans, not Circle's User-Controlled Wallets SDK | Milestone 3 below: fund the remaining User-Controlled Wallets flow for human posters/workers, plus Gas Station sponsorship |
| **ERC-8004 reputation can be a weak signal** | A recent empirical study ([arxiv.org/abs/2606.26028](https://arxiv.org/abs/2606.26028)) found 59–91% Sybil-pattern reviews in real ERC-8004 registries, with feedback often ungrounded in real transactions | Two layers, both live: (1) ArcBounty's `giveFeedback` is called only by the adapter, only after a bounty is actually paid out with an evidence CID — reputation is task-backed by construction; (2) V4's on-chain `uniquePosterCount` makes "reputation across many counterparties" cost N distinct funded wallets instead of one alt account, and the opt-in worker bond prices out free bounty-squatting. Design rationale: `V4_DESIGN_ANTI_SYBIL.md` |
| **Arc mainnet is now "this summer" (2026), not an abstract future** | Testnet-only today | Roadmap explicitly scoped to land pre-mainnet hardening in lockstep with Arc's mainnet timeline |

## Requested amount, by milestone

**$38,000 USDC total**, tied to 6 verifiable milestones rather than a flat salary line:

| # | Milestone | Deliverable | Budget |
|---|---|---|---|
| 1 | Real multisig arbitrator + security runbook | ✅ Arbitrator already moved to a Safe (1-of-1); funds adding independent co-signers + raising the threshold, plus a documented dispute runbook | $4k |
| 2 | External audit | `BountyAdapter` (~590 LOC + fund custody paths) audited by a reputable boutique firm, or a funded contest pool (Sherlock / Code4rena / Cantina) — priced at market rate, not a token line item; public report either way | $12k |
| 3 | Circle Wallets — frontend + Gas Station | ✅ Developer-controlled (agent-side) already shipped & verified; funds the remaining User-Controlled Wallets flow for humans + Gas Station sponsorship | $6k |
| 4 | 3 production demo agents | Real autonomous agents (translation, code review, data) running end-to-end | $5k |
| 5 | Public bounty liquidity | 50+ live bounties (17 today) whose rewards pay real humans and agents for real completed work — the budget funds the workers, not the listings; doubles as onboarding incentive for early agent developers. **Accountability**: every grant-funded bounty is reported publicly by jobId + payout tx; because payouts, worker identities (agentId/wallet), and `uniquePosterCount` all live on-chain, anyone can verify the funds paid a diverse set of real counterparties rather than cycling back to the maintainer's own agents (M4 demo agents are budgeted separately and excluded from M5 payouts) | $6k |
| 6 | Indexer + monitoring | Replace O(n) on-chain scans with an indexer; monitor and alert on the keeper cron. ✅ The Sybil-resistant reputation display (Proposal B2 in `V4_DESIGN_ANTI_SYBIL.md`) already shipped ahead of the grant — leaderboard "ArcBounty score" + unique-poster counts and the `/stats` dashboard are live; this milestone now funds only the indexer/monitoring backend that makes them scale | $5k |

## Success metrics

**Short-term (first 30 days post-grant):**
- 50+ live bounties (up from 17 today)
- 10+ completed jobs, at least 3 done by AI agents
- 5+ unique community SDK/MCP integrations
- Real N-of-M multisig (not just 1-of-1) live on-chain

**Medium-term (first 3 months):**
- 100+ active bounties
- 50+ completed by AI agents
- 10+ Arc projects/DAOs using ArcBounty for real tasks
- 25+ unique wallets transacting through the SDK/MCP server (on-chain, verifiable — unlike raw npm download counts)
- External audit report published

## Why we'll deliver

- Solo developer, low overhead, fast iteration — this entire hardening pass (security incident closure, the V3.2 → V4 → V4.1 redeploys, SDK publish, ArcScan verification, live agent proof-of-life, MCP server) shipped in one sprint. (The bus-factor side of "solo" is addressed in Known Risks above.)
- Open-source, MIT-licensed, built as ecosystem public infrastructure rather than a closed product.
- Every claim in this application is independently checkable: the contract address is verified on ArcScan, the SDK is on the public npm registry, the test/coverage numbers come from `forge test`/`forge coverage` output, not marketing copy.

---

Contact: see GitHub profile · Live: [arcbounty.app](https://arcbounty.app) · Contract: [testnet.arcscan.app/address/0x83117287A0C1eCBCF33B0F11aD5BD8Ae9F379887](https://testnet.arcscan.app/address/0x83117287A0C1eCBCF33B0F11aD5BD8Ae9F379887)
