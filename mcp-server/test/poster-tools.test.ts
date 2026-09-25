import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ArcBountyAgent, BountyMeta } from "arcbounty-agent-sdk";
import { createMcpServer } from "../src/tools.js";
import type { SpendLimits } from "../src/limits.js";

const ME = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const ZERO = "0x0000000000000000000000000000000000000000";

function meta(overrides: Partial<BountyMeta> = {}): BountyMeta {
  return {
    jobId: 7n, poster: ME, reward: 5_000_000n, deadline: 2_000_000_000n, ipfsDescHash: "ipfs://QmDesc",
    category: "dev", tags: [], agentId: 0n, agentOnly: false, humanOnly: false,
    whitelistedProvider: ZERO, assignedProvider: OTHER, submittedResultHash: "https://gist.github.com/x/y",
    submittedAt: 1_900_000_000n, isTaken: true, rejectedAt: 0n, rejectionReasonHash: "", inDispute: false,
    resolved: false, disputeInitiator: ZERO, disputeRaisedAt: 0n, disputeReasonHash: "",
    disputeResponseHash: "", disputeRulingHash: "", requireWorkerBond: false, workerBond: 0n,
    ...overrides,
  } as BountyMeta;
}

/** The chain layer is the one thing replaced: every call is recorded, nothing is sent. */
function fakeAgent(opts: { bounty?: BountyMeta; balanceUsdc?: number; failCreate?: boolean } = {}) {
  const calls = {
    createBounty: [] as unknown[],
    approveBounty: [] as unknown[][],
    cancelBounty: [] as unknown[],
  };
  const agent = {
    address: ME,
    network: {
      name: "Arc Testnet",
      brand: { name: "ArcBounty", domain: "testnet.arcbounty.app" },
      nativeCurrency: { isUsdc: true, symbol: "USDC" },
    },
    formatUsdc: (raw: bigint) => (Number(raw) / 1e6).toFixed(2),
    usdcBalance: async () => BigInt(Math.round((opts.balanceUsdc ?? 100) * 1e6)),
    createBounty: async (o: unknown) => {
      calls.createBounty.push(o);
      if (opts.failCreate) throw new Error("execution reverted");
      return { hash: "0xabc", jobId: 42n };
    },
    getBounty: async () => opts.bounty ?? meta(),
    getBountyDescription: async () => "# A task",
    getPostedBounties: async () => [opts.bounty ?? meta()],
    approveBounty: async (jobId: bigint, score: number) => {
      calls.approveBounty.push([jobId, score]);
      return { hash: "0xdef" };
    },
    cancelBounty: async (jobId: bigint) => {
      calls.cancelBounty.push(jobId);
      return { hash: "0xc0c" };
    },
  };
  return { agent: agent as unknown as ArcBountyAgent, calls };
}

async function connect(agent: ArcBountyAgent, limits?: SpendLimits, hasSigner = true) {
  const server = createMcpServer({ agent, hasSigner, version: "test", limits });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0]!.text;
  return { isError: Boolean(res.isError), text };
}

const POST = {
  title: "Check our docs for dead links",
  description: "Open every link on https://example.test/docs and report the broken ones.",
  reward_usdc: 5,
  deadline_days: 7,
  category: "content",
};

