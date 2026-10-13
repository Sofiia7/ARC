# NadBounty Envio indexer

**Scope: Monad TESTNET (chain 10143), Base (8453) and Arc (5042). It does not index Monad mainnet (143)**: `config.yaml` has no chain 143 entry, and the mainnet site at https://nadbounty.app reads the chain directly instead.

Indexes Monad testnet V4.8 bounty/contest events, mirror snapshots, Base/Arc legacy bounty events and ERC-8004 identity transfers. Event identity is chain + transaction hash + log index; owners and contracts are normalized to lowercase. Each bounty fact retains its source block, timestamp and transaction hash.

Run on Linux with Node 22.15 or newer:

```sh
npm ci
npm run codegen
npm run typecheck
```

The dedicated GitHub workflow runs code generation and TypeScript checks on Linux without service credentials. Windows native execution is unsupported by Envio. Running the actual indexer additionally requires supported Docker/Postgres infrastructure, configured RPCs and an Envio token where required for HyperSync. Copy `.env.example` to a private `.env` before local runtime setup.

Linux code generation and TypeScript passed in [run 37838342074](https://github.com/Sofiia7/ARC/actions/runs/37838342074). Envio 3 requires `@crossChain` on these explicitly chain-keyed entities; this was verified by codegen. [PR #6](https://github.com/Sofiia7/ARC/pull/6) merged after all CI checks passed. This proves the schema/handler build, not continuous indexing; the hosted endpoint described next was added afterwards.

This first schema stores event facts and identity/mirror state. It does not claim to derive a trusted reputation gate from bounty events alone: registry feedback can fail or be revoked. The exact, live-verified raw feedback reader lives in `scripts/lib/nad-reputation.ts`; integrating its active-feedback semantics and durable old-recipient discovery is still required for the production mirror workflow. Identity indexing starts at the chain origin to preserve ownership history; narrow it only with a verified registry-deployment block or a complete seeded ownership checkpoint.

## Hosted history source

Monad Testnet10143, Base8453 and Arc5042 use Envio HyperSync as their primary source. Explicit RPC sync was removed after the hosted Arc RPC returned pruned history and Monad RPC required tiny block windows. Both https://10143.hypersync.xyz/height and https://5042.hypersync.xyz/height were verified on2026-10-09. Chain origins and per-adapter deployment ranges remain unchanged, preserving identity ownership history. See https://docs.envio.dev/docs/HyperIndex/configuration-file and https://docs.envio.dev/blog/index-arc-usdc-transfers. Envio Cloud manages its HyperSync credentials; local runs still require an Envio token.

## Live GraphQL endpoint

https://nadbounty-indexer.89-124-77-59.sslip.io/v1/graphql

A self-hosted Hasura (see `VPS.md`) in front of the Envio indexer. Only the public, read-only GraphQL path is exposed: the console and metadata are not, and the public role has no mutations. It answers `POST` with a JSON body. Quick check:

```sh
curl -s -X POST https://nadbounty-indexer.89-124-77-59.sslip.io/v1/graphql -H 'content-type: application/json' -d '{"query":"{ __typename }"}'
```

returns `{"data":{"__typename":"query_root"}}` (verified on 2026-10-13).

What it holds: `chain_id` 10143 (Monad **testnet**, adapter `0xf88B980B3AB1CD5A2Befd9c0B88B70196f215020` from block 69191994, the V4.8 rehearsal deployment), 8453 (Base) and 5042 (Arc), exactly the chains in `config.yaml`. It holds nothing for Monad mainnet: a `BountyEvent` query with `chainId: {_eq: 143}` returns no rows (verified on 2026-10-13). The entities are the ones in `schema.graphql` (`BountyEvent`, `Identity`, `IdentityTransfer`, `MirrorRecord`) plus Hasura's `chain_metadata`. Addresses are lowercase, and `BigInt` fields come back as strings.

### Example queries

Each one was run against the endpoint on 2026-10-13; the results quoted are what it returned.

1. Which chains are indexed and how fresh they are.

   ```graphql
   { chain_metadata { chain_id latest_processed_block block_height is_hyper_sync } }
   ```

   Returned chain ids 5042, 8453 and 10143, each with `is_hyper_sync` true and `latest_processed_block` within a few blocks of `block_height`.

2. The full lifecycle of one contest, job 7 on Monad testnet (created, entered, rejected, challenged, then awarded and settled by the keeper).

   ```graphql
   {
     BountyEvent(where: {chainId: {_eq: 10143}, jobId: {_eq: 7}}, order_by: {blockNumber: asc}) {
       kind blockNumber timestamp transactionHash
     }
   }
   ```

   Returned eight events, `ContestCreated` and `BountyCreated` at block 69228125 through `ContestAwarded` and `ContestSettled` at block 69800115 (transaction `0x112b4a4036ece28231d3a28827ecefedd2bd94edd2cdefacfab719b2d8c4107a`).

3. Cross-chain reputation records mirrored into the Monad testnet `ReputationMirror`, newest source block first.

   ```graphql
   {
     MirrorRecord(where: {valid: {_eq: true}}, order_by: {sourceBlock: desc}) {
       chainId identityOwner sourceChain sourceBlock paidJobs scoreSum
     }
   }
   ```

   Returned five records, for example the Arc owner `0x092f4483526ebc2476c247cb88d166adb7c3232f` with `sourceChain` 5042, `paidJobs` 6 and `scoreSum` 535 (testnet mirror, source block 25025504).

4. Current owner and ownership history of an ERC-8004 identity (agent 2077 on Monad testnet).

   ```graphql
   {
     Identity(where: {chainId: {_eq: 10143}, agentId: {_eq: 2077}}) { agentId owner sourceBlock }
     IdentityTransfer(where: {chainId: {_eq: 10143}, agentId: {_eq: 2077}}, order_by: {blockNumber: asc}) {
       previousOwner owner blockNumber logIndex
     }
   }
   ```

   Returned the current owner `0x6543555570adf7f38e536b028d9db5973a266115` (source block 69227931) and one transfer, from the zero address (the mint) to that owner at the same block.
