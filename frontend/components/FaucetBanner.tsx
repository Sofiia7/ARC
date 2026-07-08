"use client";

import { useAccount, useBalance } from "wagmi";

// On Arc, USDC is BOTH the reward token and the native gas token — a wallet
// with a zero balance can't post, take, or even approve anything. Without
// this banner a first-time visitor connects, clicks something, and hits an
// opaque "insufficient funds" failure with no path forward.
export const FAUCET_URL = "https://faucet.circle.com/";

export function FaucetBanner() {
  const { address, isConnected } = useAccount();
  const { data: balance } = useBalance({
    address,
    query: { enabled: !!address, refetchInterval: 30_000 },
  });

  if (!isConnected || !address || balance === undefined) return null;
  if (balance.value > 0n) return null;

  return (
    <div
      role="status"
      style={{
        margin: "14px 0 0",
        padding: "12px 18px",
        borderRadius: 14,
        background: "rgba(255,205,140,0.08)",
        border: "1px solid rgba(255,205,140,0.35)",
        backdropFilter: "var(--g-blur)",
        WebkitBackdropFilter: "var(--g-blur)",
        fontSize: 13,
        color: "var(--ink-soft)",
        lineHeight: 1.55,
      }}
    >
      <strong style={{ color: "var(--honey)" }}>Your wallet has no testnet USDC.</strong>{" "}
      On Arc, USDC is both the reward <em>and</em> the gas token, so you need some before you
      can post or take a bounty. Get free testnet USDC from{" "}
      <a
        href={FAUCET_URL}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: "var(--honey)", textDecoration: "underline" }}
      >
        Circle&apos;s faucet
      </a>{" "}
      — select <strong>Arc Testnet</strong>, paste your address, and come back. This banner
      disappears once the balance lands.
    </div>
  );
}
