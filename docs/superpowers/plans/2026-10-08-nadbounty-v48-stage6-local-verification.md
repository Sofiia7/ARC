> Historical document (written October 2026). It describes the project at that time and is not kept up to date. For the current state see README.md, SECURITY.md and contracts/DEPLOYMENTS.md.

# NadBounty V4.8 - Task 6 local verification

Date: 2026-10-08. Local safety checks and deployment/rehearsal tooling are implemented. Task 6 remains open for Monad-aware fork execution and live testnet evidence; no network transaction, deployment, Safe handoff, unpause, commit or push was performed.

## Stateful safety model

`contracts/test/BountyAdapterV48MixedInvariant.t.sol` uses the real pinned AgenticCommerce implementation behind an ERC1967 proxy, six wallets, three mutable identities, and several concurrent funded contests, funded/submitted single-taker jobs, unfunded deposits and worker bonds. Random actions create additional jobs (bounded to 40), admit/replace entries, pick, reject/challenge/respond/accept/rule/default/timeout/settle/reconcile, advance time, rotate identity owner/working keys, toggle registry failure/blacklists/pause, claim escrow expiry refunds and withdraw parked credits.

Three properties check:

- Every minted token remains in the tracked actors, fee recipient, adapter or escrow.
- Adapter balances exactly cover direct open-job obligations plus parked address/identity claims; escrow balances exactly cover funded/submitted jobs. One job cannot consume another job's deposit or bond.
- Resolved state remains terminal, per-job terminal allocations do not exceed reward plus its bond, contest allocations do not exceed gross reward, and each entry's award/event count is at most one.

Ghost violation flags persist instead of reverting inside the handler, so invariant `fail_on_revert=false` cannot discard a discovered accounting failure. Handler counters report attempted actions; successful adapter calls are separately tracked and guard reverts are intentionally caught. Zero handler reverts does not mean every attempted adapter action succeeded.

A deterministic matrix shares the same accounting model and covers thirteen contest scenarios: early pick, silence, no-entry expiry, unchallenged rejection, acceptance after identity transfer, arbitrator worker/refund rulings, unanswered default, neutral timeout with registry outage and blacklisted poster, and four already-refunded escrow recovery states. It then settles/replays concurrent single-taker obligations. It asserts successful execution of every contest exit selector plus single-taker approval, auto-approval and cancellation, so random branch selection is not the only coverage evidence.

## Deployment and fork tooling

`contracts/script/BountyAdapterV48Deployment.s.sol` provides a guarded paused deployment and a separate keyless read-back. Fourteen tests use the actual deployment sequence, pinned proxy and a probe-compatible Safe test double. They cover both chain IDs, wrong/unsupported chain, absent dependency code, wrong token metadata, missing identity/wallet/reputation reads, two-of-three Safe shape, zero relayer, pending role handoffs, wrong implementation slot/relayer, unpause/raised cap, nonzero escrow fees and enabled forwarder rejection. The Safe double is not evidence of real multisig signature execution.

Preflight uses functional identity reads instead of assuming a registry NFT collection name. Runtime dependency authenticity and intended Safe signers must be confirmed independently. The adapter remains paused with 100-bps fee and 100-USDC cap; the script never unpauses. Both adapter Safe accept calls are required before read-back readiness.

`contracts/test/BountyAdapterV48MonadFork.t.sol` is opt-in with an explicit RPC and pinned block. Three cases cover real registry owner/working-wallet reads, current-owner USDC payment, single-taker/contest settlement and actual feedback confirmed through the adapter-filtered registry summary. Without RPC, Foundry explicitly reports the fixture as skipped (one setup skip), rather than passing these cases. A missing distinct working wallet also explicitly skips that case when the fork is enabled. This stage did **not** execute a real Monad fork.

Environment placeholders are in `contracts/.env.example`. Full prerequisites, simulation/read-back commands, Safe handoff and evidence requirements are in rehearsal checklist (kept with the private deployment notes). Broadcast artifacts, compiler cache and outputs are ignored. No secret values were copied into source, docs or test output.

## Verification results

