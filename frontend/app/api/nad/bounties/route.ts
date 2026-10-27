import { NextRequest } from "next/server";
import { nadApiClient, nadJson } from "@/lib/nadPublicApi";
import { rateLimited } from "@/lib/publicApi";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One chain read per page per instance every 5 minutes, whatever the CDN region of the caller.
const PAGE_TTL_MS = 300_000;
const pages = new Map<string, { at: number; body: Record<string, unknown> }>();
export async function GET(req: NextRequest) {
  const limited = await rateLimited(req);
  if (limited) return limited;
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? "25"),
    offset = Number(req.nextUrl.searchParams.get("offset") ?? "0");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0)
    return nadJson({ error: "limit must be 1-100; offset must be a nonnegative integer" }, 400);
  const key = `${offset}:${limit}`,
    hit = pages.get(key);
  if (hit && Date.now() - hit.at < PAGE_TTL_MS) return nadJson(hit.body);
  try {
    const { client, adapter, abi, block, info } = await nadApiClient();
    const total = await client.readContract({
      address: adapter,
      abi,
      functionName: "totalBounties",
      blockNumber: block.number,
    });
    const bounties = [];
    for (let i = total - 1n - BigInt(offset); i >= 0n && bounties.length < limit; i--) {
      const id = await client.readContract({
        address: adapter,
        abi,
        functionName: "allJobIds",
        args: [i],
        blockNumber: block.number,
      });
      bounties.push(
        await client.readContract({
          address: adapter,
          abi,
          functionName: "getBountyMeta",
          args: [id],
          blockNumber: block.number,
        }),
      );
    }
    const body = { ...info, total, offset, limit, bounties };
    if (pages.size >= 100) pages.clear();
    pages.set(key, { at: Date.now(), body });
    return nadJson(body);
  } catch {
    return nadJson({ error: "Could not read NadBounty V4.8" }, 502);
  }
}
