# Deployments

Canonical source of truth for deployed contracts. Always trust this file
over `broadcast/` artifacts — those are forge's working area and may be
overwritten or out of date.

## Arc Testnet (chain id `5042002`)

### BountyAdapter (V4.4 — live, current frontend target)

| Field | Value |
|---|---|
| Address | `0x538CD48789667168bfb36f838Af8476237F9409F` |
| RPC | `https://rpc.testnet.arc.network` |
| Source | `src/BountyAdapter.sol` (at V4.4) |
| Features | Same on-chain behavior as V4.3 (worker bond, `uniquePosterCount`, the V4.1/V4.2 timing guards, real reputation-registry interface) **plus the V4.4 fee fix**: `claimArbitratorTimeout`'s neutral 50/50 fallback no longer deducts the protocol fee — `_completeAndSplit` divides the full escrowed amount (external-review finding: users were being charged the 1% fee precisely when the arbitrator failed to deliver the service the fee funds). |
| Fee | 100 bps (1%) |
| Fee recipient | `0xADac7534d3fE868E28c77df5CD930f2635bcb63A` |
| Arbitrator | `0x4892232f0dD235cC1B92a3A87fc8990553691BC6` (**the Safe**, 2-of-3) — two-step transfer completed 2026-07-10: `transferArbitrator` from the deployer (block `51091540`, tx `0xda5bc0bab1c8679283b0b2f999289223f6234e9a3fcb78b268f0392a5d69322e`), `acceptArbitrator()` executed **from the Safe itself** (`execTransaction` via app.safe.global, 2 of 3 signatures; block `51095596`, tx `0x640542ffe338b7ce8dfe5edf4a0ff3c518fcf56a06465d705f108845537eb086`). Verified on-chain: `arbitrator()` returns the Safe, `pendingArbitrator()` is zero. |
| Verified | ✅ ArcScan (Blockscout) |
| Deployed | 2026-07-10, block `51091329`, tx `0xef75cef9d6c9d86762bf8d84a74846d6eb30c076dd220661e2935288f1beecea`, from the same rotated Sprint-0 deployer `0xde427f…` |

> **Board state:** all 14 open listings on superseded V4.3 were reclaimed via
> `scripts/reclaim-bounties.ts` (~24 USDC returned to the poster wallet,
> 2026-07-10) before this deployment's re-seed. Re-seeded the same day:
> `seed-bounties.ts` full set (14 listings, 2 with `requireWorkerBond`,
> `SEED_DEADLINE_DAYS=60`) + 2 extra listings (`SEED_LIMIT=2`) posted
> specifically for the agent proof-of-life re-run, then completed end-to-end
> by the same reused agent identity — jobIds `155220` (the bond listing:
> bond posted at take, refunded at submit) and `155219`, agentId `847205`,
> paid 0.99 USDC of each 1 USDC reward (`scripts/agent-proof-of-life.ts`).
> `totalBounties()` is 16, 14 open; `uniquePosterCount(847205)` = 1 on this
> deployment (the counter, like all adapter storage, resets on redeploy).

### BountyAdapter (V4.3 — superseded, arbitrator-timeout split charged the protocol fee)

