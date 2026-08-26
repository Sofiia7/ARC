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

/**
 * What the participant reads inside Zealy when a claim is rejected. Zealy shows
 * this string verbatim, so each one names the missing action and where to go do
 * it - a bare "not eligible" turns into a support message instead of a visit.
 */
const PASS_MESSAGE = "Verified on-chain. Nice work.";

const NOT_YET: Record<Task, string> = {
  took_bounty:
    "This wallet has not taken a bounty yet. Pick an open one at arcbounty.app, take it, then claim again.",
  submitted_work:
    "No submitted work found for this wallet. Take a bounty at arcbounty.app, submit your result, then claim again.",
  submitted_for_other:
    "No submitted work found on a bounty posted by someone else. Bounties you posted yourself do not count - take one from another poster at arcbounty.app, submit your result, then claim again.",
  completed_bounty:
    "No bounty of yours has been approved and paid out yet. This one waits on the poster, so claim again once the payout lands.",
  posted_bounty:
    "No bounty posted from this wallet yet. Get free testnet USDC from Circle's faucet (pick Arc Testnet), post one at arcbounty.app/post, then claim again.",
};

function notYetMessage(task: string | undefined): string {
  if (task && task in NOT_YET) return NOT_YET[task as Task];
  return "No ArcBounty activity found for this wallet yet. Post or take a bounty at arcbounty.app, then claim again.";
}

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

/**
 * Zealy encodes the verdict in the status code, not in the body: 200 means the
 * user completed the action, 400 means they did not, and it validates that an
 * endpoint returns nothing else. Answering a Zealy claim the Galxe way - 200
 * with a `result` field - would pass every participant who never touched the
 * board, because Zealy would only ever see the 200.
 *
 * Detected from the payload rather than configured, so the same URL works in
 * both places: `accounts` and `requestId` are Zealy's signature and Galxe
 * sends neither. `?format=zealy` forces it if that ever stops being true.
 */
function isZealy(body: Record<string, unknown>, url: URL): boolean {
  if (url.searchParams.get("format") === "zealy") return true;
  return body["accounts"] !== undefined || body["requestId"] !== undefined;
}

function zealyReply(passed: boolean, message: string): NextResponse {
  return NextResponse.json({ message }, { status: passed ? 200 : 400, headers: corsHeaders() });
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
  const zealy = isZealy(body, url);

  /** In Zealy mode every answer has to be a 200 or a 400 carrying `message`;
   * its endpoint tester rejects anything else outright. Everywhere else the
   * full status object is more useful. */
  const fail = (message: string, status = 400): NextResponse =>
    zealy ? zealyReply(false, message) : json({ error: message, tasks: TASKS }, status);

  const address = parseAddress(
    url.searchParams.get("address") ??
      url.searchParams.get("wallet") ??
      body["address"] ??
      body["wallet"] ??
      // Zealy's actual shape, from zealy.io/docs/tasks/api: the wallet arrives
      // nested under `accounts`, never at the top level.
      (body["accounts"] as Record<string, unknown> | undefined)?.["wallet"] ??
      (body["user"] as Record<string, unknown> | undefined)?.["wallet"],
  );
  if (!address) {
    return fail(
      zealy
        ? "Connect a wallet to your Zealy account first - this quest is verified against on-chain activity."
        : "supply an EVM address as ?address= or {\"address\": \"0x...\"}",
    );
  }

  const taskRaw = url.searchParams.get("task") ?? body["task"];
  const task = typeof taskRaw === "string" ? taskRaw : undefined;
  if (task !== undefined && !(TASKS as readonly string[]).includes(task)) {
    return fail(`Unknown task "${task}".`);
  }

  const rl = await consumeAsync(`quest:${clientKey(req)}`, IP_RATE);
  if (!rl.ok) {
    return fail("Too many verification attempts right now, try again in a minute.", 429);
  }

  const key = address.toLowerCase();
  const already = earned.get(key);

  let status: Awaited<ReturnType<typeof verify>>;
  try {
    status = await verify(address);
  } catch (err) {
    // Never answer a chain failure with a plain "no". Telling someone who did
    // the work that they are ineligible costs a participant and earns a
    // support message; telling them to retry costs a click. If we already know
    // they earned something, serve that instead of failing.
    if (already && already.size > 0) {
      const passed = task ? already.has(task as Task) : already.size > 0;
      if (zealy) return zealyReply(passed, passed ? PASS_MESSAGE : notYetMessage(task));
      return json({
        address,
        network: network.name,
        brand: network.brand.name,
        ...Object.fromEntries(TASKS.map(t => [t, already.has(t) ? 1 : 0])),
        cached: true,
        ...(task ? { task, result: passed ? 1 : 0 } : {}),
      });
    }
    console.error("[quest] chain read failed:", err);
    // Zealy accepts only 200 and 400, so a 503 is not an option there; say
    // plainly that this is our side and worth retrying.
    return zealy
      ? zealyReply(false, "Could not read the chain just now. Wait a minute and claim again.")
      : json({ error: "could not read the chain, retry shortly", retryAfterSec: 10 }, 503);
  }

  const set = already ?? new Set<Task>();
  for (const t of TASKS) if (status[t] === 1) set.add(t);
  if (set.size > 0) earned.set(key, set);

  const merged = Object.fromEntries(TASKS.map(t => [t, set.has(t) ? 1 : status[t]])) as Record<Task, 0 | 1>;

  if (zealy) {
    // Without a task the only sensible reading is "did anything at all", which
    // is a weak quest - but it should still not silently pass everyone.
    const passed = task ? merged[task as Task] === 1 : TASKS.some(t => merged[t] === 1);
    return zealyReply(passed, passed ? PASS_MESSAGE : notYetMessage(task));
  }

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
