import { createRequire } from "node:module";
import { encodeFunctionData, type Address, type Hash } from "viem";
import type { initiateDeveloperControlledWalletsClient as InitCircleClient } from "@circle-fin/developer-controlled-wallets";
import type { Signer } from "./types.js";

/**
 * Loaded through `require`, and only when a Circle wallet is actually used.
 *
 * `@circle-fin/developer-controlled-wallets` is CommonJS. A static
 * `import { initiateDeveloperControlledWalletsClient } from "..."` in the ESM
 * build asks Node to resolve a *named* export from a CJS module, which
 * cjs-module-lexer cannot always detect statically - and when it cannot, the
 * failure is a SyntaxError at import time, before any of this module's code
 * runs. That took down every consumer of the ESM build on Vercel's runtime,
 * including callers that never touch Circle wallets at all: importing the SDK
 * was enough. `require` performs the same resolution at call time and is
 * immune, and the `import type` above keeps full typing with no runtime cost.
 */
function loadCircleClient(): typeof InitCircleClient {
  const require = createRequire(import.meta.url);
  const mod = require("@circle-fin/developer-controlled-wallets") as {
    initiateDeveloperControlledWalletsClient?: typeof InitCircleClient;
    default?: { initiateDeveloperControlledWalletsClient?: typeof InitCircleClient };
  };
  const init = mod.initiateDeveloperControlledWalletsClient ?? mod.default?.initiateDeveloperControlledWalletsClient;
  if (!init) {
    throw new Error(
      "arcbounty-agent-sdk: @circle-fin/developer-controlled-wallets did not export " +
      "initiateDeveloperControlledWalletsClient - check the installed version.",
    );
  }
  return init;
}

export type CircleWalletConfig = {
  /** Circle API key (Circle Console → Testnet/Mainnet → API Keys → API Key, Standard). */
  apiKey: string;
  /** Registered entity secret - see docs/circle-wallet.md. Controls every wallet under this API key. */
  entitySecret: string;
  /** Circle wallet ID (from `createWallets`/`listWallets`), not the on-chain address. */
  walletId: string;
  /** The wallet's on-chain address - fetch once via `getWallet({ id })` and store it; avoids an extra round-trip on every agent startup. */
  address: Address;
  /** Override Circle's API base URL (defaults to https://api.circle.com). */
  baseUrl?: string;
};

/**
 * Signer backed by a Circle developer-controlled wallet (MPC custody, no raw
 * private key in this process). Every write is submitted as a contract
 * execution transaction and polled until it has an on-chain tx hash.
 */
export class CircleSigner implements Signer {
  readonly address: Address;
  private readonly client: ReturnType<typeof InitCircleClient>;
  private readonly walletId: string;

  constructor(config: CircleWalletConfig) {
    this.address = config.address;
    this.walletId = config.walletId;
    this.client = loadCircleClient()({
      apiKey: config.apiKey,
      entitySecret: config.entitySecret,
      baseUrl: config.baseUrl,
    });
  }

  async writeContract(params: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
    /** Ignored: Circle prices and submits the transaction itself. */
    gas?: bigint;
  }): Promise<Hash> {
    const callData = encodeFunctionData({
      abi: params.abi,
      functionName: params.functionName,
      args: params.args,
    } as Parameters<typeof encodeFunctionData>[0]);

    const created = await this.client.createContractExecutionTransaction({
      walletId: this.walletId,
      contractAddress: params.address,
      callData,
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });

    const txId = created.data?.id;
    if (!txId) {
      throw new Error("CircleSigner: createContractExecutionTransaction did not return a transaction id");
    }

    // EOA wallets get a txHash at SENT; SCA wallets only at CONFIRMED. Either
    // way, waitForTxHash polls until it exists or the tx hits a terminal
    // failure state (CANCELLED/DENIED/FAILED/STUCK), whichever comes first.
    const result = await this.client.getTransaction({ id: txId, waitForTxHash: true });
    return result.data.transaction.txHash as Hash;
  }
}
