import { encodeFunctionData, type Address, type Hash } from "viem";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import type { Signer } from "./types.js";

export type CircleWalletConfig = {
  /** Circle API key (Circle Console → Testnet/Mainnet → API Keys → API Key, Standard). */
  apiKey: string;
  /** Registered entity secret — see docs/circle-wallet.md. Controls every wallet under this API key. */
  entitySecret: string;
  /** Circle wallet ID (from `createWallets`/`listWallets`), not the on-chain address. */
  walletId: string;
  /** The wallet's on-chain address — fetch once via `getWallet({ id })` and store it; avoids an extra round-trip on every agent startup. */
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
  private readonly client: ReturnType<typeof initiateDeveloperControlledWalletsClient>;
  private readonly walletId: string;

  constructor(config: CircleWalletConfig) {
    this.address = config.address;
    this.walletId = config.walletId;
    this.client = initiateDeveloperControlledWalletsClient({
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
