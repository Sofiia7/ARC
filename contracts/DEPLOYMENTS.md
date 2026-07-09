# Deployments

Canonical source of truth for deployed contracts. Always trust this file
over `broadcast/` artifacts — those are forge's working area and may be
overwritten or out of date.

## Arc Testnet (chain id `5042002`)

### BountyAdapter (V4.3 — live, current frontend target)

| Field | Value |
|---|---|
| Address | `0x2e9504EEa0bD80CBaA2464227054fc941EE46cA7` |
| RPC | `https://rpc.testnet.arc.network` |
| Source | `src/BountyAdapter.sol` (at V4.3) |
| Features | Same on-chain behavior as V4.2 (opt-in worker bond, `uniquePosterCount`, the `disputeBounty`/`MIN_BOND_TAKE_WINDOW` fixes) **plus the V4.3 reputation-registry fix**: `IReputationRegistry` was mirroring an assumed/older ERC-8004 draft (`giveFeedback(agentId, score, feedbackType, context, field1-3, hash)`, `getReputation(agentId)`) that never matched the real deployed registry — every `giveFeedback` call had a wrong selector and silently reverted (swallowed by the adapter's own `try/catch`) since the very first integration, so no agent had ever actually received on-chain feedback despite completed bounties. Confirmed via the verified registry source (`ReputationRegistryUpgradeable` v2.0.0 at `0x16e0fa7f7c56b9a767e34b192b51f921be31da34`, behind the `0x8004B663…` proxy): real interface is `giveFeedback(agentId, int128 value, uint8 valueDecimals, tag1, tag2, endpoint, feedbackURI, hash)` / `getSummary(agentId, clientAddresses[], tag1, tag2)`. Rewired to the real interface — writes pass the 0-100 score as `value` with `valueDecimals=0`; `getAgentReputation` now proxies `getSummary(agentId, [address(this)], "", "")` and reshapes it into the same `averageScore/totalFeedbacks/totalJobs` struct the frontend already expected, so no frontend ABI change was needed. |
| Fee | 100 bps (1%) |
| Fee recipient | `0xADac7534d3fE868E28c77df5CD930f2635bcb63A` |
| Arbitrator | `0x4892232f0dD235cC1B92a3A87fc8990553691BC6` (**the Safe** — two-step transfer completed 2026-07-09; **2-of-2 signers** as of 2026-07-09, up from 1-of-1 — Grant Milestone 1's independent co-signer, real N-of-M) |
| Verified | ✅ ArcScan (Blockscout) |
| Deployed | 2026-07-08, block `50813922`, tx `0x4ff7afb10531cb5f8739cfbe561af6ea7369d39358980a1e29e69273b1c43daa`, from the same rotated Sprint-0 deployer `0xde427f…` |

> **✅ Arbitrator transfer complete (2026-07-09).** `transferArbitrator(0x4892232f0dD235cC1B92a3A87fc8990553691BC6)`
> was called from the deployer (block `50893874`, tx
> `0x09234cc842e985647d02d3b37625b82b893e263fcf67560ffa31830440c07fe8`), and
> `acceptArbitrator()` was executed **from the Safe itself** (block
> `50894030`, tx `0xa0a1a20cdac6b0c9347ad4c7a6c7ebcd0a49274a0ecfac7eed696e03f21c0179`)
> via app.safe.global. Verified on-chain: `arbitrator()` returns the Safe,
> `pendingArbitrator()` is zero.

> **✅ Safe raised to 2-of-2 (2026-07-09).** `addOwnerWithThreshold(0xed733FC13B1413966cf056866B6d80eF7b490eEc, 2)`
> was executed via `execTransaction` from the sole owner (`scripts/safe-add-signer.ts`
> — computes the SafeTx EIP-712 hash locally and cross-checks it against the
> Safe's own `getTransactionHash(...)` before signing), block `50974445`, tx
> `0xe44b243c70428204dd6f7602a2c121e4595626047e4d19039ea0077cd9cf0347`.
> Verified on-chain: `getOwners()` returns both addresses, `getThreshold()`
> is 2. Any future arbitrator decision now needs both signers — no single
> key can unilaterally rule a dispute.

> **Board state:** all 17 open listings on superseded V4.2 were reclaimed via
> `scripts/reclaim-bounties.ts` (~28 USDC returned to the poster wallet across
> 17 `cancelBounty` txs, 2026-07-08) before this deployment's re-seed. Two
> more listings — "viem script: watch BountyCreated and print new bounties"
> and "TypeScript snippet: pin a Buffer to Pinata v3" (bond-required) — were
> posted 2026-07-09 (`SEED_LIMIT=2 SEED_DEADLINE_DAYS=60`) specifically to
> re-run the agent proof-of-life flow on this deployment, then completed
> end-to-end by the same reused agent identity (jobIds `154216`/`154217`,
> agentId `847205`) — see `scripts/agent-proof-of-life.ts`. `totalBounties()`
> is 22, 14 open.

### BountyAdapter (V4.2 — superseded, reputation-registry integration broken)

| Field | Value |
|---|---|
| Address | `0x30C4EC6A846F8F879CAB3de481E3fd3f442e7572` |
| Source | `src/BountyAdapter.sol` (at V4.2) |
| Features | V4 (opt-in worker bond + `uniquePosterCount(agentId)` anti-Sybil signal) + V4.1 (`rejectBounty` bounded by `APPROVAL_TIMEOUT`, `withdrawRejection(jobId)`, `MIN_BOND_BOUNTY_DURATION` 24h creation floor) **plus the V4.2 external-review fixes**: `disputeBounty` now shares `rejectBounty`'s `APPROVAL_TIMEOUT` bound (a poster blocked from a late rejection could otherwise open a late dispute instead — same free delay, worse worst case), and `MIN_BOND_TAKE_WINDOW` (12h floor on **taking** a bond bounty — closes the residual honeypot where an aged bond listing could still be taken minutes before its deadline). See `ARCHITECTURE.md` §3 ("V4.2: closing the two mirror paths"). |
| Fee | 100 bps (1%) |
| Fee recipient | `0xADac7534d3fE868E28c77df5CD930f2635bcb63A` |
| Arbitrator | `0x4892232f0dD235cC1B92a3A87fc8990553691BC6` (**the Safe**, SafeL2 v1.4.1 — two-step transfer completed on this deployment; 1-of-1 signers today, N-of-M is Grant Milestone 1) |
| Verified | ✅ ArcScan (Blockscout) |
| Deployed | 2026-07-08, block `50644939`, tx `0x95d19367b44b66cf481bde50963a5c3c3d51dd48e667c0066465a78cc79e3663`, from the rotated Sprint-0 deployer `0xde427f…` |
| Superseded because | `IReputationRegistry` didn't match the real deployed registry — see V4.3 above. All other V4.2 behavior (worker bond, dispute/rejection timing fixes) carried forward unchanged. |

> **✅ Arbitrator transfer complete.** `transferArbitrator(0x4892232f0dD235cC1B92a3A87fc8990553691BC6)`
> was called from the deployer (tx `0xd4174c41dc6a6eb6097f6dda4cb475ec11a9537b0e2f7183d12e09615d32816b`),
> and `acceptArbitrator()` was executed **from the Safe itself** (Safe
> `execTransaction`, tx
> `0xd7690941a0e58bf687691438af8a852b7671266306328ca79110e4614c1a3ea7`,
> block `50650819`) via app.safe.global. Verified on-chain: `arbitrator()`
> returns the Safe, `pendingArbitrator()` is zero.
>
> On-chain wiring verified via `cast call`: all four registries, fee
> recipient, 100 bps fee, `WORKER_BOND_BPS() == 1500`, `MIN_WORKER_BOND() ==
> 500000`, `MIN_BOND_BOUNTY_DURATION() == 86400` (24h), `MIN_BOND_TAKE_WINDOW()
> == 43200` (12h, new in V4.2), `APPROVAL_TIMEOUT() == 1209600` (14d), and
> `ARBITRATOR_TIMEOUT() == 2592000` (30 days exactly) all confirmed correct
> post-deploy.
>
> **Board state:** all 17 open listings on superseded V4.1 were reclaimed via
> `scripts/reclaim-bounties.ts` (~28 USDC returned to the poster wallet across
> 17 `cancelBounty` txs, 2026-07-08) before this deployment's re-seed.
> Re-seeded the same day: `seed-bounties.ts` full set (14 listings, 2 with
> `requireWorkerBond`) + `seed-extra.ts` with `SEED_LIMIT=5` (5 listings, 1
> with `requireWorkerBond`) — **19 total across all 5 categories, 3 bond
> listings, 60-day deadlines** (`SEED_DEADLINE_DAYS=60`), matching the prior
> board's composition. Two were then completed end-to-end by a real agent as
> the V4.2 proof-of-life (jobIds `151547` — the bond listing, bond posted
> and refunded — and `151546`; agentId `847205`, same identity reused from
> the prior V4.1 run; see `scripts/agent-proof-of-life.ts`), leaving 17
> open. `uniquePosterCount(847205)` = 1 on this deployment (first completion
> with this poster since the contract redeployed and the counter reset).

Wired dependencies:

| Field | Value |
|---|---|
| `agenticCommerce` | `0x0747EEf0706327138c69792bF28Cd525089e4583` |
| `identityRegistry` | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| `reputationRegistry` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| `usdc` | `0x3600000000000000000000000000000000000000` |

### Historical / abandoned deployments

These addresses appear in `broadcast/Deploy.s.sol/5042002/*.json` but are
**not** the canonical adapter. Do not point clients at them.

- `0x83117287A0C1eCBCF33B0F11aD5BD8Ae9F379887` — V4.1: live 2026-07-07 to
  2026-07-08. Added the `APPROVAL_TIMEOUT` bound on `rejectBounty`,
  `withdrawRejection`, and the `MIN_BOND_BOUNTY_DURATION` (24h) creation-time
  honeypot guard. Superseded by V4.2 the next day once an external review
  found the two mirror-path gaps (late `disputeBounty`, take-near-deadline
  bond honeypot). All 17 open listings reclaimed via
  `scripts/reclaim-bounties.ts` (~28 USDC). Arbitrator transfer to the Safe
  was completed here (`acceptArbitrator()` executed from the Safe
  2026-07-07) — that acceptance is specific to this address and does not
  carry over to V4.2, which needs its own `acceptArbitrator()` call.
- `0xAe9898324256083E8F37D82FEC4be0448A107645` — V4: live 2026-07-05 to
  2026-07-07. First deployment with the worker bond + `uniquePosterCount`;
  superseded by V4.1 (the three internal-audit fixes above) two days later.
  All 15 listings reclaimed via `scripts/reclaim-bounties.ts`; arbitrator was
  the Safe here too.
- `0x90a976bD4edF7cA66F38bF4E8Bf795bA389b4f05` — V3.3: live 2026-07-05, briefly.
  Added `claimArbitratorTimeout` (closes the arbitrator-liveness gap) and
  replaceable `feeRecipient`. Superseded by V4 the same day once the
  worker-bond/anti-Sybil parameters were agreed. Arbitrator transfer to the
  Safe was started (`transferArbitrator`) but never accepted before
  superseding it — the pending transfer on this address is now moot.
- `0x5E7106382bA80c8805A570dEE4cB4bC321a8Ed83` — V3.2: live until 2026-07-05.
  Fixed the `giveFeedback` revert blocking agent payouts, but had no recovery
  path for a dispute where the arbitrator never rules after a response is
  filed (funds could freeze forever). Superseded by V3.3. Arbitrator was a
  Safe (`0x4892232f0dD235cC1B92a3A87fc8990553691BC6`, 1-of-1) — that Safe
  still exists and is the intended arbitrator for V4 too, pending the
  `acceptArbitrator` step noted above.
- `0x15Fba46C1f5eCc043ebf0E859Ce1e7DC2aa0C679` — V3.1: live until Sprint 0.
  `takeBounty` fixed, but `giveFeedback` reverts on the live registry blocked
  agent approval/payout. Superseded by V3.2.
- `0x4AF985AE361354bB28e1c3A9096cB797567D04F3` — V3: Sprint-1 hardened but
  `takeBounty` calls the live registry's reverting `isRegistered()`, so
  agent-takers cannot take. Superseded by V3.1.
- `0x8b541706f0766A09CD7a9fbFd02e30458BA4091D` — V2: humanOnly + dispute
  response/ruling but pre-Sprint-1 (no autoApprove, charges fee on create,
  no O(1) index views, no length caps).
- `0x1effdfbdc977b5dc3a1ee0e9d8d951e0a2b30b55` — older variant, no
  dispute response/ruling fields.
- `0x2f5171317be1c912153c4760af03d6ee77d52894` — empty, abandoned.

## Updating this file after a redeploy

1. Run `script/Deploy.s.sol`.
2. Replace the address in the table above.
3. Update `BOUNTY_ADAPTER_ADDRESS` and `NEXT_PUBLIC_BOUNTY_ADAPTER_ADDRESS`
   in both `.env` and Vercel env.
4. Bump the SDK version (`agent-sdk/package.json`) and republish if its
   ABI changed.
