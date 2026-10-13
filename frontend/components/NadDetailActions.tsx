"use client";

import Link from "next/link";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { Address, ContractFunctionReturnType } from "viem";
import type { BOUNTY_ADAPTER_V48_ABI as ABI } from "@/lib/abi-v48";
import { shortAddress } from "@/lib/format";
import { parseScore, settlementText, type TextIntent } from "@/lib/nadActions";
import type { NadSettlement } from "@/lib/nadKeeper";
import type { ContestPaymentMethod } from "@/lib/nadContestActions";
import { workerBondFor } from "@/lib/nadMoney";
import { DISPUTE_RESPONSE_WINDOW } from "@/lib/nadTimeline";
import { formatUsdcUnits } from "@/lib/nadStats";
import type { Entry, Meta } from "@/lib/nadStatus";
import { ActionButton, button } from "./nadShared";
import flow from "./NadFlow.module.css";

export type Challenge = ContractFunctionReturnType<typeof ABI, "view", "getContestChallenge">;
export type Reasons = {
  enter: string | null;
  take: string | null;
  submitWork: string | null;
  approve: string | null;
  reject: string | null;
  cancel: string | null;
  pay: string | null;
  rejectAll: string | null;
  respond: string | null;
  challenge: string | null;
};
type Run = (name: string, args: unknown[]) => Promise<void>;
type RunEvidence = (name: string, args?: unknown[]) => Promise<void>;
const small: React.CSSProperties = { fontSize: 13, color: "var(--ink-soft)" };

/** "Your action" panel: the one text box (labelled for what it is used for) and the buttons passed as children. */
export function ActionPanel({
  picker,
  intent,
  showText,
  text,
  setText,
  children,
}: {
  picker?: ReactNode;
  intent: TextIntent;
  showText: boolean;
  text: string;
  setText: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <span className="title">Your action</span>
      </div>
      {picker}
      {showText && (
        <div className="form-row">
          <label className="form-label" htmlFor="result-text">
            {intent.label}
          </label>
          <textarea
            id="result-text"
            className="textarea"
            rows={5}
            value={text}
            aria-describedby="result-text-hint"
            onChange={(e) => setText(e.target.value)}
          />
          <p id="result-text-hint" className={flow.hint} style={{ marginTop: 6 }}>
            {intent.hint}
          </p>
        </div>
      )}
      {children}
    </section>
  );
}

/** Buttons for someone who is not the poster: enter a contest, take a bounty, submit work or challenge a rejection. */
export function WorkerActions({
  meta,
  closed,
  ownsAssigned,
  reasons,
  disabled,
  submit,
  take,
  challengeRejection,
}: {
  meta: Meta;
  closed: bigint;
  ownsAssigned: boolean;
  reasons: Reasons;
  disabled: boolean;
  submit: () => Promise<void>;
  take: () => Promise<void>;
  challengeRejection: () => Promise<void>;
}) {
  if (meta.contest) {
    if (closed > 0n) return <p className={flow.hint}>This contest has closed. Entries can no longer be added.</p>;
    return (
      <div className={flow.actions}>
        <ActionButton
          id="enter"
          label="Submit sealed entry"
          disabled={disabled}
          reason={reasons.enter}
          onClick={() => void submit()}
        />
      </div>
    );
  }
  if (!meta.isTaken) {
    return (
      <div className={flow.actions}>
        <ActionButton
          id="take"
          label="Take bounty"
          disabled={disabled}
          reason={reasons.take}
          onClick={() => void take()}
        />
      </div>
    );
  }
  if (!ownsAssigned) return <p className={flow.hint}>Someone is already working on this bounty.</p>;
  return (
    <div className={flow.actions}>
      {!meta.submittedResultHash && (
        <ActionButton
          id="submit-work"
          label="Submit work"
          disabled={disabled}
          reason={reasons.submitWork}
          onClick={() => void submit()}
        />
      )}
      {meta.rejectedAt > 0n && (
        <ActionButton
          id="challenge-rejection"
          label="Challenge rejection"
          disabled={disabled}
          reason={reasons.challenge}
          onClick={() => void challengeRejection()}
        />
      )}
      {meta.submittedResultHash && meta.rejectedAt === 0n && (
        <p className={flow.hint}>
          Your work is submitted. The poster has 14 days to approve or reject it; after that anyone can release your
          payment.
        </p>
      )}
    </div>
  );
}

