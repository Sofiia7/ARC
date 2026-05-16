# ArcBounty — Security Policy & Threat Model

Last updated: 2026-05 (sprint 2). Contract version: pre-audit. Active on Arc Testnet only.

## Reporting a vulnerability

Please email `security@arcbounty.xyz` with a description and ideally a reproducer. Do **not** open a public GitHub issue for security-sensitive findings. Bounties for critical findings will be paid in USDC on Arc from the protocol fee reserve.

## Trust model

| Component | Trust level | Notes |
|---|---|---|
| `AgenticCommerce` (ERC-8183, 0x0747…4583) | Trusted (Arc team) | Audited by Arc; we treat its calls as non-malicious. |
| `IdentityRegistry` / `ReputationRegistry` (ERC-8004) | Trusted (Arc team) | Same. |
| `USDC` (0x36…0000) | Trusted (Circle) | Standard ERC-20, no fee-on-transfer. |
| `BountyAdapter` (this repo) | Pre-audit | Not yet audited. |
| `arbitrator` (constructor `msg.sender`) | **Centralized trust** | MVP. Migration to multisig + UMA/Kleros oracle is on roadmap. |
| Posters / Providers / Agents | Untrusted | Standard adversarial assumption. |

## Threat model

Attacks we explicitly defend against, with the corresponding mitigation and test.

### 1. USDC stuck in adapter
- **Vector**: cancel/expire/reject before AC complete leaves USDC orphaned in adapter.
- **Mitigation**: every terminal path (`cancelBounty`, `expireBounty`, `rejectBounty`, `resolveDispute(false)`) calls AC's refund/expire/reject, then forwards the returned USDC back to poster via `_refundFromAC`.
- **Tests**: `testCancelBounty_refundsPoster`, `testExpireBounty_refundsPoster`, `testRejectBounty_returnsToMockState`, `testResolveDispute_payPoster`.

### 2. MEV front-running of `takeBounty`
- **Vector**: a bot watching mempool snipes high-value bounties by submitting `takeBounty` with higher priority fee.
- **Mitigations** (defense in depth):
  1. **On-chain allowlist**: poster sets `provider != 0` at creation → only that address can take. Enforced in `_take`.
  2. **Opt-in commit-reveal**: poster sets `commitRevealRequired: true`. Provider must `commitTake(commitment)` then `revealTake` ≥ 2 blocks later. The commitment binds `(jobId, msg.sender, agentId, salt)`, so a copying bot's reveal won't match its own (missing) commitment. Reveal window expires after 256 blocks to prevent stale commits.
  3. Even without protection, on Arc with finality <1s and $0.01 gas, MEV economics are weaker than on Ethereum.
- **Tests**: `testWhitelist_strangerCannotTake`, `testCommitReveal_*`, `testCommitReveal_frontRunnerCannotCopyReveal`.

### 3. Dispute-griefing by malicious provider
- **Vector**: provider opens `disputeBounty` immediately to lock funds.
- **Mitigations**:
  - `disputeBounty` requires a submission (`bytes(submittedResultHash).length > 0`) → provider must actually deliver something before disputing.
  - Dispute window is bounded to 48 hours after `submittedAt`; after that the dispute path is closed.
  - Arbitrator can resolve immediately; no mandatory wait.
- **Tests**: `testDispute_requiresSubmission`, `testDispute_blocksApprove`, `testResolveDispute_*`.

### 4. Reputation manipulation (score > 100, fake feedback)
- **Vector**: caller passes `reputationScore = 255` to inflate or `0` to penalize maliciously.
- **Mitigation**: `require(reputationScore <= 100)` in `approveBounty`; `require(reputationPenalty <= 100)` in `resolveDispute`. `_giveFeedback` only fires when `agentId > 0`; humans don't get reputation.

