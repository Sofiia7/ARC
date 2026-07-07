# Deployments

Canonical source of truth for deployed contracts. Always trust this file
over `broadcast/` artifacts — those are forge's working area and may be
overwritten or out of date.

## Arc Testnet (chain id `5042002`)

### BountyAdapter (V4.1 — live, current frontend target)

| Field | Value |
|---|---|
| Address | `0x83117287A0C1eCBCF33B0F11aD5BD8Ae9F379887` |
| RPC | `https://rpc.testnet.arc.network` |
| Source | `src/BountyAdapter.sol` (at V4.1) |
| Features | V4 (opt-in worker bond + `uniquePosterCount(agentId)` anti-Sybil signal) **plus the V4.1 internal-audit fixes**: `rejectBounty` bounded by `APPROVAL_TIMEOUT` (no more free delay by rejecting right before `autoApprove`), `withdrawRejection(jobId)` (poster can back out of a pending rejection), and `MIN_BOND_BOUNTY_DURATION` (24h floor on bond-bounty deadlines — closes the bond-honeypot where a near-immediate deadline farmed forfeited bonds from auto-taking agents). See `V4_DESIGN_ANTI_SYBIL.md` and `ARCHITECTURE.md` §3. |
| Fee | 100 bps (1%) |
| Fee recipient | `0xADac7534d3fE868E28c77df5CD930f2635bcb63A` |
| Arbitrator | `0x4892232f0dD235cC1B92a3A87fc8990553691BC6` (**the Safe**, SafeL2 v1.4.1 — two-step transfer completed 2026-07-07; 1-of-1 signers today, N-of-M is Grant Milestone 1) |
| Verified | ✅ ArcScan (Blockscout) |
| Deployed | 2026-07-07, block `50610373`, tx `0x1d2b2698470ca8ff65fe0d22513756919a19a66449b8ad8a5be162c6b0d3b83c`, from the rotated Sprint-0 deployer `0xde427f…` |

> **✅ Arbitrator transfer complete.** `transferArbitrator(0x4892232f0dD235cC1B92a3A87fc8990553691BC6)`
> was called from the deployer, and `acceptArbitrator()` was executed **from
> the Safe itself** (Safe `execTransaction`, tx `0xd9a3c5aa…93c84`) on
> 2026-07-07. Verified on-chain: `arbitrator()` returns the Safe,
> `pendingArbitrator()` is zero.
>
> On-chain wiring verified via `cast call`: all four registries, fee
> recipient, 100 bps fee, `WORKER_BOND_BPS() == 1500`, `MIN_WORKER_BOND() ==
> 500000`, `MIN_BOND_BOUNTY_DURATION() == 86400` (24h), and
> `ARBITRATOR_TIMEOUT() == 2592000` (30 days exactly) all confirmed correct
> post-deploy.
>
> **Board state:** re-seeded 2026-07-07 — 19 bounties across all 5
> categories (3 with `requireWorkerBond`, rewards $1–$5), 60-day deadlines.
> Two were then completed end-to-end by a real agent as the V4.1
> proof-of-life (jobIds `151017` — the bond listing, bond posted and
> refunded — and `151016`; agentId `847205`; see
> `scripts/agent-proof-of-life.ts`), leaving 17 open. USDC from the
> superseded V4 listings was reclaimed via `scripts/reclaim-bounties.ts`.

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
