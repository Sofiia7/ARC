import { test } from "node:test";
import assert from "node:assert/strict";
import { zeroAddress } from "viem";
import { buildReputationBody, combineTotals } from "../src/identityReputation.js";
import { buildWorkersBody, collectCandidates, type WorkerIdentity, type WorkerScan } from "../src/workers.js";
import { ADAPTER, HUMAN, MIRROR, OWNER_10388, OWNER_2077, POSTER, WALLET_10388, meta } from "./helpers.js";

const context = { chainId: 143, adapter: ADAPTER };
const block = { number: 1000n, hash: `0x${"ab".repeat(32)}` as const, timestamp: 1_792_000_000n };

test("candidates: assigned providers and contest entrants, de-duplicated, in job order", () => {
  const { candidates, truncated } = collectCandidates([
    { meta: meta({ isTaken: true, agentId: 10388n, assignedProvider: WALLET_10388 }) },
    { meta: meta({ isTaken: true, agentId: 10388n, assignedProvider: WALLET_10388 }) }, // same agent again
    { meta: meta({ isTaken: true, assignedProvider: HUMAN }) },
    { meta: meta({ isTaken: true, assignedProvider: HUMAN.toUpperCase().replace("0X", "0x") as `0x${string}` }) }, // same wallet, other case
    { meta: meta({ isTaken: false, agentId: 9n }) }, // never taken: not a worker
    {
      meta: meta({ contest: true }),
      entries: [
        { agentId: 2077n, entrant: OWNER_2077, resultHash: "ipfs://a", awarded: false },
        { agentId: 0n, entrant: POSTER, resultHash: "ipfs://b", awarded: false },
        { agentId: 10388n, entrant: WALLET_10388, resultHash: "ipfs://c", awarded: true },
      ],
    },
  ]);
  assert.deepEqual(candidates, [
    { kind: "agent", agentId: 10388n },
    { kind: "human", wallet: HUMAN },
    { kind: "agent", agentId: 2077n },
    { kind: "human", wallet: POSTER },
  ]);
  assert.equal(truncated, false);
});

test("candidates: a taken bounty with no usable identity adds nothing, and the cap is reported", () => {
  const empty = collectCandidates([{ meta: meta({ isTaken: true, agentId: 0n, assignedProvider: zeroAddress }) }]);
  assert.deepEqual(empty, { candidates: [], truncated: false });
  const many = collectCandidates(
    Array.from({ length: 10 }, (_, index) => ({ meta: meta({ isTaken: true, agentId: BigInt(index + 1) }) })),
    4,
  );
  assert.equal(many.candidates.length, 4);
  assert.equal(many.truncated, true);
});

const agent = (agentId: bigint, owner: `0x${string}`, paidJobs: bigint, scoreSum: bigint): WorkerIdentity => ({
  kind: "agent",
  agentId,
  owner,
  workingWallet: null,
  paidJobs,
  scoreSum,
});

const scan = (identities: WorkerIdentity[], overrides: Partial<WorkerScan> = {}): WorkerScan => ({
  block,
  totalJobs: 5n,
  jobsScanned: 5,
  identities,
  identitiesTruncated: false,
  unresolved: 0,
  ...overrides,
});

test("workers: only identities that pass the gate, best average first, boundary included", () => {
  const body = buildWorkersBody(
    context,
    scan([
      agent(1n, OWNER_10388, 3n, 240n), // exactly 80: passes
      agent(2n, OWNER_2077, 3n, 239n), // 79.66: fails
      agent(3n, OWNER_2077, 4n, 380n), // 95: passes, listed first
      { kind: "human", wallet: HUMAN, paidJobs: 3n, scoreSum: 270n }, // 90
      agent(4n, OWNER_2077, 2n, 200n), // too few jobs
    ]),
    { minJobs: 3, minAvgScore: 80 },
  );
  assert.equal(body.count, 3);
  assert.deepEqual(
    body.workers.map((worker) => ("agentId" in worker ? `agent:${worker.agentId}` : `human:${worker.wallet}`)),
    ["agent:3", `human:${HUMAN}`, "agent:1"],
  );
  assert.deepEqual(body.workers[0].tiers, { proven: true, top: false });
  assert.equal(body.workers[2].averageScore, "80.00");
  assert.deepEqual(body.gate.minJobs, 3);
});

