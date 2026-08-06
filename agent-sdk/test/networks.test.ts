import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  NETWORKS,
  resolveNetwork,
  CONTRACTS,
  ARC_TESTNET_RPC,
  ARC_TESTNET_CHAIN_ID,
  ArcBountyAgent,
} from "../src/index.js";

// NOTE: this is a PLACEHOLDER chain id for tests only. The real Arc mainnet
// chain id is not published by Circle yet and must never be hardcoded.
const FAKE_MAINNET_ENV: Record<string, string> = {
  ARC_MAINNET_CHAIN_ID:            "777001",
  ARC_MAINNET_RPC_URL:             "https://rpc.example-mainnet.invalid",
  ARC_MAINNET_EXPLORER_URL:        "https://explorer.example-mainnet.invalid",
  ARC_MAINNET_EXPLORER_API_URL:    "https://explorer.example-mainnet.invalid/api",
  ARC_MAINNET_AGENTIC_COMMERCE:    "0x00000000000000000000000000000000000000a1",
  ARC_MAINNET_IDENTITY_REGISTRY:   "0x00000000000000000000000000000000000000a2",
  ARC_MAINNET_REPUTATION_REGISTRY: "0x00000000000000000000000000000000000000a3",
  ARC_MAINNET_USDC:                "0x00000000000000000000000000000000000000a4",
};
const FAKE_ADAPTER = "0x00000000000000000000000000000000000000a5";

const MAINNET_REQUIRED_VARS = Object.keys(FAKE_MAINNET_ENV);

// Deterministic, well-known dev key — never used on a real network.
const DUMMY_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001" as const;

/** Reach into the agent's private viem client to assert the actual chain wiring. */
function clientOf(agent: ArcBountyAgent): { chain: { id: number }; transport: { url?: string } } {
  return (agent as unknown as { publicClient: { chain: { id: number }; transport: { url?: string } } })
    .publicClient;
}

describe("resolveNetwork — arc-testnet", () => {
  it("returns the static testnet entry unchanged", () => {
    const net = resolveNetwork("arc-testnet", {});
    expect(net.chainId).toBe(5_042_002);
    expect(net.name).toBe("Arc Testnet");
    expect(net.caip2).toBe("eip155:5042002");
    expect(net.rpcUrl).toBe("https://rpc.testnet.arc.network");
    expect(net.explorerUrl).toBe("https://testnet.arcscan.app");
    expect(net.explorerApiUrl).toBe("https://testnet.arcscan.app/api");
    expect(net.contracts).toEqual({
      AGENTIC_COMMERCE:    "0x0747EEf0706327138c69792bF28Cd525089e4583",
      IDENTITY_REGISTRY:   "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      REPUTATION_REGISTRY: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
      USDC:                "0x3600000000000000000000000000000000000000",
    });
    expect(net.defaultBountyAdapter).toBe("0x538CD48789667168bfb36f838Af8476237F9409F");
    expect(net.adapterDeployBlock).toBe(50_610_373);
    expect(net.testnet).toBe(true);
    expect(net.blocksPerDay).toBe(86_400);
  });

  it("lets ARC_RPC_URL override only the RPC URL (pre-0.5 behavior)", () => {
    const net = resolveNetwork("arc-testnet", { ARC_RPC_URL: "http://localhost:8545" });
    expect(net.rpcUrl).toBe("http://localhost:8545");
    expect(net.chainId).toBe(5_042_002);
    // The shared static entry must not be mutated by the override.
    expect(NETWORKS["arc-testnet"].rpcUrl).toBe("https://rpc.testnet.arc.network");
  });

  it("returns a copy — mutating the result never touches NETWORKS", () => {
    const net = resolveNetwork("arc-testnet", {});
    net.rpcUrl = "http://mutated.invalid";
    net.contracts.USDC = "0x00000000000000000000000000000000000000ff";
    expect(NETWORKS["arc-testnet"].rpcUrl).toBe("https://rpc.testnet.arc.network");
    expect(NETWORKS["arc-testnet"].contracts.USDC).toBe("0x3600000000000000000000000000000000000000");
  });
});

