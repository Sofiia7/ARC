"use client";

import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { arcTestnet } from "@/lib/wagmi";

/// Persistent banner that surfaces when the connected wallet is on a different
/// chain than Arc Testnet. One click triggers a switchChain RPC request to the
/// wallet (Rabby/MetaMask will add the network on-the-fly if it isn't known).
export function ChainGuard() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain, isPending } = useSwitchChain();

  if (!isConnected || chainId === arcTestnet.id) return null;

  return (
    <div
      className="sticky top-16 z-40 mx-4 my-3 rounded-xl border border-amber-400/40 px-4 py-3 text-sm flex items-center justify-between gap-3 flex-wrap"
      style={{
        background: "linear-gradient(135deg, rgba(245,158,11,0.12), rgba(220,38,38,0.08))",
        backdropFilter: "blur(14px) saturate(140%)",
      }}
    >
      <div className="flex items-center gap-2 text-amber-200">
        <span className="text-lg">⚠️</span>
        <span>
          Your wallet is on chain {chainId}. ArcBounty is on{" "}
          <strong className="text-amber-100">Arc Testnet (id {arcTestnet.id})</strong>.
          Transactions won't work until you switch.
        </span>
      </div>
      <button
        onClick={() => switchChain({ chainId: arcTestnet.id })}
        disabled={isPending}
        className="btn-glow !py-2 !px-4 text-sm whitespace-nowrap disabled:opacity-60"
      >
        {isPending ? "Switching…" : "Switch to Arc Testnet"}
      </button>
    </div>
  );
}
