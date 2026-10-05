import { formatUnits, type Address } from "viem";
import { BOUNTY_ADAPTER_ABI } from "@/lib/contracts";
import { isPaidToWorker, workerOf } from "@/lib/bountyMetas";
import {
  adapters, apiJson, apiOptions, loadBoard, networkInfo, rateLimited, readFailed, serverClient,
} from "@/lib/publicApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Work history for reputation builders: who got paid, for what, and the
// ERC-8004 feedback this escrow wrote for each agent. The escrow is the
// feedback's client, so its summary is read per adapter and merged the way
// the leaderboard does (weighted by feedback count).

type Rep = { agentId: number; averageScore: number; feedbacks: number };

export async function GET(req: Request) {
  const limited = await rateLimited(req);
  if (limited) return limited;

  let board;
  try {
    board = await loadBoard();
  } catch (err) {
    return readFailed("workers", err);
  }

  const byWallet = new Map<string, { completed: number; earned: bigint; agentIds: Set<bigint>; jobIds: number[] }>();
  for (const m of board.metas) {
    if (!isPaidToWorker(m)) continue;
    const w = workerOf(m)!;
    const row = byWallet.get(w) ?? { completed: 0, earned: 0n, agentIds: new Set<bigint>(), jobIds: [] };
    row.completed++;
    row.earned += m.reward - (m.reward * board.feeBps) / 10_000n;
    if (m.agentId > 0n) row.agentIds.add(m.agentId);
    row.jobIds.push(Number(m.jobId));
    byWallet.set(w, row);
  }

  const agentIds = [...new Set([...byWallet.values()].flatMap(r => [...r.agentIds]))];
  const { current, history } = adapters();
  const all: Address[] = [current, ...history];
  const reps = new Map<bigint, Rep>();
  if (agentIds.length) {
    let results;
    try {
      results = await serverClient().multicall({
        allowFailure: true,
        contracts: agentIds.flatMap(id => all.map(address => ({
          address, abi: BOUNTY_ADAPTER_ABI, functionName: "getAgentReputation" as const, args: [id] as const,
        }))),
      });
    } catch (err) {
      return readFailed("workers reputation", err);
    }
    agentIds.forEach((id, i) => {
      let weighted = 0;
      let feedbacks = 0;
      all.forEach((_, j) => {
        const r = results[i * all.length + j];
        if (r?.status !== "success") return;
        const v = r.result as { averageScore: bigint; totalFeedbacks: bigint };
        weighted += Number(v.averageScore) * Number(v.totalFeedbacks);
        feedbacks += Number(v.totalFeedbacks);
      });
      reps.set(id, { agentId: Number(id), averageScore: feedbacks ? Math.round(weighted / feedbacks) : 0, feedbacks });
    });
  }

  const workers = [...byWallet.entries()]
    .map(([wallet, r]) => ({
      wallet,
      completed: r.completed,
      earnedUsdc: formatUnits(r.earned, 6),
      jobIds: r.jobIds.sort((a, b) => a - b),
      agents: [...r.agentIds].map(id => reps.get(id) ?? { agentId: Number(id), averageScore: 0, feedbacks: 0 }),
    }))
    .sort((a, b) => b.completed - a.completed || Number(b.earnedUsdc) - Number(a.earnedUsdc));

  return apiJson({
    ...networkInfo(),
    readAt: board.readAt.toISOString(),
    count: workers.length,
    workers,
    notes: [
      "earnedUsdc is net of the protocol fee.",
      "Reputation is the ERC-8004 feedback this board's escrow wrote; other clients' feedback is not included.",
    ],
  });
}

export function OPTIONS() {
  return apiOptions();
}
