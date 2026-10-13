"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useAccount, usePublicClient } from "wagmi";
import type { Address, ContractFunctionReturnType, PublicClient } from "viem";
import { BOUNTY_ADAPTER_V48_ABI as ABI } from "@/lib/abi-v48";
import { CONTRACTS, ERC20_ABI } from "@/lib/contracts";
import { formatUsdc, shortAddress } from "@/lib/format";
import { pinText, fetchIpfsText } from "@/lib/ipfs";
import type { EncryptedContestEntry } from "@/lib/contestEncryption";
import {
  DEFAULT_SCORE,
  approveBlocker,
  cancelBlocker,
  challengeBlocker,
  contestClosedAtView,
  deadlineInfo,
  estimateChainNow,
  parseScore,
  payContestBlocker,
  rejectAllBlocker,
  withdrawContestRejectionBlocker,
  rejectBlocker,
  replaceEntryBlocker,
  respondBlocker,
  submitWorkBlocker,
  textIntent,
  workerBlocker,
  type DeadlineInfo,
  type WorkerCheck,
} from "@/lib/nadActions";
import { selectNadSettlement, type NadSettlement } from "@/lib/nadKeeper";
import { contestPaymentMethod, validateContestPayment } from "@/lib/nadContestActions";
import { DEPOSIT_EXPLAINER, workerBondFor } from "@/lib/nadMoney";
import { computeOutcome } from "@/lib/nadOutcome";
import { batchRead } from "@/lib/nadReads";
import {
  KNOWN_CATS,
  gateRequirement,
  nadStatus,
  nadTitleOf,
  type Entry,
  type Meta,
  type NadStatus,
} from "@/lib/nadStatus";
import { buildTimeline } from "@/lib/nadTimeline";
import { useNadAgentIds } from "@/hooks/useNadAgentIds";
import { IPFSMarkdownClient } from "./IPFSMarkdownClient";
import { NadAgentPicker } from "./NadAgentPicker";
import { NadTelegram } from "./NadTelegram";
import {
  ActionPanel,
  DepositNote,
  EntriesList,
  PosterActions,
  SettlementPanel,
  WorkerActions,
  type Challenge,
  type Reasons,
} from "./NadDetailActions";
import { OutcomePanel, PostedBanner, TimelinePanel } from "./NadDetailPanels";
import {
  UserError,
  WalletPrompt,
  ZERO,
  button,
  decryptContestEntry,
  encryptContestEntry,
  errorText,
  escrowAbi,
  identityAbi,
  useNadWrite,
  usePosterKey,
} from "./nadShared";
import flow from "./NadFlow.module.css";

const small: React.CSSProperties = { fontSize: 13, color: "var(--ink-soft)" };
const EMPTY_CHALLENGE: Challenge = { challengedAt: 0n, respondedAt: 0n, evidenceHash: "", responseHash: "" };
type ContestState = ContractFunctionReturnType<typeof ABI, "view", "getContestState">;

