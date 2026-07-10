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
  contracts.ts                   — addresses + ABI
  wagmi.ts                       — arcTestnet chain + config
  ipfs.ts                        — pin + fetch helpers
  format.ts                      — usdc/address/time helpers
```

## Configure

Create `.env.local`:

```env
NEXT_PUBLIC_RPC_URL=https://rpc.testnet.arc.network
NEXT_PUBLIC_BOUNTY_ADAPTER_ADDRESS=0x538CD48789667168bfb36f838Af8476237F9409F
NEXT_PUBLIC_WC_PROJECT_ID=<walletconnect cloud project id>
PINATA_JWT=<pinata jwt with file upload permission>
```

| Var | Purpose |
|---|---|
| `NEXT_PUBLIC_RPC_URL` | Arc Testnet RPC; falls back to `https://rpc.testnet.arc.network`. |
| `NEXT_PUBLIC_BOUNTY_ADAPTER_ADDRESS` | Deployed `BountyAdapter` address. **Must match the contract you deployed.** |
| `NEXT_PUBLIC_WC_PROJECT_ID` | WalletConnect Cloud project id (free at cloud.walletconnect.com). |
| `PINATA_JWT` | Server-side only. Used by `/api/ipfs/pin` and `/api/ipfs/pin-file` to pin descriptions and attachments. |

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

- Arc Testnet — chain id **`5042002`**, RPC `https://rpc.testnet.arc.network`, explorer `https://testnet.arcscan.app`. Defined in [`lib/wagmi.ts`](lib/wagmi.ts).

## Deploy

Auto-deploys to Vercel on push to `main`. The Vercel project is the canonical host of `arcbounty.app`. Set all four env vars above in the Vercel dashboard.

If you fork, the production build needs `next.config.mjs` as-is — it stubs out optional wagmi peer deps (`porto/internal`, `@base-org/account`, `@metamask/connect-evm`, `accounts`) that would otherwise break the build.

## ABI sync

The contract ABI lives inline in [`lib/contracts.ts`](lib/contracts.ts) as a typed `const`. When `BountyAdapter.sol` changes, regenerate from `contracts/out/BountyAdapter.sol/BountyAdapter.json` and update both the ABI and the addresses block.

## License

MIT.
