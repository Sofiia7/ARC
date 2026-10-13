/** Service version. Keep in step with package.json (a unit test enforces it). */
export const VERSION = "0.2.0";

/** Canonical public URL of the hosted mainnet instance. */
export const MAINNET_PUBLIC_URL = "https://nadbounty-facade.vercel.app";

/** Multicall3 is deployed at the canonical address on Monad mainnet and testnet. */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

/** USDC has 6 decimals on Monad. */
export const USDC_DECIMALS = 6;

/** Prices in atomic USDC (6 decimals). One table so routes, discovery and docs cannot disagree. */
export const PRICE_ATOMIC = {
  bounty: 1000n, // 0.001 USDC
  reputation: 1000n, // 0.001 USDC
  workers: 5000n, // 0.005 USDC
  contest: 1000n, // 0.001 USDC
} as const;

/** Reputation tiers, identical to the website (NadBounty gate presets) and to _checkGate's inputs. */
export const TIERS = {
  proven: { minJobs: 3, minAvgScore: 80 },
  top: { minJobs: 10, minAvgScore: 90 },
} as const;

/** Hard limits that bound the RPC work behind one paid request. */
export const LIMITS = {
  /** Only the first N jobs of the adapter (allJobIds order) are scanned for /v1/workers/verified. */
  workerScanJobs: 300,
  /** Upper bound on identities examined after the job scan. */
  workerScanIdentities: 400,
  /** Calls per Multicall3 eth_call. */
  multicallChunk: 80,
  /** Concurrent multicall chunks. */
  multicallConcurrency: 3,
  /** Concurrent heavy computations per instance. */
  heavyConcurrency: 2,
  /** Deadline for the work done after a payment is verified (the payment is cancelled when it is exceeded). */
  handlerDeadlineMs: 25_000,
} as const;

/** Cache lifetimes (milliseconds). */
export const TTL = {
  pinnedBlock: 5_000,
  maxJobId: 15_000,
  /** A brand-new bounty may postdate the cached maximum; one bounded refresh is allowed this often. */
  maxJobIdRecheck: 2_000,
  knownJob: 10 * 60_000,
  missingJob: 5_000,
  missingAgent: 15_000,
  workerScan: 15_000,
  supportedKinds: 10 * 60_000,
  supportedMaxStale: 60 * 60_000,
} as const;

/** Network timeouts (milliseconds). */
export const TIMEOUT = {
  supportedKinds: 8_000,
  /** A second supported-kinds lookup starts if the first has not answered by then. */
  supportedHedge: 2_500,
  facilitatorIo: 20_000,
  rpcStep: 10_000,
} as const;

/** Contract constants mirrored from BountyAdapterV48 (read-only reference). */
export const CONTRACT = {
  bpsDenominator: 10_000n,
  /** REJECTION_CHALLENGE_WINDOW = 48 hours. */
  rejectionChallengeWindowSeconds: 48n * 3600n,
} as const;
