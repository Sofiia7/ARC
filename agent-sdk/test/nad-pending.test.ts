import { describe, it, expect, beforeEach, vi } from "vitest";
import { NadBountyAgent } from "../src/NadBountyAgent.js";
import { computePendingActions, NAD_WINDOWS, type NadPendingJob, type NadPendingMeta } from "../src/nadPending.js";
import { THROWAWAY_KEYS, ZERO, addresses, mainnetWiring, mock, resetMocks, state } from "./helpers/nadMock.js";

vi.mock("viem", async (importOriginal) => (await import("./helpers/nadMock.js")).viemMock(await importOriginal()));
vi.mock("../src/signers/viemSigner.js", async () => (await import("./helpers/nadMock.js")).signerMock());

const DAY = 86_400n;
const NOW = 1_800_000_000n;
const poster = addresses.owner;
const worker = addresses.worker;
const meta = (o: Partial<NadPendingMeta> = {}): NadPendingMeta => ({
  jobId: 1n,
  deadline: NOW + 10n * DAY,
  resolved: false,
  contest: false,
  isTaken: true,
  submittedResultHash: "",
  submittedAt: 0n,
  rejectedAt: 0n,
  inDispute: false,
  disputeRaisedAt: 0n,
  disputeResponseHash: "",
  poster,
  assignedProvider: worker,
  agentId: 0n,
  disputeByWorker: false,
  ...o,
});
const job = (m: Partial<NadPendingMeta>, rest: Partial<NadPendingJob> = {}): NadPendingJob => ({
  meta: meta(m),
  escrowExpired: false,
  ...rest,
});
const summary = (jobs: NadPendingJob[], who: { address?: `0x${string}`; agentId?: bigint }, now = NOW) =>
  computePendingActions(jobs, who, now).map(({ jobId, role, action, kind }) => ({ jobId, role, action, kind }));

