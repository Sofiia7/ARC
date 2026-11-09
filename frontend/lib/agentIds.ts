import { encodeEventTopics, pad, parseAbi, type Address, type PublicClient } from "viem";
import { getActiveNetwork } from "./networks";

// Which ERC-8004 identities does a wallet hold right now?
//
// The registry has no reverse owner -> agentId lookup and is not enumerable,
// so ids come from Transfer(any -> owner) logs, each confirmed with ownerOf.
// What changed on 2026-11-09: the answer starts from balanceOf, which is exact
// and costs one call. Before, the hook and the register page sent ONE
// eth_getLogs over 500,000 blocks; every default Base RPC refuses that
// (mainnet.base.org caps at 500 blocks, publicnode at 50,000), the error was
// swallowed, and a wallet that already had an agent looked like it had none.

export type OwnedAgentIds = {
  /** registry balanceOf(owner); null when it could not be read. */
  owned: bigint | null;
  /** Ids confirmed by ownerOf, oldest first (the last one is the primary). */
  ids: bigint[];
};

export type AgentIdLookupOptions = {
  registry: Address;
  /** Etherscan-style logs API (Blockscout on Base). Full history in one call; may be down or keyed. */
  explorerApiUrl?: string;
  /** Widest eth_getLogs range per call for the RPC fallback. */
  maxLogRange: bigint;
  /** RPC fallback call budget (so a degraded explorer can't turn into hundreds of requests). */
  maxCalls?: number;
  fetchImpl?: typeof fetch;
};

// Only what this module reads. Kept here rather than imported from
// ./contracts, which needs the adapter env at import time.
const IDENTITY_REGISTRY_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);
const TRANSFER_EVENT = IDENTITY_REGISTRY_ABI[2];

export function defaultAgentIdLookupOptions(): AgentIdLookupOptions {
  const network = getActiveNetwork();
  return {
    registry: network.contracts.IDENTITY_REGISTRY,
    explorerApiUrl: network.explorerApiUrl,
    maxLogRange: network.maxLogRange ?? 10_000n,
  };
}

type Candidate = { tokenId: bigint; block: bigint };

async function explorerCandidates(owner: Address, o: AgentIdLookupOptions): Promise<Candidate[]> {
  const [topic0] = encodeEventTopics({ abi: [TRANSFER_EVENT], eventName: "Transfer" } as never);
  const topic2 = pad(owner.toLowerCase() as Address, { size: 32 });
  const sep = o.explorerApiUrl!.includes("?") ? "&" : "?";
  const url =
    `${o.explorerApiUrl}${sep}module=logs&action=getLogs&fromBlock=0&toBlock=latest`
    + `&address=${o.registry}&topic0=${topic0}&topic2=${topic2}&topic0_2_opr=and&page=1&offset=1000`;
  const res = await (o.fetchImpl ?? fetch)(url);
  if (!res.ok) throw new Error(`explorer ${res.status}`);
  const json = (await res.json()) as { result?: unknown };
  // "No records found" still comes back as result: []; anything else is an error message.
  if (!Array.isArray(json.result)) throw new Error("explorer: unexpected response");
  return (json.result as { topics: (string | null)[]; blockNumber: string }[])
    .filter(l => l.topics[3])
    .map(l => ({ tokenId: BigInt(l.topics[3]!), block: BigInt(l.blockNumber) }));
}

async function rpcCandidates(client: PublicClient, owner: Address, o: AgentIdLookupOptions): Promise<Candidate[]> {
  const chunk = o.maxLogRange;
  const budget = BigInt(o.maxCalls ?? 24);
  const head = await client.getBlockNumber();
  const floor = head >= chunk * budget ? head - chunk * budget + 1n : 0n;
  const found: Candidate[] = [];
  for (let to = head; to >= floor; ) {
    const from = to - chunk + 1n > floor ? to - chunk + 1n : floor;
    const logs = await client.getLogs({
      address: o.registry,
      event: TRANSFER_EVENT,
      args: { to: owner },
      fromBlock: from,
      toBlock: to,
    });
    for (const log of logs) {
      const tokenId = (log.args as { tokenId?: bigint }).tokenId;
      if (tokenId !== undefined) found.push({ tokenId, block: log.blockNumber ?? from });
    }
    // No early exit on "enough tokens seen": a newer one may have been sent
    // away again, and only ownerOf (in the caller) can tell. The budget bounds it.
    if (from === floor) break;
    to = from - 1n;
  }
  return found;
}

export async function findOwnedAgentIds(
  client: PublicClient,
  owner: Address,
  options: AgentIdLookupOptions = defaultAgentIdLookupOptions(),
): Promise<OwnedAgentIds> {
  let owned: bigint | null = null;
  try {
    owned = await client.readContract({
      address: options.registry,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: "balanceOf",
      args: [owner],
    });
  } catch {
    // A registry without balanceOf, or the read failed: fall back to logs alone.
  }
  if (owned === 0n) return { owned, ids: [] };

  let candidates: Candidate[] | null = null;
  if (options.explorerApiUrl) {
    try {
      candidates = await explorerCandidates(owner, options);
    } catch {
      candidates = null; // explorer down or keyed: bounded RPC scan below
    }
  }
  if (candidates === null) {
    try {
      candidates = await rpcCandidates(client, owner, options);
    } catch {
      candidates = [];
    }
  }

  // Newest first, each token once, kept only if the wallet still holds it.
  const ordered = [...candidates].sort((a, b) => (a.block === b.block ? 0 : a.block > b.block ? -1 : 1));
  const seen = new Set<bigint>();
  const ids: bigint[] = [];
  for (const { tokenId } of ordered) {
    if (seen.has(tokenId)) continue;
    seen.add(tokenId);
    try {
      const holder = await client.readContract({
        address: options.registry,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: "ownerOf",
        args: [tokenId],
      });
      if (holder.toLowerCase() === owner.toLowerCase()) ids.push(tokenId);
    } catch {
      // burned or unreadable: not a current identity
    }
    if (owned !== null && BigInt(ids.length) >= owned) break;
  }
  return { owned, ids: ids.reverse() };
}
