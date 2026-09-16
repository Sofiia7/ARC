"use client";

import { useAccount, useReadContract } from "wagmi";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";
import { useTx } from "@/hooks/useTx";
import { formatUsdc } from "@/lib/format";

// M-04: V4.6 added a pull-payment fallback (`pendingWithdrawals` / `withdraw()`)
// - a settlement whose direct USDC push failed (e.g. a blacklisted recipient)
// parks the amount instead of reverting the whole transaction. Without this
// banner, someone whose payout got parked had no way to discover it inside
// the app at all - the funds just sit in the contract until they happen to
// read the ABI or a block explorer themselves. Same placement/pattern as
// FaucetBanner: a persistent, wallet-state-aware banner in the root layout.
export function WithdrawBanner() {
  const { address, isConnected } = useAccount();
  const { send, isPending } = useTx();

  const { data: pending, refetch } = useReadContract({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    functionName: "pendingWithdrawals",
    args: [address!],
    query: { enabled: !!address, refetchInterval: 30_000 },
  });

  if (!isConnected || !address) return null;
  if (pending === undefined || pending === 0n) return null;

  async function handleWithdraw() {
    const hash = await send(
      {
        address: CONTRACTS.BOUNTY_ADAPTER,
        abi: BOUNTY_ADAPTER_ABI,
        functionName: "withdraw",
      },
      {
        pending: "Withdrawing…",
        success: "Withdrawn to your wallet!",
        error: "Withdrawal failed",
      },
    );
    if (hash) refetch();
  }

  return (
    <div
      role="status"
      style={{
        margin: "14px 0 0",
        padding: "12px 18px",
        borderRadius: 14,
        background: "rgba(70,211,145,0.08)",
        border: "1px solid rgba(70,211,145,0.35)",
        backdropFilter: "var(--g-blur)",
        WebkitBackdropFilter: "var(--g-blur)",
        fontSize: 13,
        color: "var(--ink-soft)",
        lineHeight: 1.55,
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
        justifyContent: "space-between",
      }}
    >
      <span>
        <strong style={{ color: "var(--green)" }}>{formatUsdc(pending)} USDC</strong> from a
        parked payout is waiting for you - a direct payout to your wallet couldn&apos;t go
        through earlier, so it&apos;s held in the contract until you withdraw it.
      </span>
      <button
        type="button"
        className="btn btn-primary"
        onClick={handleWithdraw}
        disabled={isPending}
      >
        {isPending ? "Withdrawing…" : "Withdraw"}
      </button>
    </div>
  );
}
