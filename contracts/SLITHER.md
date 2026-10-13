# Slither triage

## Monad V4.8.1 (2026-10-13)

V4.8.1 adds one source-scoped `slither-disable-next-line calls-loop` annotation, on
`_isSelfDealt` in `src/monad/BountyAdapterV48.sol`. The helper reads the current owner of
an ERC-8004 identity so that a job whose poster is also the worker earns no reputation.
It runs at most once per winner, so at most 25 owner reads per contest settlement, and a
failed read only means "not self-dealt". With it the file carries three `calls-loop`
annotations (`_payContestEntry`, `_recordContestScore`, `_isSelfDealt`). No global detector
exclusion was added.

## Monad V4.8 stage 6 local safety (2026-10-08)

Repeated the configured adapter fail-low gate: passed, one informational
low-level call. The report without global exclusions still has 60 findings
in the stage-4 reviewed categories; it exits nonzero and is not a clean strict
gate. Strict keeper/mirror fail-low checks pass with one assembly / zero findings.
No production contract logic, global exclusions or source annotations changed.
Mixed real-escrow stateful invariants pass 256 runs × 128 depth per property;
these strengthen accounting evidence without replacing network validation or
an external audit. See [stage-6 local verification](../docs/superpowers/plans/2026-10-08-nadbounty-v48-stage6-local-verification.md).

## Monad / Base keeper receiver stage 5 (2026-10-08)

`src/monad/KeeperReceiver.sol` passes fail-low with a stricter Slither
configuration that has no global detector exclusions (kept locally, not published): 9 contracts /
101 detectors, one informational assembly finding. Assembly caps target gas,
provides no output buffer and copies at most four revert bytes. Tests cover
megabyte returndata, gas exhaustion, reporting reserve and authorized reentry.
Two source-scoped zero-check annotations document intentional relayer disablement.
The stage-5 verification notes (report ABI, limits, authority and real-escrow
integration coverage) are kept locally, not published.

## Monad V4.8 stage 4 (2026-10-08)

Contest rejection/challenges/arbitration and recovery pass the configured
fail-low gate. Full analysis without global exclusions was reviewed: 60 findings
(9 incorrect-equality, 7 reentrancy-no-eth, 5 reentrancy-benign, 38 timestamp,
1 informational low-level call). New findings concern the response timestamp
sentinel, challenge/arbitration boundaries and guarded timeout parked credits.
No new global exclusions or source-scoped suppressions were added for stage 4.
The stage-4 verification notes (timing decisions, tests, commands and deployment
assumptions) are kept locally, not published.

Current V4.8 runtime is 42,406 bytes. Earlier checkpoint sizes below are
historical. Keeper and local stateful contest obligations are now implemented;
Monad fork/testnet rehearsal remains pending. Static analysis does not replace
network validation or an external audit.

## Monad V4.8 stage 3 (2026-10-07)

Contest admission, selection, silence and normal escrow recovery pass the
configured fail-low gate. Full analysis without global exclusions was reviewed:
48 findings, including the new guarded contest score/parking writes and closure
sentinel comparisons. The stage-3 verification notes (counts, assumptions and
tests) are kept locally, not published.

One additional helper-scoped `reentrancy-balance` annotation covers exact
contest receipt accounting. Two `calls-loop` annotations cover immutable
identity-owner reads and non-blocking feedback, bounded by 25 entrants.
Tests exercise 25 agent winners, failed registry reads/feedback, short receipts,
blacklisted recipients and a real-escrow token callback attempting cross-mode
reentry. No global detector exclusions were added.

Current V4.8 runtime is 35,327 bytes, within Monad's 128 KiB bound. The stage-2
figures below describe that earlier checkpoint. Contest rejection/arbitration,
stateful contest liabilities and chain-specific rehearsal remain unfinished.

## Monad V4.8 stage 2 (2026-10-07)

The separate `src/monad/BountyAdapterV48.sol` passes the existing configured
`fail-low` gate with its intentional informational `_payOrPark` call visible.
The four globally excluded V4.7 detector classes were also run and reviewed
against V4.8: 33 findings, including the new guarded local-score writes.
Details, assumptions and reproducible commands are in the stage-2 verification
notes (kept locally, not published).

