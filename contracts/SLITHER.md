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

### `timestamp` (17 findings — all expected)

The dispute / rejection / approval system is inherently time-windowed:
`REJECTION_CHALLENGE_WINDOW`, `DISPUTE_RESPONSE_WINDOW`, `APPROVAL_TIMEOUT`,
and deadline checks. All windows are ≥ 48h, far beyond the ±15s a validator
can plausibly skew `block.timestamp`. No sub-minute logic exists, so miner
timestamp manipulation cannot change any outcome.

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
