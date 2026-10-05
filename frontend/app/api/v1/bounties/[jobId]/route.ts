import type { NextRequest } from "next/server";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";
import type { BountyMeta } from "@/components/BountyCard";
import { fetchIpfsServerCached } from "@/lib/ipfsServer";
import {
  apiJson, apiOptions, loadBoard, networkInfo, nowSec, rateLimited, readFailed, serverClient, toPublicBounty,
} from "@/lib/publicApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Task texts are a few KB; this only stops a giant pin from becoming a giant response. */
const MAX_TEXT_CHARS = 64_000;

const ZERO = "0x0000000000000000000000000000000000000000";

export async function GET(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const limited = await rateLimited(req);
  if (limited) return limited;

  const { jobId: raw } = await params;
  if (!/^\d{1,30}$/.test(raw)) return apiJson({ error: "jobId must be a number." }, 400);
  const jobId = BigInt(raw);

  let board;
  try {
    board = await loadBoard();
  } catch (err) {
    return readFailed("bounty", err);
  }

  let meta = board.metas.find(m => m.jobId === jobId);
  if (!meta) {
    // The shared board read is up to 15 s old; a bounty posted since then is
    // still worth answering, so ask the current adapter directly.
    try {
      const fresh = (await serverClient().readContract({
        address: CONTRACTS.BOUNTY_ADAPTER, abi: BOUNTY_ADAPTER_ABI, functionName: "getBountyMeta", args: [jobId],
      })) as unknown as BountyMeta;
      if (fresh.poster && fresh.poster !== ZERO) meta = { ...fresh, adapter: CONTRACTS.BOUNTY_ADAPTER };
    } catch (err) {
      return readFailed("bounty", err);
    }
  }
  if (!meta) return apiJson({ error: `No bounty ${raw} on this board.` }, 404);

  const bounty = toPublicBounty(meta, board.feeBps, nowSec());

  let descriptionText: string | null | undefined;
  if (req.nextUrl.searchParams.get("full") === "1") {
    descriptionText = null;
    const cid = meta.ipfsDescHash.replace(/^ipfs:\/\//, "").trim();
    if (cid && cid.length <= 200) {
      try {
        const { bytes } = await fetchIpfsServerCached(cid);
        descriptionText = new TextDecoder().decode(bytes).slice(0, MAX_TEXT_CHARS);
      } catch (err) {
        // Gateways lag on fresh pins; the hash and link are still in the answer.
        console.error(`[api/v1] description of ${raw}:`, err);
      }
    }
  }

  return apiJson({
    ...networkInfo(),
    bounty: descriptionText === undefined ? bounty : { ...bounty, descriptionText },
  });
}

export function OPTIONS() {
  return apiOptions();
}
