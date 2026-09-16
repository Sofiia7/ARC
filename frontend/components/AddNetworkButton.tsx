"use client";

import { useState } from "react";
import { getActiveNetwork } from "@/lib/networks";

const network = getActiveNetwork();

const ADD_CHAIN_PARAMS = {
  chainId: `0x${network.chainId.toString(16)}`,
  chainName: network.name,
  // H-05: built from the active network's own nativeCurrency (lib/networks.ts)
  // instead of a hardcoded USDC entry. This button today only ever renders for
  // Arc (see needsWalletSetup below - Base wallets already have Base built
  // in), where USDC-as-native-currency happens to be correct, but a
  // hardcoded value here would silently be wrong the day a network with a
  // non-USDC native currency (e.g. Base, gas paid in ETH) reuses it.
  nativeCurrency: {
    name: network.nativeCurrency.isUsdc ? "USD Coin" : network.nativeCurrency.symbol,
    symbol: network.nativeCurrency.symbol,
    decimals: network.nativeCurrency.decimals,
  },
  rpcUrls: [network.rpcUrl],
  blockExplorerUrls: [network.explorerUrl],
};

type InjectedProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

/**
 * One click instead of six copied fields. Adding the network by hand is the
 * step where a first-time visitor gives up, and it happens before they ever
 * see a bounty.
 */
export function AddNetworkButton() {
  const [state, setState] = useState<"idle" | "pending" | "done" | "unavailable">("idle");

  async function add() {
    const injected = (window as unknown as { ethereum?: InjectedProvider }).ethereum;
    if (!injected) {
      setState("unavailable");
      return;
    }
    setState("pending");
    try {
      await injected.request({ method: "wallet_addEthereumChain", params: [ADD_CHAIN_PARAMS] });
      setState("done");
    } catch {
      // User declined, or the wallet already has it - either way there's
      // nothing to recover from, and the manual values are right below.
      setState("idle");
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <button type="button" className="btn btn-primary" onClick={add} disabled={state === "pending"}>
        {state === "pending" ? "Check your wallet…" : state === "done" ? "Network added ✓" : `Add ${network.name} to my wallet`}
      </button>
      {state === "unavailable" && (
        <span style={{ fontSize: 13, color: "var(--ink-mute)" }}>
          No browser wallet detected - add it manually with the values below.
        </span>
      )}
    </div>
  );
}