describe("resolveNetwork — arc-mainnet", () => {
  it("throws one error naming every missing variable and the docs source of truth", () => {
    let error: Error | null = null;
    try {
      resolveNetwork("arc-mainnet", {});
    } catch (e) {
      error = e as Error;
    }
    expect(error).not.toBeNull();
    for (const varName of MAINNET_REQUIRED_VARS) {
      expect(error!.message).toContain(varName);
    }
    expect(error!.message).toContain("docs.arc.io/arc/references/contract-addresses");
  });

  it("names only the variables that are actually missing", () => {
    const env = { ...FAKE_MAINNET_ENV };
    delete env["ARC_MAINNET_USDC"];
    delete env["ARC_MAINNET_RPC_URL"];
    let message = "";
    try {
      resolveNetwork("arc-mainnet", env);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("ARC_MAINNET_USDC");
    expect(message).toContain("ARC_MAINNET_RPC_URL");
    expect(message).not.toContain("ARC_MAINNET_CHAIN_ID");
    expect(message).not.toContain("ARC_MAINNET_IDENTITY_REGISTRY");
  });

  it("treats empty/whitespace values as missing", () => {
    const env = { ...FAKE_MAINNET_ENV, ARC_MAINNET_USDC: "  " };
    expect(() => resolveNetwork("arc-mainnet", env)).toThrowError(/ARC_MAINNET_USDC/);
  });

  it("resolves a full config from env", () => {
    const net = resolveNetwork("arc-mainnet", FAKE_MAINNET_ENV);
    expect(net.chainId).toBe(777_001);
    expect(net.name).toBe("Arc");
    expect(net.caip2).toBe("eip155:777001");
    expect(net.rpcUrl).toBe(FAKE_MAINNET_ENV["ARC_MAINNET_RPC_URL"]);
    expect(net.explorerUrl).toBe(FAKE_MAINNET_ENV["ARC_MAINNET_EXPLORER_URL"]);
    expect(net.explorerApiUrl).toBe(FAKE_MAINNET_ENV["ARC_MAINNET_EXPLORER_API_URL"]);
    expect(net.contracts).toEqual({
      AGENTIC_COMMERCE:    FAKE_MAINNET_ENV["ARC_MAINNET_AGENTIC_COMMERCE"],
      IDENTITY_REGISTRY:   FAKE_MAINNET_ENV["ARC_MAINNET_IDENTITY_REGISTRY"],
      REPUTATION_REGISTRY: FAKE_MAINNET_ENV["ARC_MAINNET_REPUTATION_REGISTRY"],
      USDC:                FAKE_MAINNET_ENV["ARC_MAINNET_USDC"],
    });
    expect(net.testnet).toBe(false);
    expect(net.defaultBountyAdapter).toBeUndefined();
    expect(net.adapterDeployBlock).toBeUndefined();
    expect(net.blocksPerDay).toBe(86_400); // default when ARC_MAINNET_BLOCKS_PER_DAY is unset
  });

  it("parses the optional adapter / deploy-block / blocks-per-day vars", () => {
    const net = resolveNetwork("arc-mainnet", {
      ...FAKE_MAINNET_ENV,
      ARC_MAINNET_BOUNTY_ADAPTER: FAKE_ADAPTER,
      ARC_MAINNET_ADAPTER_DEPLOY_BLOCK: "0",
      ARC_MAINNET_BLOCKS_PER_DAY: "43200",
    });
    expect(net.defaultBountyAdapter).toBe(FAKE_ADAPTER);
    expect(net.adapterDeployBlock).toBe(0);
    expect(net.blocksPerDay).toBe(43_200);
  });

  it("rejects malformed addresses, naming the offending variable", () => {
    const env = { ...FAKE_MAINNET_ENV, ARC_MAINNET_USDC: "0xnot-an-address" };
    expect(() => resolveNetwork("arc-mainnet", env)).toThrowError(/ARC_MAINNET_USDC/);
  });

  it("rejects a non-integer chain id", () => {
    const env = { ...FAKE_MAINNET_ENV, ARC_MAINNET_CHAIN_ID: "soon" };
    expect(() => resolveNetwork("arc-mainnet", env)).toThrowError(/ARC_MAINNET_CHAIN_ID/);
  });
});

describe("ArcBountyAgent constructor — network wiring", () => {
  beforeEach(() => {
    // Isolate from whatever the host shell has configured.
    vi.stubEnv("BOUNTY_ADAPTER_ADDRESS", undefined);
    vi.stubEnv("ARC_RPC_URL", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function stubMainnetEnv(extra: Record<string, string> = {}): void {
    for (const [key, value] of Object.entries({ ...FAKE_MAINNET_ENV, ...extra })) {
      vi.stubEnv(key, value);
    }
  }

  it("defaults to arc-testnet with the canonical adapter", () => {
    const agent = new ArcBountyAgent({ privateKey: DUMMY_KEY });
    expect(agent.network.chainId).toBe(5_042_002);
    expect(clientOf(agent).chain.id).toBe(5_042_002);
    expect((agent as unknown as { bountyAdapter: string }).bountyAdapter)
      .toBe("0x538CD48789667168bfb36f838Af8476237F9409F");
  });

  it("keeps the testnet chain id when only rpcUrl is overridden", () => {
    const agent = new ArcBountyAgent({ privateKey: DUMMY_KEY, rpcUrl: "http://localhost:8545" });
    expect(clientOf(agent).chain.id).toBe(5_042_002);
    expect(clientOf(agent).transport.url).toBe("http://localhost:8545");
  });

  it("explicit bountyAdapterAddress beats the env var and the network default", () => {
    vi.stubEnv("BOUNTY_ADAPTER_ADDRESS", "0x00000000000000000000000000000000000000e1");
    const agent = new ArcBountyAgent({
      privateKey: DUMMY_KEY,
      bountyAdapterAddress: FAKE_ADAPTER,
    });
    expect((agent as unknown as { bountyAdapter: string }).bountyAdapter).toBe(FAKE_ADAPTER);
  });

  it("network: 'arc-mainnet' + full env yields a client on the env chain id", () => {
    stubMainnetEnv({ ARC_MAINNET_BOUNTY_ADAPTER: FAKE_ADAPTER });
    const agent = new ArcBountyAgent({ privateKey: DUMMY_KEY, network: "arc-mainnet" });
    expect(agent.network.chainId).toBe(777_001);
    expect(agent.network.testnet).toBe(false);
    expect(clientOf(agent).chain.id).toBe(777_001);
    expect(clientOf(agent).transport.url).toBe(FAKE_MAINNET_ENV["ARC_MAINNET_RPC_URL"]);
    expect((agent as unknown as { bountyAdapter: string }).bountyAdapter).toBe(FAKE_ADAPTER);
    expect(agent.network.contracts.USDC).toBe(FAKE_MAINNET_ENV["ARC_MAINNET_USDC"]);
  });

  it("mainnet rpcUrl override changes the transport, NOT the chain id (0.4.x bug)", () => {
    stubMainnetEnv({ ARC_MAINNET_BOUNTY_ADAPTER: FAKE_ADAPTER });
    const agent = new ArcBountyAgent({
      privateKey: DUMMY_KEY,
      network: "arc-mainnet",
      rpcUrl: "http://localhost:9999",
    });
    expect(clientOf(agent).chain.id).toBe(777_001);
    expect(clientOf(agent).transport.url).toBe("http://localhost:9999");
  });

  it("network: 'arc-mainnet' without env throws, naming the missing vars", () => {
    expect(() => new ArcBountyAgent({ privateKey: DUMMY_KEY, network: "arc-mainnet" }))
      .toThrowError(/ARC_MAINNET_CHAIN_ID[\s\S]*docs\.arc\.io/);
  });

  it("mainnet ignores the generic testnet BOUNTY_ADAPTER_ADDRESS env var", () => {
    stubMainnetEnv(); // no ARC_MAINNET_BOUNTY_ADAPTER
    vi.stubEnv("BOUNTY_ADAPTER_ADDRESS", "0x538CD48789667168bfb36f838Af8476237F9409F");
    expect(() => new ArcBountyAgent({ privateKey: DUMMY_KEY, network: "arc-mainnet" }))
      .toThrowError(/no BountyAdapter address/);
  });
});

describe("deprecated 0.4.x aliases", () => {
  it("stay exported and wired to the arc-testnet entry", () => {
    expect(ARC_TESTNET_RPC).toBe(NETWORKS["arc-testnet"].rpcUrl);
    expect(ARC_TESTNET_CHAIN_ID).toBe(NETWORKS["arc-testnet"].chainId);
    expect(CONTRACTS).toEqual(NETWORKS["arc-testnet"].contracts);
    expect(CONTRACTS.USDC).toBe("0x3600000000000000000000000000000000000000");
    expect(CONTRACTS.AGENTIC_COMMERCE).toBe("0x0747EEf0706327138c69792bF28Cd525089e4583");
    expect(CONTRACTS.IDENTITY_REGISTRY).toBe("0x8004A818BFB912233c491871b3d84c89A494BD9e");
    expect(CONTRACTS.REPUTATION_REGISTRY).toBe("0x8004B663056A597Dffe9eCcC1965A193B7388713");
  });
});
