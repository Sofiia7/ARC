import type { RequestHandler } from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { PRICES, type FacadeConfig } from "./config.js";

/**
 * x402 wiring, isolated in one file on purpose: the Circle stack is young
 * (`@circle-fin/x402-batching` 3.x, spec v2 since 2025-12) - if its surface
 * drifts, this is the only file that should need to change.
 *
 * Two modes:
 *  - SELLER_ADDRESS set → real x402: unpaid requests get HTTP 402 with v2
 *    payment instructions (base64 `PAYMENT-REQUIRED` header), settled via
 *    Circle Gateway on this instance's configured network (config.caip2).
 *  - unset → free mode for local dev/CI: every paid route passes through,
 *    marked with `X-Payment-Mode: free` so nobody mistakes it for prod.
 */
export type PaymentGate = {
  mode: "x402" | "free";
  /** Price-tagged middleware for a paid route, e.g. paid("$0.001"). */
  paid: (price: string) => RequestHandler;
};

export function createPaymentGate(config: FacadeConfig): PaymentGate {
  if (!config.sellerAddress) {
    // M-10: made loud and specific on purpose - this is the difference
    // between "priced API" and "every paid route gives its response away for
    // free", and a startup log is the one place guaranteed to be seen before
    // traffic hits it. This stays a warning rather than a thrown startup
    // error: no NODE_ENV/production-style signal is read anywhere else in
    // this codebase (the Dockerfile sets NODE_ENV=production for the
    // container, but nothing in src/ inspects it - see config.ts/README.md),
    // and free mode is the documented, correct state for local dev, CI, and
    // the base-sepolia staging instance (docs/INTEGRATION_NOTES.md: x402
    // settlement isn't confirmed there yet). Inventing an environment-mode
    // signal just for this one check would be new machinery for a single
    // call site; spelling out exactly what's exposed is enough for someone
    // to notice a real deployment misconfigured this way.
    console.warn(
      "=".repeat(78) + "\n" +
      "[facade] SELLER_ADDRESS is not set - running in FREE mode.\n" +
      "Every paid route below is serving for $0, with NO x402 payment required:\n" +
      `  GET  /v1/bounties                 (normally ${PRICES.listBounties})\n` +
      `  GET  /v1/bounties/:id             (normally ${PRICES.getBounty})\n` +
      `  GET  /v1/bounties/:id/submissions (normally ${PRICES.getSubmissions})\n` +
      `  POST /v1/bounties/prepare         (normally ${PRICES.prepareBounty})\n` +
      "Each response still carries X-Payment-Mode: free, but this is the one " +
      "place that names every affected route at once.\n" +
      "This is correct for local dev/CI/staging. If this is a production " +
      "deployment meant to charge for these routes, set SELLER_ADDRESS.\n" +
      "=".repeat(78),
    );
    const free: (price: string) => RequestHandler = () => (_req, res, next) => {
      res.setHeader("X-Payment-Mode", "free");
      next();
    };
    return { mode: "free", paid: free };
  }

  const gateway = createGatewayMiddleware({
    sellerAddress: config.sellerAddress,
    networks: [config.caip2],
    facilitatorUrl: config.facilitatorUrl,
    description: `${config.brandName} facade API - on-chain bounty discovery for agents`,
  });
  return { mode: "x402", paid: (price: string) => gateway.require(price) };
}