// Title block: category and status tags, heading, poster line, contest and gate subtags, reward and time left.
function NadHeader({
  meta,
  jobId,
  title,
  status,
  deadline,
}: {
  meta: Meta;
  jobId: bigint;
  title?: string;
  status: NadStatus;
  deadline: DeadlineInfo;
}) {
  const gate = gateRequirement(meta.minJobs, meta.minAvgScore);
  return (
    <header className="bounty-head">
      <div>
        <div className="top-line">
          <span className={`tag ${KNOWN_CATS.has(meta.category) ? `cat-${meta.category}` : "cat-other"}`}>
            {meta.category}
          </span>
          {meta.contest && <span className="tag bond-required">Encrypted contest</span>}
          {meta.agentOnly && <span className="tag agent-only">Agent only</span>}
          {meta.humanOnly && <span className="tag human-only">Human only</span>}
          {!meta.contest && meta.requireWorkerBond && (
            <span className={`tag ${flow.depositTag}`} title={DEPOSIT_EXPLAINER}>
              Deposit required
            </span>
          )}
          <span className={`status ${status.kind}`}>{status.label}</span>
        </div>
        <h1>{title ?? `${meta.contest ? "Encrypted contest" : "Bounty"} #${String(jobId)}`}</h1>
        <div className="posted-by">
          Posted by <code>{shortAddress(meta.poster)}</code> · job #{String(jobId)}
        </div>
        <div className="subtags">
          {meta.contest && (
            <>
              <span className="subtag">{String(meta.maxEntries)} entries max</span>
              <span className="subtag">
                {String(meta.winners)} winner{Number(meta.winners) === 1 ? "" : "s"}
              </span>
            </>
          )}
          {gate && <span className="subtag">{gate}</span>}
          {meta.tags.map((tag) => (
            <span className="subtag" key={tag}>
              #{tag}
            </span>
          ))}
        </div>
      </div>
      <div className="bounty-price">
        <div className="price">${formatUsdc(meta.reward)}</div>
        <div className="time">{deadline.label}</div>
      </div>
    </header>
  );
}

