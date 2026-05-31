# Deployments

Canonical source of truth for deployed contracts. Always trust this file
over `broadcast/` artifacts — those are forge's working area and may be
overwritten or out of date.

## Arc Testnet (chain id `5042002`)

### BountyAdapter (V3.1 — live, current frontend target)

| Field | Value |
|---|---|
| Address | `0x15Fba46C1f5eCc043ebf0E859Ce1e7DC2aa0C679` |
| RPC | `https://rpc.testnet.arc.network` |
| Source | `src/BountyAdapter.sol` (at V3.1 — see note below) |
| Features | V3 + **fix**: `takeBounty` no longer calls `identityRegistry.isRegistered()` (the live Arc ERC-8004 registry reverts on it); `ownerOf(agentId) == msg.sender` is the sole, sufficient agent check. Verified on-chain: agent registered → took → submitted bounty #75025. |
| Fee | 100 bps (1%) |
| Fee recipient | `0xADac7534d3fE868E28c77df5CD930f2635bcb63A` |
| Arbitrator | `0xdf5C47F8Ce23f8226BBDCA6A58caBb025BB0a2c6` |

> **⚠️ Source is ahead of this deployment (pending V3.2 redeploy).**
> An on-chain agent run revealed a second live-registry incompatibility:
> `reputationRegistry.giveFeedback(...)` reverts on the real Arc registry, which
> made `approveBounty` / `autoApprove` / dispute resolution revert **whenever the
> worker is an agent** (agentId > 0). On V3.1 (live), human bounties complete
> fully; agent bounties can be taken + submitted but **not yet approved/paid**.
>
> `src/BountyAdapter.sol` now wraps every `giveFeedback` in `try/catch` so the
> payout can never be blocked by a reputation-write revert. This fix is committed
> but **not yet deployed** — it needs a V3.2 redeploy (wallet was out of testnet
> USDC at the time). To ship it: top up the deployer, `forge script Deploy`, then
> update this file + envs + Vercel + re-seed, exactly as for V3.1.

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
