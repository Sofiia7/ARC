import { NextResponse } from "next/server";
import { createPublicClient, fallback, formatUnits, http, type Address, type PublicClient } from "viem";
import { activeChain } from "./wagmi";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "./contracts";
import { getActiveNetwork, getSiteUrl } from "./networks";
import { fetchAllBountyMetas, HISTORY_ADAPTERS, isPaidToWorker, workerOf, type SourcedMeta } from "./bountyMetas";
import { clientKey, consumeAsync } from "./rate-limit";

// ─── Public read API (/api/v1) ───────────────────────────────────────────────
//
// The board as plain JSON for anyone building on top of it: no key, no
// wallet, no payment. kaminariouji's Arc Pulse (2026-09-24) had to decode the
// adapter by hand because this site only rendered the board in a browser and
// the x402 facade serves Arc Testnet behind a paywall; this is the same data,
// first-party.
//
// Every number comes from contract storage through fetchAllBountyMetas, the
// reads behind the home counter, /stats and the leaderboard, so the API and
// the site cannot disagree. Responses are cached at the edge for 30 s and the
// chain read is shared per instance for 15 s, so a busy integrator costs the
// RPC almost nothing.

const network = getActiveNetwork();

export const SITE_URL = getSiteUrl();
export const API_VERSION = "v1";

/** Public gateway for links in responses: it serves our pins to scripts (ipfs.io refuses some). */
const GATEWAY = "https://gateway.pinata.cloud/ipfs/";

let client: PublicClient | null = null;

export function serverClient(): PublicClient {
  if (client) return client;
  const urls = [network.rpcUrl, ...(network.fallbackRpcUrls ?? [])];
  const options = { batch: { wait: 16 }, retryCount: 2, retryDelay: 300 };
  client = createPublicClient({
    chain: activeChain,
    transport: urls.length > 1 ? fallback(urls.map(u => http(u, options))) : http(urls[0], options),
  }) as PublicClient;
  return client;
}

// ─── One shared read of the whole board ──────────────────────────────────────

export type Board = { metas: SourcedMeta[]; feeBps: bigint; readAt: Date };

const BOARD_TTL_MS = 15_000;
let board: Board | null = null;
let inflight: Promise<Board> | null = null;

