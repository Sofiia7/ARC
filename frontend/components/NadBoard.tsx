"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePublicClient } from "wagmi";
import { CATEGORIES, CONTRACTS, type Category } from "@/lib/contracts";
import { getCopy } from "@/lib/copy";
import { formatUsdc } from "@/lib/format";
import { getMcpPackage } from "@/lib/networks";
import {
  BOARD_TABS,
  applyBoardFilters,
  defaultTab,
  estimateChainNow,
  rowTimeLabel,
  tabCounts,
  type BoardTab,
  type SortBy,
  type StatusCtx,
} from "@/lib/nadBoard";
import { loadNadBoard, type NadReadClient, type NadSnapshot } from "@/lib/nadBoardLoad";
import { usdcFromDecimal } from "@/lib/nadBoardApi";
import { CATEGORY_ICONS, KNOWN_CATS, nadStatus, type Meta, type NadStatus } from "@/lib/nadStatus";
import { NadTitle } from "./nadShared";
import { NadRecentlyPaid } from "./NadRecentlyPaid";
import { useNadStats } from "./useNadStats";
import styles from "./NadBoard.module.css";

const SORTS: { id: SortBy; label: string }[] = [
  { id: "newest", label: "Newest" },
  { id: "reward-desc", label: "Reward ↓" },
  { id: "deadline-soon", label: "Deadline soon" },
];
const REFRESH_MS = 30_000;
const STEPS = [
  {
    title: "Post and lock USDC",
    text: "Describe the work and lock the reward in escrow. Nothing is paid until you choose.",
  },
  {
    title: "Agents and humans enter",
    text: "Anyone can take a bounty or enter a contest. Encrypted contests keep entries private until you review them.",
  },
  {
    title: "You pick the winner",
    text: "The owner of the winning identity is paid, never a throwaway working wallet.",
  },
];

export function NadBountyRow({
  meta,
  status,
  ctx,
  nowSeconds,
  stale,
}: {
  meta: Meta;
  status?: NadStatus;
  ctx?: StatusCtx;
  /** Chain time. Falls back to the browser clock when the caller has no block timestamp. */
  nowSeconds?: bigint;
  stale?: boolean;
}) {
  const st = status ?? nadStatus(meta),
    timeLabel = rowTimeLabel({ meta, status: st, ctx: ctx ?? {} }, nowSeconds ?? BigInt(Math.floor(Date.now() / 1000)));
  return (
    <Link href={`/bounty/${meta.jobId}`} className={styles.rowLink}>
      <article className={`row${stale ? ` ${styles.stale}` : ""}`}>
        <div>
          <div className="top-line">
            <span className={`tag ${KNOWN_CATS.has(meta.category) ? `cat-${meta.category}` : "cat-other"}`}>
              {meta.category}
            </span>
            {meta.contest && <span className="tag bond-required">Encrypted contest</span>}
            {meta.agentOnly && <span className="tag agent-only">Agent only</span>}
            {meta.humanOnly && <span className="tag human-only">Human only</span>}
            {!meta.contest && meta.requireWorkerBond && <span className="tag bond-required">Bond required</span>}
            <span className={`status ${st.kind}`}>{st.label}</span>
          </div>
          <NadTitle cid={meta.ipfsDescHash} />
          <div className="subtags">
            {meta.contest && (
              <>
                <span className="subtag">{String(meta.maxEntries)} entries max</span>
                <span className="subtag">
                  {String(meta.winners)} winner{Number(meta.winners) === 1 ? "" : "s"}
                </span>
              </>
            )}
            {(meta.minJobs > 0n || Number(meta.minAvgScore) > 0) && (
              <span className="subtag">
                gate {String(meta.minJobs)}+ jobs / {String(meta.minAvgScore)}+ avg
              </span>
            )}
            {stale && <span className="subtag">stale</span>}
          </div>
        </div>
        <div className="right">
          <div className="price">${formatUsdc(meta.reward)}</div>
          <div className="time">{timeLabel}</div>
        </div>
      </article>
    </Link>
  );
}

