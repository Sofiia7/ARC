import test from "node:test";
import assert from "node:assert/strict";
import { fetchNadStats, parseNadStats, profileHref, toDecimal, toUsdc, usdcFromDecimal } from "../lib/nadBoardApi";
import { buildNadStatsReport, type NadStatsMeta } from "../lib/nadStats";

const NOW = 1_800_000_000n;
const ZERO = "0x0000000000000000000000000000000000000000";
const POSTER = "0x00000000000000000000000000000000000000a1";
const HUMAN = "0x00000000000000000000000000000000000000b2";
const OWNER = "0x0a46d80665E12Cb568541A20d39269F29318D066";

const statsMeta = (o: Partial<NadStatsMeta>): NadStatsMeta => ({
  jobId: 1n,
  poster: POSTER,
  reward: 1_000_000n,
  deadline: NOW + 86400n,
  agentId: 0n,
  assignedProvider: ZERO,
  submittedResultHash: "",
  isTaken: false,
  rejectedAt: 0n,
  inDispute: false,
  resolved: false,
  disputeRaisedAt: 0n,
  disputeResponseHash: "",
  disputeRulingHash: "",
  disputeByWorker: false,
  contest: false,
  maxEntries: 0,
  ...o,
});

// The real report from lib/nadStats.ts, serialised the way app/api/nad/stats/route.ts does it.
function wireSample() {
  const report = buildNadStatsReport(
    [
      {
        meta: statsMeta({ jobId: 1n, resolved: true, isTaken: true, submittedResultHash: "bafy", agentId: 10388n }),
        escrowStatus: 3,
        entries: [],
      },
      {
        meta: statsMeta({ jobId: 2n, reward: 2_000_000n, contest: true, resolved: true, maxEntries: 5 }),
        escrowStatus: 3,
        entries: [{ agentId: 0n, entrant: HUMAN, awarded: true }],
      },
      { meta: statsMeta({ jobId: 3n }), escrowStatus: 0, entries: [] },
    ],
    { nowSec: NOW, ownerOf: (id) => (id === 10388n ? OWNER : undefined) },
  );
  const body = {
    chainId: 143,
    adapter: "0xf88B980B3AB1CD5A2Befd9c0B88B70196f215020",
    sourceBlock: "112984473",
    sourceBlockHash: "0xabc",
    generatedAt: "2026-10-13T10:00:00.000Z",
    coverage: { jobsRead: 3, totalBounties: 3, truncated: false },
    ...report,
  };
  return JSON.parse(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? String(v) : v)));
}

test("parseNadStats reads what lib/nadStats.ts and the route really produce", () => {
  const data = parseNadStats(wireSample());
  assert.ok(data);
  assert.equal(data.sourceBlock, "112984473");
  assert.equal(data.chainId, 143);
  assert.deepEqual(data.coverage, { jobsRead: "3", totalBounties: "3", truncated: false });
  assert.equal(data.stats.posted, "3");
  assert.equal(data.stats.open, "1");
  assert.equal(data.stats.settledPaid, "2");
  assert.equal(data.stats.paidOutUsdc, "2.97");
  assert.equal(data.stats.feesUsdc, "0.03");
  assert.equal(data.stats.uniquePaidIdentities, "2");
  assert.equal(usdcFromDecimal(data.stats.paidOutUsdc), "$2.97");
  // Leaderboard: an agent keyed by id, a human keyed by wallet.
  const agent = data.leaderboard.find((r) => r.agentId === "10388");
  assert.deepEqual(agent, { owner: OWNER, agentId: "10388", paidJobs: "1", usdcEarned: "0.99" });
  assert.equal(data.leaderboard.find((r) => r.agentId === "0")?.owner, HUMAN);
  // Recently settled: newest job id first, kind single or contest.
  assert.deepEqual(
    data.recentlySettled.map((r) => [r.jobId, r.kind, r.reward, r.netPaid, r.agentId]),
    [
      ["2", "contest", "2", "1.98", "0"],
      ["1", "single", "1", "0.99", "10388"],
    ],
  );
});

