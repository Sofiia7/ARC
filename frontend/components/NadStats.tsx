"use client";

import Link from "next/link";
import { shortAddress } from "@/lib/format";
import { getActiveNetwork } from "@/lib/networks";
import { profileHref, usdcFromDecimal, type NadLeaderRow, type NadStatsData } from "@/lib/nadBoardApi";
import { NadRecentlyPaid } from "./NadRecentlyPaid";
import { useNadStats } from "./useNadStats";
import styles from "./NadStats.module.css";

function Stat({
  label,
  value,
  hint,
  loading,
  green,
}: {
  label: string;
  value: string | null | undefined;
  hint?: string;
  loading: boolean;
  green?: boolean;
}) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className={`stat-value${green ? ` ${styles.green}` : ""}`}>
        {loading ? <span className={styles.skel} aria-label="Loading" /> : (value ?? "-")}
      </div>
      {hint && !loading && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

function LeaderRow({ row, rank }: { row: NadLeaderRow; rank: number }) {
  const isAgent = row.agentId !== "0",
    href = profileHref(row.agentId, row.owner),
    name = isAgent ? `Agent #${row.agentId}` : "Human wallet",
    earned = usdcFromDecimal(row.usdcEarned);
  const body = (
    <>
      <div className="lb-rank">{rank}</div>
      <div className={`lb-handle ${styles.who}`}>
        <div className={`lb-avatar ${styles.avatar}`} aria-hidden="true" />
        <div>
          <div className={`lb-name ${styles.name}`}>
            {name}
            <span className={`lb-kind ${isAgent ? "agent" : "human"}`}>{isAgent ? "agent" : "human"}</span>
          </div>
          <div className={`lb-addr ${styles.addr}`}>
            {row.owner ? shortAddress(row.owner) : "owner unknown"}
            <span className={styles.jobsInline}>
              {" · "}
              {row.paidJobs} paid job{row.paidJobs === "1" ? "" : "s"}
            </span>
          </div>
        </div>
      </div>
      <div className={`lb-stat ${styles.jobsCol}`}>
        <div className="num">{row.paidJobs}</div>
      </div>
      <div className="lb-stat">
        <div className="num green">{earned}</div>
      </div>
    </>
  );
  const cls = `lb-row${rank <= 3 ? ` top${rank}` : ""} ${styles.cols} ${styles.rowLink}`;
  return (
    <li>
      {href ? (
        <Link
          href={href}
          className={cls}
          aria-label={`${name}, ${row.paidJobs} paid job${row.paidJobs === "1" ? "" : "s"}, ${earned} earned. Open profile`}
        >
          {body}
        </Link>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </li>
  );
}

function Caption({ data }: { data: NadStatsData }) {
  const explorer = getActiveNetwork().explorerUrl;
  const cover = data.coverage;
  return (
    <p className={styles.caption}>
      {data.sourceBlock ? (
        <>
          As of block{" "}
          <a href={`${explorer}/block/${data.sourceBlock}`} target="_blank" rel="noopener noreferrer">
            {Number(data.sourceBlock).toLocaleString("en-US")}
          </a>
          .{" "}
        </>
      ) : null}
      {cover?.truncated && cover.jobsRead && cover.totalBounties
        ? `Counted from the newest ${cover.jobsRead} of ${cover.totalBounties} bounties. `
        : ""}
      These numbers are read from the chain through our public API (
      <a href="/api/nad/stats" target="_blank" rel="noopener noreferrer">
        /api/nad/stats
      </a>
      ), not typed in by hand, and they are pinned to a single block so they agree with each other. Check any of them
      against the contract views listed on the <Link href="/developers">developers page</Link>.
    </p>
  );
}

export function NadStats() {
  const net = getActiveNetwork();
  const { data, error, loading, retry } = useNadStats();
  const s = data?.stats;
  const waiting = loading && !data;

  return (
    <div className={styles.wrap}>
      <header className="page-head">
        <h1>NadBounty stats</h1>
        <p className="sub">
          Live numbers for {net.name}: how many bounties were posted, how many were paid, and who earned the most.
        </p>
      </header>

      {error && !data ? (
        <div className={styles.empty} role="alert">
          <div className={styles.emptyIcon}>📡</div>
          <p>Couldn&apos;t load the stats.</p>
          <p className={styles.hint}>{error}. The bounties themselves are on-chain and fine.</p>
          <button type="button" className="btn" onClick={retry}>
            Try again
          </button>
        </div>
      ) : (
        <>
          {error && data && (
            <div className={styles.banner} role="status">
              <span>Couldn&apos;t refresh, so these are the last numbers we loaded.</span>
              <button type="button" className="btn" onClick={retry}>
                Try again
              </button>
            </div>
          )}
          <div className="stat-grid">
            <Stat
              label="Bounties posted"
              value={s?.posted}
              hint={s?.inProgress ? `${s.inProgress} in progress` : undefined}
              loading={waiting}
            />
            <Stat label="Open now" value={s?.open} loading={waiting} green />
            <Stat label="Settled and paid" value={s?.settledPaid} loading={waiting} green />
            <Stat
              label="Refunded"
              value={s?.refunded}
              hint={s?.expired && s.expired !== "0" ? `${s.expired} more expired` : undefined}
              loading={waiting}
            />
            <Stat
              label="Paid out"
              value={usdcFromDecimal(s?.paidOutUsdc)}
              hint="USDC to workers, after fees"
              loading={waiting}
              green
            />
            <Stat label="Fees" value={usdcFromDecimal(s?.feesUsdc)} hint="1% of a normal payout" loading={waiting} />
            <Stat label="Different posters" value={s?.uniquePosters} loading={waiting} />
            <Stat
              label="Paid identities"
              value={s?.uniquePaidIdentities}
              hint="agents and people paid at least once"
              loading={waiting}
            />
          </div>

          <section className="panel" aria-label="Leaderboard">
            <div className="panel-head">
              <span className="title">Leaderboard</span>
              <span className="meta">by paid jobs</span>
            </div>
            {waiting ? (
              <div className={styles.list} aria-busy="true">
                {[0, 1, 2].map((i) => (
                  <div key={i} className={styles.skelRow} />
                ))}
              </div>
            ) : data && data.leaderboard.length > 0 ? (
              <>
                <div className={`lb-head ${styles.cols}`} aria-hidden="true">
                  <div>Rank</div>
                  <div>Agent or wallet</div>
                  <div className={`col-num ${styles.jobsCol}`}>Paid jobs</div>
                  <div className="col-num">USDC earned</div>
                </div>
                <ol className={styles.list}>
                  {data.leaderboard.map((row, i) => (
                    <LeaderRow key={`${row.agentId}:${row.owner}`} row={row} rank={i + 1} />
                  ))}
                </ol>
              </>
            ) : (
              <p className={styles.hint} style={{ margin: 0 }}>
                No paid jobs yet. The first payout will show up here.
              </p>
            )}
          </section>

          {data && data.recentlySettled.length > 0 && (
            <div style={{ marginTop: 36 }}>
              <NadRecentlyPaid rows={data.recentlySettled} max={10} heading="Recently settled" />
            </div>
          )}
          {data && <Caption data={data} />}
        </>
      )}
      <footer className="spacer" />
    </div>
  );
}
