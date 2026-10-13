import type { Config } from "./config.js";
import { VERSION } from "./constants.js";
import { FACILITATOR } from "./config.js";
import { FREE_ENDPOINTS, PAID_ENDPOINTS, UNAVAILABLE_ENDPOINTS, priceLabel, type PaidEndpoint } from "./endpoints.js";
import { formatUsdc } from "./format.js";

const SERVICE = "NadBounty x402 facade";

function network(config: Config): string {
  return `eip155:${config.chainId}`;
}

function networkName(config: Config): string {
  return config.chainId === 143 ? "Monad mainnet" : "Monad testnet";
}

function payment(config: Config) {
  return {
    protocol: "x402",
    x402Version: 2,
    scheme: "exact",
    network: network(config),
    asset: { symbol: "USDC", address: config.usdc, decimals: 6, eip712: { name: "USDC", version: "2" } },
    payTo: config.payTo,
    facilitator: FACILITATOR,
    note: "Unpaid requests to a paid route answer HTTP 402 with the requirements in the PAYMENT-REQUIRED header (base64 JSON). Settlement happens only after a successful response: errors are never charged.",
  };
}

function endpointRecord(config: Config, endpoint: PaidEndpoint) {
  return {
    method: endpoint.method,
    path: endpoint.templatePath,
    url: `${config.publicUrl}${endpoint.templatePath}`,
    price: {
      amount: endpoint.priceAtomic.toString(),
      usdc: formatUsdc(endpoint.priceAtomic),
      label: priceLabel(endpoint.priceAtomic),
    },
    paid: true,
    summary: endpoint.summary,
    description: endpoint.description,
    parameters: endpoint.parameters.map(({ name, in: where, required, description }) => ({
      name,
      in: where,
      required,
      description,
    })),
    returns: endpoint.returns,
    example: `${config.publicUrl}${endpoint.example}`,
  };
}

function unavailable(config: Config) {
  return UNAVAILABLE_ENDPOINTS.map((entry) => ({
    method: entry.method,
    path: entry.path,
    available: entry.available(config),
    reason: entry.available(config) ? undefined : entry.reason,
  }));
}

/** GET /v1 (and /): the endpoint index. */
export function buildIndex(config: Config) {
  return {
    service: SERVICE,
    version: VERSION,
    description: `Pay-per-read access to NadBounty V4.8 on ${networkName(config)}: block-pinned snapshots that replace several RPC reads, paid per request in USDC over x402.`,
    network: { name: networkName(config), caip2: network(config), chainId: config.chainId },
    baseUrl: config.publicUrl,
    adapter: config.adapter,
    payment: payment(config),
    endpoints: PAID_ENDPOINTS.map((endpoint) => endpointRecord(config, endpoint)),
    free: FREE_ENDPOINTS.map((entry) => ({ ...entry, url: `${config.publicUrl}${entry.path}` })),
    notAvailable: unavailable(config),
    docs: {
      openapi: `${config.publicUrl}/openapi.json`,
      x402: `${config.publicUrl}/.well-known/x402.json`,
      llms: `${config.publicUrl}/llms.txt`,
    },
    limits: { requestsPerMinutePerClient: config.rateLimitPerMinute },
    code: "https://github.com/Sofiia7/ARC/tree/main/nad-facade",
  };
}

const errorBody = {
  type: "object",
  properties: { error: { type: "string" } },
  required: ["error"],
} as const;

const snapshotProperties = {
  chainId: { type: "integer" },
  adapter: { type: "string" },
  contractVersion: { type: "string", enum: ["4.8"] },
  sourceBlock: { type: "string", description: "Block number every value in the response was read at." },
  sourceBlockHash: { type: "string" },
} as const;

const amount = {
  type: "object",
  properties: { atomic: { type: "string" }, usdc: { type: "string" } },
  required: ["atomic", "usdc"],
} as const;

const totals = {
  paidJobs: { type: "string" },
  scoreSum: { type: "string" },
  averageScore: {
    type: ["string", "null"],
    description: "scoreSum / paidJobs to two decimals; null without paid jobs.",
  },
} as const;

const gate = {
  type: "object",
  properties: { minJobs: { type: "integer" }, minAvgScore: { type: "integer" }, passes: { type: "boolean" } },
} as const;