describe("single-taker bounties", () => {
  it("lists nothing while everything is on schedule", () => {
    expect(summary([job({})], { address: poster })).toEqual([]);
    expect(summary([job({})], { address: worker })).toEqual([]);
  });
  it("offers a refund of an untaken or abandoned bounty after its deadline, to either party", () => {
    const late = job({ deadline: NOW - 1n });
    expect(summary([late], { address: poster })).toEqual([
      { jobId: 1n, role: "poster", action: "expireBounty", kind: "claim" },
    ]);
    expect(summary([late], { address: worker })).toEqual([
      { jobId: 1n, role: "worker", action: "expireBounty", kind: "claim" },
    ]);
    expect(summary([job({ deadline: NOW })], { address: poster })).toEqual([]);
  });
  it("asks the poster to review a submission, with the end of the window", () => {
    const submitted = job({ submittedResultHash: "ipfs://r", submittedAt: NOW - DAY });
    const [action] = computePendingActions([submitted], { address: poster }, NOW);
    expect(action).toMatchObject({
      role: "poster",
      action: "approveBounty",
      kind: "respond",
      expiresAt: NOW - DAY + 14n * DAY,
    });
    expect(summary([submitted], { address: worker })).toEqual([]);
  });
  it("lets anyone auto-approve once the poster has been silent for 14 days", () => {
    const silent = job({ submittedResultHash: "ipfs://r", submittedAt: NOW - 15n * DAY });
    expect(summary([silent], { address: worker })).toEqual([
      { jobId: 1n, role: "worker", action: "autoApprove", kind: "claim" },
    ]);
    expect(summary([silent], { address: poster })).toEqual([
      { jobId: 1n, role: "poster", action: "autoApprove", kind: "claim" },
    ]);
  });
  it("gives the worker 48 hours to challenge a rejection, then lets the refund finalize", () => {
    const rejected = job({ submittedResultHash: "ipfs://r", submittedAt: NOW - 3n * DAY, rejectedAt: NOW - DAY });
    expect(computePendingActions([rejected], { address: worker }, NOW)[0]).toMatchObject({
      role: "worker",
      action: "challengeRejection",
      kind: "respond",
      expiresAt: NOW + DAY,
    });
    expect(summary([rejected], { address: poster })).toEqual([]);
    const stale = job({ submittedResultHash: "ipfs://r", submittedAt: NOW - 9n * DAY, rejectedAt: NOW - 3n * DAY });
    expect(summary([stale], { address: worker })).toEqual([
      { jobId: 1n, role: "worker", action: "finalizeRejection", kind: "claim" },
    ]);
  });
  it("tells only the respondent to answer a dispute, and offers the default ruling after 48 hours", () => {
    const byWorker = job({
      submittedResultHash: "ipfs://r",
      submittedAt: NOW - 5n * DAY,
      rejectedAt: NOW - 3n * DAY,
      inDispute: true,
      disputeByWorker: true,
      disputeRaisedAt: NOW - DAY,
    });
    expect(summary([byWorker], { address: poster })).toEqual([
      { jobId: 1n, role: "poster", action: "respondToDispute", kind: "respond" },
    ]);
    expect(summary([byWorker], { address: worker })).toEqual([]);
    const byPoster = job({
      submittedResultHash: "ipfs://r",
      submittedAt: NOW - 5n * DAY,
      inDispute: true,
      disputeByWorker: false,
      disputeRaisedAt: NOW - DAY,
    });
    expect(summary([byPoster], { address: worker })).toEqual([
      { jobId: 1n, role: "worker", action: "respondToDispute", kind: "respond" },
    ]);
    const ignored = job({
      submittedResultHash: "ipfs://r",
      submittedAt: NOW - 9n * DAY,
      inDispute: true,
      disputeByWorker: true,
      disputeRaisedAt: NOW - 3n * DAY,
    });
    expect(summary([ignored], { address: worker })).toEqual([
      { jobId: 1n, role: "worker", action: "claimDefaultRuling", kind: "claim" },
    ]);
    expect(summary([ignored], { address: poster })).toEqual([
      { jobId: 1n, role: "poster", action: "claimDefaultRuling", kind: "claim" },
    ]);
  });
  it("offers the arbitrator timeout 30 days after a dispute both sides answered", () => {
    const answered = job({
      submittedResultHash: "ipfs://r",
      submittedAt: NOW - 40n * DAY,
      inDispute: true,
      disputeRaisedAt: NOW - 31n * DAY,
      disputeResponseHash: "ipfs://x",
    });
    expect(summary([answered], { address: poster })).toEqual([
      { jobId: 1n, role: "poster", action: "claimArbitratorTimeout", kind: "claim" },
    ]);
  });
  it("prefers escrow recovery when the escrow job expired", () => {
    expect(summary([job({}, { escrowExpired: true })], { address: poster })).toEqual([
      { jobId: 1n, role: "poster", action: "reconcileExpiredEscrow", kind: "claim" },
    ]);
  });
  it("skips settled jobs and jobs the address has no part in", () => {
    expect(summary([job({ resolved: true, deadline: NOW - 1n })], { address: poster })).toEqual([]);
    expect(summary([job({ deadline: NOW - 1n })], { address: addresses.stranger })).toEqual([]);
  });
  it("finds a worker through its agentId even when another working wallet took the job", () => {
    const late = job({ deadline: NOW - 1n, agentId: 10388n });
    expect(summary([late], { address: addresses.stranger, agentId: 10388n })).toEqual([
      { jobId: 1n, role: "worker", action: "expireBounty", kind: "claim" },
    ]);
    expect(summary([late], { agentId: 99n })).toEqual([]);
  });
  it("reports one entry per action, with the poster role first when one wallet plays both", () => {
    const self = job({ deadline: NOW - 1n, assignedProvider: poster });
    expect(summary([self], { address: poster })).toEqual([
      { jobId: 1n, role: "poster", action: "expireBounty", kind: "claim" },
    ]);
  });
});

