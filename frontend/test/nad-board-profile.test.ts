import test from "node:test";
import assert from "node:assert/strict";
import { isAddress } from "viem";
import {
  GATE_PRESETS,
  PROFILE_EXAMPLES,
  average,
  checkGate,
  describeGate,
  normalizeWallet,
  parseProfileQuery,
  postersLine,
  profilePath,
  profileQuery,
  tierOf,
} from "../lib/nadProfile";
import { loadNadProfile } from "../lib/nadProfileLoad";
import type { ReadCall } from "../lib/nadBoardLoad";

const WALLET = "0x092F4483526eBc2476c247cB88d166aDb7C3232f";

test("gate: integer math with the boundary jobs * minAvg === scoreSum passing", () => {
  // 3 jobs at exactly 80 average: 240 === 80 * 3 passes, 239 does not.
  assert.equal(checkGate(3n, 240n, 3n, 80n).pass, true);
  assert.equal(checkGate(3n, 239n, 3n, 80n).pass, false);
  assert.equal(checkGate(3n, 239n, 3n, 80n).scoreOk, false);
  assert.equal(checkGate(3n, 239n, 3n, 80n).jobsOk, true);
  // 10 jobs at exactly 90 average.
  assert.equal(checkGate(10n, 900n, 10n, 90n).pass, true);
  assert.equal(checkGate(10n, 899n, 10n, 90n).pass, false);
});

test("gate: too few jobs fails even with a perfect score", () => {
  const c = checkGate(2n, 200n, 3n, 80n);
  assert.equal(c.pass, false);
  assert.equal(c.jobsOk, false);
  assert.equal(c.scoreOk, true);
});

test("gate: more jobs than needed still needs the weighted score, not only the minimum count", () => {
  // 6 jobs need 480; 540 passes the Proven gate, 400 does not.
  assert.equal(checkGate(6n, 540n, 3n, 80n).pass, true);
  assert.equal(checkGate(6n, 400n, 3n, 80n).pass, false);
  assert.equal(checkGate(6n, 400n, 3n, 80n).requiredSum, 480n);
});

test("gate: mirrors _checkGate for empty and zero gates", () => {
  assert.equal(checkGate(0n, 0n, 0n, 0n).pass, true);
  assert.equal(checkGate(5n, 0n, 0n, 0n).pass, true);
  // jobs == 0 with a non-zero average requirement fails even when minJobs is 0.
  assert.equal(checkGate(0n, 0n, 0n, 50n).pass, false);
  assert.equal(checkGate(0n, 0n, 1n, 0n).pass, false);
  assert.equal(checkGate(1n, 0n, 1n, 0n).pass, true);
});

test("gate presets are Proven 3+/80+ and Top 10+/90+", () => {
  assert.deepEqual(
    GATE_PRESETS.map((p) => [p.id, p.minJobs, p.minAvg]),
    [
      ["proven", 3n, 80n],
      ["top", 10n, 90n],
    ],
  );
});

test("tierOf picks the highest tier reached", () => {
  assert.equal(tierOf(10n, 900n), "Top");
  assert.equal(tierOf(10n, 850n), "Proven");
  assert.equal(tierOf(3n, 240n), "Proven");
  assert.equal(tierOf(2n, 180n), null);
  assert.equal(tierOf(0n, 0n), null);
});

test("describeGate lists the numbers behind a verdict", () => {
  const failing = describeGate(checkGate(2n, 180n, 3n, 80n));
  assert.deepEqual(failing[0], { label: "Paid jobs", value: "2", need: "3+", ok: false });
  assert.deepEqual(failing[1], { label: "Score sum", value: "180", need: "160+ (80 x 2 jobs)", ok: true });
  const none = describeGate(checkGate(0n, 0n, 3n, 80n));
  assert.equal(none[1].ok, false);
  assert.match(none[1].need, /at least one paid job/);
});

test("average: two decimals, a dash with no paid jobs", () => {
  assert.equal(average(2n, 180n), "90");
  assert.equal(average(3n, 280n), "93.33");
  assert.equal(average(0n, 0n), "-");
});

test("deep links: ?agent= and ?wallet= both parse, in any query-string shape", () => {
  assert.deepEqual(parseProfileQuery("?agent=10388"), { kind: "agent", agentId: 10388n });
  assert.deepEqual(parseProfileQuery("agent=10388"), { kind: "agent", agentId: 10388n });
  assert.deepEqual(parseProfileQuery(`?wallet=${WALLET}`), { kind: "wallet", wallet: WALLET });
  assert.deepEqual(parseProfileQuery(`?wallet=${WALLET.toLowerCase()}`), {
    kind: "wallet",
    wallet: WALLET.toLowerCase(),
  });
  assert.deepEqual(parseProfileQuery(`?utm=x&wallet=${WALLET}`), { kind: "wallet", wallet: WALLET });
});

test("deep links: a non-zero agent wins, agent=0 and garbage fall through", () => {
  assert.deepEqual(parseProfileQuery(`?agent=5&wallet=${WALLET}`), { kind: "agent", agentId: 5n });
  assert.deepEqual(parseProfileQuery(`?agent=0&wallet=${WALLET}`), { kind: "wallet", wallet: WALLET });
  assert.equal(parseProfileQuery("?agent=0"), null);
  assert.equal(parseProfileQuery("?agent=abc"), null);
  assert.equal(parseProfileQuery("?agent=-3"), null);
  assert.equal(parseProfileQuery("?wallet=0x123"), null);
  assert.equal(parseProfileQuery("?wallet="), null);
  assert.equal(parseProfileQuery(""), null);
  assert.equal(parseProfileQuery("?"), null);
  // A mixed-case address with a broken checksum is not accepted as a wallet.
  assert.equal(parseProfileQuery(`?wallet=${WALLET.replace("B", "b")}`), null);
});

