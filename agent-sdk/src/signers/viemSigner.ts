import { createWalletClient, createPublicClient, http, type Address, type Chain, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Signer } from "./types.js";

/** Default signer: a local private key, signed and broadcast via viem. */
export class ViemSigner implements Signer {
  readonly address: Address;
  private readonly walletClient;
  private readonly publicClient;
  private readonly account: ReturnType<typeof privateKeyToAccount>;

  constructor(privateKey: `0x${string}`, chain: Chain, rpcUrl: string) {
    this.account = privateKeyToAccount(privateKey);
    this.address = this.account.address;
    this.walletClient = createWalletClient({ account: this.account, chain, transport: http(rpcUrl) });
    this.publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  }

  async writeContract(params: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }): Promise<Hash> {
    // The nonce is the higher of `latest` and `pending`, because on a
    // load-balanced endpoint either tag can be the stale one and the failure
    // modes are opposite.
    //
    // Measured on Base's public endpoint, 2026-08-28. The same host answered
    // `latest=27` and `pending=24` seconds apart: viem builds from `pending` by
    // default, and a transaction on that spent nonce is accepted by
    // eth_sendRawTransaction, hands back a hash, and can never be included. It
    // just disappears, which is what happened to three writes on Base mainnet.
    // Switching to `latest` alone then produced the mirror image within the
    // hour - "nonce (31) is lower than the current nonce" on an approve issued
    // right after a submit, because that node's `latest` had not caught up with
    // a transaction it had already mined.
    //
    // Taking the maximum is right under both: a nonce that is too low is
    // fatal-and-silent, one that is too high only waits, and every write here
    // goes through _writeAdapter, which awaits its receipt before returning -
    // so there is never an in-flight transaction of ours that a too-high nonce
    // would strand.
    const [latest, pending] = await Promise.all([
      this.publicClient.getTransactionCount({ address: this.address, blockTag: "latest" }),
      this.publicClient.getTransactionCount({ address: this.address, blockTag: "pending" }),
    ]);
    const nonce = Math.max(latest, pending);

    return this.walletClient.writeContract({
      address: params.address,
      abi: params.abi as never,
      functionName: params.functionName as never,
      args: params.args as never,
      chain: null,
      account: this.account,
      nonce,
    });
  }
}
