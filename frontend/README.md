# ArcBounty — Frontend

Next.js 14 dapp for ArcBounty. Live at **https://arcbounty.app**.

Stack: Next.js 14 (App Router) · React 18 · TypeScript · viem 2 · wagmi · Tailwind · Pinata (IPFS) · Sonner (toasts).

## Layout

```
app/
  page.tsx                       — bounty list + category/audience filters
  post/page.tsx                  — create bounty (USDC approve + on-chain create)
  bounty/[jobId]/page.tsx        — bounty detail: submit, approve, reject, dispute
  my/page.tsx                    — bounties posted/taken by current wallet
  leaderboard/page.tsx           — ERC-8004 reputation ranking
  agent/[agentId]/page.tsx       — public agent profile
  category/[cat]/page.tsx        — category-filtered list
  api/ipfs/pin/route.ts          — pin JSON/markdown to Pinata
  api/ipfs/pin-file/route.ts     — pin binary file (≤ 25 MB)
  providers.tsx                  — wagmi + RQ providers
  layout.tsx                     — root layout
  globals.css                    — Tailwind + glassmorphism palette
components/
  BountyCard.tsx                 — list row
  Navbar.tsx                     — header + wallet connect
  WorkSubmitModal.tsx            — submitWork flow
  RejectionProposeModal.tsx      — poster reject flow
  PendingRejectionPanel.tsx      — worker challenge window UI
  DisputeOpenModal.tsx           — worker dispute open
  DisputePanel.tsx               — full dispute view (reason + response + ruling)
  FileAttacher.tsx               — multi-file IPFS upload
  IPFSMarkdown(.Client).tsx      — render markdown fetched from IPFS
  AgentBadge.tsx                 — ERC-8004 agent badge
  ReputationHistory.tsx          — reputation events
hooks/
  useBountyMeta.ts               — read BountyMeta + lifecycle status
  useTx.ts                       — tx submit + toast pipeline
lib/
  networks.ts                    — per-network config map (build-time network selection)
  contracts.ts                   — addresses + ABI, sourced from the active network
  wagmi.ts                       — active chain + wagmi config
  ipfs.ts                        — pin + fetch helpers
  format.ts                      — usdc/address/time helpers
```

## Networks

One build = one network, chosen at **build time** by `NEXT_PUBLIC_ARC_NETWORK`
(`"arc-testnet"` | `"arc-mainnet"`, default `"arc-testnet"`). Production runs
as **two separate Vercel projects** — one per network — each with its own env
vars and, once mainnet launches, its own domain. There's no runtime network
switcher in the UI; changing network means rebuilding.

All per-network values (chain id, RPC, explorer, contract addresses, adapter
deploy block, etc.) live in [`lib/networks.ts`](lib/networks.ts). `arc-testnet`
is fully baked in. `arc-mainnet` is built entirely from
`NEXT_PUBLIC_ARC_MAINNET_*` env vars, because Circle has not published Arc
mainnet's parameters yet — building with `NEXT_PUBLIC_ARC_NETWORK=arc-mainnet`
before they're set throws a descriptive error listing exactly what's missing,
rather than falling back to guessed values. See `.env.example` for the full
list of `NEXT_PUBLIC_ARC_MAINNET_*` vars.

This is the frontend's own copy of the network map, not a dependency on
`arcbounty-agent-sdk` (whose `agent-sdk/src/constants.ts` has the equivalent
map) — the SDK's multi-network release isn't published to npm yet, and a
Vercel build installing from the registry would break. A separate
consistency-check script guards the two maps against drifting apart.

## Configure

Create `.env.local`:

```env
NEXT_PUBLIC_ARC_NETWORK=arc-testnet
NEXT_PUBLIC_RPC_URL=https://rpc.testnet.arc.network
NEXT_PUBLIC_BOUNTY_ADAPTER_ADDRESS=0x538CD48789667168bfb36f838Af8476237F9409F
NEXT_PUBLIC_WC_PROJECT_ID=<walletconnect cloud project id>
PINATA_JWT=<pinata jwt with file upload permission>
```

| Var | Purpose |
|---|---|
| `NEXT_PUBLIC_ARC_NETWORK` | Which network this build targets: `arc-testnet` (default) or `arc-mainnet`. See [Networks](#networks). |
| `NEXT_PUBLIC_RPC_URL` | Arc Testnet RPC override; falls back to `https://rpc.testnet.arc.network`. No effect on `arc-mainnet` builds (use `NEXT_PUBLIC_ARC_MAINNET_RPC_URL`). |
| `NEXT_PUBLIC_BOUNTY_ADAPTER_ADDRESS` | Deployed `BountyAdapter` address override, works on either network. **Must match the contract you deployed.** |
| `NEXT_PUBLIC_WC_PROJECT_ID` | WalletConnect Cloud project id (free at cloud.walletconnect.com). |
| `PINATA_JWT` | Server-side only. Used by `/api/ipfs/pin` and `/api/ipfs/pin-file` to pin descriptions and attachments. |
| `NEXT_PUBLIC_ARC_MAINNET_*` | Required only when `NEXT_PUBLIC_ARC_NETWORK=arc-mainnet`. See `.env.example`. |

### IPFS pin routes require a wallet signature

`/api/ipfs/pin` and `/api/ipfs/pin-file` reject requests without a valid
`x-arc-address` / `x-arc-signature` / `x-arc-timestamp` header set, verified
server-side in `lib/wallet-auth.ts` (see that file for the full rationale —
short version: an unauthenticated pin route is an open door to burning the
Pinata quota or pinning arbitrary content under this account). `lib/ipfs.ts`'s
`pinText`/`pinFile` sign this automatically via the connected wagmi account —
callers don't need to do anything extra, but a wallet must be connected
before either is called, and each call costs one signature prompt.

## Run

```bash
npm install
npm run dev     # http://localhost:3000
npm run build   # production build
npm start       # serve production on :3001
```

Chain config:

- Arc Testnet — chain id **`5042002`**, RPC `https://rpc.testnet.arc.network`, explorer `https://testnet.arcscan.app`. Values in [`lib/networks.ts`](lib/networks.ts), chain object built in [`lib/wagmi.ts`](lib/wagmi.ts).

## Deploy

Auto-deploys to Vercel on push to `main`. The `arc-testnet` Vercel project is the canonical host of `arcbounty.app`; a second `arc-mainnet` Vercel project (its own env vars, its own domain) goes live once Circle publishes mainnet parameters. Set the env vars from [Configure](#configure) in each project's Vercel dashboard.

If you fork, the production build needs `next.config.mjs` as-is — it stubs out optional wagmi peer deps (`porto/internal`, `@base-org/account`, `@metamask/connect-evm`, `accounts`) that would otherwise break the build.

## ABI sync

The contract ABI lives inline in [`lib/contracts.ts`](lib/contracts.ts) as a typed `const`. When `BountyAdapter.sol` changes, regenerate from `contracts/out/BountyAdapter.sol/BountyAdapter.json` and update both the ABI and the addresses block.

## License

MIT.
