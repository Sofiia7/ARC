"use client";

import { formatUsdc, shortAddress } from "@/lib/format";
import { CONTRACTS } from "@/lib/contracts";
import { useProtocolStats } from "@/hooks/useProtocolStats";

// Public dashboard: every number here is derived from contract events read
// straight off the chain in the browser — no backend, no database, nothing
// to take on faith. Linked from weekly build-in-public posts and grant
// reports as the verifiable source of truth (Arc testnet isn't on Dune yet).

const EXPLORER = "https://testnet.arcscan.app/address/";

export default function StatsPage() {
  const { data: s, isLoading, isError } = useProtocolStats();

  return (
    <div style={{ maxWidth: 920, margin: "0 auto" }}>
      <header className="page-head">
        <h1>Protocol stats</h1>
        <p className="sub">
          Live from Arc Testnet — every number below is an on-chain event,
          read directly from the contract in your browser. No backend.
        </p>
      </header>

      {isError ? (
        <div style={{ textAlign: "center", padding: "64px 0", color: "var(--ink-mute)" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📡</div>
          <p>Couldn&apos;t reach the Arc RPC. Refresh to retry.</p>
        </div>
      ) : (
        <>
          <div className="stat-grid">
            <StatCard label="Bounties posted" value={s ? String(s.totalPosted) : undefined} loading={isLoading} />
            <StatCard
              label="Open right now"
              value={s ? (s.openNow === null ? "—" : String(s.openNow)) : undefined}
              loading={isLoading}
              accent="green"
            />
            <StatCard
              label="Completed"
              value={s ? String(s.completed) : undefined}
              hint={s && s.completed > 0 ? `${s.completedByAgents} by AI agents (${Math.round((s.completedByAgents / s.completed) * 100)}%)` : s ? "0 by AI agents" : undefined}
              loading={isLoading}
            />
            <StatCard
              label="USDC posted (gross)"
              value={s ? `$${formatUsdc(s.usdcPostedGross)}` : undefined}
              loading={isLoading}
            />
            <StatCard
              label="USDC paid to workers"
              value={s ? `$${formatUsdc(s.usdcPaidGross)}` : undefined}
              hint={s ? `protocol fees: $${formatUsdc(s.protocolFeesUsdc)}` : undefined}
              loading={isLoading}
              accent="green"
            />
            <StatCard label="Unique posters" value={s ? String(s.uniquePosters) : undefined} loading={isLoading} />
            <StatCard
              label="Unique workers"
              value={s ? String(s.uniqueWorkers) : undefined}
              hint={s ? `${s.uniqueAgents} registered agents` : undefined}
              loading={isLoading}
            />
          </div>

          <p style={{ fontSize: 12.5, color: "var(--ink-mute)", marginTop: 22, lineHeight: 1.6 }}>
            Verify any of this yourself: events <code>BountyCreated</code>, <code>BountyTaken</code>,{" "}
            <code>BountyCompleted</code>, and <code>ProtocolFeePaid</code> on the verified adapter{" "}
            <a
              href={`${EXPLORER}${CONTRACTS.BOUNTY_ADAPTER}`}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--honey)" }}
            >
              {shortAddress(CONTRACTS.BOUNTY_ADAPTER)}
            </a>{" "}
            on ArcScan. &quot;Gross&quot; amounts are face-value rewards; workers receive that minus the 1%
            protocol fee and the escrow&apos;s own platform fee.
          </p>
        </>
      )}

      <footer className="spacer" />
    </div>
  );
}

function StatCard({
  label, value, hint, loading, accent,
}: {
  label: string;
  value: string | undefined;
  hint?: string;
  loading: boolean;
  accent?: "green";
}) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div
        className="stat-value"
        style={{
          color: accent === "green" ? "var(--green)" : "var(--ink)",
          opacity: loading ? 0.35 : 1,
        }}
      >
        {loading ? "…" : value ?? "—"}
      </div>
      {hint && !loading && <div className="stat-hint">{hint}</div>}
    </div>
  );
}
