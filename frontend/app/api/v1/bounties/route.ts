import type { NextRequest } from "next/server";
import { isAddress } from "viem";
import {
  adapters, apiJson, apiOptions, loadBoard, networkInfo, nowSec, rateLimited, readFailed,
  STATUSES, toPublicBounty, type BountyStatus, type PublicBounty,
} from "@/lib/publicApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AUDIENCES = ["anyone", "agents", "humans"] as const;

export async function GET(req: NextRequest) {
  const limited = await rateLimited(req);
  if (limited) return limited;

  const q = req.nextUrl.searchParams;

  let statuses: Set<BountyStatus> | null = null;
  const statusParam = q.get("status");
  if (statusParam) {
    const asked = statusParam.split(",").map(s => s.trim()).filter(Boolean);
    const unknown = asked.filter(s => !STATUSES.includes(s as BountyStatus));
    if (unknown.length) {
      return apiJson({ error: `Unknown status: ${unknown.join(", ")}. Use ${STATUSES.join(", ")}.` }, 400);
    }
    statuses = new Set(asked as BountyStatus[]);
  }

  const audience = q.get("audience");
  if (audience && !(AUDIENCES as readonly string[]).includes(audience)) {
    return apiJson({ error: `Unknown audience: ${audience}. Use ${AUDIENCES.join(", ")}.` }, 400);
  }

  const address = (name: "poster" | "worker"): string | null | false => {
    const v = q.get(name);
    if (!v) return null;
    return isAddress(v, { strict: false }) ? v.toLowerCase() : false;
  };
  const poster = address("poster");
  const worker = address("worker");
  if (poster === false || worker === false) {
    return apiJson({ error: "poster and worker must be 0x addresses." }, 400);
  }

  let board;
  try {
    board = await loadBoard();
  } catch (err) {
    return readFailed("bounties", err);
  }

  const now = nowSec();
  const bounties: PublicBounty[] = board.metas
    .map(m => toPublicBounty(m, board.feeBps, now))
    .filter(b =>
      (!statuses || statuses.has(b.status))
      && (!audience || b.audience === audience)
      && (!poster || b.poster.toLowerCase() === poster)
      && (!worker || b.worker?.toLowerCase() === worker))
    .sort((a, b) => b.jobId - a.jobId);

  return apiJson({
    ...networkInfo(),
    adapter: adapters().current,
    readAt: board.readAt.toISOString(),
    count: bounties.length,
    bounties,
  });
}

export function OPTIONS() {
  return apiOptions();
}
