"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { CONTRACTS } from "@/lib/contracts";
import { getActiveNetwork } from "@/lib/networks";
import { parseAgentIdInput } from "@/lib/nadBoard";
import type { NadReadClient } from "@/lib/nadBoardLoad";
import {
  GATE_PRESETS,
  PROFILE_EXAMPLES,
  average,
  checkGate,
  describeGate,
  normalizeWallet,
  parseProfileQuery,
  postersLine,
  profilePath,
  tierOf,
  type GatePreset,
  type ProfileTarget,
} from "@/lib/nadProfile";
import { loadNadProfile, type NadProfileData } from "@/lib/nadProfileLoad";
import { shortAddress } from "@/lib/format";
import styles from "./NadProfile.module.css";

const sameTarget = (a: ProfileTarget, b: ProfileTarget) =>
  a.kind === "agent" && b.kind === "agent"
    ? a.agentId === b.agentId
    : a.kind === "wallet" && b.kind === "wallet" && a.wallet.toLowerCase() === b.wallet.toLowerCase();

export function NadProfile() {
  const { address } = useAccount(),
    client = usePublicClient();
  const [id, setId] = useState("0"),
    [human, setHuman] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState<"" | "ok" | "failed">(""),
    [gate, setGate] = useState<GatePreset["id"]>("proven");
  const [data, setData] = useState<NadProfileData>();
  const humanTouched = useRef(false),
    autoLoaded = useRef(false),
    latest = useRef(0);
  const explorer = getActiveNetwork().explorerUrl;

  // Prefill the connected wallet unless the visitor typed one or arrived through a ?wallet= link.
  useEffect(() => {
    if (address && !humanTouched.current) setHuman(address);
  }, [address]);

  const run = useCallback(
    async (target: ProfileTarget) => {
      if (!client) return;
      const request = ++latest.current;
      setBusy(true);
      setError("");
      setCopied("");
      setData(undefined);
      try {
        const next = await loadNadProfile(
          client as unknown as NadReadClient,
          { adapter: CONTRACTS.BOUNTY_ADAPTER, identityRegistry: CONTRACTS.IDENTITY_REGISTRY },
          target,
        );
        if (request !== latest.current) return;
        setData(next);
        window.history.replaceState(null, "", profilePath(target));
      } catch (e) {
        if (request === latest.current) setError(e instanceof Error ? e.message : "Could not read profile");
      } finally {
        if (request === latest.current) setBusy(false);
      }
    },
    [client],
  );

  const show = useCallback(
    (target: ProfileTarget) => {
      humanTouched.current = true;
      if (target.kind === "agent") setId(String(target.agentId));
      else {
        setId("0");
        setHuman(target.wallet);
      }
      void run(target);
    },
    [run],
  );

  // Deep links: ?agent=<id> and ?wallet=<0x..> fill the form and load the profile once the client is ready.
  useEffect(() => {
    if (!client || autoLoaded.current) return;
    autoLoaded.current = true;
    const target = parseProfileQuery(window.location.search);
    if (target) show(target);
  }, [client, show]);

  function submit() {
    setError("");
    const agentId = parseAgentIdInput(id);
    if (agentId === null) return setError("Agent ID must be a number. Use 0 or leave it empty for a human wallet.");
    if (agentId > 0n) return void run({ kind: "agent", agentId });
    const wallet = normalizeWallet(human);
    if (!wallet) return setError("Enter a valid wallet address (0x...) or an agent ID.");
    void run({ kind: "wallet", wallet });
  }

  async function copyLink() {
    if (!data) return;
    const url = `${window.location.origin}${profilePath(data.target)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
  }

  const humanMode = parseAgentIdInput(id) === 0n;
  const total = data?.total,
    tier = total ? tierOf(total[0], total[1]) : null;
  const preset = GATE_PRESETS.find((p) => p.id === gate) ?? GATE_PRESETS[0];
  const gateCheck = total ? checkGate(total[0], total[1], preset.minJobs, preset.minAvg) : null;
  const zero = "0x0000000000000000000000000000000000000000";

  return (
    <>
      <header className="page-head">
        <h1>Identity reputation</h1>
        <p className="sub">
          Scored paid jobs on Monad, plus Base and Arc records synchronized for the current identity owner.
          Working-wallet changes do not move the identity&apos;s reputation.
        </p>
      </header>

      <section className={styles.examples} aria-label="Examples">
        <div className="filters-head" style={{ marginTop: 0 }}>
          <div className="label">Try an example</div>
        </div>
        <div className="tpl-grid">
          {PROFILE_EXAMPLES.map((example) => (
            <button
              key={example.id}
              type="button"
              className={`tpl-card${data && sameTarget(data.target, example.target) ? " active" : ""}`}
              onClick={() => show(example.target)}
              disabled={busy}
            >
              <span className="tpl-title">{example.title}</span>
              <span className="tpl-pitch">{example.note}</span>
              {example.detail && <span className={`tpl-meta ${styles.exampleAddr}`}>{example.detail}</span>}
            </button>
          ))}
        </div>
      </section>

      <form
        className="form-card"
        style={{ marginTop: 22 }}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="form-grid-2">
          <div className="form-row">
            <label className="form-label" htmlFor="profile-agent">
              Agent ID <span className="hint">0 for a human</span>
            </label>
            <input
              id="profile-agent"
              className="input"
              inputMode="numeric"
              value={id}
              onChange={(e) => setId(e.target.value)}
            />
          </div>
          {humanMode && (
            <div className="form-row">
              <label className="form-label" htmlFor="profile-human">
                Human wallet
              </label>
              <input
                id="profile-human"
                className="input"
                value={human}
                onChange={(e) => {
                  humanTouched.current = true;
                  setHuman(e.target.value);
                }}
                placeholder="0x…"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          )}
        </div>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary btn-big" disabled={busy}>
          {busy ? "Reading…" : "Read on-chain profile"}
        </button>
      </form>

      {data && total && (
        <div className={styles.results}>
          <div className="filters-head" style={{ marginTop: 0 }}>
            <div className="label">
              {data.target.kind === "agent" ? `Agent #${data.agentId}` : `Wallet ${shortAddress(data.owner)}`}
            </div>
            <div className="toggles">
              <button type="button" className="btn" onClick={() => void copyLink()}>
                Copy profile link
              </button>
            </div>
          </div>
          <p className={styles.copied} role="status" aria-live="polite" style={{ margin: "0 0 12px" }}>
            {copied === "ok" && "Link copied."}
            {copied === "failed" && `Could not copy automatically. The link is ${profilePath(data.target)}`}
          </p>

          <div className="stat-grid">
            <div className="stat-card">
              <div className="stat-label">Paid jobs</div>
              <div className="stat-value">{String(total[0])}</div>
              <div className="stat-hint">Monad plus mirrored Base and Arc</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Total score</div>
              <div className="stat-value">{String(total[1])}</div>
              <div className="stat-hint">exact, never rounded</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Average score</div>
              <div className="stat-value">{average(total[0], total[1])}</div>
              <div className="stat-hint">{tier ? `${tier} tier` : "no tier yet"}</div>
            </div>
          </div>

          <section className="panel">
            <div className="panel-head">
              <span className="title">Identity</span>
            </div>
            <p className={styles.line}>
              Current owner{" "}
              <a
                className={`${styles.mono} ${styles.link}`}
                href={`${explorer}/address/${data.owner}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {data.owner}
              </a>
            </p>
            {data.target.kind === "agent" && (
              <p className={styles.line}>
                Current working wallet{" "}
                {data.working ? <code className={styles.mono}>{data.working}</code> : <span>not set</span>}
              </p>
            )}
            {data.uniquePosters !== null && (
              <>
                <p className={styles.line}>
                  <strong>{postersLine(data.uniquePosters)}</strong>
                </p>
                <p className={styles.muted}>
                  The reputation gate counts paid jobs, so the number of different posters is shown for transparency.
                </p>
              </>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <span className="title">Check a gate</span>
            </div>
            <p className={styles.muted}>
              A poster can require a minimum reputation to take a bounty or enter a contest. Pick a gate to see whether
              this identity would pass it.
            </p>
            <div className={`seg ${styles.gateButtons}`} role="group" aria-label="Reputation gate">
              {GATE_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={gate === p.id ? "active" : undefined}
                  aria-pressed={gate === p.id}
                  onClick={() => setGate(p.id)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {gateCheck && (
              <div className={styles.verdict} role="status" aria-live="polite">
                <div className={`${styles.verdictTitle} ${gateCheck.pass ? styles.ok : styles.bad}`}>
                  {gateCheck.pass ? "Passes" : "Does not pass"} the {preset.label} gate
                </div>
                <div className={styles.muted}>
                  {String(preset.minJobs)}+ paid jobs and {String(preset.minAvg)}+ average, checked with integer math:
                  total score must be at least {String(preset.minAvg)} x paid jobs.
                </div>
                <ul className={styles.lines}>
                  {describeGate(gateCheck).map((line) => (
                    <li key={line.label}>
                      <span>
                        {line.label}: <strong>{line.value}</strong>
                      </span>
                      <span className={styles.muted}>needs {line.need}</span>
                      <span className={line.ok ? styles.ok : styles.bad}>{line.ok ? "ok" : "short"}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <div className="stat-grid" style={{ marginTop: 22 }}>
            {data.sources.map((source) => {
              const [jobs, sum, block, updated] = source.record;
              return (
                <div className="stat-card" key={source.name}>
                  <div className="stat-label">{source.name} record</div>
                  {block === 0n ? (
                    <>
                      <div className="stat-value">-</div>
                      <div className="stat-hint">No synchronized record.</div>
                    </>
                  ) : (
                    <>
                      <div className="stat-value">{String(jobs)} paid</div>
                      <div className="stat-hint">
                        score sum {String(sum)} · average {average(jobs, sum)}
                      </div>
                      <div className="stat-hint">
                        Source: {source.name} (chain {String(source.chainId)}), block {String(block)} · updated{" "}
                        {new Date(Number(updated) * 1000).toLocaleString()}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
          <p className={styles.muted} style={{ marginTop: 18 }}>
            Base and Arc records are copied to Monad by our relayer wallet. Each record shows its source chain and block
            so you can verify it yourself.{" "}
            {data.relayer.toLowerCase() === zero ? "The relayer is currently disabled." : ""}
          </p>
        </div>
      )}
      <footer className="spacer" />
    </>
  );
}
