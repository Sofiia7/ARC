# Slither triage

`slither.config.json` excludes three detector classes from the CI gate. Each is
a reviewed, accepted finding — not a blanket silence. Re-review before mainnet.

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
