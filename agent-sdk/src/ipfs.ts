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

/** True iff Pinata creds are reachable in env. Cheap to call repeatedly. */
export function isPinningConfigured(): boolean {
  return Boolean(process.env["PINATA_JWT"] || (process.env["PINATA_API_KEY"] && process.env["PINATA_SECRET"]));
}

/**
 * Pin text content to IPFS via Pinata's v2 `pinFileToIPFS` API. Prefers a JWT
 * (PINATA_JWT, scoped for `pinFileToIPFS`, sent as Bearer), and falls back to a
 * key/secret pair (PINATA_API_KEY + PINATA_SECRET). Returns an `ipfs://<cid>` URI.
 *
 * Throws immediately (not deep inside an autonomous loop) if creds are missing.
 */
export async function pinText(content: string, filename = "result.md"): Promise<string> {
  const jwt       = process.env["PINATA_JWT"];
  const apiKey    = process.env["PINATA_API_KEY"];
  const apiSecret = process.env["PINATA_SECRET"];

  const blob = new Blob([content], { type: "text/plain" });

  if (jwt) {
    const form = new FormData();
    form.append("file", blob, filename);
    const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
      body: form,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Pinata v2 error ${res.status}: ${text}`);
    }
    const data = await res.json() as { IpfsHash: string };
    return `ipfs://${data.IpfsHash}`;
  }

  if (apiKey && apiSecret) {
    const form = new FormData();
    form.append("file", blob, filename);
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
      throw new Error(`Pinata v1 error ${res.status}: ${text}`);
    }
    const data = await res.json() as { IpfsHash: string };
    return `ipfs://${data.IpfsHash}`;
  }

  throw new Error("Set PINATA_JWT (preferred) or PINATA_API_KEY + PINATA_SECRET to pin to IPFS");
}
