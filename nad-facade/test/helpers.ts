import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, SupportedResponse } from "@x402/core/types";
import type { Express } from "express";
import { zeroAddress, type Address } from "viem";
import type { BountyMeta, Call, CallResult, ChainClient, ContestEntry, PinnedBlock } from "../src/chain.js";
import { configuration } from "../src/config.js";
import { createApp, type Deps } from "../src/createApp.js";
import { createFacilitator, type FacilitatorHandle } from "../src/facilitator.js";
import { TokenBucketLimiter } from "../src/rateLimit.js";

export const TREASURY = "0x74678c072Ca546f11466CD44eB7e21730a312a54" as const;
export const ADAPTER = "0x5C38F98Fb3F3BA3eB8206Cb653eeDC8C159E1bE4" as const;
export const IDENTITY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const;
export const MIRROR = "0x05e17AaCBf7c8e47D4Db4B9108f66f846ceDdAC5" as const;
export const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as const;

export const mainnetConfig = (extra: NodeJS.ProcessEnv = {}) =>
  configuration({
    NAD_NETWORK: "monad-mainnet",
    NAD_BOUNTY_ADAPTER_ADDRESS: ADAPTER,
    NAD_X402_PAY_TO: TREASURY,
    ...extra,
  });

export function meta(overrides: Partial<BountyMeta> = {}): BountyMeta {
  return {
    jobId: 0n,
    poster: zeroAddress,
    reward: 0n,
    deadline: 0n,
    ipfsDescHash: "",
    category: "dev",
    tags: [],
    agentId: 0n,
    agentOnly: false,
    humanOnly: false,
    whitelistedProvider: zeroAddress,
    assignedProvider: zeroAddress,
    submittedResultHash: "",
    submittedAt: 0n,
    isTaken: false,
    rejectedAt: 0n,
    rejectionReasonHash: "",
    inDispute: false,
    resolved: false,
    disputeInitiator: zeroAddress,
    disputeRaisedAt: 0n,
    disputeReasonHash: "",
    disputeResponseHash: "",
    disputeRulingHash: "",
    requireWorkerBond: false,
    workerBond: 0n,
    bondPayer: zeroAddress,
    disputeByWorker: false,
    contest: false,
    maxEntries: 0,
    winners: 0,
    minJobs: 0n,
    minAvgScore: 0,
    ...overrides,
  } as BountyMeta;
}

export const POSTER = "0x6abc2b575eC66701c17DAD96dDA97F22b837849E" as const;
export const OWNER_10388 = "0x4076F0Ccc2E8c0B94002cAdeDE0186D064EA95e6" as const;
export const WALLET_10388 = "0x0a46d80665E12Cb568541A20d39269F29318D066" as const;
export const OWNER_2077 = "0x22598E3CC0260fd085a40F3c5e7Ef2B2349244a7" as const;
export const HUMAN = "0x1111111111111111111111111111111111111111" as const;