describe("contests", () => {
  const contestMeta = { contest: true, isTaken: false, deadline: NOW - 2n * DAY, assignedProvider: ZERO } as const;
  const entries = [
    { agentId: 0n, entrant: addresses.stranger },
    { agentId: 10388n, entrant: worker },
  ];
  const state_ = (o: Partial<NonNullable<NadPendingJob["contest"]>> = {}) => ({
    closedAt: NOW - 2n * DAY,
    entryCount: 2,
    challenges: [],
    entries,
    ...o,
  });

  it("asks the poster to pick winners in a closed contest, and pays everyone after silence", () => {
    const review = job(contestMeta, { contest: state_() });
    expect(computePendingActions([review], { address: poster }, NOW)[0]).toMatchObject({
      role: "poster",
      action: "pickContestWinners",
      kind: "respond",
      expiresAt: NOW - 2n * DAY + 14n * DAY,
    });
    const silent = job(contestMeta, { contest: state_({ closedAt: NOW - 15n * DAY }) });
    expect(summary([silent], { address: poster })).toEqual([
      { jobId: 1n, role: "poster", action: "settleContestSilence", kind: "claim" },
    ]);
    expect(summary([silent], { address: worker })).toEqual([
      { jobId: 1n, role: "entrant", action: "settleContestSilence", kind: "claim" },
    ]);
  });
  it("refunds an empty contest after its deadline and ignores one still open", () => {
    expect(
      summary([job(contestMeta, { contest: state_({ entryCount: 0, closedAt: contestMeta.deadline, entries: [] }) })], {
        address: poster,
      }),
    ).toEqual([{ jobId: 1n, role: "poster", action: "expireBounty", kind: "claim" }]);
    expect(
      summary(
        [
          job(
            { ...contestMeta, deadline: NOW + DAY },
            { contest: state_({ closedAt: 0n, entryCount: 1, entries: [entries[0]!] }) },
          ),
        ],
        { address: poster },
      ),
    ).toEqual([]);
  });
  it("lets an entrant challenge a rejection until the window closes, but only once", () => {
    const rejected = job({ ...contestMeta, rejectedAt: NOW - DAY }, { contest: state_() });
    expect(computePendingActions([rejected], { address: worker }, NOW)[0]).toMatchObject({
      role: "entrant",
      action: "challengeContestRejection",
      kind: "respond",
      expiresAt: NOW + DAY,
    });
    expect(summary([rejected], { address: addresses.stranger })).toEqual([
      { jobId: 1n, role: "entrant", action: "challengeContestRejection", kind: "respond" },
    ]);
    const challenged = job(
      { ...contestMeta, rejectedAt: NOW - DAY, inDispute: true, disputeRaisedAt: NOW - DAY / 2n },
      {
        contest: state_({ challenges: [{ index: 1, challengedAt: NOW - DAY / 2n, respondedAt: 0n }] }),
      },
    );
    expect(summary([challenged], { address: worker })).toEqual([]);
    expect(summary([challenged], { address: addresses.stranger })).toEqual([
      { jobId: 1n, role: "entrant", action: "challengeContestRejection", kind: "respond" },
    ]);
  });
  it("lets anyone finalize an unchallenged rejection after 48 hours", () => {
    const old = job({ ...contestMeta, rejectedAt: NOW - 3n * DAY }, { contest: state_() });
    expect(summary([old], { address: poster })).toEqual([
      { jobId: 1n, role: "poster", action: "finalizeContestRejection", kind: "claim" },
    ]);
    expect(summary([old], { address: worker })).toEqual([
      { jobId: 1n, role: "entrant", action: "finalizeContestRejection", kind: "claim" },
    ]);
  });
  it("asks the poster to answer open challenges before the first deadline, then hands over by default", () => {
    const challengedAt = NOW - DAY;
    const open = job(
      { ...contestMeta, rejectedAt: NOW - 3n * DAY, inDispute: true, disputeRaisedAt: challengedAt },
      {
        contest: state_({ challenges: [{ index: 1, challengedAt, respondedAt: 0n }] }),
      },
    );
    expect(computePendingActions([open], { address: poster }, NOW)[0]).toMatchObject({
      role: "poster",
      action: "respondToContestChallenges",
      kind: "respond",
      expiresAt: challengedAt + NAD_WINDOWS.response,
    });
    const overdue = job(
      { ...contestMeta, rejectedAt: NOW - 5n * DAY, inDispute: true, disputeRaisedAt: NOW - 3n * DAY },
      {
        contest: state_({ challenges: [{ index: 1, challengedAt: NOW - 3n * DAY, respondedAt: 0n }] }),
      },
    );
    expect(summary([overdue], { address: poster })).toEqual([
      { jobId: 1n, role: "poster", action: "claimContestDefault", kind: "claim" },
    ]);
    expect(summary([overdue], { address: worker })).toEqual([
      { jobId: 1n, role: "entrant", action: "claimContestDefault", kind: "claim" },
    ]);
  });
  it("offers the arbitrator timeout once every challenge is answered and 30 days passed", () => {
    const answered = job(
      { ...contestMeta, rejectedAt: NOW - 40n * DAY, inDispute: true, disputeRaisedAt: NOW - 31n * DAY },
      {
        contest: state_({ challenges: [{ index: 1, challengedAt: NOW - 31n * DAY, respondedAt: NOW - 30n * DAY }] }),
      },
    );
    expect(summary([answered], { address: poster })).toEqual([
      { jobId: 1n, role: "poster", action: "claimContestArbitratorTimeout", kind: "claim" },
    ]);
  });
  it("needs the contest state for a contest", () => {
    expect(() => computePendingActions([job(contestMeta)], { address: poster }, NOW)).toThrow(
      "Contest state is required",
    );
  });
});

