// Chain reads for the NadBounty profile page. React-free; two Multicall3 rounds instead of seven sequential reads.
import type { Abi, Address } from "viem";
import { BOUNTY_ADAPTER_V48_ABI as ABI } from "./abi-v48";
import { REPUTATION_MIRROR_ABI as MIRROR_ABI } from "./reputationMirrorAbi";
import { readMany, type NadReadClient, type ReadCall } from "./nadBoardLoad";
import type { ProfileTarget } from "./nadProfile";

const IDENTITY_ABI = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getAgentWallet",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const satisfies Abi;

const ZERO = "0x0000000000000000000000000000000000000000";
/** Cross-chain sources the relayer copies into the mirror. */
export const MIRROR_SOURCES = [
  { name: "Base", chainId: 8453n },
  { name: "Arc", chainId: 5042n },
] as const;

export type MirrorRecord = readonly [paidJobs: bigint, scoreSum: bigint, sourceBlock: bigint, updatedAt: bigint];
export type NadProfileData = {
  target: ProfileTarget;
  agentId: bigint;
  owner: Address;
  /** The agent's current working wallet, or null for humans and agents that have none set. */
  working: Address | null;
  /** [paidJobs, scoreSum] across Monad and the mirrored Base and Arc records. */
  total: readonly [bigint, bigint];
  /** Distinct posters that have paid this agent. Null for humans. */
  uniquePosters: bigint | null;
  sources: { name: string; chainId: bigint; record: MirrorRecord }[];
  relayer: Address;
};

export type NadProfileCfg = { adapter: Address; identityRegistry: Address };

export async function loadNadProfile(
  client: NadReadClient,
  cfg: NadProfileCfg,
  target: ProfileTarget,
): Promise<NadProfileData> {
  const agentId = target.kind === "agent" ? target.agentId : 0n;
  const round1: ReadCall[] = [{ address: cfg.adapter, abi: ABI as Abi, functionName: "reputationMirror" }];
  if (target.kind === "agent")
    round1.push(
      { address: cfg.identityRegistry, abi: IDENTITY_ABI, functionName: "ownerOf", args: [agentId] },
      { address: cfg.identityRegistry, abi: IDENTITY_ABI, functionName: "getAgentWallet", args: [agentId] },
      { address: cfg.adapter, abi: ABI as Abi, functionName: "uniquePosterCount", args: [agentId] },
    );
  const first = await readMany(client, round1);
  if (first[0]?.status !== "success") throw new Error("Could not read the reputation mirror address");
  const mirror = first[0].result as Address;

  let owner: Address;
  let working: Address | null = null;
  let uniquePosters: bigint | null = null;
  if (target.kind === "agent") {
    const [ownerRes, workingRes, uniqueRes] = [first[1], first[2], first[3]];
    if (ownerRes?.status !== "success") throw new Error(`Agent #${agentId} does not exist on this network`);
    owner = ownerRes.result as Address;
    if (workingRes?.status === "success" && String(workingRes.result).toLowerCase() !== ZERO)
      working = workingRes.result as Address;
    if (uniqueRes?.status === "success") uniquePosters = uniqueRes.result as bigint;
  } else {
    owner = target.wallet;
  }

  const second = await readMany(client, [
    { address: cfg.adapter, abi: ABI as Abi, functionName: "getIdentityReputation", args: [agentId, owner] },
    ...MIRROR_SOURCES.map((s) => ({
      address: mirror,
      abi: MIRROR_ABI as Abi,
      functionName: "records",
      args: [owner, s.chainId],
    })),
    { address: mirror, abi: MIRROR_ABI as Abi, functionName: "relayer" },
  ]);
  const totalRes = second[0];
  if (totalRes?.status !== "success") throw new Error("Could not read this identity's reputation");
  const sources = MIRROR_SOURCES.map((s, i) => {
    const r = second[1 + i];
    const record: MirrorRecord = r?.status === "success" ? (r.result as MirrorRecord) : ([0n, 0n, 0n, 0n] as const);
    return { name: s.name, chainId: s.chainId, record };
  });
  const relayerRes = second[1 + MIRROR_SOURCES.length];
  return {
    target,
    agentId,
    owner,
    working,
    total: totalRes.result as readonly [bigint, bigint],
    uniquePosters,
    sources,
    relayer: (relayerRes?.status === "success" ? relayerRes.result : ZERO) as Address,
  };
}
