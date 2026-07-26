"use client";

import { useState } from "react";

const ARC_TESTNET_PARAMS = {
  chainId: "0x4CEF52", // 5042002
  chainName: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 6 },
  rpcUrls: ["https://rpc.testnet.arc.network"],
  blockExplorerUrls: ["https://testnet.arcscan.app"],
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
      await injected.request({ method: "wallet_addEthereumChain", params: [ARC_TESTNET_PARAMS] });
      setState("done");
    } catch {
      // User declined, or the wallet already has it — either way there's
      // nothing to recover from, and the manual values are right below.
      setState("idle");
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <button type="button" className="btn btn-primary" onClick={add} disabled={state === "pending"}>
        {state === "pending" ? "Check your wallet…" : state === "done" ? "Network added ✓" : "Add Arc Testnet to my wallet"}
      </button>
      {state === "unavailable" && (
        <span style={{ fontSize: 13, color: "var(--ink-mute)" }}>
          No browser wallet detected — add it manually with the values below.
        </span>
      )}
    </div>
  );
}
