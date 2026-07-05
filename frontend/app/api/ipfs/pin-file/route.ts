import { NextRequest, NextResponse } from "next/server";
import { clientKey, consumeAsync } from "@/lib/rate-limit";
import { reportEvent } from "@/lib/observe";
import { verifyWalletAuth } from "@/lib/wallet-auth";

export const runtime = "nodejs";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB
const RATE = { capacity: 5, refillPerSecond: 5 / 60 }; // 5 file uploads / min per wallet

const ALLOWED_MIME_PREFIXES = [
  "image/",
  "text/",
  "application/pdf",
  "application/json",
  "application/zip",
];

function isAllowedMime(mime: string): boolean {
  if (!mime) return false;
  // Block obvious executables outright.
  const denied = [
    "application/x-msdownload",
    "application/x-msdos-program",
    "application/x-executable",
    "application/x-sh",
    "application/x-shockwave-flash",
  ];
  if (denied.includes(mime)) return false;
  return ALLOWED_MIME_PREFIXES.some(p => mime === p || mime.startsWith(p));
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

  const rl = await consumeAsync(`pin-file:${auth.address.toLowerCase()}:${clientKey(req)}`, RATE);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  const incoming = await req.formData();
  const file = incoming.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "file field required" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: `file exceeds ${MAX_BYTES} bytes` }, { status: 413 });
  }

  const mime = file.type || "application/octet-stream";
  if (!isAllowedMime(mime)) {
    return NextResponse.json({ error: `unsupported content type: ${mime}` }, { status: 415 });
  }

  const name = (file as File).name || "upload.bin";

  const form = new FormData();
  form.append("file", file, name);

  // v2 pinning API — JWT scoped for `pinFileToIPFS` authenticates via Bearer.
  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "unknown");
    reportEvent("ipfs.pin-file", `Pinata error ${res.status}`, "error", { status: res.status, body: errText.slice(0, 500) });
    return NextResponse.json({ error: `Pinata error: ${res.status}` }, { status: 502 });
  }

  const data = await res.json() as { IpfsHash: string; PinSize?: number };
  return NextResponse.json({
    cid:      data.IpfsHash,
    name,
    mimeType: mime,
    size:     data.PinSize ?? file.size,
  });
}
