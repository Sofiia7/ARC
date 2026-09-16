import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  NETWORKS,
  resolveNetwork,
  CONTRACTS,
  ARC_TESTNET_RPC,
  ARC_TESTNET_CHAIN_ID,
  ArcBountyAgent,
} from "../src/index.js";

const FAKE_ADAPTER = "0x00000000000000000000000000000000000000a5";

const ARC_MAINNET_ADAPTER = "0x73c617e808ED5c7Ca41413DFC6EE940dDcBb0b8D";
const ARC_TESTNET_ADAPTER = "0xeDf2c738915b042da97788b2b5499D4655FB1f20";

// Deterministic, well-known dev key - never used on a real network.
const DUMMY_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001" as const;

/** Reach into the agent's private viem client to assert the actual chain wiring. */
function clientOf(agent: ArcBountyAgent): { chain: { id: number }; transport: { url?: string } } {
  return (agent as unknown as { publicClient: { chain: { id: number }; transport: { url?: string } } })
    .publicClient;
}

describe("resolveNetwork - arc-testnet", () => {
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
    expect(net.defaultBountyAdapter).toBe("0xeDf2c738915b042da97788b2b5499D4655FB1f20");
    expect(net.adapterDeployBlock).toBe(60_965_136);
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

  it("returns a copy - mutating the result never touches NETWORKS", () => {
    const net = resolveNetwork("arc-testnet", {});
    net.rpcUrl = "http://mutated.invalid";
    net.contracts.USDC = "0x00000000000000000000000000000000000000ff";
    expect(NETWORKS["arc-testnet"].rpcUrl).toBe("https://rpc.testnet.arc.network");
    expect(NETWORKS["arc-testnet"].contracts.USDC).toBe("0x3600000000000000000000000000000000000000");
  });
});

