"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ipfsUrl } from "@/lib/ipfs";
import { formatUsdcUnits } from "@/lib/nadStats";
import { getActiveNetwork } from "@/lib/networks";
import { phaseWhenText, timelineRules, type TimelinePhase } from "@/lib/nadTimeline";
import type { Outcome } from "@/lib/nadOutcome";
import { shortAddress } from "@/lib/format";
import { NadTelegram } from "./NadTelegram";
import flow from "./NadFlow.module.css";

const when = (ts: bigint) =>
  new Date(Number(ts) * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const STATE_WORD = { done: "done", current: "in progress", upcoming: "upcoming", skipped: "not needed" } as const;
const PHASE_CLASS = {
  done: flow.phaseDone,
  current: flow.phaseCurrent,
  upcoming: flow.phaseUpcoming,
  skipped: flow.phaseSkipped,
} as const;

/** The windows that apply to this bounty, with real dates in chain time. The current one is highlighted. */
export function TimelinePanel({ phases, now }: { phases: readonly TimelinePhase[]; now: bigint }) {
  if (phases.length === 0) return null;
  return (
    <section className="panel" aria-label="Timeline">
      <div className="panel-head">
        <span className="title">Timeline</span>
        <span className="meta">dates in your local time</span>
      </div>
      <ol className={flow.timeline}>
        {phases.map((phase) => {
          return (
            <li
              key={phase.id}
              className={`${flow.phase} ${PHASE_CLASS[phase.state]}`}
              aria-current={phase.state === "current" ? "step" : undefined}
            >
              <span className={flow.dot} aria-hidden="true" />
              <div className={flow.phaseBody}>
                <div className={flow.phaseTitle}>
                  <span>
                    {phase.label} <span className={flow.srOnly}>({STATE_WORD[phase.state]})</span>
                  </span>
                  <span className={flow.phaseWhen}>{phaseWhenText(phase, now, when)}</span>
                </div>
                {(phase.state === "current" || phase.state === "upcoming") && (
                  <p className={flow.phaseNote}>{phase.note}</p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <details>
        <summary className={flow.hint} style={{ cursor: "pointer" }}>
          How the windows work
        </summary>
        <ul className={flow.rules}>
          {timelineRules().map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function AddressLink({ address }: { address: string }) {
  return (
    <a href={`${getActiveNetwork().explorerUrl}/address/${address}`} target="_blank" rel="noopener noreferrer">
      <code className={flow.mono}>{shortAddress(address)}</code>
    </a>
  );
}

const usdc = (units: bigint) => `${formatUsdcUnits(units)} USDC`;

/** Who was paid what (or refunded) for a settled bounty. */
export function OutcomePanel({ outcome, feePercent = "1%" }: { outcome: Outcome; feePercent?: string }) {
  const feeLabel = outcome.fee > 0n ? `Protocol fee (${feePercent})` : "Protocol fee";
  const winners = outcome.payees.filter((p) => p.role !== "poster");
  const poster = outcome.payees.find((p) => p.role === "poster");
  return (
    <section className="panel" aria-label="Outcome">
      <div className="panel-head">
        <span className="title">Outcome</span>
        <span className="meta">{outcome.approximate ? "amounts are approximate" : "exact amounts"}</span>
      </div>
      <p className={flow.outcomeHead}>{outcome.title}</p>
      {outcome.reasonText && <p style={{ margin: 0, color: "var(--ink-soft)" }}>{outcome.reasonText}</p>}
      {outcome.kind !== "unknown" && (
        <dl className={flow.kv}>
          <dt>Escrowed reward</dt>
          <dd>{usdc(outcome.gross)}</dd>
          {winners.map((p) => (
            <Fragment key={`${p.role}-${p.entryIndex ?? "w"}-${p.agentId}`}>
              <dt>
                Paid to {p.who}
                <span className={flow.kvSub}>
                  {p.entryIndex !== null && <>entry #{p.entryIndex + 1} · </>}
                  {p.agentId !== 0n ? (
                    <Link href={`/profile?agent=${p.agentId}`}>agent #{String(p.agentId)}</Link>
                  ) : p.address ? (
                    <Link href={`/profile?wallet=${p.address}`}>wallet profile</Link>
                  ) : null}
                  {p.address && (
                    <>
                      {p.agentId !== 0n || p.entryIndex !== null ? " · " : ""}
                      <AddressLink address={p.address} />
                    </>
                  )}
                </span>
              </dt>
              <dd>{usdc(p.amount)}</dd>
            </Fragment>
          ))}
          {outcome.fee > 0n && (
            <Fragment>
              <dt>
                {feeLabel}
                <span className={flow.kvSub}>
                  paid to the fee recipient{outcome.feeRecipient ? " " : ""}
                  {outcome.feeRecipient && <AddressLink address={outcome.feeRecipient} />}
                </span>
              </dt>
              <dd>{usdc(outcome.fee)}</dd>
            </Fragment>
          )}
          {poster && (
            <Fragment>
              <dt>
                {outcome.kind === "refunded" ? "Refunded to the poster" : "Returned to the poster"}
                {poster.address && (
                  <span className={flow.kvSub}>
                    <AddressLink address={poster.address} />
                  </span>
                )}
              </dt>
              <dd>{usdc(poster.amount)}</dd>
            </Fragment>
          )}
          {outcome.remainder > 0n && (
            <Fragment>
              <dt>Rounding</dt>
              <dd>{usdc(outcome.remainder)}</dd>
            </Fragment>
          )}
        </dl>
      )}
      {outcome.results.length > 0 && (
        <div>
          <p className="form-label" style={{ marginBottom: 6 }}>
            {outcome.results[0].sealed ? "Winning entries" : "Delivered result"}
          </p>
          <ul className={flow.noteList}>
            {outcome.results.map((result) => (
              <li key={`${result.cid}-${result.entryIndex}`}>
                {result.sealed && result.entryIndex !== null ? `Entry #${result.entryIndex + 1}: ` : ""}
                <a href={ipfsUrl(result.cid)} target="_blank" rel="noopener noreferrer">
                  {result.sealed ? "sealed entry (ciphertext) on IPFS" : "result on IPFS"}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {outcome.notes.length > 0 && (
        <ul className={flow.noteList}>
          {outcome.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Shown once after posting (?posted=1): the share link, a copy button and the Telegram reminders. */
export function PostedBanner({ url, showTelegram }: { url: string; showTelegram: boolean }) {
  const [copied, setCopied] = useState<"idle" | "ok" | "failed">("idle");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (copied === "idle") return;
    const timer = setTimeout(() => setCopied("idle"), 2500);
    return () => clearTimeout(timer);
  }, [copied]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("ok");
    } catch {
      input.current?.select();
      setCopied("failed");
    }
  }
  return (
    <>
      <section className={flow.banner} role="status" aria-label="Bounty created">
        <h2>Your bounty is live.</h2>
        <p style={{ margin: 0, color: "var(--ink-soft)" }}>
          The reward is locked in escrow. Share the link so agents and people can find it.
        </p>
        <div className={flow.shareRow}>
          <input
            ref={input}
            className="input"
            readOnly
            value={url}
            aria-label="Link to this bounty"
            onFocus={(e) => e.currentTarget.select()}
          />
          <button type="button" className="btn btn-primary" onClick={() => void copy()}>
            {copied === "ok" ? "Copied" : "Copy link"}
          </button>
        </div>
        <span className={flow.srOnly} aria-live="polite">
          {copied === "ok" ? "Link copied" : copied === "failed" ? "Press Ctrl+C to copy the selected link" : ""}
        </span>
        {copied === "failed" && (
          <p className={flow.hint}>Your browser blocked copying. The link is selected: press Ctrl+C or Cmd+C.</p>
        )}
      </section>
      {showTelegram && <NadTelegram />}
    </>
  );
}
