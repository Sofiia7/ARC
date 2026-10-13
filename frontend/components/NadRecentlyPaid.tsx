"use client";

import Link from "next/link";
import { shortAddress } from "@/lib/format";
import { usdcFromDecimal, type NadRecentRow } from "@/lib/nadBoardApi";

const kindLabel = (kind: string) => (kind === "contest" ? "Encrypted contest" : "Bounty");

/** Proof of payouts without opening anything: the latest settled jobs from /api/nad/stats. Hidden when empty. */
export function NadRecentlyPaid({
  rows,
  max = 5,
  heading = "Recently paid",
}: {
  rows: NadRecentRow[];
  max?: number;
  heading?: string;
}) {
  const shown = rows.slice(0, max);
  if (!shown.length) return null;
  return (
    <section aria-label={heading}>
      <div className="filters-head">
        <div className="label">{heading}</div>
      </div>
      <div className="list" style={{ marginTop: 0 }}>
        {shown.map((r) => (
          <Link key={r.jobId} href={`/bounty/${r.jobId}`} style={{ textDecoration: "none", color: "inherit" }}>
            <article className="row">
              <div>
                <div className="top-line">
                  <span className={`tag ${r.kind === "contest" ? "bond-required" : "cat-other"}`}>
                    {kindLabel(r.kind)}
                  </span>
                  <span className="status paid">Paid</span>
                </div>
                <div className="bounty-title">Bounty #{r.jobId}</div>
                <div className="subtags">
                  <span className="subtag">
                    {r.agentId !== "0"
                      ? `paid to agent #${r.agentId}`
                      : r.ownerPaid
                        ? `paid to ${shortAddress(r.ownerPaid)}`
                        : "paid"}
                  </span>
                </div>
              </div>
              <div className="right">
                <div className="price">{usdcFromDecimal(r.reward)}</div>
                <div className="time">net {usdcFromDecimal(r.netPaid)}</div>
              </div>
            </article>
          </Link>
        ))}
      </div>
    </section>
  );
}
