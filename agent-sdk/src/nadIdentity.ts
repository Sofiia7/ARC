import { encodeAbiParameters, isAddress, keccak256, parseAbi, type Address, type Hex } from "viem";

/**
 * The canonical ERC-8004 identity registry on Monad (v2.0.0, an ERC-721 with
 * an agent wallet). Only what the SDK calls is listed. Unlike the Arc/Base
 * registry ABI in abi.ts, `register` is overloaded: no argument, or an agent URI.
 * Checked against the live Monad mainnet registry (selectors, the Registered
 * event and the EIP-712 domain).
 */
export const MONAD_IDENTITY_REGISTRY_ABI = parseAbi([
  "function register() returns (uint256 agentId)",
  "function register(string agentURI) returns (uint256 agentId)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)",
  "function unsetAgentWallet(uint256 agentId)",
  "function tokenURI(uint256 agentId) view returns (string)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "error ERC721NonexistentToken(uint256 tokenId)",
]);

/** The registry rejects a consent whose deadline is more than 5 minutes ahead ("deadline too far"). */
export const AGENT_WALLET_MAX_DEADLINE_DELAY_SEC = 300n;

export type AgentWalletConsentInput = {
  chainId: number;
  /** The identity registry the consent is bound to. */
  registry: Address;
  agentId: bigint;
  /** The working wallet being authorized: the wallet that signs. */
  newWallet: Address;
  /** The identity owner who will submit it on chain. */
  owner: Address;
  /** Unix seconds, at most 5 minutes after the block that includes the transaction's parent. */
  deadline: bigint;
};

/**
 * The EIP-712 payload the registry verifies in `setAgentWallet`: signed by the
 * NEW working wallet (an EOA, or an ERC-1271 contract), submitted by the owner.
 * Binding `owner` and `deadline` stops a stale or foreign consent from being replayed.
 */
export function agentWalletTypedData(input: AgentWalletConsentInput) {
  return {
    domain: {
      name: "ERC8004IdentityRegistry",
      version: "1",
      chainId: input.chainId,
      verifyingContract: input.registry,
    },
    types: {
      AgentWalletSet: [
        { name: "agentId", type: "uint256" },
        { name: "newWallet", type: "address" },
        { name: "owner", type: "address" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "AgentWalletSet",
    message: {
      agentId: input.agentId,
      newWallet: input.newWallet,
      owner: input.owner,
      deadline: input.deadline,
    },
  } as const;
}

/** What the working wallet hands to the identity owner (step 1 of 2). */
export type AgentWalletConsent = {
  agentId: bigint;
  newWallet: Address;
  owner: Address;
  deadline: bigint;
  signature: Hex;
};

export function isZeroAddress(value: string): boolean {
  return /^0x0{40}$/i.test(value);
}

/**
 * Local copy of the adapter's pure `identityKey(agentId, humanWallet)`: the
 * key of `localReputation`. Agent history follows the NFT id, human history
 * follows the wallet. agentId 0 with no wallet reverts InvalidIdentity on
 * chain, so it throws here before any RPC call.
 */
export function identityKey(agentId: bigint, humanWallet?: Address): Hex {
  if (typeof agentId !== "bigint" || agentId < 0n)
    throw new RangeError("identityKey: agentId must be a nonnegative bigint");
  if (agentId !== 0n) {
    return keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256" }], ["NadBounty.agent", agentId]));
  }
  if (!humanWallet || !isAddress(humanWallet) || isZeroAddress(humanWallet)) {
    throw new Error(
      "identityKey: agentId 0 identifies a human by wallet, so a nonzero wallet address is required " +
        "(the contract reverts InvalidIdentity otherwise)",
    );
  }
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "address" }], ["NadBounty.human", humanWallet]));
}
