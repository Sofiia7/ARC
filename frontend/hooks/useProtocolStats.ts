"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { AbiEvent } from "viem";
import { CONTRACTS, BOUNTY_ADAPTER_ABI, BOUNTY_ADAPTER_DEPLOY_BLOCK } from "@/lib/contracts";
import { getLogsChunked } from "@/lib/chainLogs";

// Public, on-chain-verifiable protocol stats for /stats. Same
// fetch-all-events approach as useCompletedBounties (leaderboard): fine at
// testnet scale, replaced by an indexer in Sprint 4 / grant milestone 6.
// Arc testnet isn't indexed by Dune (mainnet launches summer 2026), so this
// page IS the public dashboard until then — it's linked from grant reports
// and weekly build-in-public posts, hence "every number is an event."

export type ProtocolStats = {
  totalPosted: number;
  usdcPostedGross: bigint;   // sum of rewards across all created bounties
  completed: number;
  completedByAgents: number;
  usdcPaidGross: bigint;     // sum of rewards of completed bounties (pre-fee)
  protocolFeesUsdc: bigint;  // sum of ProtocolFeePaid amounts
  uniquePosters: number;
  uniqueWorkers: number;
  uniqueAgents: number;      // distinct agentIds that took at least one bounty
  openNow: number | null;    // null = live RPC read unavailable (rate-limited); event-derived stats still valid
};

function evt(name: string): AbiEvent {
  const found = BOUNTY_ADAPTER_ABI.find(e => e.type === "event" && e.name === name);
  // Loud failure beats a silent `!`: a missing ABI entry once cost hours of
  // debugging here — the undefined slipped through the non-null assertion and
  // surfaced as an unrelated-looking TypeError deep inside the fetch path.
  if (!found) throw new Error(`[useProtocolStats] event ${name} missing from BOUNTY_ADAPTER_ABI`);
  return found as unknown as AbiEvent;
}

export function useProtocolStats() {
  const publicClient = usePublicClient();

  return useQuery<ProtocolStats>({
    queryKey: ["protocol-stats", CONTRACTS.BOUNTY_ADAPTER],
    enabled: !!publicClient,
    staleTime: 60_000,
    queryFn: async () => {
      if (!publicClient) throw new Error("no public client");

      const address = CONTRACTS.BOUNTY_ADAPTER;
      const from = BOUNTY_ADAPTER_DEPLOY_BLOCK;

      // Full-history scans via Blockscout (one request per event type), with
      // a bounded chunked-RPC fallback — see lib/chainLogs.ts for why the
      // naive full-range eth_getLogs is impossible on the Arc RPC.
      //
      // The "open right now" count is the only live RPC read; the public RPC
      // rate-limits aggressively (429), so treat it as best-effort — a busy
      // RPC must degrade one card to "—", not blank the whole page.
      const [createdLogs, takenLogs, completedLogs, feeLogs] = await Promise.all([
        getLogsChunked(publicClient, { address, event: evt("BountyCreated") }, from),
        getLogsChunked(publicClient, { address, event: evt("BountyTaken") }, from),
        getLogsChunked(publicClient, { address, event: evt("BountyCompleted") }, from),
        getLogsChunked(publicClient, { address, event: evt("ProtocolFeePaid") }, from),
      ]);

      let openNow: number | null = null;
      try {
        const openIds = await publicClient.readContract({
          address, abi: BOUNTY_ADAPTER_ABI, functionName: "getOpenBounties", args: ["", 0n, 0n],
        }) as readonly bigint[];
        openNow = openIds.length;
      } catch {
        // rate-limited RPC — leave null, the card renders "—"
      }

      const rewardByJobId = new Map<string, bigint>();
      const posters = new Set<string>();
      let usdcPostedGross = 0n;
      for (const l of createdLogs as Array<{ args: unknown }>) {
        const a = l.args as { jobId: bigint; poster: string; reward: bigint };
        rewardByJobId.set(a.jobId.toString(), a.reward);
        posters.add(a.poster.toLowerCase());
        usdcPostedGross += a.reward;
      }

      const workers = new Set<string>();
      const agents = new Set<string>();
      for (const l of takenLogs as Array<{ args: unknown }>) {
        const a = l.args as { provider: string; agentId: bigint };
        workers.add(a.provider.toLowerCase());
        if (a.agentId > 0n) agents.add(a.agentId.toString());
      }

      let completedByAgents = 0;
      let usdcPaidGross = 0n;
      for (const l of completedLogs as Array<{ args: unknown }>) {
        const a = l.args as { jobId: bigint; agentId: bigint };
        if (a.agentId > 0n) completedByAgents++;
        usdcPaidGross += rewardByJobId.get(a.jobId.toString()) ?? 0n;
      }

      let protocolFeesUsdc = 0n;
      for (const l of feeLogs as Array<{ args: unknown }>) {
        const a = l.args as { amount: bigint };
        protocolFeesUsdc += a.amount;
      }

      return {
        totalPosted: createdLogs.length,
        usdcPostedGross,
        completed: completedLogs.length,
        completedByAgents,
        usdcPaidGross,
        protocolFeesUsdc,
        uniquePosters: posters.size,
        uniqueWorkers: workers.size,
        uniqueAgents: agents.size,
        openNow,
      };
    },
  });
}
