# Specification: ArcBounty × Circle Agent Stack + Base mainnet

**Version:** 1.0 (13.07.2026)
**Assignee:** Claude Code
**Repositories:** ArcBounty contracts (Arc testnet), frontend (arcbounty.app), arcbounty-agent-sdk

## Context

ArcBounty is a decentralized bounty marketplace on Arc Network (ERC-8183 / ERC-8004), with USDC escrow in smart contracts, a working frontend and SDK, and real deals on Arc testnet. The goal of this specification is four blocks:

1. A paid facade REST API (x402) - the entry point to the Circle Agent Marketplace.
2. Circle Agent Wallets support in arcbounty-agent-sdk.
3. SKILL.md for agents (Agent Skills format).
4. Contract deployment on Base mainnet (multichain: Arc testnet + Base).

The blocks are independent. Execution order: 4 → 1 → 3 → 2 (Base deployment first, so that the facade and the e2e tests can run against a mainnet backend, not only testnet).

**Important:** we do NOT change the protocol or the contracts. x402 is used only to pay for facade API calls; it does not touch the escrow logic.

---

## Block 0. Verification before code (mandatory, before any code)

The information below was collected from public announcements and may be outdated or inaccurate in the API details. Before implementing, check it against live sources and record the results in `docs/INTEGRATION_NOTES.md`:

- [ ] The current API of the `@circle-fin/x402-batching` package (middleware signatures, price format, supported settlement networks). Seller quickstart: https://developers.circle.com/gateway/nanopayments/quickstarts/seller
- [ ] Circle CLI `@circle-fin/cli`: commands for creating an Agent Wallet, OTP login, limits, x402 payment. Whether Agent Wallet supports the Arc testnet and Base networks - if Arc is not supported, we run the Block 2 e2e on Base.
- [ ] Official ERC-8004 registry addresses on Base mainnet - only from 8004.org / the standard's official repo. **Do not make up addresses. If there is no official deployment on Base, we deploy our own registry instances from the standard's reference repo and record this in the docs.**
- [ ] The native USDC address on Base: expected `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` - verify against Circle's official list (developers.circle.com).
- [ ] Chain ID: Base mainnet 8453, Base Sepolia 84532. Take the Arc testnet chain ID and RPC from the repo's current config.
- [ ] The SKILL.md format per the Agent Skills specification (open standard) + examples in https://github.com/circlefin/skills

If any of the links is dead or the API is radically different - stop and describe the discrepancy, do not improvise.

---

## Block 1. Facade API with x402 (estimate: 1-2 days)

### Purpose
A public paid REST layer on top of ArcBounty, so that (a) we can pass the Circle Agent Marketplace listing - a curated catalog of services paid for by agents in USDC; (b) agents with wallets can programmatically discover and post bounties.

### Stack
TypeScript, Fastify (or Express - align with what is already in the codebase), Docker. A separate package/folder `apps/facade-api` in the monorepo or a separate repo `arcbounty-api` - choose based on the current structure.

### v1 endpoints

| Method | Path | What it does | x402 price |
|---|---|---|---|
| GET | /health | status, version, supported networks | free |
| GET | /openapi.json | OpenAPI 3.1 spec | free |
| GET | /v1/bounties | search: status, tags, minReward, maxReward, chain, pagination | $0.001 |
| GET | /v1/bounties/:id | details + escrow status + deadlines | $0.001 |
| GET | /v1/bounties/:id/submissions | list of submissions (public fields) | $0.001 |
| POST | /v1/bounties/prepare | prepare the bounty creation transaction | $0.01 |

The discovery endpoints (/health, /openapi.json) must be free - an agent has to be able to understand the service before paying.

### The POST /v1/bounties/prepare pattern
The facade is NOT custodial and NOT a relayer. The endpoint accepts the bounty parameters (title, description hash/URI, reward, deadline, chain), validates them, and returns a ready unsigned transaction: `{ to, data, value, chainId }` + a human-readable description. The agent signs it with its own wallet. The x402 fee is for the preparation/validation service, not for the escrow.

### x402 wiring
```ts
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";

const gateway = createGatewayMiddleware({
  sellerAddress: process.env.SELLER_ADDRESS!, // Sofiia's wallet
});

app.get("/v1/bounties", gateway.require("$0.001"), listBountiesHandler);
```
Behavior: a request without payment → HTTP 402 with payment instructions per the x402 specification; with payment → 200. Verify the exact signature in Block 0.