/** Buttons for the poster: pay or reject, respond to a dispute, cancel. */
export function PosterActions({
  meta,
  entryCount,
  selectedCount,
  paymentMethod,
  reasons,
  disabled,
  approveScore,
  setApproveScore,
  approve,
  paySelected,
  evidenceAction,
  action,
}: {
  meta: Meta;
  entryCount: number;
  selectedCount: number;
  paymentMethod: ContestPaymentMethod | null;
  reasons: Reasons;
  disabled: boolean;
  approveScore: string;
  setApproveScore: (value: string) => void;
  approve: () => Promise<void>;
  paySelected: () => Promise<void>;
  evidenceAction: RunEvidence;
  action: Run;
}) {
  const score = parseScore(approveScore);
  const cancel = (
    <ActionButton
      id="cancel"
      className="btn"
      label="Cancel and refund"
      disabled={disabled}
      reason={reasons.cancel}
      onClick={() => void action("cancelBounty", [])}
    />
  );
  if (meta.contest) {
    return (
      <div className={flow.actions}>
        <ActionButton
          id="pay"
          label={meta.inDispute ? "Accept challengers" : "Pay selected winners"}
          disabled={disabled}
          reason={reasons.pay}
          onClick={() => void paySelected()}
        />
        <ActionButton
          id="reject-all"
          className="btn btn-danger"
          label="Reject all with reason"
          disabled={disabled}
          reason={reasons.rejectAll}
          onClick={() => void evidenceAction("rejectAllContestEntries")}
        />
        {meta.inDispute && (
          <ActionButton
            id="respond"
            label="Respond to challenges"
            disabled={disabled}
            reason={reasons.respond}
            onClick={() => void evidenceAction("respondToContestChallenges")}
          />
        )}
        {cancel}
      </div>
    );
  }
  const reviewing = !!meta.submittedResultHash && meta.rejectedAt === 0n && !meta.inDispute;
  return (
    <>
      {reviewing && (
        <div className="form-row">
          <label className="form-label" htmlFor="approve-score">
            Score <span className="hint">0-100, counts toward the worker&apos;s reputation</span>
          </label>
          <input
            id="approve-score"
            className="input"
            inputMode="numeric"
            style={{ maxWidth: 140 }}
            value={approveScore}
            aria-invalid={!score.ok}
            aria-describedby={score.ok ? undefined : "approve-score-error"}
            onChange={(e) => setApproveScore(e.target.value)}
          />
          {!score.ok && (
            <p id="approve-score-error" role="alert" className={flow.error} style={{ marginTop: 6 }}>
              {score.error}
            </p>
          )}
        </div>
      )}
      {!meta.isTaken && <p className={flow.hint}>Waiting for someone to take this bounty.</p>}
      {meta.isTaken && !meta.submittedResultHash && <p className={flow.hint}>Waiting for the worker to submit.</p>}
      {meta.rejectedAt > 0n && !meta.inDispute && (
        <p className={flow.hint}>
          You rejected this work. The worker has 48 hours to challenge, then the reward is refunded to you.
        </p>
      )}
      <div className={flow.actions}>
        {reviewing && (
          <>
            <ActionButton
              id="approve"
              label="Approve and pay"
              disabled={disabled}
              reason={reasons.approve}
              onClick={() => void approve()}
            />
            <ActionButton
              id="reject"
              className="btn btn-danger"
              label="Reject with reason"
              disabled={disabled}
              reason={reasons.reject}
              onClick={() => void evidenceAction("rejectBounty")}
            />
          </>
        )}
        {meta.inDispute && (
          <ActionButton
            id="respond"
            label="Respond to dispute"
            disabled={disabled}
            reason={reasons.respond}
            onClick={() => void evidenceAction("respondToDispute")}
          />
        )}
        {cancel}
      </div>
    </>
  );
}

/** A deposit line shown to someone about to take a bond bounty. */
export function DepositNote({ reward }: { reward: bigint }) {
  return (
    <p className={flow.hint}>
      Taking this bounty locks a refundable deposit of {formatUsdcUnits(workerBondFor(reward))} USDC (15% of the reward,
      at least 0.50 USDC). It is returned when you submit work, and goes to the poster if you take it and never deliver.
    </p>
  );
}

/** Shown once the on-chain deadline has passed and a permissionless settlement call is available. */
export function SettlementPanel({
  settlement,
  meta,
  disabled,
  action,
}: {
  settlement: NadSettlement;
  meta: Meta;
  disabled: boolean;
  action: Run;
}) {
  const text = settlementText(settlement, {
    contest: meta.contest,
    isTaken: meta.isTaken,
    disputeByWorker: meta.disputeByWorker,
  });
  return (
    <section className="panel warning">
      <div className="panel-head">
        <span className="title">Settlement open</span>
      </div>
      <p style={{ margin: 0 }}>
        A deadline has passed. Anyone can submit this settlement, not only the poster or the worker.
      </p>
      <p className={flow.hint}>{text.description}</p>
      <button className={button} disabled={disabled} onClick={() => void action(settlement, [])}>
        {text.button}
      </button>
    </section>
  );
}

const SCORE_ERROR = "Whole number from 0 to 100.";

