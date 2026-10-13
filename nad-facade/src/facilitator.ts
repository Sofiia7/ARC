import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import type { SupportedResponse } from "@x402/core/types";
import { CachedValue, hedged, type Clock } from "./cache.js";
import { TIMEOUT, TTL } from "./constants.js";

type Kinds = { kinds: readonly { network: string; scheme: string; x402Version: number }[] };

/** True when the facilitator lists the exact scheme for this network under x402 v2. */
export function supportsExactV2(supported: Kinds, network: string): boolean {
  return supported.kinds.some((k) => k.network === network && k.scheme === "exact" && k.x402Version === 2);
}

export function assertSupportsExactV2(supported: Kinds, network: string): void {
  if (!supportsExactV2(supported, network)) throw new Error("Facilitator does not support selected network");
}

export type FacilitatorHandle = {
  /** Hand this to x402ResourceServer: verify/settle go to the facilitator, getSupported comes from the cache. */
  client: FacilitatorClient;
  /** Resolves when the supported kinds are known and include the selected network; rejects otherwise. */
  ensureSupported: () => Promise<void>;
  supported: CachedValue<SupportedResponse>;
};

export type FacilitatorOptions = {
  url: string;
  network: string;
  /** Verify and settle transport. Defaults to an HTTP client with a 20 s timeout. */
  io?: FacilitatorClient;
  /** Source of the supported kinds. Defaults to an HTTP client with an 8 s timeout. */
  probe?: Pick<FacilitatorClient, "getSupported">;
  ttlMs?: number;
  timeoutMs?: number;
  /** Start a second lookup if the first has not answered after this long. */
  hedgeAfterMs?: number;
  maxStaleMs?: number;
  now?: Clock;
  onError?: (error: unknown) => void;
};

/**
 * The supported-kinds lookup never blocks startup and never hangs a request: it is cached for ten minutes, bounded by a
 * hard timer, hedged with a second attempt against one-off stalls, and the last good answer is served when a refresh
 * fails (up to an hour).
 */
export function createFacilitator(options: FacilitatorOptions): FacilitatorHandle {
  const io = options.io ?? new HTTPFacilitatorClient({ url: options.url, timeoutMs: TIMEOUT.facilitatorIo });
  const probe = options.probe ?? new HTTPFacilitatorClient({ url: options.url, timeoutMs: TIMEOUT.supportedKinds });
  const supported = new CachedValue<SupportedResponse>({
    load: () => hedged(() => probe.getSupported(), options.hedgeAfterMs ?? TIMEOUT.supportedHedge),
    validate: (value) => assertSupportsExactV2(value, options.network),
    ttlMs: options.ttlMs ?? TTL.supportedKinds,
    timeoutMs: options.timeoutMs ?? TIMEOUT.supportedKinds,
    maxStaleMs: options.maxStaleMs ?? TTL.supportedMaxStale,
    now: options.now,
    onError: options.onError ?? ((error) => console.error("[facilitator] supported kinds unavailable:", error)),
  });
  const client: FacilitatorClient = {
    verify: (payload, requirements) => io.verify(payload, requirements),
    settle: (payload, requirements) => io.settle(payload, requirements),
    getSupported: () => supported.get(),
  };
  return {
    client,
    supported,
    ensureSupported: async () => {
      await supported.get();
    },
  };
}

const shared = new Map<string, FacilitatorHandle>();

/** Module-level instance per facilitator and network, so a re-created app keeps the warm cache. */
export function sharedFacilitator(url: string, network: string): FacilitatorHandle {
  const key = `${url}|${network}`;
  let handle = shared.get(key);
  if (!handle) {
    handle = createFacilitator({ url, network });
    shared.set(key, handle);
  }
  return handle;
}
