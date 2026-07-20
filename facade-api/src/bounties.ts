import { BOUNTY_ADAPTER_ABI, ARC_TESTNET_CHAIN_ID } from "./sdk.js";
import type { BountyMeta, OpenBountiesFilter } from "arcbounty-agent-sdk";
import { createPublicClient, defineChain, http, type PublicClient } from "viem";
import { TtlCache } from "./cache.js";
import type { FacadeConfig } from "./config.js";

/**
 * Read-only view over the bounty board.
 *
 * Deliberately does NOT use the SDK's listOpenBounties(): that method fans out
 * one eth_call per bounty in a Promise.all, and the public Arc RPC enforces
 * ~4 requests/sec per IP (error -32011 "request limit reached" — measured, and
 * JSON-RPC batching does not help: each sub-call burns budget). A browser user
 * gets their own per-IP budget; this server shares one IP across all callers,
 * so reads are paced through a single global gate instead. A dedicated
 * ARC_RPC_URL removes the constraint entirely (see .env.example).
 */

const arcTestnet = defineChain({
  id: ARC_TESTNET_CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 6 },
  rpcUrls: { default: { http: [] } },
});

/** Minimum spacing between RPC sends, shared across all endpoints. 300ms keeps
 * us at ~3 req/s — under the measured ~4/s public-RPC budget with headroom for
 * the keeper/frontend occasionally sharing the IP. */
const RPC_GAP_MS = 300;
const RATE_LIMIT_RETRIES = 2;

export class BountyReader {
  private readonly client: PublicClient;
  private readonly listCache: TtlCache<bigint[]>;
  private readonly bountyCache: TtlCache<BountyMeta>;
  private gate: Promise<void> = Promise.resolve();

  constructor(private readonly config: FacadeConfig) {
    this.client = createPublicClient({
      chain: { ...arcTestnet, rpcUrls: { default: { http: [config.rpcUrl] } } },
      transport: http(config.rpcUrl),
    }) as PublicClient;
    this.listCache = new TtlCache<bigint[]>(config.cacheTtlMs);
    // Metas live longer than the id list: individual bounties change state a
    // handful of times over days, while the open-id set changes on every
    // take/create. 3× list TTL keeps repeat listings nearly RPC-free.
    this.bountyCache = new TtlCache<BountyMeta>(config.cacheTtlMs * 3);
  }

  /** Serialize every RPC read through one paced lane, retrying -32011. */
  private paced<T>(op: () => Promise<T>): Promise<T> {
    const run = this.gate.then(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await op();
        } catch (err) {
          const limited = err instanceof Error && /request limit|-32011|429/i.test(err.message);
          if (!limited || attempt >= RATE_LIMIT_RETRIES) throw err;
          await new Promise(r => setTimeout(r, 1_200 * (attempt + 1)));
        }
      }
    });
    // Next caller waits for this op + gap, success or failure.
    this.gate = run.then(
      () => new Promise(r => setTimeout(r, RPC_GAP_MS)),
      () => new Promise(r => setTimeout(r, RPC_GAP_MS)),
    );
    return run;
  }

  private readMeta(jobId: bigint): Promise<BountyMeta> {
    return this.paced(() =>
      this.client.readContract({
        address: this.config.bountyAdapterAddress,
        abi: BOUNTY_ADAPTER_ABI,
        functionName: "getBountyMeta",
        args: [jobId],
      }),
    ) as Promise<BountyMeta>;
  }

  async listOpen(filter: OpenBountiesFilter): Promise<{ value: BountyMeta[]; stale: boolean }> {
    const category = filter.category ?? "";
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 50;

    const ids = await this.listCache.getOrFetch(`${category}:${offset}:${limit}`, () =>
      this.paced(() =>
        this.client.readContract({
          address: this.config.bountyAdapterAddress,
          abi: BOUNTY_ADAPTER_ABI,
          functionName: "getOpenBounties",
          args: [category, BigInt(offset), BigInt(limit)],
        }),
      ).then(r => [...(r as readonly bigint[])]),
    );

    // Sequential on purpose (see header comment). Warm cache short-circuits
    // before any RPC, so only new/expired bounties actually pay the gap.
    const metas: BountyMeta[] = [];
    let anyStale = ids.stale;
    for (const id of ids.value) {
      const { value, stale } = await this.bountyCache.getOrFetch(id.toString(), () => this.readMeta(id));
      metas.push(value);
      anyStale ||= stale;
    }

    const post = metas.filter(m => {
      if (m.isTaken || m.resolved) return false; // stale cache can lag a take
      if (filter.agentOnly && !m.agentOnly) return false;
      if (filter.humanOnly && !m.humanOnly) return false;
      if (filter.minReward !== undefined && Number(m.reward) / 1e6 < filter.minReward) return false;
      if (filter.maxReward !== undefined && Number(m.reward) / 1e6 > filter.maxReward) return false;
      return true;
    });
    return { value: post, stale: anyStale };
  }

  async get(jobId: bigint): Promise<{ value: BountyMeta; stale: boolean }> {
    return this.bountyCache.getOrFetch(jobId.toString(), () => this.readMeta(jobId));
  }
}
