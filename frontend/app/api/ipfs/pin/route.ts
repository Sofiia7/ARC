import { NextRequest, NextResponse } from "next/server";
import { clientKey, consumeAsync } from "@/lib/rate-limit";
import { reportEvent } from "@/lib/observe";
import { verifyWalletAuth } from "@/lib/wallet-auth";
import { fetchIpfsServerCached } from "@/lib/ipfsServer";

export const runtime = "nodejs";

const MAX_TEXT_BYTES = 1 * 1024 * 1024; // 1 MB
// Wallet-scoped: generous enough for a real user. Wallet creation is free, so
// this alone doesn't bound a determined attacker - the IP-only bucket below
// is what actually caps "spin up N wallets from one machine" abuse.
const WALLET_RATE = { capacity: 10, refillPerSecond: 10 / 60 }; // 10 / min per wallet
// IP-only: independent of wallet identity, catches many-wallets-one-IP abuse
// that a wallet-only bucket can't see (a fresh EOA always starts with a full
// wallet bucket).
const IP_RATE = { capacity: 20, refillPerSecond: 20 / 60 }; // 20 / min per IP, any wallet
// Daily volume cap per wallet - bounds sustained abuse even from a client
// that paces requests just under the per-minute limits.
const DAILY_BYTES_PER_WALLET = 20 * 1024 * 1024; // 20 MB / day
const DAILY_RATE = { capacity: DAILY_BYTES_PER_WALLET, refillPerSecond: DAILY_BYTES_PER_WALLET / 86_400 };

function tooBig(s: string): boolean {
  return new TextEncoder().encode(s).byteLength > MAX_TEXT_BYTES;
}

export async function POST(req: NextRequest) {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    return NextResponse.json({ error: "IPFS not configured: PINATA_JWT missing" }, { status: 503 });
  }

  const ip = clientKey(req);

  // IP check FIRST, before signature verification: verifyWalletAuth() falls
  // back to an on-chain eth_call for ERC-1271 smart-account addresses (e.g.
  // Porto passkey wallets) even when the signature is garbage - so an
  // unthrottled flood of bogus-signature requests could still burn RPC quota
  // if this ran after auth. This bucket alone isn't the abuse bound (see
  // WALLET_RATE below, checked post-auth) - it's just cheap enough to gate
  // the expensive path first.
  const ipRl = await consumeAsync(`pin:ip:${ip}`, IP_RATE);
  if (!ipRl.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(ipRl.retryAfterSec) } },
    );
  }

  const auth = await verifyWalletAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const wallet = auth.address.toLowerCase();

  // Wallet-scoped, checked after auth succeeds - see WALLET_RATE above for
  // why this alone isn't sufficient (wallet creation is free).
  const walletRl = await consumeAsync(`pin:wallet:${wallet}`, WALLET_RATE);
  if (!walletRl.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(walletRl.retryAfterSec) } },
    );
  }

  let content: string;
  try {
    const body = await req.json() as { content?: unknown };
    if (!body.content || typeof body.content !== "string") {
      return NextResponse.json({ error: "content required (string)" }, { status: 400 });
    }
    content = body.content;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (tooBig(content)) {
    return NextResponse.json({ error: `content exceeds ${MAX_TEXT_BYTES} bytes` }, { status: 413 });
  }

  const byteLength = new TextEncoder().encode(content).byteLength;
  const dailyRl = await consumeAsync(`pin:daily:${wallet}`, DAILY_RATE, byteLength);
  if (!dailyRl.ok) {
    return NextResponse.json(
      { error: `Daily pin volume exceeded (${DAILY_BYTES_PER_WALLET} bytes/day per wallet)` },
      { status: 429, headers: { "Retry-After": String(dailyRl.retryAfterSec) } },
    );
  }

  const blob = new Blob([content], { type: "text/plain" });
  const form = new FormData();
  form.append("file", blob, "content.md");

  // v2 pinning API - JWT scoped for `pinFileToIPFS` authenticates via Bearer.
  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "unknown");
    reportEvent("ipfs.pin", `Pinata error ${res.status}`, "error", { status: res.status, body: errText.slice(0, 500) });
    return NextResponse.json({ error: `Pinata error: ${res.status}` }, { status: 502 });
  }

  const data = await res.json() as { IpfsHash: string };

  // Warm the read cache now, while the poster is already waiting on this
  // request, so the FIRST person to view this bounty never pays gateway
  // latency either - not just the second one. Best-effort: Pinata's own
  // gateway (first in the race) usually serves what it just stored
  // immediately, but if every gateway is slow this just no-ops and the
  // normal /api/ipfs/read race handles it on first view instead.
  await fetchIpfsServerCached(data.IpfsHash).catch(() => {});

  return NextResponse.json({ cid: data.IpfsHash });
}
