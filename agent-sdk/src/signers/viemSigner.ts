import { createWalletClient, http, type Address, type Chain, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Signer } from "./types.js";

/** Default signer: a local private key, signed and broadcast via viem. */
export class ViemSigner implements Signer {
  readonly address: Address;
  private readonly walletClient;
  private readonly account: ReturnType<typeof privateKeyToAccount>;

  constructor(privateKey: `0x${string}`, chain: Chain, rpcUrl: string) {
    this.account = privateKeyToAccount(privateKey);
    this.address = this.account.address;
    this.walletClient = createWalletClient({ account: this.account, chain, transport: http(rpcUrl) });
  }

  async writeContract(params: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }): Promise<Hash> {
    return this.walletClient.writeContract({
      address: params.address,
      abi: params.abi as never,
      functionName: params.functionName as never,
      args: params.args as never,
      chain: null,
      account: this.account,
    });
  }
}
