import { formatUnits } from "viem";
import { computeProtocolStats } from "@/lib/protocolStats";
import { adapters, apiJson, apiOptions, loadBoard, networkInfo, nowSec, rateLimited, readFailed } from "@/lib/publicApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const usdc = (units: bigint) => formatUnits(units, 6);

export async function GET(req: Request) {
  const limited = await rateLimited(req);
  if (limited) return limited;

  let board;
  try {
    board = await loadBoard();
  } catch (err) {
    return readFailed("stats", err);
  }

  const s = computeProtocolStats(board.metas, board.feeBps, nowSec());
  return apiJson({
    ...networkInfo(),
    adapter: adapters().current,
    readAt: board.readAt.toISOString(),
    posted: s.totalPosted,
    open: s.openNow,
    completed: s.completed,
    completedByAgents: s.completedByAgents,
    postedUsdc: usdc(s.usdcPostedGross),
    completedRewardsUsdc: usdc(s.usdcPaidGross),
    paidToWorkersUsdc: usdc(s.usdcPaidGross - s.protocolFeesUsdc),
    protocolFeesUsdc: usdc(s.protocolFeesUsdc),
    feeBps: Number(board.feeBps),
    posters: s.uniquePosters,
    workers: s.uniqueWorkers,
    agents: s.uniqueAgents,
    notes: [
      "completed counts bounties paid to a worker: approved by the poster or auto-approved after the review window.",
      "Bounties settled through a rejection or a dispute are not counted as completed, since storage does not record the outcome.",
      "A poster taking its own bounty (a test run) counts neither as completed nor as a worker.",
    ],
  });
}

export function OPTIONS() {
  return apiOptions();
}