| Check | Result |
|---|---|
| V4.8 local suites, including new invariants and deployment checks | **317 passed** |
| Existing adapter/mirror/keeper suites under default profile | **171 passed** |
| Total passing checks | **488** |
| New real-registry Monad fork fixture | **Explicitly skipped**, no RPC configured |
| Extended mixed invariants | 256 runs × 128 depth = **32,768 actions per property**, all three pass |
| Deterministic thirteen-scenario matrix | Passed |
| Focused formatting of all new Monad sources/tests/script | Passed |
| Ethereum size gate excluding V4.8 artifacts | Passed |
| Gas snapshot with seed `0x48` | Passed, all earlier entries preserved |
| `git diff --check` | Passed |

The two legacy RPC-dependent tests still return early without exercising a fork; their passing status is not network evidence. Whole-tree Windows formatting has the previously documented CRLF issue in three unchanged legacy files; the focused checks pass. No remote CI run occurred.

The gas snapshot initially failed because stages 1/5 added mirror/keeper tests without their snapshot entries. Added **52** entries after asserting every earlier entry is unchanged. CI now supplies a fixed fuzz seed for reproducible new fuzz-test gas measurements. Arc/Base toolchain, test baseline values and production bytecode are unchanged.

Runtime/initcode sizes (compiler 0.8.30, optimizer 200, via IR, Cancun):

| Contract | Runtime | Initcode before constructor arguments | Including constructor arguments |
|---|---:|---:|---:|
| V4.8 adapter | 42,406 | 43,420 | 43,612 |
| Keeper receiver | 3,124 | 3,571 | 3,699 |
| Reputation mirror | 3,275 | 3,599 | 3,663 |

These fit the approved Monad bounds. Local Foundry 1.7.1 with the `monad_local` size limit does not validate Monad gas/opcodes/reserve rules. Official [Monad tooling instructions](https://docs.monad.xyz/tooling-and-infra/toolkits/foundry) require Foundry 1.8+ and Monad execution selection for those checks. The legacy V4.7 adapter remains 23,366 runtime bytes. Legacy adapter and pinned escrow files were compared as raw bytes against HEAD and are identical.

## Static analysis

Repeated the configured adapter fail-low gate: passed with one informational `_payOrPark` low-level-call finding. Repeated the full adapter report without global detector exclusions: **60** findings, same reviewed categories as stage 4 (9 incorrect-equality, 7 reentrancy-no-eth, 5 reentrancy-benign, 38 timestamp and 1 low-level-call). The full report exits nonzero because it reports findings; it is **not** a clean strict gate. The earlier lifecycle/reentrancy/sentinel triage still applies; no production contract logic or suppressions changed in this stage.

Strict keeper analysis: passed fail-low, one informational bounded-assembly finding. Strict mirror analysis: passed fail-low, zero findings. These are internal checks and do not replace an external audit.

## Reproduction

From `contracts/`, using the pinned local binary:

```powershell
$forge = 'forge'
$env:FOUNDRY_PROFILE = 'monad_local'
& $forge test --match-contract 'BountyAdapterV48.*' --summary
$env:FOUNDRY_INVARIANT_RUNS = '256'
$env:FOUNDRY_INVARIANT_DEPTH = '128'
& $forge test --match-contract BountyAdapterV48MixedInvariantTest --summary
Remove-Item Env:FOUNDRY_INVARIANT_RUNS, Env:FOUNDRY_INVARIANT_DEPTH
$env:FOUNDRY_PROFILE = 'default'
& $forge test --no-match-contract 'BountyAdapterV48.*' --summary
& $forge build --sizes --skip BountyAdapterV48
& $forge snapshot --check --fuzz-seed 0x48 --no-match-contract 'BountyAdapterForkTest|BountyAdapterV48.*'
```

Remaining: run the pinned live-registry fork on Monad-aware tooling, validate actual transaction limits/SDK buffering, perform live testnet settlement/keeper/rotation scenarios, record verified dependency/Safe evidence and complete the paused handoff/read-back. Only then consider the mainnet paused deployment and later launch review.
