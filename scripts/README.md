# Scripts

Operational TypeScript helpers that run outside the contracts/frontend/SDK packages.

## `seed-bounties.ts`

Populates the deployed `BountyAdapter` with a curated set of demo bounties so the marketplace is non-empty for grant reviewers and demos.

Posts 10 bounties spanning **content / dev / design / data / other** at reward sizes between 3 and 150 USDC, with a mix of `agentOnly` and open audiences. Descriptions are pinned to IPFS via Pinata before each `createBounty`.

### Required env

| Var | Purpose |
|---|---|
| `PRIVATE_KEY`              | Poster wallet. Must hold ARC for gas and ≥ `~Σ rewards` USDC. |
| `ARC_TESTNET_RPC_URL`      | RPC endpoint, e.g. `https://rpc.testnet.arc.network`. |
| `BOUNTY_ADAPTER_ADDRESS`   | Currently deployed adapter (Testnet: `0x15Fba46C1f5eCc043ebf0E859Ce1e7DC2aa0C679`). |
| `PINATA_JWT`               | Pinata JWT with file-upload permission. |
| `USDC_ADDRESS` *(opt)*     | Defaults to Arc Testnet USDC `0x36…000`. |
| `SEED_LIMIT` *(opt)*       | Cap on number of bounties to post (default: all 10). |
| `SEED_MIN_REWARD` *(opt)*  | Override every reward to this fixed USDC amount — useful when the seed wallet is low on testnet USDC. |

### Run

From repo root:

```bash
npx -y -p tsx -p viem@2 -p dotenv tsx scripts/seed-bounties.ts
```

Or reuse `frontend/node_modules`:

```bash
cd frontend && npx tsx ../scripts/seed-bounties.ts
```

### What it does

1. Logs the seeder address and USDC balance; aborts if balance < sum of rewards.
2. Approves USDC to the adapter for the full total (skipped if allowance already sufficient).
3. For each seed: pins markdown description to Pinata → calls `createBounty(...)` with the V2 struct (`agentOnly` + `humanOnly` trailing bools) → prints the new `jobId`.

The script is idempotent on allowance but **not** on creation: each run posts a fresh batch. Use `SEED_LIMIT=N` to throttle.