const responseSchemas: Record<PaidEndpoint["id"], Record<string, unknown>> = {
  bounty: {
    type: "object",
    properties: {
      ...snapshotProperties,
      meta: { type: "object", description: "The BountyMeta struct as returned by getBountyMeta (amounts as strings)." },
      entries: {
        type: "array",
        description:
          "Contest entries (agentId, entrant, resultHash ciphertext CID, awarded); empty for plain bounties.",
      },
    },
  },
  reputation: {
    type: "object",
    properties: {
      ...snapshotProperties,
      agentId: { type: "string" },
      identityOwner: { type: "string" },
      workingWallet: { type: ["string", "null"] },
      local: { type: "object", properties: totals },
      mirror: {
        type: "object",
        properties: {
          address: { type: "string" },
          records: {
            type: "array",
            items: {
              type: "object",
              properties: {
                sourceChain: { type: "integer", enum: [8453, 5042] },
                chain: { type: "string", enum: ["base", "arc"] },
                ...totals,
                sourceBlock: { type: "string" },
                updatedAt: { type: "string" },
              },
            },
          },
        },
      },
      combined: { type: "object", properties: totals },
      gates: { type: "object", properties: { proven: gate, top: gate } },
    },
  },
  workers: {
    type: "object",
    properties: {
      ...snapshotProperties,
      gate: {
        type: "object",
        properties: { minJobs: { type: "integer" }, minAvgScore: { type: "integer" }, rule: { type: "string" } },
      },
      count: { type: "integer" },
      workers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["agent", "human"] },
            agentId: { type: "string" },
            wallet: { type: "string" },
            identityOwner: { type: "string" },
            workingWallet: { type: ["string", "null"] },
            ...totals,
            tiers: { type: "object", properties: { proven: { type: "boolean" }, top: { type: "boolean" } } },
          },
        },
      },
      scope: { type: "object", description: "How the candidate set was built and what it leaves out." },
    },
  },
  contest: {
    type: "object",
    properties: {
      ...snapshotProperties,
      jobId: { type: "string" },
      state: {
        type: "string",
        enum: [
          "open",
          "closed_no_entries",
          "in_review",
          "review_expired",
          "rejection_challenge_window",
          "rejection_unchallenged",
          "in_dispute",
          "settled",
          "refunded",
        ],
      },
      reward: amount,
      entries: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer" },
            agentId: { type: "string" },
            entrant: { type: "string" },
            ciphertextCid: { type: "string" },
            awarded: { type: "boolean" },
            score: {
              type: "null",
              description: "Per-entry scores are only in ContestAwarded events and are not served.",
            },
            identityOwner: { type: ["string", "null"] },
            payout: {
              type: ["object", "null"],
              properties: { recipient: { type: ["string", "null"] }, parked: { type: "boolean" }, net: amount },
            },
          },
        },
      },
      settlement: { type: ["object", "null"] },
    },
  },
};

const errorResponses = (endpoint: PaidEndpoint) => {
  const out: Record<string, unknown> = {
    "400": {
      description: "Invalid parameter. No payment is requested.",
      content: { "application/json": { schema: errorBody } },
    },
    "402": {
      description: `Payment required (x402 v2, exact, ${priceLabel(endpoint.priceAtomic)} USDC). Requirements are in the base64 PAYMENT-REQUIRED header.`,
    },
    "429": {
      description: "Rate limit exceeded; see Retry-After.",
      content: { "application/json": { schema: errorBody } },
    },
    "503": {
      description: "Upstream chain or facilitator unavailable; see Retry-After. Never charged.",
      content: { "application/json": { schema: errorBody } },
    },
  };
  if (endpoint.id !== "workers")
    out["404"] = {
      description:
        endpoint.id === "contest"
          ? "Unknown job, or the job is not a contest. Never charged."
          : "Unknown job or identity. Never charged.",
      content: { "application/json": { schema: errorBody } },
    };
  return out;
};

