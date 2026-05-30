import { pinText } from "./ipfs.js";

/**
 * ERC-8004 agent metadata (TZ §4.3 + §12.3).
 *
 * IdentityRegistry.register() stores a URI; everyone reading it expects the
 * referenced JSON to follow this shape. Persistence matters — `data:` URIs
 * break the moment a verifier wants to fetch the manifest after registration,
 * so we always pin to IPFS.
 */
export type ArcBountySection = {
  /** Min reputation a poster requires before this agent takes their bounty. */
  min_reputation?: number;
  preferred_categories?: ReadonlyArray<"dev" | "design" | "content" | "data" | "other">;
  min_reward_usdc?: number;
  max_reward_usdc?: number;
};

export type AgentMetadata = {
  name: string;
  description: string;
  agent_type?: string;
  capabilities?: readonly string[];
  version?: string;
  contact?: string;

  // ArcBounty-specific block — required for agents that want to be discoverable
  // by the autonomous selection in subscribeToNewBounties / runOnce.
  arcbounty?: ArcBountySection;
};

/**
 * Validate a metadata blob before pinning. Strict by default — we'd rather
 * fail loudly on init than silently push a broken manifest to IPFS.
 */
export function validateAgentMetadata(m: unknown): asserts m is AgentMetadata {
  if (typeof m !== "object" || m === null) throw new Error("metadata must be an object");
  const o = m as Record<string, unknown>;
  if (typeof o.name !== "string" || o.name.length === 0)
    throw new Error("metadata.name must be a non-empty string");
  if (typeof o.description !== "string")
    throw new Error("metadata.description must be a string");
  if (o.capabilities !== undefined && !Array.isArray(o.capabilities))
    throw new Error("metadata.capabilities must be an array of strings");
  if (o.arcbounty !== undefined) {
    const a = o.arcbounty as Record<string, unknown>;
    if (a.min_reputation !== undefined && (typeof a.min_reputation !== "number" || a.min_reputation < 0 || a.min_reputation > 100))
      throw new Error("metadata.arcbounty.min_reputation must be a number in [0, 100]");
    if (a.preferred_categories !== undefined) {
      if (!Array.isArray(a.preferred_categories)) throw new Error("preferred_categories must be an array");
      for (const c of a.preferred_categories as unknown[]) {
        if (typeof c !== "string" || !["dev","design","content","data","other"].includes(c))
          throw new Error(`preferred_categories: invalid category ${String(c)}`);
      }
    }
    for (const k of ["min_reward_usdc","max_reward_usdc"] as const) {
      const v = a[k];
      if (v !== undefined && (typeof v !== "number" || v < 0)) {
        throw new Error(`metadata.arcbounty.${k} must be a non-negative number`);
      }
    }
  }
}

/** Pin a validated metadata blob to IPFS and return the `ipfs://<cid>` URI. */
export async function pinAgentMetadata(meta: AgentMetadata): Promise<string> {
  validateAgentMetadata(meta);
  return pinText(JSON.stringify(meta, null, 2), "agent.json");
}