describe("NadBountyAgent.getPendingActions", () => {
  const agent = () => new NadBountyAgent({ network: "monad-mainnet", privateKey: THROWAWAY_KEYS.worker });
  const metas: Record<string, NadPendingMeta> = {};
  const names = () => mock.read.mock.calls.map(([call]) => call.functionName as string);

  beforeEach(() => {
    resetMocks(mainnetWiring());
    state.now = NOW;
    for (const key of Object.keys(metas)) delete metas[key];
    Object.assign(metas, {
      "1": meta({ jobId: 1n, poster: worker, deadline: NOW - DAY, isTaken: false, assignedProvider: ZERO }),
      "2": meta({ jobId: 2n, poster: worker, resolved: true }),
      "3": meta({
        jobId: 3n,
        poster: poster,
        submittedResultHash: "ipfs://r",
        submittedAt: NOW - 15n * DAY,
        deadline: NOW - 20n * DAY,
      }),
      "4": meta({
        jobId: 4n,
        poster,
        contest: true,
        isTaken: false,
        deadline: NOW - 2n * DAY,
        assignedProvider: ZERO,
        rejectedAt: NOW - DAY,
        inDispute: true,
        disputeRaisedAt: NOW - DAY,
      }),
      "5": meta({ jobId: 5n, poster, deadline: NOW - 100n * DAY }),
    });
    state.reads["getMyPostedBounties"] = [1n, 2n];
    state.reads["getMyAssignedBounties"] = [3n, 4n, 5n];
    state.reads["getAgentBounties"] = [4n, 6n];
    state.reads["getBountyMeta"] = (args: readonly unknown[]) =>
      metas[String(args[0])] ?? meta({ jobId: args[0] as bigint, poster, resolved: true });
    state.reads["getContestState"] = [2n, NOW - 2n * DAY, NOW + 12n * DAY, false];
    state.reads["getContestChallengers"] = [1];
    state.reads["getContestChallenge"] = { challengedAt: NOW - DAY, respondedAt: 0n };
    state.reads["getContestEntries"] = [
      { agentId: 0n, entrant: addresses.stranger, resultHash: "ipfs://a", awarded: false },
      { agentId: 10388n, entrant: worker, resultHash: "ipfs://b", awarded: false },
    ];
    state.reads["getJob"] = { status: 5 };
  });

  it("scans an address's posted and assigned jobs in a few batched reads, without any log query", async () => {
    const pending = await agent().getPendingActions();
    // Job 2 is settled; job 4 is a rejected contest this wallet already challenged, so it needs nothing.
    expect(pending.map(({ jobId, role, action, kind }) => ({ jobId, role, action, kind }))).toEqual([
      { jobId: 1n, role: "poster", action: "expireBounty", kind: "claim" },
      { jobId: 3n, role: "worker", action: "autoApprove", kind: "claim" },
      { jobId: 5n, role: "worker", action: "reconcileExpiredEscrow", kind: "claim" },
    ]);
    expect(mock.getLogs).not.toHaveBeenCalled();
    expect(mock.multicall.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("includes the contest the wallet entered and its open challenge window", async () => {
    metas["4"] = meta({
      jobId: 4n,
      poster,
      contest: true,
      isTaken: false,
      deadline: NOW - 2n * DAY,
      assignedProvider: ZERO,
      rejectedAt: NOW - DAY,
    });
    state.reads["getContestChallengers"] = [];
    const pending = await agent().getPendingActions();
    expect(pending.find((entry) => entry.jobId === 4n)).toMatchObject({
      role: "entrant",
      action: "challengeContestRejection",
      kind: "respond",
    });
  });

  it("reads by wallet and by identity, deduplicating the job lists", async () => {
    await agent().getPendingActions({ agentId: 10388n });
    const idCalls = mock.read.mock.calls
      .filter(([call]) => call.functionName === "getBountyMeta")
      .map(([call]) => call.args[0]);
    expect(idCalls.sort()).toEqual([1n, 2n, 3n, 4n, 5n, 6n].sort());
    expect(names().slice(0, 3)).toEqual(["getMyPostedBounties", "getMyAssignedBounties", "getAgentBounties"]);
  });

  it("works for another wallet, on a read-only client, at a chosen time", async () => {
    const reader = new NadBountyAgent({ network: "monad-mainnet" });
    const pending = await reader.getPendingActions({ address: worker, now: NOW });
    expect(pending.length).toBeGreaterThan(0);
    expect(mock.block).not.toHaveBeenCalled();
    await expect(reader.getPendingActions()).rejects.toThrow("address and/or an agentId");
    await expect(reader.getPendingActions({ address: ZERO })).rejects.toThrow("not a valid address");
  });

  it("only asks the escrow about jobs far past their deadline", async () => {
    await agent().getPendingActions();
    const escrowCalls = mock.read.mock.calls.filter(([call]) => call.functionName === "getJob");
    expect(escrowCalls.map(([call]) => call.args[0])).toEqual([5n]);
    expect(escrowCalls[0]![0].address).toBe("0x8F367e17d96EB83c4A51b3349e3CE30447aDB7e2");
  });

  it("scans only the newest maxJobs of each list", async () => {
    await agent().getPendingActions({ maxJobs: 1 });
    const scanned = mock.read.mock.calls
      .filter(([call]) => call.functionName === "getBountyMeta")
      .map(([call]) => call.args[0]);
    expect(scanned.sort()).toEqual([2n, 5n].sort());
    await expect(agent().getPendingActions({ maxJobs: 0 })).rejects.toThrow("maxJobs");
  });

  it("returns an empty list without further reads when the wallet has no jobs or all are settled", async () => {
    state.reads["getMyPostedBounties"] = [];
    state.reads["getMyAssignedBounties"] = [];
    expect(await agent().getPendingActions()).toEqual([]);
    expect(mock.multicall).toHaveBeenCalledTimes(1);
    state.reads["getMyPostedBounties"] = [2n];
    mock.multicall.mockClear();
    expect(await agent().getPendingActions()).toEqual([]);
    expect(mock.multicall).toHaveBeenCalledTimes(2);
  });

  it("asks the adapter for the escrow address when the adapter is not the canonical one", async () => {
    state.reads["agenticCommerce"] = "0x0000000000000000000000000000000000000c01";
    const custom = new NadBountyAgent({
      network: "monad-mainnet",
      bountyAdapterAddress: "0x0000000000000000000000000000000000000048",
      privateKey: THROWAWAY_KEYS.worker,
    });
    await custom.getPendingActions();
    expect(mock.read.mock.calls.find(([call]) => call.functionName === "getJob")![0].address).toBe(
      "0x0000000000000000000000000000000000000c01",
    );
  });
});