Three source-scoped `reentrancy-balance` annotations cover exact escrow-receipt
comparisons in `_completeAndForward`, `_completeAndSplit`, `_rejectAndRefund`.
All external callers hold the same nonReentrant guard and AC/USDC addresses
are immutable. Tests attempt nested settlement during an escrow receipt and
verify that short receipts cannot consume another open bounty's deposit.
Do not extend these annotations to unrelated code without re-review.

V4.8's 26,272-byte runtime exceeds Ethereum's 24 KiB limit but fits Monad's
128 KiB limit. CI therefore retains the Ethereum size gate for Arc/Base and
checks V4.8 under its separate local Monad size profile. This profile does not
validate Monad gas pricing; real Monad execution remains a later requirement.

`slither.config.json` excludes four detector classes from the CI gate. Each is
a reviewed, accepted finding - not a blanket silence. Re-review before mainnet.

One finding is **deliberately left visible** rather than excluded:
`low-level-calls` (Informational). It shows up in every report, is explained
below, and does not fail CI - the gate is `fail-on: low`, and Informational
sits below Low.

Run the full report (including excluded detectors) any time with:

```bash
cd contracts
slither src/BountyAdapter.sol \
  --solc-remaps "@openzeppelin/=lib/openzeppelin-contracts/ forge-std/=lib/forge-std/src/" \
  --filter-paths lib/
```

## Excluded detectors and why

### `timestamp` (all findings expected; count grows with each time-windowed feature)

The dispute / rejection / approval system is inherently time-windowed:
`REJECTION_CHALLENGE_WINDOW`, `DISPUTE_RESPONSE_WINDOW`, `APPROVAL_TIMEOUT`,
`ARBITRATOR_TIMEOUT`, `MIN_BOND_BOUNTY_DURATION`, and deadline checks. All
windows are ≥ 24h, far beyond the ±15s a validator can plausibly skew
`block.timestamp`. No sub-minute logic exists, so miner timestamp
manipulation cannot change any outcome.

### `incorrect-equality` (1 finding)

`_completeAndForward` does `if (received == 0) return;` on a balance delta
measured before/after the trusted AgenticCommerce `complete()` call. USDC is a
standard ERC-20 with no rebasing or fee-on-transfer; the delta is exact. A
strict `== 0` short-circuit is correct and intentional.

### `reentrancy-no-eth` (3 findings - added with V4.6)

`_payOrPark` credits `pendingWithdrawals[payee] += amount` *after* the
low-level `usdc.transfer` call it just attempted, so Slither flags the three
settlement helpers that reach it (`_completeAndForward`, `_completeAndSplit`,
`expireBounty`) as cross-function reentrancy on `pendingWithdrawals`.

Accepted, for the same two reasons as `reentrancy-benign` above:

1. Every external entry point is `nonReentrant`, so no reentrant call can
   interleave and observe the intermediate state.
2. The only contract called is `usdc` - an **immutable** address fixed in the
   constructor, i.e. real USDC, not an attacker-supplied token. USDC performs
   no callbacks into the caller; there is no hook to reenter from.

Writing the credit *before* the attempt and subtracting it again on success
would silence this, but costs two extra SSTOREs on every successful payout -
i.e. a permanent gas tax on the happy path to appease a finding that cannot
fire. **Re-check this if `usdc` ever becomes mutable or configurable per
deployment** - that assumption is what makes this safe.

Excluded globally rather than suppressed per-line, and that is a real
downside: a genuine `reentrancy-no-eth` elsewhere in the contract will now go
unreported. Per-line and block suppressions (`slither-disable-next-line`,
`slither-disable-start/end`) were tried first and behave inconsistently in
Slither 0.11.5 - the identical construct suppressed the finding in
`_completeAndForward` and `expireBounty` but not in `_completeAndSplit`,
with or without a single-line signature. Rather than ship markers that look
like protection while silently doing nothing, the exclude is global and this
note records the cost. Worth retrying when Slither is next upgraded.

### `low-level-calls` (1 finding - NOT excluded, visible in every report)