/** GET /openapi.json: OpenAPI 3.1 with x402 price information on every paid operation. */
export function buildOpenApi(config: Config) {
  const free = (summary: string, contentType = "application/json") => ({
    get: {
      summary,
      responses: {
        "200": {
          description: "OK",
          content: {
            [contentType]: { schema: contentType === "application/json" ? { type: "object" } : { type: "string" } },
          },
        },
      },
    },
  });
  const paths: Record<string, unknown> = {
    "/health": free("Liveness and configuration summary (free)"),
    "/v1": free("Endpoint index with prices (free)"),
    "/openapi.json": free("This document (free)"),
    "/.well-known/x402.json": free("x402 discovery manifest (free)"),
    "/llms.txt": free("Plain-text description for agents (free)", "text/plain"),
  };
  for (const endpoint of PAID_ENDPOINTS) {
    paths[endpoint.templatePath] = {
      get: {
        operationId: `get_${endpoint.id}`,
        summary: endpoint.summary,
        description: endpoint.description,
        "x-x402-price": priceLabel(endpoint.priceAtomic),
        "x-payment-info": {
          price: { mode: "fixed", currency: "USD", amount: formatUsdc(endpoint.priceAtomic) },
          protocols: [{ x402: {} }],
        },
        parameters: endpoint.parameters.map(({ name, in: where, required, description, schema }) => ({
          name,
          in: where,
          required,
          description,
          schema,
        })),
        responses: {
          "200": {
            description: `Block-pinned snapshot: ${endpoint.returns}`,
            content: { "application/json": { schema: responseSchemas[endpoint.id] } },
          },
          ...errorResponses(endpoint),
        },
      },
    };
  }
  for (const entry of UNAVAILABLE_ENDPOINTS) {
    if (entry.available(config)) {
      paths[entry.path] = free("Finalized Base and Arc reputation source evidence for the mirror (free)");
    }
  }
  return {
    openapi: "3.1.0",
    info: {
      title: SERVICE,
      version: VERSION,
      description:
        `Pay-per-read, block-pinned snapshots of NadBounty V4.8 on ${networkName(config)}, paid in USDC through x402 v2 (exact scheme, Monad Foundation facilitator). ` +
        "Read-only: the service holds no key and never sends a transaction. Errors and unsupported requests are never charged.",
    },
    servers: [{ url: config.publicUrl }],
    paths,
    "x-x402": payment(config),
    "x-not-available": unavailable(config).filter((entry) => !entry.available),
  };
}

/** GET /.well-known/x402.json: the same shape as the Arc facade manifest, plus asset and payee. */
export function buildX402Manifest(config: Config) {
  return {
    x402Version: 2,
    service: SERVICE,
    description: `Pay-per-read NadBounty V4.8 snapshots on ${networkName(config)}. USDC micro-priced via x402.`,
    openapi: `${config.publicUrl}/openapi.json`,
    network: network(config),
    asset: config.usdc,
    payTo: config.payTo,
    facilitator: FACILITATOR,
    endpoints: PAID_ENDPOINTS.map((endpoint) => ({
      method: endpoint.method,
      path: endpoint.templatePath,
      price: priceLabel(endpoint.priceAtomic),
      amount: endpoint.priceAtomic.toString(),
    })),
    notAvailable: unavailable(config).filter((entry) => !entry.available),
  };
}

/** GET /llms.txt */
export function buildLlmsTxt(config: Config): string {
  const lines = [
    `# ${SERVICE}`,
    "",
    `Paid (x402 v2, USDC) REST reads over NadBounty V4.8, the on-chain bounty board on ${networkName(config)}.`,
    "Every paid answer is read at one block and names it (sourceBlock, sourceBlockHash). Read-only: no key, no transactions.",
    "",
    `Base URL: ${config.publicUrl}`,
    `Network: ${network(config)}, asset USDC ${config.usdc}, pay to ${config.payTo}`,
    "",
    "Free: GET /health, GET /v1, GET /openapi.json, GET /.well-known/x402.json, GET /llms.txt",
    "Paid:",
    ...PAID_ENDPOINTS.map(
      (endpoint) =>
        `- GET ${endpoint.templatePath} (${priceLabel(endpoint.priceAtomic)} USDC): ${endpoint.summary}. Example: ${config.publicUrl}${endpoint.example}`,
    ),
    ...UNAVAILABLE_ENDPOINTS.filter((entry) => !entry.available(config)).map(
      (entry) => `Not available: GET ${entry.path} - ${entry.reason}`,
    ),
    "",
    "Unpaid requests to a paid route return HTTP 402 with the requirements in the base64 PAYMENT-REQUIRED header.",
    "Pay with any x402 client (scheme exact, network " +
      network(config) +
      ") and repeat the request with the PAYMENT-SIGNATURE header.",
    "Malformed or unknown IDs, rate limits and upstream errors are answered with 4xx/5xx and are never charged.",
    `Limit: ${config.rateLimitPerMinute} requests per minute per client; 429 carries Retry-After.`,
    "",
    `Docs: ${config.publicUrl}/openapi.json  Code: https://github.com/Sofiia7/ARC/tree/main/nad-facade`,
  ];
  return lines.join("\n") + "\n";
}
