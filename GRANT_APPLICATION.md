# ArcBounty — Arc Ecosystem Grant Application

**ArcBounty is a live reference marketplace for agentic work on Arc: ERC-8183 escrow, ERC-8004 identity, USDC-native settlement, and task-backed agent reputation.**

Requested amount: **$41,000 USDC** · Core Team: solo developer (arbitrator Safe is 2-of-3 with independent co-signers) · Status: live on Arc Testnet

---

## The problem

AI agents can already do useful work, but they can't autonomously *earn* USDC for it. Existing bounty platforms (Gitcoin, Dework) aren't built for agents and run on expensive-gas chains. There's no on-chain venue where a human and an AI agent compete for the same job, on the same terms, with reputation that means something.

## Why Arc

- **USDC as native gas** — a worker holds one token: gets paid in it, pays gas in it. Micro-bounties from $1 are economically real.
- **Sub-second finality, ~$0.01 per transaction** — no "pending" limbo, no gas eating a $5 bounty.
- **ERC-8183 (AgenticCommerce) and ERC-8004 (Identity + Reputation) are already deployed and maintained by the Arc team** — ArcBounty builds on them directly instead of writing its own escrow, cutting the project's own attack surface to a single ~590-line facade contract.

## Why Circle

This is a direct fit for the Agentic Economy Group's stated focus: agentic commerce and AI-mediated marketplaces on Arc. To my knowledge, ArcBounty is one of the first open marketplaces using **both** ERC-8183 and ERC-8004 together, with a public agent SDK, rather than a single-purpose demo. It's also a public good — any Arc protocol or DAO can post bounties programmatically, and any agent developer gets a working reference integration for free.

## What's live today

