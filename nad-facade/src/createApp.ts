import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import {
  ExpressAdapter,
  paymentMiddlewareFromHTTPServer,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { Address } from "viem";
import { adapterAbi, createViemChain, unwrap, type ChainClient } from "./chain.js";
import { Semaphore, withTimeout, type Clock } from "./cache.js";
import { FACILITATOR, type Config } from "./config.js";
import { LIMITS, PRICE_ATOMIC, TIMEOUT, VERSION } from "./constants.js";
import { buildIndex, buildLlmsTxt, buildOpenApi, buildX402Manifest } from "./discovery.js";
import { PAID_ENDPOINTS, x402Routes, type PaidEndpoint } from "./endpoints.js";
import { sharedFacilitator, type FacilitatorHandle } from "./facilitator.js";
import { formatUsdc } from "./format.js";
import { canonicalPath, fail, genericMiddlewareErrors, getOnly, guarded, logAndFail, respond } from "./http.js";
import { rateLimit, TokenBucketLimiter } from "./rateLimit.js";
import { ChainReader } from "./reader.js";
import { reputationSources } from "./reputationSources.js";
import { parseId, parseVerifiedQuery } from "./validate.js";

/** Collaborators that tests replace; production uses the defaults. */
export type Deps = {
  chain?: ChainClient;
  facilitator?: FacilitatorHandle;
  limiter?: TokenBucketLimiter;
  now?: Clock;
  /** Replaces the x402 route table (tests use this to prove an uncovered route is refused). */
  routes?: ReturnType<typeof x402Routes>;
};

const DOC_CACHE = "public, max-age=300, s-maxage=300";

/**
 * Builds the Express app without any network I/O: chain checks and the facilitator's supported kinds are resolved
 * lazily (and cached) on the first request that needs them, so a cold start can never hang.
 */
export function createApp(config: Config, deps: Deps = {}) {
  const network = `eip155:${config.chainId}` as const;
  const chain = deps.chain ?? createViemChain(config.rpc);
  const reader = new ChainReader(chain, config, deps.now);
  const facilitator = deps.facilitator ?? sharedFacilitator(FACILITATOR, network);
  const limiter =
    deps.limiter ??
    new TokenBucketLimiter({
      capacity: config.rateLimitPerMinute,
      refillPerSecond: config.rateLimitPerMinute / 60,
      now: deps.now,
    });
  const heavy = new Semaphore(LIMITS.heavyConcurrency);

  // The RPC must be the configured chain and the adapter must pay out the configured USDC. Success is remembered.
  let chainVerified: Promise<void> | undefined;
  const verifyChain = () => {
    chainVerified ??= (async () => {
      if ((await chain.getChainId()) !== config.chainId) throw new Error("RPC chain mismatch");
      const [usdc] = await chain.call([{ address: config.adapter, abi: adapterAbi, functionName: "usdc" }]);
      if (unwrap<Address>(usdc, "usdc").toLowerCase() !== config.usdc.toLowerCase())
        throw new Error("Adapter USDC mismatch");
    })().catch((error) => {
      chainVerified = undefined;
      throw error;
    });
    return chainVerified;
  };
  const ready = () =>
    Promise.all([withTimeout(verifyChain(), TIMEOUT.rpcStep), facilitator.ensureSupported()]).then(() => undefined);

  const app = express();
  app.disable("x-powered-by");
  // Behind Vercel the first X-Forwarded-For hop is the client and X-Forwarded-Proto is https; the payment layer builds
  // the resource URL it advertises from req.protocol.
  app.set("trust proxy", true);
  app.set("query parser", "simple");
  app.set("json replacer", (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
  app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    next();
  });
  app.use(canonicalPath);

  const prices = Object.fromEntries(PAID_ENDPOINTS.map((endpoint) => [endpoint.id, formatUsdc(endpoint.priceAtomic)]));
  app.get("/health", (_req, res) =>
    res.json({
      ok: true,
      version: VERSION,
      chainId: config.chainId,
      adapter: config.adapter,
      contractVersion: "4.8",
      payment: "x402-v2-exact",
      priceUSDC: formatUsdc(PRICE_ATOMIC.bounty),
      prices,
    }),
  );

  app.use(rateLimit(limiter));

  // ---- Free discovery (static documents, computed once) ----
  const index = buildIndex(config);
  const openapi = buildOpenApi(config);
  const manifest = buildX402Manifest(config);
  const llms = buildLlmsTxt(config);
  const doc =
    (body: unknown): RequestHandler =>
    (_req, res) => {
      res.set("Cache-Control", DOC_CACHE);
      res.json(body);
    };
  app.get(["/", "/v1"], doc(index));
  app.get("/openapi.json", doc(openapi));
  app.get("/.well-known/x402.json", doc(manifest));
  app.get("/llms.txt", (_req, res) => {
    res.set("Cache-Control", DOC_CACHE);
    res.type("text/plain").send(llms);
  });

  app.get("/v1/reputation-sources", async (_req, res) => {
    if (config.chainId !== 10143) {
      fail(res, 501, "Not available on this network");
      return;
    }
    try {
      res.json(await reputationSources());
    } catch (error) {
      logAndFail(res, "reputation sources", error, 503, "Finalized reputation source evidence unavailable", 30);
    }
  });

  // ---- Paid routes ----
  // Order per route: method guard, parameter validation, readiness (chain + facilitator, cached), cheap cached existence
  // check, payment (402 challenge or verification), then the real reads. Reads that can fail run after verification, so
  // a failure answers 4xx/5xx and the payment layer cancels settlement: nothing is charged.
  const server = new x402ResourceServer(facilitator.client).register(network, new ExactEvmScheme());
  const httpServer = new x402HTTPResourceServer(server, deps.routes ?? x402Routes(config));
  let payment: RequestHandler | undefined;
  const paywall: RequestHandler = (req, res, next) => {
    payment ??= paymentMiddlewareFromHTTPServer(httpServer);
    Promise.resolve(payment(req, res, next)).catch(next);
  };
  const readyGate: RequestHandler = (_req, res, next) => {
    ready().then(
      () => next(),
      (error) => logAndFail(res, "not ready", error, 503, "Payment service temporarily unavailable", 5),
    );
  };
  // Defence in depth: a paid route that the payment layer does not cover is refused rather than served for free.
  const covered: RequestHandler = (req, res, next) => {
    const context = { adapter: new ExpressAdapter(req), path: req.path, method: req.method };
    if (httpServer.requiresPayment(context)) return next();
    logAndFail(res, "paid route not covered by the payment layer", req.path, 500, "Internal error");
  };
  type Check = (req: Request, res: Response) => Promise<boolean>;
  const pre =
    (check: Check): RequestHandler =>
    (req, res, next: NextFunction) => {
      check(req, res).then(
        (proceed) => proceed && next(),
        (error) => logAndFail(res, "precheck", error, 503, "Could not verify the request on-chain", 5),
      );
    };
  const mount = (
    endpoint: PaidEndpoint,
    validate: RequestHandler,
    exists: Check | undefined,
    handler: (req: Request, res: Response) => Promise<void>,
  ) => {
    app
      .route(endpoint.expressPath)
      .all(getOnly)
      .get(
        validate,
        readyGate,
        ...(exists ? [pre(exists)] : []),
        genericMiddlewareErrors,
        covered,
        paywall,
        guarded(endpoint.id, handler),
      );
  };
  const idValidator =
    (param: string, label: string): RequestHandler =>
    (req, res, next) => {
      const id = parseId(req.params[param]);
      if (id === undefined) return fail(res, 400, `Invalid ${label}`);
      res.locals.id = id;
      next();
    };

  const bounty = PAID_ENDPOINTS.find((e) => e.id === "bounty")!;
  const reputation = PAID_ENDPOINTS.find((e) => e.id === "reputation")!;
  const workers = PAID_ENDPOINTS.find((e) => e.id === "workers")!;
  const contest = PAID_ENDPOINTS.find((e) => e.id === "contest")!;

  mount(
    bounty,
    idValidator("jobId", "job ID"),
    async (_req, res) => {
      if (await reader.lookupJob(res.locals.id)) return true;
      fail(res, 404, "Bounty not found");
      return false;
    },
    async (_req, res) => {
      const snapshot = await reader.bountySnapshot(res.locals.id);
      if (snapshot) respond(res, 200, snapshot);
      else fail(res, 404, "Bounty not found");
    },
  );

  mount(
    reputation,
    idValidator("agentId", "agent ID"),
    async (_req, res) => {
      if (!reader.isKnownMissingAgent(res.locals.id)) return true;
      fail(res, 404, "Unknown agent identity");
      return false;
    },
    async (_req, res) => {
      const body = await reader.reputationSnapshot(res.locals.id);
      if (body) respond(res, 200, body);
      else fail(res, 404, "Unknown agent identity");
    },
  );

  mount(
    workers,
    (req, res, next) => {
      const parsed = parseVerifiedQuery(req.query as Record<string, unknown>);
      if (!parsed.ok) return fail(res, 400, parsed.error);
      res.locals.gate = parsed.value;
      next();
    },
    undefined,
    async (_req, res) => {
      const release = heavy.tryAcquire();
      if (!release) return fail(res, 503, "Busy, retry shortly", 2);
      try {
        respond(res, 200, await reader.verifiedWorkers(res.locals.gate));
      } finally {
        release();
      }
    },
  );

  mount(
    contest,
    idValidator("jobId", "job ID"),
    async (_req, res) => {
      const info = await reader.lookupJob(res.locals.id);
      if (!info) fail(res, 404, "Contest not found");
      else if (!info.contest) fail(res, 404, "Job is not a contest");
      return info?.contest === true;
    },
    async (_req, res) => {
      const result = await reader.contestResult(res.locals.id);
      if (result === undefined) fail(res, 404, "Contest not found");
      else if (result === "not-contest") fail(res, 404, "Job is not a contest");
      else respond(res, 200, result);
    },
  );

  app.use((_req, res) => fail(res, 404, "Not found"));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logAndFail(res, "unhandled", error, 503, "Payment service unavailable");
  });
  return app;
}
