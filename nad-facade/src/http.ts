import type { NextFunction, Request, RequestHandler, Response } from "express";
import { withTimeout } from "./cache.js";
import { LIMITS } from "./constants.js";

/**
 * Send exactly one response. `res.headersSent` is not usable for this: once a payment is verified the x402 middleware
 * buffers the response until settlement, so it stays false after a handler has already answered.
 */
export function respond(res: Response, status: number, body: unknown, retryAfterSeconds?: number): void {
  if (res.locals.responded || res.headersSent) return;
  res.locals.responded = true;
  if (retryAfterSeconds !== undefined) res.set("Retry-After", String(retryAfterSeconds));
  res.status(status).json(body);
}

/** Send a generic error body. Detail belongs in the server log, never in the response. */
export function fail(res: Response, status: number, message: string, retryAfterSeconds?: number): void {
  respond(res, status, { error: message }, retryAfterSeconds);
}

/** Log the full error server-side, then answer with a short generic body. */
export function logAndFail(
  res: Response,
  tag: string,
  error: unknown,
  status: number,
  message: string,
  retryAfterSeconds?: number,
): void {
  console.error(`[facade] ${tag}:`, error);
  fail(res, status, message, retryAfterSeconds);
}

/**
 * Wraps the work done after a payment is verified. An exception, a missing response or an exceeded deadline becomes a
 * generic 503, which makes the payment layer cancel the settlement: the caller is not charged.
 */
export function guarded(tag: string, handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res) => {
    withTimeout(handler(req, res), LIMITS.handlerDeadlineMs).then(
      () => {
        if (!res.locals.responded) {
          logAndFail(
            res,
            tag,
            new Error("handler finished without a response"),
            503,
            "Could not read the on-chain snapshot",
            5,
          );
        }
      },
      (error) => logAndFail(res, tag, error, 503, "Could not read the on-chain snapshot", 5),
    );
  };
}

/**
 * Rewrites the x402 middleware's own 500 and 502 bodies (which carry exception text) into generic errors and logs the
 * original. Payment-protocol responses (402 with PAYMENT-REQUIRED or PAYMENT-RESPONSE) are untouched.
 */
export const genericMiddlewareErrors: RequestHandler = (_req, res, next) => {
  const json = res.json.bind(res);
  res.json = ((body?: unknown) => {
    if (res.statusCode === 502 || res.statusCode === 500) {
      console.error("[facade] payment middleware error:", body);
      const unavailable = res.statusCode === 502;
      if (unavailable) res.set("Retry-After", "5");
      return json({ error: unavailable ? "Payment facilitator unavailable" : "Internal error" });
    }
    return json(body);
  }) as Response["json"];
  next();
};

/** Only GET is served on paid paths: HEAD or OPTIONS must never reach a handler that the payment layer skips. */
export const getOnly: RequestHandler = (req, res, next) => {
  if (req.method === "GET") return next();
  res.set("Allow", "GET");
  fail(res, 405, "Method not allowed");
};

/** Non-canonical paths (double slashes, backslashes, encoded slashes or control characters) are unknown routes. */
export const canonicalPath: RequestHandler = (req, res, next: NextFunction) => {
  const raw = req.originalUrl.split("?")[0];
  if (raw.includes("//") || raw.includes("\\") || /%2f|%5c|%00|[\u0000-\u001f]/i.test(raw)) {
    fail(res, 404, "Not found");
    return;
  }
  next();
};