export function NadDetail({ jobId }: { jobId: bigint }) {
  const client = usePublicClient();
  const { address } = useAccount();
  const { write, busy, sendOrThrow } = useNadWrite();
  const recover = usePosterKey();
  const [meta, setMeta] = useState<Meta>(),
    [entries, setEntries] = useState<readonly Entry[]>([]),
    [description, setDescription] = useState<any>(),
    [descriptionTitle, setDescriptionTitle] = useState(""),
    [challenges, setChallenges] = useState<Challenge[]>([]),
    [plain, setPlain] = useState<Record<number, string>>({}),
    [selected, setSelected] = useState<number[]>([]),
    [scores, setScores] = useState<Record<number, string>>({}),
    [approveScore, setApproveScore] = useState(String(DEFAULT_SCORE)),
    [actingAs, setActingAs] = useState("0"),
    [text, setText] = useState(""),
    [error, setError] = useState(""),
    [working, setWorking] = useState(false);
  const [closedAt, setClosedAt] = useState(0n),
    [settlement, setSettlement] = useState<NadSettlement | null>(null),
    [clock, setClock] = useState<{ block: bigint; at: number }>(),
    [paused, setPaused] = useState(true),
    [escrowStatus, setEscrowStatus] = useState<number>(),
    [feeBps, setFeeBps] = useState(100n),
    [feeRecipient, setFeeRecipient] = useState<string | null>(null),
    [owners, setOwners] = useState<Record<string, string>>({}),
    [identityInfo, setIdentityInfo] = useState<{ gate: { jobs: bigint; sum: bigint } | null; usdc: bigint | null }>({
      gate: null,
      usdc: null,
    }),
    [posted, setPosted] = useState(false),
    [, setTick] = useState(0);
  const descriptionCid = useRef("");

  // One clock for every label and every button: the last block read plus the real seconds since, refreshed every 10 s.
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(timer);
  }, []);
  const chainNow = clock ? estimateChainNow(clock.block, clock.at, Date.now()) : 0n;

  // ?posted=1 comes from the post form: show the success banner once, then drop the parameter.
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.get("posted") !== "1") return;
    setPosted(true);
    query.delete("posted");
    const rest = query.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`,
    );
  }, []);

  const load = useCallback(async () => {
    if (!client) return;
    const reader = client as PublicClient;
    try {
      const block = await reader.getBlock();
      const at = Date.now();
      const pin = block.number;
      const adapter = (functionName: string, args: unknown[] = []) => ({
        address: CONTRACTS.BOUNTY_ADAPTER,
        abi: ABI,
        functionName,
        args,
      });
      const [metaR, pausedR, feeBpsR, feeRecipientR, jobR] = await batchRead(
        reader,
        [
          adapter("getBountyMeta", [jobId]),
          adapter("paused"),
          adapter("feeBps"),
          adapter("feeRecipient"),
          { address: CONTRACTS.AGENTIC_COMMERCE, abi: escrowAbi, functionName: "getJob", args: [jobId] },
        ],
        pin,
      );
      if (!metaR.ok) throw new UserError("Could not read this bounty right now. It will retry in a moment.");
      const m = metaR.value as Meta;
      if (m.poster === ZERO) throw new UserError("Bounty not found.");
      const escrow = jobR.ok ? Number((jobR.value as { status: number }).status) : undefined;
      let list: readonly Entry[] = [];
      let cs: Challenge[] = [];
      let closed = 0n;
      if (m.contest) {
        const [entriesR, stateR] = await batchRead(
          reader,
          [adapter("getContestEntries", [jobId]), adapter("getContestState", [jobId])],
          pin,
        );
        if (!entriesR.ok || !stateR.ok)
          throw new UserError("Could not read this contest right now. It will retry in a moment.");
        list = entriesR.value as readonly Entry[];
        closed = (stateR.value as ContestState)[1];
        // Challenges can only exist after a rejection: skip the reads otherwise.
        cs =
          m.rejectedAt > 0n && list.length
            ? (
                await batchRead(
                  reader,
                  list.map((_, i) => adapter("getContestChallenge", [jobId, i])),
                  pin,
                )
              ).map((r) => (r.ok ? (r.value as Challenge) : EMPTY_CHALLENGE))
            : list.map(() => EMPTY_CHALLENGE);
      }
      const ownerIds = m.resolved
        ? Array.from(
            new Set([m.agentId, ...list.filter((e) => e.awarded).map((e) => e.agentId)].filter((id) => id > 0n)),
          )
        : [];
      const ownerReads = await batchRead(
        reader,
        ownerIds.map((id) => ({
          address: CONTRACTS.IDENTITY_REGISTRY,
          abi: identityAbi,
          functionName: "ownerOf",
          args: [id],
        })),
        pin,
      );
      setMeta(m);
      setEntries(list);
      setChallenges(cs);
      setClosedAt(closed);
      setClock({ block: block.timestamp, at });
      setPaused(pausedR.ok ? Boolean(pausedR.value) : true);
      setFeeBps(feeBpsR.ok ? (feeBpsR.value as bigint) : 100n);
      setFeeRecipient(feeRecipientR.ok ? String(feeRecipientR.value) : null);
      setEscrowStatus(escrow);
      setOwners(
        Object.fromEntries(
          ownerIds.flatMap((id, i) => {
            const read = ownerReads[i];
            return read.ok ? [[String(id), String(read.value)]] : [];
          }),
        ),
      );
      setSettlement(
        selectNadSettlement(
          m,
          block.timestamp,
          m.contest ? { entryCount: list.length, closedAt: closed, challenges: cs } : undefined,
          escrow === 5,
        ),
      );
      setSelected((current) => current.filter((i) => i < list.length && (!m.inDispute || cs[i]?.challengedAt > 0n)));
      setError("");
      if (descriptionCid.current !== m.ipfsDescHash) {
        try {
          const raw = await fetchIpfsText(m.ipfsDescHash);
          // Same rule as the board row (title, then name, then the first line), so the two always agree.
          setDescriptionTitle(nadTitleOf(raw));
          try {
            setDescription(JSON.parse(raw));
          } catch {
            setDescription({ description: raw });
          }
          descriptionCid.current = m.ipfsDescHash;
        } catch {
          setError("Could not load the task description from IPFS. It will retry in a moment.");
        }
      }
    } catch (e) {
      setError(errorText(e, "load this bounty"));
    }
  }, [client, jobId]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30000);
    return () => clearInterval(timer);
  }, [load]);

  const poster = !!address && address.toLowerCase() === meta?.poster.toLowerCase();
  const candidates = useMemo(() => (meta ? [meta.agentId, ...entries.map((e) => e.agentId)] : []), [meta, entries]);
  const agents = useNadAgentIds(candidates);
  const ownsEntry = (entry: { agentId: bigint; entrant: Address }) =>
    !!address &&
    (entry.agentId === 0n ? entry.entrant.toLowerCase() === address.toLowerCase() : agents.ids.includes(entry.agentId));
  const ownsAssigned =
    !!meta &&
    meta.isTaken &&
    !!address &&
    (meta.agentId === 0n
      ? meta.assignedProvider.toLowerCase() === address.toLowerCase()
      : agents.ids.includes(meta.agentId));

  // Who the wallet acts as: default to the first agent on an agent-only bounty, always the wallet on a human-only one.
  useEffect(() => {
    if (!meta) return;
    setActingAs((current) => {
      if (meta.humanOnly) return "0";
      if (current !== "0" && agents.status === "ready" && !agents.ids.some((id) => String(id) === current)) return "0";
      if (meta.agentOnly && current === "0" && agents.ids.length > 0) return String(agents.ids[0]);
      return current;
    });
  }, [meta, agents.ids, agents.status]);

  // The chosen identity's reputation totals (for the gate) and the wallet's USDC (for a deposit), read like the contract does.
  const loadedAt = clock?.at;
  useEffect(() => {
    if (!client || !address || !meta || poster || meta.resolved) {
      setIdentityInfo({ gate: null, usdc: null });
      return;
    }
    const hasGate = meta.minJobs > 0n || Number(meta.minAvgScore) > 0;
    const needsDeposit = !meta.contest && meta.requireWorkerBond;
    if (!hasGate && !needsDeposit) {
      setIdentityInfo({ gate: null, usdc: null });
      return;
    }
    let live = true;
    void (async () => {
      const calls = [
        ...(hasGate
          ? [
              {
                address: CONTRACTS.BOUNTY_ADAPTER,
                abi: ABI,
                functionName: "getIdentityReputation",
                args: [BigInt(actingAs), address],
              },
            ]
          : []),
        ...(needsDeposit
          ? [{ address: CONTRACTS.USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [address] }]
          : []),
      ];
      try {
        const results = await batchRead(client as PublicClient, calls);
        if (!live) return;
        let at = 0;
        let gate: { jobs: bigint; sum: bigint } | null = null;
        let usdc: bigint | null = null;
        if (hasGate) {
          const r = results[at++];
          if (r.ok) gate = { jobs: (r.value as readonly bigint[])[0], sum: (r.value as readonly bigint[])[1] };
        }
        if (needsDeposit) {
          const r = results[at++];
          if (r.ok) usdc = r.value as bigint;
        }
        setIdentityInfo({ gate, usdc });
      } catch {
        if (live) setIdentityInfo({ gate: null, usdc: null });
      }
    })();
    return () => {
      live = false;
    };
  }, [client, address, meta, poster, actingAs, loadedAt]);

  const disabled = busy || working;
  const run = async (fn: () => Promise<unknown>, action = "complete that action") => {
    setWorking(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError(errorText(e, action));
    } finally {
      setWorking(false);
    }
  };
  const action = (name: string, args: unknown[]) => run(() => write(name, [jobId, ...args]));

  const closed = meta?.contest ? contestClosedAtView(closedAt, meta.deadline, chainNow) : 0n;
  const paymentMethod = meta ? contestPaymentMethod(meta, closed, chainNow) : null;
  const intent = meta
    ? textIntent({
        poster,
        contest: meta.contest,
        inDispute: meta.inDispute,
        rejectedAt: meta.rejectedAt,
        disputeByWorker: meta.disputeByWorker,
      })
    : textIntent({ poster: false, contest: false, inDispute: false, rejectedAt: 0n, disputeByWorker: false });

  /** The reason this wallet, acting as the chosen identity, cannot enter or take right now (checked again with a fresh block on click). */
  function workerCheck(now: bigint, mode: "enter" | "take"): WorkerCheck | null {
    if (!meta || !address) return null;
    const agentId = BigInt(actingAs);
    return {
      mode,
      meta,
      now,
      paused,
      closedAt: closed,
      entries,
      agentCount: agents.ids.length,
      identity: { agentId, wallet: address, controlled: agentId === 0n || agents.ids.includes(agentId) },
      gate: identityInfo.gate,
      usdcBalance: identityInfo.usdc,
    };
  }
  const check = (now: bigint, mode: "enter" | "take") => {
    const input = workerCheck(now, mode);
    return input ? workerBlocker(input) : null;
  };

  async function submit() {
    if (!meta || !client || !address) return;
    await run(
      async () => {
        const head = await client.getBlock();
        if (!text.trim()) throw new UserError(`Fill in "${intent.label}" first.`);
        const blocker = meta.contest ? check(head.timestamp, "enter") : submitWorkBlocker(meta, head.timestamp);
        if (blocker) throw new UserError(blocker);
        if (meta.contest) {
          const publicKey = description?.contestEncryption?.publicKey ?? description?.contestPublicKey;
          if (!publicKey)
            throw new UserError(
              "The poster's encryption key is missing from the description, so this contest cannot take sealed entries.",
            );
          const cid = await pinText(JSON.stringify(await encryptContestEntry(text, publicKey)));
          await write("enterContest", [jobId, BigInt(actingAs), cid]);
        } else {
          const cid = await pinText(text);
          await write("submitWork", [jobId, cid]);
        }
        setText("");
      },
      meta.contest ? "enter the contest" : "submit your work",
    );
  }
  async function evidenceAction(name: string, args: unknown[] = []) {
    await run(async () => {
      if (!text.trim()) throw new UserError(`Fill in "${intent.label}" first.`);
      const cid = await pinText(text);
      await write(name, [jobId, ...args, cid]);
      setText("");
    });
  }
  async function take() {
    if (!meta || !client || !address) return;
    await run(async () => {
      const head = await client.getBlock();
      const blocker = check(head.timestamp, "take");
      if (blocker) throw new UserError(blocker);
      if (meta.requireWorkerBond) {
        const amount = workerBondFor(meta.reward);
        const allowance = await client.readContract({
          address: CONTRACTS.USDC,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [address, CONTRACTS.BOUNTY_ADAPTER],
        });
        if (allowance < amount) {
          await sendOrThrow(
            {
              address: CONTRACTS.USDC,
              abi: ERC20_ABI,
              functionName: "approve",
              args: [CONTRACTS.BOUNTY_ADAPTER, amount],
            },
            "The deposit approval was not confirmed.",
          );
        }
      }
      await write("takeBounty", [jobId, BigInt(actingAs)]);
    }, "take this bounty");
  }
  async function approve() {
    const score = parseScore(approveScore);
    await run(async () => {
      if (!score.ok) throw new UserError(score.error);
      await write("approveBounty", [jobId, score.value]);
    }, "approve this work");
  }
  async function decrypt() {
    if (!meta) return;
    await run(async () => {
      if (!["wallet-signature-v1", "mera-prf-v1"].includes(description?.contestEncryption?.keySource))
        throw new UserError(
          "This contest was posted using an SDK encryption key. Decrypt its entries with that SDK key.",
        );
      const key = await recover(meta.poster);
      if (key.publicKey !== description.contestEncryption.publicKey)
        throw new UserError(
          "This wallet returned a different encryption key. Use the wallet or passkey you posted with, or the original key backup.",
        );
      const values: Record<number, string> = {};
      for (let i = 0; i < entries.length; i++) {
        const envelope = JSON.parse(await fetchIpfsText(entries[i].resultHash)) as EncryptedContestEntry;
        values[i] = await decryptContestEntry(envelope, key);
      }
      setPlain(values);
    }, "decrypt the entries");
  }
  async function paySelected() {
    await run(async () => {
      if (!meta || !paymentMethod)
        throw new UserError("This contest cannot be paid through the selected action. Reload its state.");
      const values = selected.map((i) => {
        const score = parseScore(scores[i] ?? "90");
        if (!score.ok) throw new UserError(`Entry ${i + 1}: ${score.error}`);
        return score.value;
      });
      validateContestPayment(selected, values, entries.length, meta.winners, paymentMethod, challenges);
      await write(paymentMethod, [jobId, selected, values]);
    }, "pay the selected winners");
  }
  async function replaceEntry(i: number) {
    await run(async () => {
      const publicKey = description?.contestEncryption?.publicKey ?? description?.contestPublicKey;
      if (!publicKey) throw new UserError("The poster's encryption key is missing from the description.");
      if (!text.trim()) throw new UserError(`Fill in "${intent.label}" with your replacement first.`);
      const cid = await pinText(JSON.stringify(await encryptContestEntry(text, publicKey)));
      await write("replaceContestEntry", [jobId, i, cid]);
      setText("");
    }, "replace your entry");
  }

  const anyAwarded = entries.some((e) => e.awarded);
  const status = meta
    ? nadStatus(meta, {
        escrowStatus,
        closedAt: meta.contest ? closed : undefined,
        entryCount: meta.contest ? entries.length : undefined,
        anyAwarded: meta.contest ? anyAwarded : undefined,
        nowSeconds: chainNow || undefined,
      })
    : null;
  const deadline = meta ? deadlineInfo(meta, chainNow, closedAt) : null;
  const outcome = meta?.resolved
    ? computeOutcome({ meta, escrowStatus, entries, challenges, feeBps, now: chainNow, owners, feeRecipient })
    : null;
  const settledAs = outcome?.title;
  const phases = useMemo(
    () => (meta ? buildTimeline(meta, closed, chainNow, { entryCount: entries.length, challenges, settledAs }) : []),
    [meta, closed, chainNow, entries.length, challenges, settledAs],
  );

  const reasons: Reasons | null =
    meta && address
      ? {
          enter: check(chainNow, "enter"),
          take: check(chainNow, "take"),
          submitWork: submitWorkBlocker(meta, chainNow),
          approve:
            approveBlocker(meta) ?? (parseScore(approveScore).ok ? null : "Enter a whole number score from 0 to 100."),
          reject: rejectBlocker(meta, chainNow),
          cancel: cancelBlocker(meta, entries.length),
          pay: payContestBlocker(meta, paymentMethod, selected.length),
          rejectAll: rejectAllBlocker(meta, entries.length, closed, chainNow),
          withdrawRejection: withdrawContestRejectionBlocker(meta, challenges),
          respond: respondBlocker(meta, chainNow, challenges),
          challenge: challengeBlocker(meta, chainNow, false),
        }
      : null;

  const showPicker =
    !!meta && !poster && !meta.resolved && ((meta.contest && closed === 0n) || (!meta.contest && !meta.isTaken));
  const reviewing = !!meta && !meta.contest && !!meta.submittedResultHash && meta.rejectedAt === 0n && !meta.inDispute;
  const showText =
    !!meta &&
    !meta.resolved &&
    (poster
      ? meta.contest
        ? entries.length > 0 || meta.inDispute
        : reviewing || meta.inDispute
      : meta.contest
        ? closed === 0n || (meta.rejectedAt > 0n && entries.some(ownsEntry))
        : ownsAssigned && (!meta.submittedResultHash || meta.rejectedAt > 0n));

  return (
    <div style={{ maxWidth: 920, margin: "0 auto" }}>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/">Browse</Link>
        <span className="sep">/</span>
        {meta && (
          <>
            <span style={{ textTransform: "capitalize" }}>{meta.category}</span>
            <span className="sep">/</span>
          </>
        )}
        <span className="current">#{String(jobId)}</span>
      </nav>
      {posted && (
        <PostedBanner
          url={`${typeof window === "undefined" ? "" : window.location.origin}/bounty/${String(jobId)}`}
          showTelegram={poster}
        />
      )}
      {error && (
        <div className="panel danger" role="alert">
          <p style={{ margin: 0, overflowWrap: "anywhere" }}>{error}</p>
        </div>
      )}
      {!meta || !status || !deadline ? (
        !error && <div className="row" style={{ height: 280, opacity: 0.5 }} />
      ) : (
        <>
          <NadHeader
            meta={meta}
            jobId={jobId}
            title={descriptionTitle || undefined}
            status={status}
            deadline={deadline}
          />
          <section className="desc-card">
            <div className="label">Description</div>
            <IPFSMarkdownClient cid={meta.ipfsDescHash} />
          </section>
          <p style={{ ...small, marginTop: 14 }}>
            {meta.contest ? (closed > 0n ? "Entries closed" : "Entries close") : "Deadline"}:{" "}
            {new Date(Number(closed > 0n ? closed : meta.deadline) * 1000).toLocaleString()} · Poster:{" "}
            <code style={{ overflowWrap: "anywhere" }}>{meta.poster}</code>
          </p>
          {outcome && <OutcomePanel outcome={outcome} />}
          <TimelinePanel phases={phases} now={chainNow} />
          {!address ? (
            <div style={{ marginTop: 22 }}>
              <WalletPrompt big />
            </div>
          ) : (
            !meta.resolved &&
            reasons && (
              <ActionPanel
                picker={
                  showPicker ? (
                    <>
                      <NadAgentPicker
                        agents={agents}
                        value={actingAs}
                        onChange={setActingAs}
                        disabled={disabled}
                        audience={meta.agentOnly ? "agent" : meta.humanOnly ? "human" : null}
                      />
                      {!meta.contest && meta.requireWorkerBond && <DepositNote reward={meta.reward} />}
                    </>
                  ) : undefined
                }
                intent={intent}
                showText={showText}
                text={text}
                setText={setText}
              >
                {poster ? (
                  <PosterActions
                    meta={meta}
                    entryCount={entries.length}
                    selectedCount={selected.length}
                    paymentMethod={paymentMethod}
                    reasons={reasons}
                    disabled={disabled}
                    approveScore={approveScore}
                    setApproveScore={setApproveScore}
                    approve={approve}
                    paySelected={paySelected}
                    evidenceAction={evidenceAction}
                    action={action}
                  />
                ) : (
                  <WorkerActions
                    meta={meta}
                    closed={closed}
                    ownsAssigned={ownsAssigned}
                    reasons={reasons}
                    disabled={disabled}
                    submit={submit}
                    take={take}
                    challengeRejection={() => evidenceAction("challengeRejection")}
                  />
                )}
              </ActionPanel>
            )
          )}
          {address && settlement && !meta.resolved && (
            <SettlementPanel settlement={settlement} meta={meta} disabled={disabled} action={action} />
          )}
          {poster && !meta.resolved && !posted && <NadTelegram />}
          {poster && meta.contest && (
            <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
              <button
                className={button}
                disabled={disabled || entries.length === 0}
                aria-describedby="decrypt-hint"
                onClick={() => void decrypt()}
              >
                Decrypt entries
              </button>
              <p id="decrypt-hint" className={flow.hint}>
                {entries.length === 0 ? "No entries to decrypt yet. " : ""}
                Asks your wallet for a signature that derives the key on this device. No funds move. Use the same wallet
                or passkey you posted with.
              </p>
            </div>
          )}
          {meta.contest && (
            <EntriesList
              meta={meta}
              entries={entries}
              challenges={challenges}
              plain={plain}
              selected={selected}
              scores={scores}
              setSelected={setSelected}
              setScores={setScores}
              poster={poster}
              address={address}
              paymentMethod={paymentMethod}
              disabled={disabled}
              ownsEntry={ownsEntry}
              replaceEntry={replaceEntry}
              evidenceAction={evidenceAction}
              replaceReason={replaceEntryBlocker(paused, closed)}
              challengeReason={(index) => challengeBlocker(meta, chainNow, challenges[index]?.challengedAt > 0n)}
            />
          )}
        </>
      )}
      <footer className="spacer" />
    </div>
  );
}
