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
  const { isConnected } = useAccount();
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
      const hash = await writeContractAsync(params as Parameters<typeof writeContractAsync>[0]);

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
