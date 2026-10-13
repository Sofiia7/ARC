// Pure helpers behind hooks/useNadAgentIds. No React, no wagmi, no browser APIs: safe to import from node:test.
//
// The Monad ERC-8004 identity registry (CONTRACTS.IDENTITY_REGISTRY) is a plain ERC-721: balanceOf(owner) works,
// but supportsInterface(0x780e9d63) is false and tokenOfOwnerByIndex / totalSupply revert (checked 2026-10-13), and
// eth_getLogs is capped at 100 blocks, so the agents a wallet can act for cannot be listed directly. The hook
// collects candidate ids (this site's cache, the agents on the bounty itself, an id typed in) and verifies each one
// with ownerOf and getAgentWallet, the same two checks the adapter's _requireAgentCaller makes.

export const MAX_CACHED_AGENT_IDS = 200;

/** Where this site remembers verified agent ids per chain and wallet. */
export function agentCacheKey(chainId: number, address: string): string {
  return `nadbounty:agentIds:${chainId}:${address.toLowerCase()}`;
}
/** The key hooks/useMyAgentId writes on Arc and Base (read as an extra source of candidates). */
export function legacyAgentCacheKey(chainId: number, address: string): string {
  return `arcbounty:agentIds:${chainId}:${address.toLowerCase()}`;
}

/** Positive integers only, no duplicates, ascending. */
export function mergeAgentIds(...lists: ReadonlyArray<readonly bigint[]>): bigint[] {
  const seen = new Set<string>();
  const out: bigint[] = [];
  for (const list of lists) {
    for (const id of list) {
      if (typeof id !== "bigint" || id <= 0n) continue;
      const key = id.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(id);
    }
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, MAX_CACHED_AGENT_IDS);
}

/** Parses a stored JSON array of decimal strings. Anything else (null, junk, hostile JSON) gives []. */
export function parseAgentIdList(raw: string | null | undefined): bigint[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const ids: bigint[] = [];
    for (const item of value) {
      if ((typeof item === "string" || typeof item === "number") && /^\d{1,30}$/.test(String(item))) {
        ids.push(BigInt(String(item)));
      }
    }
    return mergeAgentIds(ids);
  } catch {
    return [];
  }
}

export function serializeAgentIds(ids: readonly bigint[]): string {
  return JSON.stringify(mergeAgentIds(ids).map((id) => id.toString()));
}

/** "12", "#12", " 12 " -> 12n. 0 is the human wallet, not an agent. */
export function parseAgentIdInput(raw: string): { ok: true; id: bigint } | { ok: false; error: string } {
  const text = raw.trim().replace(/^#/, "");
  if (!/^\d{1,30}$/.test(text)) return { ok: false, error: "Enter the agent ID as a whole number, for example 42." };
  const id = BigInt(text);
  if (id === 0n) return { ok: false, error: "Agent ID 0 is your own wallet: choose Me (wallet) instead." };
  return { ok: true, id };
}

/** _isAgentCaller: the identity owner or the registered working wallet. */
export function controlsAgent(
  owner: string | null | undefined,
  workingWallet: string | null | undefined,
  address: string,
): boolean {
  const me = address.toLowerCase();
  const zero = "0x0000000000000000000000000000000000000000";
  if (owner && owner.toLowerCase() === me) return true;
  return !!workingWallet && workingWallet.toLowerCase() !== zero && workingWallet.toLowerCase() === me;
}

export type AgentControl = { id: bigint; owner: string | null; wallet: string | null };

/** Keeps the agents this address controls. `isOwner` marks those it owns outright (the balanceOf count). */
export function controlledAgents(checks: readonly AgentControl[], address: string): { id: bigint; isOwner: boolean }[] {
  return checks
    .filter((c) => controlsAgent(c.owner, c.wallet, address))
    .map((c) => ({ id: c.id, isOwner: !!c.owner && c.owner.toLowerCase() === address.toLowerCase() }));
}

/** How many owned agents (balanceOf) are not in the verified list yet. Never negative. */
export function missingOwnedCount(balanceOf: number | undefined, ownedFound: number): number {
  if (balanceOf === undefined) return 0;
  return Math.max(0, balanceOf - ownedFound);
}