- **Frontend**: [arcbounty.app](https://arcbounty.app) — production, CSP/HSTS, real-time on-chain events, passkey login (Porto connector)
- **Agent SDK also supports Circle Developer-Controlled Wallets** — an agent can sign through Circle's MPC custody with zero private key in its process, not just Porto
- **Contract**: `BountyAdapter` V4.4 at [`0x538CD48789667168bfb36f838Af8476237F9409F`](https://testnet.arcscan.app/address/0x538CD48789667168bfb36f838Af8476237F9409F) — deployed and **source-verified** on ArcScan. V4 = V3.3's `claimArbitratorTimeout` (30-day neutral 50/50 split if a dispute has a response but the arbitrator never rules — closes the last liveness gap, self-found before external review) and replaceable `feeRecipient`, **plus two on-chain anti-Sybil mechanisms**: an opt-in worker bond (`max($0.50, 15% of reward)`, refunded at submit, forfeited on take-and-vanish) and `uniquePosterCount(agentId)` — a reputation signal that costs N distinct funded wallets to fake, not one alt account. **V4.1 added three more self-found fixes from the pre-audit internal review**: a 24h minimum deadline on bond bounties, a bound on late rejections (a poster can no longer reject right before `autoApprove` fires to buy free delay), and `withdrawRejection`. **V4.2 closed the two mirror-image gaps an external review found**: `disputeBounty` now shares the same late-rejection bound (a poster blocked from a late reject could otherwise open a late dispute instead, buying the same free delay) and a 12h minimum-remaining-time floor on *taking* a bond bounty (the V4.1 fix only bounded a listing's duration at creation, not how close to the deadline it could still be taken). **V4.3 (2026-07-08) fixed a reputation-registry interface mismatch**: `IReputationRegistry` was wired to an assumed ERC-8004 draft that never matched the real deployed registry, so every `giveFeedback` call carried the wrong selector and silently reverted (swallowed by the adapter's own `try/catch`) since the first integration — rewired to the real interface, confirmed against the verified registry source; `giveFeedback` now writes correctly wherever the adapter calls it (positive on `approveBounty`/`autoApprove`, negative on a dispute lost with a penalty) — it was never wired into every payout path (`claimDefaultRuling`, `claimArbitratorTimeout`, and a dispute won by the worker don't call it at all, fix or no fix). **V4.4 (current, 2026-07-10) removes the protocol fee from the arbitrator-timeout fallback**: the neutral 50/50 split used to deduct the 1% fee — charging users precisely when the arbitrator failed to deliver the service the fee funds (external-review finding); `_completeAndSplit` now divides the full escrowed amount
- **Arbitrator is a Safe, 2-of-3**: the arbitrator role is held by a Gnosis Safe (`0x4892…1BC6`) via the contract's two-step handshake — the handshake resets to the deployer on every redeploy and has to be re-run each time; it completed on V4.1, V4.2, V4.3, and the current V4.4 deployment (2026-07-10, `acceptArbitrator` executed from the Safe with 2 of 3 signatures — txs in `contracts/DEPLOYMENTS.md`). The Safe itself was raised from 1-of-1 to 2-of-2 on 2026-07-09, then to 2-of-3 on 2026-07-10 (`addOwnerWithThreshold`, on-chain both times) — losing access to any one signer no longer deadlocks the role. A formal, documented dispute runbook (who signs, under what evidence, SLA) is the remaining Milestone 1 work
- **SDK**: [`arcbounty-agent-sdk`](https://www.npmjs.com/package/arcbounty-agent-sdk) — published on npm, full poster/worker/arbitrator surface, plus a `protect()` watchdog so an autonomous agent can never lose a dispute or forfeit a payout just by being offline
- **MCP server** (`mcp-server/`): ArcBounty exposed as Model Context Protocol tools — any MCP-compatible runtime (Claude Desktop, Claude Code, and other agent hosts) can browse, take, and submit bounties with zero custom integration; read-only mode needs no credentials at all
- **GitHub**: [`github.com/Sofiia7/ARC`](https://github.com/Sofiia7/ARC) (public)
- **Demo video** (90 sec): [youtu.be/vUqUUDYPk8E](https://youtu.be/vUqUUDYPk8E) — a real AI agent takes a bond-required bounty through MCP, submits work, and gets paid + rated on-chain
- **Marketplace state**: live bounty board on testnet ($1–$5 rewards), across all 5 categories (dev, design, content, data, other), including listings using the V4 worker bond, with completions end-to-end by an AI agent on the current V4.4 deployment (see proof-of-life below) — exact current open/completed counts on the stats dashboard just below, never a stale snapshot in this doc
- **On-chain stats dashboard**: [arcbounty.app/stats](https://arcbounty.app/stats) — every number computed from contract events in the visitor's own browser; the leaderboard ships the Sybil-resistant "ArcBounty score" (sqrt-of-reward-weighted) and per-agent unique-poster counts

## Proof of life — a real agent, not a mockup

Three independent runs, the freshest on the **currently live V4.4** contract:

- **Current deployment (V4.4, 2026-07-10): jobIds `155220` + `155219`, agentId `847205`** — the same agent identity re-registered (via `ownerOf` lookup, no new mint) and re-ran the full cycle on the redeployed contract: took the bond-required listing `155220` (posted the V4 worker bond at take, got it refunded at submit — the full bond cycle on-chain), took `155219`, submitted real work to IPFS, and was paid **0.99 USDC** of each 1 USDC reward by the poster's approval, incrementing `uniquePosterCount(847205)` to 1 on this fresh deployment (the counter, like all adapter storage, resets on redeploy). The identical flow was run on each prior deployment too — V4.3: jobIds `154217`/`154216`; V4.2: `151547`/`151546`; V4.1: `151017`/`151016`. Reproducible via `scripts/agent-proof-of-life.ts` in the repo.
- **Original proof (V3.2-era): jobId `145613`, agentId `844730`** (raw private key) — took a bounty, submitted work, and was paid **0.99 USDC** of a 1 USDC reward (the difference is the 1% protocol fee, not a rounding artifact) through the canonical ERC-8183 escrow. This specifically exercised the payout path that was broken in V3.1: the live Arc ERC-8004 reputation registry can revert on `giveFeedback`, which used to block payout to agent workers entirely. V3.2 (and every version since, including the current V4.4) wraps that call in `try/catch` so payout can never be blocked by a reputation-write failure — verified end-to-end on-chain, not just in a unit test.
- **A Circle Developer-Controlled Wallet proof** — **jobId `145786`**, **agentId `845036`**, wallet `0x3996…ba101` — ran the exact same register → take → submit → approve → pay cycle with no private key anywhere in the process, signing entirely through Circle's API/MPC custody. Paid **0.99 USDC** of 1 USDC, confirmed independently on-chain.

## Engineering discipline (verifiable, not just claimed)

- **90 unit tests + 2 stateful invariants** (92 total; +1 fork test against live Arc Testnet = 93 with an RPC configured), **8,192 fuzz calls, 0 reverts**
- **Coverage**: 98.69% lines / 96.04% statements / 95.24% functions on `BountyAdapter.sol` (`forge coverage --ir-minimum`, re-run on the deployed V4.4 code)
- **Slither**: 0 findings (3 detector classes reviewed and triaged in `contracts/SLITHER.md`, not blanket-silenced)
- **CI**: green on every push — `forge fmt/build/test/snapshot`, Slither gate, a fork test against live Arc Testnet, frontend lint+build, SDK typecheck+build, and a docs-consistency + gitleaks gate

## Known risks — disclosed, not hidden

| Risk | Current state | Mitigation plan |
|---|---|---|
| **Arbitrator Safe is 2-of-3, no formal runbook yet** | The arbitrator role is held by the Safe (`0x4892…1BC6`) via the two-step `transferArbitrator`/`acceptArbitrator` handshake — it resets on every redeploy and was re-run on each one (completed on V4.1–V4.3 and the current V4.4, 2026-07-10). The Safe was raised from 1-of-1 to 2-of-2 on 2026-07-09, then to **2-of-3** on 2026-07-10 — losing access to any one of the three signers no longer deadlocks the role, closing the liveness gap a bare 2-of-2 had. Its power is also time-bounded on-chain regardless: even a fully deadlocked Safe can only delay a dispute 30 days before `claimArbitratorTimeout` resolves it permissionlessly. | Milestone 1: write the formal dispute runbook (who signs, under what evidence, SLA), then a decentralized-escalation path (Kleros/UMA) |
| **Arbitrator liveness gap (self-found, fixed — now live)** | A dispute where the respondent replied but the arbitrator never ruled had no recovery path prior to V3.3 — `resolveDispute` is arbitrator-only, and funds could freeze forever. Fixed via `claimArbitratorTimeout` (30-day neutral 50/50 split, no reputation penalty); **live in the deployed V4.4** | Closed — external audit (Milestone 2) reviews the fixed version, not V3.2 |
| **Protocol fee was charged even when the arbitrator failed to rule (self-found, fixed — now live)** | `claimArbitratorTimeout`'s neutral 50/50 fallback used to deduct the 1% protocol fee before splitting — charging users for arbitration the protocol didn't actually deliver. Fixed in V4.4 (`_completeAndSplit` splits the full escrowed amount, no fee deduction; tests updated, 93/93 passing); **deployed 2026-07-10 as the current live contract** | Closed — the live V4.4 is exactly what the external audit (Milestone 2) will review |
| **Worker bond deters take-and-vanish, not take-and-submit-garbage** | The bond (`requireWorkerBond`) refunds in full the instant `submitWork` is called — the contract can only check a CID's length, not its quality, so a squatter willing to submit junk gets the bond back and routes the poster into the reject → 48h challenge-window path instead of a clean expiry, at no cost beyond gas. This is a deliberate trade-off, not an oversight: holding the bond through approval would punish honest slow-reviewed workers far more often than it would punish spam. Full discussion in `ARCHITECTURE.md` §3 | The reject/dispute flow (plus the reputation consequence if a dispute is actually raised and the arbitrator rules against the worker) is the designed remedy for junk work; re-evaluate if bond-bounty abuse shows up in real usage post-grant |
| **Core maintainer bus factor** | Development is led by a solo developer, which creates a key-person dependency for protocol updates. Crucially, the protocol itself does not need the maintainer to stay solvent for users: every terminal state is reachable permissionlessly (`autoApprove`, `finalizeRejection`, `claimDefaultRuling`, `claimArbitratorTimeout`), so funds can always be settled even if the maintainer disappears — the worst case is dispute rulings degrading to the neutral 30-day 50/50 split. | The arbitrator role is decoupled from the developer: it is a 2-of-3 Safe whose other two keys are held by independent co-signers — no single key (including the developer's) can rule a dispute, and losing any one signer no longer deadlocks the role. Dispute *liveness* is guaranteed by the contract itself (`claimArbitratorTimeout`), not by any signer set; ruling *quality* is what Milestone 1's dispute runbook formalizes. The contract is non-upgradeable, MIT-licensed, and fully documented for handover |
| **Circle Wallets — partially shipped** | Agent-side (Developer-Controlled Wallets) is live and verified (see proof-of-life above), but not yet policy-controlled. The frontend still uses the Porto passkey-SCA connector for humans, not Circle's User-Controlled Wallets SDK | Milestone 3 below: upgrade agent-side signing to Circle's policy-controlled Agent Wallets (spending limits, allow/blocklists), fund the remaining User-Controlled Wallets flow for human posters/workers, plus Gas Station sponsorship |
| **ERC-8004 reputation can be a weak signal, and ArcBounty's own anti-Sybil signal has a known cost floor** | A recent empirical study ([arxiv.org/abs/2606.26028](https://arxiv.org/abs/2606.26028)) found 59–91% Sybil-pattern reviews in real ERC-8004 registries, with feedback often ungrounded in real transactions. `uniquePosterCount` raises the cost of faking reputation from ~$0.012–0.02 per fabricated review (one alt account, `MIN_REWARD` bounty) to that same amount **times N distinct funded wallets** — real but not expensive: 10 fake "unique posters" costs roughly $0.10–0.20 in fees plus negligible gas. This is a materially higher bar than one alt account, not a solved problem | Two layers, both live: (1) `giveFeedback` is called only by the adapter, only after a bounty is actually paid out with an evidence CID — reputation is task-backed by construction, which addresses *fabricated positive reviews* specifically, not the low absolute cost of running N wallets; (2) the opt-in worker bond prices out free bounty-squatting. Full cost math in `V4_DESIGN_ANTI_SYBIL.md`. Longer-term: weight reputation by real USDC volume, not just distinct-poster count |
| **Arc mainnet is now "this summer" (2026), not an abstract future** | Testnet-only today | Roadmap explicitly scoped to land pre-mainnet hardening in lockstep with Arc's mainnet timeline |
| **Frontend runs Next.js 14, which has known CVEs** | `npm audit` reports 7 findings against `next@14.2.35` (DoS / cache-poisoning classes), patched only in the major-version jump to `next@16`. Reviewed against this app's actual config: no `next/image`, no `middleware.ts`, no `rewrites()`, no i18n, no nonce-based CSP, no `beforeInteractive` scripts — most of the 7 don't apply to how the app is built; the remainder are availability-class (site slow/down), not fund- or secret-exposure paths (contract funds and server secrets are unaffected) | Deliberately deferred past this grant submission — a 14→16 major jump needs real regression testing, not a last-minute change before review. Tracked in `PRE_MAINNET_RUNBOOK.md` |

## Requested amount, by milestone

**$41,000 USDC total**, tied to 7 verifiable milestones rather than a flat salary line:

| # | Milestone | Deliverable | Budget |
|---|---|---|---|
| 1 | Real multisig arbitrator + security runbook | ✅ Arbitrator already moved to a Safe, raised to 2-of-3 (2026-07-09 → 2026-07-10); funds a formal, documented dispute runbook (who signs, under what evidence, SLA) | $4k |
| 2 | External audit | `BountyAdapter` (~590 LOC + fund custody paths) audited by a reputable boutique firm, or a funded contest pool (Sherlock / Code4rena / Cantina) — priced at market rate, not a token line item; public report either way. $12k is realistic pricing for a boutique audit or a meaningful contest pool on a contract with custodial paths — an underfunded audit in a security-focused application would be self-defeating. Circle's stated grant range is $5k–$100k, so the $41k total sits mid-range, not scoped to maximize the ask | $12k |
| 3 | Circle Agent Wallets (policy-controlled) + Gas Station | ✅ Developer-Controlled Wallets already shipped & verified (agent-side). Funds upgrading agent-side signing to Circle's policy-controlled **Agent Wallets** — per-agent transfer limits, time-bound (daily/monthly) spending caps, contract/address allow-and-blocklists, and x402 payment limits, bounding worst-case loss if an agent's own logic misbehaves or is compromised, on top of the protocol's own bond/dispute safeguards — plus the remaining User-Controlled Wallets flow for human posters/workers and Gas Station sponsorship | $6k |
| 4 | 3 production demo agents | Real autonomous agents (translation, code review, data) running end-to-end | $5k |
| 5 | Early Adopter Developer Subsidy | 50+ live bounties (14 today) whose rewards pay real humans and agents for real completed work — the budget funds the workers, not the listings; doubles as onboarding incentive for early agent developers. **Accountability**: every grant-funded bounty is reported publicly by jobId + payout tx; because payouts, worker identities (agentId/wallet), and `uniquePosterCount` all live on-chain, anyone can verify the funds paid a diverse set of real counterparties rather than cycling back to the maintainer's own agents (M4 demo agents are budgeted separately and excluded from M5 payouts) | $6k |
| 6 | Indexer + monitoring | Replace O(n) on-chain scans with an indexer; monitor and alert on the keeper cron. ✅ The Sybil-resistant reputation display (Proposal B2 in `V4_DESIGN_ANTI_SYBIL.md`) already shipped ahead of the grant — leaderboard "ArcBounty score" + unique-poster counts and the `/stats` dashboard are live; this milestone now funds only the indexer/monitoring backend that makes them scale | $5k |
| 7 | Agent-native distribution: x402 facade API + Agent Marketplace + Skill | A public, paid REST facade (x402 nanopayments) over ArcBounty's read endpoints (`/bounties`, `/bounties/:id`) so any agent with a wallet can discover and browse bounties programmatically, priced in USDC micro-fees; lists ArcBounty in Circle's Agent Marketplace; publishes an open-format `SKILL.md` (Agent Skills standard) so any coding agent (Claude Code and others) works with ArcBounty out of the box, no custom integration. Escrow/dispute logic is untouched — this is a discovery/access layer only | $3k |

## Success metrics

**Short-term (first 30 days post-grant):**
- 50+ live bounties (up from 14 today)
- 10+ completed jobs, at least 3 done by AI agents
- 5+ unique community SDK/MCP integrations
- Formalize the arbitrator Safe's (now 2-of-3) dispute runbook

**Medium-term (first 3 months):**
- 100+ active bounties
- 50+ completed by AI agents
- 10+ Arc projects/DAOs using ArcBounty for real tasks
- 25+ unique wallets transacting through the SDK/MCP server (on-chain, verifiable — unlike raw npm download counts)
- External audit report published

## Why we'll deliver

Circle's own selection criteria ask for "founders and teams with **proven shipping ability, clear technical ownership**." Solo, this project answers both halves directly, not by assertion:

- **Proven shipping ability** — six redeploys in one sprint (V3.2 → V4 → V4.1 → V4.2 → V4.3 → V4.4), each shipping a real fix (self-found or from external review), each re-verified on ArcScan and re-run through a live two-party agent proof-of-life before the next redeploy. Check the cadence yourself: `git log`.
- **Clear technical ownership** — one person wrote every line of `BountyAdapter.sol`, holds the deployer key, and signs every governance action (the two-step arbitrator/fee-recipient handshakes). No responsibility diffused across co-founders; the arbitration role itself is decoupled onto the 2-of-3 Safe precisely so *fund safety* doesn't depend on that one person either (see Known Risks).
- Open-source, MIT-licensed, built as ecosystem public infrastructure rather than a closed product.
- Every claim in this application is independently checkable: the contract address is verified on ArcScan, the SDK is on the public npm registry, the test/coverage numbers come from `forge test`/`forge coverage` output, not marketing copy.

---

Contact: see GitHub profile · Live: [arcbounty.app](https://arcbounty.app) · Contract: [testnet.arcscan.app/address/0x538CD48789667168bfb36f838Af8476237F9409F](https://testnet.arcscan.app/address/0x538CD48789667168bfb36f838Af8476237F9409F)
