# Integration notes — Part 2 (Circle Agent Stack + Base) pre-implementation verification

> Block 0 of `Part2_Base/TZ_arcbounty_circle_stack_base.md`: every external assumption
> verified against live sources on **2026-07-19**, before any code. Addresses were
> additionally confirmed on-chain (`eth_getCode` / `eth_call` against the official RPCs).

## 1. Base deployment facts (Block 4)

### ERC-8004 registries — canonical deployments EXIST on Base (do NOT self-deploy)

The TZ assumed we might need to deploy our own registry instances. Wrong — the 8004
team's canonical registries are live on both target networks
(source: [erc-8004/erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts) README, on-chain confirmed):

| Network | IdentityRegistry | ReputationRegistry |
|---|---|---|
| Base mainnet (8453) | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| Base Sepolia (84532) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

Both Identity Registries respond `name() == "AgentIdentity"` (ERC-721, ERC-1967 proxy).
Mainnet uses the same vanity pair across all mainnets; testnets use a separate pair.

### ERC-8183 escrow — NO canonical deployment on Base (self-deploy IS correct)

- [EIP-8183](https://eips.ethereum.org/EIPS/eip-8183) is a Draft, chain-agnostic
  *interface* standard — not a singleton. Reference implementation:
  [erc-8183/base-contracts](https://github.com/erc-8183/base-contracts) (MIT;
  "base" = core contracts, not the Base chain).
- The escrow ArcBounty wraps today is **Arc's own reference deployment on Arc
  Testnet** (`0x0747EEf0706327138c69792bF28Cd525089e4583`,
  per [docs.arc.io tutorial](https://docs.arc.io/arc/tutorials/create-your-first-erc-8183-job)).
  Nothing canonical exists on Base → on Base we deploy our own kernel instance from
  the reference repo. **Before doing so: diff the reference `ERC8183.sol` against the
  interface `BountyAdapter` was built against on Arc** — the adapter has only ever run
  against Arc's instance.

### USDC + chain parameters (confirmed against Circle / Base docs)

| | Base mainnet | Base Sepolia |
|---|---|---|
| chainId | 8453 (`0x2105`) | 84532 (`0x14a34`) |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Public RPC | `https://mainnet.base.org` (rate-limited) | `https://sepolia.base.org` |
| Explorer | basescan.org | sepolia.basescan.org |

Sources: [Circle USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses),
[docs.base.org/network-information](https://docs.base.org/network-information).

- Contract verification: Basescan is folded into **Etherscan API v2** — single
  endpoint `https://api.etherscan.io/v2/api` with `chainid=8453|84532`, one
  etherscan.io key for all chains. For Foundry: `--verifier etherscan --chain 8453`
  with an **etherscan.io** key (legacy basescan-only keys are out).
- Gas on Base is **ETH**, not USDC — deployer and workers need ETH for gas. The
  "one token: earn USDC, pay gas in USDC" pitch is Arc-specific; Base copy must not
  repeat it.

## 2. x402 / facade API facts (Block 1)

### `@circle-fin/x402-batching` — verified against the 3.2.0 tarball

- Latest **3.2.0** (2026-06-18). `createGatewayMiddleware` is real, exported from
  `@circle-fin/x402-batching/server`:
  - config: `sellerAddress` (required), `networks?` (CAIP-2: `eip155:8453` Base,
    `eip155:5042002` Arc Testnet; omit = all), `facilitatorUrl?` (defaults:
    mainnet `https://gateway-api.circle.com`, testnet
    `https://gateway-api-testnet.circle.com`), `description?`
  - per-route pricing: `gateway.require('$0.001')` → **Express** middleware
  - lifecycle hooks: `onProtectedRequest`, `onBefore/AfterVerify`, `onBefore/AfterSettle`,
    failure variants — useful for the request-id ↔ payment-tx logging the TZ asks for
- **Express-only** native middleware. Fastify/Hono/Next go through standard
  `@x402/core` + `BatchFacilitatorClient` (or `@x402/fastify|hono|next`, all v2.19.0).
  → Decision: use **Express** (nothing in this repo uses Fastify; Circle's quickstart
  and Marketplace guidance are Express-first).
- Settlement networks: **Base mainnet supported; Arc Testnet supported; Arc mainnet
  NOT public** (pre-GA flag `arcPrivateMainnet` / `eip155:5042` behind a header).
- Client side (for the Block 2 e2e): `GatewayClient` from
  `@circle-fin/x402-batching/client` — `deposit()`, `pay()`, buyer hooks.

### x402 protocol — spec is v2, don't code against v1 shapes

- Canonical repo moved to the **x402 Foundation**
  ([x402-foundation/x402](https://github.com/x402-foundation/x402)); coinbase/x402 is
  a development fork. Circle Gateway is a facilitator within the same open standard.
- **Spec v2 (2025-12-09)**: payment instructions travel in a base64-encoded
  `PAYMENT-REQUIRED` response **header** (not only a JSON body); `accepts[].amount`
  is atomic units (renamed from v1 `maxAmountRequired`); `network` is CAIP-2.
  Acceptance test for the facade: assert the v2 header shape on an unpaid request.

### Circle Agent Marketplace

- Live: [agents.circle.com/services](https://agents.circle.com/services). Seller
  intake = the Google Form linked from the page and Circle's blog (verified working,
  same `forms.gle/7YFzvdmMcn1JH5tF6`).
- **No formal listing requirements published.** Recommended practice per Circle's
  blog: Circle Gateway middleware for x402, clear per-endpoint pricing, stable
  response schema, supported network. Ecosystem conventions worth shipping anyway:
  `/.well-known/x402.json`, `/openapi.json`, `/llms.txt`.

## 3. Circle CLI + Agent Wallets facts (Block 2) — biggest deviation from the TZ

- CLI: **`@circle-fin/cli` v0.0.6** (2026-06-22), bin `circle`, Node ≥ 20.18.2.
  - `circle wallet login <email>` — **OTP login** (`--testnet` for testnet session)
  - Agent Wallets provisioned at login; `wallet list/create/balance/transfer/execute`
  - policy: `circle wallet limit set --policy-type stablecoin --per-tx … --daily …
    --weekly … --monthly …`, recipient/contract blocklists; **policy writes are
    OTP-gated** (a human must be in the loop)
  - x402: `circle services search/inspect/pay`, `circle gateway balance/deposit/withdraw`
- **CONTRADICTION vs the TZ/grant wording:** Agent Wallets are built on Circle's
  **user-controlled** wallets operated via the CLI — *not* Developer-Controlled
  Wallets with policies, and there is **no documented API/SDK provisioning path**.
  A fully-headless `CircleAgentWalletSigner` as specced may not be implementable
  against the public surface today; the realistic scope is CLI-driven provisioning +
  whatever signing surface the CLI/underlying UCW SDK exposes. Prototype first,
  then re-scope Block 2.
- Networks ([supported-blockchains](https://developers.circle.com/agent-stack/agent-wallets/supported-blockchains)):
  **Arc Testnet ✅ (testnet only), Base mainnet ✅, Base Sepolia ✅, Arc mainnet ❌.**
- No GA/beta label anywhere; CLI is v0.0.x — treat every interface as unstable and
  pin exact versions.

## 4. SKILL.md / Agent Skills facts (Block 3)

- Canonical spec: [agentskills.io/specification](https://agentskills.io/specification)
  (open standard, stewarded via the Agentic AI Foundation). Frontmatter: `name`
  (≤64 chars, kebab-case, **must equal the directory name**) + `description`
  (≤1024 chars, keyword-rich "what + when"); optional `license`, `compatibility`,
  `metadata`, `allowed-tools`. Body guidance: < 5000 tokens / < 500 lines;
  push detail into `references/`. Validator: `skills-ref validate`.
- Distribution: `npx skills add <owner>/<repo>` (Vercel Labs
  [vercel-labs/skills](https://github.com/vercel-labs/skills)) — GitHub *is* the
  registry; a repo is installable if it has `SKILL.md` under root, `skills/`, or
  `.claude/skills/` etc. **No separate skills repo needed** — `skills/arcbounty/SKILL.md`
  in this repo makes `npx skills add Sofiia7/ARC` work as-is.
- **skills.sh has no submission process** — the catalog auto-populates from install
  telemetry. Extra listing venues: awesome-claude-skills lists (PR-based).
- [circlefin/skills](https://github.com/circlefin/skills): exists, 17 skills, all
  Circle products under `plugins/circle/`; third-party acceptance undocumented →
  **don't plan on a PR there** (matches the TZ). Their `use-arc` skill is a good
  format template. Optional extra: a `.claude-plugin/marketplace.json` also makes
  the repo installable via Claude Code's `/plugin marketplace add`.

## 5. Consequences for the plan (delta vs the TZ)

1. Block 4 simplifies: no registry self-deploy on Base — wire the canonical
   `0x8004…` addresses; only the ERC-8183 kernel is self-deployed.
2. The Arc testnet deployment (V4.4, board, stats, Safe handshake) is referenced by
   the submitted grant application — **do not redeploy Arc**; the `maxBountyAmount`
   safety cap ships as V4.5 **on Base only**.
3. The arbitrator Safe `0x4892…1BC6` lives on Arc — a Safe must be **created on Base**
   (same 3 signers, threshold 2) and the two-step handshake re-run there.
4. Block 1 targets Express + `@circle-fin/x402-batching@3.2.0`, x402 **v2** response
   shapes, networks `eip155:8453` (+ `eip155:5042002` for testnet reads).
5. Block 2 is re-scoped: CLI-driven Agent Wallet provisioning (OTP = human-in-loop),
   e2e on Base Sepolia or Arc Testnet; the SDK ships whatever signer surface is
   actually reachable, and the limitation is documented honestly.
6. Block 3 ships inside this repo (`skills/arcbounty/`), no new repo, no circlefin PR.
