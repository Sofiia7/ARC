import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import {
  createPublicClient, createWalletClient, http, type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";
import { activeChain } from "@/lib/wagmi";

// Plain !== leaks comparison time proportional to the matching prefix length.
// CRON_SECRET is Vercel-generated (not attacker-guessable in practice), but
// this is free to get right.
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Keeper cron - drives the contract's permissionless liveness paths so no human
// has to babysit the board:
//   • expireBounty(jobId)          - past deadline, no submission  → refund poster
//   • autoApprove(jobId)           - submitted, APPROVAL_TIMEOUT elapsed, poster ghosted → pay worker
//   • finalizeRejection(jobId)     - rejection unchallenged past REJECTION_CHALLENGE_WINDOW → refund poster
//   • claimDefaultRuling(jobId)    - dispute unanswered past DISPUTE_RESPONSE_WINDOW → initiator's opponent loses by default
//   • claimArbitratorTimeout(jobId)- dispute answered both sides, arbitrator never ruled, past ARBITRATOR_TIMEOUT → neutral 50/50 split
//   • reconcileExpiredEscrow(jobId)- AC's own claimRefund fired despite AC_EXPIRY_BUFFER (something unresolved 90+ days) → attribute funds per the contract's documented default
// (V4.7, M-03: the last four were a total gap before this - only the first
// two liveness paths were ever driven by this cron. reconcileExpiredEscrow
// coverage was itself a gap found in review of the other three, after this
// file first shipped without it.)
//
// INERT BY DEFAULT. Activates only when KEEPER_PRIVATE_KEY is set. Wire it up in
// Vercel Cron (e.g. every 6h) and protect with CRON_SECRET. Until then this
// route is a safe no-op (503).
//
// Env:
//   KEEPER_PRIVATE_KEY   - funded wallet (ARC for gas). Send a low-value key.
//   CRON_SECRET          - Vercel sets `Authorization: Bearer <CRON_SECRET>`.
//   Chain + RPC come from the shared `activeChain` (lib/wagmi.ts) - whichever
//   network this build was compiled for (NEXT_PUBLIC_ARC_NETWORK).
// Query:
//   ?dryRun=1            - list candidates without sending transactions.

// `allJobIds(uint256)` is a public array getter on the adapter but isn't in the
// shared ABI (the UI never enumerates the full set). The keeper does, so add it
// here locally.
const ALL_JOB_IDS_ABI = [{
  name: "allJobIds", type: "function", stateMutability: "view",
  inputs: [{ name: "", type: "uint256" }],
  outputs: [{ name: "", type: "uint256" }],
}] as const;

// AC's own job status, only consulted for jobs old enough that AC_EXPIRY_BUFFER
// could plausibly have elapsed - see the reconcileExpiredEscrow candidate below.
// Matches the real AgenticCommerce.sol Job struct/JobStatus enum exactly
// (contracts/src/base/AgenticCommerce.sol) - dynamic fields (description) must
// stay in the ABI even though this route never reads them, or the tuple
// decodes incorrectly.
const AC_GET_JOB_ABI = [{
  name: "getJob", type: "function", stateMutability: "view",
  inputs: [{ name: "jobId", type: "uint256" }],
  outputs: [{
    name: "", type: "tuple",
    components: [
      { name: "id", type: "uint256" },
      { name: "client", type: "address" },
      { name: "provider", type: "address" },
      { name: "evaluator", type: "address" },
      { name: "description", type: "string" },
      { name: "budget", type: "uint256" },
      { name: "expiredAt", type: "uint256" },
      { name: "status", type: "uint8" },
      { name: "hook", type: "address" },
    ],
  }],
}] as const;
const AC_JOB_STATUS_EXPIRED = 5; // Open,Funded,Submitted,Completed,Rejected,Expired

type Meta = {
  jobId: bigint; poster: Address; deadline: bigint;
  submittedResultHash: string; submittedAt: bigint;
  resolved: boolean; inDispute: boolean; rejectedAt: bigint; isTaken: boolean;
  disputeRaisedAt: bigint; disputeResponseHash: string;
};

/** How long to wait for a dispatched tx's receipt before giving up on THIS
 *  run confirming it (the tx itself is still live - just unconfirmed here). */
const RECEIPT_TIMEOUT_MS = 60_000;

export async function GET(req: NextRequest) {
  const pk = process.env.KEEPER_PRIVATE_KEY;
  if (!pk) {
    return NextResponse.json(
      { error: "keeper not configured: KEEPER_PRIVATE_KEY missing (route inert)" },
      { status: 503 },
    );
  }

  // ── Auth ──
  // Mandatory once the keeper wallet is live: an unauthenticated keeper route
  // lets anyone spam it and burn the keeper wallet's gas on every call. A
  // missing CRON_SECRET next to a funded KEEPER_PRIVATE_KEY is a
  // misconfiguration, not an open-by-default route.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "keeper misconfigured: KEEPER_PRIVATE_KEY is set but CRON_SECRET is missing" },
      { status: 503 },
    );
  }
  const auth = req.headers.get("authorization");
  if (!auth || !safeEqual(auth, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const adapter = CONTRACTS.BOUNTY_ADAPTER;
  const agenticCommerce = CONTRACTS.AGENTIC_COMMERCE;

  const chain = activeChain;
  const rpc = chain.rpcUrls.default.http[0];
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const account = privateKeyToAccount(pk as `0x${string}`);
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });

  const now = BigInt(Math.floor(Date.now() / 1000));

  const [total, approvalTimeout, rejectionChallengeWindow, disputeResponseWindow, arbitratorTimeout, acExpiryBuffer] =
    await Promise.all([
      pub.readContract({ address: adapter, abi: BOUNTY_ADAPTER_ABI, functionName: "totalBounties" }) as Promise<bigint>,
      pub.readContract({ address: adapter, abi: BOUNTY_ADAPTER_ABI, functionName: "APPROVAL_TIMEOUT" }) as Promise<bigint>,
      pub.readContract({ address: adapter, abi: BOUNTY_ADAPTER_ABI, functionName: "REJECTION_CHALLENGE_WINDOW" }) as Promise<bigint>,
      pub.readContract({ address: adapter, abi: BOUNTY_ADAPTER_ABI, functionName: "DISPUTE_RESPONSE_WINDOW" }) as Promise<bigint>,
      pub.readContract({ address: adapter, abi: BOUNTY_ADAPTER_ABI, functionName: "ARBITRATOR_TIMEOUT" }) as Promise<bigint>,
      pub.readContract({ address: adapter, abi: BOUNTY_ADAPTER_ABI, functionName: "AC_EXPIRY_BUFFER" }) as Promise<bigint>,
    ]);

  const expireCandidates: string[] = [];
  const autoApproveCandidates: string[] = [];
  const finalizeRejectionCandidates: string[] = [];
  const claimDefaultRulingCandidates: string[] = [];
  const claimArbitratorTimeoutCandidates: string[] = [];
  const reconcileExpiredEscrowCandidates: string[] = [];
  const sent: { action: string; jobId: string; hash: string; confirmed: boolean }[] = [];
  const failed: { action: string; jobId: string; error: string }[] = [];

  // V4.7 (M-03): dispatches a write and waits (bounded) for its receipt, so a
  // reverted transaction is reported as `failed`, not silently as `sent` -
  // previously this route reported a hash the instant it was accepted by the
  // mempool, with no confirmation it was ever actually mined, let alone that
  // it succeeded.
  async function dispatch(functionName: string, jobId: bigint, action: string): Promise<void> {
    let hash: `0x${string}`;
    try {
      hash = await wallet.writeContract({
        address: adapter, abi: BOUNTY_ADAPTER_ABI, functionName, args: [jobId], chain, account,
      } as never);
    } catch (e) {
      failed.push({ action, jobId: jobId.toString(), error: errMsg(e) });
      return;
    }
    try {
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
      if (receipt.status === "reverted") {
        failed.push({ action, jobId: jobId.toString(), error: `tx ${hash} was mined but reverted` });
        return;
      }
      sent.push({ action, jobId: jobId.toString(), hash, confirmed: true });
    } catch {
      // Sent, but no receipt within the timeout - still genuinely in flight,
      // not a failure. Recorded unconfirmed rather than silently claimed as
      // a success; the next run will see it as still-actionable if it never
      // lands, or skip it (resolved) if it did.
      sent.push({ action, jobId: jobId.toString(), hash, confirmed: false });
    }
  }

  for (let i = 0n; i < total; i++) {
    let jobId: bigint;
    try {
      jobId = await pub.readContract({
        address: adapter, abi: ALL_JOB_IDS_ABI, functionName: "allJobIds", args: [i],
      }) as bigint;
    } catch { continue; }

    let m: Meta;
    try {
      m = await pub.readContract({
        address: adapter, abi: BOUNTY_ADAPTER_ABI, functionName: "getBountyMeta", args: [jobId],
      }) as unknown as Meta;
    } catch { continue; }

    if (m.resolved) continue;

    const hasSubmission = m.submittedResultHash.length > 0;

    // expireBounty: past deadline, no submission yet.
    if (!hasSubmission && now > m.deadline) {
      expireCandidates.push(jobId.toString());
      if (!dryRun) await dispatch("expireBounty", jobId, "expire");
      continue;
    }

    // autoApprove: submitted, not disputed/rejected, approval window elapsed.
    if (hasSubmission && !m.inDispute && m.rejectedAt === 0n && now > m.submittedAt + approvalTimeout) {
      autoApproveCandidates.push(jobId.toString());
      if (!dryRun) await dispatch("autoApprove", jobId, "autoApprove");
      continue;
    }

    // finalizeRejection: poster rejected, worker never challenged, window closed.
    if (m.rejectedAt > 0n && !m.inDispute && now > m.rejectedAt + rejectionChallengeWindow) {
      finalizeRejectionCandidates.push(jobId.toString());
      if (!dryRun) await dispatch("finalizeRejection", jobId, "finalizeRejection");
      continue;
    }

    if (m.inDispute) {
      const noResponse = m.disputeResponseHash.length === 0;
      // claimDefaultRuling: dispute raised, respondent never replied, window closed.
      if (noResponse && now > m.disputeRaisedAt + disputeResponseWindow) {
        claimDefaultRulingCandidates.push(jobId.toString());
        if (!dryRun) await dispatch("claimDefaultRuling", jobId, "claimDefaultRuling");
        continue;
      }
      // claimArbitratorTimeout: both sides responded, arbitrator never ruled, window closed.
      if (!noResponse && now > m.disputeRaisedAt + arbitratorTimeout) {
        claimArbitratorTimeoutCandidates.push(jobId.toString());
        if (!dryRun) await dispatch("claimArbitratorTimeout", jobId, "claimArbitratorTimeout");
        continue;
      }
    }

    // reconcileExpiredEscrow: last-resort safety net, only worth checking once
    // AC_EXPIRY_BUFFER could plausibly have elapsed (every branch above should
    // otherwise have already resolved this job well before then) - an extra
    // read against AgenticCommerce, so it's gated behind this cheap timestamp
    // check rather than run for every unresolved job on every scan.
    if (now > m.deadline + acExpiryBuffer) {
      try {
        const job = await pub.readContract({
          address: agenticCommerce, abi: AC_GET_JOB_ABI, functionName: "getJob", args: [jobId],
        });
        if (Number(job.status) === AC_JOB_STATUS_EXPIRED) {
          reconcileExpiredEscrowCandidates.push(jobId.toString());
          if (!dryRun) await dispatch("reconcileExpiredEscrow", jobId, "reconcileExpiredEscrow");
        }
      } catch { /* AC read failed - skip, try again next run */ }
    }
  }

  return NextResponse.json({
    dryRun,
    scanned: total.toString(),
    keeper: account.address,
    expireCandidates,
    autoApproveCandidates,
    finalizeRejectionCandidates,
    claimDefaultRulingCandidates,
    claimArbitratorTimeoutCandidates,
    reconcileExpiredEscrowCandidates,
    sent,
    failed,
  });
}

function errMsg(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 200);
}