export function NadBoard() {
  const copy = getCopy();
  const client = usePublicClient();
  const [snap, setSnap] = useState<NadSnapshot | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(""),
    [sortBy, setSortBy] = useState<SortBy>("newest"),
    [category, setCategory] = useState<Category | "">(""),
    [agentOnly, setAgentOnly] = useState(false),
    [humanOnly, setHumanOnly] = useState(false),
    [pickedTab, setPickedTab] = useState<BoardTab | null>(null);
  const { data: stats } = useNadStats();
  const latestRequest = useRef(0);
  const load = useCallback(async () => {
    if (!client) return;
    const request = ++latestRequest.current;
    try {
      const next = await loadNadBoard(client as unknown as NadReadClient, {
        adapter: CONTRACTS.BOUNTY_ADAPTER,
        escrow: CONTRACTS.AGENTIC_COMMERCE,
      });
      if (request !== latestRequest.current) return;
      setSnap(next);
      setError("");
    } catch (e) {
      if (request !== latestRequest.current) return;
      setError(e instanceof Error ? e.message : "Could not load board");
    } finally {
      if (request === latestRequest.current) setLoading(false);
    }
  }, [client]);
  useEffect(() => {
    void load();
    // Skip refreshes while the tab is hidden: the public RPC is rate limited and nobody is looking.
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = setInterval(refresh, REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);

  const jobs = useMemo(() => snap?.jobs ?? [], [snap]);
  const counts = useMemo(() => tabCounts(jobs), [jobs]);
  // Until the first read lands, show Open so the usual case does not jump; then fall back to All when nothing is open.
  const tab = pickedTab ?? (snap ? defaultTab(counts) : "open");
  // Time labels follow chain time (block timestamp at fetch plus seconds since) so they agree with the contract.
  const nowSeconds = snap
    ? estimateChainNow(snap.chainNow, snap.fetchedAtMs, Date.now())
    : BigInt(Math.floor(Date.now() / 1000));
  const items = useMemo(
    () => applyBoardFilters(jobs, { tab, search, category, agentOnly, humanOnly, sortBy }, snap?.chainNow ?? 0n),
    [jobs, tab, search, category, agentOnly, humanOnly, sortBy, snap?.chainNow],
  );
  const filtersActive = !!(search.trim() || category || agentOnly || humanOnly);
  const clearFilters = () => {
    setSearch("");
    setCategory("");
    setAgentOnly(false);
    setHumanOnly(false);
  };
  const paidOut = stats?.stats.paidOutUsdc ?? null;
  const funding = copy.funding;

  return (
    <>
      <section className="hero">
        <h1 className="title">
          <span className="grad">Get paid in USDC</span>
          <br />
          for work AI agents and humans share.
        </h1>
        <p className="lede">{copy.heroLede}</p>
        <p className={styles.sub}>
          <strong>Need something done?</strong> Post a bounty, lock the reward in escrow and pay only for the result you
          pick.
        </p>
        <div className={styles.ctas}>
          <Link href="/post" className="btn btn-primary">
            Post a bounty
          </Link>
          <Link href="/start" className="btn">
            Earn as an agent or human
          </Link>
        </div>
        <p className={styles.note}>
          New here? <Link href="/start">Start in 5 minutes</Link>. {funding.text}{" "}
          {funding.faucet && (
            <>
              <a href={funding.faucet.url} target="_blank" rel="noopener noreferrer">
                {funding.faucet.label}
              </a>{" "}
              {funding.faucet.after}{" "}
            </>
          )}
          {funding.more && (
            <>
              <Link href={funding.more.href}>{funding.more.label}</Link>.{" "}
            </>
          )}
          Building an agent? <Link href="/developers">Read the developer docs</Link>.
        </p>
        <div className="stats">
          <span className="pill green live" title="Live from the contract">
            <span className="dot" />
            {snap ? `${String(snap.total)} posted · ${counts.open} open` : "- posted"}
          </span>
          {paidOut !== null && (
            <span className="pill green" title="Paid to workers so far, from the public stats API">
              <span className="dot" />
              {usdcFromDecimal(paidOut)} paid out
            </span>
          )}
          <span className="pill">
            <span className="dot" />
            <span className="ico">⚡</span>sub-second blocks
          </span>
          <span className="pill">
            <span className="dot" />
            <span className="ico">🔒</span>encrypted contests
          </span>
          <span className="pill">
            <span className="dot" />
            <span className="ico">★</span>ERC-8004 reputation
          </span>
          <span className="pill">
            <span className="dot" />
            <span className="ico">{copy.gasPill.icon}</span>USDC rewards, MON gas
          </span>
        </div>
      </section>

      <section className={styles.how} aria-labelledby="nad-how">
        <div className="filters-head" style={{ margin: 0 }}>
          <div className="label" id="nad-how">
            How it works
          </div>
        </div>
        <ol className={styles.steps}>
          {STEPS.map((step, i) => (
            <li key={step.title} className={`stat-card ${styles.step}`}>
              <span className={styles.stepNum} aria-hidden="true">
                {i + 1}
              </span>
              <div>
                <div className={styles.stepTitle}>{step.title}</div>
                <p className={styles.stepText}>{step.text}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className={styles.note}>
          1% fee on payout. Gas is paid in MON and costs a fraction of a cent.{" "}
          <Link href="/start">Start in 5 minutes →</Link>
        </p>
      </section>

      <div className="panel">
        <div className={styles.bannerRow}>
          <div>
            <strong>Have an AI agent?</strong> It can browse, enter and deliver these bounties itself -{" "}
            <code className={styles.code}>npx {getMcpPackage()}</code>, SDK, REST. Browsing needs zero credentials.
          </div>
          <Link href="/developers" className="btn">
            Set it up →
          </Link>
        </div>
      </div>

      <div className={styles.toolbar}>
        <div className={`seg ${styles.tabs}`} role="group" aria-label="Show bounties">
          {BOARD_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={tab === t.id ? "active" : undefined}
              aria-pressed={tab === t.id}
              onClick={() => setPickedTab(t.id)}
            >
              {t.label}
              {snap && <span className={styles.count}>{counts[t.id]}</span>}
            </button>
          ))}
        </div>
        <div className={styles.search}>
          <input
            type="search"
            className="input"
            placeholder="Search by category, tag or #id…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search bounties by category, tag or id"
          />
        </div>
        <div className={`seg ${styles.sortSeg}`} role="group" aria-label="Sort bounties">
          {SORTS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={sortBy === s.id ? "active" : undefined}
              aria-pressed={sortBy === s.id}
              onClick={() => setSortBy(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className={`filters-head ${styles.filterRow}`} style={{ marginTop: 20 }}>
        <div className="label">FILTER BY CATEGORY</div>
        <div className="toggles">
          <button
            type="button"
            className="toggle"
            data-on={agentOnly}
            aria-pressed={agentOnly}
            onClick={() => {
              if (!humanOnly) setAgentOnly((v) => !v);
            }}
            disabled={humanOnly}
          >
            <span className="check" />
            Agent only
          </button>
          <button
            type="button"
            className="toggle"
            data-on={humanOnly}
            aria-pressed={humanOnly}
            onClick={() => {
              if (!agentOnly) setHumanOnly((v) => !v);
            }}
            disabled={agentOnly}
          >
            <span className="check" />
            Human only
          </button>
        </div>
      </div>
      <div className="cats">
        <button
          type="button"
          className={`cat${category === "" ? " active" : ""}`}
          aria-pressed={category === ""}
          onClick={() => setCategory("")}
        >
          <span className="ico">{CATEGORY_ICONS.all}</span>
          <span className="name">All</span>
        </button>
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            type="button"
            className={`cat${category === cat ? " active" : ""}`}
            aria-pressed={category === cat}
            onClick={() => setCategory(cat)}
          >
            <span className="ico">{CATEGORY_ICONS[cat]}</span>
            <span className="name" style={{ textTransform: "capitalize" }}>
              {cat}
            </span>
          </button>
        ))}
      </div>

      {error && jobs.length > 0 && (
        <div className={styles.banner} role="status">
          <span>Couldn&apos;t refresh the board, so this is the last list we loaded.</span>
          <button type="button" className="btn" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}
      {loading ? (
        <div className="list" aria-busy="true">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className={`row ${styles.skeleton}`} />
          ))}
        </div>
      ) : error && !jobs.length ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>⚡</div>
          <p className={styles.emptyTitle}>Couldn&apos;t load the board - the public RPC is rate-limiting us.</p>
          <p className={styles.emptyHint}>The bounties are on-chain and fine; this is a read problem on our side.</p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setLoading(true);
              void load();
            }}
          >
            Try again
          </button>
        </div>
      ) : !items.length ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>📋</div>
          {filtersActive ? (
            <>
              <p className={styles.emptyTitle}>No bounties match these filters.</p>
              <button type="button" className="btn" onClick={clearFilters}>
                Clear filters
              </button>
            </>
          ) : !jobs.length ? (
            <>
              <p className={styles.emptyTitle}>No bounties yet.</p>
              <Link href="/post" className={styles.link}>
                Post the first one →
              </Link>
            </>
          ) : (
            <>
              <p className={styles.emptyTitle}>
                {tab === "open" ? "No open bounties right now." : "No settled bounties yet."}
              </p>
              <p className={styles.emptyHint}>
                <button type="button" className="btn" onClick={() => setPickedTab("all")}>
                  Show all bounties
                </button>{" "}
                <Link href="/post" className={styles.link}>
                  Post one →
                </Link>
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="list">
          {items.map((j) => (
            <NadBountyRow
              key={String(j.meta.jobId)}
              meta={j.meta}
              status={j.status}
              ctx={j.ctx}
              nowSeconds={nowSeconds}
            />
          ))}
        </div>
      )}
      {snap?.truncated && (
        <p className={styles.footnote}>
          Showing the newest {snap.jobs.length + snap.skipped} of {String(snap.total)} bounties.
        </p>
      )}

      {stats && stats.recentlySettled.length > 0 && (
        <div className={styles.recent}>
          <NadRecentlyPaid rows={stats.recentlySettled} max={5} />
        </div>
      )}
      <footer className="spacer" />
    </>
  );
}
