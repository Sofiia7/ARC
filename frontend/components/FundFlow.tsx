"use client";

import { useState } from "react";
import { useWriteContract, useReadContract, useAccount, usePublicClient } from "wagmi";
import { toast } from "sonner";
import { CONTRACTS, BOUNTY_ADAPTER_ABI, ERC20_ABI } from "@/lib/contracts";
import { formatUsdc } from "@/lib/format";

type Props = {
  jobId: bigint;
  reward: bigint;
  onSuccess?: () => void;
};

type Step = "idle" | "approving" | "funding" | "done";

export function FundFlow({ jobId, reward, onSuccess }: Props) {
  const { address } = useAccount();
  const [step, setStep] = useState<Step>("idle");
  const publicClient = usePublicClient();

  const { data: allowance } = useReadContract({
    address: CONTRACTS.USDC,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [address!, CONTRACTS.BOUNTY_ADAPTER],
    query: { enabled: !!address },
  });

  const { writeContractAsync } = useWriteContract();
  const needsApprove = !allowance || allowance < reward;

  async function handleFund() {
    try {
      if (needsApprove) {
        setStep("approving");
        const tid = toast.loading("Approving USDC (1/2)…");
        const hash = await writeContractAsync({
          address: CONTRACTS.USDC,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [CONTRACTS.BOUNTY_ADAPTER, reward],
        });
        await publicClient?.waitForTransactionReceipt({ hash });
        toast.success("USDC approved!", { id: tid });
      }

      setStep("funding");
      const tid2 = toast.loading("Funding escrow (2/2)…");
      const hash2 = await writeContractAsync({
        address: CONTRACTS.BOUNTY_ADAPTER,
        abi: BOUNTY_ADAPTER_ABI,
        functionName: "fundBounty",
        args: [jobId],
      });
      await publicClient?.waitForTransactionReceipt({ hash: hash2 });
      toast.success("Bounty funded! Waiting for submissions.", { id: tid2 });

      setStep("done");
      onSuccess?.();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(msg.includes("User rejected") ? "Transaction rejected" : "Funding failed");
      setStep("idle");
    }
  }

  const LABELS: Record<Step, string> = {
    idle:     `Fund $${formatUsdc(reward)} USDC`,
    approving: "Approving USDC…",
    funding:   "Funding escrow…",
    done:      "Funded!",
  };

  const busy = step === "approving" || step === "funding";

  return (
    <div className="space-y-2">
      {needsApprove && step === "idle" && (
        <p className="text-xs text-gray-500">Requires 2 transactions: approve USDC → fund escrow.</p>
      )}
      <button
        onClick={handleFund}
        disabled={busy || step === "done"}
        className="w-full bg-green-600 hover:bg-green-500 disabled:bg-gray-700 disabled:text-gray-500
                   disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl transition-colors"
      >
        {LABELS[step]}
      </button>
    </div>
  );
}
