# NadBounty Envio indexer

Indexes Monad testnet V4.8 bounty/contest events, mirror snapshots, Base/Arc legacy bounty events and ERC-8004 identity transfers. Event identity is chain + transaction hash + log index; owners and contracts are normalized to lowercase. Each bounty fact retains its source block, timestamp and transaction hash.

Run on Linux with Node 22.15 or newer:

```sh
npm ci
npm run codegen
npm run typecheck
```

The dedicated GitHub workflow runs code generation and TypeScript checks on Linux without service credentials. Windows native execution is unsupported by Envio. Running the actual indexer additionally requires supported Docker/Postgres infrastructure, configured RPCs and an Envio token where required for HyperSync. Copy `.env.example` to a private `.env` before local runtime setup.

This first schema stores event facts and identity/mirror state. It does not claim to derive a trusted reputation gate from bounty events alone: registry feedback can fail or be revoked. The exact, live-verified raw feedback reader lives in `scripts/lib/nad-reputation.ts`; integrating its active-feedback semantics and durable old-recipient discovery is still required for the production mirror workflow. Identity indexing starts at the chain origin to preserve ownership history; narrow it only with a verified registry-deployment block or a complete seeded ownership checkpoint.
