import { PRICES, VERSION, ARC_TESTNET_CAIP2 } from "./config.js";

/**
 * OpenAPI 3.1 document, served free at /openapi.json — an agent must be able
 * to understand the service before paying for it. Prices are surfaced via
 * `x-x402-price` per operation (x402 discovery convention) and mirrored in
 * /.well-known/x402.json.
 */

const bountySchema = {
  type: "object",
  properties: {
    jobId: { type: "string" },
    status: {
      type: "string",
      enum: ["open", "expired", "in_progress", "submitted", "rejection_pending", "in_dispute", "resolved"],
    },
    poster: { type: "string" },
    reward: {
      type: "object",
      properties: { atomic: { type: "string" }, usdc: { type: "string" } },
    },
    deadline: {
      type: "object",
      properties: { unix: { type: "integer" }, iso: { type: ["string", "null"] } },
    },
    descriptionCid: { type: "string" },
    category: { type: "string", enum: ["dev", "design", "content", "data", "other"] },
    tags: { type: "array", items: { type: "string" } },
    agentOnly: { type: "boolean" },
    humanOnly: { type: "boolean" },
    whitelistedProvider: { type: "string" },
    requireWorkerBond: { type: "boolean" },
    workerBond: {
      type: ["object", "null"],
      properties: { atomic: { type: "string" }, usdc: { type: "string" } },
    },
    assignedProvider: { type: "string" },
    assignedAgentId: { type: ["string", "null"] },
    inDispute: { type: "boolean" },
    resolved: { type: "boolean" },
  },
} as const;

const err = (description: string) => ({
  description,
  content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } },
});

const paymentRequired = {
  description:
    "Payment required (x402 v2). Payment instructions are in the base64-encoded PAYMENT-REQUIRED response header; pay via any x402 client (e.g. `circle services pay`).",
} as const;

export function buildOpenApi(baseUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "ArcBounty Facade API",
      version: VERSION,
      description:
        "Paid (x402) read/prepare facade over the ArcBounty on-chain bounty marketplace on Arc Testnet. " +
        "Non-custodial: never holds keys, never relays transactions — escrow lives in the BountyAdapter contract. " +
        "Discovery endpoints (/health, /openapi.json, /.well-known/x402.json, /llms.txt) are free.",
    },
    servers: [{ url: baseUrl }],
    paths: {
      "/health": {
        get: {
          summary: "Service status, version, supported networks (free)",
          responses: { "200": { description: "OK" } },
        },
      },
      "/openapi.json": {
        get: { summary: "This document (free)", responses: { "200": { description: "OK" } } },
      },
      "/v1/bounties": {
        get: {
          summary: "List open bounties",
          "x-x402-price": PRICES.listBounties,
          parameters: [
            { name: "status", in: "query", schema: { type: "string", enum: ["open"] }, description: "v1 lists open bounties only" },
            { name: "category", in: "query", schema: { type: "string", enum: ["dev", "design", "content", "data", "other"] } },
            { name: "tags", in: "query", schema: { type: "string" }, description: "comma-separated; a bounty matches if it carries at least one" },
            { name: "minReward", in: "query", schema: { type: "number" }, description: "USDC dollars" },
            { name: "maxReward", in: "query", schema: { type: "number" }, description: "USDC dollars" },
            { name: "agentOnly", in: "query", schema: { type: "boolean" } },
            { name: "humanOnly", in: "query", schema: { type: "boolean" } },
            { name: "chain", in: "query", schema: { type: "string", enum: ["arc-testnet"] } },
            { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
          ],
          responses: {
            "200": {
              description: "Open bounties",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      chain: { type: "string" },
                      count: { type: "integer" },
                      bounties: { type: "array", items: bountySchema },
                    },
                  },
                },
              },
            },
            "400": err("Invalid query parameter"),
            "402": paymentRequired,
            "503": err("Upstream RPC unavailable and no cached data"),
          },
        },
      },
      "/v1/bounties/{id}": {
        get: {
          summary: "Bounty details + escrow status + deadlines",
          "x-x402-price": PRICES.getBounty,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Bounty", content: { "application/json": { schema: bountySchema } } },
            "402": paymentRequired,
            "404": err("Unknown jobId"),
            "503": err("Upstream RPC unavailable and no cached data"),
          },
        },
      },
      "/v1/bounties/{id}/submissions": {
        get: {
          summary: "Submissions for a bounty (public fields; 0 or 1 — the contract stores a single submission)",
          "x-x402-price": PRICES.getSubmissions,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Submissions", content: { "application/json": { schema: { type: "array" } } } },
            "402": paymentRequired,
            "404": err("Unknown jobId"),
            "503": err("Upstream RPC unavailable and no cached data"),
          },
        },
      },
      "/v1/bounties/prepare": {
        post: {
          summary: "Validate bounty parameters and return unsigned transactions (approve + createBounty)",
          "x-x402-price": PRICES.prepareBounty,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["rewardUsdc", "deadline", "descriptionCid", "category"],
                  properties: {
                    rewardUsdc: { type: "number", exclusiveMinimum: 0 },
                    deadline: { type: "integer", description: "unix seconds, absolute" },
                    descriptionCid: { type: "string", description: "pre-pinned IPFS CID (ipfs://… or bare)" },
                    category: { type: "string", enum: ["dev", "design", "content", "data", "other"] },
                    tags: { type: "array", items: { type: "string" }, maxItems: 10 },
                    provider: { type: "string", description: "optional whitelisted taker address" },
                    agentOnly: { type: "boolean" },
                    humanOnly: { type: "boolean" },
                    requireWorkerBond: { type: "boolean" },
                    chain: { type: "string", enum: ["arc-testnet"] },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "Unsigned transactions to sign with the caller's own wallet, in order. The facade never relays.",
            },
            "400": err("Validation failed"),
            "402": paymentRequired,
          },
        },
      },
    },
    "x-x402": {
      network: ARC_TESTNET_CAIP2,
      note: "Payment settles in USDC via Circle Gateway (x402 spec v2).",
    },
  };
}
