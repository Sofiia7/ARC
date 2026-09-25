import { describe, it, expect } from "vitest";
import { recoverMessageAddress } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { base } from "viem/chains";
import { ViemSigner } from "../src/signers/viemSigner.js";

// A fresh throwaway key per run: nothing here may ever hold funds.
const KEY = generatePrivateKey();

describe("ViemSigner.signMessage", () => {
  it("signs a message that recovers to its own address, without touching the RPC", async () => {
    // An unroutable RPC: signing a message is local, so nothing may call it.
    const signer = new ViemSigner(KEY, base, "http://127.0.0.1:1");
    const signature = await signer.signMessage("ArcBounty IPFS pin");
    expect(await recoverMessageAddress({ message: "ArcBounty IPFS pin", signature })).toBe(signer.address);
  });
});
