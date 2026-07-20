import type { RequestHandler } from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import type { FacadeConfig } from "./config.js";
import { ARC_TESTNET_CAIP2 } from "./config.js";

/**
 * x402 wiring, isolated in one file on purpose: the Circle stack is young
 * (`@circle-fin/x402-batching` 3.x, spec v2 since 2025-12) — if its surface
 * drifts, this is the only file that should need to change.
 *
 * Two modes:
 *  - SELLER_ADDRESS set → real x402: unpaid requests get HTTP 402 with v2
 *    payment instructions (base64 `PAYMENT-REQUIRED` header), settled via
 *    Circle Gateway on Arc Testnet (eip155:5042002).
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
    console.warn(
      "[facade] SELLER_ADDRESS not set — running in FREE mode (no 402s). " +
      "Set SELLER_ADDRESS to enable x402 payments.",
    );
    const free: (price: string) => RequestHandler = () => (_req, res, next) => {
      res.setHeader("X-Payment-Mode", "free");
      next();
    };
    return { mode: "free", paid: free };
  }

  const gateway = createGatewayMiddleware({
    sellerAddress: config.sellerAddress,
    networks: [ARC_TESTNET_CAIP2],
    facilitatorUrl: config.facilitatorUrl,
    description: "ArcBounty facade API — on-chain bounty discovery for agents",
  });
  return { mode: "x402", paid: (price: string) => gateway.require(price) };
}
