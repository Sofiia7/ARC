import { NextRequest, NextResponse } from "next/server";
import {
  createPublicClient, createWalletClient, http, defineChain, type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Keeper cron — drives the contract's permissionless liveness paths so no human
// has to babysit the board:
//   • expireBounty(jobId)  — past deadline, no submission  → refund poster
//   • autoApprove(jobId)   — submitted, APPROVAL_TIMEOUT elapsed, poster ghosted → pay worker
//
// INERT BY DEFAULT. Activates only when KEEPER_PRIVATE_KEY is set. Wire it up in
// Vercel Cron (e.g. every 6h) and protect with CRON_SECRET. Until then this
// route is a safe no-op (503).
//
// Env:
//   KEEPER_PRIVATE_KEY   — funded wallet (ARC for gas). Send a low-value key.
//   CRON_SECRET          — Vercel sets `Authorization: Bearer <CRON_SECRET>`.
//   NEXT_PUBLIC_RPC_URL  — Arc RPC.
// Query:
//   ?dryRun=1            — list candidates without sending transactions.

const CHAIN_ID = 5042002;

// `allJobIds(uint256)` is a public array getter on the adapter but isn't in the
// shared ABI (the UI never enumerates the full set). The keeper does, so add it
// here locally.
const ALL_JOB_IDS_ABI = [{
  name: "allJobIds", type: "function", stateMutability: "view",
  inputs: [{ name: "", type: "uint256" }],
  outputs: [{ name: "", type: "uint256" }],
}] as const;

type Meta = {
  jobId: bigint; poster: Address; deadline: bigint;
  submittedResultHash: string; submittedAt: bigint;
  resolved: boolean; inDispute: boolean; rejectedAt: bigint; isTaken: boolean;
};

export async function GET(req: NextRequest) {
  // ── Auth ──
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const pk = process.env.KEEPER_PRIVATE_KEY;
  if (!pk) {
    return NextResponse.json(
      { error: "keeper not configured: KEEPER_PRIVATE_KEY missing (route inert)" },
      { status: 503 },
    );
  }

  const rpc = process.env.NEXT_PUBLIC_RPC_URL ?? "https://rpc.testnet.arc.network";
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const adapter = CONTRACTS.BOUNTY_ADAPTER;

  const chain = defineChain({
    id: CHAIN_ID, name: "Arc Testnet",
    nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 6 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const account = privateKeyToAccount(pk as `0x${string}`);
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });

  const now = BigInt(Math.floor(Date.now() / 1000));

  const [total, approvalTimeout] = await Promise.all([
    pub.readContract({ address: adapter, abi: BOUNTY_ADAPTER_ABI, functionName: "totalBounties" }) as Promise<bigint>,
    pub.readContract({ address: adapter, abi: BOUNTY_ADAPTER_ABI, functionName: "APPROVAL_TIMEOUT" }) as Promise<bigint>,
  ]);

  const expireCandidates: string[] = [];
  const autoApproveCandidates: string[] = [];
  const sent: { action: string; jobId: string; hash: string }[] = [];
  const failed: { action: string; jobId: string; error: string }[] = [];

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
      if (!dryRun) {
        try {
          const hash = await wallet.writeContract({
            address: adapter, abi: BOUNTY_ADAPTER_ABI, functionName: "expireBounty",
            args: [jobId], chain, account,
          });
          sent.push({ action: "expire", jobId: jobId.toString(), hash });
        } catch (e) {
          failed.push({ action: "expire", jobId: jobId.toString(), error: errMsg(e) });
        }
      }
      continue;
    }

    // autoApprove: submitted, not disputed/rejected, approval window elapsed.
    if (hasSubmission && !m.inDispute && m.rejectedAt === 0n && now > m.submittedAt + approvalTimeout) {
      autoApproveCandidates.push(jobId.toString());
      if (!dryRun) {
        try {
          const hash = await wallet.writeContract({
            address: adapter, abi: BOUNTY_ADAPTER_ABI, functionName: "autoApprove",
            args: [jobId], chain, account,
          });
          sent.push({ action: "autoApprove", jobId: jobId.toString(), hash });
        } catch (e) {
          failed.push({ action: "autoApprove", jobId: jobId.toString(), error: errMsg(e) });
        }
      }
    }
  }

  return NextResponse.json({
    dryRun,
    scanned: total.toString(),
    keeper: account.address,
    expireCandidates,
    autoApproveCandidates,
    sent,
    failed,
  });
}

function errMsg(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 200);
}
