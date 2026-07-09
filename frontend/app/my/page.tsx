"use client";

import { useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";
import { BountyCard } from "@/components/BountyCard";
import type { BountyMeta } from "@/components/BountyCard";
import Link from "next/link";

type Tab = "posted" | "assigned";

export default function MyPage() {
  const { address, isConnected } = useAccount();
  const [tab, setTab] = useState<Tab>("posted");

  const { data: postedIds }   = useReadContract({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    functionName: "getMyPostedBounties",
    args: [address!],
    query: { enabled: !!address },
  });

  const { data: assignedIds } = useReadContract({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    functionName: "getMyAssignedBounties",
    args: [address!],
    query: { enabled: !!address },
  });

  if (!isConnected) {
    return (
      <div style={{ textAlign: "center", padding: "80px 0", color: "var(--ink-mute)" }}>
        Connect your wallet to see your tasks.
      </div>
    );
  }

  const activeIds = tab === "posted" ? postedIds : assignedIds;

  return (
    <>
      <header className="page-head">
        <h1>My Tasks</h1>
      </header>

      <div className="seg">
        <button
          type="button"
          className={tab === "posted" ? "active" : undefined}
          onClick={() => setTab("posted")}
        >
          Posted By Me
        </button>
        <button
          type="button"
          className={tab === "assigned" ? "active" : undefined}
          onClick={() => setTab("assigned")}
        >
          Assigned To Me
        </button>
      </div>

      {!activeIds || activeIds.length === 0 ? (
        <div style={{ textAlign: "center", padding: "64px 0", color: "var(--ink-soft)", marginTop: 24 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📭</div>
          <p style={{ marginBottom: 16 }}>
            {tab === "posted" ? "You haven't posted any bounties yet." : "You haven't taken any bounties yet."}
          </p>
          {tab === "posted" && (
            <Link href="/post" style={{ color: "var(--honey)", textDecoration: "underline", fontSize: 14 }}>
              Post your first bounty →
            </Link>
          )}
        </div>
      ) : (
        <div className="list" style={{ marginTop: 24 }}>
          {activeIds.map(jobId => (
            <MyBountyLoader key={jobId.toString()} jobId={jobId} />
          ))}
        </div>
      )}

      <footer className="spacer" />
    </>
  );
}

function MyBountyLoader({ jobId }: { jobId: bigint }) {
  const { data: meta } = useReadContract({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    functionName: "getBountyMeta",
    args: [jobId],
    // This list has no per-row event subscription (that's 13 watchers ×
    // every row, expensive) — poll instead so a submission or dispute someone
    // else triggers shows up without a manual page reload.
    query: { refetchInterval: 8_000 },
  });

  if (!meta) return <div className="row" style={{ height: 92, opacity: 0.5 }} />;
  return <BountyCard meta={meta as BountyMeta} />;
}
