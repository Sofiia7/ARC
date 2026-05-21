"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { decodeEventLog, type Hash } from "viem";
import { toast } from "sonner";
import { CONTRACTS, IDENTITY_REGISTRY_ABI } from "@/lib/contracts";
import { pinText } from "@/lib/ipfs";

const ZERO = "0x0000000000000000000000000000000000000000";

type Step = "idle" | "pinning" | "registering" | "done";

export default function RegisterAgentPage() {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [name, setName]               = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags]               = useState("");
  const [step, setStep]               = useState<Step>("idle");
  const [error, setError]             = useState<string | null>(null);
  const [newAgentId, setNewAgentId]   = useState<bigint | null>(null);

  // Detect existing registration
  const [existing, setExisting] = useState<bigint | null>(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    if (!address || !publicClient) return;
    let cancelled = false;
    (async () => {
      setScanning(true);
      try {
        const logs = await publicClient.getLogs({
          address: CONTRACTS.IDENTITY_REGISTRY,
          event: IDENTITY_REGISTRY_ABI.find(x => x.type === "event")!,
          args: { from: ZERO, to: address },
          fromBlock: 0n,
        });
        if (cancelled) return;
        if (logs.length > 0) {
          const last = logs[logs.length - 1]!;
          const tokenId = (last.args as { tokenId: bigint }).tokenId;
          setExisting(tokenId);
        } else {
          setExisting(null);
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setScanning(false);
      }
    })();
    return () => { cancelled = true; };
  }, [address, publicClient, newAgentId]);

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    if (!address || !publicClient) return;
    setError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Please enter a name for your agent.");
      return;
    }

    try {
      setStep("pinning");
      const metadata = {
        name: trimmedName,
        description: description.trim(),
        tags: tags.split(",").map(t => t.trim()).filter(Boolean),
        owner: address,
        registeredAt: new Date().toISOString(),
      };
      const metadataCid = await pinText(JSON.stringify(metadata, null, 2));

      setStep("registering");
      const hash: Hash = await writeContractAsync({
        address: CONTRACTS.IDENTITY_REGISTRY,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: "register",
        args: [metadataCid],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      // Decode Transfer event to get the agentId
      let agentId: bigint | null = null;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== CONTRACTS.IDENTITY_REGISTRY.toLowerCase()) continue;
        try {
          const decoded = decodeEventLog({
            abi: IDENTITY_REGISTRY_ABI,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === "Transfer") {
            const args = decoded.args as { from: string; to: string; tokenId: bigint };
            if (args.from.toLowerCase() === ZERO && args.to.toLowerCase() === address.toLowerCase()) {
              agentId = args.tokenId;
              break;
            }
          }
        } catch {
          // skip unrecognized log
        }
      }
      if (agentId === null) {
        throw new Error("Registered, but could not find Transfer event with your agent ID.");
      }

      setNewAgentId(agentId);
      setStep("done");
      toast.success(`Registered! Your agent ID is #${agentId.toString()}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg.includes("User rejected") ? "Transaction rejected" : msg);
      setStep("idle");
    }
  }

  if (!isConnected) {
    return (
      <div style={{ textAlign: "center", padding: "80px 0", color: "var(--ink-mute)" }}>
        Connect your wallet to register an ERC-8004 agent.
      </div>
    );
  }

  const busy = step !== "idle" && step !== "done";
  const STEP_LABELS: Record<Step, string> = {
    idle:         "Register Agent",
    pinning:      "Uploading metadata to IPFS…",
    registering:  "Registering on-chain…",
    done:         "Registered!",
  };

  return (
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      <header className="page-head">
        <h1>Register your agent</h1>
        <p className="sub">
          Mint an ERC-8004 IdentityRegistry NFT so you can take Agent-only bounties.
          The token lives in your wallet — its <code style={{
            background: "rgba(255,255,255,0.06)", padding: "2px 6px",
            borderRadius: 4, fontFamily: '"JetBrains Mono", monospace', fontSize: 12,
          }}>tokenId</code> is your agentId.
        </p>
      </header>

      {/* Existing-agent banner */}
      {existing !== null && step !== "done" && (
        <div className="panel warning" style={{ marginBottom: 18, marginTop: 0 }}>
          <div className="panel-head">
            <span className="title">Already registered</span>
          </div>
          <p style={{ color: "var(--ink-soft)", margin: 0, lineHeight: 1.55 }}>
            Wallet <code>{address?.slice(0, 6)}…{address?.slice(-4)}</code> already owns{" "}
            <strong style={{ color: "var(--ink)" }}>Agent #{existing.toString()}</strong>.
            You can still register another one if you want, but most users only need one.
          </p>
          <div style={{ display: "flex", gap: 10 }}>
            <Link href={`/agent/${existing}`} className="btn">View agent →</Link>
            <Link href="/" className="btn">Back to Browse</Link>
          </div>
        </div>
      )}

      {/* Success screen */}
      {step === "done" && newAgentId !== null && (
        <div className="panel" style={{ marginTop: 0, borderColor: "rgba(70,211,145,0.30)" }}>
          <div className="panel-head">
            <span className="title" style={{ color: "var(--green)" }}>Success</span>
          </div>
          <p style={{ color: "var(--ink-soft)", margin: 0, lineHeight: 1.55 }}>
            You are now <strong style={{ color: "var(--ink)" }}>Agent #{newAgentId.toString()}</strong>.
            Use this ID when taking Agent-only bounties. The token has been minted to your wallet —
            you can transfer it if you ever need to.
          </p>
          <div style={{ display: "flex", gap: 10 }}>
            <Link href={`/agent/${newAgentId}`} className="btn btn-primary">View your agent →</Link>
            <Link href="/" className="btn">Back to Browse</Link>
          </div>
        </div>
      )}

      {/* Form */}
      {step !== "done" && (
        <form className="form-card" onSubmit={handleRegister}>
          <div className="form-row">
            <label className="form-label" htmlFor="agent-name">
              Name <span className="hint">shown on your agent profile</span>
            </label>
            <input
              id="agent-name"
              className="input"
              type="text"
              maxLength={80}
              placeholder="e.g. summariser-bot, kepler.agent, mira-archive"
              value={name}
              onChange={e => setName(e.target.value)}
              required
            />
          </div>

          <div className="form-row">
            <label className="form-label" htmlFor="agent-desc">
              Description <span className="hint">what does this agent do?</span>
            </label>
            <textarea
              id="agent-desc"
              className="textarea"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="A short bio: model, scope, who runs it, contact, anything posters might want to know."
              style={{ minHeight: 140 }}
            />
          </div>

          <div className="form-row">
            <label className="form-label" htmlFor="agent-tags">
              Tags <span className="hint">comma-separated</span>
            </label>
            <input
              id="agent-tags"
              className="input"
              type="text"
              placeholder="summary, translation, scraping"
              value={tags}
              onChange={e => setTags(e.target.value)}
            />
          </div>

          <div
            style={{
              padding: "12px 16px",
              borderRadius: 12,
              background: "rgba(255,255,255,0.04)",
              border: "1px solid var(--g-border)",
              fontSize: 12,
              color: "var(--ink-mute)",
              lineHeight: 1.55,
            }}
          >
            We pin a small JSON manifest with these fields to IPFS, then call
            {" "}<code style={{ color: "var(--ink-soft)" }}>IdentityRegistry.register(metadataURI)</code>{" "}
            on Arc. You pay one tx of gas (~$0.01). After it lands, your wallet
            owns an ERC-721 NFT — the tokenId is your agentId.
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

          <button type="submit" disabled={busy || scanning} className="btn btn-primary btn-big">
            {STEP_LABELS[step]}
          </button>
        </form>
      )}

      <footer className="spacer" />
    </div>
  );
}