### Data
Source - reads from the contracts (RPC) + the existing indexer, if there is one in the repo. Response cache of 15-30 seconds (in-memory or Redis; Redis is already in the projects' stack). Logging: request id ↔ payment tx hash - will be useful for grant reporting.

### Deployment
Dockerfile + docker-compose. Target server - the project's existing Ubuntu server (agree on the port, behind a reverse proxy with TLS). `.env.example` with all variables.

### Acceptance criteria
- [ ] `curl` without payment on a paid route → 402 with a correct x402 body.
- [ ] Payment with a test wallet via Circle CLI → 200, valid JSON.
- [ ] /openapi.json passes OpenAPI 3.1 validation.
- [ ] Facade README: how an agent pays for a call (snippet with Circle CLI).
- [ ] p95 latency of GET routes < 800ms with a warm cache.

---

## Block 2. Circle Agent Wallets in arcbounty-agent-sdk (estimate: 2-4 days, the biggest)

### Purpose
An agent with a Circle Agent Wallet (permissionless, policy-controlled wallets for agents) can take bounties, submit work, and receive payouts through our SDK. In the grant deck this is the milestone "Circle Wallets connector" - in code and docs rename it to **Agent Wallets support**.

### Tasks
1. Study the signer interface the SDK currently uses (viem account / ethers signer - per the actual codebase).
2. A `CircleAgentWalletSigner` module implementing this interface on top of a Circle Agent Wallet (via Circle's official SDK/CLI mechanics - per the results of Block 0). Cover the operations: `takeBounty`, `submitWork`, `claimPayout`.
3. An example configuration of wallet policy guardrails (per-transaction / daily limit) in `examples/`.
4. An e2e script `examples/circle-agent-e2e.ts`: create a wallet → fund it → find a bounty via the facade API (the link to Block 1) → take → submit → receive the payout. Network: Arc testnet; if Agent Wallets do not support Arc - Base (see Block 0), and record this.
5. Update the SDK README + the grant deck (milestone rename).

### Acceptance criteria
- [ ] The e2e script passes from a clean environment following the README, without manual edits.
- [ ] Adapter unit tests (RPC mocks) are green in CI.
- [ ] In the e2e, at least one facade API call is paid by this same wallet via x402 (a demonstration of the full cycle "the agent pays for search → earns on a bounty").

---

## Block 3. SKILL.md "arcbounty" (estimate: half a day)

### Purpose
A skill in the Agent Skills format (open standard: SKILL.md with YAML frontmatter name/description + instructions), so that any coding agent (Claude Code and others) can work with ArcBounty. Distribution: our own repo `arcbounty/skills`, installation via `npx skills add <repo>`, publication in the skills.sh catalog. We do not open a PR to circlefin/skills - it holds only Circle products.

### Skill contents
- What ArcBounty is: roles (poster / worker agent), the bounty lifecycle, escrow and the dispute flow.
- Workflow for the assignee agent: discover (via the facade API with x402 or directly from the contracts) → task assessment → take → submit → payout.
- Workflow for the poster: prepare → sign → fund escrow.
- Typical mistakes: USDC = 6 decimals; on Arc gas is paid in USDC (not ETH); deadline fields; repeated take; what happens when a deadline is missed.
- Links: contract addresses per network (Arc testnet, Base), the facade OpenAPI, the SDK repo.

### Acceptance criteria
- [ ] The skill installs via `npx skills add` and is picked up by Claude Code.
- [ ] Test run: a fresh Claude Code session with the skill successfully performs the scenario "find open bounties and show the top 3 by reward" via the facade API.

---

## Block 4. Deployment on Base mainnet (estimate: 2-3 days)

### Purpose
(a) A live mainnet product independent of the Arc mainnet timeline; (b) a presence on the network where most of the agent x402 economy volume happens; (c) a basis for retroactive Base Builder Grants (there are no applications - they find projects by activity).

### Tasks
1. Review the network hardcodes in the contracts/deployment scripts (USDC address, 8004 registries) → move them into a config keyed by chainId.
2. Deploy the contracts on Base mainnet (8453). First a full rehearsal on Base Sepolia (84532).
3. ERC-8004: registry addresses - strictly per Block 0.
4. **Safety cap (mandatory):** until there is an audit, a bounty size limit at the contract level - `maxBountyAmount`, default 500 USDC, changeable by the owner. On the frontend - a banner "unaudited beta, cap $500". This is a deliberate decision: mainnet without an audit is acceptable only with damage limitation.
5. Contract verification on Basescan.
6. Frontend: a network switcher (Arc testnet / Base mainnet), SDK: multichain config.
7. Indexer/subgraph (if there is one) → add Base.
8. `docs/DEPLOYMENTS.md`: a table of addresses per network, date, commit.

### Acceptance criteria
- [ ] The full bounty cycle (create → take → submit → payout) passes on Base Sepolia in the e2e.
- [ ] The contracts on Base mainnet are deployed, verified, and the cap is active.
- [ ] The frontend works with both networks, the default is Base mainnet.
- [ ] The deployment gas estimate is recorded in DEPLOYMENTS.md (expectation: single to tens of $).

---

## Environment variables (summary)

```
SELLER_ADDRESS=            # wallet for receiving x402 payments
DEPLOYER_PRIVATE_KEY=      # only via env/secret manager, never goes into git
BASE_RPC_URL=
BASE_SEPOLIA_RPC_URL=
ARC_TESTNET_RPC_URL=       # from the current config
REDIS_URL=                 # for the facade cache (optional)
```

## Manual steps (done by Sofiia, not Claude Code)

1. Make the main repo public (for listings, grants, skills.sh).
2. The Agent Marketplace seller form "Accept USDC from agents": https://forms.gle/7YFzvdmMcn1JH5tF6 (service name, description, endpoints, wallet). The catalog is curated - after the form, Circle reviews it.
3. Publish the skill in the skills.sh catalog.
4. A PR to awesome-erc8004 (link to the project + Base addresses).
5. Seed 2-3 real bounties on Base after deployment (within the cap).

## Out of scope for this specification (candidates for the ETHGlobal async continuity submission, 4-16.09)

Do not do now - this is September work within the event window:
- A reference "earning agent": autonomously discover → take → execute (LLM) → submit → payout, with a stream of the process.
- Integration of ERC-8004 reputation (Reputation/Validation Registry) into assignee selection.
- A CCTP bridge for bounties: posting on Base, execution/payout on Arc mainnet (if it launches).
