# ArcBounty — Audit Preparation Package

Companion to `SECURITY.md`. Aimed at external auditors (Spearbit / Code4rena Lite / Cantina).

Contract under review: `contracts/src/BountyAdapter.sol`
Solidity: 0.8.30 | Foundry | OZ ReentrancyGuard + SafeERC20
LOC (excl. comments + interfaces): ~370
Tests: 62 unit + 2 fork = 64 (see `contracts/test/`)

## Scope

**In scope:**
- `contracts/src/BountyAdapter.sol`
- `contracts/src/interfaces/*.sol` (interface fidelity only)

**Out of scope:**
- `AgenticCommerce` (ERC-8183), `IdentityRegistry`, `ReputationRegistry` — audited by Arc team, treated as trusted.
- USDC — standard Circle issuance.
- Off-chain: `arcbounty-agent-sdk`, Next.js frontend, expiry-runner.

## Trust assumptions

1. AC, Identity, Reputation contracts at the canonical Arc addresses behave according to their documented interfaces and never call back into the adapter maliciously.
2. USDC is a standard ERC-20 (`transferFrom`/`transfer` return bool, no fee-on-transfer, no rebasing).
3. `arbitrator` is honest. (Acknowledged centralization; migration to multisig is the first action post-audit; see `transferArbitrator`/`acceptArbitrator`.)
4. `feeRecipient` address is correct at construction. (Immutable; deploy with a multisig.)
5. `sanctionsOracle`, when set, returns truthful results.

## Lifecycle invariants

For every `jobId` created via `BountyAdapter.createBounty`:

| # | Invariant |
|---|---|
| L1 | After `createBounty` returns: `meta.poster ≠ 0 ∧ meta.funded = true ∧ AC.budget[jobId] = meta.reward` |
| L2 | `meta.reward = (input.reward - fee)` where `fee = input.reward * feeBps / 10_000` |
| L3 | At most one of {`approveBounty`, `autoApprove`, `rejectBounty`, `cancelBounty`, `expireBounty`, `resolveDispute`} ever transitions `finalized: false → true` for a given jobId |
| L4 | If `meta.finalized = true`, no state-changing entry point may further mutate `meta` (enforced by `require(!meta.finalized)` on every path) |
| L5 | If `meta.isTaken = false`, then `meta.assignedProvider = 0 ∧ meta.submittedResultHash = ""` |
| L6 | If `bytes(meta.submittedResultHash).length > 0`, then `meta.submittedAt > 0 ∧ meta.isTaken = true` |
| L7 | `meta.inDispute → !meta.finalized` (dispute must be resolved before finalize) |
| L8 | `disputeBounty` / `rejectBounty` / `approveBounty` reject calls outside the 48h `submittedAt + DISPUTE_WINDOW` (rejection allowed only inside; approval allowed only inside; autoApprove allowed only after; this is by design) |

## Money-flow invariant

**For any jobId, total USDC delivered to (poster + provider + feeRecipient) over the lifetime equals the original `input.reward` passed to `createBounty`.**

- `fee` → `feeRecipient` at create (always)
- On `complete` (approve / autoApprove / resolveDispute-pay-provider): `netReward` → provider
- On `reject` / `cancel` / `expire` / resolveDispute-pay-poster: AC.refund pushes `netReward` back to adapter → adapter forwards to poster via `_refundFromAC`

There is exactly one "settlement event" per jobId, gated by `meta.finalized`.

## Access control matrix

| Function | Caller |
|---|---|
| `createBounty` | anyone (USDC allowance required) |
| `takeBounty` / `commitTake` / `revealTake` | anyone, subject to `whitelistedProvider` and `agentOnly` |
| `submitWork` | `meta.assignedProvider` only |
| `approveBounty` / `rejectBounty` / `cancelBounty` / `disputeBounty` (poster path) | `meta.poster` |
| `disputeBounty` (provider path) | `meta.assignedProvider` |
| `autoApprove` | `meta.assignedProvider`, after window |
| `expireBounty` | anyone (permissionless) |
| `resolveDispute` | `arbitrator` only |
| `transferArbitrator` / `setSanctionsOracle` | `arbitrator` only |
| `acceptArbitrator` | `pendingArbitrator` only |

