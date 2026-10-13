import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NadBountyError, generateContestKeypair, type NadBountyAgent } from "arcbounty-agent-sdk";
import { createNadMcpServer, createFailureOutcome, type CreateNadMcpServerOptions } from "../src/nad-tools.js";

const ME = "0x1111111111111111111111111111111111111111";
const OWNER = "0x4444444444444444444444444444444444444444";
const WORKER = "0x5555555555555555555555555555555555555555";
const ZERO = "0x0000000000000000000000000000000000000000";
const NOW = 1_800_000_000n;
const WEEK = (NOW + 7n * 86_400n).toString();
const KEY = `0x${"11".repeat(32)}`;

/** A full fake of the SDK client: every chain and network call is a recorded stub, nothing is sent. */
function fakeAgent(overrides: Record<string, unknown> = {}) {
  const receipt = (hash = "0xabc") => ({ transactionHash: hash, status: "success", gasUsed: 42n, blockNumber: 7n });
  const base = {
    address: ME,
    networkName: "monad-mainnet",
    bountyAdapter: "0x2222222222222222222222222222222222222222",
    network: {
      chainId: 143,
      usdc: "0x3333333333333333333333333333333333333333",
      identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      explorerUrl: "https://monadscan.com",
    },
    isPaused: vi.fn(async () => false),
    maxBountyAmount: vi.fn(async () => 100_000_000n),
    feeBps: vi.fn(async () => 100n),
    usdcBalance: vi.fn(async () => 100_000_000n),
    monBalance: vi.fn(async () => 5n * 10n ** 18n),
    pin: vi.fn(async () => "ipfs://QmPinned"),
    pinDescription: vi.fn(async () => "ipfs://QmDescription"),
    pinContestEntry: vi.fn(async () => "ipfs://QmSealed"),
    createBounty: vi.fn(async () => ({ jobId: 48n, receipt: receipt("0x123") })),
    registerIdentity: vi.fn(async () => ({ agentId: 77n, hash: "0xreg", receipt: receipt("0xreg") })),
    getIdentity: vi.fn(async () => ({ owner: OWNER, workingWallet: WORKER })),
    signAgentWalletConsent: vi.fn(async (o: { agentId: bigint; owner: string }) => ({
      agentId: o.agentId,
      newWallet: ME,
      owner: o.owner,
      deadline: NOW + 300n,
      signature: `0x${"ab".repeat(65)}`,
    })),
    setAgentWallet: vi.fn(async () => receipt("0xset")),
    unsetAgentWallet: vi.fn(async () => receipt("0xunset")),
    getIdentityReputation: vi.fn(async () => [2n, 180n] as const),
    localReputation: vi.fn(async () => ({ paidJobs: 2n, scoreSum: 180n })),
    getMirrorTotals: vi.fn(async () => ({ paidJobs: 1n, scoreSum: 90n })),
    getMirrorRecords: vi.fn(async () => ({
      base: { paidJobs: 1n, scoreSum: 90n, sourceBlock: 5n, updatedAt: NOW },
      arc: { paidJobs: 0n, scoreSum: 0n, sourceBlock: 0n, updatedAt: 0n },
    })),
    uniquePosterCount: vi.fn(async () => 1n),
    getAgentReputation: vi.fn(async () => ({ averageScore: 90n, totalFeedbacks: 2n, totalJobs: 2n })),
    getMyPostedBounties: vi.fn(async () => [1n, 2n, 3n]),
    getMyAssignedBounties: vi.fn(async () => [9n]),
    getBounty: vi.fn(async (id: bigint) => meta({ jobId: id })),
    getBountyDescription: vi.fn(async () => ({ title: "T", description: "Do the thing" })),
    listOpenBounties: vi.fn(async () => [meta({ jobId: 4n }), meta({ jobId: 5n })]),
    getPendingActions: vi.fn(async () => []),
    getPendingWithdrawals: vi.fn(async () => ({ address: 2_500_000n, identity: 0n })),
    takeBounty: vi.fn(async () => receipt("0xtake")),
    submitWork: vi.fn(async () => receipt("0xsubmit")),
    approveBounty: vi.fn(async () => receipt("0xapprove")),
    rejectBounty: vi.fn(async () => receipt("0xreject")),
    withdrawRejection: vi.fn(async () => receipt("0xwr")),
    challengeRejection: vi.fn(async () => receipt("0xch")),
    disputeBounty: vi.fn(async () => receipt("0xdisp")),
    respondToDispute: vi.fn(async () => receipt("0xresp")),
    enterContest: vi.fn(async () => receipt("0xenter")),
    replaceContestEntry: vi.fn(async () => receipt("0xrepl")),
    pickContestWinners: vi.fn(async () => receipt("0xpick")),
    rejectAllContestEntries: vi.fn(async () => receipt("0xrej")),
    challengeContestRejection: vi.fn(async () => receipt("0xcc")),
    respondToContestChallenges: vi.fn(async () => receipt("0xrcc")),
    acceptContestChallengers: vi.fn(async () => receipt("0xacc")),
    withdraw: vi.fn(async () => receipt("0xw")),
    withdrawIdentity: vi.fn(async () => receipt("0xwi")),
    ...Object.fromEntries(
      [
        "autoApprove",
        "cancelBounty",
        "expireBounty",
        "finalizeRejection",
        "claimDefaultRuling",
        "claimArbitratorTimeout",
        "settleContestSilence",
        "finalizeContestRejection",
        "claimContestDefault",
        "claimContestArbitratorTimeout",
        "reconcileExpiredEscrow",
      ].map((name) => [name, vi.fn(async () => receipt(`0x${name}`))]),
    ),
    ...overrides,
  };
  return base as typeof base & NadBountyAgent;
}

