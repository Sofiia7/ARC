# ArcBounty — Arc Ecosystem Grant Application

**ArcBounty is a live reference marketplace for agentic work on Arc: ERC-8183 escrow, ERC-8004 identity, USDC-native settlement, and task-backed agent reputation.**

Requested amount: **$31,000 USDC** · Team: solo developer · Status: live on Arc Testnet

---

## The problem

AI agents can already do useful work, but they can't autonomously *earn* USDC for it. Existing bounty platforms (Gitcoin, Dework) aren't built for agents and run on expensive-gas chains. There's no on-chain venue where a human and an AI agent compete for the same job, on the same terms, with reputation that means something.

## Why Arc

- **USDC as native gas** — a worker holds one token: gets paid in it, pays gas in it. Micro-bounties from $1 are economically real.
- **Sub-second finality, ~$0.01 per transaction** — no "pending" limbo, no gas eating a $5 bounty.
- **ERC-8183 (AgenticCommerce) and ERC-8004 (Identity + Reputation) are already deployed and audited by the Arc team** — ArcBounty builds on them directly instead of writing its own escrow, cutting the project's own attack surface to a single ~560-line facade contract.

## Why Circle

This is a direct fit for the Agentic Economy Group's stated focus: agentic commerce and AI-mediated marketplaces on Arc. ArcBounty is the first open marketplace using **both** ERC-8183 and ERC-8004 together, with a public agent SDK, rather than a single-purpose demo. It's also a public good — any Arc protocol or DAO can post bounties programmatically, and any agent developer gets a working reference integration for free.

## What's live today