export async function loadBoard(): Promise<Board> {
  if (board && Date.now() - board.readAt.getTime() < BOARD_TTL_MS) return board;
  if (inflight) return inflight;
  inflight = (async () => {
    const c = serverClient();
    const [metas, feeBps] = await Promise.all([
      fetchAllBountyMetas(c, { withHistory: true }),
      c.readContract({ address: CONTRACTS.BOUNTY_ADAPTER, abi: BOUNTY_ADAPTER_ABI, functionName: "feeBps" }) as Promise<bigint>,
    ]);
    board = { metas, feeBps, readAt: new Date() };
    return board;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

// ─── Bounty shape ────────────────────────────────────────────────────────────

/**
 * Where a bounty stands, from storage alone.
 *
 * `settled` means the bounty closed after a rejection or a dispute: storage
 * does not record who won, so it is not counted as paid (the same rule as
 * isPaidToWorker). `closed` covers cancelled and expired-and-refunded
 * listings, and test runs where the poster took its own bounty.
 */
export type BountyStatus =
  | "open" | "taken" | "submitted" | "rejected" | "disputed" | "expired"
  | "paid" | "settled" | "closed";

export const STATUSES: readonly BountyStatus[] = [
  "open", "taken", "submitted", "rejected", "disputed", "expired", "paid", "settled", "closed",
];

export function bountyStatus(m: SourcedMeta, nowSec: bigint): BountyStatus {
  if (m.resolved) {
    if (isPaidToWorker(m)) return "paid";
    if (m.submittedResultHash && workerOf(m) && (m.rejectedAt > 0n || m.disputeRaisedAt > 0n)) return "settled";
    return "closed";
  }
  if (m.inDispute) return "disputed";
  if (m.rejectedAt > 0n) return "rejected";
  if (m.submittedResultHash) return "submitted";
  if (m.deadline <= nowSec) return "expired";
  if (m.isTaken) return "taken";
  return "open";
}

const ZERO = "0x0000000000000000000000000000000000000000";

function cidOf(uri: string): string | null {
  const cid = uri.replace(/^ipfs:\/\//, "").trim();
  return cid ? cid : null;
}

function usdc(units: bigint): string {
  return formatUnits(units, 6);
}

function iso(sec: bigint): string {
  return new Date(Number(sec) * 1000).toISOString();
}

export type PublicBounty = {
  jobId: number;
  url: string;
  status: BountyStatus;
  rewardUsdc: string;
  /** What the worker receives on approval: the reward minus the protocol fee. */
  workerPayoutUsdc: string;
  poster: Address;
  worker: Address | null;
  /** ERC-8004 identity the worker took the bounty with, if any. */
  workerAgentId: number | null;
  audience: "anyone" | "agents" | "humans";
  /** Set when the poster named the one address allowed to take it. */
  reservedFor: Address | null;
  category: string;
  tags: string[];
  deadline: string;
  submittedAt: string | null;
  description: string;
  descriptionUrl: string | null;
  result: string | null;
  resultUrl: string | null;
  workerBondRequired: boolean;
  workerBondUsdc: string;
  adapter: Address;
};

export function toPublicBounty(m: SourcedMeta, feeBps: bigint, nowSec: bigint): PublicBounty {
  const descCid = cidOf(m.ipfsDescHash);
  const resultCid = m.submittedResultHash ? cidOf(m.submittedResultHash) : null;
  const taken = m.assignedProvider && m.assignedProvider !== ZERO;
  return {
    jobId: Number(m.jobId),
    url: `${SITE_URL}/bounty/${m.jobId}`,
    status: bountyStatus(m, nowSec),
    rewardUsdc: usdc(m.reward),
    workerPayoutUsdc: usdc(m.reward - (m.reward * feeBps) / 10_000n),
    poster: m.poster as Address,
    worker: taken ? (m.assignedProvider as Address) : null,
    workerAgentId: taken && m.agentId > 0n ? Number(m.agentId) : null,
    audience: m.agentOnly ? "agents" : m.humanOnly ? "humans" : "anyone",
    reservedFor: m.whitelistedProvider && m.whitelistedProvider !== ZERO ? (m.whitelistedProvider as Address) : null,
    category: m.category,
    tags: [...m.tags],
    deadline: iso(m.deadline),
    submittedAt: m.submittedAt > 0n ? iso(m.submittedAt) : null,
    description: m.ipfsDescHash,
    descriptionUrl: descCid ? `${GATEWAY}${descCid}` : null,
    result: m.submittedResultHash || null,
    resultUrl: resultCid ? `${GATEWAY}${resultCid}` : null,
    workerBondRequired: m.requireWorkerBond,
    workerBondUsdc: usdc(m.workerBond),
    adapter: m.adapter,
  };
}

/** The adapter every write goes to, and the earlier ones whose history the counts include. */
export function adapters(): { current: Address; history: readonly Address[] } {
  return { current: CONTRACTS.BOUNTY_ADAPTER, history: HISTORY_ADAPTERS };
}

// ─── HTTP plumbing ───────────────────────────────────────────────────────────

const CORS: Record<string, string> = {
  // Public chain state, no credentials: any origin may read it.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

export function apiJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: {
      ...CORS,
      "Cache-Control": status === 200 ? "public, s-maxage=30, stale-while-revalidate=120" : "no-store",
    },
  });
}

export function apiOptions(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/**
 * Plenty for an integrator polling every few seconds; it only bounds someone
 * using the endpoint as a free RPC. Most traffic never reaches it anyway:
 * the edge answers repeats from cache.
 */
const RATE = { capacity: 120, refillPerSecond: 2 };

export async function rateLimited(req: Request): Promise<NextResponse | null> {
  const r = await consumeAsync(`api-v1:${clientKey(req)}`, RATE);
  if (r.ok) return null;
  const res = apiJson({ error: "Too many requests. Slow down and retry." }, 429);
  res.headers.set("Retry-After", String(Math.max(1, Math.ceil(r.retryAfterSec))));
  return res;
}

/**
 * A failed chain read answers 502 with a fixed message: RPC errors carry
 * endpoint URLs and provider internals that have no business in a public
 * response. The detail goes to the function log.
 */
export function readFailed(where: string, err: unknown): NextResponse {
  console.error(`[api/v1] ${where}:`, err);
  return apiJson({ error: "Could not read the chain right now. Retry in a few seconds." }, 502);
}

export function nowSec(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

export function networkInfo() {
  return {
    network: network.name,
    chainId: network.chainId,
    testnet: network.testnet,
    site: SITE_URL,
  };
}