describe("post_bounty", () => {
  it("pins the title and description as one document and posts with the given terms", async () => {
    const { agent, calls } = fakeAgent();
    const client = await connect(agent);

    const res = await call(client, "post_bounty", { ...POST, tags: ["docs"], human_only: true });

    expect(res.isError).toBe(false);
    expect(calls.createBounty).toEqual([{
      rewardUsdc: 5,
      deadline: 7 * 86_400,
      descriptionText: `# ${POST.title}\n\n${POST.description}`,
      category: "content",
      tags: ["docs"],
      agentOnly: false,
      humanOnly: true,
    }]);
    expect(JSON.parse(res.text)).toMatchObject({
      jobId: "42", txHash: "0xabc", url: "https://testnet.arcbounty.app/bounty/42",
    });
  });

  it("refuses a reward above the per-bounty cap without touching the chain", async () => {
    const { agent, calls } = fakeAgent();
    const client = await connect(agent, { maxRewardUsdc: 20, maxSpendUsdc: 50 });

    const res = await call(client, "post_bounty", { ...POST, reward_usdc: 25 });

    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/ARCBOUNTY_MAX_REWARD_USDC/);
    expect(calls.createBounty).toHaveLength(0);
  });

  it("stops once this session's total would pass the spend cap", async () => {
    const { agent, calls } = fakeAgent();
    const client = await connect(agent, { maxRewardUsdc: 20, maxSpendUsdc: 30 });

    expect((await call(client, "post_bounty", { ...POST, reward_usdc: 20 })).isError).toBe(false);
    const second = await call(client, "post_bounty", { ...POST, reward_usdc: 15 });

    expect(second.isError).toBe(true);
    expect(second.text).toMatch(/ARCBOUNTY_MAX_SPEND_USDC/);
    expect(calls.createBounty).toHaveLength(1);
  });

  it("does not count a failed post against the session cap", async () => {
    const failing = fakeAgent({ failCreate: true });
    const client = await connect(failing.agent, { maxRewardUsdc: 20, maxSpendUsdc: 20 });

    expect((await call(client, "post_bounty", { ...POST, reward_usdc: 20 })).isError).toBe(true);
    expect((await call(client, "post_bounty", { ...POST, reward_usdc: 20 })).text).not.toMatch(/ARCBOUNTY_MAX_SPEND_USDC/);
    expect(failing.calls.createBounty).toHaveLength(2);
  });

  it("refuses when the wallet cannot cover the reward", async () => {
    const { agent, calls } = fakeAgent({ balanceUsdc: 1 });
    const client = await connect(agent);

    const res = await call(client, "post_bounty", POST);

    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/holds 1\.00 USDC/);
    expect(calls.createBounty).toHaveLength(0);
  });

  it("refuses agent_only together with human_only", async () => {
    const { agent, calls } = fakeAgent();
    const client = await connect(agent);

    const res = await call(client, "post_bounty", { ...POST, agent_only: true, human_only: true });

    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/agent_only.*human_only/);
    expect(calls.createBounty).toHaveLength(0);
  });
});

describe("approve_bounty", () => {
  it("pays out a submission on a bounty this wallet posted, with the given score", async () => {
    const { agent, calls } = fakeAgent();
    const client = await connect(agent);

    const res = await call(client, "approve_bounty", { jobId: "7", score: 90 });

    expect(res.isError).toBe(false);
    expect(calls.approveBounty).toEqual([[7n, 90]]);
    expect(JSON.parse(res.text)).toMatchObject({ txHash: "0xdef" });
  });

  it("refuses a bounty another wallet posted", async () => {
    const { agent, calls } = fakeAgent({ bounty: meta({ poster: OTHER }) });
    const client = await connect(agent);

    const res = await call(client, "approve_bounty", { jobId: "7", score: 90 });

    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/posted by/);
    expect(calls.approveBounty).toHaveLength(0);
  });

  it("refuses a bounty with nothing submitted yet", async () => {
    const { agent, calls } = fakeAgent({ bounty: meta({ submittedResultHash: "" }) });
    const client = await connect(agent);

    const res = await call(client, "approve_bounty", { jobId: "7", score: 90 });

    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/nothing has been submitted/);
    expect(calls.approveBounty).toHaveLength(0);
  });
});

describe("cancel_bounty", () => {
  it("refunds an untaken bounty this wallet posted", async () => {
    const { agent, calls } = fakeAgent({ bounty: meta({ isTaken: false, assignedProvider: ZERO, submittedResultHash: "" }) });
    const client = await connect(agent);

    const res = await call(client, "cancel_bounty", { jobId: "7" });

    expect(res.isError).toBe(false);
    expect(calls.cancelBounty).toEqual([7n]);
  });

  it("refuses once a worker has taken the bounty", async () => {
    const { agent, calls } = fakeAgent();
    const client = await connect(agent);

    const res = await call(client, "cancel_bounty", { jobId: "7" });

    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/already taken/);
    expect(calls.cancelBounty).toHaveLength(0);
  });
});

describe("reading a poster's side", () => {
  it("get_my_posted_bounties lists this wallet's bounties", async () => {
    const { agent } = fakeAgent();
    const client = await connect(agent);

    const res = await call(client, "get_my_posted_bounties", {});

    expect(JSON.parse(res.text)).toMatchObject([{ jobId: "7", poster: ME }]);
  });

  it("get_bounty includes the submitted result so a poster can review it", async () => {
    const { agent } = fakeAgent();
    const client = await connect(agent);

    const res = await call(client, "get_bounty", { jobId: "7" });

    expect(JSON.parse(res.text)).toMatchObject({ submittedResult: "https://gist.github.com/x/y" });
  });

  it("registers no spending tools without a signer", async () => {
    const { agent } = fakeAgent();
    const client = await connect(agent, undefined, false);

    const names = (await client.listTools()).tools.map(t => t.name);

    for (const tool of ["post_bounty", "approve_bounty", "cancel_bounty", "get_my_posted_bounties"]) {
      expect(names).not.toContain(tool);
    }
  });
});
