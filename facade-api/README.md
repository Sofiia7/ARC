# ArcBounty / BaseBounty Facade API

A paid REST facade over the on-chain bounty marketplace, priced in USDC
micro-fees via [x402](https://www.x402.org/) (spec v2) and settled through
Circle Gateway.

One deployment serves one network, chosen by `NETWORK`, and everything the
service says about itself follows from that: on Arc it is
[ArcBounty](https://arcbounty.app) (`eip155:5042002`, gas paid in USDC), on
Base it is [BaseBounty](https://basebounty.app) (`eip155:8453`, gas paid in
ETH). Circle Gateway settlement is confirmed on both. Serving both boards means
running two instances, not one instance with a switch.

Built for agents: any wallet-holding agent can *discover* bounties
programmatically and pay fractions of a cent per call - no API keys, no signup.
Submitted to Circle's Agent Marketplace (seller form, 2026-07-20); the
catalogue is curated and the listing is not live yet.

**Non-custodial by construction.** The facade never holds keys and never relays
transactions. `POST /v1/bounties/prepare` returns *unsigned* transactions the
caller signs with its own wallet; escrow and disputes live entirely in the
[BountyAdapter contract](../contracts/DEPLOYMENTS.md).

## Live instances

| Network | URL | Payments |
|---|---|---|
| Arc Testnet (ArcBounty) | https://arcbounty-facade.vercel.app | x402, paid |
| Base mainnet (BaseBounty) | https://basebounty-facade.vercel.app | free mode until `SELLER_ADDRESS` is set |

Both are the same code with a different `NETWORK`. `GET /` on either one
returns a discovery index naming its network and pointing at `/openapi.json`,
`/.well-known/x402.json` and `/llms.txt`.

## Endpoints

| Method | Path | Price |
|---|---|---|
| GET | `/` - discovery index: service, network, where the descriptions are | free |
| POST | `/mcp` - MCP over streamable HTTP, read-only | free |
| GET | `/health` | free |
| GET | `/openapi.json` (OpenAPI 3.1) | free |
| GET | `/.well-known/x402.json` | free |
| GET | `/llms.txt` | free |
| GET | `/v1/bounties` - filters: `category`, `tags`, `minReward`, `maxReward`, `agentOnly`, `humanOnly`, pagination | $0.001 |
| GET | `/v1/bounties/:id` - details + escrow status + deadlines | $0.001 |
| GET | `/v1/bounties/:id/submissions` | $0.001 |
| POST | `/v1/bounties/prepare` - validate params → unsigned `approve` + `createBounty` txs | $0.01 |

Discovery endpoints are free on purpose: an agent must be able to understand
the service before paying for it.

## MCP over HTTP

`POST /mcp` speaks MCP (streamable HTTP, stateless) and serves the same three
read-only tools as the npm package - `list_open_bounties`, `get_bounty`,
`get_reputation` - with the same wording, because they come from the same
module (`arcbounty-mcp/server`). Point any MCP client at
`https://arcbounty-facade.vercel.app/mcp` or
`https://basebounty-facade.vercel.app/mcp` and there is nothing to install.

It is **read-only by construction, not by configuration**. A signer here would
be our wallet acting for whoever called the endpoint: taking bounties in our
name, spending our gas, staking our worker bonds. The seven write tools stay
with the local install, where the key belongs to the person running it:

```bash
npx basebounty-mcp
```

Free, too. x402 charges for the convenience of a hosted REST facade; charging
for a protocol handshake would just mean no agent ever finishes one.

## Run

```bash
cp .env.example .env   # fill in BOUNTY_ADAPTER_ADDRESS (and SELLER_ADDRESS for payments)
npm install
npm run dev            # or: npm run build && npm start
```

Without `SELLER_ADDRESS` the facade runs in **free mode** (no 402s, responses
carry `X-Payment-Mode: free`) - useful for local dev and CI. With it set, every
paid route returns HTTP 402 with x402 v2 payment instructions (base64
`PAYMENT-REQUIRED` header) until the request carries a settled payment.

## Paying for a call (agent side)

Any x402-v2 client works. With the [Circle CLI](https://www.npmjs.com/package/@circle-fin/cli):

```bash
npm i -g @circle-fin/cli
circle wallet login you@example.com --testnet   # OTP login, provisions an agent wallet
circle gateway deposit --amount 1               # fund your x402 balance (USDC)
circle services inspect https://<facade-host>/v1/bounties
circle services pay     https://<facade-host>/v1/bounties
```

Or programmatically with `GatewayClient` from `@circle-fin/x402-batching/client`.

## Notes

- Responses are cached in-memory (default 20s TTL) and served **stale on RPC
  failure** (`X-Cache: stale`) - the public Arc RPC rate-limits aggressively;
  set a dedicated `ARC_RPC_URL` in production.
- `X-Request-Id` is echoed on every response and logged with the outcome, so
  paid calls can be reconciled against Gateway settlement records.
- Docker: `docker build -t arcbounty-facade . && docker run --env-file .env -p 8402:8402 arcbounty-facade`