## Known issues / accepted findings

| Detector | Status | Reason |
|---|---|---|
| Slither `reentrancy-benign` in `createBounty` | accepted | `jobId` is returned by `AC.createJob`; meta cannot be written before that call. Protected by `nonReentrant` + AC is trusted. |
| Slither `timestamp` | accepted | All comparisons are coarse (hours/days). Miner ±15s drift has no economic impact. |
| `arbitrator` initial value = deployer | accepted, will be migrated | Documented in `SECURITY.md §10`. Post-deploy step: call `transferArbitrator(multisig)` → `acceptArbitrator()`. |
| O(n) iteration in `getOpenBounties` / `_filterByPoster` / `_filterByProvider` | accepted for MVP | View-only; called from off-chain clients. At ~1k jobs still fits eth_call gas; an indexer is recommended past that. |
| `feeBps` immutable | accepted | See `docs/economics.md`. |

## Properties we'd like the auditor to verify

1. **No USDC can be permanently locked in `BountyAdapter`.** Every USDC arriving via `safeTransferFrom` in `createBounty` is, by the end of the same transaction, either in `feeRecipient` (fee) or in AC escrow (`netReward`). All terminal paths return the AC balance to the poster via `_refundFromAC`, and `approveBounty`-class paths route AC to the provider directly inside ERC-8183 (adapter never touches it).

2. **Commit-reveal cannot be replayed.** `commitHash[jobId][msg.sender]` and `commitBlock` are both cleared at the start of a successful `revealTake`. A stale commitment cannot be used after `_take` flips `isTaken`.

3. **MEV front-runner cannot steal a bounty in commit-reveal mode.** A mempool observer of a `revealTake(jobId, agentId, salt)` cannot themselves call `revealTake` for the same job because they have no `commitHash` entry (`require(stored != bytes32(0))`).

4. **No path to bypass `nonReentrant`.** All entry points that touch USDC or AC are marked `nonReentrant`.

5. **`arbitrator` rotation cannot leave a void.** If `transferArbitrator(0)` is called, the live `arbitrator` stays unchanged; `pendingArbitrator` is just cleared. Therefore there's always at least one address authorized to resolve disputes.

6. **Sanctions oracle off-by-default.** With `sanctionsOracle = 0`, all legacy flows pass unchanged. Setting an oracle blocks future flows but does not retroactively block already-submitted work (except at the payout step).

## Deployment runbook (pre-audit)

1. `forge build --sizes` (verify contract under 24 KB)
2. `forge test` (62/62 green)
3. `forge snapshot --check` (no gas regression)
4. `slither src/BountyAdapter.sol --config-file slither.config.json --fail-medium --exclude reentrancy-benign,timestamp` (zero findings)
5. `forge script script/Deploy.s.sol --rpc-url $ARC_TESTNET_RPC_URL --private-key $DEPLOYER_PK --broadcast --verify`
6. Note the deployed address.
7. From the deployer address: `transferArbitrator(<multisig>)`.
8. From the multisig: `acceptArbitrator()`.
9. (Optional) From the multisig: `setSanctionsOracle(<chainalysis-oracle>)`.
10. Update `frontend/.env.local` and `agent-sdk` consumers with the new `BOUNTY_ADAPTER_ADDRESS`.
11. Create a single test bounty end-to-end against the live deployment.

## Mainnet checklist (pre-launch, post-audit)

- [ ] External audit complete, all High/Medium findings addressed
- [ ] Arbitrator is a 2/3+ Gnosis Safe
- [ ] `feeRecipient` is a multisig
- [ ] Sanctions oracle configured (decision per `SECURITY.md §9`)
- [ ] Canonical AC/Identity/Reputation addresses re-verified from official Arc docs at deployment time
- [ ] Slither baseline + CI green on the deployed commit
- [ ] Bug bounty program announced
- [ ] Public incident response channel documented