/** Contest entries: sealed or decrypted text, winner selection and scores for the poster, replace/challenge for entrants. */
export function EntriesList({
  meta,
  entries,
  challenges,
  plain,
  selected,
  scores,
  setSelected,
  setScores,
  poster,
  address,
  paymentMethod,
  disabled,
  ownsEntry,
  replaceEntry,
  evidenceAction,
  replaceReason,
  challengeReason,
}: {
  meta: Meta;
  entries: readonly Entry[];
  challenges: Challenge[];
  plain: Record<number, string>;
  selected: number[];
  scores: Record<number, string>;
  setSelected: Dispatch<SetStateAction<number[]>>;
  setScores: Dispatch<SetStateAction<Record<number, string>>>;
  poster: boolean;
  address?: Address;
  paymentMethod: ContestPaymentMethod | null;
  disabled: boolean;
  ownsEntry: (entry: { agentId: bigint; entrant: Address }) => boolean;
  replaceEntry: (index: number) => Promise<void>;
  evidenceAction: RunEvidence;
  replaceReason: string | null;
  challengeReason: (index: number) => string | null;
}) {
  return (
    <section style={{ marginTop: 22 }} aria-label="Entries">
      <div className="panel-head">
        <span className="title">
          Entries · {entries.length}/{meta.maxEntries}
        </span>
      </div>
      {entries.length === 0 && (
        <p className={flow.hint} style={{ marginTop: 12 }}>
          No entries yet.
        </p>
      )}
      {entries.map((entry, i) => {
        const challenged = challenges[i]?.challengedAt > 0n;
        const mine = !!address && ownsEntry(entry);
        const state = entry.awarded
          ? { kind: "paid", label: "Awarded" }
          : challenged
            ? { kind: "in-review", label: "Challenged" }
            : meta.resolved
              ? { kind: "expired", label: "Not selected" }
              : { kind: "submitted", label: "Submitted" };
        return (
          <article className="panel" key={i}>
            <div className={flow.entryHead}>
              <p className={flow.entryWho}>
                #{i + 1} ·{" "}
                {entry.agentId !== 0n ? (
                  <Link href={`/profile?agent=${entry.agentId}`}>Agent #{String(entry.agentId)}</Link>
                ) : (
                  <Link href={`/profile?wallet=${entry.entrant}`}>Human wallet</Link>
                )}{" "}
                · <code className={flow.mono}>{shortAddress(entry.entrant)}</code>{" "}
                {mine && <span className={flow.you}>your entry</span>}
              </p>
              <span className={`status ${state.kind}`}>{state.label}</span>
            </div>
            {plain[i] ? (
              <pre className="desc-card" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 }}>
                {plain[i]}
              </pre>
            ) : (
              <p className={flow.hint}>Sealed entry: only the poster can read it.</p>
            )}
            {poster && paymentMethod && (!meta.inDispute || challenged) && (
              <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.includes(i)}
                    onChange={(e) => setSelected((s) => (e.target.checked ? [...s, i] : s.filter((x) => x !== i)))}
                  />{" "}
                  Select winner
                </label>
                <label>
                  Score{" "}
                  <input
                    className="input"
                    inputMode="numeric"
                    style={{ width: 90 }}
                    value={scores[i] ?? "90"}
                    aria-invalid={!parseScore(scores[i] ?? "90").ok}
                    aria-label={`Score for entry ${i + 1}, 0 to 100`}
                    onChange={(e) => setScores((s) => ({ ...s, [i]: e.target.value }))}
                  />
                </label>
                {!parseScore(scores[i] ?? "90").ok && (
                  <span role="alert" className={flow.error}>
                    {SCORE_ERROR}
                  </span>
                )}
              </div>
            )}
            {!poster && mine && !meta.resolved && (
              <div className={flow.actions}>
                {!meta.rejectedAt && (
                  <ActionButton
                    id={`replace-${i}`}
                    label="Replace sealed entry"
                    disabled={disabled}
                    reason={replaceReason}
                    onClick={() => void replaceEntry(i)}
                  />
                )}
                {meta.rejectedAt > 0n && (
                  <ActionButton
                    id={`challenge-${i}`}
                    label="Challenge this entry"
                    disabled={disabled}
                    reason={challengeReason(i)}
                    onClick={() => void evidenceAction("challengeContestRejection", [i])}
                  />
                )}
              </div>
            )}
            {challenged && (
              <p style={{ ...small, margin: 0 }}>
                Poster response due{" "}
                {new Date(Number(challenges[i].challengedAt + DISPUTE_RESPONSE_WINDOW) * 1000).toLocaleString()} ·{" "}
                {challenges[i].respondedAt > 0n ? "responded" : "awaiting response"}
              </p>
            )}
          </article>
        );
      })}
    </section>
  );
}