function meta(overrides: Record<string, unknown> = {}) {
  return {
    jobId: 1n,
    poster: OWNER,
    reward: 5_000_000n,
    deadline: NOW + 86_400n,
    ipfsDescHash: "ipfs://QmDesc",
    category: "dev",
    tags: [],
    agentId: 0n,
    agentOnly: false,
    humanOnly: false,
    whitelistedProvider: ZERO,
    assignedProvider: ZERO,
    submittedResultHash: "",
    submittedAt: 0n,
    isTaken: false,
    rejectedAt: 0n,
    rejectionReasonHash: "",
    inDispute: false,
    resolved: false,
    disputeInitiator: ZERO,
    disputeRaisedAt: 0n,
    disputeReasonHash: "",
    disputeResponseHash: "",
    disputeRulingHash: "",
    requireWorkerBond: false,
    workerBond: 0n,
    bondPayer: ZERO,
    disputeByWorker: false,
    contest: false,
    maxEntries: 0,
    winners: 0,
    minJobs: 0n,
    minAvgScore: 0,
    ...overrides,
  };
}

type Agent = ReturnType<typeof fakeAgent>;

async function connect(agent: Agent = fakeAgent(), options: Partial<CreateNadMcpServerOptions> = {}, hasSigner = true) {
  const server = createNadMcpServer({
    agent,
    hasSigner,
    version: "test",
    limits: { maxRewardUsdc: 20, maxSpendUsdc: 50 },
    now: () => NOW,
    ...options,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(a);
  return { client, agent };
}

type Result = { isError?: boolean; content: { type: string; text: string }[] };
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  try {
    return (await client.callTool({ name, arguments: args })) as Result;
  } catch (error) {
    // An argument rejected by the schema surfaces as a protocol error.
    return { isError: true, content: [{ type: "text", text: (error as Error).message }] };
  }
}
const text = (r: Result) => r.content[0]!.text;
const data = (r: Result) => JSON.parse(text(r)) as Record<string, any>;

const post = { rewardUsdc: "20", deadline: WEEK, content: "Write the thing", category: "dev" };

describe("tool surface", () => {
  it("registers only reads and local crypto without a key, and says so in network", async () => {
    const { client } = await connect(fakeAgent(), {}, false);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual([
      "network",
      "list_open_bounties",
      "get_bounty",
      "get_contest",
      "get_identity",
      "get_identity_reputation",
      "get_agent_reputation",
      "get_my_bounties",
      "get_pending_actions",
      "balances",
      "encrypt_contest_entry",
      "decrypt_contest_entry",
      "generate_contest_keypair",
    ]);
    const network = data(await call(client, "network"));
    expect(network).toMatchObject({ mode: "read-only", hasSigner: false, gasToken: "MON", chainId: 143 });
    expect(network.board).toMatchObject({ paused: false, maxRewardUsdc: "100", feePercent: 1 });
    expect(network.signer).toBeUndefined();
    await client.close();
  });

  it("registers every write tool with a key, with the new identity, dispute and settlement coverage", async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const expected of [
      "register_agent",
      "sign_agent_wallet_consent",
      "set_agent_wallet",
      "unset_agent_wallet",
      "pin_text",
      "post_bounty",
      "reject_bounty",
      "withdraw_rejection",
      "challenge_rejection",
      "respond_to_dispute",
      "dispute_bounty",
      "withdraw",
      "withdraw_identity",
      "finalize_rejection",
      "claim_default_ruling",
      "claim_arbitrator_timeout",
    ]) {
      expect(names).toContain(expected);
    }
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeLessThanOrEqual(48);
    expect(data(await call(client, "network")).signer).toBe(ME);
    await client.close();
  });

  it("describes every property precisely, never reusing the job-id text for a deadline, and advertises no $ref", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const problems: string[] = [];
    for (const tool of tools) {
      if (!tool.description || tool.description.length < 40) problems.push(`${tool.name}: description too short`);
      if (!/^[A-Z][a-z]+ /.test(tool.description ?? ""))
        problems.push(`${tool.name}: description must start with a verb`);
      const walk = (schema: any, path: string) => {
        if (schema.$ref) problems.push(`${tool.name}.${path}: $ref`);
        for (const [key, value] of Object.entries<any>(schema.properties ?? {})) {
          if (!value.description) problems.push(`${tool.name}.${path}${key}: no description`);
          walk(value, `${path}${key}.`);
        }
        if (schema.items) walk(schema.items, `${path}[].`);
      };
      walk(tool.inputSchema, "");
    }
    expect(problems).toEqual([]);

    const postTool = tools.find((t) => t.name === "post_bounty")!;
    const props = postTool.inputSchema.properties as Record<string, { description: string }>;
    expect(props["deadline"]!.description).toMatch(/unix timestamp in SECONDS/);
    expect(props["deadline"]!.description).not.toMatch(/job id/i);
    expect(props["minJobs"]!.description).toMatch(/paid jobs/);
    expect(props["minJobs"]!.description).not.toMatch(/job id/i);
    expect(props["rewardUsdc"]!.description).toMatch(/up to 6 decimals/);
    expect(props["minAvgScore"]!.description).toMatch(/0-100/);
    await client.close();
  });

  it("accepts a job id sent as a number", async () => {
    const { client, agent } = await connect(fakeAgent(), {}, false);
    const r = await call(client, "get_bounty", { jobId: 48, includeContent: false });
    expect(r.isError).toBeFalsy();
    expect(agent.getBounty).toHaveBeenCalledWith(48n);
    expect((await call(client, "get_bounty", { jobId: "abc" })).isError).toBe(true);
    await client.close();
  });
});

