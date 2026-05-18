# Arc Ecosystem Grant — Application Letter

**Project**: ArcBounty
**Applicant**: [your name / handle]
**Contact**: [email]
**Repository**: https://github.com/Sofiia7/ARC
**Open PR (current work)**: https://github.com/Sofiia7/ARC/pull/1
**Requested amount**: $48,000 USDC, 8-week milestone-gated schedule

---

Dear Arc Ecosystem Grants Committee,

ArcBounty is a public-good bounty board for Arc, built strictly on top of ERC-8183 (AgenticCommerce) and ERC-8004 (Identity + Reputation). We don't write our own escrow logic — your audited contracts at `0x0747…4583` handle the money. We write what's missing: a frontend, a TypeScript SDK, and a thin facade that adds categories, dispute machinery, and reputation feedback. The whole adapter is ~370 lines of Solidity, MIT-licensed, with a 62/62 forge test suite, Slither in CI, and a deployment runbook in `AUDIT.md`.

What makes ArcBounty different from the existing samples and from generic L2 bounty boards is that **a human freelancer and an autonomous AI agent compete for the same job, with the same UI, the same on-chain reputation, and the same payout path**. The agent doesn't need a special "API" — it just uses the same contract calls a wallet user makes, wrapped in a tiny SDK that abstracts viem.

## Why we're submitting now

Most grant applications at this stage are slideware. We're submitting an audit-prep package:

- `contracts/src/BountyAdapter.sol` — production-quality, no upgradeable proxies, OZ-based safety primitives.
- `contracts/test/BountyAdapter.t.sol` — 62 unit tests, plus a `BountyAdapter.fork.t.sol` that runs against the live Arc Testnet contracts (skipped gracefully when no RPC env is set).
- `.github/workflows/security.yml` — runs forge build/test/coverage, `forge snapshot --check`, and Slither `--fail-medium` on every PR.
- `SECURITY.md` — threat model with 12 attack categories, each with mitigation and test references.
- `AUDIT.md` — 8 lifecycle invariants, a money-flow invariant, access-control matrix, accepted findings, 6 properties for the auditor, and a step-by-step deployment runbook.
- `docs/economics.md` — protocol fee rationale (1 % flat, hard-capped at 10 %), break-even analysis, fee-evolution roadmap.

We don't want the committee to fund a hope. We want the committee to fund the **next two steps**: an external audit, and the mainnet migration with a multisig arbitrator + Chainalysis sanctions oracle wired in.

## How we use the $48,000

| Bucket | Amount | Outcome |
|---|---|---|
| **Developer compensation** (320 h over 8 weeks @ $50/h) | **$16,000** | Engineering capacity to deliver everything below. Includes sprint planning, audit-finding remediation, testnet ops, mainnet migration, and reactive bugfixes for first 60 days post-launch |
| External audit (Spearbit Lite / Code4rena Lite / Cantina) | $15,000 | Published audit report, all High/Medium findings addressed in a follow-up PR |
| Engineering services / paid integrations (Circle Wallets connector, Chainalysis oracle subscription, multisig setup, Sentry, Pinata Pro) | $7,000 | Mainnet deployment with `arbitrator` on a 2/3 Safe, `sanctionsOracle` set to the canonical Chainalysis address, live monitoring |
| Reference agents (translation, code-review, design-to-code) + community agent-builder bounty pool | $6,000 | 3 reference agents earning real USDC on mainnet, plus a $1k pool that pays community devs to publish more |
| Bootstrap bounty pool (poster-side seed) | $3,000 | The marketplace launches with live demand, not an empty grid |
| Maintenance (expiry-runner gas + IPFS pinning) | $1,000 | 6 months of zero-touch operation |

We don't ask for revenue share or fee subsidies — the protocol fee (1 % at create time) is the long-term sustainability mechanism. The grant funds the path from "audit-ready" to "live on mainnet with users".

### A note on the developer line

The five sprints summarised below were delivered without any compensation; that's ~8 weeks of full-time work already on the table as a public good. Asking for developer pay for the next 8 weeks is what makes the timeline real — otherwise audit-finding remediation, mainnet ops, and the inevitable post-launch bugfix cycle compete with paid work and slip. $50/h is well below market for Solidity / TypeScript engineers with audit-prep experience (rate cards usually start at $80–150/h); we kept it deliberately modest because we want the grant to stretch across audit + ecosystem seeding + a real launch, not just headcount.

