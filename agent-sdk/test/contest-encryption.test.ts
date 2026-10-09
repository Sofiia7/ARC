import { describe, it, expect } from "vitest";
import sodium from "libsodium-wrappers";
import { generateContestKeypair, contestKeypairFromSeed, deriveContestKeypair, encryptContestEntry, decryptContestEntry } from "../src/contestEncryption.js";

describe("contest sealed boxes", () => {
  it("only the poster can decrypt Unicode results and encrypting twice is randomized", async () => {
    const poster = await generateContestKeypair();
    const other = await generateContestKeypair();
    const text = "Результат 🟣\nhttps://example.com/work";
    const first = await encryptContestEntry(text, poster.publicKey);
    const second = await encryptContestEntry(text, poster.publicKey);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(await decryptContestEntry(first, poster)).toBe(text);
    await expect(decryptContestEntry(first, other)).rejects.toThrow("different poster");
    await expect(decryptContestEntry(first, { publicKey: poster.publicKey, privateKey: other.privateKey })).rejects.toThrow("Cannot decrypt");
  });
  it("authenticates ciphertext and rejects truncation and unsupported envelopes", async () => {
    const key = await generateContestKeypair();
    const entry = await encryptContestEntry("private entry", key.publicKey);
    await sodium.ready;
    const bytes = sodium.from_base64(entry.ciphertext); bytes[bytes.length - 1] ^= 1;
    await expect(decryptContestEntry({ ...entry, ciphertext: sodium.to_base64(bytes) }, key)).rejects.toThrow("Cannot decrypt");
    await expect(decryptContestEntry({ ...entry, ciphertext: "AA" }, key)).rejects.toThrow("size");
    await expect(decryptContestEntry({ ...entry, version: 2 } as never, key)).rejects.toThrow("Unsupported");
  });
  it("bounds plaintext and key sizes", async () => {
    const key = await generateContestKeypair();
    await expect(encryptContestEntry("", key.publicKey)).rejects.toThrow("1 to");
    await expect(encryptContestEntry("x".repeat(1_000_001), key.publicKey)).rejects.toThrow("1 to");
    await expect(encryptContestEntry("result", "AA")).rejects.toThrow("public key");
    await expect(contestKeypairFromSeed(new Uint8Array(31))).rejects.toThrow("32 bytes");
  });
  it("reconstructs a private key deterministically while separating contexts", async () => {
    const seed = new Uint8Array(32).fill(91);
    expect(await contestKeypairFromSeed(seed)).toEqual(await contestKeypairFromSeed(seed));
    const first = await deriveContestKeypair(seed, "eip155:143:poster:contest-1");
    expect(await deriveContestKeypair(seed, "eip155:143:poster:contest-1")).toEqual(first);
    expect((await deriveContestKeypair(seed, "eip155:10143:poster:contest-1")).publicKey).not.toBe(first.publicKey);
    expect(seed).toEqual(new Uint8Array(32).fill(91));
    await expect(deriveContestKeypair(seed, "")).rejects.toThrow("context");
  });
});
