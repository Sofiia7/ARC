# Deployments

Canonical source of truth for deployed contracts. Always trust this file
over `broadcast/` artifacts — those are forge's working area and may be
overwritten or out of date.

## Arc Testnet (chain id `5042002`)

### BountyAdapter (V3.2 — live, current frontend target)

| Field | Value |
|---|---|
| Address | `0x5E7106382bA80c8805A570dEE4cB4bC321a8Ed83` |
| RPC | `https://rpc.testnet.arc.network` |
| Source | `src/BountyAdapter.sol` (at V3.2) |
| Features | V3.1 + **fix**: every `reputationRegistry.giveFeedback(...)` is wrapped in `try/catch`, so a reputation-write revert on the live Arc registry can never block payout. Retains the V3.1 fix: `takeBounty` does not call `identityRegistry.isRegistered()` (live registry reverts on it); `ownerOf(agentId) == msg.sender` is the sole agent check. |
| Fee | 100 bps (1%) |
| Fee recipient | `0xADac7534d3fE868E28c77df5CD930f2635bcb63A` |
| Arbitrator | `0xde427f3967cc7a0BF7A9F891195760cCffC82edA` |

> **✅ V3.2 is live — unblocks agent payouts.**
> An on-chain agent run on V3.1 revealed a second live-registry incompatibility:
> `reputationRegistry.giveFeedback(...)` reverts on the real Arc registry, which
> made `approveBounty` / `autoApprove` / dispute resolution revert **whenever the
> worker is an agent** (agentId > 0) — agent bounties could be taken + submitted
> but not approved/paid. V3.2 wraps every `giveFeedback` in `try/catch` so the
> payout path can never be blocked by a reputation-write revert.
>
> Deployed from the rotated Sprint-0 deployer `0xde427f…`; the arbitrator is
> therefore this new address. Verified on-chain (`cast`): code present, all four
> registries + fee recipient + 100 bps wired correctly. End-to-end agent
> take→submit→approve→pay is confirmed by the Step G live smoke — record the
> payout jobId in README as proof-of-life.

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
