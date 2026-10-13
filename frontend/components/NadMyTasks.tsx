"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useAccount, usePublicClient } from "wagmi";
import { CONTRACTS } from "@/lib/contracts";
import { BOARD_LIMIT, estimateChainNow, parseAgentIdInput } from "@/lib/nadBoard";
import { loadMyJobIds, loadNadJobs, type NadReadClient, type NadSnapshot } from "@/lib/nadBoardLoad";
import { NadBountyRow } from "./NadBounty";
import { ConnectWalletModal } from "./ConnectWalletModal";
import { NadTelegram } from "./NadTelegram";
import styles from "./NadBoard.module.css";

const AGENT_DEBOUNCE_MS = 600;

export function NadMyTasks() {
  const { address } = useAccount(),
    client = usePublicClient();
  const [id, setId] = useState(""),
    [snap, setSnap] = useState<NadSnapshot | null>(null),
    [cut, setCut] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [connect, setConnect] = useState(false);
  const request = useRef(0);

  const load = useCallback(
    async (agentInput: string) => {
      if (!client || !address) return;
      const agentId = parseAgentIdInput(agentInput);
      if (agentId === null) {
        setError("Agent ID must be a number. Leave it empty if you only want your wallet's tasks.");
        return;
      }
      const mine = ++request.current;
      setBusy(true);
      setError("");
      try {
        const reader = client as unknown as NadReadClient;
        const cfg = { adapter: CONTRACTS.BOUNTY_ADAPTER, escrow: CONTRACTS.AGENTIC_COMMERCE };
        const { ids, truncated } = await loadMyJobIds(reader, cfg, { address, agentId });
        const next = await loadNadJobs(reader, cfg, ids);
        if (mine !== request.current) return;
        setSnap(next);
        setCut(truncated);
      } catch (e) {
        if (mine === request.current) setError(e instanceof Error ? e.message : "Could not read tasks");
      } finally {
        if (mine === request.current) setBusy(false);
      }
    },
    [client, address],
  );

  // A different wallet is a different list: drop the old rows, then read the new ones.
  useEffect(() => {
    request.current++;
    setSnap(null);
    setCut(false);
    setError("");
    setBusy(false);
    if (address && client) void load(id);
  }, [address, client]); // eslint-disable-line react-hooks/exhaustive-deps

  // Typing an agent ID reloads after a short pause. An empty field means 0, so clearing it is never an error.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (!address || parseAgentIdInput(id) === null) return;
    const timer = setTimeout(() => void load(id), AGENT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const jobs = useMemo(() => snap?.jobs ?? [], [snap]);
  const stale = !!error && jobs.length > 0;
  const nowSeconds = snap
    ? estimateChainNow(snap.chainNow, snap.fetchedAtMs, Date.now())
    : BigInt(Math.floor(Date.now() / 1000));
  const idInvalid = parseAgentIdInput(id) === null;

  return (
    <>
      <header className="page-head">
        <h1>My Tasks</h1>
        <p className="sub">Bounties you posted and contests or jobs you entered.</p>
      </header>
      {!address ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>📭</div>
          <p style={{ marginBottom: 16 }}>Connect your wallet to see your bounties and entries.</p>
          <button type="button" className="btn btn-primary btn-big" onClick={() => setConnect(true)}>
            Connect wallet
          </button>
          {connect && <ConnectWalletModal onClose={() => setConnect(false)} />}
        </div>
      ) : (
        <>
          <div className={styles.toolbar} style={{ marginTop: 0, alignItems: "flex-end" }}>
            <div className="form-row" style={{ maxWidth: 360, flex: "1 1 240px" }}>
              <label className="form-label" htmlFor="my-agent">
                Optional agent ID <span className="hint">includes its history after a wallet rotation</span>
              </label>
              <input
                id="my-agent"
                className="input"
                inputMode="numeric"
                placeholder="empty = wallet only"
                value={id}
                aria-invalid={idInvalid}
                onChange={(e) => setId(e.target.value)}
              />
            </div>
            <button type="button" className="btn" disabled={busy} onClick={() => void load(id)}>
              {busy ? "Reading…" : `Reload latest ${BOARD_LIMIT}`}
            </button>
          </div>
          {error && (
            <div className={styles.banner} role="alert">
              <span style={{ overflowWrap: "anywhere" }}>
                {error}
                {stale && " Showing the last list we loaded, which may be out of date."}
              </span>
              {!idInvalid && (
                <button type="button" className="btn" disabled={busy} onClick={() => void load(id)}>
                  Try again
                </button>
              )}
            </div>
          )}
          {busy && !jobs.length ? (
            <div className="list" style={{ marginTop: 24 }} aria-busy="true">
              {[0, 1].map((i) => (
                <div key={i} className={`row ${styles.skeleton}`} />
              ))}
            </div>
          ) : snap && !jobs.length ? (
            <div className={styles.empty}>
              <div className={styles.emptyIcon}>📭</div>
              <p style={{ marginBottom: 16 }}>No tasks for this wallet yet.</p>
              <Link href="/post" className={styles.link} style={{ fontSize: 14 }}>
                Post your first bounty →
              </Link>
            </div>
          ) : (
            <div className="list" style={{ marginTop: 24 }}>
              {jobs.map((j) => (
                <NadBountyRow
                  key={String(j.meta.jobId)}
                  meta={j.meta}
                  status={j.status}
                  ctx={j.ctx}
                  nowSeconds={nowSeconds}
                  stale={stale}
                />
              ))}
            </div>
          )}
          {cut && <p className={styles.footnote}>Showing the newest {BOARD_LIMIT} tasks.</p>}
          <NadTelegram title="Reminders" />
        </>
      )}
      <footer className="spacer" />
    </>
  );
}
