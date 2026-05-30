import { NextRequest, NextResponse } from "next/server";
import { clientKey, consume } from "@/lib/rate-limit";
import { reportEvent } from "@/lib/observe";

export const runtime = "nodejs";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB
const RATE = { capacity: 5, refillPerSecond: 5 / 60 }; // 5 file uploads / min

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

  const rl = consume(`pin-file:${clientKey(req)}`, RATE);
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
  form.append("network", "public");

  const res = await fetch("https://uploads.pinata.cloud/v3/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "unknown");
    reportEvent("ipfs.pin-file", `Pinata error ${res.status}`, "error", { status: res.status, body: errText.slice(0, 500) });
    return NextResponse.json({ error: `Pinata error: ${res.status}` }, { status: 502 });
  }

  const data = await res.json() as {
    data: { cid: string; mime_type?: string; size?: number; name?: string };
  };
  return NextResponse.json({
    cid:      data.data.cid,
    name:     data.data.name ?? name,
    mimeType: data.data.mime_type ?? mime,
    size:     data.data.size ?? file.size,
  });
}
