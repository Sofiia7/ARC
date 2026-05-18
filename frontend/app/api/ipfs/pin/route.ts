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
  // Pinata v3 Files API defaults to PRIVATE storage; explicitly opt into the
  // public IPFS network so the CID is resolvable via every public gateway.
  form.append("network", "public");

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
