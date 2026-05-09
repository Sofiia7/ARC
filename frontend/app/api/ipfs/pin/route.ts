import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { content } = await req.json() as { content: string };

  if (!content || typeof content !== "string") {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }

  const jwt = process.env.PINATA_JWT;

  if (!jwt) {
    return NextResponse.json({ error: "IPFS not configured: PINATA_JWT missing" }, { status: 503 });
  }

  const blob = new Blob([content], { type: "text/plain" });
  const form = new FormData();
  form.append("file", blob, "content.md");

  const res = await fetch("https://uploads.pinata.cloud/v3/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
    },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "unknown");
    console.error("Pinata error:", res.status, errText);
    return NextResponse.json({ error: `Pinata error: ${res.status}` }, { status: 502 });
  }

  const data = await res.json() as { data: { cid: string } };
  return NextResponse.json({ cid: data.data.cid });
}
