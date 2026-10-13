import { LIMITS, PRICE_ATOMIC, TIERS } from "./constants.js";
import { formatUsdc } from "./format.js";
import { VERIFIED_BOUNDS, VERIFIED_DEFAULTS } from "./validate.js";
import type { Config } from "./config.js";

export type Parameter = {
  name: string;
  in: "path" | "query";
  required: boolean;
  description: string;
  schema: Record<string, unknown>;
};

export type PaidEndpoint = {
  id: "bounty" | "reputation" | "workers" | "contest";
  method: "GET";
  /** Express route. */
  expressPath: string;
  /** OpenAPI path template. */
  templatePath: string;
  /** x402 route key ([param] segments match exactly one path segment). */
  x402Pattern: string;
  priceAtomic: bigint;
  summary: string;
  description: string;
  /** Example request path (mainnet data). */
  example: string;
  parameters: Parameter[];
  /** Short description of the 200 body for llms.txt and OpenAPI. */
  returns: string;
};

const jobId: Parameter = {
  name: "jobId",
  in: "path",
  required: true,
  description: "Job ID of a bounty on this adapter (positive integer, at most 30 digits).",
  schema: { type: "string", pattern: "^[1-9][0-9]{0,29}$" },
};

/** Every paid route. Prices, x402 route keys, OpenAPI, /v1 and llms.txt are all generated from this table. */
export const PAID_ENDPOINTS: readonly PaidEndpoint[] = [
  {
    id: "bounty",
    method: "GET",
    expressPath: "/v1/bounties/:jobId",
    templatePath: "/v1/bounties/{jobId}",
    x402Pattern: "GET /v1/bounties/[jobId]",
    priceAtomic: PRICE_ATOMIC.bounty,
    summary: "Block-pinned NadBounty V4.8 bounty and encrypted entry references",
    description:
      "The full on-chain bounty record and, for contests, the entries (ciphertext CIDs only), read at one block. Never decrypted content.",
    example: "/v1/bounties/2",
    parameters: [jobId],
    returns: "meta (BountyMeta), entries, sourceBlock, sourceBlockHash",
  },
  {
    id: "reputation",
    method: "GET",
    expressPath: "/v1/reputation/:agentId",
    templatePath: "/v1/reputation/{agentId}",
    x402Pattern: "GET /v1/reputation/[agentId]",
    priceAtomic: PRICE_ATOMIC.reputation,
    summary: "Cross-chain reputation of an ERC-8004 identity in one call",
    description:
      "Current identity owner and working wallet, the adapter local reputation, the ReputationMirror record for Base and for Arc " +
      "(each with its sourceBlock), the combined paid jobs, score sum and weighted average, and the Proven " +
      `(${TIERS.proven.minJobs} jobs, ${TIERS.proven.minAvgScore} average) and Top (${TIERS.top.minJobs} jobs, ${TIERS.top.minAvgScore} average) ` +
      "gate flags, computed with the adapter integer rule. One call replaces five reads across three contracts.",
    example: "/v1/reputation/10388",
    parameters: [
      {
        name: "agentId",
        in: "path",
        required: true,
        description: "ERC-8004 agent ID (positive integer, at most 30 digits).",
        schema: { type: "string", pattern: "^[1-9][0-9]{0,29}$" },
      },
    ],
    returns: "identityOwner, workingWallet, local, mirror.records[base, arc], combined, gates.proven, gates.top",
  },
  {
    id: "workers",
    method: "GET",
    expressPath: "/v1/workers/verified",
    templatePath: "/v1/workers/verified",
    x402Pattern: "GET /v1/workers/verified",
    priceAtomic: PRICE_ATOMIC.workers,
    summary: "Identities on this adapter that currently pass a reputation gate",
    description:
      "Workers (agents and humans) who took a bounty or entered a contest on this adapter and currently pass the given gate, " +
      `sorted by average score. Candidates come from the first ${LIMITS.workerScanJobs} jobs (no event-log scan); the scope field states the limits.`,
    example: `/v1/workers/verified?minJobs=${VERIFIED_DEFAULTS.minJobs}&minAvgScore=${VERIFIED_DEFAULTS.minAvgScore}`,
    parameters: [
      {
        name: "minJobs",
        in: "query",
        required: false,
        description: `Minimum scored paid jobs (integer ${VERIFIED_BOUNDS.minJobs.min}-${VERIFIED_BOUNDS.minJobs.max}, default ${VERIFIED_DEFAULTS.minJobs}).`,
        schema: {
          type: "integer",
          minimum: VERIFIED_BOUNDS.minJobs.min,
          maximum: VERIFIED_BOUNDS.minJobs.max,
          default: VERIFIED_DEFAULTS.minJobs,
        },
      },
      {
        name: "minAvgScore",
        in: "query",
        required: false,
        description: `Minimum weighted average score, compared as scoreSum >= minAvgScore * paidJobs (integer ${VERIFIED_BOUNDS.minAvgScore.min}-${VERIFIED_BOUNDS.minAvgScore.max}, default ${VERIFIED_DEFAULTS.minAvgScore}).`,
        schema: {
          type: "integer",
          minimum: VERIFIED_BOUNDS.minAvgScore.min,
          maximum: VERIFIED_BOUNDS.minAvgScore.max,
          default: VERIFIED_DEFAULTS.minAvgScore,
        },
      },
    ],
    returns: "workers[] (kind, agentId or wallet, identityOwner, totals, tiers), count, gate, scope",
  },
  {
    id: "contest",
    method: "GET",
    expressPath: "/v1/contests/:jobId/result",
    templatePath: "/v1/contests/{jobId}/result",
    x402Pattern: "GET /v1/contests/[jobId]/result",
    priceAtomic: PRICE_ATOMIC.contest,
    summary: "Contest state, entries, winners and net payouts",
    description:
      "For a contest job: state (open, in_review, settled, ...), every entry with agentId, entrant, awarded flag and ciphertext CID, " +
      "and for each winner the payout recipient (the identity owner, never the working wallet) and the net amount after the 1% fee, " +
      "computed as the contract does. Never decrypted content.",
    example: "/v1/contests/2/result",
    parameters: [{ ...jobId, description: "Job ID of a contest bounty." }],
    returns: "state, timeline, entries[] (awarded, ciphertextCid, payout), settlement",
  },
];

