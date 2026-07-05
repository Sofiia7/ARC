import { getAccount, signMessage } from "wagmi/actions";
import { config } from "./wagmi";

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

// M5 hardening: the pin routes require a wallet signature (see
// frontend/lib/wallet-auth.ts for the server-side rationale). Signing costs
// the user one passkey/wallet prompt per pin, which is why callers should
// batch content into a single pinText/pinFile call rather than pinning in a
// tight loop.
async function signPinAuthHeaders(): Promise<Record<string, string>> {
  const account = getAccount(config);
  if (!account.isConnected || !account.address) {
    throw new Error("Connect a wallet before uploading to IPFS");
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const message = `ArcBounty IPFS pin\naddress: ${account.address}\ntimestamp: ${timestamp}`;
  const signature = await signMessage(config, { message });
  return {
    "x-arc-address": account.address,
    "x-arc-signature": signature,
    "x-arc-timestamp": String(timestamp),
  };
}

export async function pinText(content: string): Promise<string> {
  const authHeaders = await signPinAuthHeaders();
  const res = await fetch("/api/ipfs/pin", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
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
  const authHeaders = await signPinAuthHeaders();
  const form = new FormData();
  form.append("file", file, file.name);
  const res = await fetch("/api/ipfs/pin-file", { method: "POST", body: form, headers: authHeaders });
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
