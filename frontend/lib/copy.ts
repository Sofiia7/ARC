import { getActiveNetwork, type NetworkConfig } from "./networks";

// ─── Network-dependent copy ──────────────────────────────────────────────────
//
// One build = one network (see lib/networks.ts), so the product's wording is a
// function of the network, not a runtime toggle. Everything user-facing that
// differs between the Arc and Base deployments lives HERE rather than inline
// in components, for two reasons:
//
//  1. The Arc copy leans hard on "USDC is the gas token, you need no second
//     asset" - Arc's actual selling point. On Base that claim is false: USDC
//     is an ordinary ERC-20 and gas is ETH. Copied over unchanged it silently
//     breaks onboarding, because a wallet funded only with USDC cannot send
//     the first transaction. Branching in one file makes that impossible to
//     half-apply.
//  2. The Base deployment ships under its own brand (BaseBounty) - see
//     `Brand` in lib/networks.ts.
//
// Branch on capability (`nativeCurrency.isUsdc`), never on the network slug:
// base-mainnet then inherits the Base wording automatically the day it is
// added to the map, with no edit here.

export type Faucet = {
  /** Text before the faucet link. */
  lead: string;
  url: string;
  label: string;
  /** Text after the faucet link (network selection hint, extra asset, …). */
  after: string;
};

export type NetworkCopy = {
  /** Sub-headline under the hero title. */
  heroLede: string;
  /** The "what do I need in my wallet" line under the hero. */
  funding: { text: string; faucet?: Faucet };
  /** Hero pill describing how gas works on this chain. */
  gasPill: { icon: string; label: string };
  /** /start - the "what do I fund this wallet with" explainer. */
  gasExplainer: { title: string; body: string };
  /** /start - the "this is not a token launch" bullet, mainnet wording. */
  noTokenNote: { title: string; body: string };
  /** One-liner for metadata/OG descriptions. */
  tagline: string;
};

const CIRCLE_FAUCET = "https://faucet.circle.com/";

function arcCopy(network: NetworkConfig): NetworkCopy {
  return {
    heroLede:
      "Native to Arc. Powered by ERC-8183 escrow + ERC-8004 on-chain reputation. " +
      "Micro-bounties from $1 are economically real because USDC is native gas.",
    funding: network.testnet
      ? {
        text: "you'll need testnet USDC (it's also the gas token), free at",
        faucet: { lead: "", url: CIRCLE_FAUCET, label: "Circle's faucet", after: "(select Arc Testnet)." },
      }
      : { text: "you'll need USDC in your wallet (it's also the gas token) to post or take a bounty." },
    gasPill: { icon: "⛽", label: "native USDC gas" },
    gasExplainer: {
      title: "There is no separate token.",
      body:
        "USDC is the reward and the gas token - what you earn or spend is the only asset you " +
        "need in the wallet. No approving a second token just to pay fees.",
    },
    noTokenNote: {
      title: "There is no separate token.",
      body:
        "USDC is the reward and the gas token - what you earn or post here is real USDC, not a " +
        "points system or an airdrop.",
    },
    tagline: "Escrowed micro-bounties for AI agents and humans, native to Arc.",
  };
}

function baseCopy(network: NetworkConfig): NetworkCopy {
  const gas = network.nativeCurrency.symbol;
  return {
    heroLede:
      "Built for the x402 agent economy on Base. ERC-8183 escrow + ERC-8004 on-chain reputation - " +
      "an agent pays for discovery over x402 and earns the bounty it finds, without leaving the chain.",
    funding: network.testnet
      ? {
        text: `two assets here, not one: testnet USDC for the reward and a little ${gas} for gas. USDC is free at`,
        faucet: {
          lead: "",
          url: CIRCLE_FAUCET,
          label: "Circle's faucet",
          after: `(select Base Sepolia); ${gas} from any public Base Sepolia faucet.`,
        },
      }
      : {
        text:
          `you'll need USDC for the reward and a little ${gas} for gas - on Base those are two ` +
          `separate assets, unlike a USDC-gas chain.`,
      },
    // Gas is not the story on Base - x402 is. Arc's "⛽ native USDC gas" pill
    // would be actively wrong here, so the slot sells the real advantage.
    gasPill: { icon: "🤖", label: "x402-native discovery" },
    gasExplainer: {
      title: "Two assets, not one.",
      body:
        `USDC is the reward; gas is paid in ${gas}. Fund the wallet with both - a wallet holding ` +
        `only USDC cannot send its first transaction, so this is the one step worth checking twice.`,
    },
    noTokenNote: {
      title: "There is no token of ours.",
      body:
        `Rewards are real USDC and gas is real ${gas} - neither is a points system, an airdrop, ` +
        `nor anything we mint. We take a 1% protocol fee on payout and nothing else.`,
    },
    tagline: "Escrowed bounties for AI agents, x402-native on Base.",
  };
}

/** Copy for the network this build targets. */
export function getCopy(): NetworkCopy {
  const network = getActiveNetwork();
  return network.nativeCurrency.isUsdc ? arcCopy(network) : baseCopy(network);
}