describe("resolveNetwork - base-sepolia", () => {
  it("returns the static Base Sepolia entry", () => {
    const net = resolveNetwork("base-sepolia", {});
    expect(net.chainId).toBe(84_532);
    expect(net.name).toBe("Base Sepolia");
    expect(net.caip2).toBe("eip155:84532");
    expect(net.rpcUrl).toBe("https://sepolia.base.org");
    expect(net.explorerUrl).toBe("https://sepolia.basescan.org");
    expect(net.contracts).toEqual({
      AGENTIC_COMMERCE:    "0xbe6e78207140d21d5FcF5595Ad396e482f1Cd384",
      IDENTITY_REGISTRY:   "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      REPUTATION_REGISTRY: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
      USDC:                "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    });
    expect(net.defaultBountyAdapter).toBe("0x32EC90A4dad0bbdFF0eF44461c353aC5C02757F4");
    expect(net.adapterDeployBlock).toBe(45_438_882);
    expect(net.testnet).toBe(true);
    expect(net.blocksPerDay).toBe(43_200);
  });

  it("brands as BaseBounty, separately from Arc's ArcBounty", () => {
    expect(resolveNetwork("base-sepolia", {}).brand)
      .toEqual({ name: "BaseBounty", domain: "basebounty.app" });
    expect(resolveNetwork("arc-testnet", {}).brand)
      .toEqual({ name: "ArcBounty", domain: "testnet.arcbounty.app" });
  });

  it("pays gas in ETH, not USDC - the one thing that differs from Arc", () => {
    expect(resolveNetwork("base-sepolia", {}).nativeCurrency)
      .toEqual({ symbol: "ETH", decimals: 18, isUsdc: false });
    // Arc's native token IS USDC; anything prompting a user to fund a wallet
    // must branch on this rather than assume one model. Natively it has 18
    // decimals (eth_getBalance), 6 only through the ERC-20 interface - and
    // MetaMask refuses wallet_addEthereumChain with anything but 18.
    expect(resolveNetwork("arc-testnet", {}).nativeCurrency)
      .toEqual({ symbol: "USDC", decimals: 18, isUsdc: true });
  });

  it("lets BASE_SEPOLIA_RPC_URL override only the RPC URL", () => {
    const net = resolveNetwork("base-sepolia", { BASE_SEPOLIA_RPC_URL: "http://localhost:8545" });
    expect(net.rpcUrl).toBe("http://localhost:8545");
    expect(net.chainId).toBe(84_532);
    expect(NETWORKS["base-sepolia"].rpcUrl).toBe("https://sepolia.base.org");
  });

  it("does not leak ARC_RPC_URL across networks", () => {
    const net = resolveNetwork("base-sepolia", { ARC_RPC_URL: "http://arc-only.invalid" });
    expect(net.rpcUrl).toBe("https://sepolia.base.org");
  });

  it("returns a copy - mutating the result never touches NETWORKS", () => {
    const net = resolveNetwork("base-sepolia", {});
    net.contracts.USDC = "0x00000000000000000000000000000000000000ff";
    net.nativeCurrency.symbol = "MUTATED";
    net.brand.name = "MUTATED";
    expect(NETWORKS["base-sepolia"].contracts.USDC).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(NETWORKS["base-sepolia"].nativeCurrency.symbol).toBe("ETH");
    expect(NETWORKS["base-sepolia"].brand.name).toBe("BaseBounty");
  });
});

describe("resolveNetwork - base-mainnet", () => {
  it("returns the static Base mainnet entry", () => {
    const net = resolveNetwork("base-mainnet", {});
    expect(net.chainId).toBe(8_453);
    expect(net.name).toBe("Base");
    expect(net.caip2).toBe("eip155:8453");
    expect(net.rpcUrl).toBe("https://mainnet.base.org");
    expect(net.explorerUrl).toBe("https://basescan.org");
    expect(net.contracts).toEqual({
      AGENTIC_COMMERCE:    "0x6D9317eC0Fca3aFd5439d539064DBA94197c4AC4",
      IDENTITY_REGISTRY:   "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      REPUTATION_REGISTRY: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
      USDC:                "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    });
    expect(net.defaultBountyAdapter).toBe("0x9b0B27c20DF10BFc667F4316d7175166Ff8c4c2c");
    expect(net.adapterDeployBlock).toBe(50_576_208);
    expect(net.blocksPerDay).toBe(43_200);
  });

  it("is flagged non-testnet, as is Arc mainnet and nothing else", () => {
    expect(resolveNetwork("base-mainnet", {}).testnet).toBe(false);
    expect(resolveNetwork("arc-mainnet", {}).testnet).toBe(false);
    expect(resolveNetwork("base-sepolia", {}).testnet).toBe(true);
    expect(resolveNetwork("arc-testnet", {}).testnet).toBe(true);
  });

  it("shares BaseBounty branding and ETH gas with Base Sepolia", () => {
    expect(resolveNetwork("base-mainnet", {}).brand)
      .toEqual({ name: "BaseBounty", domain: "basebounty.app" });
    expect(resolveNetwork("base-mainnet", {}).nativeCurrency)
      .toEqual({ symbol: "ETH", decimals: 18, isUsdc: false });
  });

  it("uses its own contracts, never Base Sepolia's", () => {
    const mainnet = resolveNetwork("base-mainnet", {});
    const sepolia = resolveNetwork("base-sepolia", {});
    expect(mainnet.contracts.USDC).not.toBe(sepolia.contracts.USDC);
    expect(mainnet.contracts.AGENTIC_COMMERCE).not.toBe(sepolia.contracts.AGENTIC_COMMERCE);
    expect(mainnet.defaultBountyAdapter).not.toBe(sepolia.defaultBountyAdapter);
    // The 8004 registries are NOT shared across the two Base networks, though
    // this test asserted for two weeks that they were - which is how the
    // Sepolia pair ended up in the mainnet entry, reverting on every call.
    // "0x8004…" is a vanity prefix the 8004 team uses on every chain, not one
    // address deployed at the same place everywhere.
    expect(mainnet.contracts.IDENTITY_REGISTRY).not.toBe(sepolia.contracts.IDENTITY_REGISTRY);
    expect(mainnet.contracts.REPUTATION_REGISTRY).not.toBe(sepolia.contracts.REPUTATION_REGISTRY);
  });

  it("lets BASE_MAINNET_RPC_URL override only the RPC URL", () => {
    const net = resolveNetwork("base-mainnet", { BASE_MAINNET_RPC_URL: "http://localhost:8545" });
    expect(net.rpcUrl).toBe("http://localhost:8545");
    expect(net.chainId).toBe(8_453);
    expect(NETWORKS["base-mainnet"].rpcUrl).toBe("https://mainnet.base.org");
  });

  it("does not leak the Base Sepolia override across networks", () => {
    const net = resolveNetwork("base-mainnet", { BASE_SEPOLIA_RPC_URL: "http://sepolia-only.invalid" });
    expect(net.rpcUrl).toBe("https://mainnet.base.org");
  });

  it("returns a copy - mutating the result never touches NETWORKS", () => {
    const net = resolveNetwork("base-mainnet", {});
    net.contracts.USDC = "0x00000000000000000000000000000000000000ff";
    net.brand.name = "MUTATED";
    expect(NETWORKS["base-mainnet"].contracts.USDC).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(NETWORKS["base-mainnet"].brand.name).toBe("BaseBounty");
  });
});

describe("resolveNetwork - arc-mainnet", () => {
  it("returns the static Arc mainnet entry", () => {
    const net = resolveNetwork("arc-mainnet", {});
    expect(net.chainId).toBe(5_042);
    expect(net.name).toBe("Arc");
    expect(net.caip2).toBe("eip155:5042");
    expect(net.rpcUrl).toBe("https://rpc.blockdaemon.mainnet.arc.io");
    expect(net.explorerUrl).toBe("https://explorer.arc.io");
    expect(net.contracts).toEqual({
      AGENTIC_COMMERCE:    "0x64cA39Fc57315D0D488acCaC07c37C6E841CD058",
      IDENTITY_REGISTRY:   "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      REPUTATION_REGISTRY: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
      USDC:                "0x3600000000000000000000000000000000000000",
    });
    expect(net.defaultBountyAdapter).toBe(ARC_MAINNET_ADAPTER);
    expect(net.adapterDeployBlock).toBe(21_153_190);
    expect(net.blocksPerDay).toBe(170_000);
  });

  it("takes arcbounty.app over from the testnet build, and pays gas in 18-decimal USDC", () => {
    expect(resolveNetwork("arc-mainnet", {}).brand)
      .toEqual({ name: "ArcBounty", domain: "arcbounty.app" });
    expect(resolveNetwork("arc-mainnet", {}).nativeCurrency)
      .toEqual({ symbol: "USDC", decimals: 18, isUsdc: true });
  });

  it("uses Base mainnet's 8004 registries and its own escrow, never Arc testnet's", () => {
    const mainnet = resolveNetwork("arc-mainnet", {});
    const testnet = resolveNetwork("arc-testnet", {});
    // The 8004 team's mainnet pair really is at the same addresses on Arc and
    // Base - checked on both chains, not inferred from the vanity prefix
    // (the inference is what shipped Sepolia's pair to Base mainnet once).
    expect(mainnet.contracts.IDENTITY_REGISTRY).toBe(resolveNetwork("base-mainnet", {}).contracts.IDENTITY_REGISTRY);
    expect(mainnet.contracts.REPUTATION_REGISTRY).toBe(resolveNetwork("base-mainnet", {}).contracts.REPUTATION_REGISTRY);
    expect(mainnet.contracts.IDENTITY_REGISTRY).not.toBe(testnet.contracts.IDENTITY_REGISTRY);
    expect(mainnet.contracts.AGENTIC_COMMERCE).not.toBe(testnet.contracts.AGENTIC_COMMERCE);
    expect(mainnet.defaultBountyAdapter).not.toBe(testnet.defaultBountyAdapter);
    // USDC's ERC-20 interface is the same system address on both Arc networks.
    expect(mainnet.contracts.USDC).toBe(testnet.contracts.USDC);
  });

  it("lets ARC_MAINNET_RPC_URL override only the RPC URL", () => {
    const net = resolveNetwork("arc-mainnet", { ARC_MAINNET_RPC_URL: "http://localhost:8545" });
    expect(net.rpcUrl).toBe("http://localhost:8545");
    expect(net.chainId).toBe(5_042);
    expect(NETWORKS["arc-mainnet"].rpcUrl).toBe("https://rpc.blockdaemon.mainnet.arc.io");
  });

  it("does not leak the testnet ARC_RPC_URL onto mainnet", () => {
    const net = resolveNetwork("arc-mainnet", { ARC_RPC_URL: "https://rpc.testnet.arc.network" });
    expect(net.rpcUrl).toBe("https://rpc.blockdaemon.mainnet.arc.io");
  });

  it("returns a copy - mutating the result never touches NETWORKS", () => {
    const net = resolveNetwork("arc-mainnet", {});
    net.contracts.AGENTIC_COMMERCE = "0x00000000000000000000000000000000000000ff";
    net.brand.domain = "mutated.invalid";
    expect(NETWORKS["arc-mainnet"].contracts.AGENTIC_COMMERCE).toBe("0x64cA39Fc57315D0D488acCaC07c37C6E841CD058");
    expect(NETWORKS["arc-mainnet"].brand.domain).toBe("arcbounty.app");
  });
});

describe("ArcBountyAgent constructor - network wiring", () => {
  beforeEach(() => {
    // Isolate from whatever the host shell has configured.
    vi.stubEnv("BOUNTY_ADAPTER_ADDRESS", undefined);
    vi.stubEnv("ARC_RPC_URL", undefined);
    vi.stubEnv("ARC_MAINNET_RPC_URL", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to arc-testnet with the canonical adapter", () => {
    const agent = new ArcBountyAgent({ privateKey: DUMMY_KEY });
    expect(agent.network.chainId).toBe(5_042_002);
    expect(clientOf(agent).chain.id).toBe(5_042_002);
    expect((agent as unknown as { bountyAdapter: string }).bountyAdapter).toBe(ARC_TESTNET_ADAPTER);
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

  it("network: 'arc-mainnet' yields a client on chain 5042 with the mainnet adapter", () => {
    const agent = new ArcBountyAgent({ privateKey: DUMMY_KEY, network: "arc-mainnet" });
    expect(agent.network.chainId).toBe(5_042);
    expect(agent.network.testnet).toBe(false);
    expect(clientOf(agent).chain.id).toBe(5_042);
    expect(clientOf(agent).transport.url).toBe("https://rpc.blockdaemon.mainnet.arc.io");
    expect((agent as unknown as { bountyAdapter: string }).bountyAdapter).toBe(ARC_MAINNET_ADAPTER);
  });

  it("mainnet rpcUrl override changes the transport, NOT the chain id (0.4.x bug)", () => {
    const agent = new ArcBountyAgent({
      privateKey: DUMMY_KEY,
      network: "arc-mainnet",
      rpcUrl: "http://localhost:9999",
    });
    expect(clientOf(agent).chain.id).toBe(5_042);
    expect(clientOf(agent).transport.url).toBe("http://localhost:9999");
  });

  it("mainnet ignores a testnet BOUNTY_ADAPTER_ADDRESS and ARC_RPC_URL left in the env", () => {
    vi.stubEnv("BOUNTY_ADAPTER_ADDRESS", ARC_TESTNET_ADAPTER);
    vi.stubEnv("ARC_RPC_URL", "https://rpc.testnet.arc.network");
    const agent = new ArcBountyAgent({ privateKey: DUMMY_KEY, network: "arc-mainnet" });
    expect((agent as unknown as { bountyAdapter: string }).bountyAdapter).toBe(ARC_MAINNET_ADAPTER);
    expect(clientOf(agent).transport.url).toBe("https://rpc.blockdaemon.mainnet.arc.io");
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