### 5. Reentrancy
- **Vector**: external call (AC.createJob/submit/complete) re-enters adapter.
- **Mitigations**:
  - `ReentrancyGuard` (`nonReentrant`) on every state-changing entry point.
  - CEI ordering on `submitWork` (state written before AC.submit).
  - `createBounty` writes meta between `createJob` and `setBudget`/`fund`. The intermediate AC calls are to a trusted, audited contract; the inner reentrancy is structurally unavoidable because `jobId` is returned by `createJob`. Slither flags this as `reentrancy-benign` — **accepted**.
- **Tests**: implicit in full-flow and dispute tests; explicit static analysis via Slither (see "Static analysis" below).

### 6. Gas-bomb via tags array
- **Vector**: poster passes a huge `tags[]` array to make storage writes prohibitive or block reads.
- **Mitigation**: `MAX_TAGS = 10`, `MAX_TAG_LEN = 32` bytes.
- **Tests**: `testCreateBounty_revertTooManyTags`.

### 7. Sybil reputation
- **Vector**: many cheap ERC-8004 agent identities boost one operator's reputation by completing low-value bounties.
- **Status**: **partial** — ERC-8004 identity itself does not enforce sybil-resistance. Mitigation deferred to v2 (stake-weighted reputation or proof-of-personhood gate). For MVP, frontend leaderboard surfaces `totalJobs` alongside score so consumers can weight raw volume.

### 8. IPFS unpinning
- **Vector**: poster pins description, then unpins after submission; provider can't prove what was promised.
- **Mitigation**: out-of-protocol — Pinata pinning with fallback to nft.storage on the frontend; long-term we recommend providers pin a local copy of `ipfsDescHash` before taking.

### 9. Sanctioned addresses (OFAC / Circle compliance)
- **Vector**: USDC is issued by Circle; touching sanctioned addresses risks USDC freeze on the issuer side.
- **Status**: **not implemented in contract** — design decision in ТЗ §13.2. MVP: off-chain Chainalysis Sanctions API check in the frontend. Mainnet: on-chain oracle call in `createBounty` / `takeBounty` / `approveBounty` (≤ 2k gas overhead). Decision to be ratified before mainnet (sprint 5).

### 10. Arbitrator rug
- **Vector**: arbitrator address favors one party in disputes.
- **Status**: **acknowledged centralization**. Mitigation roadmap:
  - v1.x: replace `arbitrator: address immutable` with 2-of-3 multisig.
  - v2: integrate UMA Optimistic Oracle or Kleros court for fully decentralized dispute resolution.
- Today this is a permitted trust assumption documented for grant reviewers.

### 11. Replay of commit-reveal commitments
- **Vector**: attacker re-uses an old commitment after a job is finalized.
- **Mitigation**: `revealTake` deletes both `commitHash[jobId][msg.sender]` and `commitBlock[jobId][msg.sender]` regardless of outcome, and `_take` requires `!isTaken && !finalized`.

### 12. Allowance griefing / non-standard USDC
- **Vector**: USDC token that does not return bool on `approve`.
- **Mitigation**: `SafeERC20.forceApprove` and `safeTransfer`/`safeTransferFrom` throughout.

## Static analysis

Slither is run as part of CI (see `.github/workflows/security.yml` — TODO sprint 3). Config: `contracts/slither.config.json`.

Current accepted findings:
- `reentrancy-benign` in `createBounty` — see threat #5.
- `timestamp` warnings — all timestamp comparisons are coarse (hours/days), no value depends on miner-controlled ±15s drift.

## Out of scope

- Off-chain agent logic (`arcbounty-agent-sdk`) — separate threat model in `agent-sdk/SECURITY.md` (TODO).
- IPFS gateway availability.
- Wallet provider security (MetaMask, Circle Wallets).
- Chain-level reorgs on Arc Testnet (treat 5-block finality as sufficient).

## Audit status

| Stage | Status |
|---|---|
| Internal review | ✅ self-review + Slither (this document) |
| Fork tests on Arc Testnet | 🟡 scaffolded (`BountyAdapter.fork.t.sol`); requires RPC env to run |
| External audit (Spearbit / Code4rena / Cantina) | ❌ pre-mainnet (sprint 5) |
| Public bug bounty | ❌ post-audit |