test("parseNadStats: a missing counter is null, not zero, and bad rows are dropped", () => {
  const wire = wireSample();
  delete wire.stats.refunded;
  wire.stats.feesUsdc = "not a number";
  wire.leaderboard.unshift({ owner: "0x1", agentId: 1 });
  wire.recentlySettled.unshift({ kind: "single" });
  const data = parseNadStats(wire);
  assert.ok(data);
  assert.equal(data.stats.refunded, null);
  assert.equal(data.stats.feesUsdc, null);
  assert.equal(data.stats.posted, "3");
  assert.equal(data.leaderboard.length, 2);
  assert.equal(data.recentlySettled.length, 2);
});

test("parseNadStats rejects payloads that are not stats", () => {
  assert.equal(parseNadStats(null), null);
  assert.equal(parseNadStats("html"), null);
  assert.equal(parseNadStats({ error: "boom" }), null);
  assert.equal(parseNadStats([]), null);
  assert.deepEqual(parseNadStats({ stats: {} })?.leaderboard, []);
  assert.equal(parseNadStats({ stats: {} })?.coverage, null);
});

test("toDecimal accepts non-negative integers only", () => {
  assert.equal(toDecimal("007"), "7");
  assert.equal(toDecimal(12), "12");
  assert.equal(toDecimal(12n), "12");
  assert.equal(toDecimal(-1), null);
  assert.equal(toDecimal(1.5), null);
  assert.equal(toDecimal("1e6"), null);
  assert.equal(toDecimal(undefined), null);
});

test("toUsdc normalises whole-USDC decimals and rejects anything else", () => {
  assert.equal(toUsdc("2.97"), "2.97");
  assert.equal(toUsdc("1"), "1");
  assert.equal(toUsdc("1.500000"), "1.5");
  assert.equal(toUsdc("0"), "0");
  assert.equal(toUsdc(0.99), "0.99");
  assert.equal(toUsdc(5), "5");
  assert.equal(toUsdc("-1"), null);
  assert.equal(toUsdc("1.1234567"), null);
  assert.equal(toUsdc("abc"), null);
  assert.equal(toUsdc(undefined), null);
  assert.equal(toUsdc(Number.NaN), null);
});

test("usdcFromDecimal shows at least cents and never rounds a cent away", () => {
  assert.equal(usdcFromDecimal("2.97"), "$2.97");
  assert.equal(usdcFromDecimal("1"), "$1.00");
  assert.equal(usdcFromDecimal("1.5"), "$1.50");
  assert.equal(usdcFromDecimal("1234.56"), "$1,234.56");
  assert.equal(usdcFromDecimal("0.005"), "$0.005");
  assert.equal(usdcFromDecimal(null), "-");
  assert.equal(usdcFromDecimal(""), "-");
  assert.equal(usdcFromDecimal("oops"), "-");
});

test("profileHref links agents by id and humans by wallet", () => {
  assert.equal(profileHref("10388", "0xabc"), "/profile?agent=10388");
  assert.equal(profileHref("0", OWNER), `/profile?wallet=${OWNER}`);
  assert.equal(profileHref("0", "not an address"), null);
  assert.equal(profileHref("0", ZERO), null);
});

test("fetchNadStats parses a good answer and rejects bad ones", async () => {
  const ok = (async () => new Response(JSON.stringify(wireSample()), { status: 200 })) as unknown as typeof fetch;
  assert.equal((await fetchNadStats({ fetchImpl: ok })).stats.posted, "3");
  const down = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
  await assert.rejects(fetchNadStats({ fetchImpl: down }), /503/);
  const junk = (async () => new Response(JSON.stringify({ hello: 1 }), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(fetchNadStats({ fetchImpl: junk }), /unexpected payload/);
});

test("fetchNadStats gives up after the timeout", async () => {
  const hang = ((_: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;
  await assert.rejects(fetchNadStats({ fetchImpl: hang, timeoutMs: 20 }), /aborted/);
});
