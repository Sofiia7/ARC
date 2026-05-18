"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useWriteContract, useAccount, usePublicClient } from "wagmi";
import { CONTRACTS, BOUNTY_ADAPTER_ABI, ERC20_ABI, CATEGORIES, type Category } from "@/lib/contracts";
import { parseUsdc } from "@/lib/format";
import { pinText } from "@/lib/ipfs";

type Step = "idle" | "pinning" | "approving" | "creating" | "done";

export default function PostPage() {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();

  const [form, setForm] = useState({
    description: "",
    category:    "dev" as Category,
    tags:        "",
    reward:      "",
    days:        "7",
    agentOnly:   false,
    commitReveal: false,
  });
  const [step, setStep]   = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);

  function set(key: keyof typeof form, value: string | boolean) {
    setForm(f => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!address) return;
    setError(null);

    const rewardRaw = parseUsdc(form.reward);
    const deadline  = BigInt(Math.floor(Date.now() / 1000) + Number(form.days) * 86400);
    const tags      = form.tags.split(",").map(t => t.trim()).filter(Boolean);

    try {
      setStep("pinning");
      const cid = await pinText(form.description);

      setStep("approving");
      const approveHash = await writeContractAsync({
        address: CONTRACTS.USDC,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [CONTRACTS.BOUNTY_ADAPTER, rewardRaw],
      });
      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
      }

      setStep("creating");
      const receiptHash = await writeContractAsync({
        address: CONTRACTS.BOUNTY_ADAPTER,
        abi: BOUNTY_ADAPTER_ABI,
        functionName: "createBounty",
        args: [{
          provider: "0x0000000000000000000000000000000000000000",
          reward: rewardRaw,
          deadline,
          ipfsDescHash: cid,
          category: form.category,
          tags,
          agentOnly: form.agentOnly,
          commitRevealRequired: form.commitReveal,
        }],
      });
      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash: receiptHash });
      }

      setStep("done");
      // Navigate to home after short delay
      setTimeout(() => router.push("/"), 1500);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg.includes("User rejected") ? "Transaction rejected" : `Failed: ${msg}`);
      setStep("idle");
    }
  }

  const STEP_LABELS: Record<Step, string> = {
    idle:      "Post Bounty",
    pinning:   "Uploading to IPFS…",
    approving: "Approving USDC (tx 1/2)…",
    creating:  "Creating bounty (tx 2/2)…",
    done:      "Posted! Redirecting…",
  };

  const busy = step !== "idle" && step !== "done";

  if (!isConnected) {
    return (
      <div className="text-center py-20 text-gray-400">
        Connect your wallet to post a bounty.
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-6">Post a Bounty</h1>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Description */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1.5">
            Description (Markdown)
          </label>
          <textarea
            value={form.description}
            onChange={e => set("description", e.target.value)}
            placeholder="Describe the task clearly. Include acceptance criteria."
            rows={10}
            required
            className="w-full bg-white/5 border border-white/10 rounded-xl p-4 text-sm resize-none
                       focus:outline-none focus:border-blue-500 font-mono"
          />
        </div>

        {/* Category + Tags */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Category</label>
            <select
              value={form.category}
              onChange={e => set("category", e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm
                         focus:outline-none focus:border-blue-500"
            >
              {CATEGORIES.map(c => (
                <option key={c} value={c} className="capitalize">{c}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">
              Tags <span className="text-gray-500">(comma-separated)</span>
            </label>
            <input
              type="text"
              value={form.tags}
              onChange={e => set("tags", e.target.value)}
              placeholder="solidity, arc, typescript"
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm
                         focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        {/* Reward + Deadline */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">
              Reward (USDC) <span className="text-gray-500">min $1</span>
            </label>
            <input
              type="number"
              min="1"
              step="0.01"
              value={form.reward}
              onChange={e => set("reward", e.target.value)}
              placeholder="50"
              required
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm
                         focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Deadline (days)</label>
            <input
              type="number"
              min="1"
              max="90"
              value={form.days}
              onChange={e => set("days", e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm
                         focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        {/* Agent only toggle */}
        <label className="flex items-center gap-3 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={form.agentOnly}
            onChange={e => set("agentOnly", e.target.checked)}
            className="accent-violet-500 w-4 h-4"
          />
          <div>
            <span className="text-sm font-medium">Agent only</span>
            <span className="ml-2 text-xs text-gray-500">Only ERC-8004 registered AI agents can take this bounty</span>
          </div>
        </label>

        {/* MEV protection toggle */}
        <label className="flex items-center gap-3 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={form.commitReveal}
            onChange={e => set("commitReveal", e.target.checked)}
            className="accent-amber-500 w-4 h-4"
          />
          <div>
            <span className="text-sm font-medium">MEV protection (commit-reveal)</span>
            <span className="ml-2 text-xs text-gray-500">
              Requires takers to commit first and reveal ≥ 2 blocks later. Recommended for high-value bounties.
            </span>
          </div>
        </label>

        {error && (
          <div className="bg-red-900/30 border border-red-800 rounded-xl p-3 text-sm text-red-400">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="btn-glow w-full disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {STEP_LABELS[step]}
        </button>

        {busy && (
          <p className="text-xs text-center text-gray-500">
            This requires 2 transactions: USDC approval + bounty creation.
          </p>
        )}
      </form>
    </div>
  );
}
