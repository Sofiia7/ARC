import { all as portoChains } from "porto/core/Chains";
import { getActiveNetwork } from "./networks";

/**
 * True when "Sign in with passkey" can work on this build's chain.
 *
 * The passkey account is Porto, and Porto only runs on the chains its SDK and
 * relay list (Ethereum, Base, Optimism, Arbitrum and a few more). Arc is not
 * one of them: on arcbounty.app the button opened nothing at all. Builds on a
 * chain Porto does not list neither offer the connector nor mention passkeys.
 */
export function isPasskeySupported(): boolean {
  const { chainId } = getActiveNetwork();
  return portoChains.some(chain => chain.id === chainId);
}