## Deliverables and acceptance criteria

After 8 weeks we'll have:

1. **Audit complete**, report published in the repo, all High/Medium addressed (verifiable in commit history).
2. **Mainnet contract deployed**, with arbitrator pointing to a public multisig (verifiable on the eventual Arcscan mainnet — Arc itself hasn't launched mainnet yet; we deploy in lockstep when it does).
3. **≥ 3 reference AI agents live**, each having earned at least $20 USDC across multiple bounties (verifiable on-chain via `BountyCompleted` events).
4. **≥ 30 completed bounties**, of which **≥ 10 by AI agents**, in the first 30 days post-launch (matches TZ §11 short-term metrics).
5. **Public metrics dashboard** counting bounties / agents / GMV from on-chain events.

**Current state (testnet, today)**: live two-wallet cycle proven on Arc Testnet — poster `0xdf5C…2c6` posted a 3 USDC bounty; an independent worker wallet `0x6543…6115` took it, submitted, and received **2.964458 USDC** via the canonical ERC-8183 escrow (jobId 24700, ~98.8 % of face value after our 1 % fee and the ~0.18 % AC platform fee). Public frontend at https://arcbounty-eight.vercel.app, adapter `0x5b776bcbce35379ef6cf376ec32264d41d871ec3`. All four transaction hashes (createBounty, takeBounty by worker wallet, submitWork, approveBounty payout) are in `README.md` and `pitch_deck.md` with direct Arcscan links.

If we miss any deliverable, unspent funds return to the grant treasury — the contract for that is just a 2/3 multisig with both Arc Foundation and our team as signers; happy to wire it as a streaming grant for full transparency.

## What we already shipped (without grant funding)

Six sprints of work, summarized in PR #1 on the repo:

- Sprint 0: fixed compilation, MIT licence, KPI retention metrics in the spec.
- Sprint 1: full lifecycle refactor — atomic create-and-fund, refund paths, `forceApprove`, validations, dispute window.
- Sprint 2: Slither + fork tests + SECURITY.md + gas snapshot + MEV protection (whitelist + commit-reveal).
- Sprint 3: live UI for dispute / autoApprove / commit-reveal / score input, live updates via `watchContractEvent`, CI workflow, Circle Wallets scaffold.
- Sprint 4: SDK helpers (`subscribeToNewBounties`, `commitAndReveal`), permissionless expiry-runner example, bounty description JSON schema v1.0.
- Sprint 5: mutable arbitrator (2-step transfer), optional sanctions oracle, ValidationRegistry removed from configs, README/AUDIT/economics package.
- Sprint 6: lifecycle rewritten to **variant B+** after reading the real ERC-8183 implementation source on Arcscan and finding three undocumented access-control constraints (`setBudget` callable only by AC.provider, `fund` only by AC.client, `complete` only by AC.evaluator). The adapter now takes all three AC roles and forwards payout to the real worker via balance-delta accounting. **Live end-to-end smoke ran on Arc Testnet**: adapter `0x5b776bcbce35379ef6cf376ec32264d41d871ec3`, jobId 21377, four successful txes, provider received 1.977174 USDC from the canonical AC escrow.

That's roughly 10 weeks of one engineer's time, **already on the table** as a public good. The grant pays for the parts only money can buy: an external audit, a real Chainalysis subscription, and a small bootstrap pool — plus the next 8 weeks of engineering through Arc's mainnet launch.

## Two questions for the committee

1. **Audit firm preference?** Spearbit Lite typically runs $12–18k for ~400 LOC; Cantina and Code4rena Lite have similar ranges. Do you have a preferred provider or scope template you want us to use?
2. **Mainnet timing.** We can ship to mainnet within 2 weeks of audit completion. Is there a coordinated Arc mainnet launch window we should align with?

Thank you for reading. Everything we've claimed in this letter is reproducible from the repo head — run `forge test` in `contracts/`, run `slither` with our config, walk the AUDIT.md runbook on Testnet, or just open `SECURITY.md`. Happy to schedule a 20-minute call to walk through any of it.

— [your name]
[date]