| Field | Value |
|---|---|
| Address | `0x2e9504EEa0bD80CBaA2464227054fc941EE46cA7` |
| RPC | `https://rpc.testnet.arc.network` |
| Source | `src/BountyAdapter.sol` (at V4.3) |
| Superseded because | `claimArbitratorTimeout`'s neutral 50/50 fallback deducted the 1% protocol fee before splitting — charging users for arbitration the protocol didn't deliver. Fixed in V4.4 (`_completeAndSplit` splits the full escrowed amount). All other V4.3 behavior carried forward unchanged. All 14 open listings reclaimed 2026-07-10 (~24 USDC) ahead of the V4.4 deployment. |
| Features | Same on-chain behavior as V4.2 (opt-in worker bond, `uniquePosterCount`, the `disputeBounty`/`MIN_BOND_TAKE_WINDOW` fixes) **plus the V4.3 reputation-registry fix**: `IReputationRegistry` was mirroring an assumed/older ERC-8004 draft (`giveFeedback(agentId, score, feedbackType, context, field1-3, hash)`, `getReputation(agentId)`) that never matched the real deployed registry — every `giveFeedback` call had a wrong selector and silently reverted (swallowed by the adapter's own `try/catch`) since the very first integration, so no agent had ever actually received on-chain feedback despite completed bounties. Confirmed via the verified registry source (`ReputationRegistryUpgradeable` v2.0.0 at `0x16e0fa7f7c56b9a767e34b192b51f921be31da34`, behind the `0x8004B663…` proxy): real interface is `giveFeedback(agentId, int128 value, uint8 valueDecimals, tag1, tag2, endpoint, feedbackURI, hash)` / `getSummary(agentId, clientAddresses[], tag1, tag2)`. Rewired to the real interface — writes pass the 0-100 score as `value` with `valueDecimals=0`; `getAgentReputation` now proxies `getSummary(agentId, [address(this)], "", "")` and reshapes it into the same `averageScore/totalFeedbacks/totalJobs` struct the frontend already expected, so no frontend ABI change was needed. |
| Fee | 100 bps (1%) |
| Fee recipient | `0xADac7534d3fE868E28c77df5CD930f2635bcb63A` |
| Arbitrator | `0x4892232f0dD235cC1B92a3A87fc8990553691BC6` (**the Safe** — two-step transfer completed 2026-07-09; **2-of-3 signers** as of 2026-07-10, up from 2-of-2 — Grant Milestone 1 progress) |
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

> **✅ Safe raised to 2-of-3 (2026-07-10).** `addOwnerWithThreshold(0x403A027b6c217C5E08cE4497A55732056067FD2D, 2)`
> was executed via `execTransaction` from app.safe.global (both existing
> owners confirmed), block `51087021`, tx
> `0xa375ed9b9a692246600a57a09dc6163d0306afe95578fbccb5c84deaacba1276`.
> Verified on-chain: `getOwners()` returns all three addresses, `getThreshold()`
> is still 2 — losing access to any one of the three signers no longer
> deadlocks the arbitrator role.

> **Board state:** all 17 open listings on superseded V4.2 were reclaimed via
> `scripts/reclaim-bounties.ts` (~28 USDC returned to the poster wallet across
> 17 `cancelBounty` txs, 2026-07-08) before this deployment's re-seed. Two
> more listings — "viem script: watch BountyCreated and print new bounties"
> and "TypeScript snippet: pin a Buffer to Pinata v3" (bond-required) — were
> posted 2026-07-09 (`SEED_LIMIT=2 SEED_DEADLINE_DAYS=60`) specifically to
> re-run the agent proof-of-life flow on this deployment, then completed
> end-to-end by the same reused agent identity (jobIds `154216`/`154217`,
> agentId `847205`) — see `scripts/agent-proof-of-life.ts`. `totalBounties()`
> is 22, 14 open (state as of 2026-07-09; those 14 were reclaimed 2026-07-10
> ahead of the V4.4 deployment — see the current section above).

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

## Base Mainnet (chain id `8453`) — BaseBounty, V4.6 live

> Arc Testnet above remains the deployment cited in the submitted grant
> application. This is the separate **BaseBounty** brand on Base mainnet
> (`basebounty.app`), same V4.6 contracts, its own signer set.

### BountyAdapter (V4.6 — live)

| Field | Value |
|---|---|
| Address | `0x8F367e17d96EB83c4A51b3349e3CE30447aDB7e2` |
| AgenticCommerce (proxy) | `0xD87Ece19382044b69f4E9cb89e71A0Aa3Aeb9f9f` |
| AgenticCommerce (impl) | `0x2948F64Af4d218394c426609D8Aea22914D13468` |
| RPC | `https://mainnet.base.org` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (re-verified at deploy time: `symbol()=="USDC"`, `decimals()==6`) |
| IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` (official 8004-team registry — same canonical address as testnet, code confirmed on 8453) |
| ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` (official 8004-team registry — same canonical address as testnet, code confirmed on 8453) |
| Fee | 100 bps (1%), matches Arc |
| Fee recipient | `0xADac7534d3fE868E28c77df5CD930f2635bcb63A` (same wallet as Arc; two-step `transferFeeRecipient` if it ever moves) |
| maxBountyAmount | `500000000` (500 USDC, atomic) |
| Owner (`setMaxBountyAmount` admin) | deployer `0x6abc2b575eC66701c17DAD96dDA97F22b837849E` — fresh mainnet key, never used on testnet |
| AgenticCommerce admin (upgrade key) | deployer — verified on-chain `hasRole(DEFAULT_ADMIN_ROLE, deployer) == true` |
| Arbitrator | ✅ the Safe `0x74678c072Ca546f11466CD44eB7e21730a312a54` — two-step handshake complete 2026-08-14. `transferArbitrator` from the deployer (tx `0xf285578a8c21745994169beaa0f837c6ad933a300ec9778f080a3f3105158326`, block `49964879`), then `acceptArbitrator()` executed **from the Safe** with 2 of 3 signatures (`0xed733FC1…` + `0xC6B48f60…`, executed by the latter) via app.safe.global — tx `0x6df88b7ecfb79e3771b4b6e86d5d3132c34fc85f1e6629f4fc048e0419398a99`, block `49965922`. Confirmed on-chain: `arbitrator()` returns the Safe, `pendingArbitrator()` is zero. |
| Deployed | 2026-08-14, block `49964666`, gas 7,272,443 across 3 txs (impl 258,837 + proxy 2,127,457 + adapter 4,886,149) at ~0.01 gwei ≈ 0.0000366 ETH actually spent |
| Deploy txs | impl `0xd1b104b8a3239948323ad8bec5d2ef9ba357cb87a7c6914e2b2d8a0c2ecc45cf`, proxy `0x3720c5a95c4403e9ccaa41dadf558fb0be5470857dc18e391c6602bfe12c64e4`, adapter `0x4a0b161934b9861d7fdde03c0329c4f2b0bfdee589602a1c5ed3461edbba0f0e` |
| `adapterDeployBlock` for the network maps | `49964666` (recorded from the `forge` output at deploy time, per the Sepolia lesson below) |
| Basescan | all three contracts verified during the deploy run (`--verify`, Etherscan V2 key) |
| Deploy script | `contracts/script/DeployBaseMainnet.s.sol` — hard `block.chainid == 8453` guard, code-presence checks on USDC and both registries before broadcasting, and post-deploy `require`s that the escrow admin role and adapter owner landed on the deployer |

### Arbitrator Safe (Base mainnet)

| Field | Value |
|---|---|
| Address | `0x74678c072Ca546f11466CD44eB7e21730a312a54` |
| Version | SafeL2 v1.4.1 — singleton `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762`, fallback handler `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99`, byte-for-byte the same configuration as the Arc Safe (verified by reading Arc's slot 0 / handler slot / `VERSION()`) |
| Owners | `0xed733FC13B1413966cf056866B6d80eF7b490eEc`, `0x403A027b6c217C5E08cE4497A55732056067FD2D`, `0xC6B48f603C439B4a6b55462AfCae10594D31242A` |
| Threshold | 2 of 3 (confirmed on-chain via `getOwners()` / `getThreshold()`) |
| Created | 2026-08-14, block `49964833`, tx `0xf3f5fdcf4bc36e3a0df884372e2da6d3e140a4746a4bbbc3e924369744346669`, 313k gas |
| How | `scripts/safe-create-base.ts` — canonical `SafeProxyFactory` `0x4e1DCf7A…0ec67`, not app.safe.global. The result is an ordinary canonical Safe and appears in the Safe web app: `https://app.safe.global/home?safe=base:0x74678c072Ca546f11466CD44eB7e21730a312a54` |
| Signer set | Deliberately **not** Arc's: the third Arc signer was the testnet deployer whose key lives in plaintext `.env`. Per `PRE_MAINNET_RUNBOOK.md` §9, mainnet gets its own set, and the mainnet deploy key is not an owner — it only paid gas. |

## Base Sepolia (chain id `84532`) — staging, V4.6 current

> Arc Testnet above remains the live, canonical deployment (the address the
> frontend/SDK/MCP server all target). This section is staging ahead of
> Base mainnet — it does not change what "canonical" means anywhere else in
> this repo.

> **⚠️ Both staging escrows have an unreachable admin (found 2026-08-14).**
> `DeployBaseSepolia.s.sol` read `address deployer = msg.sender;` *inside*
> `run()`. `vm.startBroadcast(pk)` rewrites the sender of the calls the script
> makes, but not `msg.sender` of the script's own frame — that stays Foundry's
> default sender `0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38` unless `--sender`
> or `--private-key` is passed on the command line. So the address handed to
> `AgenticCommerce.initialize(..., admin_)` was that keyless constant, and
> `DEFAULT_ADMIN_ROLE` (UUPS upgrade authority, `setPlatformFee`) landed there
> on both V4.5 and V4.6. `BountyAdapter` was unaffected — its constructor reads
> its own `msg.sender`, which really is the broadcaster — which is why the
> owner/arbitrator rows are correct and the E2E runs passed: the admin role is
> never touched at runtime. Consequence is limited to staging: those two
> escrows can never be upgraded or re-configured. **Fixed** in both deploy
> scripts by deriving the address explicitly (`vm.addr(deployerKey)`), plus
> post-deploy `require`s; Base mainnet was deployed with the fixed script and
> verified on-chain to hold the role on the real deployer.

### BountyAdapter (V4.6 — current staging target)

| Field | Value |
|---|---|
| Address | `0x32EC90A4dad0bbdFF0eF44461c353aC5C02757F4` |
| AgenticCommerce (proxy) | `0xbe6e78207140d21d5FcF5595Ad396e482f1Cd384` |
| AgenticCommerce (impl) | `0xB15a22b6E16A3717B655796Ada4Fc64C57Ea90A1` |
| Deployed | 2026-08-13, block `45438882`, gas 7,272,443 across 3 txs (impl 258,837 + proxy 2,127,457 + adapter 4,886,149) at 0.011 gwei ≈ 0.0001 ETH |
| Change vs V4.5 | `_payOrPark` pull-payment fallback — see the V4.6 notes in `src/BountyAdapter.sol`. Same USDC / registry / fee-recipient / cap configuration as V4.5 below. |

**E2E proof-of-life on V4.6 (2026-08-13):** jobId `1`, same wallet as poster and
worker. Full cycle `approve` → `createBounty` (1 USDC) → `takeBounty` →
`submitWork` → `approveBounty(95)`. Balances reconcile exactly: deployer
19.99 → 18.99 (bounty funded) → **19.98** (0.99 payout received), 0.01 fee to
the fee recipient, **0 USDC left in the adapter**, and
`pendingWithdrawals(deployer) == 0` — i.e. the direct push succeeded and the
new fallback did not fire on a healthy transfer.

> **What this run does NOT prove.** The park-and-withdraw path itself cannot be
> exercised on a live network: blacklisting is Circle's privilege, not
> something a deployment can trigger. That path is covered by the 8 unit tests
> against a `Blacklistable` mock, which were verified to fail against the old
> push implementation. Live testing here only confirms V4.6 did not regress the
> healthy path.

### BountyAdapter (V4.5 — superseded 2026-08-13, kept for reference)

Rehearsal deploy ahead of Base mainnet (per `Part2_Base/TZ_arcbounty_circle_stack_base.md`
Block 4). Deployed via `contracts/script/DeployBaseSepolia.s.sol`. Does **not**
touch Arc — Arc's live V4.4 deployment is untouched and remains the one cited
in the submitted grant application.

| Field | Value |
|---|---|
| BountyAdapter | `0x39e8D70BF771001d8FDa13354c2CE5c2DD6229D9` |
| AgenticCommerce (proxy) | `0x37BB41D12adC01cBFb9Ca69098F9E09E0938a673` |
| AgenticCommerce (impl) | `0x5E7106382bA80c8805A570dEE4cB4bC321a8Ed83` |
| RPC | `https://sepolia.base.org` |
| USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` (official 8004-team testnet registry — not self-deployed) |
| ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` (official 8004-team testnet registry — not self-deployed) |
| Fee | 100 bps (1%), matches Arc |
| Fee recipient | `0xADac7534d3fE868E28c77df5CD930f2635bcb63A` (same wallet as Arc) |
| maxBountyAmount (V4.5) | `500000000` (500 USDC, atomic) |
| Owner (maxBountyAmount admin) | deployer `0xde427f3967cc7a0BF7A9F891195760cCffC82edA` — no Base Safe yet; create one before mainnet |
| Arbitrator | deployer (unset — no Base Safe yet; must run the two-step handshake before mainnet, exactly as Arc did) |
| AgenticCommerce admin (upgrade key) | ⚠️ **not the deployer — stranded.** Verified 2026-08-14: `hasRole(DEFAULT_ADMIN_ROLE, 0xde427f…)` is `false` and the role sits on `0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38`, Foundry's default sender, for which no private key exists. Same on the V4.6 escrow above. Cause and fix in the note below. |
| Deployed | 2026-07-20, gas: 7,159,306 total across 3 txs (impl + proxy + adapter) ≈ 0.000043 ETH at the block's gas price — at typical Base mainnet gas prices this is expected to land in cents, not dollars |
| Deploy blocks | BountyAdapter `44398167`, AgenticCommerce proxy `44398166` (both 2026-07-20T16:23:4xZ). Recovered after the fact by binary-searching `eth_getCode` — the original deploy recorded tx hashes but no block numbers. `adapterDeployBlock` in both network maps is the lower bound for chunked event scans, so **record it from the `forge` output at deploy time** for Base mainnet rather than reconstructing it later. |
| Escrow source | `src/base/AgenticCommerce.sol` — byte-for-byte match of Arc's own deployed variant (not the current, role-restricted ERC-8183 reference); see `docs/INTEGRATION_NOTES.md` for why |

**E2E proof-of-life (2026-07-20):** jobId `1`, same wallet as both poster and
worker (allowed — `takeBounty` has no poster≠worker restriction). Full cycle:
`approve` → `createBounty` (1 USDC reward) → `takeBounty` → `submitWork` →
`approveBounty(95)`. Final `getBountyMeta(1)` confirms `resolved = true`.
Payout matched Arc's exact split: 0.99 USDC to the worker, 0.01 USDC (1% fee)
to the fee recipient. Tx hashes: create `0x2fd14154…8873`, take
`0xad38d732…905b`, submit `0x41e491d5…8df4`, approve `0xa4987bb4…bdb0`.

## Updating this file after a redeploy

1. Run `script/Deploy.s.sol`.
2. Replace the address in the table above.
3. Update `BOUNTY_ADAPTER_ADDRESS` and `NEXT_PUBLIC_BOUNTY_ADAPTER_ADDRESS`
   in both `.env` and Vercel env.
4. Bump the SDK version (`agent-sdk/package.json`) and republish if its
   ABI changed.
