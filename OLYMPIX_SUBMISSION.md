# OLYMPIX_SUBMISSION

## 1. Summary

| Field | Value |
|---|---|
| Project | ArcBounty (repository `Sofiia7/ARC`), a USDC bounty board for humans and AI agents |
| Date | 2026-11-23 |
| Review level | Max: Critical, High, Medium, Low and Informational, plus Slither with no detector exclusions |
| Solidity compiler | solc 0.8.30, `via_ir = true`, optimizer 200 runs, EVM `cancun` (`contracts/foundry.toml`). `BountyAdapter.sol` pins `pragma solidity 0.8.30`; `AgenticCommerce.sol` declares `^0.8.28` and is compiled with 0.8.30 |
| Reviewed commit | `1d5a315` (origin/main, 2026-11-12). The Arc contracts have not changed since `6f465a6` (2026-09-17, formatting only after the deploy commit `0859ff6`) |
| Fixed commit | Branch `chore/olympix-pre-audit`, the commit that adds this file (its hash is given in the Olympix form) |
| Network | Arc mainnet, chain id 5042 |

**What is deployed (Arc mainnet).** Source of all three is an exact Sourcify match of the reviewed commit (creation and runtime bytecode).

| Contract | Address | Upgradeable |
|---|---|---|
| BountyAdapter V4.7 | `0x73c617e808ED5c7Ca41413DFC6EE940dDcBb0b8D` | No |
| AgenticCommerce escrow (ERC1967 proxy, UUPS) | `0x64cA39Fc57315D0D488acCaC07c37C6E841CD058` | Yes, by the Safe |
| AgenticCommerce implementation | `0x3BD209158283FE1cd81054b1c91Ea723f1eBB251` | - |
| Owner, arbitrator, fee recipient of the adapter role set; escrow admin | Safe 2-of-3 `0x74678c072Ca546f11466CD44eB7e21730a312a54` | - |
| Deployer | `0xde427f3967cc7a0BF7A9F891195760cCffC82edA` (no role left) | - |

