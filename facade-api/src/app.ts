import express, { type NextFunction, type Request, type Response } from "express";
import { loadConfig, PRICES, VERSION, type FacadeConfig } from "./config.js";
import { BountyReader } from "./bounties.js";
import { createPaymentGate } from "./payments.js";
import { buildOpenApi } from "./openapi.js";
import { serializeBounty, serializeSubmissions } from "./serialize.js";
import { prepareBountySchema, validatePrepare, buildPrepareResponse } from "./prepare.js";
import { QuestVerifier, QuestIndeterminate, QUEST_TASKS, isQuestTask } from "./quest.js";

/**
 * The Express app, separated from the listener so the same code runs as a
 * plain Node server (src/index.ts, Docker) and as a Vercel function
 * (api/index.ts exports this app as the handler).
 */
export function buildApp(config: FacadeConfig = loadConfig()) {
  const reader = new BountyReader(config);
  const gate = createPaymentGate(config);
  const quest = new QuestVerifier(reader, config);

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

  // The root had no route at all, which on Vercel surfaced as a 500
  // (FUNCTION_INVOCATION_FAILED) rather than a 404 - the first thing anyone
  // opening the bare hostname saw, human or crawler. It is also the natural
  // place to say what this service is and where the machine-readable
  // descriptions live.
  app.get("/", (req, res) => {
    const baseUrl = `${req.protocol}://${req.get("host") ?? "localhost"}`;
    res.json({
      service: `${config.brandName} Facade API`,
      description:
        `Paid (x402 v2, USDC) REST facade over ${config.brandName}, the on-chain bounty board on ` +
        `${config.networkName}. Humans and AI agents take the same jobs under one escrow contract.`,
      version: VERSION,
      network: { name: config.networkName, caip2: config.caip2, chainId: config.chainId },
      paymentMode: gate.mode,
      discovery: {
        health: `${baseUrl}/health`,
        openapi: `${baseUrl}/openapi.json`,
        x402: `${baseUrl}/.well-known/x402.json`,
        llms: `${baseUrl}/llms.txt`,
      },
      app: `https://${config.brandDomain}`,
      code: "https://github.com/Sofiia7/ARC",
    });
  });

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      version: VERSION,
      paymentMode: gate.mode,
      networks: [{ chain: config.network, caip2: config.caip2, adapter: config.bountyAdapterAddress }],
      prices: PRICES,
    });
  });

  app.get("/openapi.json", (req, res) => {
    const baseUrl = `${req.protocol}://${req.get("host") ?? "localhost"}`;
    res.json(buildOpenApi(baseUrl, config));
  });

  app.get("/.well-known/x402.json", (req, res) => {
    const baseUrl = `${req.protocol}://${req.get("host") ?? "localhost"}`;
    res.json({
      x402Version: 2,
      service: `${config.brandName} Facade API`,
      description: "On-chain bounty discovery + tx preparation for agents. USDC micro-priced via x402.",
      openapi: `${baseUrl}/openapi.json`,
      network: config.caip2,
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
        `# ${config.brandName} Facade API`,
        "",
        `Paid (x402 v2, USDC) REST facade over ${config.brandName} - the on-chain bounty marketplace on ${config.networkName}.`,
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
        `App: https://${config.brandDomain} · Code: https://github.com/Sofiia7/ARC`,
      ].join("\n"),
    );
  });

  // ─── Quest verification (free, for Galxe / Zealy) ──────────────────────────
  //
  // Galxe's REST credential and Zealy's `api` task both work by calling an
  // endpoint the project hosts with a wallet address, which is what makes a
  // quest on Arc possible at all: neither platform lists Arc among the chains
  // it verifies natively, and neither has to.
  //
  // Free on purpose. x402 exists so agents pay for discovery; a quest platform
  // is not an agent, will not pay, and would simply fail the credential.

  // Galxe checks CORS before it will even save a campaign, including a real
  // OPTIONS preflight, and its docs name "test succeeded but the save failed"
  // as the symptom of getting this wrong. The data behind it is public chain
  // state keyed by an address the caller already knows, and no credentials
  // ride along, so a wildcard origin costs nothing.
  const questCors = (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
    res.setHeader("Access-Control-Max-Age", "86400");
    next();
  };

  app.options("/v1/quest/*", questCors, (_req, res) => res.status(204).end());

  async function handleVerify(req: Request, res: Response): Promise<void> {
    if (config.questApiKey) {
      const supplied =
        req.get("X-API-Key") ?? req.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      if (supplied !== config.questApiKey) {
        res.status(401).json({ error: "bad or missing quest API key" });
        return;
      }
    }

    // Galxe sends whichever variable the campaign was configured with, and
    // Zealy's payload shape is set in its task editor rather than published,
    // so every plausible spelling is accepted instead of guessed at.
    const body = (req.body ?? {}) as Record<string, unknown>;
    const raw =
      req.query["address"] ??
      req.query["wallet"] ??
      body["address"] ??
      body["wallet"] ??
      body["accounts"] ??
      (body["user"] as Record<string, unknown> | undefined)?.["wallet"];

    const address = QuestVerifier.parseAddress(Array.isArray(raw) ? raw[0] : raw);
    if (!address) {
      res.status(400).json({
        error: "supply an EVM address as ?address= or {\"address\": \"0x...\"}",
        tasks: QUEST_TASKS,
      });
      return;
    }

    const taskRaw = req.query["task"] ?? body["task"];
    const task = typeof taskRaw === "string" ? taskRaw : undefined;
    if (task !== undefined && !isQuestTask(task)) {
      res.status(400).json({ error: `unknown task "${task}"`, tasks: QUEST_TASKS });
      return;
    }

    try {
      const status = await quest.verify(address);
      // `result` is the single field a platform can read when it has no
      // scripting step of its own; Galxe users point their JS expression at
      // the named task instead and can ignore it.
      res.json(task ? { ...status, task, result: status[task] } : status);
    } catch (err) {
      if (err instanceof QuestIndeterminate) {
        // Never a zero. See QuestIndeterminate for why a false negative is
        // the one answer this endpoint must not give.
        res.status(503).json({ error: err.message, retryAfterSec: 10 });
        return;
      }
      throw err;
    }
  }

  app.get("/v1/quest/verify", questCors, (req, res, next) => {
    handleVerify(req, res).catch(next);
  });
  app.post("/v1/quest/verify", questCors, (req, res, next) => {
    handleVerify(req, res).catch(next);
  });

  /** What a campaign builder needs in front of them while filling the form. */
  app.get("/v1/quest/tasks", questCors, (req, res) => {
    const baseUrl = `${req.protocol}://${req.get("host") ?? "localhost"}`;
    res.json({
      network: config.network,
      brand: config.brandName,
      adapter: config.bountyAdapterAddress,
      endpoint: `${baseUrl}/v1/quest/verify`,
      authRequired: config.questApiKey !== null,
      tasks: QUEST_TASKS.map(name => ({
        name,
        galxeExpression: `function(resp){ return resp.${name} }`,
        example: `${baseUrl}/v1/quest/verify?address=0x0000000000000000000000000000000000000000&task=${name}`,
      })),
    });
  });

  // ─── Paid endpoints ────────────────────────────────────────────────────────

  app.get("/v1/bounties", gate.paid(PRICES.listBounties), async (req, res, next) => {
    try {
      const q = req.query;
      if (q["status"] !== undefined && q["status"] !== "open") {
        return res.status(400).json({ error: "v1 supports status=open only (the contract indexes open bounties)" });
      }
      if (q["chain"] !== undefined && q["chain"] !== config.network) {
        return res.status(400).json({ error: `this facade instance supports chain=${config.network} only` });
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
      res.json({ chain: config.network, count: bounties.length, offset, limit, bounties });
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
      // The adapter returns a zeroed struct for unknown ids - poster == 0x0 is
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
    const semanticError = validatePrepare(parsed.data, config);
    if (semanticError) return res.status(400).json({ error: semanticError });
    res.json(buildPrepareResponse(parsed.data, config));
  });

  // ─── Errors ────────────────────────────────────────────────────────────────

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (isRpcFailure(err)) {
      // Cache had nothing to serve stale - the public Arc RPC is rate-limited;
      // this is expected under burst load, not a bug (see docs/INTEGRATION_NOTES.md).
      return res.status(503).json({ error: "upstream RPC unavailable, retry shortly", retryAfterSec: 15 });
    }
    console.error("[facade] unhandled:", err);
    res.status(500).json({ error: "internal error" });
  });

  return { app, gate, config };
}