describe("read tools", () => {
  it("lists open bounties as summaries and pages with nextOffset", async () => {
    const { client, agent } = await connect(fakeAgent(), {}, false);
    const r = data(await call(client, "list_open_bounties", { limit: 2, category: "dev" }));
    expect(agent.listOpenBounties).toHaveBeenCalledWith({ category: "dev", offset: 0n, limit: 2n });
    expect(r).toMatchObject({ count: 2, nextOffset: 2 });
    expect(r.bounties[0]).toMatchObject({ jobId: "4", status: "open", rewardUsdc: "5", kind: "single-taker" });
    await client.close();
  });

  it("get_bounty adds status, description and the delivered work, flagged as untrusted", async () => {
    const delivered = meta({
      jobId: 9n,
      isTaken: true,
      assignedProvider: WORKER,
      submittedResultHash: "ipfs://QmWork",
      submittedAt: NOW - 10n,
    });
    const fetchText = vi.fn(async () => "the delivered text");
    const { client } = await connect(fakeAgent({ getBounty: vi.fn(async () => delivered) }), { fetchText }, false);
    const r = data(await call(client, "get_bounty", { jobId: "9" }));
    expect(r).toMatchObject({ status: "submitted", rewardUsdc: "5", submission: "the delivered text" });
    expect(r.description).toMatchObject({ title: "T" });
    expect(r.contentNotice).toMatch(/untrusted/);
    expect(fetchText).toHaveBeenCalledWith("ipfs://QmWork");
    const lean = data(await call(client, "get_bounty", { jobId: "9", includeContent: false }));
    expect(lean.description).toBeUndefined();
    await client.close();
  });

  it("get_identity_reputation returns paid jobs, score sum and average for a real agent", async () => {
    const { client, agent } = await connect(fakeAgent(), {}, false);
    const r = data(await call(client, "get_identity_reputation", { agentId: "10388" }));
    expect(r).toEqual({ agentId: "10388", paidJobs: "2", scoreSum: "180", averageScore: 90 });
    expect(agent.getIdentityReputation).toHaveBeenCalledWith(10388n, undefined);
    await client.close();
  });

  it("get_identity_reputation refuses agentId 0 without a wallet before any RPC call", async () => {
    const { client, agent } = await connect(fakeAgent(), {}, false);
    const r = await call(client, "get_identity_reputation", { agentId: "0" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/humanWallet/);
    expect(agent.getIdentityReputation).not.toHaveBeenCalled();
    const zero = await call(client, "get_identity_reputation", { agentId: "0", humanWallet: ZERO });
    expect(zero.isError).toBe(true);
    expect(agent.getIdentityReputation).not.toHaveBeenCalled();
    const ok = await call(client, "get_identity_reputation", { agentId: "0", humanWallet: WORKER });
    expect(data(ok)).toMatchObject({ humanWallet: WORKER, paidJobs: "2" });
    expect(agent.getIdentityReputation).toHaveBeenCalledWith(0n, WORKER);
    await client.close();
  });

  it("get_identity_reputation defaults a human to the signing wallet", async () => {
    const { client, agent } = await connect();
    await call(client, "get_identity_reputation", { agentId: "0" });
    expect(agent.getIdentityReputation).toHaveBeenCalledWith(0n, ME);
    await client.close();
  });

  it("get_identity separates owner from working wallet and rejects agentId 0", async () => {
    const { client } = await connect(fakeAgent(), {}, false);
    expect(data(await call(client, "get_identity", { agentId: "7" }))).toEqual({
      agentId: "7",
      owner: OWNER,
      workingWallet: WORKER,
    });
    expect((await call(client, "get_identity", { agentId: "0" })).isError).toBe(true);
    await client.close();
  });

  it("get_agent_reputation combines gate totals, local, mirror records and unique posters", async () => {
    const { client, agent } = await connect(fakeAgent(), {}, false);
    const r = data(await call(client, "get_agent_reputation", { agentId: "10388" }));
    expect(agent.getMirrorTotals).toHaveBeenCalledWith(OWNER);
    expect(r).toMatchObject({
      owner: OWNER,
      gate: { paidJobs: "2", scoreSum: "180", averageScore: 90 },
      local: { paidJobs: "2" },
      uniquePosters: "1",
      erc8004Summary: { totalFeedbacks: "2" },
    });
    expect(r.mirror.base).toMatchObject({ sourceBlock: "5", paidJobs: "1" });
    await client.close();
  });

  it("get_my_bounties lists the newest posted and assigned jobs of a given wallet", async () => {
    const { client, agent } = await connect(fakeAgent(), {}, false);
    const r = data(await call(client, "get_my_bounties", { address: OWNER, limit: 2 }));
    expect(agent.getMyPostedBounties).toHaveBeenCalledWith(OWNER);
    expect(r.posted).toMatchObject({ total: 3, shown: 2 });
    expect(r.posted.bounties.map((b: any) => b.jobId)).toEqual(["3", "2"]);
    expect(r.assigned.total).toBe(1);
    const noWallet = await call(client, "get_my_bounties", {});
    expect(noWallet.isError).toBe(true);
    expect(text(noWallet)).toMatch(/read-only/);
    await client.close();
  });

  it("get_pending_actions maps each action to the tool that performs it", async () => {
    const getPendingActions = vi.fn(async () => [
      { jobId: 5n, role: "poster", kind: "respond", action: "approveBounty", reason: "review", expiresAt: NOW + 3600n },
      { jobId: 6n, role: "worker", kind: "claim", action: "autoApprove", reason: "silent poster" },
    ]);
    const { client } = await connect(fakeAgent({ getPendingActions }), {}, false);
    const r = data(await call(client, "get_pending_actions", { agentId: "7" }));
    expect(getPendingActions).toHaveBeenCalledWith({ agentId: 7n, maxJobs: 200 });
    expect(r.actions[0]).toMatchObject({ jobId: "5", tool: "approve_bounty (or reject_bounty)", secondsLeft: "3600" });
    expect(r.actions[1]).toMatchObject({ tool: "auto_approve", kind: "claim" });
    const none = await call(client, "get_pending_actions", {});
    expect(none.isError).toBe(true);
    expect(text(none)).toMatch(/address or agentId/);
    await client.close();
  });

  it("balances reports USDC, MON, parked payouts and warns when MON is short", async () => {
    const { client } = await connect(fakeAgent({ monBalance: vi.fn(async () => 5n * 10n ** 16n) }), {}, false);
    const r = data(await call(client, "balances", { address: WORKER }));
    expect(r).toMatchObject({ usdc: "100", mon: "0.05", lowOnGas: true, parkedUsdc: { forWallet: "2.5" } });
    expect(r.warning).toMatch(/MON/);
    await client.close();
  });

  it("get_contest lists entries in order and only the challenged ones", async () => {
    const challenge = (at: bigint) => ({
      challengedAt: at,
      respondedAt: 0n,
      evidenceHash: "ipfs://QmEv",
      responseHash: "",
    });
    const { client } = await connect(
      fakeAgent({
        getBounty: vi.fn(async () => meta({ contest: true, maxEntries: 5, winners: 1 })),
        getContestState: vi.fn(async () => [2n, NOW - 100n, NOW + 1000n, false] as const),
        getContestEntries: vi.fn(async () => [
          { agentId: 1n, entrant: WORKER, resultHash: "ipfs://QmA", awarded: false },
          { agentId: 0n, entrant: OWNER, resultHash: "ipfs://QmB", awarded: false },
        ]),
        getContestChallenge: vi.fn(async (_: bigint, i: number) => (i === 1 ? challenge(NOW - 5n) : challenge(0n))),
      }),
      {},
      false,
    );
    const r = data(await call(client, "get_contest", { jobId: "3" }));
    expect(r.state).toMatchObject({ entryCount: "2", resolved: false });
    expect(r.entries.map((e: any) => e.entryCid)).toEqual(["ipfs://QmA", "ipfs://QmB"]);
    expect(r.challenges).toHaveLength(1);
    expect(r.challenges[0].index).toBe(1);
    await client.close();
  });
});

describe("local contest crypto", () => {
  it("round-trips an entry through generate, encrypt and decrypt from an IPFS reference", async () => {
    const envelope = { current: undefined as unknown };
    const fetchText = vi.fn(async () => JSON.stringify(envelope.current));
    const { client } = await connect(fakeAgent(), { fetchText }, false);
    const keys = data(await call(client, "generate_contest_keypair"));
    expect(keys.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(keys.warning).toMatch(/Save privateKey/);
    envelope.current = data(
      await call(client, "encrypt_contest_entry", { plaintext: "secret answer", posterPublicKey: keys.publicKey }),
    );
    const viaCid = data(
      await call(client, "decrypt_contest_entry", {
        entryCid: "ipfs://QmEntry",
        publicKey: keys.publicKey,
        privateKey: keys.privateKey,
      }),
    );
    expect(viaCid.plaintext).toBe("secret answer");
    const direct = data(
      await call(client, "decrypt_contest_entry", {
        entry: envelope.current,
        publicKey: keys.publicKey,
        privateKey: keys.privateKey,
      }),
    );
    expect(direct.plaintext).toBe("secret answer");
    expect(
      (await call(client, "decrypt_contest_entry", { publicKey: keys.publicKey, privateKey: keys.privateKey })).isError,
    ).toBe(true);
    await client.close();
  });

  it("reports non-envelope content from IPFS as a readable error", async () => {
    const keys = await generateContestKeypair();
    const { client } = await connect(fakeAgent(), { fetchText: async () => "plain text, not an envelope" }, false);
    const r = await call(client, "decrypt_contest_entry", {
      entryCid: "ipfs://QmX",
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not an encrypted entry envelope/);
    await client.close();
  });
});

describe("error text", () => {
  it("never carries an RPC URL, and removes the configured key", async () => {
    const viem = Object.assign(
      new Error("HTTP request failed.\n\nURL: https://rpc.example.com/SECRETKEY\nRequest body: {}"),
      {
        name: "HttpRequestError",
        shortMessage: "HTTP request failed.",
      },
    );
    const plain = new Error(`fetch failed for https://rpc.example.com/SECRETKEY and key ${KEY}`);
    const agent = fakeAgent({ getBounty: vi.fn().mockRejectedValueOnce(viem).mockRejectedValueOnce(plain) });
    const { client } = await connect(agent, { secrets: [KEY] }, false);
    const first = await call(client, "get_bounty", { jobId: "1", includeContent: false });
    expect(first.isError).toBe(true);
    expect(text(first)).toMatch(/RPC request failed/);
    expect(text(first)).not.toMatch(/https?:|SECRETKEY|Request body/);
    const second = await call(client, "get_bounty", { jobId: "1", includeContent: false });
    expect(text(second)).not.toMatch(/https?:|SECRETKEY/);
    expect(text(second)).not.toContain(KEY);
    expect(text(second)).toContain("[redacted]");
    await client.close();
  });

  it("turns a decoded contract revert into a readable message", async () => {
    const revert = new NadBountyError(
      "createBounty: NadBounty is paused: creating bounties is switched off.",
      "paused",
    );
    const { client } = await connect(fakeAgent({ takeBounty: vi.fn().mockRejectedValue(revert) }));
    const r = await call(client, "take_bounty", { jobId: "4" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/paused/);
    await client.close();
  });
});

describe("post_bounty", () => {
  it("preserves the exact six-decimal reward and the contest and gate fields", async () => {
    const { client, agent } = await connect();
    const keys = await generateContestKeypair();
    const r = await call(client, "post_bounty", {
      ...post,
      rewardUsdc: "1.000001",
      contest: true,
      maxEntries: 10,
      winners: 2,
      minJobs: "3",
      minAvgScore: 80,
      contestPublicKey: keys.publicKey,
    });
    expect(r.isError).toBeFalsy();
    expect(agent.createBounty).toHaveBeenCalledWith(
      expect.objectContaining({
        reward: 1_000_001n,
        contest: true,
        maxEntries: 10,
        winners: 2,
        minJobs: 3n,
        minAvgScore: 80,
      }),
    );
    expect(agent.pinDescription).toHaveBeenCalledWith({
      description: "Write the thing",
      contestPublicKey: keys.publicKey,
    });
    expect(data(r)).toMatchObject({
      jobId: "48",
      descriptionCid: "ipfs://QmDescription",
      kind: "contest",
      transactionHash: "0x123",
    });
    await client.close();
  });

  it("uses an existing descriptionCid without pinning, and refuses both or neither", async () => {
    const { client, agent } = await connect();
    const { content: _content, ...withoutContent } = post;
    expect(
      (await call(client, "post_bounty", { ...withoutContent, descriptionCid: "ipfs://QmMine" })).isError,
    ).toBeFalsy();
    expect(agent.pinDescription).not.toHaveBeenCalled();
    expect(agent.createBounty).toHaveBeenCalledWith(expect.objectContaining({ ipfsDescHash: "ipfs://QmMine" }));
    for (const bad of [{ ...post, descriptionCid: "ipfs://QmMine" }, withoutContent]) {
      const r = await call(client, "post_bounty", bad);
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/exactly one of descriptionCid/);
    }
    await client.close();
  });

  it("computes the deadline from deadlineInDays with the server clock", async () => {
    const { client, agent } = await connect();
    const { deadline: _deadline, ...rest } = post;
    await call(client, "post_bounty", { ...rest, deadlineInDays: 2 });
    expect(agent.createBounty).toHaveBeenCalledWith(expect.objectContaining({ deadline: NOW + 2n * 86_400n }));
    await client.close();
  });

  it("rejects a duration, milliseconds, a missing or a doubled deadline before anything is reserved", async () => {
    const { client, agent } = await connect();
    const { deadline: _deadline, ...rest } = post;
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ ...post, deadline: "604800" }, /at least 1 hour in the future/],
      [{ ...post, deadline: "1790000000000" }, /milliseconds/],
      [{ ...rest }, /exactly one of deadline/],
      [{ ...post, deadlineInDays: 3 }, /exactly one of deadline/],
      [{ ...rest, deadlineInDays: 0.001 }, /at least 1 hour/],
    ];
    for (const [args, pattern] of cases) {
      const r = await call(client, "post_bounty", args);
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(pattern);
    }
    expect(agent.createBounty).not.toHaveBeenCalled();
    // Nothing was reserved: two full-size posts still fit under the 50 USDC cap.
    expect((await call(client, "post_bounty", { ...post, rewardUsdc: "20" })).isError).toBeFalsy();
    expect((await call(client, "post_bounty", { ...post, rewardUsdc: "20" })).isError).toBeFalsy();
    await client.close();
  });

  it("refuses incompatible flags and a contest without a key before any transaction", async () => {
    const { client, agent } = await connect();
    for (const args of [
      { ...post, agentOnly: true, humanOnly: true },
      { ...post, contest: true, requireWorkerBond: true, contestPublicKey: "A".repeat(43) },
      { ...post, contest: true },
      { ...post, rewardUsdc: "0.5" },
      { ...post, rewardUsdc: "25" },
    ]) {
      expect((await call(client, "post_bounty", args)).isError).toBe(true);
    }
    expect(agent.createBounty).not.toHaveBeenCalled();
    await client.close();
  });

  it("reserves spend capacity before concurrent creates await the RPC", async () => {
    const { client, agent } = await connect(fakeAgent(), { limits: { maxRewardUsdc: 20, maxSpendUsdc: 25 } });
    const results = await Promise.all([call(client, "post_bounty", post), call(client, "post_bounty", post)]);
    expect(results.filter((r) => r.isError)).toHaveLength(1);
    expect(agent.createBounty).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it("blocks a post that would pass the per-run cap and names the NAD variable", async () => {
    const { client } = await connect();
    await call(client, "post_bounty", post);
    await call(client, "post_bounty", post);
    const third = await call(client, "post_bounty", post);
    expect(third.isError).toBe(true);
    expect(text(third)).toMatch(/NAD_MAX_SPEND_USDC/);
    const tooBig = await call(client, "post_bounty", { ...post, rewardUsdc: "21" });
    expect(text(tooBig)).toMatch(/NAD_MAX_REWARD_USDC/);
    await client.close();
  });

  describe("spend reservation after a failure", () => {
    /** After `fail`, how many full 20 USDC posts still fit under the 50 USDC cap (3 failures first). */
    async function successesAfterThreeFailures(fail: () => Promise<never>) {
      const createBounty = vi.fn(fail);
      const { client } = await connect(fakeAgent({ createBounty }));
      for (let i = 0; i < 3; i++) expect((await call(client, "post_bounty", post)).isError).toBe(true);
      createBounty.mockImplementation((async () => ({
        jobId: 1n,
        receipt: { transactionHash: "0x1", status: "success" },
      })) as never);
      let ok = 0;
      while (ok < 5 && !(await call(client, "post_bounty", post)).isError) ok++;
      await client.close();
      return ok;
    }

    it("releases it when parameter validation rejected the call", async () => {
      expect(
        await successesAfterThreeFailures(async () => {
          throw new NadBountyError("createBounty parameters: bad", "INVALID_PARAMS");
        }),
      ).toBe(2);
    });
    it("releases it when estimation decoded a contract revert", async () => {
      expect(
        await successesAfterThreeFailures(async () => {
          throw new NadBountyError("createBounty: paused", "paused");
        }),
      ).toBe(2);
    });
    it("releases it on insufficient MON for gas", async () => {
      expect(
        await successesAfterThreeFailures(async () => {
          throw new NadBountyError("createBounty: no MON", "INSUFFICIENT_FUNDS");
        }),
      ).toBe(2);
    });
    it("releases it when the chain check or the USDC approval failed on the network", async () => {
      expect(
        await successesAfterThreeFailures(async () => {
          throw new NadBountyError("verify RPC chain: The Monad RPC request failed", "NETWORK");
        }),
      ).toBe(2);
      expect(
        await successesAfterThreeFailures(async () => {
          throw new NadBountyError("approve: The Monad RPC request failed", "NETWORK");
        }),
      ).toBe(2);
    });
    it("releases it when the createBounty transaction was mined and reverted", async () => {
      expect(
        await successesAfterThreeFailures(async () => {
          throw new Error(
            "Monad transaction reverted: 0xdead (https://monadscan.com/tx/0xdead). It was estimated to succeed.",
          );
        }),
      ).toBe(2);
    });
    it("releases it when the receipt itself says reverted", async () => {
      const createBounty = vi.fn(async () => ({
        jobId: 0n,
        receipt: { transactionHash: "0xbad", status: "reverted" },
      }));
      const { client } = await connect(fakeAgent({ createBounty }));
      for (let i = 0; i < 3; i++) {
        const r = await call(client, "post_bounty", post);
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/reverted on chain/);
      }
      createBounty.mockResolvedValue({ jobId: 2n, receipt: { transactionHash: "0x2", status: "success" } });
      expect((await call(client, "post_bounty", post)).isError).toBeFalsy();
      await client.close();
    });
    it("releases it for failures before the createBounty step: paused, low USDC, no MON, bad cap", async () => {
      const agent = fakeAgent();
      const { client } = await connect(agent);
      const attempts: [string, () => void][] = [
        ["paused", () => agent.isPaused.mockResolvedValueOnce(true)],
        ["on-chain per-bounty cap", () => agent.maxBountyAmount.mockResolvedValueOnce(10_000_000n)],
        ["holds 1 USDC", () => agent.usdcBalance.mockResolvedValueOnce(1_000_000n)],
        ["no MON", () => agent.monBalance.mockResolvedValueOnce(0n)],
        ["pin", () => agent.pinDescription.mockRejectedValueOnce(new Error("pin failed"))],
      ];
      for (const [pattern, arrange] of attempts) {
        arrange();
        const r = await call(client, "post_bounty", post);
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(new RegExp(pattern, "i"));
      }
      expect(agent.createBounty).not.toHaveBeenCalled();
      expect((await call(client, "post_bounty", post)).isError).toBeFalsy();
      expect((await call(client, "post_bounty", post)).isError).toBeFalsy();
      await client.close();
    });

    it("keeps it when the outcome is unknown: a transport failure on createBounty itself", async () => {
      expect(
        await successesAfterThreeFailures(async () => {
          throw new NadBountyError("createBounty: The Monad RPC request failed", "NETWORK");
        }),
      ).toBe(0);
    });
    it("keeps it when the confirmation never arrived", async () => {
      expect(
        await successesAfterThreeFailures(async () => {
          throw new NadBountyError("waiting for the transaction: Timed out", "UNKNOWN");
        }),
      ).toBe(0);
    });
    it("keeps it when the transaction confirmed but its event could not be read (the reward is locked)", async () => {
      expect(
        await successesAfterThreeFailures(async () => {
          throw new Error("Missing BountyCreated event in confirmed transaction 0xabc");
        }),
      ).toBe(0);
    });
    it("keeps it for an error it does not recognise", async () => {
      expect(
        await successesAfterThreeFailures(async () => {
          throw new Error("something unexpected");
        }),
      ).toBe(0);
    });

    it("tells the caller the outcome is unknown and how to reconcile", async () => {
      const { client } = await connect(
        fakeAgent({
          createBounty: vi.fn(async () => {
            throw new NadBountyError("createBounty: The Monad RPC request failed", "NETWORK");
          }),
        }),
      );
      const r = await call(client, "post_bounty", post);
      expect(text(r)).toMatch(/outcome is unknown/);
      expect(text(r)).toMatch(/get_my_bounties/);
      expect(text(r)).toMatch(/20 USDC stays counted/);
      await client.close();
    });

    it("keeps it after a success", async () => {
      const { client } = await connect();
      expect((await call(client, "post_bounty", post)).isError).toBeFalsy();
      expect((await call(client, "post_bounty", post)).isError).toBeFalsy();
      expect((await call(client, "post_bounty", post)).isError).toBe(true);
      expect(data(await call(client, "network")).spendCaps).toMatchObject({
        reservedThisRunUsdc: "40",
        remainingThisRunUsdc: 10,
      });
      await client.close();
    });
  });
});

describe("createFailureOutcome", () => {
  const cases: [string, unknown, "not-escrowed" | "uncertain"][] = [
    ["validation", new NadBountyError("createBounty parameters: x", "INVALID_PARAMS"), "not-escrowed"],
    ["decoded revert", new NadBountyError("createBounty: x", "reward too low"), "not-escrowed"],
    ["custom error", new NadBountyError("createBounty: x", "ReputationGateFailed"), "not-escrowed"],
    ["insufficient funds", new NadBountyError("createBounty: x", "INSUFFICIENT_FUNDS"), "not-escrowed"],
    ["chain check", new NadBountyError("verify RPC chain: x", "NETWORK"), "not-escrowed"],
    ["deployment check", new NadBountyError("verify deployment: x", "UNKNOWN"), "not-escrowed"],
    ["allowance read", new NadBountyError("allowance: x", "NETWORK"), "not-escrowed"],
    ["approve", new NadBountyError("approve: x", "UNKNOWN"), "not-escrowed"],
    ["wrong chain", new Error("Wrong Monad RPC chain"), "not-escrowed"],
    ["adapter mismatch", new Error("V4.8 usdc mismatch"), "not-escrowed"],
    ["no key", new Error("A private key is required for NadBounty writes"), "not-escrowed"],
    [
      "approval not visible",
      new Error("USDC approval is not yet visible to the RPC; retry before creating the bounty"),
      "not-escrowed",
    ],
    ["mined revert", new Error("Monad transaction reverted: 0xabc"), "not-escrowed"],
    ["send failed on the network", new NadBountyError("createBounty: x", "NETWORK"), "uncertain"],
    ["unknown error while sending", new NadBountyError("createBounty: x", "UNKNOWN"), "uncertain"],
    ["receipt wait timeout", new NadBountyError("waiting for the transaction: x", "UNKNOWN"), "uncertain"],
    ["receipt wait network", new NadBountyError("waiting for the transaction: x", "NETWORK"), "uncertain"],
    ["confirmed without event", new Error("Missing BountyCreated event in confirmed transaction 0xabc"), "uncertain"],
    ["unrecognised", new Error("boom"), "uncertain"],
    ["not an Error", "boom", "uncertain"],
  ];
  it.each(cases)("%s", (_name, error, expected) => {
    expect(createFailureOutcome(error)).toBe(expected);
  });
});

describe("tools that take a CID or content", () => {
  it("submit_work pins content, passes the CID and reports the pinned CID", async () => {
    const { client, agent } = await connect();
    const r = data(await call(client, "submit_work", { jobId: "4", content: "# Result" }));
    expect(agent.pin).toHaveBeenCalledWith("# Result");
    expect(agent.submitWork).toHaveBeenCalledWith(4n, "ipfs://QmPinned");
    expect(r).toMatchObject({ transactionHash: "0xsubmit", status: "success", pinnedCid: "ipfs://QmPinned" });
    await client.close();
  });

  it("keeps the CID path and pins nothing", async () => {
    const { client, agent } = await connect();
    await call(client, "submit_work", { jobId: "4", resultCid: "ipfs://QmDone" });
    expect(agent.pin).not.toHaveBeenCalled();
    expect(agent.submitWork).toHaveBeenCalledWith(4n, "ipfs://QmDone");
    await client.close();
  });

  it("requires exactly one of the two for every evidence and reason tool", async () => {
    const { client, agent } = await connect();
    const specs: [string, Record<string, unknown>, string, string][] = [
      ["submit_work", { jobId: "4" }, "resultCid", "content"],
      ["reject_bounty", { jobId: "4" }, "reasonCid", "reason"],
      ["challenge_rejection", { jobId: "4" }, "evidenceCid", "evidence"],
      ["dispute_bounty", { jobId: "4" }, "reasonCid", "reason"],
      ["respond_to_dispute", { jobId: "4" }, "responseCid", "response"],
      ["enter_contest", { jobId: "4" }, "encryptedCid", "content"],
      ["replace_contest_entry", { jobId: "4", index: 0 }, "encryptedCid", "content"],
      ["reject_all_contest_entries", { jobId: "4" }, "reasonCid", "reason"],
      ["challenge_contest_rejection", { jobId: "4", index: 0 }, "evidenceCid", "evidence"],
      ["respond_to_contest_challenges", { jobId: "4" }, "responseCid", "response"],
    ];
    for (const [name, base, cidName, contentName] of specs) {
      const neither = await call(client, name, base);
      expect(neither.isError, `${name} neither`).toBe(true);
      expect(text(neither)).toContain(`exactly one of ${cidName}`);
      const both = await call(client, name, { ...base, [cidName]: "ipfs://QmA", [contentName]: "text" });
      expect(both.isError, `${name} both`).toBe(true);
    }
    expect(agent.pin).not.toHaveBeenCalled();
    expect(agent.pinContestEntry).not.toHaveBeenCalled();
    await client.close();
  });

  it("maps each reason, evidence and response tool to its contract call", async () => {
    const { client, agent } = await connect();
    const specs: [string, Record<string, unknown>, keyof Agent, unknown[]][] = [
      ["reject_bounty", { reason: "wrong" }, "rejectBounty", [4n, "ipfs://QmPinned"]],
      ["challenge_rejection", { evidence: "see" }, "challengeRejection", [4n, "ipfs://QmPinned"]],
      ["dispute_bounty", { reason: "late" }, "disputeBounty", [4n, "ipfs://QmPinned"]],
      ["respond_to_dispute", { response: "no" }, "respondToDispute", [4n, "ipfs://QmPinned"]],
      ["reject_all_contest_entries", { reason: "none fit" }, "rejectAllContestEntries", [4n, "ipfs://QmPinned"]],
      [
        "challenge_contest_rejection",
        { index: 2, evidence: "mine" },
        "challengeContestRejection",
        [4n, 2, "ipfs://QmPinned"],
      ],
      ["respond_to_contest_challenges", { response: "reply" }, "respondToContestChallenges", [4n, "ipfs://QmPinned"]],
    ];
    for (const [name, args, method, expected] of specs) {
      const r = await call(client, name, { jobId: "4", ...args });
      expect(r.isError, name).toBeFalsy();
      expect(agent[method], name).toHaveBeenCalledWith(...expected);
    }
    await client.close();
  });

  it("names the pinned CID when the chain call fails after pinning", async () => {
    const { client } = await connect(
      fakeAgent({
        rejectBounty: vi.fn(async () => {
          throw new NadBountyError("rejectBounty: Only the poster of this bounty can do this.", "only poster");
        }),
      }),
    );
    const r = await call(client, "reject_bounty", { jobId: "4", reason: "bad" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Only the poster/);
    expect(text(r)).toContain("ipfs://QmPinned");
    expect(text(r)).toContain("reasonCid");
    await client.close();
  });

  it("enter_contest seals content to the poster key and never pins plaintext", async () => {
    const { client, agent } = await connect();
    const r = data(await call(client, "enter_contest", { jobId: "4", agentId: 7, content: "my answer" }));
    expect(agent.pinContestEntry).toHaveBeenCalledWith(4n, "my answer");
    expect(agent.pin).not.toHaveBeenCalled();
    expect(agent.enterContest).toHaveBeenCalledWith(4n, 7n, "ipfs://QmSealed");
    expect(r.pinnedCid).toBe("ipfs://QmSealed");
    await call(client, "enter_contest", { jobId: "4", encryptedCid: "ipfs://QmMine" });
    expect(agent.enterContest).toHaveBeenLastCalledWith(4n, 0n, "ipfs://QmMine");
    await call(client, "replace_contest_entry", { jobId: "4", index: 1, content: "better" });
    expect(agent.replaceContestEntry).toHaveBeenCalledWith(4n, 1, "ipfs://QmSealed");
    await client.close();
  });
});

describe("identity tools", () => {
  it("register_agent pins an agent card, mints once, and explains the owner role", async () => {
    const { client, agent } = await connect();
    const description = (await client.listTools()).tools.find((t) => t.name === "register_agent")!.description!;
    expect(description).toMatch(/OWNER/);
    expect(description).toMatch(/WORKING wallet/);
    const r = data(
      await call(client, "register_agent", { name: "Scout", description: "Finds bugs", capabilities: ["audit"] }),
    );
    const pinned = JSON.parse((agent.pin as any).mock.calls[0][0]);
    expect(pinned).toMatchObject({ name: "Scout", description: "Finds bugs", capabilities: ["audit"], active: true });
    expect(agent.registerIdentity).toHaveBeenCalledWith("ipfs://QmPinned");
    expect(r).toMatchObject({ agentId: "77", owner: ME, transactionHash: "0xreg" });
    const again = await call(client, "register_agent", {});
    expect(again.isError).toBe(true);
    expect(text(again)).toMatch(/already registered agentId 77/);
    expect(agent.registerIdentity).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it("register_agent accepts a bare registration and refuses name together with metadataUri", async () => {
    const { client, agent } = await connect();
    expect((await call(client, "register_agent", { name: "x", metadataUri: "ipfs://QmA" })).isError).toBe(true);
    expect(agent.registerIdentity).not.toHaveBeenCalled();
    await call(client, "register_agent", {});
    expect(agent.registerIdentity).toHaveBeenCalledWith("");
    await client.close();
  });

  it("signs a consent with the working wallet and hands it to the owner, who submits it", async () => {
    const { client, agent } = await connect();
    const signed = data(await call(client, "sign_agent_wallet_consent", { agentId: "7", owner: OWNER }));
    expect(agent.signAgentWalletConsent).toHaveBeenCalledWith({ agentId: 7n, owner: OWNER });
    expect(signed.consent).toMatchObject({ agentId: "7", newWallet: ME, owner: OWNER, deadline: String(NOW + 300n) });
    expect(signed.next).toMatch(/set_agent_wallet/);
    const set = data(await call(client, "set_agent_wallet", { consent: signed.consent }));
    expect(agent.setAgentWallet).toHaveBeenCalledWith(7n, {
      agentId: 7n,
      newWallet: ME,
      owner: OWNER,
      deadline: NOW + 300n,
      signature: `0x${"ab".repeat(65)}`,
    });
    expect(set.transactionHash).toBe("0xset");
    await client.close();
  });

  it("unsets the working wallet and withdraws parked identity payouts", async () => {
    const { client, agent } = await connect();
    await call(client, "unset_agent_wallet", { agentId: "7" });
    expect(agent.unsetAgentWallet).toHaveBeenCalledWith(7n);
    await call(client, "withdraw_identity", { agentId: "7" });
    expect(agent.withdrawIdentity).toHaveBeenCalledWith(7n);
    await call(client, "withdraw");
    expect(agent.withdraw).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it("pin_text pins and returns the CID", async () => {
    const { client, agent } = await connect();
    const r = data(await call(client, "pin_text", { content: "hello" }));
    expect(agent.pin).toHaveBeenCalledWith("hello");
    expect(r).toEqual({ uri: "ipfs://QmPinned", cid: "QmPinned", bytes: 5 });
    await client.close();
  });
});

describe("settlement and decision tools", () => {
  it("each settlement tool calls its contract method with the job id", async () => {
    const { client, agent } = await connect();
    const map: Record<string, keyof Agent> = {
      auto_approve: "autoApprove",
      cancel_bounty: "cancelBounty",
      expire_bounty: "expireBounty",
      finalize_rejection: "finalizeRejection",
      claim_default_ruling: "claimDefaultRuling",
      claim_arbitrator_timeout: "claimArbitratorTimeout",
      settle_contest_silence: "settleContestSilence",
      finalize_contest_rejection: "finalizeContestRejection",
      claim_contest_default: "claimContestDefault",
      claim_contest_arbitrator_timeout: "claimContestArbitratorTimeout",
      reconcile_expired_escrow: "reconcileExpiredEscrow",
      withdraw_rejection: "withdrawRejection",
    };
    for (const [tool, method] of Object.entries(map)) {
      const r = await call(client, tool, { jobId: "12" });
      expect(r.isError, tool).toBeFalsy();
      expect(agent[method], tool).toHaveBeenCalledWith(12n);
      expect(data(r).explorerUrl).toContain("https://monadscan.com/tx/");
    }
    await client.close();
  });

  it("approve, take and pick winners check their arguments", async () => {
    const { client, agent } = await connect();
    expect((await call(client, "approve_bounty", { jobId: "4", score: 101 })).isError).toBe(true);
    await call(client, "approve_bounty", { jobId: "4", score: 90 });
    expect(agent.approveBounty).toHaveBeenCalledWith(4n, 90);
    await call(client, "take_bounty", { jobId: "4", agentId: "7" });
    expect(agent.takeBounty).toHaveBeenCalledWith(4n, 7n);
    await call(client, "take_bounty", { jobId: "4" });
    expect(agent.takeBounty).toHaveBeenLastCalledWith(4n, 0n);
    expect((await call(client, "pick_contest_winners", { jobId: "4", indices: [0, 1], scores: [90] })).isError).toBe(
      true,
    );
    expect(
      (await call(client, "pick_contest_winners", { jobId: "4", indices: [1, 1], scores: [90, 80] })).isError,
    ).toBe(true);
    expect(agent.pickContestWinners).not.toHaveBeenCalled();
    await call(client, "pick_contest_winners", { jobId: "4", indices: [0, 2], scores: [90, 80] });
    expect(agent.pickContestWinners).toHaveBeenCalledWith(4n, [0, 2], [90, 80]);
    expect((await call(client, "accept_contest_challengers", { jobId: "4", indices: [0], scores: [] })).isError).toBe(
      true,
    );
    await client.close();
  });
});
