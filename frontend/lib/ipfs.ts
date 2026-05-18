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
  for (const gateway of GATEWAYS) {
    try {
      const res = await fetch(`${gateway}${cid}`, { next: { revalidate: 3600 } });
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

export type PinnedFile = {
  uri: string;          // ipfs://<cid>
  cid: string;
  name: string;
  mimeType: string;
  size: number;
};

export async function pinFile(file: File): Promise<PinnedFile> {
  const form = new FormData();
  form.append("file", file, file.name);
  const res = await fetch("/api/ipfs/pin-file", { method: "POST", body: form });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed to pin file" }));
    throw new Error(err.error || "Failed to pin file");
  }
  const data = await res.json() as { cid: string; name: string; mimeType: string; size: number };
  return { uri: `ipfs://${data.cid}`, ...data };
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

export function markdownForPinnedFile(f: PinnedFile): string {
  if (isImageMime(f.mimeType)) {
    return `![${f.name}](${f.uri})`;
  }
  return `[${f.name}](${f.uri})`;
}