/** A small world shaped like the mainnet deployment: five jobs, two contests, two agents, one human. */
export function world() {
  const metas = new Map<bigint, BountyMeta>([
    [
      1n,
      meta({
        jobId: 1n,
        poster: POSTER,
        reward: 1_000_000n,
        isTaken: true,
        resolved: true,
        agentId: 10388n,
        assignedProvider: WALLET_10388,
      }),
    ],
    [
      2n,
      meta({
        jobId: 2n,
        poster: POSTER,
        reward: 2_000_000n,
        contest: true,
        resolved: true,
        winners: 1,
        maxEntries: 3,
        deadline: 1_791_868_239n,
      }),
    ],
    [
      3n,
      meta({ jobId: 3n, poster: POSTER, reward: 1_000_000n, contest: true, resolved: true, winners: 1, maxEntries: 3 }),
    ],
    [4n, meta({ jobId: 4n, poster: POSTER, reward: 1_000_000n, isTaken: true, assignedProvider: HUMAN })],
    [
      5n,
      meta({
        jobId: 5n,
        poster: POSTER,
        reward: 1_000_000n,
        isTaken: true,
        agentId: 2077n,
        assignedProvider: OWNER_2077,
      }),
    ],
  ]);
  const entries = new Map<bigint, ContestEntry[]>([
    [2n, [{ agentId: 10388n, entrant: WALLET_10388, resultHash: "ipfs://QmCiphertext2", awarded: true }]],
    [3n, []],
  ]);
  const owners = new Map<bigint, Address>([
    [10388n, OWNER_10388],
    [2077n, OWNER_2077],
  ]);
  const wallets = new Map<bigint, Address>([
    [10388n, WALLET_10388],
    [2077n, OWNER_2077],
  ]);
  // identity key -> [paidJobs, scoreSum]; agent keys are 0x..<agentId>, human keys are 0x..h<wallet>.
  const local = new Map<string, readonly [bigint, bigint]>([
    ["agent:10388", [1n, 95n]],
    ["agent:2077", [0n, 0n]],
    [`human:${HUMAN.toLowerCase()}`, [3n, 270n]],
  ]);
  const mirror = new Map<string, readonly [bigint, bigint, bigint, bigint]>([
    [`${OWNER_10388.toLowerCase()}:8453`, [2n, 170n, 52_341_683n, 1_791_000_000n]],
    [`${OWNER_10388.toLowerCase()}:5042`, [0n, 0n, 0n, 0n]],
    [`${OWNER_2077.toLowerCase()}:5042`, [6n, 535n, 24_922_445n, 1_791_000_001n]],
  ]);
  return { metas, entries, owners, wallets, local, mirror, total: 5n, jobIds: [1n, 2n, 3n, 4n, 5n] };
}

export type World = ReturnType<typeof world>;

export type FakeChain = ChainClient & {
  log: { calls: string[]; blocks: number; batches: number };
  world: World;
  block: PinnedBlock;
  failNext: { calls: boolean };
};

const ok = (result: unknown): CallResult => ({ status: "success", result });
const revert = (): CallResult => ({ status: "failure", error: new Error("execution reverted") });

export function fakeChain(chainId = 143): FakeChain {
  const w = world();
  const log = { calls: [] as string[], blocks: 0, batches: 0 };
  const failNext = { calls: false };
  const block: PinnedBlock = { number: 1000n, hash: `0x${"ab".repeat(32)}`, timestamp: 1_792_000_000n };
  const read = (call: Call): CallResult => {
    const args = call.args ?? [];
    switch (call.functionName) {
      case "usdc":
        return ok(USDC);
      case "identityRegistry":
        return ok(IDENTITY);
      case "reputationMirror":
        return ok(MIRROR);
      case "feeBps":
        return ok(100n);
      case "totalBounties":
        return ok(w.total);
      case "allJobIds":
        return ok(w.jobIds[Number(args[0])]);
      case "getBountyMeta":
        return ok(w.metas.get(args[0] as bigint) ?? meta());
      case "getContestEntries": {
        const found = w.entries.get(args[0] as bigint);
        return found ? ok(found) : revert();
      }
      case "getContestState": {
        const id = args[0] as bigint;
        const m = w.metas.get(id);
        if (!m?.contest) return revert();
        return ok([BigInt(w.entries.get(id)?.length ?? 0), 1_791_868_239n, 1_793_077_839n, m.resolved]);
      }
      case "getContestChallengers":
        return ok([]);
      case "ownerOf": {
        const owner = w.owners.get(args[0] as bigint);
        return owner ? ok(owner) : revert();
      }
      case "getAgentWallet":
        return ok(w.wallets.get(args[0] as bigint) ?? zeroAddress);
      case "identityKey":
        return ok(`0x${(args[0] as bigint).toString(16).padStart(64, "0")}`);
      case "localReputation":
        return ok(w.local.get(`agent:${keyToAgent(args[0] as string)}`) ?? [0n, 0n]);
      case "records":
        return ok(w.mirror.get(`${String(args[0]).toLowerCase()}:${args[1]}`) ?? [0n, 0n, 0n, 0n]);
      case "getIdentityReputation": {
        const [agentId, wallet] = args as [bigint, Address];
        if (agentId === 0n) {
          const l = w.local.get(`human:${wallet.toLowerCase()}`) ?? [0n, 0n];
          return ok([l[0], l[1]]);
        }
        const owner = w.owners.get(agentId);
        if (!owner) return revert();
        const l = w.local.get(`agent:${agentId}`) ?? [0n, 0n];
        const base = w.mirror.get(`${owner.toLowerCase()}:8453`) ?? [0n, 0n];
        const arc = w.mirror.get(`${owner.toLowerCase()}:5042`) ?? [0n, 0n];
        return ok([l[0] + base[0] + arc[0], l[1] + base[1] + arc[1]]);
      }
      default:
        return revert();
    }
  };
  return {
    log,
    world: w,
    block,
    failNext,
    async getChainId() {
      return chainId;
    },
    async getBlock() {
      log.blocks++;
      return block;
    },
    async call(calls) {
      if (failNext.calls) throw new Error("rpc down https://rpc.example.invalid/secret-key");
      log.batches++;
      for (const call of calls) log.calls.push(call.functionName);
      return calls.map(read);
    },
  };
}

