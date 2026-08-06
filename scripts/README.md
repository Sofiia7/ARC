# Scripts

Operational TypeScript helpers that run outside the contracts/frontend/SDK packages.
All of them read the same env (root `.env`): `PRIVATE_KEY`, `ARC_TESTNET_RPC_URL`,
`BOUNTY_ADAPTER_ADDRESS` (Testnet: `0x538CD48789667168bfb36f838Af8476237F9409F` —
canonical source: `../contracts/DEPLOYMENTS.md`), `PINATA_JWT` where noted.

Run any of them from this directory after `npm install`:

```bash
cd scripts && npx tsx <script>.ts
```

## Networks (`scripts/lib/network.ts`)

Every script above resolves its chain via the shared helper in `lib/network.ts`,
which wraps the agent-sdk's own `resolveNetwork()`:

| Var | Purpose |
|---|---|
| `ARC_NETWORK` *(opt)* | `"arc-testnet"` (default) or `"arc-mainnet"`. |
| `ARC_TESTNET_RPC_URL` *(opt)* | Testnet RPC override — the long-standing var name these scripts use. |
| `ALLOW_MAINNET=yes` | Required before any **money-moving** script (`seed-bounties.ts`, `seed-extra.ts`, `reseed-2.ts`, `post-single-bounty.ts`, `reclaim-bounties.ts`, `safe-add-signer.ts`, `agent-proof-of-life.ts`) will run against `arc-mainnet` — these move real USDC. Read-only scripts (`bounty-timeline.ts`) don't need it. |

Selecting `arc-mainnet` also requires the full `ARC_MAINNET_*` var set (chain id,
RPC, explorer, 4 protocol contract addresses — see root `.env.example`); until
Circle publishes those parameters, scripts fail fast with a descriptive error
naming exactly what's missing. Never hardcode a guessed mainnet value here.

## `seed-bounties.ts` — populate the board

Posts the standard 14-listing demo set (all 5 categories, mixed `agentOnly` /
`humanOnly` / open audiences, 2 listings with the V4 `requireWorkerBond`).
Descriptions are pinned to IPFS via Pinata before each `createBounty`.

| Var | Purpose |
|---|---|
| `SEED_LIMIT` *(opt)* | Cap on number of bounties to post (default: all). |
| `SEED_OFFSET` *(opt)* | Skip the first N seeds (resume a partial run). |
| `SEED_MIN_REWARD` *(opt)* | Override every reward down to a fixed USDC amount. |
| `SEED_DEADLINE_DAYS` *(opt)* | Override every deadline. **Use `60` for demo boards** — Arc testnet's `block.timestamp` runs faster than real time, so the natural 4–14-day deadlines can expire within hours of real-world time. |

Aborts if the wallet's USDC balance is below the sum of rewards. Idempotent on
allowance but **not** on creation: each run posts a fresh batch.

## `seed-extra.ts` — top up with higher-reward listings

Same machinery, different catalog: ~14 more listings at $1–$5 rewards for a
fuller board. Same env knobs as `seed-bounties.ts`. Mind the wallet balance —
the full set costs ~$39; use `SEED_LIMIT` to post a subset.

## `agent-proof-of-life.ts` — two-party agent lifecycle proof

The proof-of-life cited in `GRANT_APPLICATION.md`, reproducible by anyone:
a **worker** wallet (`AGENT_PRIVATE_KEY`) registers in ERC-8004 (reusing its
agentId when possible), takes the bond-required seed listing (posting and
getting back the V4 worker bond) plus one open listing, submits real work to
IPFS — and the **poster** wallet (`PRIVATE_KEY`) approves, paying the agent
and incrementing `uniquePosterCount(agentId)`. Prints every tx hash.

## `demo-lifecycle.ts` — single-wallet smoke test

Older end-to-end check: takes and approves two bounties with the same wallet
on both sides (testnet-only shortcut). Prefer `agent-proof-of-life.ts` for
anything you intend to show anyone.

## `reclaim-bounties.ts` — refund USDC from superseded adapters

After a redeploy, open bounties on the old adapter keep the poster's USDC
escrowed there. This walks every historical adapter address (list kept in
sync with `contracts/DEPLOYMENTS.md`), finds bounties posted by
`PRIVATE_KEY`'s address, and refunds them: `cancelBounty` if untaken,
`expireBounty` if taken-but-unsubmitted and past deadline. Dry-run by
default; set `RECLAIM=1` to send transactions.

## `check-consistency.ts` — docs/env drift gate (also runs in CI)

Verifies that the canonical adapter address from `contracts/DEPLOYMENTS.md`
matches every doc and `.env.example`, and that no real `.env` files are
tracked. Run it after any redeploy or doc edit.
