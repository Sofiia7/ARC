/// Public IPFS gateways, tried in order. cloudflare-ipfs.com was retired in 2024,
/// so we use ipfs.io as the primary fallback and dweb.link as a secondary one.
const GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://nftstorage.link/ipfs/",
];

function cidFromUri(uriOrCid: string): string {
  return uriOrCid.replace(/^ipfs:\/\//, "");
}

export function ipfsUrl(uriOrCid: string, gatewayIndex = 0): string {
  const cid = cidFromUri(uriOrCid);
  const gateway = GATEWAYS[gatewayIndex % GATEWAYS.length];
  return `${gateway}${cid}`;
}

export async function fetchIpfsText(uriOrCid: string): Promise<string> {
  const cid = cidFromUri(uriOrCid);
  // Per-gateway timeout so a slow gateway doesn't block the chain.
  for (const gateway of GATEWAYS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(`${gateway}${cid}`, {
        signal: ctrl.signal,
        next: { revalidate: 3600 },
      });
      clearTimeout(t);
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

export async function pinText(content: string): Promise<string> {
  const res = await fetch("/api/ipfs/pin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error("Failed to pin to IPFS");
  const data = await res.json() as { cid: string };
  return `ipfs://${data.cid}`;
}

export async function pinJson(obj: unknown): Promise<string> {
  return pinText(JSON.stringify(obj, null, 2));
}