`_payOrPark` uses `address(usdc).call(abi.encodeCall(IERC20.transfer, …))`
rather than `safeTransfer`. This is the entire point of V4.6: `safeTransfer`
reverts on failure, and a revert here rolls back the terminal state
(`resolved = true`) written moments earlier, which is exactly how a USDC
blacklist could strand a bounty forever. A typed `try usdc.transfer(…)` is not
sufficient either - it still reverts when a token returns no data or malformed
data. The low-level call collapses every failure mode (revert, `false`,
unexpected return data) into a single "park it" branch, with the return value
explicitly length-checked before decoding.

### `reentrancy-benign` (1 finding)

`createBounty` writes `BountyMeta` state after calling `agenticCommerce.createJob`
/ `setBudget`. This is safe because:

1. The function is `nonReentrant` (OZ guard) - no reentrant call can interleave.
2. `AgenticCommerce` is a trusted, Arc-team-deployed contract at a hard-coded
   immutable address, not attacker-controlled.
3. `jobId` is the **return value** of `createJob`, so the metadata write
   *must* happen after the call - a full check-effects-interactions reorder is
   structurally impossible here.

Slither itself classifies this as "benign" (no value transfer is gated on the
post-call state). Documented and accepted.

## Not excluded

Everything else (high/medium correctness detectors, unchecked transfers,
arbitrary-send, etc.) remains a hard CI failure. `SafeERC20` is used for every
token movement, so unchecked-transfer cannot fire.

## `src/base/` (reported on every CI run, outside the gate since 2026-09-17)

**Current setup.** `slither.config.json` gates `BountyAdapter` only (`lib/` and
`src/base/` filtered, `fail-on: low`). A second CI step runs the whole tree,
`src/base/` included, with `slither.report.config.json` and `fail-on: none`, so
the findings below print on every run without failing it. Why: V4.7 moved
`src/base/` into the gate, and the first CI run of that config (2026-09-17,
the day the V4.7 commits reached `main`) failed on the `arbitrary-send-erc20`
false positive below, which Slither rates High. Suppressing it would mean an
inline marker in a file kept as a literal copy of the reference escrow (and
a different source hash from the one verified on Sourcify for Arc mainnet);
excluding the detector globally would also drop it for `BountyAdapter`, where
every `safeTransferFrom` takes `msg.sender` today and should stay guarded.

The history of the decision, kept as written for V4.7:

`src/base/AgenticCommerce.sol` used to be excluded from the Slither gate the
same way `lib/` is, on the reasoning that it's Arc's own accepted design, not
ours to triage. That held for Arc - an external, Arc-team-deployed and
Arc-team-upgradeable contract this project only reads - but not for Base:
Base's copy is self-deployed under this project's own admin key, with this
project holding the UUPS upgrade authority, so it is very much ours to triage
there. The source stays a deliberate byte-for-byte match of Arc's variant
(see `docs/INTEGRATION_NOTES.md`) for compatibility, kept unmodified - only
the Slither exclusion changed. (This note previously referenced a "$12k
external audit, grant Milestone 2" as the reason `BountyAdapter` alone was in
scope - that audit was cancelled 2026-08-09 and never happened; don't restore
that framing.)

Findings surfaced by including it:

- **`arbitrary-send-erc20`** on `AgenticCommerce.fund`'s
  `paymentToken.safeTransferFrom(job.client, address(this), job.budget)`.
  False positive: `fund()` requires `msg.sender == job.client` on the line
  immediately above, so `from` can never diverge from the caller. Slither's
  detector doesn't trace that guard back to the transfer - same class of
  false positive already accepted project-wide via `reentrancy-benign`/
  `reentrancy-no-eth` above.
- **`missing-inheritance`**: `AgenticCommerce` doesn't formally
  `is IAgenticCommerce`. Deliberate - the file is pinned as an exact match of
  the external reference implementation and Arc's own verified on-chain
  source; adding an inheritance declaration is a source-level change with no
  bytecode effect, left out to keep the file a literal, unmodified copy.

`reentrancy-no-eth` findings on this file's hook callbacks (always
`address(0)` in our deployment) would fall under the same globally-excluded
detector and accepted reasoning as this project's own `reentrancy-no-eth`
triage above, if any surface once that detector is ever re-enabled.