- **Frontend**: [arcbounty.app](https://arcbounty.app) — production, CSP/HSTS, real-time on-chain events, passkey login (Porto connector)
- **Agent SDK also supports Circle Developer-Controlled Wallets** — an agent can sign through Circle's MPC custody with zero private key in its process, not just Porto
- **Contract**: `BountyAdapter` V3.2 at [`0x5E7106382bA80c8805A570dEE4cB4bC321a8Ed83`](https://testnet.arcscan.app/address/0x5E7106382bA80c8805A570dEE4cB4bC321a8Ed83) — deployed and **source-verified** on ArcScan
- **SDK**: [`arcbounty-agent-sdk`](https://www.npmjs.com/package/arcbounty-agent-sdk) — published on npm, full poster/worker/arbitrator surface
- **GitHub**: `github.com/Sofiia7/ARC` (private repo — access available on request as part of this application)
- **Marketplace state**: 17 live bounties on testnet, across all 5 categories (dev, design, content, data, other)

## Proof of life — a real agent, not a mockup

An actual AI agent (not a human-operated wallet) completed the full lifecycle on the live V3.2 contract:

- **jobId `145613`**, **agentId `844730`** (raw private key) — took a bounty, submitted work, and was paid **0.99 USDC** of a 1 USDC reward (the difference is the 1% protocol fee, not a rounding artifact) through the canonical ERC-8183 escrow.
- This specifically exercises the payout path that used to be broken on the prior contract version (V3.1): the live Arc ERC-8004 reputation registry can revert on `giveFeedback`, which used to block payout to agent workers entirely. V3.2 wraps that call in `try/catch` so payout can never be blocked by a reputation-write failure — verified end-to-end on-chain, not just in a unit test.
- **A second, independent proof using a Circle Developer-Controlled Wallet** — **jobId `145786`**, **agentId `845036`**, wallet `0x3996…ba101` — ran the exact same register → take → submit → approve → pay cycle with no private key anywhere in the process, signing entirely through Circle's API/MPC custody. Paid **0.99 USDC** of 1 USDC, confirmed independently on-chain.

## Engineering discipline (verifiable, not just claimed)

- **60 unit tests + 2 stateful invariants** (62 total; +1 fork test against live Arc Testnet = 63 with an RPC configured), **8,192 fuzz calls, 0 reverts**
- **Coverage**: 97.6% lines / 94.9% statements / 91.4% functions on `BountyAdapter.sol` (`forge coverage --ir-minimum`)
- **Slither**: 0 findings (3 detector classes reviewed and triaged in `contracts/SLITHER.md`, not blanket-silenced)
- **CI**: green on every push — `forge fmt/build/test/snapshot`, Slither gate, a fork test against live Arc Testnet, frontend lint+build, SDK typecheck+build, and a docs-consistency + gitleaks gate

## Known risks — disclosed, not hidden

| Risk | Current state | Mitigation plan |
|---|---|---|
| **Arbitrator is a 1-of-1 Safe, not real multisig yet** | Moved from a raw EOA to a Safe (`0x4892…1BC6`, SafeL2 v1.4.1) — but it's still a single signer today | Milestone 1 below: add independent co-signers + raise the threshold inside the Safe (no further contract changes needed), then a decentralized-escalation path (Kleros/UMA) |
| **Circle Wallets — partially shipped** | Agent-side (Developer-Controlled Wallets) is live and verified (see proof-of-life above). The frontend still uses the Porto passkey-SCA connector for humans, not Circle's User-Controlled Wallets SDK | Milestone 3 below: fund the remaining User-Controlled Wallets flow for human posters/workers, plus Gas Station sponsorship |
| **ERC-8004 reputation can be a weak signal** | A recent empirical study ([arxiv.org/abs/2606.26028](https://arxiv.org/abs/2606.26028)) found 59–91% Sybil-pattern reviews in real ERC-8004 registries, with feedback often ungrounded in real transactions | ArcBounty's `giveFeedback` is called only by the adapter, only after a bounty is actually paid out with an evidence CID — reputation is task-backed by construction, not a free-form rating |
| **Arc mainnet is now "this summer" (2026), not an abstract future** | Testnet-only today | Roadmap explicitly scoped to land pre-mainnet hardening in lockstep with Arc's mainnet timeline |

## Requested amount, by milestone

**$31,000 USDC total**, tied to 6 verifiable milestones rather than a flat salary line:

| # | Milestone | Deliverable | Budget |
|---|---|---|---|
| 1 | Real multisig arbitrator + security runbook | ✅ Arbitrator already moved to a Safe (1-of-1); funds adding independent co-signers + raising the threshold, plus a documented dispute runbook | $4k |
| 2 | External audit | `BountyAdapter` audit (or audit contest), public report | $6k |
| 3 | Circle Wallets — frontend + Gas Station | ✅ Developer-controlled (agent-side) already shipped & verified; funds the remaining User-Controlled Wallets flow for humans + Gas Station sponsorship | $6k |
| 4 | 3 production demo agents | Real autonomous agents (translation, code review, data) running end-to-end | $5k |
| 5 | Public bounty liquidity | 50+ real testnet bounties funded by the grant (17 today) | $6k |
| 6 | Indexer / monitoring / keeper hardening | Replace O(n) on-chain scans with an indexer; monitor and alert on the keeper cron | $4k |

## Success metrics

**Short-term (first 30 days post-grant):**
- 50+ live bounties (up from 17 today)
- 10+ completed jobs, at least 3 done by AI agents
- 5+ unique community SDK integrations
- Real N-of-M multisig (not just 1-of-1) live on-chain

**Medium-term (first 3 months):**
- 100+ active bounties
- 50+ completed by AI agents
- 10+ Arc projects/DAOs using ArcBounty for real tasks
- SDK downloaded 500+ times from npm
- External audit report published

## Why we'll deliver

- Solo developer, low overhead, fast iteration — this entire hardening pass (security incident closure, V3.2 redeploy, SDK publish, ArcScan verification, live agent proof-of-life) shipped in one sprint.
- Open-source, MIT-licensed, built as ecosystem public infrastructure rather than a closed product.
- Every claim in this application is independently checkable: the contract address is verified on ArcScan, the SDK is on the public npm registry, the test/coverage numbers come from `forge test`/`forge coverage` output, not marketing copy.

---

Contact: see GitHub profile · Live: [arcbounty.app](https://arcbounty.app) · Contract: [testnet.arcscan.app/address/0x5E7106382bA80c8805A570dEE4cB4bC321a8Ed83](https://testnet.arcscan.app/address/0x5E7106382bA80c8805A570dEE4cB4bC321a8Ed83)
