import { createPublicClient, http, isAddress, type Address, type Hex } from "viem";
import { arcTestnet } from "./wagmi";

// ─── Lightweight wallet-signature auth for the IPFS pin routes ────────────────
//
// M5 hardening: /api/ipfs/pin and /pin-file were open to any anonymous caller
// with only an in-memory per-IP rate limit — trivially abusable to burn the
// Pinata quota or pin arbitrary (including illegal) content under our
// account. Requiring a wallet signature raises the cost of abuse from "any
// HTTP client" to "must control a private key or SCA wallet", and gives us an
// address-keyed rate-limit dimension in addition to IP.
//
// This is deliberately NOT full EIP-4361 SIWE (no domain/nonce registry,
// no session). A signed, timestamped message with a short validity window is
// sufficient here: the goal is raising the cost of bulk abuse, not building a
// login system. A stolen signature is only replayable within the window and
// only lets someone pin content as if they were that address — it can't move
// funds or impersonate the address anywhere else.
//
// verifyMessage (viem) is used instead of a bare ecrecover so ERC-1271 smart
// accounts (Porto passkey-SCA) verify correctly too — it falls back to an
// on-chain eth_call for contract wallets, plain ecrecover for EOAs.

const MESSAGE_WINDOW_SEC = 5 * 60; // signature must be within 5 minutes of now

const verifyClient = createPublicClient({ chain: arcTestnet, transport: http() });

export function pinAuthMessage(address: Address, timestamp: number): string {
  return `ArcBounty IPFS pin\naddress: ${address}\ntimestamp: ${timestamp}`;
}

export type WalletAuthResult =
  | { ok: true; address: Address }
  | { ok: false; status: number; error: string };

export async function verifyWalletAuth(req: Request): Promise<WalletAuthResult> {
  const address = req.headers.get("x-arc-address");
  const signature = req.headers.get("x-arc-signature");
  const timestampRaw = req.headers.get("x-arc-timestamp");

  if (!address || !signature || !timestampRaw) {
    return { ok: false, status: 401, error: "missing wallet auth headers (x-arc-address/-signature/-timestamp)" };
  }
  if (!isAddress(address)) {
    return { ok: false, status: 401, error: "x-arc-address is not a valid address" };
  }

  const timestamp = Number(timestampRaw);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, status: 401, error: "x-arc-timestamp is not a number" };
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > MESSAGE_WINDOW_SEC) {
    return { ok: false, status: 401, error: "signed message expired — resign and retry" };
  }

  const message = pinAuthMessage(address, timestamp);
  try {
    const valid = await verifyClient.verifyMessage({
      address,
      message,
      signature: signature as Hex,
    });
    if (!valid) return { ok: false, status: 401, error: "invalid signature" };
  } catch {
    return { ok: false, status: 401, error: "signature verification failed" };
  }

  return { ok: true, address };
}
