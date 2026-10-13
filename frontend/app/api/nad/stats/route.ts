import { NextRequest, NextResponse } from "next/server";
import type { Address } from "viem";
import { nadApiClient, nadJson } from "@/lib/nadPublicApi";
import { rateLimited, safeLogError } from "@/lib/publicApi";
import { CONTRACTS } from "@/lib/contracts";
import { MULTICALL3_ADDRESS } from "@/lib/networks";
import {
  buildNadStatsReport,
  NAD_ESCROW_ABI,
  NAD_REGISTRY_ABI,
  type NadJobSnapshot,
  type NadStatsEntry,
} from "@/lib/nadStats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Board-wide stats from storage only. The Monad public RPC caps eth_getLogs at 100 blocks, so nothing here reads
// events: every number comes from view calls batched through Multicall3, all pinned to one block so the snapshot is
// internally consistent. At most the newest MAX_JOBS jobs are read; `coverage` says when the board is larger.

const MAX_JOBS = 300;
const CHUNK = 50;
/** One chain read is shared per instance for this long, so query-string variants cannot multiply RPC traffic. */
const TTL_MS = 15_000;

/** Runs one Multicall3 request per chunk of calls, one after the other (the public RPC is shared and rate limited). */
async function inChunks<T, R>(items: readonly T[], run: (chunk: T[]) => Promise<R[]>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(...(await run(items.slice(i, i + CHUNK))));
  return out;
}

async function buildBody() {
  const { client, adapter, abi, block, info } = await nadApiClient();
  const blockNumber = block.number;
  const multicall = { blockNumber, multicallAddress: MULTICALL3_ADDRESS, batchSize: 0, allowFailure: false } as const;

  const total = await client.readContract({ address: adapter, abi, functionName: "totalBounties", blockNumber });
  const count = Number(total < BigInt(MAX_JOBS) ? total : BigInt(MAX_JOBS));
  const first = total - BigInt(count);

  const ids = await inChunks(
    Array.from({ length: count }, (_, i) => first + BigInt(i)),
    (chunk) =>
      client.multicall({
        ...multicall,
        contracts: chunk.map((index) => ({ address: adapter, abi, functionName: "allJobIds", args: [index] }) as const),
      }),
  );
  const metas = await inChunks(ids, (chunk) =>
    client.multicall({
      ...multicall,
      contracts: chunk.map((id) => ({ address: adapter, abi, functionName: "getBountyMeta", args: [id] }) as const),
    }),
  );
  const contestIds = metas.filter((m) => m.contest).map((m) => m.jobId);
  const [jobs, entryLists] = await Promise.all([
    inChunks(ids, (chunk) =>
      client.multicall({
        ...multicall,
        contracts: chunk.map(
          (id) =>
            ({ address: CONTRACTS.AGENTIC_COMMERCE, abi: NAD_ESCROW_ABI, functionName: "getJob", args: [id] }) as const,
        ),
      }),
    ),
    inChunks(contestIds, (chunk) =>
      client.multicall({
        ...multicall,
        contracts: chunk.map(
          (id) => ({ address: adapter, abi, functionName: "getContestEntries", args: [id] }) as const,
        ),
      }),
    ),
  ]);

  const entriesByJob = new Map<bigint, readonly NadStatsEntry[]>(contestIds.map((id, i) => [id, entryLists[i]]));

  // Only agent payees need a registry lookup: a human wallet is its own owner.
  const agentIds = new Set<bigint>();
  metas.forEach((m) => {
    if (m.contest) entriesByJob.get(m.jobId)?.forEach((e) => e.awarded && e.agentId !== 0n && agentIds.add(e.agentId));
    else if (m.resolved && m.agentId !== 0n) agentIds.add(m.agentId);
  });
  const agentList = [...agentIds];
  const owners = await inChunks(agentList, (chunk) =>
    client.multicall({
      ...multicall,
      // A burned or unreadable identity must not fail the whole snapshot: its payout simply shows no owner.
      allowFailure: true,
      contracts: chunk.map(
        (id) =>
          ({
            address: CONTRACTS.IDENTITY_REGISTRY as Address,
            abi: NAD_REGISTRY_ABI,
            functionName: "ownerOf",
            args: [id],
          }) as const,
      ),
    }),
  );
  const ownerById = new Map<bigint, string | null>(
    agentList.map((id, i) => [id, owners[i].status === "success" ? owners[i].result : null]),
  );

  const snapshots: NadJobSnapshot[] = metas.map((meta, i) => ({
    meta,
    escrowStatus: jobs[i].status,
    entries: entriesByJob.get(meta.jobId) ?? [],
  }));

  const feeBps = await client.readContract({ address: adapter, abi, functionName: "feeBps", blockNumber });
  const report = buildNadStatsReport(snapshots, {
    nowSec: block.timestamp,
    feeBps,
    ownerOf: (id) => ownerById.get(id),
  });

  return {
    chainId: info.chainId,
    adapter: info.adapter,
    sourceBlock: info.sourceBlock,
    sourceBlockHash: info.sourceBlockHash,
    generatedAt: new Date().toISOString(),
    coverage: { jobsRead: count, totalBounties: Number(total), truncated: total > BigInt(count) },
    ...report,
  };
}

let cached: { at: number; body: Awaited<ReturnType<typeof buildBody>> } | null = null;
let inflight: Promise<Awaited<ReturnType<typeof buildBody>>> | null = null;

async function loadBody() {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.body;
  if (!inflight) {
    inflight = buildBody()
      .then((body) => {
        cached = { at: Date.now(), body };
        return body;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export async function GET(req: NextRequest) {
  const limited = await rateLimited(req);
  if (limited) return limited;
  try {
    const body = await loadBody();
    return new NextResponse(
      JSON.stringify(body, (_, v) => (typeof v === "bigint" ? String(v) : v)),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  } catch (err) {
    console.error("[api/nad/stats]", safeLogError(err));
    return nadJson({ error: "Could not read NadBounty V4.8" }, 502);
  }
}
