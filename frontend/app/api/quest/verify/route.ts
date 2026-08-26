import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, isAddress, type Address } from "viem";
import { activeChain } from "@/lib/wagmi";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";
import { getActiveNetwork } from "@/lib/networks";
import { clientKey, consumeAsync } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ─── Quest verification for Galxe and Zealy ──────────────────────────────────
//
// Both platforms verify custom on-chain actions the same way: they call an
// endpoint the project hosts with a wallet address and read the JSON answer.
// Galxe scores it with a JS expression (REST credential), Zealy reads the
// `result` field (`api` task type). Neither requires the chain to appear in
// its own supported-chain list, which is what makes an Arc quest possible at
// all - the list is only a shortcut for projects that do not want to host a
// check like this one.
//
// This lives in the frontend rather than in facade-api for one practical
// reason: it is already deployed at arcbounty.app, and this build registers
// Multicall3, so every bounty meta a verification needs collapses into a
// single eth_call. The facade reads through a 300ms paced lane instead, which
// a quest stampede would queue behind Galxe's 5-second ceiling.

const network = getActiveNetwork();

const client = createPublicClient({
  chain: activeChain,
  transport: http(network.rpcUrl, { batch: { wait: 16 }, retryCount: 2, retryDelay: 300 }),
});

const TASKS = [
  "took_bounty",
  "submitted_work",
  // Separate from submitted_work on purpose. takeBounty() has no
  // msg.sender != poster check, so a participant can post a bounty, take it
  // themselves and submit against it - satisfying "post one" and "do one"
  // without ever touching another person's listing. A quest whose copy says
  // "complete someone else's bounty" has to verify exactly that, or it pays
  // for a closed loop that adds nothing to the board.
  "submitted_for_other",
  "completed_bounty",
  "posted_bounty",
] as const;
type Task = (typeof TASKS)[number];

/**
 * Generous on purpose. A quest platform verifies every participant from its
 * own small set of IPs, so a limit tuned for one human per address would
 * throttle Galxe itself and fail the whole campaign. This only bounds someone
 * scripting the endpoint as a free chain-indexer.
 */
const IP_RATE = { capacity: 300, refillPerSecond: 300 / 60 };

/**
 * Addresses that already satisfied a task, kept for the lifetime of the
 * serverless instance and never downgraded.
 *
 * Each fact is monotonic - having taken a bounty does not un-happen - so an
 * RPC hiccup must never revoke a completion someone already earned. A cold
 * instance simply re-reads the chain, which is correct, just slower.
 */
const earned = new Map<string, Set<Task>>();

const ZERO_HASH = `0x${"0".repeat(64)}`;

function corsHeaders(): Record<string, string> {
  return {
    // Galxe runs a real OPTIONS preflight before it will save a campaign, and
    // its docs name a failed preflight as the cause of "the test passed but
    // the save did not". The payload is public chain state keyed by an address
    // the caller already supplied, and no credentials ride along.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
    "Access-Control-Max-Age": "86400",
  };
}

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: corsHeaders() });
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

/** Galxe can be configured to send the address without its 0x prefix, and
 * Zealy's payload shape is set in its task editor rather than published, so
 * every plausible spelling is accepted rather than guessed at. */
function parseAddress(raw: unknown): Address | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const candidate = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  return isAddress(candidate) ? (candidate.toLowerCase() as Address) : null;
}

