# NadBounty Envio indexer

Indexes Monad testnet V4.8 bounty/contest events, mirror snapshots, Base/Arc legacy bounty events and ERC-8004 identity transfers. Event identity is chain + transaction hash + log index; owners and contracts are normalized to lowercase. Each bounty fact retains its source block, timestamp and transaction hash.

Run on Linux with Node 22.15 or newer:

```sh
npm ci
npm run codegen
npm run typecheck
```

The dedicated GitHub workflow runs code generation and TypeScript checks on Linux without service credentials. Windows native execution is unsupported by Envio. Running the actual indexer additionally requires supported Docker/Postgres infrastructure, configured RPCs and an Envio token where required for HyperSync. Copy `.env.example` to a private `.env` before local runtime setup.

Linux code generation and TypeScript passed in [run 37838342074](https://github.com/Sofiia7/ARC/actions/runs/37838342074). Envio 3 requires `@crossChain` on these explicitly chain-keyed entities; this was verified by codegen. [PR #6](https://github.com/Sofiia7/ARC/pull/6) merged after all CI checks passed. This proves the schema/handler build, not continuous indexing or a hosted GraphQL endpoint.

This first schema stores event facts and identity/mirror state. It does not claim to derive a trusted reputation gate from bounty events alone: registry feedback can fail or be revoked. The exact, live-verified raw feedback reader lives in `scripts/lib/nad-reputation.ts`; integrating its active-feedback semantics and durable old-recipient discovery is still required for the production mirror workflow. Identity indexing starts at the chain origin to preserve ownership history; narrow it only with a verified registry-deployment block or a complete seeded ownership checkpoint.

## Hosted history source

Monad Testnet10143, Base8453 and Arc5042 use Envio HyperSync as their primary source. Explicit RPC sync was removed after the hosted Arc RPC returned pruned history and Monad RPC required tiny block windows. Both https://10143.hypersync.xyz/height and https://5042.hypersync.xyz/height were verified on2026-10-09. Chain origins and per-adapter deployment ranges remain unchanged, preserving identity ownership history. See https://docs.envio.dev/docs/HyperIndex/configuration-file and https://docs.envio.dev/blog/index-arc-usdc-transfers. Envio Cloud manages its HyperSync credentials; local runs still require an Envio token.
