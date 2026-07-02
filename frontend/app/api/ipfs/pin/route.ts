import { NextRequest, NextResponse } from "next/server";
import { clientKey, consumeAsync } from "@/lib/rate-limit";
import { reportEvent } from "@/lib/observe";

export const runtime = "nodejs";

const MAX_TEXT_BYTES = 1 * 1024 * 1024; // 1 MB
const RATE = { capacity: 10, refillPerSecond: 10 / 60 }; // 10 / min, sustained

function tooBig(s: string): boolean {
  return new TextEncoder().encode(s).byteLength > MAX_TEXT_BYTES;
}

export async function POST(req: NextRequest) {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    return NextResponse.json({ error: "IPFS not configured: PINATA_JWT missing" }, { status: 503 });
  }

  const rl = await consumeAsync(`pin:${clientKey(req)}`, RATE);
  if (!rl.ok) {
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
