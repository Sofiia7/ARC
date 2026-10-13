import { vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { MONAD_NETWORKS } from "../../src/constants.js";

/**
 * Shared fakes for NadBountyAgent tests: no network, no real keys. Test files wire them in with
 *   vi.mock("viem", async (importOriginal) => (await import("./helpers/nadMock.js")).viemMock(await importOriginal()));
 *   vi.mock("../src/signers/viemSigner.js", async () => (await import("./helpers/nadMock.js")).signerMock());
 */
export const mock = {
  chain: vi.fn(),
  read: vi.fn(),
  multicall: vi.fn(),
  block: vi.fn(),
  estimate: vi.fn(),
  wait: vi.fn(),
  write: vi.fn(),
  balance: vi.fn(),
  getLogs: vi.fn(),
  client: vi.fn(),
};

type Reader = unknown | ((args: readonly unknown[], call: { address: string; functionName: string }) => unknown);
/** What `readContract` / `multicall` answer, keyed by function name. */
export const state: { reads: Record<string, Reader>; now: bigint } = { reads: {}, now: 1_800_000_000n };

export const THROWAWAY_KEYS = {
  owner: `0x${"01".repeat(32)}`,
  worker: `0x${"02".repeat(32)}`,
  stranger: `0x${"03".repeat(32)}`,
} as const;
export const addresses = {
  owner: privateKeyToAccount(THROWAWAY_KEYS.owner).address,
  worker: privateKeyToAccount(THROWAWAY_KEYS.worker).address,
  stranger: privateKeyToAccount(THROWAWAY_KEYS.stranger).address,
};
export const hash = `0x${"ab".repeat(32)}` as const;
export const ZERO = "0x0000000000000000000000000000000000000000" as const;

/** The wiring answers of the canonical mainnet adapter. */
export function mainnetWiring(): Record<string, Reader> {
  const n = MONAD_NETWORKS["monad-mainnet"];
  return {
    usdc: n.usdc,
    identityRegistry: n.identity,
    reputationRegistry: n.reputation,
    agenticCommerce: n.agenticCommerce,
    reputationMirror: n.reputationMirror,
  };
}

export function resetMocks(reads: Record<string, Reader> = {}, chainId = 143) {
  vi.clearAllMocks();
  state.reads = { ...reads };
  state.now = 1_800_000_000n;
  mock.chain.mockResolvedValue(chainId);
  mock.estimate.mockResolvedValue(101n);
  mock.write.mockResolvedValue(hash);
  mock.wait.mockResolvedValue({ status: "success", transactionHash: hash, logs: [] });
  mock.balance.mockResolvedValue(5n * 10n ** 18n);
  mock.block.mockImplementation(async () => ({ timestamp: state.now }));
  mock.read.mockImplementation(async (call: { address: string; functionName: string; args?: readonly unknown[] }) => {
    const answer = state.reads[call.functionName];
    if (answer === undefined) throw new Error(`Unexpected read ${call.functionName}`);
    return typeof answer === "function"
      ? (answer as (a: readonly unknown[], c: typeof call) => unknown)(call.args ?? [], call)
      : answer;
  });
  // allowFailure:false semantics: plain values, the whole batch fails if one call fails.
  mock.multicall.mockImplementation(
    async ({ contracts }: { contracts: { address: string; functionName: string; args?: readonly unknown[] }[] }) =>
      Promise.all(contracts.map((call) => mock.read(call))),
  );
}

export function viemMock(original: typeof import("viem")) {
  return {
    ...original,
    createPublicClient: vi.fn((config: unknown) => {
      mock.client(config);
      return {
        getChainId: mock.chain,
        readContract: mock.read,
        multicall: mock.multicall,
        getBlock: mock.block,
        estimateContractGas: mock.estimate,
        waitForTransactionReceipt: mock.wait,
        getBalance: mock.balance,
        getLogs: mock.getLogs,
      };
    }),
  };
}

export function signerMock() {
  return {
    ViemSigner: class {
      readonly address: `0x${string}`;
      readonly account: ReturnType<typeof privateKeyToAccount>;
      constructor(privateKey: `0x${string}`) {
        this.account = privateKeyToAccount(privateKey);
        this.address = this.account.address;
      }
      writeContract = (params: unknown) => mock.write(params);
      signMessage = (message: string) => this.account.signMessage({ message });
      signTypedData = (data: unknown) => this.account.signTypedData(data as never);
    },
  };
}
