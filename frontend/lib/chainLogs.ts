import {
  decodeEventLog,
  encodeEventTopics,
  type AbiEvent,
  type Hex,
  type PublicClient,
} from "viem";
import { getActiveNetwork } from "./networks";

// ─── Full-history event scans without an indexer ─────────────────────────────
//
// The Arc public RPC rejects eth_getLogs over a >10,000-block range outright
// (HTTP 413, error -32614) - and Arc Testnet's clock runs fast enough that the
// chain grew ~250k blocks in the adapter's first day. A chunked RPC scan of
// the full history is therefore 25+ requests per event type on day one and
// grows daily: workable as a fallback, hopeless as the primary path.
//
// Primary path instead: ArcScan's Blockscout API (etherscan-compatible
// `module=logs&action=getLogs`), which serves an address+topic0 filter over
// the full range in ONE request and sends `Access-Control-Allow-Origin: *`.
// The underlying API returns at most ~1,000 records per call (M-12): paged
// via its own `page`/`offset` params below, up to MAX_PAGES, rather than
// silently truncating at the first page.
//
// Fallback path (Blockscout down): chunked RPC scan, bounded to the most
// recent MAX_LOOKBACK blocks so a degraded mode can't hammer the RPC for
// minutes. The bound means the fallback may under-count old events - it
// logs a console.warn so the degradation is visible, not silent.

const network = getActiveNetwork();

const BLOCKSCOUT_API = network.explorerApiUrl;
const CHUNK = 10_000n;
const CONCURRENCY = 10;
const MAX_LOOKBACK = network.maxLookbackBlocks; // fallback only
const PAGE_SIZE = 1_000; // matches the API's own per-call cap (see comment above)
const MAX_PAGES = 20; // bound worst-case work - revisit once the indexer (grant milestone 6) replaces this file

export type ScannedLog = { args: unknown; blockNumber?: bigint };

// M-12: a transient explorer failure (a blip, a deploy, a rate limit) used to
// permanently downgrade this whole serverless instance to the bounded RPC
// fallback for the rest of its lifetime - a warm instance can live for hours,
// so one bad response could mean hours of under-counted (MAX_LOOKBACK-bounded)
// results afterward even once the explorer recovered. Track the last-failure
// timestamp instead of a one-way flag, and retry the explorer path again
// after a cooldown.
const EXPLORER_RETRY_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
let explorerUnavailableSince: number | null = null;

function explorerInCooldown(): boolean {
  return explorerUnavailableSince !== null && Date.now() - explorerUnavailableSince < EXPLORER_RETRY_COOLDOWN_MS;
}

export async function getLogsChunked(
  client: PublicClient,
  params: { address: `0x${string}`; event: AbiEvent },
  fromBlock: bigint,
): Promise<ScannedLog[]> {
  if (!explorerInCooldown()) {
    try {
      const result = await blockscoutLogs(params.address, params.event, fromBlock);
      explorerUnavailableSince = null; // recovered - clear any prior failure
      return result;
    } catch (err) {
      explorerUnavailableSince = Date.now();
      console.warn(
        "[chainLogs] explorer log API unavailable, using the bounded RPC scan for the next "
        + `${EXPLORER_RETRY_COOLDOWN_MS / 60_000} minute(s) (most recent ${MAX_LOOKBACK} blocks only):`,
        err,
      );
    }
  }
  return rpcChunkedLogs(client, params, fromBlock);
}

type BlockscoutLog = {
  data: Hex;
  topics: Array<Hex | null>;
  blockNumber: Hex;
};

async function blockscoutLogs(
  address: `0x${string}`,
  event: AbiEvent,
  fromBlock: bigint,
): Promise<ScannedLog[]> {
  const [topic0] = encodeEventTopics({ abi: [event], eventName: event.name } as never);
  // Arc's ArcScan API takes no query string of its own, but Etherscan V2 is a
  // single multichain endpoint keyed by `?chainid=…` - appending another `?`
  // produced a URL the API rejects outright ("Missing or unsupported chainid").
  const sep = BLOCKSCOUT_API.includes("?") ? "&" : "?";
  const baseUrl =
    `${BLOCKSCOUT_API}${sep}module=logs&action=getLogs`
    + `&fromBlock=${fromBlock}&toBlock=latest&address=${address}&topic0=${topic0}`;

  // M-12: the underlying API caps each call at ~PAGE_SIZE records - loop
  // through subsequent pages (bounded by MAX_PAGES) until a short page (or
  // an empty one) signals we've reached the end, instead of silently
  // returning only the first page's worth of history.
  const all: BlockscoutLog[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${baseUrl}&page=${page}&offset=${PAGE_SIZE}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`blockscout ${res.status}`);
    const json = await res.json() as { result?: unknown };
    // "No records found" still returns result: [] - only a non-array is an error.
    if (!Array.isArray(json.result)) throw new Error("blockscout: unexpected response shape");

    const pageResult = json.result as BlockscoutLog[];
    all.push(...pageResult);
    if (pageResult.length < PAGE_SIZE) break; // short page - this was the last one
  }

  return all.map(raw => {
    // Blockscout pads the topics array with nulls for unused topic slots.
    const topics = raw.topics.filter((t): t is Hex => t !== null);
    const decoded = decodeEventLog({
      abi: [event],
      data: raw.data,
      topics: topics as [Hex, ...Hex[]],
    } as never);
    return {
      args: (decoded as { args: unknown }).args,
      blockNumber: BigInt(raw.blockNumber),
    };
  });
}

async function rpcChunkedLogs(
  client: PublicClient,
  params: { address: `0x${string}`; event: AbiEvent },
  fromBlock: bigint,
): Promise<ScannedLog[]> {
  const head = await client.getBlockNumber();
  if (head < fromBlock) return [];

  const floor = head - fromBlock > MAX_LOOKBACK ? head - MAX_LOOKBACK : fromBlock;

  const ranges: Array<{ from: bigint; to: bigint }> = [];
  for (let from = floor; from <= head; from += CHUNK) {
    const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n;
    ranges.push({ from, to });
  }

  const out: ScannedLog[] = [];
  for (let i = 0; i < ranges.length; i += CONCURRENCY) {
    const batch = ranges.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(r =>
        client.getLogs({
          address: params.address,
          event: params.event as never,
          fromBlock: r.from,
          toBlock: r.to,
        }),
      ),
    );
    for (const logs of results) {
      out.push(...(logs as ScannedLog[]));
    }
  }
  return out;
}
