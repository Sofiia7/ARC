import { encryptContestEntry } from "./contestEncryption.js";
import { pinTextAuto, type MessageSigner, type PinViaSiteOptions } from "./ipfs.js";

/** The only contest cipher the site and the SDK speak. */
export const CONTEST_ENCRYPTION_ALGORITHM = "x25519-xsalsa20-poly1305-sealedbox" as const;

/**
 * Where a contest's private key comes from. The site decrypts entries itself only for
 * "wallet-signature-v1" (derived from a wallet signature) and "mera-prf-v1" (a passkey
 * PRF). Anything else, including the SDK default below, means the poster holds the key
 * and decrypts with `decryptContestEntry`.
 */
export type NadKeySource = "wallet-signature-v1" | "mera-prf-v1" | "sdk-keypair-v1" | (string & {});

export type NadContestEncryption = {
  version: 1;
  algorithm: typeof CONTEST_ENCRYPTION_ALGORITHM;
  /** X25519 public key, base64url without padding (43 characters). */
  publicKey: string;
  keySource: NadKeySource;
};

/**
 * The JSON document a bounty's `ipfsDescHash` points to. The same shape the
 * website writes in frontend/components/NadPost.tsx; the SDK and the site must agree on it.
 */
export type NadDescription = {
  version: 1;
  title: string;
  description: string;
  contestEncryption?: NadContestEncryption;
};

export type CreateDescriptionInput = {
  /** The task text (Markdown is fine). */
  description: string;
  /** Defaults to the first non-empty line of the description, cut to 120 characters (as the site does). */
  title?: string;
  /** Contests only: the poster's X25519 public key from `generateContestKeypair()`. */
  contestPublicKey?: string;
  /** Defaults to "sdk-keypair-v1": the site cannot decrypt, the poster keeps the private key. */
  keySource?: NadKeySource;
};

const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;

/** Build the description document. Pin its {@link serializeDescription} output, then pass the CID to createBounty. */
export function createDescription(input: CreateDescriptionInput): NadDescription {
  if (typeof input.description !== "string" || !input.description.trim()) {
    throw new Error("createDescription: description must be a non-empty string");
  }
  const firstLine = input.description.split("\n").find((line) => line.trim().length > 0) ?? "";
  const title = (input.title ?? firstLine.trim()).slice(0, 120);
  const result: NadDescription = { version: 1, title, description: input.description };
  if (input.contestPublicKey !== undefined) {
    if (!PUBLIC_KEY.test(input.contestPublicKey)) {
      throw new Error(
        "createDescription: contestPublicKey must be a 32-byte X25519 key as unpadded base64url " +
          "(43 characters), as returned by generateContestKeypair()",
      );
    }
    result.contestEncryption = {
      version: 1,
      algorithm: CONTEST_ENCRYPTION_ALGORITHM,
      publicKey: input.contestPublicKey,
      keySource: input.keySource ?? "sdk-keypair-v1",
    };
  } else if (input.keySource !== undefined) {
    throw new Error("createDescription: keySource only makes sense together with contestPublicKey");
  }
  return result;
}

/** The exact text to pin. */
export function serializeDescription(description: NadDescription): string {
  return JSON.stringify(description);
}

/** A description as read back from IPFS, tolerant of older and hand-written documents. */
export type ParsedNadDescription = {
  title: string;
  description: string;
  contestEncryption?: Partial<NadContestEncryption>;
  /** Legacy top-level key written by early demo scripts. */
  contestPublicKey?: string;
};

/** Parse a pinned description. Plain text (not JSON) is accepted as the description itself. */
export function parseNadDescription(text: string): ParsedNadDescription {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    const firstLine = text.split("\n").find((line) => line.trim().length > 0) ?? "";
    return { title: firstLine.trim().slice(0, 120), description: text };
  }
  const object = json as Record<string, unknown>;
  const description = typeof object["description"] === "string" ? object["description"] : "";
  const rawTitle = typeof object["title"] === "string" ? object["title"] : "";
  const parsed: ParsedNadDescription = {
    title: rawTitle || (description.split("\n").find((line) => line.trim().length > 0) ?? "").trim().slice(0, 120),
    description,
  };
  const encryption = object["contestEncryption"];
  if (encryption && typeof encryption === "object") {
    const e = encryption as Record<string, unknown>;
    parsed.contestEncryption = {
      ...(e["version"] === 1 ? { version: 1 as const } : {}),
      ...(e["algorithm"] === CONTEST_ENCRYPTION_ALGORITHM ? { algorithm: CONTEST_ENCRYPTION_ALGORITHM } : {}),
      ...(typeof e["publicKey"] === "string" ? { publicKey: e["publicKey"] } : {}),
      ...(typeof e["keySource"] === "string" ? { keySource: e["keySource"] } : {}),
    };
  }
  if (typeof object["contestPublicKey"] === "string") parsed.contestPublicKey = object["contestPublicKey"];
  return parsed;
}

/** The key entrants encrypt to: the same lookup the website performs. */
export function contestPublicKeyOf(description: ParsedNadDescription | NadDescription): string | undefined {
  return description.contestEncryption?.publicKey ?? (description as ParsedNadDescription).contestPublicKey;
}

/**
 * Encrypt a contest entry to the poster's public key and pin only the sealed
 * envelope. Returns the `ipfs://` URI to pass to `enterContest`. Never pass the
 * plaintext (or any private key) to a pin: the site and IPFS would see it.
 *
 * @param recipient the poster's public key, or the bounty's description (see `parseNadDescription`).
 */
export async function pinContestEntry(
  plaintext: string,
  recipient: string | ParsedNadDescription | NadDescription,
  signer: MessageSigner,
  options: PinViaSiteOptions = {},
): Promise<string> {
  const publicKey = typeof recipient === "string" ? recipient : contestPublicKeyOf(recipient);
  if (!publicKey) {
    throw new Error("This bounty's description has no contest encryption key, so it is not an encrypted contest");
  }
  const envelope = await encryptContestEntry(plaintext, publicKey);
  return pinTextAuto(JSON.stringify(envelope), signer, options);
}
