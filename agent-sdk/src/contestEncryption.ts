import sodium from "libsodium-wrappers";

export type ContestEncryptionKeypair = { publicKey: string; privateKey: string };
export type EncryptedContestEntry = {
  version: 1;
  algorithm: "x25519-xsalsa20-poly1305-sealedbox";
  recipientPublicKey: string;
  ciphertext: string;
};
const MAX_ENTRY_BYTES = 1_000_000;

/** Generate once and retain the private key securely; publish only publicKey. */
export async function generateContestKeypair(): Promise<ContestEncryptionKeypair> {
  await sodium.ready;
  const key = sodium.crypto_box_keypair();
  return { publicKey: sodium.to_base64(key.publicKey), privateKey: sodium.to_base64(key.privateKey) };
}

/** Seed is a private, uniformly random 32-byte value (or a suitably derived PRF key). */
export async function contestKeypairFromSeed(seed: Uint8Array): Promise<ContestEncryptionKeypair> {
  await sodium.ready;
  if (seed.length !== sodium.crypto_box_SEEDBYTES) throw new Error("Contest seed must be 32 bytes");
  const key = sodium.crypto_box_seed_keypair(seed);
  return { publicKey: sodium.to_base64(key.publicKey), privateKey: sodium.to_base64(key.privateKey) };
}

/** Derive locally from private PRF/signature bytes. Never publish that input. */
export async function deriveContestKeypair(secret: Uint8Array, context: string): Promise<ContestEncryptionKeypair> {
  if (secret.length < 32 || !context.trim()) throw new Error("Private key material and a nonempty context are required");
  const key = await globalThis.crypto.subtle.importKey("raw", new Uint8Array(secret), "HKDF", false, ["deriveBits"]);
  const seed = new Uint8Array(await globalThis.crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256",
    salt: new TextEncoder().encode("NadBounty contest encryption v1"),
    info: new TextEncoder().encode(context),
  }, key, 256));
  try { return await contestKeypairFromSeed(seed); } finally { seed.fill(0); }
}

export async function encryptContestEntry(plaintext: string, recipientPublicKey: string): Promise<EncryptedContestEntry> {
  await sodium.ready;
  const bytes = sodium.from_string(plaintext);
  if (!bytes.length || bytes.length > MAX_ENTRY_BYTES) throw new Error("Entry must contain 1 to 1,000,000 UTF-8 bytes");
  const publicKey = sodium.from_base64(recipientPublicKey);
  if (publicKey.length !== sodium.crypto_box_PUBLICKEYBYTES) throw new Error("Invalid poster public key");
  return { version: 1, algorithm: "x25519-xsalsa20-poly1305-sealedbox", recipientPublicKey,
    ciphertext: sodium.to_base64(sodium.crypto_box_seal(bytes, publicKey)) };
}

export async function decryptContestEntry(entry: EncryptedContestEntry, key: ContestEncryptionKeypair): Promise<string> {
  await sodium.ready;
  if (entry.version !== 1 || entry.algorithm !== "x25519-xsalsa20-poly1305-sealedbox") throw new Error("Unsupported entry encryption");
  const publicKey = sodium.from_base64(key.publicKey), privateKey = sodium.from_base64(key.privateKey);
  if (publicKey.length !== sodium.crypto_box_PUBLICKEYBYTES || privateKey.length !== sodium.crypto_box_SECRETKEYBYTES) throw new Error("Invalid poster keypair");
  const recipient = sodium.from_base64(entry.recipientPublicKey);
  if (!sodium.memcmp(publicKey, recipient)) throw new Error("Entry belongs to a different poster key");
  // Reject oversized input before decoding/allocating its binary representation.
  if (entry.ciphertext.length > 1_400_100) throw new Error("Encrypted entry is too large");
  const ciphertext = sodium.from_base64(entry.ciphertext);
  if (ciphertext.length <= sodium.crypto_box_SEALBYTES || ciphertext.length > MAX_ENTRY_BYTES + sodium.crypto_box_SEALBYTES) throw new Error("Invalid encrypted entry size");
  try {
    const plaintext = sodium.crypto_box_seal_open(ciphertext, publicKey, privateKey);
    if (!plaintext) throw new Error("Invalid ciphertext");
    return sodium.to_string(plaintext);
  } catch { throw new Error("Cannot decrypt entry: wrong key or modified ciphertext"); }
  finally { privateKey.fill(0); }
}