function keyToAgent(key: string): bigint {
  return BigInt(key);
}

const SUPPORTED: SupportedResponse = {
  kinds: [
    { x402Version: 2, scheme: "exact", network: "eip155:143", extra: {} },
    { x402Version: 2, scheme: "exact", network: "eip155:10143", extra: {} },
  ],
  extensions: [],
  signers: { "eip155:143": ["0x7f6a2850669202519f0FE8aa912451238820Db86"] },
} as SupportedResponse;

export type FakeFacilitator = {
  handle: FacilitatorHandle;
  counts: { supported: number; verify: number; settle: number };
};

export function fakeFacilitator(
  options: {
    supported?: () => Promise<SupportedResponse>;
    verify?: () => Promise<{ isValid: boolean; payer?: string }>;
    timeoutMs?: number;
    ttlMs?: number;
    now?: () => number;
  } = {},
): FakeFacilitator {
  const counts = { supported: 0, verify: 0, settle: 0 };
  const client: FacilitatorClient = {
    async getSupported() {
      counts.supported++;
      return options.supported ? options.supported() : SUPPORTED;
    },
    async verify() {
      counts.verify++;
      return options.verify ? options.verify() : { isValid: true, payer: HUMAN };
    },
    async settle(_payload, requirements) {
      counts.settle++;
      return { success: true, transaction: `0x${"cd".repeat(32)}`, network: requirements.network, payer: HUMAN };
    },
  };
  const handle = createFacilitator({
    url: "https://facilitator.invalid",
    network: "eip155:143",
    io: client,
    probe: client,
    timeoutMs: options.timeoutMs,
    ttlMs: options.ttlMs,
    now: options.now,
    onError: () => undefined,
  });
  return { handle, counts };
}

export type Harness = {
  base: string;
  chain: FakeChain;
  facilitator: FakeFacilitator;
  app: Express;
  close: () => Promise<void>;
};

export async function startApp(
  options: {
    chain?: FakeChain;
    facilitator?: FakeFacilitator;
    limiter?: TokenBucketLimiter;
    routes?: Deps["routes"];
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<Harness> {
  const chain = options.chain ?? fakeChain();
  const facilitator = options.facilitator ?? fakeFacilitator();
  const config = mainnetConfig(options.env);
  const app = createApp(config, {
    chain,
    facilitator: facilitator.handle,
    limiter: options.limiter,
    routes: options.routes,
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    chain,
    facilitator,
    app,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** Build a PAYMENT-SIGNATURE header from a 402 response, the way an x402 client would (signature is a placeholder). */
export function paymentHeaderFrom(challenge: Response): Record<string, string> {
  const header = challenge.headers.get("payment-required");
  if (!header) throw new Error("No PAYMENT-REQUIRED header");
  const required = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: required.resource,
    accepted: required.accepts[0],
    payload: {
      signature: `0x${"11".repeat(65)}`,
      authorization: {
        from: HUMAN,
        to: TREASURY,
        value: required.accepts[0].amount,
        validAfter: "0",
        validBefore: "9999999999",
        nonce: `0x${"22".repeat(32)}`,
      },
    },
  } as PaymentPayload;
  return { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64") };
}

export function decodeRequired(response: Response) {
  const header = response.headers.get("payment-required");
  if (!header) throw new Error("No PAYMENT-REQUIRED header");
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}
