"use client";

import { useAccount, useWriteContract, usePublicClient } from "wagmi";
import { toast } from "sonner";
import type { Abi } from "viem";

type WriteParams = {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args?: unknown[];
};

/**
 * Thin wrapper around wagmi's writeContract with automatic toast notifications.
 * Shows: pending → success/error toasts.
 */
export function useTx() {
  const { writeContractAsync, isPending } = useWriteContract();
  const { isConnected, address } = useAccount();
  const publicClient = usePublicClient();

  async function send(
    params: WriteParams,
    labels: { pending?: string; success?: string; error?: string } = {}
  ): Promise<`0x${string}` | null> {
    // Catch the no-wallet case before wagmi throws its opaque
    // ConnectorNotConnectedError — the user needs a next step, not "Failed".
    if (!isConnected) {
      toast.error("Connect your wallet first (top right) to do this.");
      return null;
    }
    const toastId = toast.loading(labels.pending ?? "Sending transaction…");

    try {
      // Pad the estimate generously: functions with a `try/catch` around an
      // external call (e.g. approveBounty's reputationRegistry.giveFeedback)
      // can need meaningfully more gas on a cold storage write than
      // eth_estimateGas accounts for, and since EVM only charges for gas
      // actually used, a fat ceiling here costs nothing on a success path.
      let gas: bigint | undefined;
      try {
        const estimate = await publicClient?.estimateContractGas({
          ...(params as Parameters<typeof writeContractAsync>[0]),
          account: address,
        });
        if (estimate) gas = (estimate * 150n) / 100n;
      } catch {
        // fall back to wallet/RPC default estimation
      }
      const hash = await writeContractAsync({
        ...(params as Parameters<typeof writeContractAsync>[0]),
        ...(gas ? { gas } : {}),
      });

      toast.loading("Waiting for confirmation…", { id: toastId });
      await publicClient?.waitForTransactionReceipt({ hash });

      toast.success(labels.success ?? "Transaction confirmed!", { id: toastId });
      return hash;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const friendly = msg.includes("User rejected")
        ? "Transaction rejected"
        : labels.error ?? "Transaction failed";
      toast.error(friendly, { id: toastId });
      return null;
    }
  }

  return { send, isPending };
}