/** Routes that exist but are not served on every network. Listed in discovery instead of failing confusingly. */
export const UNAVAILABLE_ENDPOINTS = [
  {
    method: "GET",
    path: "/v1/reputation-sources",
    available: (config: Config) => config.chainId === 10143,
    reason: "Disabled on Monad mainnet: it serves finalized Base and Arc source evidence for the testnet mirror only.",
  },
] as const;

export const FREE_ENDPOINTS = [
  { method: "GET", path: "/health", description: "Liveness and configuration summary." },
  { method: "GET", path: "/v1", description: "Endpoint index with prices." },
  { method: "GET", path: "/openapi.json", description: "OpenAPI 3.1 description with x402 payment information." },
  { method: "GET", path: "/.well-known/x402.json", description: "x402 discovery manifest." },
  { method: "GET", path: "/llms.txt", description: "Plain-text description for agents." },
] as const;

/** "$0.001" style label. */
export function priceLabel(atomic: bigint): string {
  return `$${formatUsdc(atomic)}`;
}

/** Route table for @x402/express: one exact-scheme USDC option per endpoint, paid to the treasury. */
export function x402Routes(config: Config) {
  const network = `eip155:${config.chainId}` as const;
  // Both Monad USDC deployments are EIP-3009 tokens with EIP-712 domain name "USDC", version "2" (verified on chain);
  // state it explicitly instead of relying on a default asset table.
  const asset = { asset: config.usdc, extra: { name: "USDC", version: "2" } };
  return Object.fromEntries(
    PAID_ENDPOINTS.map((endpoint) => [
      endpoint.x402Pattern,
      {
        accepts: {
          scheme: "exact",
          network,
          payTo: config.payTo,
          price: { amount: endpoint.priceAtomic.toString(), ...asset },
          maxTimeoutSeconds: 60,
        },
        description: endpoint.summary,
        mimeType: "application/json",
      },
    ]),
  );
}
