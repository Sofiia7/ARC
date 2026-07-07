import { NextRequest, NextResponse } from "next/server";
import { clientKey, consumeAsync } from "@/lib/rate-limit";
import { reportEvent } from "@/lib/observe";
import { verifyWalletAuth } from "@/lib/wallet-auth";

export const runtime = "nodejs";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB
// Wallet-scoped: see pin/route.ts for why this alone isn't sufficient — wallet
// creation is free, so a determined attacker isn't bounded by this bucket.
const WALLET_RATE = { capacity: 5, refillPerSecond: 5 / 60 }; // 5 uploads / min per wallet
// IP-only: independent dimension that catches many-wallets-one-IP abuse.
const IP_RATE = { capacity: 15, refillPerSecond: 15 / 60 }; // 15 uploads / min per IP, any wallet
// Daily volume cap per wallet — bounds sustained abuse paced under the
// per-minute limits (25 MB files x a handful/day would otherwise be legal).
const DAILY_BYTES_PER_WALLET = 100 * 1024 * 1024; // 100 MB / day
const DAILY_RATE = { capacity: DAILY_BYTES_PER_WALLET, refillPerSecond: DAILY_BYTES_PER_WALLET / 86_400 };

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

// Client-supplied Content-Type is trivially spoofable (it's just a form-field
// value), so isAllowedMime() alone is advisory. This checks the actual first
// bytes against well-known executable/script signatures regardless of the
// declared MIME type — a coarse denylist, not a full file-type sniffer.
function looksExecutable(bytes: Uint8Array): boolean {
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) return true; // MZ (PE/DOS)
  if (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) return true; // \x7fELF
  if (bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21) return true; // #! shebang
  if (bytes.length >= 4) {
    const magic = (bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!;
    // Mach-O (32/64-bit, either endianness) + universal binary ("fat" Mach-O).
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic >>> 0)) return true;
  }
  return false;
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

  // Both dimensions must pass — see pin/route.ts for the rationale.
  const [walletRl, ipRl] = await Promise.all([
    consumeAsync(`pin-file:wallet:${wallet}`, WALLET_RATE),
    consumeAsync(`pin-file:ip:${ip}`, IP_RATE),
  ]);
  const rl = !walletRl.ok ? walletRl : ipRl;
  if (!walletRl.ok || !ipRl.ok) {
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

  const dailyRl = await consumeAsync(`pin-file:daily:${wallet}`, DAILY_RATE, file.size);
  if (!dailyRl.ok) {
    return NextResponse.json(
      { error: `Daily pin volume exceeded (${DAILY_BYTES_PER_WALLET} bytes/day per wallet)` },
      { status: 429, headers: { "Retry-After": String(dailyRl.retryAfterSec) } },
    );
  }

  const mime = file.type || "application/octet-stream";
  if (!isAllowedMime(mime)) {
    return NextResponse.json({ error: `unsupported content type: ${mime}` }, { status: 415 });
  }

  const headBuf = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (looksExecutable(headBuf)) {
    return NextResponse.json({ error: "file content looks like an executable — rejected" }, { status: 415 });
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
