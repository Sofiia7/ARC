# Slither triage

`slither.config.json` excludes four detector classes from the CI gate. Each is
a reviewed, accepted finding — not a blanket silence. Re-review before mainnet.

One finding is **deliberately left visible** rather than excluded:
`low-level-calls` (Informational). It shows up in every report, is explained
below, and does not fail CI — the gate is `fail-on: low`, and Informational
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

### `reentrancy-no-eth` (3 findings — added with V4.6)

`_payOrPark` credits `pendingWithdrawals[payee] += amount` *after* the
low-level `usdc.transfer` call it just attempted, so Slither flags the three
settlement helpers that reach it (`_completeAndForward`, `_completeAndSplit`,
`expireBounty`) as cross-function reentrancy on `pendingWithdrawals`.

Accepted, for the same two reasons as `reentrancy-benign` above:

1. Every external entry point is `nonReentrant`, so no reentrant call can
   interleave and observe the intermediate state.
2. The only contract called is `usdc` — an **immutable** address fixed in the
   constructor, i.e. real USDC, not an attacker-supplied token. USDC performs
   no callbacks into the caller; there is no hook to reenter from.

Writing the credit *before* the attempt and subtracting it again on success
would silence this, but costs two extra SSTOREs on every successful payout —
i.e. a permanent gas tax on the happy path to appease a finding that cannot
fire. **Re-check this if `usdc` ever becomes mutable or configurable per
deployment** — that assumption is what makes this safe.

Excluded globally rather than suppressed per-line, and that is a real
downside: a genuine `reentrancy-no-eth` elsewhere in the contract will now go
unreported. Per-line and block suppressions (`slither-disable-next-line`,
`slither-disable-start/end`) were tried first and behave inconsistently in
Slither 0.11.5 — the identical construct suppressed the finding in
`_completeAndForward` and `expireBounty` but not in `_completeAndSplit`,
with or without a single-line signature. Rather than ship markers that look
like protection while silently doing nothing, the exclude is global and this
note records the cost. Worth retrying when Slither is next upgraded.

### `low-level-calls` (1 finding — NOT excluded, visible in every report)

`_payOrPark` uses `address(usdc).call(abi.encodeCall(IERC20.transfer, …))`
rather than `safeTransfer`. This is the entire point of V4.6: `safeTransfer`
reverts on failure, and a revert here rolls back the terminal state
(`resolved = true`) written moments earlier, which is exactly how a USDC
blacklist could strand a bounty forever. A typed `try usdc.transfer(…)` is not
sufficient either — it still reverts when a token returns no data or malformed
data. The low-level call collapses every failure mode (revert, `false`,
unexpected return data) into a single "park it" branch, with the return value
explicitly length-checked before decoding.

### `reentrancy-benign` (1 finding)

`createBounty` writes `BountyMeta` state after calling `agenticCommerce.createJob`
/ `setBudget`. This is safe because:

1. The function is `nonReentrant` (OZ guard) — no reentrant call can interleave.
2. `AgenticCommerce` is a trusted, Arc-team-deployed contract at a hard-coded
   immutable address, not attacker-controlled.
3. `jobId` is the **return value** of `createJob`, so the metadata write
   *must* happen after the call — a full check-effects-interactions reorder is
   structurally impossible here.

Slither itself classifies this as "benign" (no value transfer is gated on the
post-call state). Documented and accepted.

## Not excluded

Everything else (high/medium correctness detectors, unchecked transfers,
arbitrary-send, etc.) remains a hard CI failure. `SafeERC20` is used for every
token movement, so unchecked-transfer cannot fire.

## `src/base/` is filtered out entirely, not triaged

`src/base/AgenticCommerce.sol` (added for the Base deployment, V4.5) is
excluded from the Slither gate the same way `lib/` is — it is a byte-for-byte
copy of the exact contract Arc itself already deployed and has run in
production for months (verified against ArcScan's source for
`0x0747EEf0706327138c69792bF28Cd525089e4583`; see
`docs/INTEGRATION_NOTES.md`), vendored only because Base has no canonical
ERC-8183 deployment of any kind to point at instead. It is not code this
project wrote or is claiming custody-path ownership of — the $12k external
audit (grant Milestone 2) is scoped to `BountyAdapter` (~590 LOC), not this
escrow. Findings here (a handful of `reentrancy-no-eth` on hook callbacks that
are always `address(0)` in our deployment, and one `arbitrary-send-erc20` on
the standard escrow `transferFrom`) are Arc's own accepted design, not ours to
triage.
