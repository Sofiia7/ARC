import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

export async function POST(req: NextRequest) {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    return NextResponse.json({ error: "IPFS not configured: PINATA_JWT missing" }, { status: 503 });
  }

  const incoming = await req.formData();
  const file = incoming.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "file field required" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: `file exceeds ${MAX_BYTES} bytes` }, { status: 413 });
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
    console.error("Pinata file upload error:", res.status, errText);
    return NextResponse.json({ error: `Pinata error: ${res.status}` }, { status: 502 });
  }

  const data = await res.json() as { data: { cid: string; mime_type?: string; size?: number; name?: string } };
  return NextResponse.json({
    cid: data.data.cid,
    name: data.data.name ?? name,
    mimeType: data.data.mime_type ?? (file.type || "application/octet-stream"),
    size: data.data.size ?? file.size,
  });
}
