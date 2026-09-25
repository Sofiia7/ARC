import type { Address, Hex } from "viem";
import { IPFS_GATEWAYS } from "./constants.js";

function cidFromUri(uriOrCid: string): string {
  return uriOrCid.replace(/^ipfs:\/\//, "");
}

/** Per-gateway request timeout (V4.7, M-05). A hanging gateway used to stall
 *  every other gateway in the same round behind it, since they were tried
 *  strictly one after another with no timeout at all. */
const GATEWAY_TIMEOUT_MS = 8_000;

/** Hard cap on a single gateway response (V4.7, M-05). Bounty descriptions
 *  and result hashes are small text/JSON documents, not arbitrary files -
 *  10 MB is generous headroom, not a target. Enforced against actual bytes
 *  read, not just a (spoofable, sometimes absent) Content-Length header. */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

async function fetchOneGateway(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`gateway responded ${res.status}`);

    const declaredLength = res.headers.get("content-length");
    if (declaredLength && Number(declaredLength) > MAX_RESPONSE_BYTES) {
      throw new Error(`response declares ${declaredLength} bytes, exceeding the ${MAX_RESPONSE_BYTES}-byte cap`);
    }

    const reader = res.body?.getReader();
    if (!reader) return await res.text(); // no streaming body available - fall back, still timeout-guarded above

    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(`response exceeds the ${MAX_RESPONSE_BYTES}-byte cap`);
      }
      chunks.push(value);
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(combined);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read text back out of IPFS, racing every gateway within a round and
 * re-trying the whole list (with backoff) before giving up.
 *
 * The multi-round retry is not defensive padding. Content pinned seconds ago
 * is routinely unreachable through every public gateway at once while
 * providers propagate - measured on Base mainnet: a CID pinned weeks earlier
 * served 200 from ipfs.io while one pinned minutes earlier 504'd on all of
 * pinata/ipfs.io/cloudflare/dweb/w3s/4everland. A single pass therefore fails
 * exactly when a poster opens a submission right after the worker delivered
 * it, which reads as the worker having submitted nothing.
 *
 * V4.7 (M-05): gateways within a round are now raced concurrently (each with
 * its own timeout) rather than tried strictly one after another - previously
 * one hanging gateway (no timeout existed at all) stalled every other
 * gateway in the same round behind it.
 */
export async function fetchIpfsText(
  uriOrCid: string,
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string> {
  const cid      = cidFromUri(uriOrCid);
  const attempts = opts.attempts ?? 3;
  const delayMs  = opts.delayMs ?? 1_000;
  const sleep    = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));

  for (let round = 0; round < attempts; round++) {
    try {
      return await Promise.any(IPFS_GATEWAYS.map(gateway => fetchOneGateway(`${gateway}${cid}`)));
    } catch {
      // every gateway in this round failed (Promise.any rejects with an
      // AggregateError only once all of them have) - fall through to the
      // backoff and try the whole list again.
    }
    // Back off between rounds: propagation is the thing being waited on, and
    // hammering the same three gateways immediately does not help it along.
    if (round < attempts - 1) await sleep(delayMs * (round + 1));
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

// ─── Pinning through the site ────────────────────────────────────────────────
//
// pinText needs a Pinata key of its own, which an agent that only wants to
// post or deliver a bounty rarely has: every MCP write tool that pins failed
// without one. The web app already pins for any wallet that signs a short
// timestamped message (frontend/app/api/ipfs/pin, rate-limited per wallet and
// per IP), so an agent holding a key can come in through the same door.

/** IPFS is chain-agnostic, so one site's pin route serves every network. */
export const DEFAULT_PIN_URL = "https://arcbounty.app/api/ipfs/pin";

/** Anything that can prove it controls `address`; custodial signers may not. */
export type MessageSigner = {
  readonly address: Address;
  signMessage?: (message: string) => Promise<Hex>;
};

export type PinViaSiteOptions = {
  /** Defaults to ARCBOUNTY_PIN_URL, then {@link DEFAULT_PIN_URL}. */
  url?: string;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
};

/** The exact message the site's pin route verifies - `pinAuthMessage` in frontend/lib/wallet-auth.ts. */
export function pinAuthMessage(address: Address, timestamp: number): string {
  return `ArcBounty IPFS pin\naddress: ${address}\ntimestamp: ${timestamp}`;
}

/** Pin text through the site's pin route, authenticated by a wallet signature. */
export async function pinTextViaSite(
  content: string,
  signer: MessageSigner,
  opts: PinViaSiteOptions = {},
): Promise<string> {
  if (!signer.signMessage) throw new Error("This signer cannot sign messages, so it cannot pin through the site");
  const url = opts.url ?? process.env["ARCBOUNTY_PIN_URL"] ?? DEFAULT_PIN_URL;
  const fetchImpl = opts.fetchImpl ?? ((u: string, init: RequestInit) => fetch(u, init));
  const timestamp = Math.floor((opts.now ?? Date.now)() / 1000);
  const signature = await signer.signMessage(pinAuthMessage(signer.address, timestamp));

  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-arc-address": signer.address,
      "x-arc-signature": signature,
      "x-arc-timestamp": String(timestamp),
    },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      // not JSON - the status alone has to do
    }
    throw new Error(`Pinning through ${url} failed: ${res.status}${detail ? ` ${detail}` : ""}`);
  }
  const data = await res.json() as { cid?: string };
  if (!data.cid) throw new Error(`Pinning through ${url} returned no cid`);
  return `ipfs://${data.cid}`;
}

/** Pin with what this process has: its own Pinata credentials, else the site signed by `signer`. */
export async function pinTextAuto(
  content: string,
  signer: MessageSigner,
  opts: PinViaSiteOptions = {},
): Promise<string> {
  if (isPinningConfigured()) return pinText(content);
  if (signer.signMessage) return pinTextViaSite(content, signer, opts);
  throw new Error(
    "Cannot pin to IPFS: set PINATA_JWT (or PINATA_API_KEY + PINATA_SECRET), or use a signer that can " +
    "sign messages (a private key), so the text is pinned through the site.",
  );
}