async function verify(address: Address) {
  const [assigned, posted] = await Promise.all([
    client.readContract({
      address: CONTRACTS.BOUNTY_ADAPTER,
      abi: BOUNTY_ADAPTER_ABI,
      functionName: "getMyAssignedBounties",
      args: [address],
    }) as Promise<readonly bigint[]>,
    client.readContract({
      address: CONTRACTS.BOUNTY_ADAPTER,
      abi: BOUNTY_ADAPTER_ABI,
      functionName: "getMyPostedBounties",
      args: [address],
    }) as Promise<readonly bigint[]>,
  ]);

  let submitted = 0;
  let submittedForOther = 0;
  let completed = 0;

  if (assigned.length > 0) {
    // One aggregated eth_call for every bounty this address took, however many
    // that is. allowFailure keeps a single unreadable job from voiding the
    // whole verification.
    const metas = await client.multicall({
      allowFailure: true,
      contracts: assigned.map(jobId => ({
        address: CONTRACTS.BOUNTY_ADAPTER,
        abi: BOUNTY_ADAPTER_ABI,
        functionName: "getBountyMeta" as const,
        args: [jobId] as const,
      })),
    });

    for (const entry of metas) {
      if (entry.status !== "success") continue;
      const meta = entry.result as { submittedResultHash: string; resolved: boolean; poster: string };
      const hasSubmission = meta.submittedResultHash !== ZERO_HASH;
      if (hasSubmission) submitted++;
      if (hasSubmission && meta.poster.toLowerCase() !== address) submittedForOther++;
      // `resolved` alone would also count a bounty the poster cancelled;
      // pairing it with a submission is what makes it "this worker was paid".
      if (hasSubmission && meta.resolved) completed++;
    }
  }

  return {
    took_bounty: assigned.length > 0 ? 1 : 0,
    submitted_work: submitted > 0 ? 1 : 0,
    submitted_for_other: submittedForOther > 0 ? 1 : 0,
    completed_bounty: completed > 0 ? 1 : 0,
    posted_bounty: posted.length > 0 ? 1 : 0,
    counts: {
      taken: assigned.length,
      submitted,
      submittedForOther,
      completed,
      posted: posted.length,
    },
  } as const;
}

async function handle(req: NextRequest, bodyRaw: unknown): Promise<NextResponse> {
  const body = (bodyRaw ?? {}) as Record<string, unknown>;
  const url = new URL(req.url);

  const address = parseAddress(
    url.searchParams.get("address") ??
      url.searchParams.get("wallet") ??
      body["address"] ??
      body["wallet"] ??
      (body["user"] as Record<string, unknown> | undefined)?.["wallet"],
  );
  if (!address) {
    return json({ error: "supply an EVM address as ?address= or {\"address\": \"0x...\"}", tasks: TASKS }, 400);
  }

  const taskRaw = url.searchParams.get("task") ?? body["task"];
  const task = typeof taskRaw === "string" ? taskRaw : undefined;
  if (task !== undefined && !(TASKS as readonly string[]).includes(task)) {
    return json({ error: `unknown task "${task}"`, tasks: TASKS }, 400);
  }

  const rl = await consumeAsync(`quest:${clientKey(req)}`, IP_RATE);
  if (!rl.ok) {
    return json({ error: "Rate limit exceeded" }, 429);
  }

  const key = address.toLowerCase();
  const already = earned.get(key);

  let status: Awaited<ReturnType<typeof verify>>;
  try {
    status = await verify(address);
  } catch (err) {
    // Never answer a chain failure with zeroes. Telling someone who did the
    // work that they are ineligible costs a participant and earns a support
    // message; telling them to retry costs a click. If we already know they
    // earned something, serve that instead of failing.
    if (already && already.size > 0) {
      return json({
        address,
        network: network.name,
        brand: network.brand.name,
        ...Object.fromEntries(TASKS.map(t => [t, already.has(t) ? 1 : 0])),
        cached: true,
        ...(task ? { task, result: already.has(task as Task) ? 1 : 0 } : {}),
      });
    }
    console.error("[quest] chain read failed:", err);
    return json({ error: "could not read the chain, retry shortly", retryAfterSec: 10 }, 503);
  }

  const set = already ?? new Set<Task>();
  for (const t of TASKS) if (status[t] === 1) set.add(t);
  if (set.size > 0) earned.set(key, set);

  const merged = Object.fromEntries(TASKS.map(t => [t, set.has(t) ? 1 : status[t]])) as Record<Task, 0 | 1>;

  return json({
    address,
    network: network.name,
    brand: network.brand.name,
    ...merged,
    counts: status.counts,
    // The single field a platform can read when it has no scripting step of
    // its own. Galxe users point their JS expression at the named task.
    ...(task ? { task, result: merged[task as Task] } : {}),
  });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handle(req, null);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    // A platform that posts an empty or non-JSON body can still pass the
    // address in the query string, so this is not fatal on its own.
  }
  return handle(req, body);
}
