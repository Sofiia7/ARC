import { nadApiClient } from "@/lib/nadPublicApi";
import { CONTRACTS } from "@/lib/contracts";
import { fetchIpfsServerCached } from "@/lib/ipfsServer";
import { classifyNadJob, formatUsdcUnits, NAD_ESCROW_ABI, nadOutcomeLabel, type NadOutcome } from "@/lib/nadStats";

// Server-side data for one bounty's link preview, shared by layout.tsx (the <title> and description) and
// opengraph-image.tsx (the card). Everything here is best effort: any failure resolves to null and the callers fall
// back to the generic site metadata. Only the public description is ever read - a contest's entries and its
// encryption key are never touched.

export type BountyCard = {
  jobId: string;
  title: string;
  /** Plain text, at most 160 characters; empty when the poster wrote none (or it could not be fetched in time). */
  description: string;
  /** "$2 USDC" */
  reward: string;
  contest: boolean;
  outcome: NadOutcome;
  /** "Open", "Paid", "Refunded" ... */
  status: string;
};

const POSITIVE_INT = /^[1-9]\d{0,17}$/;
/** Hard ceiling on how long a preview waits for IPFS; the card is then built without a description. */
const IPFS_TIMEOUT_MS = 3_000;
/** A description is a few KB of text; anything bigger is not read. */
const MAX_DESCRIPTION_BYTES = 64 * 1024;
/** A card with its description is kept this long; one without is retried sooner. */
const CACHE_TTL_MS = 60_000;
const PARTIAL_TTL_MS = 15_000;
const CACHE_MAX = 200;
const cache = new Map<string, { until: number; card: BountyCard }>();

/** Markdown / HTML to one line of plain text. */
export function plainText(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/^[ \t]{0,3}(?:#{1,6}|[-*+>]|\d+\.)[ \t]+/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Cuts to `max` characters (counted in code points) and marks the cut with three dots, backing up to the last
 * space when that costs less than the final 40% so a word is not sliced in half.
 */
export function clip(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const cut = chars.slice(0, max - 3).join("");
  const space = cut.lastIndexOf(" ");
  return `${(space > (max - 3) * 0.6 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

/**
 * Reads the public part of a description pin: the JSON the post form writes ({ title, description }, the launch demo
 * pins { name, description }), or plain markdown. Nothing else in the JSON is looked at.
 */
export function parseDescription(raw: string): { title: string; body: string } {
  let text = raw;
  let title = "";
  try {
    const json = JSON.parse(raw) as { title?: unknown; name?: unknown; description?: unknown };
    const named = typeof json?.title === "string" && json.title.trim() ? json.title : json?.name;
    if (typeof named === "string") title = plainText(named);
    text = typeof json?.description === "string" ? json.description : "";
  } catch {
    // Not JSON: the pin is the markdown itself.
  }
  const lines = text.split("\n");
  const firstIndex = lines.findIndex((l) => l.trim());
  const first = firstIndex < 0 ? "" : plainText(lines[firstIndex]);
  if (!title) title = first;
  // The post form copies the first line into the title, so do not say it twice.
  const body = plainText(first && first === title ? lines.slice(firstIndex + 1).join("\n") : text);
  return { title, body };
}

/** The pinned description text, or null if IPFS does not answer within the ceiling. */
async function readDescription(uri: string): Promise<string | null> {
  const cid = uri.replace(/^ipfs:\/\//, "").trim();
  if (!/^[A-Za-z0-9]{20,128}$/.test(cid)) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The shared gateway race (same Data Cache entries as /api/ipfs/read, warmed when the bounty is pinned).
    const { bytes } = await Promise.race([
      fetchIpfsServerCached(cid),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("IPFS timeout")), IPFS_TIMEOUT_MS);
      }),
    ]);
    return bytes.byteLength > MAX_DESCRIPTION_BYTES ? null : new TextDecoder().decode(bytes);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The preview data for bounty `rawId`, or null when the id is not a positive integer, the bounty does not exist,
 * this is not a Monad build, or the chain cannot be read. A missing or slow IPFS description is not a failure:
 * the card then carries a generic title ("Bounty #7") and no description.
 */
export async function loadBountyCard(rawId: string): Promise<BountyCard | null> {
  if (!POSITIVE_INT.test(rawId)) return null;
  const hit = cache.get(rawId);
  if (hit && Date.now() < hit.until) return hit.card;
  try {
    const { client, adapter, abi, block } = await nadApiClient();
    const jobId = BigInt(rawId);
    const blockNumber = block.number;
    const meta = await client.readContract({
      address: adapter,
      abi,
      functionName: "getBountyMeta",
      args: [jobId],
      blockNumber,
    });
    if (meta.poster === "0x0000000000000000000000000000000000000000") return null;
    const [job, entries, raw] = await Promise.all([
      client.readContract({
        address: CONTRACTS.AGENTIC_COMMERCE,
        abi: NAD_ESCROW_ABI,
        functionName: "getJob",
        args: [jobId],
        blockNumber,
      }),
      meta.contest
        ? client.readContract({ address: adapter, abi, functionName: "getContestEntries", args: [jobId], blockNumber })
        : Promise.resolve([]),
      readDescription(meta.ipfsDescHash),
    ]);
    // Only the outcome is used here, which does not depend on the fee, so the default fee is fine.
    const { outcome } = classifyNadJob({ meta, escrowStatus: job.status, entries }, { nowSec: block.timestamp });
    const parsed = raw === null ? { title: "", body: "" } : parseDescription(raw);
    const card: BountyCard = {
      jobId: rawId,
      title: parsed.title || `Bounty #${rawId}`,
      description: parsed.body ? clip(parsed.body, 160) : "",
      reward: `$${formatUsdcUnits(meta.reward)} USDC`,
      contest: meta.contest,
      outcome,
      status: nadOutcomeLabel(outcome),
    };
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(rawId, { until: Date.now() + (raw === null ? PARTIAL_TTL_MS : CACHE_TTL_MS), card });
    return card;
  } catch {
    return null;
  }
}
