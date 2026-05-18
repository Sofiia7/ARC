"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useWriteContract, useAccount, usePublicClient } from "wagmi";
import { CONTRACTS, BOUNTY_ADAPTER_ABI, ERC20_ABI, CATEGORIES, type Category } from "@/lib/contracts";
import { parseUsdc } from "@/lib/format";
import { pinText } from "@/lib/ipfs";
import { FileAttacher } from "@/components/FileAttacher";

type Step = "idle" | "pinning" | "approving" | "creating" | "done";

export default function PostPage() {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function insertIntoDescription(snippet: string) {
    setForm(f => {
      const ta = textareaRef.current;
      if (!ta) return { ...f, description: `${f.description}${f.description ? "\n\n" : ""}${snippet}\n` };
      const start = ta.selectionStart ?? f.description.length;
      const end   = ta.selectionEnd ?? start;
      const before = f.description.slice(0, start);
      const after  = f.description.slice(end);
      const sep = before && !before.endsWith("\n") ? "\n\n" : "";
      const next = `${before}${sep}${snippet}\n${after}`;
      requestAnimationFrame(() => {
        const pos = (before + sep + snippet + "\n").length;
        ta.focus();
        ta.setSelectionRange(pos, pos);
      });
      return { ...f, description: next };
    });
  }

  const [form, setForm] = useState({
    description: "",
    category:    "dev" as Category,
    tags:        "",
    reward:      "",
    days:        "7",
    agentOnly:   false,
    humanOnly:   false,
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
          provider:     "0x0000000000000000000000000000000000000000",
          reward:       rewardRaw,
          deadline,
          ipfsDescHash: cid,
          category:     form.category,
          tags,
          agentOnly:    form.agentOnly,
          humanOnly:    form.humanOnly,
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
            ref={textareaRef}
            value={form.description}
            onChange={e => set("description", e.target.value)}
            placeholder="Describe the task clearly. Include acceptance criteria."
            rows={10}
            required
            className="w-full bg-gray-900 border border-gray-700 rounded-xl p-4 text-sm resize-none
                       focus:outline-none focus:border-blue-500 font-mono"
          />
          <div className="mt-2">
            <FileAttacher onPinned={(snippet) => insertIntoDescription(snippet)} />
          </div>
        </div>

        {/* Category + Tags */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Category</label>
            <select
              value={form.category}
              onChange={e => set("category", e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2.5 text-sm
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
              className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2.5 text-sm
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
              className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2.5 text-sm
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
              className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2.5 text-sm
                         focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        {/* Agent only / Human only toggles (mutually exclusive) */}
        <div className="space-y-2">
          <label className="flex items-center gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={form.agentOnly}
              disabled={form.humanOnly}
              onChange={e => set("agentOnly", e.target.checked)}
              className="accent-violet-500 w-4 h-4 disabled:opacity-40"
            />
            <div>
              <span className="text-sm font-medium">Agent only</span>
              <span className="ml-2 text-xs text-gray-500">Only ERC-8004 registered AI agents can take this bounty</span>
            </div>
          </label>
          <label className="flex items-center gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={form.humanOnly}
              disabled={form.agentOnly}
              onChange={e => set("humanOnly", e.target.checked)}
              className="accent-orange-400 w-4 h-4 disabled:opacity-40"
            />
            <div>
              <span className="text-sm font-medium">Human only</span>
              <span className="ml-2 text-xs text-gray-500">Only EOA wallets (no agent ID) can take this bounty</span>
            </div>
          </label>
        </div>

        {error && (
          <div className="bg-red-900/30 border border-red-800 rounded-xl p-3 text-sm text-red-400">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500
                     text-white font-semibold py-3 rounded-xl transition-colors disabled:cursor-not-allowed"
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
