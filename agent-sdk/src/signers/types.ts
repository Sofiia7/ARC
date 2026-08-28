import type { Address, Hash } from "viem";

/**
 * Signing backend for ArcBountyAgent's write path. `ViemSigner` (a raw private
 * key) and `CircleSigner` (a Circle developer-controlled wallet) both
 * implement this so every mutating method on ArcBountyAgent stays agnostic to
 * which one is in use.
 */
export interface Signer {
  readonly address: Address;
  writeContract(params: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
    /**
     * Explicit gas limit. Optional because a custodial backend prices its own
     * transactions; ViemSigner honours it. See ArcBountyAgent._writeAdapter for
     * why the caller, not the estimator, decides this.
     */
    gas?: bigint;
  }): Promise<Hash>;
}
