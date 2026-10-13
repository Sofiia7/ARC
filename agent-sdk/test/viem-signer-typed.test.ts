import { describe, it, expect } from "vitest";
import { recoverTypedDataAddress } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { ViemSigner } from "../src/signers/viemSigner.js";
import { agentWalletTypedData } from "../src/nadIdentity.js";
import { MONAD_NETWORKS } from "../src/constants.js";

// A fresh throwaway key per run: nothing here may ever hold funds.
const KEY = generatePrivateKey();
const monad = {
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:1"] } },
};

describe("ViemSigner.signTypedData", () => {
  it("signs the registry's AgentWalletSet consent locally, recoverable to its own address", async () => {
    // An unroutable RPC: typed-data signing is local, so nothing may call it.
    const signer = new ViemSigner(KEY, monad, "http://127.0.0.1:1");
    const typed = agentWalletTypedData({
      chainId: 143,
      registry: MONAD_NETWORKS["monad-mainnet"].identity,
      agentId: 10388n,
      newWallet: signer.address,
      owner: "0x4076F0Ccc2E8c0B94002cAdeDE0186D064EA95e6",
      deadline: 1_800_000_300n,
    });
    const signature = await signer.signTypedData(typed);
    expect(await recoverTypedDataAddress({ ...typed, signature })).toBe(signer.address);
  });
});
