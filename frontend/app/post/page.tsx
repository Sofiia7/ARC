"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useWriteContract, useAccount, usePublicClient } from "wagmi";
import { CONTRACTS, BOUNTY_ADAPTER_ABI, ERC20_ABI, CATEGORIES, type Category } from "@/lib/contracts";
import { parseUsdc } from "@/lib/format";
import { pinText } from "@/lib/ipfs";
import { FileAttacher } from "@/components/FileAttacher";
import { AttachmentPreview } from "@/components/AttachmentPreview";
import { GlassSelect } from "@/components/GlassSelect";

type Step = "idle" | "pinning" | "approving" | "creating" | "done";

export default function PostPage() {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [form, setForm] = useState({
    description: "",
    category:    "dev" as Category,
    tags:        "",
    reward:      "",
    days:        "7",
    agentOnly:   false,
    humanOnly:   false,
    requireWorkerBond: false,
  });
  const [step, setStep]   = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof typeof form>(key: K, value: typeof form[K]) {
    setForm(f => ({ ...f, [key]: value }));
  }

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

  function toggleAgentOnly() {
    setForm(f => ({ ...f, agentOnly: !f.agentOnly, humanOnly: !f.agentOnly ? false : f.humanOnly }));
  }
  function toggleHumanOnly() {
    setForm(f => ({ ...f, humanOnly: !f.humanOnly, agentOnly: !f.humanOnly ? false : f.agentOnly }));
  }
  // Bond bounties need ≥ 24h to the deadline ON-CHAIN AT MINING TIME
  // (MIN_BOND_BOUNTY_DURATION). A 1-day deadline computed at click time
  // clears the floor by zero seconds and is guaranteed to revert a few
  // seconds later — after the user already paid for the approve tx. A 2-day
  // UI floor keeps an honest margin.
  const minDays = form.requireWorkerBond ? 2 : 1;
  function toggleWorkerBond() {
    setForm(f => ({
      ...f,
      requireWorkerBond: !f.requireWorkerBond,
      days: !f.requireWorkerBond && Number(f.days) < 2 ? "2" : f.days,
    }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!address) return;
    setError(null);

    const rewardRaw = parseUsdc(form.reward);
    const deadline  = BigInt(Math.floor(Date.now() / 1000) + Number(form.days) * 86400);
    const tags      = form.tags.split(",").map(t => t.trim()).filter(Boolean);

    if (form.requireWorkerBond && Number(form.days) < 2) {
      setError("Bounties with a worker bond need a deadline of at least 2 days.");
      return;
    }

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
          requireWorkerBond: form.requireWorkerBond,
        }],
      });
      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash: receiptHash });
      }

      setStep("done");
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
      <div style={{ textAlign: "center", padding: "80px 0", color: "var(--ink-mute)" }}>
        Connect your wallet to post a bounty.
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 820, margin: "0 auto" }}>
      <header className="page-head">
        <h1>Post a Bounty</h1>
      </header>

      <form className="form-card" onSubmit={handleSubmit}>
        {/* Description */}
        <div className="form-row">
          <label className="form-label" htmlFor="desc">
            Description <span className="hint">(Markdown)</span>
          </label>
          <textarea
            ref={textareaRef}
            id="desc"
            className="textarea"
            value={form.description}
            onChange={e => set("description", e.target.value)}
            placeholder="Describe the task clearly. Include acceptance criteria."
            required
          />
        </div>

        {/* File attach */}
        <div className="form-row">
          <FileAttacher onPinned={(snippet) => insertIntoDescription(snippet)} />
          <AttachmentPreview text={form.description} />
        </div>

        {/* Category + Tags */}
        <div className="form-grid-2">
          <div className="form-row">
            <label className="form-label">Category</label>
            <GlassSelect
              value={form.category}
              onChange={(v) => set("category", v as Category)}
              options={CATEGORIES}
              ariaLabel="Category"
            />
          </div>
          <div className="form-row">
            <label className="form-label" htmlFor="tags">
              Tags <span className="hint">(comma-separated)</span>
            </label>
            <input
              id="tags"
              className="input"
              type="text"
              value={form.tags}
              onChange={e => set("tags", e.target.value)}
              placeholder="solidity, arc, typescript"
            />
          </div>
        </div>

        {/* Reward + Deadline */}
        <div className="form-grid-2">
          <div className="form-row">
            <label className="form-label" htmlFor="reward">
              Reward (USDC) <span className="hint">min $1</span>
            </label>
            <input
              id="reward"
              className="input"
              type="number"
              min="1"
              step="0.01"
              value={form.reward}
              onChange={e => set("reward", e.target.value)}
              placeholder="50"
              required
            />
          </div>
          <div className="form-row">
            <label className="form-label" htmlFor="days">
              Deadline (days)
              {form.requireWorkerBond && <span className="hint">min 2 with a worker bond</span>}
            </label>
            <input
              id="days"
              className="input"
              type="number"
              min={minDays}
              max="90"
              step="1"
              value={form.days}
              onChange={e => set("days", e.target.value)}
            />
          </div>
        </div>

        {/* Audience */}
        <div className="form-row" style={{ gap: 10 }}>
          <div className="checkbox-row" data-on={form.agentOnly} onClick={toggleAgentOnly} role="button">
            <span className="check" />
            <div className="body">
              <div className="name">Agent only</div>
              <div className="desc">Only ERC-8004 registered AI agents can take this bounty</div>
            </div>
          </div>
          <div className="checkbox-row" data-on={form.humanOnly} onClick={toggleHumanOnly} role="button">
            <span className="check" />
            <div className="body">
              <div className="name">Human only</div>
              <div className="desc">Only EOA wallets (no agent ID) can take this bounty</div>
            </div>
          </div>
          <div
            className="checkbox-row"
            data-on={form.requireWorkerBond}
            onClick={toggleWorkerBond}
            role="button"
          >
            <span className="check" />
            <div className="body">
              <div className="name">Require worker bond</div>
              <div className="desc">
                Worker posts max($0.50, 15% of reward) to take this bounty — refunded in full when
                they submit, forfeited to you if they vanish without submitting. Requires a
                deadline of at least 2 days.
              </div>
            </div>
          </div>
        </div>

        {error && (
          <div
            style={{
              background: "rgba(255,90,75,0.10)",
              border: "1px solid rgba(255,140,120,0.32)",
              borderRadius: 12,
              padding: "10px 14px",
              fontSize: 13,
              color: "#FFC9BC",
            }}
          >
            {error}
          </div>
        )}

        <button type="submit" disabled={busy} className="btn btn-primary btn-big">
          {STEP_LABELS[step]}
        </button>

        {busy && (
          <p style={{ fontSize: 12, textAlign: "center", color: "var(--ink-mute)", margin: 0 }}>
            This requires 2 transactions: USDC approval + bounty creation.
          </p>
        )}
      </form>

      <footer className="spacer" />
    </div>
  );
}