test("profile links round-trip through parseProfileQuery", () => {
  for (const example of PROFILE_EXAMPLES) {
    assert.deepEqual(parseProfileQuery(profileQuery(example.target)), example.target);
    assert.equal(profilePath(example.target).startsWith("/profile?"), true);
  }
  assert.equal(profilePath({ kind: "agent", agentId: 10388n }), "/profile?agent=10388");
});

test("the example cards point at a valid agent id and a valid checksummed wallet", () => {
  const wallet = PROFILE_EXAMPLES.find((e) => e.target.kind === "wallet");
  assert.ok(wallet && wallet.target.kind === "wallet");
  assert.equal(isAddress(wallet.target.wallet), true);
  assert.equal(wallet.detail, wallet.target.wallet);
  assert.equal(PROFILE_EXAMPLES[0].target.kind === "agent" && PROFILE_EXAMPLES[0].target.agentId, 10388n);
});

test("normalizeWallet trims and validates", () => {
  assert.equal(normalizeWallet(`  ${WALLET}  `), WALLET);
  assert.equal(normalizeWallet("nope"), null);
  assert.equal(normalizeWallet(""), null);
});

test("postersLine pluralizes", () => {
  assert.equal(postersLine(1n), "Paid by 1 different poster");
  assert.equal(postersLine(0n), "Paid by 0 different posters");
  assert.equal(postersLine(7n), "Paid by 7 different posters");
});

// ---- loader ----------------------------------------------------------------------------------------------------

const ADAPTER = "0x00000000000000000000000000000000000000a1" as const;
const REGISTRY = "0x00000000000000000000000000000000000000d1" as const;
const MIRROR = "0x00000000000000000000000000000000000000c1" as const;
const OWNER = "0x00000000000000000000000000000000000000b1" as const;
const ZERO = "0x0000000000000000000000000000000000000000";

function fakeProfileClient(options: { missingAgent?: boolean; noWorking?: boolean } = {}) {
  const calls: string[] = [];
  const answer = (c: ReadCall): unknown => {
    switch (c.functionName) {
      case "reputationMirror":
        return MIRROR;
      case "ownerOf":
        if (options.missingAgent) throw new Error("ERC721NonexistentToken");
        return OWNER;
      case "getAgentWallet":
        return options.noWorking ? ZERO : "0x00000000000000000000000000000000000000f1";
      case "uniquePosterCount":
        return 4n;
      case "getIdentityReputation":
        return [6n, 540n];
      case "records":
        return c.args?.[1] === 8453n ? [3n, 270n, 99n, 1_700_000_000n] : [0n, 0n, 0n, 0n];
      case "relayer":
        return "0x00000000000000000000000000000000000000e9";
      default:
        throw new Error(`unexpected ${c.functionName}`);
    }
  };
  return {
    calls,
    chain: { contracts: { multicall3: {} } },
    async multicall({ contracts }: { contracts: ReadCall[] }) {
      calls.push(`multicall:${contracts.map((c) => c.functionName).join(",")}`);
      return contracts.map((c) => {
        try {
          return { status: "success", result: answer(c) };
        } catch (error) {
          return { status: "failure", error };
        }
      });
    },
    async readContract(c: ReadCall) {
      return answer(c);
    },
    async getBlock() {
      return { timestamp: 1n };
    },
  };
}
const cfg = { adapter: ADAPTER, identityRegistry: REGISTRY };

test("loadNadProfile (agent): two multicall rounds and everything the page shows", async () => {
  const client = fakeProfileClient();
  const data = await loadNadProfile(client, cfg, { kind: "agent", agentId: 10388n });
  assert.deepEqual(client.calls, [
    "multicall:reputationMirror,ownerOf,getAgentWallet,uniquePosterCount",
    "multicall:getIdentityReputation,records,records,relayer",
  ]);
  assert.equal(data.owner, OWNER);
  assert.equal(data.working, "0x00000000000000000000000000000000000000f1");
  assert.equal(data.uniquePosters, 4n);
  assert.deepEqual(data.total, [6n, 540n]);
  assert.deepEqual(
    data.sources.map((s) => [s.name, s.record[0]]),
    [
      ["Base", 3n],
      ["Arc", 0n],
    ],
  );
  assert.equal(checkGate(data.total[0], data.total[1], 3n, 80n).pass, true);
});

test("loadNadProfile (wallet): no identity reads, no poster count, no working wallet", async () => {
  const client = fakeProfileClient();
  const data = await loadNadProfile(client, cfg, { kind: "wallet", wallet: WALLET });
  assert.equal(client.calls[0], "multicall:reputationMirror");
  assert.equal(data.owner, WALLET);
  assert.equal(data.working, null);
  assert.equal(data.uniquePosters, null);
  assert.equal(data.agentId, 0n);
});

test("loadNadProfile: an unset working wallet is null and a missing agent is a clear error", async () => {
  const data = await loadNadProfile(fakeProfileClient({ noWorking: true }), cfg, { kind: "agent", agentId: 3n });
  assert.equal(data.working, null);
  await assert.rejects(
    loadNadProfile(fakeProfileClient({ missingAgent: true }), cfg, { kind: "agent", agentId: 99999n }),
    /Agent #99999 does not exist/,
  );
});