test("workers: a stricter gate changes the list, a gate nobody meets yields an empty list", () => {
  const identities = [agent(1n, OWNER_10388, 10n, 900n), agent(2n, OWNER_2077, 10n, 899n)];
  assert.equal(buildWorkersBody(context, scan(identities), { minJobs: 10, minAvgScore: 90 }).count, 1);
  assert.equal(buildWorkersBody(context, scan(identities), { minJobs: 11, minAvgScore: 0 }).count, 0);
});

test("workers: the scope states the candidate set and every limitation", () => {
  const body = buildWorkersBody(
    context,
    scan([agent(1n, OWNER_10388, 3n, 270n)], {
      totalJobs: 450n,
      jobsScanned: 300,
      identitiesTruncated: true,
      unresolved: 2,
    }),
    { minJobs: 3, minAvgScore: 80 },
  );
  assert.equal(body.scope.jobsScanned, 300);
  assert.equal(body.scope.totalJobs, "450");
  assert.equal(body.scope.jobCap, 300);
  assert.equal(body.scope.truncated, true);
  assert.equal(body.scope.identitiesTruncated, true);
  assert.equal(body.scope.unresolvedIdentities, 2);
  assert.equal(body.scope.identitiesConsidered, 3);
  assert.match(body.scope.candidateSet, /first jobs of this adapter/);
  assert.match(body.scope.candidateSet, /Event logs are not scanned/);
  assert.match(body.scope.limitation, /beyond the first 300/);
  assert.equal(body.sourceBlock, 1000n);
});

test("reputation: sums add exactly, averages are weighted and the gate flags follow the adapter rule", () => {
  const local = { paidJobs: 1n, scoreSum: 95n };
  const records = [
    { paidJobs: 2n, scoreSum: 170n, sourceBlock: 52_341_683n, updatedAt: 1_791_000_000n },
    { paidJobs: 0n, scoreSum: 0n, sourceBlock: 0n, updatedAt: 0n },
  ];
  assert.deepEqual(combineTotals(local, records), { paidJobs: 3n, scoreSum: 265n });
  const body = buildReputationBody({
    context,
    block,
    agentId: 10388n,
    identityOwner: OWNER_10388,
    workingWallet: WALLET_10388,
    mirror: MIRROR,
    local,
    records,
    onChainTotals: { paidJobs: 3n, scoreSum: 265n },
  });
  assert.equal(body.combined.averageScore, "88.33");
  assert.equal(body.local.averageScore, "95.00");
  assert.equal(body.mirror.records[0].chain, "base");
  assert.equal(body.mirror.records[0].sourceBlock, "52341683");
  assert.equal(body.mirror.records[1].chain, "arc");
  assert.equal(body.mirror.records[1].averageScore, null);
  assert.equal(body.gates.proven.passes, true); // 265 >= 80 * 3
  assert.equal(body.gates.top.passes, false);
  assert.equal(body.workingWallet, WALLET_10388);
  assert.equal(body.identityOwner, OWNER_10388);
});

test("reputation: a zero working wallet is reported as null and Top needs ten jobs", () => {
  const body = buildReputationBody({
    context,
    block,
    agentId: 5n,
    identityOwner: OWNER_2077,
    workingWallet: zeroAddress,
    mirror: MIRROR,
    local: { paidJobs: 4n, scoreSum: 360n },
    records: [
      { paidJobs: 6n, scoreSum: 540n, sourceBlock: 1n, updatedAt: 1n },
      { paidJobs: 0n, scoreSum: 0n, sourceBlock: 0n, updatedAt: 0n },
    ],
    onChainTotals: { paidJobs: 10n, scoreSum: 900n },
  });
  assert.equal(body.workingWallet, null);
  assert.equal(body.gates.top.passes, true); // 900 == 90 * 10
});

test("reputation: numbers that disagree with the adapter total are never published", () => {
  assert.throws(
    () =>
      buildReputationBody({
        context,
        block,
        agentId: 1n,
        identityOwner: OWNER_10388,
        workingWallet: null,
        mirror: MIRROR,
        local: { paidJobs: 1n, scoreSum: 95n },
        records: [
          { paidJobs: 0n, scoreSum: 0n, sourceBlock: 0n, updatedAt: 0n },
          { paidJobs: 0n, scoreSum: 0n, sourceBlock: 0n, updatedAt: 0n },
        ],
        onChainTotals: { paidJobs: 1n, scoreSum: 96n },
      }),
    /disagree/,
  );
});
