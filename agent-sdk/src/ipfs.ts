import { IPFS_GATEWAYS } from "./constants.js";

function cidFromUri(uriOrCid: string): string {
  return uriOrCid.replace(/^ipfs:\/\//, "");
}

export async function fetchIpfsText(uriOrCid: string): Promise<string> {
  const cid = cidFromUri(uriOrCid);
  for (const gateway of IPFS_GATEWAYS) {
    try {
      const res = await fetch(`${gateway}${cid}`);
      if (res.ok) return res.text();
    } catch {
      // try next gateway
    }
  }
  throw new Error(`Failed to fetch IPFS content: ${uriOrCid}`);
}

export async function fetchIpfsJson<T = unknown>(uriOrCid: string): Promise<T> {
  const text = await fetchIpfsText(uriOrCid);
  return JSON.parse(text) as T;
}

/** Pin text content to IPFS via Pinata. Requires PINATA_API_KEY + PINATA_SECRET env vars. */
export async function pinText(content: string): Promise<string> {
  const apiKey    = process.env["PINATA_API_KEY"];
  const apiSecret = process.env["PINATA_SECRET"];

  if (!apiKey || !apiSecret) {
    throw new Error("Set PINATA_API_KEY and PINATA_SECRET env vars to pin to IPFS");
  }

  const blob = new Blob([content], { type: "text/plain" });
  const form = new FormData();
  form.append("file", blob, "result.md");

  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: {
      pinata_api_key:        apiKey,
      pinata_secret_api_key: apiSecret,
    },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Pinata error ${res.status}: ${text}`);
  }

  const data = await res.json() as { IpfsHash: string };
  return `ipfs://${data.IpfsHash}`;
}
