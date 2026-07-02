# ArcBounty — Smart Contracts

Foundry workspace for **`BountyAdapter.sol`**, the single facade contract that powers ArcBounty.

The adapter does **not** roll its own escrow. It plugs into Arc's native standards:

- **ERC-8183 (AgenticCommerce)** — escrow and job lifecycle
- **ERC-8004 (Trustless Agents)** — Identity + Reputation

Solidity `0.8.30`, EVM `cancun`, `via_ir = true`, optimizer 200 runs.

## Layout

```
src/
  BountyAdapter.sol          — 556 LOC, main contract
  interfaces/
    IAgenticCommerce.sol     — minimal ERC-8183 surface used by adapter
    IIdentityRegistry.sol    — ERC-8004 identity reads
    IReputationRegistry.sol  — ERC-8004 reputation writes
test/
  BountyAdapter.t.sol          — 60 unit tests
  BountyAdapterInvariant.t.sol — 2 stateful invariants
  BountyAdapterFork.t.sol      — fork test against live Arc Testnet
script/
  Deploy.s.sol               — deploy + log address
foundry.toml
```

## What's in `BountyAdapter`

Lifecycle entry points (all `nonReentrant`):

| Phase | Function | Caller |
|---|---|---|
| Create | `createBounty(CreateParams)` | poster |
| Take (anti-race) | `takeBounty(jobId, agentId)` | worker |
| Submit | `submitWork(jobId, resultCid)` | worker |
| Approve | `approveBounty(jobId, score)` | poster |
| Cancel | `cancelBounty(jobId)` | poster (only before take) |
| Expire | `expireBounty(jobId)` | anyone, after deadline |
| Reject → Challenge | `rejectBounty(jobId, reasonCid)` → `challengeRejection(jobId, reasonCid)` | poster → worker, 48 h window |
| Dispute (V2) | `disputeBounty(jobId, reasonCid)` → `respondToDispute(jobId, responseCid)` → `resolveDispute(jobId, payProvider, rulingCid, penaltyBps)` | worker → poster → arbitrator |
| Governance | `transferArbitrator(next)` + `acceptArbitrator()` | two-step, multisig-safe |

Design notes:

- **Variant B+**: the adapter takes all three AC roles (client + provider + evaluator). The real worker is tracked in `BountyMeta.assignedProvider`; the payout is forwarded via balance-delta accounting inside `_completeAndForward`. This matches the real ERC-8183 implementation on Arc.
- **Audience filter**: `agentOnly` and `humanOnly` are mutually exclusive (`require(!(agentOnly && humanOnly))`) and enforced at `takeBounty`.
- **Fees**: `feeBps` is immutable and capped at `10 %` (1000 BPS); production deployment uses `100` (1 %).
- **Whitelisted provider**: if `CreateParams.provider != 0`, only that address (or the owner of its ERC-8004 agentId) may take the bounty — supports both pre-assignment and agent-id matching.

## Build & test

```bash
forge install
forge test                  # 60 unit + 2 invariant (62); +1 fork test = 63 with RPC configured
forge test -vvv             # verbose
forge snapshot              # gas snapshot
forge coverage              # line coverage
```

## Deploy

`Deploy.s.sol` reads all addresses from env. Set the following:

| Env var | Value (Arc Testnet) |
|---|---|
| `PRIVATE_KEY`         | deployer private key |
| `AGENTIC_COMMERCE`    | `0x0747EEf0706327138c69792bF28Cd525089e4583` |
| `IDENTITY_REGISTRY`   | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| `REPUTATION_REGISTRY` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| `USDC_ADDRESS`        | `0x3600000000000000000000000000000000000000` |
| `FEE_RECIPIENT`       | address that collects the 1 % protocol fee |
| `ARC_TESTNET_RPC_URL` | `https://rpc.testnet.arc.network` |

Then:

```bash
forge script script/Deploy.s.sol:Deploy \
  --rpc-url $ARC_TESTNET_RPC_URL \
  --private-key $PRIVATE_KEY \
  --broadcast --verify
```

The deployed address prints to stdout as `BountyAdapter deployed at: 0x…`. Plug it into `frontend/.env.local` (`NEXT_PUBLIC_BOUNTY_ADAPTER_ADDRESS`) and `scripts/seed-bounties.ts` (`BOUNTY_ADAPTER_ADDRESS`).

## Current deployment

| Network | Address |
|---|---|
| Arc Testnet | [`0x5E7106382bA80c8805A570dEE4cB4bC321a8Ed83`](https://testnet.arcscan.app/address/0x5E7106382bA80c8805A570dEE4cB4bC321a8Ed83) |

Verified end-to-end by a real AI agent (not a human): jobId `145613`, agentId `844730`, worker `0x6543…6115` took the bounty, submitted work, and was paid `0.99` USDC of `1` USDC face value via canonical ERC-8183 escrow — proves `approveBounty` no longer reverts for agent workers (`agentId > 0`) on V3.2. Source verified on ArcScan.

## ABI export

After `forge build`, the ABI is at `out/BountyAdapter.sol/BountyAdapter.json`. The frontend keeps its own type-safe ABI subset in [`../frontend/lib/contracts.ts`](../frontend/lib/contracts.ts) and the SDK in [`../agent-sdk/src/abi.ts`](../agent-sdk/src/abi.ts) — both must be regenerated when the contract changes.

## License

MIT.
