"use client";

import { useAccount, useSwitchChain } from "wagmi";
import { getActiveNetwork } from "@/lib/networks";

const network = getActiveNetwork();

/** The one chain this build writes to. Pass it as `chainId` to every writeContractAsync. */
export const SITE_CHAIN_ID = network.chainId;

export class WrongChainError extends Error {
  constructor() {
    super(`Switch your wallet to ${network.name} (chain ${network.chainId}) and try again.`);
    this.name = "WrongChainError";
  }
}

/**
 * Puts the wallet on the site's chain before a write.
 *
 * wagmi sends a transaction to whatever chain the wallet is on unless it is
 * given a chainId, and useChainId() cannot see a chain the config does not
 * list: it keeps answering 5042 while MetaMask sits on Ethereum. The first
 * onboarding report (bounty #14, 2026-09-27) hit exactly that: Take was
 * prepared on Ethereum, for ETH. So the wallet itself is asked here, and the
 * write also carries `chainId: SITE_CHAIN_ID`, which makes a wallet that did
 * not switch fail loudly instead of sending the transaction somewhere else.
 */
export function useEnsureChain() {
  const { connector } = useAccount();
  const { switchChainAsync } = useSwitchChain();

  return async function ensureChain(): Promise<void> {
    const current = await connector?.getChainId();
    if (current === undefined || current === SITE_CHAIN_ID) return;
    try {
      // For a wallet that has never seen the chain, wagmi's injected
      // connector adds it first (wallet_addEthereumChain from lib/wagmi.ts).
      await switchChainAsync({ chainId: SITE_CHAIN_ID });
    } catch {
      throw new WrongChainError();
    }
  };
}
