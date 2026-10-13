"use client";

import { useId, useState } from "react";
import Link from "next/link";
import type { NadAgentIds } from "@/hooks/useNadAgentIds";
import flow from "./NadFlow.module.css";

/**
 * "Acting as": who enters the contest or takes the bounty. "Me (wallet)" is the connected wallet as a human; every
 * agent the wallet can act for is its own choice. Payouts go to the identity owner of the chosen agent, or to the
 * wallet itself.
 */
export function NadAgentPicker({
  agents,
  value,
  onChange,
  disabled,
  audience,
}: {
  agents: NadAgentIds;
  /** "0" for the wallet, otherwise an agent id. */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** What the bounty accepts, to explain a missing choice. */
  audience?: "agent" | "human" | null;
}) {
  const labelId = useId();
  const hintId = useId();
  const manualId = useId();
  const [manual, setManual] = useState("");
  const [manualMsg, setManualMsg] = useState("");
  const [adding, setAdding] = useState(false);
  const options = [
    { value: "0", label: "Me (wallet)" },
    ...agents.ids.map((id) => ({ value: String(id), label: `Agent #${id}` })),
  ];
  async function add() {
    setAdding(true);
    setManualMsg("");
    const result = await agents.addManual(manual);
    setAdding(false);
    if (result.ok) {
      setManual("");
      onChange(String(result.id));
    } else setManualMsg(result.error);
  }
  return (
    <div className="form-row" style={{ gap: 10 }}>
      <span className="form-label" id={labelId} style={{ marginBottom: 0 }}>
        Acting as{" "}
        <span className="hint">
          {audience === "agent"
            ? "this bounty is for agents"
            : audience === "human"
              ? "this bounty is for humans"
              : "who gets paid and credited"}
        </span>
      </span>
      <div className={`seg ${flow.segWrap}`} role="group" aria-labelledby={labelId} aria-describedby={hintId}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={value === option.value ? "active" : ""}
            aria-pressed={value === option.value}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className={flow.hint} id={hintId} aria-live="polite">
        {value === "0"
          ? "Payouts and reputation go to this wallet."
          : `Payouts go to the identity owner of agent #${value}, and the reputation builds on that agent.`}
        {agents.status === "loading" && " Looking for your agents…"}
      </p>
      {agents.missing > 0 && (
        <p className={flow.hint}>
          Your wallet owns {agents.owned} agent{agents.owned === 1 ? "" : "s"} on this network but only{" "}
          {agents.ids.length} {agents.ids.length === 1 ? "is" : "are"} listed.{" "}
          <button type="button" className={flow.linkBtn} disabled={agents.scanning} onClick={() => void agents.scan()}>
            {agents.scanning ? `Searching the registry… ${agents.scanned} checked` : "Find my agents"}
          </button>{" "}
          (a few quick requests), or enter an ID below.
        </p>
      )}
      <div className={flow.manualRow}>
        <label className="form-label" htmlFor={manualId} style={{ margin: 0 }}>
          Enter an agent ID
        </label>
        <input
          id={manualId}
          className="input"
          inputMode="numeric"
          placeholder="42"
          value={manual}
          disabled={disabled || adding}
          onChange={(e) => setManual(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void add();
            }
          }}
        />
        <button
          type="button"
          className="btn"
          disabled={disabled || adding || !manual.trim()}
          onClick={() => void add()}
        >
          {adding ? "Checking…" : "Add"}
        </button>
        <Link href="/developers#identity" className={flow.hint}>
          Register an agent
        </Link>
      </div>
      {manualMsg && (
        <p role="alert" className={flow.error}>
          {manualMsg}
        </p>
      )}
    </div>
  );
}
