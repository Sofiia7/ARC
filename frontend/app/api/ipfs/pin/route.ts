import { NextRequest, NextResponse } from "next/server";
import { clientKey, consumeAsync } from "@/lib/rate-limit";
import { reportEvent } from "@/lib/observe";
import { verifyWalletAuth } from "@/lib/wallet-auth";

export const runtime = "nodejs";

const MAX_TEXT_BYTES = 1 * 1024 * 1024; // 1 MB
// Wallet-scoped: generous enough for a real user. Wallet creation is free, so
// this alone doesn't bound a determined attacker — the IP-only bucket below
// is what actually caps "spin up N wallets from one machine" abuse.
const WALLET_RATE = { capacity: 10, refillPerSecond: 10 / 60 }; // 10 / min per wallet
// IP-only: independent of wallet identity, catches many-wallets-one-IP abuse
// that a wallet-only bucket can't see (a fresh EOA always starts with a full
// wallet bucket).
const IP_RATE = { capacity: 20, refillPerSecond: 20 / 60 }; // 20 / min per IP, any wallet
// Daily volume cap per wallet — bounds sustained abuse even from a client
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

  const auth = await verifyWalletAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const wallet = auth.address.toLowerCase();
  const ip = clientKey(req);

  // Both dimensions must pass — a fresh wallet doesn't bypass the IP cap, and
  // rotating IPs (VPN) doesn't bypass the wallet cap.
  const [walletRl, ipRl] = await Promise.all([
    consumeAsync(`pin:wallet:${wallet}`, WALLET_RATE),
    consumeAsync(`pin:ip:${ip}`, IP_RATE),
  ]);
  const rl = !walletRl.ok ? walletRl : ipRl;
  if (!walletRl.ok || !ipRl.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
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

  // v2 pinning API — JWT scoped for `pinFileToIPFS` authenticates via Bearer.
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
  return NextResponse.json({ cid: data.IpfsHash });
}
