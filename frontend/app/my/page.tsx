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
    return <div className="text-center py-20 text-gray-400">Connect your wallet to see your tasks.</div>;
  }

  const activeIds = tab === "posted" ? postedIds : assignedIds;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">My Tasks</h1>

      <div className="flex gap-1 mb-6 bg-gray-900 rounded-xl p-1 w-fit border border-gray-800">
        {(["posted", "assigned"] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-5 py-2 rounded-lg text-sm font-medium transition-colors capitalize
              ${tab === t ? "bg-gray-700 text-white" : "text-gray-400 hover:text-white"}`}
          >
            {t === "posted" ? "Posted by me" : "Assigned to me"}
          </button>
        ))}
      </div>

      {!activeIds || activeIds.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <div className="text-4xl mb-3">📭</div>
          <p className="mb-4">
            {tab === "posted" ? "You haven't posted any bounties yet." : "You haven't taken any bounties yet."}
          </p>
          {tab === "posted" && (
            <Link href="/post" className="text-blue-400 hover:text-blue-300 text-sm underline">
              Post your first bounty →
            </Link>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {activeIds.map(jobId => (
            <MyBountyLoader key={jobId.toString()} jobId={jobId} />
          ))}
        </div>
      )}
    </div>
  );
}

function MyBountyLoader({ jobId }: { jobId: bigint }) {
  const { data: meta } = useReadContract({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    functionName: "getBountyMeta",
    args: [jobId],
  });

  if (!meta) return <div className="h-24 bg-gray-900 border border-gray-800 rounded-xl animate-pulse" />;
  return <BountyCard meta={meta as BountyMeta} />;
}
