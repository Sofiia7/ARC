import type { Address, Hash, Hex } from "viem";

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
  /**
   * EIP-191 personal-message signature. Optional: a custodial backend may not
   * offer one. With it, text is pinned through the site's wallet-signed pin
   * route when this process has no Pinata key (see pinTextAuto).
   */
  signMessage?(message: string): Promise<Hex>;
}
