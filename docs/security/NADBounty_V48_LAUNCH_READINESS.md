# NadBounty V4.8 launch readiness

Reviewed: 2026-10-09. This document records internal verification and launch gates. It is not an external audit report.

## Scope and reviewable source

The Monad adapter, mirror, receiver and deployment checks are in `contracts/src/monad/` and `contracts/script/BountyAdapterV48Deployment.s.sol`. The source publication [PR12](https://github.com/Sofiia7/ARC/pull/12) merged after all fresh Linux checks passed, including V4.8 tests, invariants, size bounds, gas snapshots and configured Slither. The SDK source reproduces the already published `arcbounty-agent-sdk@0.10.0`. Legacy escrow logic is reused; Safe retains its upgrade authority.

The review should cover contest admission and identity deduplication, winner/challenger selection, rejection and dispute deadlines, expired escrow reconciliation, current-owner payouts, blocked-token payout parking, outstanding obligations, reentrancy, bounded receiver execution and mirror reporter revocation/invalidation. The specification is `docs/superpowers/specs/2026-10-06-nadbounty-v48-contest-design.md`.

## Completed evidence

- Local verification previously passed 488 checks, including stateful invariants and substantive identity, challenge, payout and recovery regressions. Fresh publication CI remains the authoritative check for the committed source.
- Monad-aware forks exercised real registries, working-wallet admission, current-owner payouts, feedback writes and deployed keeper/mirror contracts. Local fork time travel was used only for positive deadline tests; it does not prove real-clock settlement.
- Live testnet rehearsal settled six immediate scenarios and verified exact recipient/treasury token changes, Safe handoff and paused configuration. All five deployments received Sourcify exact matches.
- Exact finalized Base/Arc reputation records were delivered by the approved testnet relayer and independently reread. This is a trusted reporter, not DON attestation. Registry feedback revocations and identity transfers are included in the source reader.
- Permissionless keeper and mirror delivery are configured for every 30 minutes with separate wallets, Redis leases, bounded spending and receipt/state verification. Two manual Linux live runs succeeded; actual scheduled dispatch has not yet been observed. No Safe owner or deployer signing key is uploaded to those jobs.
- Envio HyperSync caught up Monad Testnet, Base and Arc with ownership history preserved. Actual GraphQL readback confirms job7 event provenance, its current agent owner and all five mirrored records.
- Hosted x402 facade passed a real 0.001 test-USDC request with exact payer/Safe balance deltas. Unpaid, invalid and nonexistent requests were checked separately.
- Both actual CRE reputation WASM simulations (cron and HTTP) passed with default limits and identical reports. Base is verified natively; Arc remains trusted HTTP evidence. Broadcasting is disabled. Gateway authentication and multi-node DON consensus are not implied by local simulation.
- Human Mera creation, session closure and recovery completed on the testnet domain. Both public signatures were verified independently; the browser confirmed the same encryption key and decryption after recovery. PRF and private keys were neither exported nor persisted.

Internal Slither evidence is in the stage verification documents. Accepted lifecycle/timestamp/reentrancy findings have documented reasoning; strict keeper/mirror checks passed. This does not replace an external audit.

## Remaining gates

1. Publish and pass fresh Linux checks for the remaining Monad interface, public API and isolated MCP product sources.
2. Verify real testnet job7 settlement after **2026-10-10 10:12:35 UTC / 12:12:35 Budapest**, including scheduler receipt, resolved state, payout/bond changes and indexed events.
3. Complete external security review before enabling public funds. No external auditor has yet signed off.
4. Fund the mainnet deployer for gas. The latest verified inventory had 0 MON and 0 USDC; the intended Safe is absent on chain143. USDC is required for funded mainnet scenarios, not merely for contract creation.
5. Deploy mainnet paused, verify dependencies and bytecode, hand owner/arbitrator to the 2-of-3 Safe, verify escrow administration/fees/caps and publish exact verified source.
6. Configure and verify the mainnet site, mainnet-specific automation, monitoring and public APIs before any unpause. Testnet addresses and scheduler configurations must not be reused as mainnet authority.

## Launch controls and operational limits

Initial intended limits are a 100-USDC maximum bounty and 1% adapter fee, with the adapter paused through deployment and role checks. Mirror and keeper forwarders remain disabled until their authority and budget are verified. Direct keeper actions remain permissionless but the adapter enforces deadlines and state.

Pause blocks new admission; it intentionally preserves settlement and withdrawals. A reporter incident requires Safe revocation and, for poisoned source heights, source-specific invalidation followed by exact resynchronization. Monitor failed transactions, parked obligations, RPC failures, recipient discovery and available keeper/relayer gas.

Passkeys are domain-bound. The testnet Mera result does not migrate a credential or balance to a different mainnet domain. Complete the mainnet domain configuration before users create and fund its passkey wallets.

Evidence caches contain public receipts and local readbacks; deployment credentials remain in ignored environment files. Keep the exact release source and compiler settings alongside source verification and transaction receipts.
