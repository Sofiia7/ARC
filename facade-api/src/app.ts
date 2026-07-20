import express, { type NextFunction, type Request, type Response } from "express";
import { loadConfig, PRICES, VERSION, ARC_TESTNET_CAIP2, type FacadeConfig } from "./config.js";
import { BountyReader } from "./bounties.js";
import { createPaymentGate } from "./payments.js";
import { buildOpenApi } from "./openapi.js";
import { serializeBounty, serializeSubmissions } from "./serialize.js";
import { prepareBountySchema, validatePrepare, buildPrepareResponse } from "./prepare.js";

/**
 * The Express app, separated from the listener so the same code runs as a
 * plain Node server (src/index.ts, Docker) and as a Vercel function
 * (api/index.ts exports this app as the handler).
 */
export function buildApp(config: FacadeConfig = loadConfig()) {
  const reader = new BountyReader(config);
  const gate = createPaymentGate(config);

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  // Request id → payment tx correlation lands in logs for grant reporting; the
  // id is cheap and monotonic per process, no dependency needed.
  let requestSeq = 0;
  app.use((req, res, next) => {
    const id = `${Date.now().toString(36)}-${(++requestSeq).toString(36)}`;
    res.setHeader("X-Request-Id", id);
    res.on("finish", () => {
      console.log(`[facade] ${id} ${req.method} ${req.path} → ${res.statusCode}`);
    });
    next();
  });

  function markStale(res: Response, stale: boolean): void {
    res.setHeader("X-Cache", stale ? "stale" : "live");
  }

  function isRpcFailure(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /RPC|rate|limit|429|timeout|fetch failed/i.test(msg);
  }

  // ─── Free discovery endpoints ──────────────────────────────────────────────

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      version: VERSION,
      paymentMode: gate.mode,
      networks: [{ chain: "arc-testnet", caip2: ARC_TESTNET_CAIP2, adapter: config.bountyAdapterAddress }],
      prices: PRICES,
    });
  });

  app.get("/openapi.json", (req, res) => {
    const baseUrl = `${req.protocol}://${req.get("host") ?? "localhost"}`;
    res.json(buildOpenApi(baseUrl));
  });

  app.get("/.well-known/x402.json", (req, res) => {
    const baseUrl = `${req.protocol}://${req.get("host") ?? "localhost"}`;
    res.json({
      x402Version: 2,
      service: "ArcBounty Facade API",
      description: "On-chain bounty discovery + tx preparation for agents. USDC micro-priced via x402.",
      openapi: `${baseUrl}/openapi.json`,
      network: ARC_TESTNET_CAIP2,
      endpoints: [
        { method: "GET", path: "/v1/bounties", price: PRICES.listBounties },
        { method: "GET", path: "/v1/bounties/{id}", price: PRICES.getBounty },
        { method: "GET", path: "/v1/bounties/{id}/submissions", price: PRICES.getSubmissions },
        { method: "POST", path: "/v1/bounties/prepare", price: PRICES.prepareBounty },
      ],
    });
  });

  app.get("/llms.txt", (_req, res) => {
    res.type("text/plain").send(
      [
        "# ArcBounty Facade API",
        "",
        "Paid (x402 v2, USDC) REST facade over ArcBounty — the on-chain bounty marketplace on Arc Testnet.",
        "Humans and AI agents compete for the same USDC bounties under one escrow contract.",
        "",
        "Free: GET /health, GET /openapi.json, GET /.well-known/x402.json",
        `Paid: GET /v1/bounties (${PRICES.listBounties}), GET /v1/bounties/{id} (${PRICES.getBounty}), ` +
          `GET /v1/bounties/{id}/submissions (${PRICES.getSubmissions}), POST /v1/bounties/prepare (${PRICES.prepareBounty})`,
        "",
        "Unpaid requests to paid routes return HTTP 402 with x402 v2 payment instructions",
        "(base64 PAYMENT-REQUIRED header). Pay with any x402 client, e.g.: circle services pay <url>",
        "",
        "The facade is non-custodial and never relays. POST /v1/bounties/prepare returns unsigned",
        "transactions you sign with your own wallet. Escrow/disputes live in the BountyAdapter contract.",
        "App: https://arcbounty.app · Code: https://github.com/Sofiia7/ARC",
      ].join("\n"),
    );
  });

  // ─── Paid endpoints ────────────────────────────────────────────────────────

  app.get("/v1/bounties", gate.paid(PRICES.listBounties), async (req, res, next) => {
    try {
      const q = req.query;
      if (q["status"] !== undefined && q["status"] !== "open") {
        return res.status(400).json({ error: "v1 supports status=open only (the contract indexes open bounties)" });
      }
      if (q["chain"] !== undefined && q["chain"] !== "arc-testnet") {
        return res.status(400).json({ error: "v1 supports chain=arc-testnet only" });
      }
      const limit = Math.min(Number(q["limit"] ?? 50) || 50, 100);
      const offset = Math.max(Number(q["offset"] ?? 0) || 0, 0);

      const { value, stale } = await reader.listOpen({
        category: typeof q["category"] === "string" ? q["category"] : undefined,
        agentOnly: q["agentOnly"] === "true" ? true : undefined,
        humanOnly: q["humanOnly"] === "true" ? true : undefined,
        minReward: q["minReward"] !== undefined ? Number(q["minReward"]) : undefined,
        maxReward: q["maxReward"] !== undefined ? Number(q["maxReward"]) : undefined,
        offset,
        limit,
      });

      let bounties = value.map(m => serializeBounty(m));
      if (typeof q["tags"] === "string" && q["tags"].length > 0) {
        const wanted = q["tags"].split(",").map(t => t.trim().toLowerCase()).filter(Boolean);
        bounties = bounties.filter(b => b.tags.some(t => wanted.includes(t.toLowerCase())));
      }

      markStale(res, stale);
      res.json({ chain: "arc-testnet", count: bounties.length, offset, limit, bounties });
    } catch (err) {
      next(err);
    }
  });

  function parseJobId(raw: string): bigint | null {
    try {
      const id = BigInt(raw);
      return id >= 0n ? id : null;
    } catch {
      return null;
    }
  }

  app.get("/v1/bounties/:id", gate.paid(PRICES.getBounty), async (req, res, next) => {
    try {
      const jobId = parseJobId(req.params.id);
      if (jobId === null) return res.status(400).json({ error: "id must be a numeric jobId" });
      const { value, stale } = await reader.get(jobId);
      // The adapter returns a zeroed struct for unknown ids — poster == 0x0 is
      // the reliable "does not exist" signal.
      if (/^0x0{40}$/i.test(value.poster)) return res.status(404).json({ error: `no bounty with jobId ${jobId}` });
      markStale(res, stale);
      res.json(serializeBounty(value));
    } catch (err) {
      next(err);
    }
  });

  app.get("/v1/bounties/:id/submissions", gate.paid(PRICES.getSubmissions), async (req, res, next) => {
    try {
      const jobId = parseJobId(req.params.id);
      if (jobId === null) return res.status(400).json({ error: "id must be a numeric jobId" });
      const { value, stale } = await reader.get(jobId);
      if (/^0x0{40}$/i.test(value.poster)) return res.status(404).json({ error: `no bounty with jobId ${jobId}` });
      markStale(res, stale);
      res.json(serializeSubmissions(value));
    } catch (err) {
      next(err);
    }
  });

  app.post("/v1/bounties/prepare", gate.paid(PRICES.prepareBounty), (req, res) => {
    const parsed = prepareBountySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "validation failed", issues: parsed.error.issues });
    }
    const semanticError = validatePrepare(parsed.data);
    if (semanticError) return res.status(400).json({ error: semanticError });
    res.json(buildPrepareResponse(parsed.data, config));
  });

  // ─── Errors ────────────────────────────────────────────────────────────────

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (isRpcFailure(err)) {
      // Cache had nothing to serve stale — the public Arc RPC is rate-limited;
      // this is expected under burst load, not a bug (see docs/INTEGRATION_NOTES.md).
      return res.status(503).json({ error: "upstream RPC unavailable, retry shortly", retryAfterSec: 15 });
    }
    console.error("[facade] unhandled:", err);
    res.status(500).json({ error: "internal error" });
  });

  return { app, gate, config };
}