External dependencies the adapter calls: Arc USDC `0x3600000000000000000000000000000000000000` (ERC-20 interface, 6 decimals, over native USDC), ERC-8004 IdentityRegistry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` and ReputationRegistry `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` (upgradeable by their own owners).

**Scope.** Every production contract that is deployed on Arc mainnet. The repository also holds `contracts/src/monad/` (NadBounty V4.8.1, a separate product on Monad, not deployed on Arc); it is out of scope for this submission. Tests, mocks, deploy scripts and `lib/` are excluded as the prompt requires.

**Files.** SHA-256 of the file content as stored in git (LF line endings). A Windows checkout with `core.autocrlf=true` has CRLF files with different hashes; `git show <commit>:<path> | sha256sum` reproduces these.

| Path | SHA-256 before the review | SHA-256 after the fixes |
|---|---|---|
| `contracts/src/BountyAdapter.sol` | `6166d14c12f97a64f5d8ad4d8438289d5371d0834efe5a251175fa1c1d3c0cef` | `c6145a9ecded213def8efb64410577f33042ab61518b03e228e0151173bfbb96` |
| `contracts/src/base/AgenticCommerce.sol` | `98586787d67da201c8f63efcfad3f87f0a5170f5f08daf74088f037a0640ca9a` | unchanged |
| `contracts/src/base/interfaces/IACPHook.sol` | `fba2717e6cea7dfa71ca010d8bb71bd376cac0db6d98892c2a7a926363f025ad` | unchanged |
| `contracts/src/interfaces/IAgenticCommerce.sol` | `714d0f63db5f5abf2bd7e0f696aa42164e36e9803b85922061b1644337184eb5` | unchanged |
| `contracts/src/interfaces/IIdentityRegistry.sol` | `c88c3e24fed39a1bd0fe072545980c75fdeda156d24d7caca56c1d254aafa688` | unchanged |
| `contracts/src/interfaces/IReputationRegistry.sol` | `2d78dc10599c683f5741fe1585d6eacd446afa4ea23f4a09205b42ee4196b5c0` | unchanged |

**Behavior changes made by the fixes** (all in `BountyAdapter.sol`; the escrow and the interfaces are untouched):

1. F-09: every reputation write now needs at least `FEEDBACK_GAS_FLOOR` (500,000) gas left. `approveBounty`, `autoApprove`, `reconcileExpiredEscrow` (worker branch) and `resolveDispute` with a penalty revert with "gas below feedback floor" when called with too little gas for an agent job, instead of settling with the write starved. Jobs without an agent (`agentId == 0`) are unaffected.
2. F-10: a reputation write that reverts now emits `ReputationWriteFailed(jobId, agentId, value)`. Payouts are still never blocked by the registry.
3. F-12: `_payOrPark` decodes the transfer return word as `uint256` and treats only `1` as paid. A token that returns a 32-byte word other than 0 or 1 now has the amount parked instead of reverting the settlement. No effect with Arc USDC.
4. F-16: `submitWork` reverts with "resolved" on a resolved bounty. Unreachable before the change (every resolved, taken, unsubmitted bounty is past its deadline).
5. ABI additions only: the constant `FEEDBACK_GAS_FLOOR` and the event `ReputationWriteFailed`. No function was removed or changed in signature.
6. Comments corrected (F-12) and long dashes replaced in comments; no bytecode effect beyond the metadata hash.

**Deployment note.** The live adapter is not upgradeable. These fixes exist in source only; the contracts on Arc mainnet keep running the reviewed commit until a new adapter is deployed, which is a separate decision. Live state read on 2026-11-23: the adapter and the escrow both hold 0 USDC, 16 bounties have been created, both escrow fees are 0, the adapter is not paused, `maxBountyAmount` is 500 USDC.

## 2. Findings

Line numbers refer to the reviewed commit `1d5a315`. BA = `contracts/src/BountyAdapter.sol`, AC = `contracts/src/base/AgenticCommerce.sol`. Slither rows group all results of one detector; the locations are listed in the row.

| ID | Severity | Source | Title | File and line | Status | Fix, or why it is still open |
|---|---|---|---|---|---|---|
| F-01 | Medium | review | Escrow `fund()` has no price guard: the provider can raise the budget after the client approved and before `fund` lands | AC 204-218, 220-238 | Open | Affects only jobs created directly on the escrow, not adapter jobs (the adapter is the provider and approves exactly the reward; tested). A fix (`fund` with an expected budget) needs an escrow upgrade by the Safe: owner decision |
| F-02 | Medium | review | An agent owner can make the registry refuse any feedback the adapter writes, including an arbitrator penalty, by approving the adapter on its ERC-8004 NFT; the adapter swallows the revert | BA 955-974 (also 577-588, 609-620, 824-835); registry `giveFeedback` self-feedback check | Open | Confirmed on an Arc mainnet fork. The failure is now logged (F-10), so it is visible on chain, but the penalty is still not recorded. A real fix (adapter-local penalty record, or refusing such agents) changes behavior: owner decision |
| F-03 | Low | review | A worker can open a dispute right after submitting; if the poster does not answer within 48 hours the worker is paid by default, which shortens the 14-day review to 48 hours | BA 843-867, 905-920 | Open | Already disclosed as L-6 in SECURITY.md (reported 2026-10-22). A minimum wait before a worker dispute changes behavior: owner decision for the next adapter |
| F-04 | Low | review | A job whose poster also owns the working agent still earns ERC-8004 feedback and unique-poster credit | BA 560-591, 1243-1248 | Open | Fixed in the Monad V4.8.1 adapter (`_isSelfDealt`), not in V4.7. Porting it changes who earns reputation: owner decision |
| F-05 | Low | review | Losses by silence never reach reputation: a finalized rejection, a default ruling for the poster and take-and-vanish write no feedback | BA 682-693, 707-729, 905-920 | Open | Only arbitrated losses are penalized. Adding a penalty on these paths changes behavior: owner decision |
| F-06 | Low | review | `reconcileExpiredEscrow` trusts the escrow's reported status and pays from the adapter's pooled balance, so a faulty or malicious escrow upgrade could pay out other bounties' untaken rewards | BA 760-839 (764) | Open | Requires the escrow's upgrade authority (the Safe). Fixes (accounting of custodied funds, or reconcile measuring its own refund) change behavior: owner decision |
| F-07 | Low | review | `getOpenBounties` scans every bounty ever listed; about 7,300 cancelled listings push the view past a 50M-gas `eth_call` cap | BA 1159-1185 | Open | Settlement is unaffected; listing and agent discovery are. Needs an indexer or an on-chain open set: design decision |
| F-08 | Low | review | Escrow fee setters emit no event and apply to jobs that are already funded; a non-zero fee breaks the adapter's zero-fee assumption (a 100% fee pays the worker nothing) | AC 126-136, 257-288 | Open | Admin-only. Events or per-job fee snapshots need an escrow upgrade. Operating rule today: both fees stay 0 |
| F-09 | Informational | review | Reputation writes run in try/catch, so a write that runs out of gas would be skipped while the settlement goes through | BA 577-588, 609-620, 824-835, 963-973 | Fixed | Not exploitable at today's registry cost (163,616 gas measured; no gas limit settles with the write starved), exploitable at about 270,000. Added a 500,000 gas floor before each write |
| F-10 | Informational | review | A failed reputation write leaves no trace on chain (empty catch, no event) | BA 587, 619, 834, 973 | Fixed | Every catch now emits `ReputationWriteFailed` |
| F-11 | Informational | review | Agent #0 exists on Arc mainnet but `agentId == 0` means "no agent", so agent #0 can never take an agent-only bounty or earn feedback | BA 492-507 | Open | Encoding the id differently changes the interface: owner decision for the next adapter |
| F-12 | Informational | review | Comments that contradict the code (title version, the V4.5 note about Arc, the whitelisted-provider rule, the reconcile branch comment, the cast comment) and `_payOrPark` reverting on a non-canonical `true` contrary to its own comment | BA 10, 102-107, 269, 799-802, 1004, 1216-1218 | Fixed | Comments corrected; return word decoded as `uint256 == 1` |
| F-13 | Informational | review | No maximum deadline; a taken bounty without a bond can be squatted until its deadline | BA 428, 482, 698 | Open | A cap changes what posters can create: owner decision |
| F-14 | Informational | review | After deadline + 90 days anyone can force the escrow refund; `reconcileExpiredEscrow` then pays the worker in full with no protocol fee and with reputation credit | BA 809-836; AC 318-332 | Accepted risk | Designed in V4.7 (no fee for the protocol's own liveness failure); the keeper settles long before 90 days |
| F-15 | Informational | review | Two-step role transfers have no explicit cancel | BA 1075-1129 | Accepted risk | A wrong nominee can be replaced by nominating again |
| F-16 | Informational | review | `submitWork` has no `resolved` guard | BA 534-558 | Fixed | Added `require(!meta.resolved)` |
| F-17 | Informational | review | The Safe can upgrade the escrow that holds funded jobs instantly, with no timelock | AC 122 | Accepted risk | Documented trust assumption (SECURITY.md); a timelock is an operations decision |
| F-18 | Informational | review | Nothing in the repository checks that an escrow upgrade keeps the storage layout and enum values the immutable adapter relies on | AC 44-73 | Fixed | Added a test that pins the slots, the Job field order and the enum values |
| F-19 | Informational | review | If escrow fees were ever enabled, a blacklisted platform treasury would make every `complete()` revert | AC 273-275 | Accepted risk | Unreachable while both fees are 0 |
| F-20 | Informational | review | Removing a hook from the whitelist does not detach it from existing jobs | AC 146-156, 169-172 | Accepted risk | Adapter jobs use no hook |
| F-21 | Informational | review | `jobHasBudget` is written but never read; `fund` accepts a budget that was never set | AC 73, 215, 220-238 | Accepted risk | Only a client can grief its own job; the adapter always sets the budget |
| F-22 | Informational | review | Escrow event gaps: no platform fee payout event, `PaymentReleased` even when net is 0 | AC 273-285 | Accepted risk | Nothing indexes escrow events; would need an upgrade |
| F-23 | Informational | review | Escrow has no sweep, does not measure what `fund` received, and has no upper bound on `expiredAt` | AC 168, 233 | Accepted risk | Arc USDC has no transfer fee; adapter jobs use deadline + 90 days |
| F-24 | Informational | review | `humanOnly` and `agentOnly` are best effort: an agent can omit its id, and anyone can register an identity | BA 492-507 | Accepted risk | Cannot be proven on chain; documented |
| F-25 | High | Slither | `arbitrary-send-erc20`: `fund` calls `safeTransferFrom(job.client, ...)` | AC 233 | False positive | `fund` requires `msg.sender == job.client` (AC 224) |
| F-26 | Medium | Slither | `incorrect-equality` (4 results): `amount == 0` and `ret.length` checks in `_payOrPark`, `received == 0` in `_completeAndForward` and `_completeAndSplit` | BA 1000, 1004, 1021, 1047 | False positive | Exact checks on amounts and return length are intended |
| F-27 | Medium | Slither | `reentrancy-no-eth` (10 results): BA `_completeAndForward`, `_completeAndSplit`, `expireBounty`, `reconcileExpiredEscrow` (2); AC `complete`, `reject`, `submit`, `fund`, `setBudget` | BA 707-729, 760-839, 1017-1052; AC 204-316 | False positive | Every state-changing entry point is `nonReentrant` in both contracts, terminal flags are set before external calls, USDC has no callbacks and adapter jobs have no hook |
| F-28 | Low | Slither | `reentrancy-benign` (6 results): BA `createBounty`, `approveBounty`, `autoApprove`, `reconcileExpiredEscrow`, `_payOrPark`; AC `setBudget` | BA 424-471, 560-624, 760-839, 999-1012; AC 204-218 | False positive | Same guards as F-27 |
| F-29 | Low | Slither | `timestamp` (22 results): deadline and window comparisons in 18 adapter functions and in AC `createJob`, `fund`, `claimRefund` | BA lifecycle functions; AC 168, 226, 322 | Accepted risk | Windows are 12 hours to 90 days; Arc mainnet's clock matched wall-clock time to the second (2026-11-23) |
| F-30 | Informational | Slither | `low-level-calls` in `_payOrPark` | BA 1003 | Accepted risk | Deliberate: a reverting transfer must park, not revert (V4.6) |
| F-31 | Informational | Slither | `missing-inheritance`: AgenticCommerce does not inherit IAgenticCommerce | AC 39 | Accepted risk | The interface is the adapter's view of the escrow; its compatibility is pinned by the F-18 test |

## 3. Tests

Commands, run from `contracts/` with Foundry 1.7.1:

```
forge test --no-match-path 'test/*Fork*'
forge test --match-path test/OlympixPreAudit20261123.t.sol --match-test F02_fork --fork-url https://rpc.blockdaemon.mainnet.arc.io
```

Results, 2026-11-23, on the fixed source:

| Run | Passed | Failed | Skipped |
|---|---|---|---|
| `forge test --no-match-path 'test/*Fork*'` (20 suites) | 571 | 0 | 0 |
| Arc mainnet fork, F-02 | 2 | 0 | 0 |

The 571 are the 543 tests that already existed (all of them also passed on the reviewed source before any change) plus the 28 in the new file; the two F-02 fork tests are among the 28 and return early when no fork is configured. The 543 include the Monad V4.8 suites, which are out of scope but share the test run. Test files: `test/BountyAdapter.t.sol`, `test/BountyAdapterInvariant.t.sol`, `test/MainnetAudit20260907.t.sol`, `test/OlympixPreAudit20261123.t.sol` for the in-scope contracts; fork suites (`*Fork*`) need an RPC and were not part of the first run. `contracts/.gas-snapshot` was refreshed for the CI gas check, since the fixed adapter's gas changed.

New test file: `contracts/test/OlympixPreAudit20261123.t.sol`, against the real repository AgenticCommerce behind an ERC1967 proxy. Its reputation registry mock costs what the live registry costs (163,616 gas, measured on an Arc mainnet fork; `test_F09_mockCostMatchesMainnetMeasurement` keeps it within 5%). Tests for open findings pin today's behavior, so a future change to it is deliberate.

| Finding | Tests |
|---|---|
| F-01 | `test_F01_providerCanRepriceDirectJobBeforeFund`, `test_F01_outsiderCannotRepriceAdapterJob` |
| F-02 | `test_F02_fork_penaltyIsWrittenNormally`, `test_F02_fork_ownerApprovalMakesPenaltyVanish` (Arc mainnet fork; they return early without it) |
| F-03 | `test_F03_workerDisputeRightAfterSubmitWinsAfter48h`, `test_F03_posterAnswerBlocksDefaultRuling` |
| F-04 | `test_F04_posterWhoOwnsTheAgentStillEarnsReputation` |
| F-05 | `test_F05_rejectionFinalizedBySilenceWritesNothing`, `test_F05_defaultRulingForPosterWritesNothing`, `test_F05_takeAndVanishWritesNothing` |
| F-06 | `test_F06_reconcileOnEscrowWordAlonePaysFromOtherBountiesFunds` |
| F-07 | `test_F07_openListingScanGrowsWithCancelledEntries` (6,827 gas per dead entry) |
| F-08 | `test_F08_feeChangeEmitsNothingAndHitsFundedJobs` |
| F-09 | `test_F09_mockCostMatchesMainnetMeasurement`, `test_F09_approveCannotSettleWithStarvedFeedback`, `test_F09_autoApproveCannotSettleWithStarvedFeedback`, `test_F09_reconcileCannotSettleWithStarvedFeedback`, `test_F09_rulingCannotSettleWithStarvedPenalty` (each at three registry costs, every gas limit from 100,000 to 800,000 in 1,000 steps plus every 10 gas above the lowest limit that settles), `test_F09_agentJobBelowFloorRevertsInsteadOfSkipping`, `test_F09_humanJobNeedsNoFloor`, `test_F09_revertingRegistryStillNeverBlocksPayout` |
| F-10 | `test_F10_failedWriteEmitsEvent`, `test_F10_failedPenaltyEmitsNegativeValue`, `test_F10_successfulWriteEmitsNoFailure` |
| F-11 | `test_F11_agentZeroCannotTakeAgentOnlyBounty` |
| F-12 | `test_F12_nonCanonicalReturnWordIsParkedNotReverted` |
| F-14 | existing `testRegression_ExternalRefundAfterBufferPaysWorker` in `MainnetAudit20260907.t.sol` |
| F-16 | `test_F16_submitAfterExpiryHitsResolvedGuard` |
| F-18 | `test_F18_escrowStorageLayoutIsPinned` |
| F-25 to F-31 | Covered by the existing suites: `BountyAdapter.t.sol`, `BountyAdapterInvariant.t.sol` (stateful invariants), `MainnetAudit20260907.t.sol` |

Before the fix, the F-09 sweep against the reviewed source passed at today's registry cost and failed at a write cost of about 270,000 (315 gas limits settled with the write skipped in `approveBounty`). That run is how the finding was rated Informational instead of Low.

## 4. Open items

**Decisions needed** (all of these change behavior, so none was fixed without you):

- **F-01, escrow repricing (Medium).** Risk: someone who uses the escrow contract directly, not through ArcBounty, can be charged more than agreed if they gave the escrow a large allowance. ArcBounty's own bounties are not affected. Decide: upgrade the escrow (needs the Safe) or leave it and say in the docs that the escrow is for the adapter only.
- **F-02, an agent can block its own penalty (Medium).** Risk: an agent that loses a dispute can make its penalty disappear from the public reputation record with one transaction; no money is involved. After the fix the attempt is visible as an event. Decide for the next adapter: keep penalties in the adapter itself, or refuse agents that approved the adapter.
- **F-03, early worker dispute (Low).** Risk: a poster who does not check a submission within 48 hours can pay the full reward for poor work. Already disclosed; SECURITY.md and the README say "no funds are lost", which understates it. Decide: a minimum wait before a worker can dispute, in the next adapter.
- **F-04, self-dealt reputation (Low).** Risk: a wallet can post a bounty, do it with its own agent and score itself 100 for about 1% of the reward. Decide: port the V4.8.1 rule.
- **F-05, silence avoids penalties (Low).** Risk: an agent that does bad work and then stays silent keeps a clean record. Decide: penalize these paths too, or document that only arbitrated losses count.
- **F-06, reconcile trusts the escrow (Low).** Risk: a bad escrow upgrade could also take money that sits in the adapter for other, untaken bounties. Today both balances are 0. Decide: add custody accounting in the next adapter, and adopt the rule that escrow upgrades keep the status values.
- **F-07, listing scan (Low).** Risk: for about 7,300 cheap create-and-cancel pairs someone can make the on-chain bounty list unreadable for the site and for agents; money is not affected. Decide: serve listings from an indexer.
- **F-08, silent escrow fees (Low).** Risk: the Safe could set a fee that takes part or all of a funded payout, with no event. Decide: keep the rule "fees stay 0" or upgrade the escrow to log and lock fees.
- **F-11, agent #0 (Info).** Risk: the owner of agent #0 on Arc cannot use agent-only bounties. Decide for the next adapter.
- **F-13, no maximum deadline (Info).** Risk: a squatter can block a bond-free bounty until a far deadline. Decide: cap deadlines (for example 365 days).
- **Redeploy.** The fixed adapter is not deployed. Decide whether and when to deploy it, and to migrate listings, as with earlier versions.

**Accepted risks** (no action unless you disagree): F-14 (no fee on the 90-day fallback), F-15 (no cancel of a role nomination), F-17 (instant escrow upgrade by the Safe), F-19 (treasury blacklist with fees enabled), F-20 (stale hooks), F-21 (unused `jobHasBudget`), F-22 (escrow event gaps), F-23 (no sweep, no balance check, no expiry cap in the escrow), F-24 (human-only and agent-only are best effort), F-29 (timestamps), F-30 (deliberate low-level call), F-31 (missing inheritance).

**False positives**: F-25, F-26, F-27, F-28 (reasons in section 2).

## 5. Audit Provenance

| Reviewer | Model | Scope | Method | Date |
|---|---|---|---|---|
| Lead reviewer (Claude Code session) | Claude Opus 5.5 (`claude-opus-5-5`) | `contracts/src/BountyAdapter.sol`, `contracts/src/base/AgenticCommerce.sol`, `contracts/src/base/interfaces/IACPHook.sol`, `contracts/src/interfaces/*.sol` at `1d5a315` | Line-by-line review; gas measurement of the live ERC-8004 registries on an Arc mainnet fork; Slither 0.11.5 with no detector exclusions (45 results triaged); Foundry tests for every finding that can be tested; merge and verification of the two subagent reports below (subagent A's objection to F-09 was confirmed by test, so F-09 was rated Informational) | 2026-11-23 |
| Claude subagent A (BountyAdapter) | Claude Opus 5.5 (claude-opus-5-5) | contracts/src/BountyAdapter.sol (full); src/base/AgenticCommerce.sol (paths the adapter calls); src/interfaces/*.sol; script/DeployArcMainnet.s.sol; DEPLOYMENTS.md Arc Mainnet section; tests MainnetAudit20260907.t.sol and BountyAdapterInvariant.t.sol (read); ERC-8004 Identity/Reputation v2.0.0 source (Sourcify chain 8453, same implementation addresses as the live Arc proxies, checked via EIP-1967 slot) | Manual line-by-line review: state-machine and time-window enumeration, fund-flow accounting, role and front-running analysis, comparison against the changelog, README, SECURITY and ARCHITECTURE. Read-only cast calls against Arc mainnet RPC and a Sourcify diff of the deployed source. No forge, slither or git runs; nothing written to the repo (scratch files only in the session scratchpad) | 2026-11-23 |
| Claude subagent B (AgenticCommerce) | Claude Opus 5.5 (`claude-opus-5-5`) | `contracts/src/base/AgenticCommerce.sol`, `contracts/src/base/interfaces/IACPHook.sol`, `contracts/src/interfaces/IAgenticCommerce.sol`; `contracts/src/BountyAdapter.sol` (only its escrow call sites and assumptions); `contracts/script/DeployArcMainnet.s.sol`; `DEPLOYMENTS.md` Arc Mainnet section; OZ 5.6.1 UUPS, Initializable, AccessControl and ReentrancyGuardTransient sources in `contracts/lib` | Manual line-by-line, read-only reasoning. No forge, slither or test runs; only read-only git log. Each claim traced to lines and a call sequence. | 2026-11-23 |
| Slither | Slither 0.11.5 | Same files as the lead reviewer; `lib/`, `src/monad/`, `test/`, `script/` filtered | All detectors, no exclusions (the repository's own `slither.config.json` excludes four detectors; it was not used for this run) | 2026-11-23 |

This is an internal, AI-assisted review, not an independent audit.
