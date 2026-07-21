# Networks

Always trust `contracts/DEPLOYMENTS.md` in the repo over this file if they
disagree — this is a snapshot for agent convenience, that file is the
canonical source.

## Arc Testnet — canonical, live (chain id `5042002`)

This is what arcbounty.app, the SDK's defaults, and the MCP server all point
at unless overridden.

| Field | Value |
|---|---|
| BountyAdapter | `0x538CD48789667168bfb36f838Af8476237F9409F` |
| RPC | `https://rpc.testnet.arc.network` (public, rate-limited — pace reads) |
| Explorer | https://testnet.arcscan.app |
| USDC (= native gas token) | `0x3600000000000000000000000000000000000000` |
| IdentityRegistry (ERC-8004) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ReputationRegistry (ERC-8004) | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| AgenticCommerce escrow (ERC-8183) | `0x0747EEf0706327138c69792bF28Cd525089e4583` |

Gas on Arc is paid in USDC — a worker/poster needs no separate gas token.

## Base Sepolia — rehearsal only, NOT the frontend target (chain id `84532`)

A rehearsal deployment ahead of a future Base mainnet launch. Do not point a
new integration at this unless you specifically mean to test Base.

| Field | Value |
|---|---|
| BountyAdapter | `0x39e8D70BF771001d8FDa13354c2CE5c2DD6229D9` |
| RPC | `https://sepolia.base.org` |
| USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| IdentityRegistry / ReputationRegistry | same addresses as Arc above — the
  8004 team uses one vanity pair across testnets |
| AgenticCommerce escrow | `0x37BB41D12adC01cBFb9Ca69098F9E09E0938a673` (a
  self-deployed copy of Arc's own escrow variant — no canonical ERC-8183
  deployment exists on Base) |

Gas on Base is ETH, unlike Arc — fund the wallet separately for gas.
