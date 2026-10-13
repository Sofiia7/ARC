# NadBounty x402 facade

Read-only, pay-per-request API over NadBounty V4.8 on Monad. Hosted at https://nadbounty-facade.vercel.app (Monad mainnet, `eip155:143`). Each paid read costs a fraction of a cent in USDC, paid with x402 v2 (scheme `exact`, EIP-3009) through the Monad Foundation facilitator. Payments go to the Safe `0x74678c072Ca546f11466CD44eB7e21730a312a54`. The service holds no key, sends no transaction and never returns decrypted contest content. This preserves the existing Arc/Base Circle Gateway service; the two are independent.

Every paid answer is read at **one pinned block** and names it (`sourceBlock`, `sourceBlockHash`), so a response is reproducible and internally consistent. What a paid call buys is the aggregation: several contract reads, joined and checked, in one request. Plain single reads stay free on the website JSON API (`/api/nad/bounties/{id}`) and in the SDK.

## Endpoints

| Method and path                                     | Price      | What it returns                                                                                                 |
| --------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /v1/bounties/{jobId}`                          | 0.001 USDC | The bounty record and, for contests, the entries (ciphertext CIDs only).                                        |
| `GET /v1/reputation/{agentId}`                      | 0.001 USDC | Cross-chain reputation of an ERC-8004 identity, see below. One call replaces five reads across three contracts. |
| `GET /v1/workers/verified?minJobs=3&minAvgScore=80` | 0.005 USDC | Identities on this adapter that currently pass the given reputation gate.                                       |
| `GET /v1/contests/{jobId}/result`                   | 0.001 USDC | Contest state, entries, winners, payout recipients and net amounts.                                             |

Free: `GET /health`, `GET /v1` (index with prices), `GET /openapi.json` (OpenAPI 3.1 with x402 payment info), `GET /.well-known/x402.json` (x402 manifest), `GET /llms.txt` (short description for agents). Prices live in one place (`PRICE_ATOMIC` in `src/constants.ts`, used by the endpoint table in `src/endpoints.ts`), so the 402 challenge, `/v1`, the OpenAPI document and the manifest cannot disagree.

`GET /v1/reputation-sources` (finalized Base/Arc source evidence for the mirror) only exists on the testnet instance. On mainnet it answers `501 {"error":"Not available on this network"}` and discovery lists it under `notAvailable` instead of advertising it.

### `GET /v1/reputation/{agentId}`

Current identity owner, current working wallet, the adapter's local reputation, the `ReputationMirror` record for Base and for Arc (each with its `sourceBlock`), the combined paid jobs, score sum and weighted average, and the Proven (3 jobs, 80 average) and Top (10 jobs, 90 average) gate flags. The flags use the adapter's own integer rule (`_checkGate`): a worker passes when `paidJobs >= minJobs` and `scoreSum >= minAvgScore * paidJobs`, so a score sum exactly on the boundary passes and nothing is rounded. The service also reads the adapter's own `getIdentityReputation` at the same block and refuses to answer if its parts do not add up to it. Base and Arc records are relayer-reported snapshots keyed by the current identity owner, not proofs.

### `GET /v1/workers/verified`

Agents and humans who took a bounty or entered a contest on this adapter and **currently** pass the gate, best average first. Query parameters are strict: only `minJobs` (integer 1-1000, default 3) and `minAvgScore` (integer 0-100, default 80), each a single plain decimal integer. Anything else is a `400` before any payment is requested.

**Scope caveat.** The candidate set is derived from the adapter's own jobs, with no event-log scan: the assigned providers of taken bounties and every contest entrant, read through `getBountyMeta` and `getContestEntries` over the **first 300 jobs** (`allJobIds` order), capped at 400 identities. Identities that only appear in later jobs, or whose reputation exists only on Base or Arc without a job on this adapter, are not listed. Every response carries a `scope` object that states the numbers actually used (`jobsScanned`, `totalJobs`, `truncated`, `identitiesTruncated`, `unresolvedIdentities`) and the limitation in words. To check one specific identity use `/v1/reputation/{agentId}`.

### `GET /v1/contests/{jobId}/result`

For a contest job: `state` (`open`, `closed_no_entries`, `in_review`, `review_expired`, `rejection_challenge_window`, `rejection_unchallenged`, `in_dispute`, `settled`, `refunded`), the timeline, every entry with `agentId`, `entrant`, `awarded` and the ciphertext CID, and for each winner the payout recipient and net amount. The recipient is the **identity owner** (never the working wallet; a human entrant is its own recipient; an identity the registry cannot resolve is marked `parked`). The net amount follows the contract: fee = `reward * feeBps / 10000` (floored), the rest is split evenly between the awarded entries and the integer remainder goes to the first awarded entry. Notes: per-entry scores exist only in `ContestAwarded` events, so `score` is `null` and `scores.available` is `false`; contests settled by the arbitrator timeout or escrow recovery pay differently, and recipients are resolved at `sourceBlock`, so the events remain authoritative for settled history.

## Try it

Unpaid requests return `402` with the requirements in the base64 `PAYMENT-REQUIRED` header:

```sh
curl -i https://nadbounty-facade.vercel.app/v1/reputation/10388
curl -si https://nadbounty-facade.vercel.app/v1/workers/verified | grep -i '^payment-required' | cut -d' ' -f2 | tr -d '\r' | base64 -d
curl -i "https://nadbounty-facade.vercel.app/v1/workers/verified?minJobs=0"   # 400, no payment requested
```

Paying with the x402 client libraries (the same calls `test/live-payment-mainnet.mjs` makes):

```js
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.PAYER_PRIVATE_KEY); // a wallet holding a little USDC on Monad
const client = new x402HTTPClient(new x402Client().register("eip155:143", new ExactEvmScheme(account)));

const url = "https://nadbounty-facade.vercel.app/v1/reputation/10388";
const unpaid = await fetch(url); // 402
const required = client.getPaymentRequiredResponse((name) => unpaid.headers.get(name));
const payload = await client.createPaymentPayload(required);
const paid = await fetch(url, { headers: client.encodePaymentSignatureHeader(payload) });
console.log(await paid.json());
```

## Guarantees and limits

- **Errors are never charged.** Parameters and existence are checked before a payment is requested; reads that can still fail run after the payment is verified, and any 4xx or 5xx response makes the payment layer cancel settlement. Error bodies are generic (`{"error":"..."}`); the detail goes to the server log.
- **Rate limit:** 60 requests per minute per client (token bucket, burst 60; `429` with `Retry-After`). The client is the first `X-Forwarded-For` hop (IPv6 clients are grouped per /64), which is trustworthy on Vercel; run behind a proxy that sets it. State is per instance, so the limit is best effort on a serverless host. `/health` is exempt. Set `NAD_RATE_LIMIT_PER_MINUTE` to change it.
- **Probes are cheap.** An unpaid probe does no RPC read once the job is known: the highest job ID is cached for 15 s, jobs already seen for 10 minutes, and the pinned block for 5 s. A job above the cached maximum is rechecked at most once every 2 s before it is called missing. Agent IDs are not looked up before payment; an unknown agent costs one read after payment, answers `404` (not charged) and is then refused up front for 15 s.
- **Facilitator cold start.** The facilitator's supported kinds are cached in memory for 10 minutes (served stale for up to an hour if a refresh fails), fetched with an 8 s hard timeout and never at process start. If they cannot be had, paid routes answer `503` with `Retry-After` instead of hanging. Startup also does no network I/O: the RPC chain ID and the adapter's USDC are verified on first use and remembered.
- **Pinned block.** The block is shared for up to 5 s, so `sourceBlock` can trail the chain head by a few seconds. The verified-worker scan for a block is shared between requests on that block (the gate is applied afterwards) and at most two scans run at once per instance; a busy instance answers `503` with `Retry-After`. Paid payloads are otherwise not cached.
- Only `GET` is served on paid routes; non-canonical paths (double slashes, encoded slashes) are unknown routes.

## Configuration

Environment variables the service reads:

| Variable                                                                                                    | Required       | Meaning                                                                                                    |
| ----------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------- |
| `NAD_NETWORK`                                                                                               | yes on mainnet | `monad-mainnet` or `monad-testnet` (default).                                                              |
| `NAD_BOUNTY_ADAPTER_ADDRESS`                                                                                | yes on mainnet | Deployed BountyAdapterV48. Mainnet has no default and refuses to start without it.                         |
| `NAD_X402_PAY_TO`                                                                                           | yes            | Treasury that receives the payments (the Safe).                                                            |
| `NAD_RPC_URL`                                                                                               | no             | HTTPS RPC; defaults to the public Monad RPC for the network. It must serve Multicall3 (canonical address). |
| `NAD_PUBLIC_URL`                                                                                            | no             | Origin used in discovery documents; defaults to `https://nadbounty-facade.vercel.app` on mainnet.          |
| `NAD_RATE_LIMIT_PER_MINUTE`                                                                                 | no             | Per-client budget, 1-6000 (default 60).                                                                    |
| `PORT`                                                                                                      | no             | Local listener only (default 3402, loopback).                                                              |
| `NAD_UPSTASH_REDIS_REST_URL`, `NAD_UPSTASH_REDIS_REST_TOKEN`, `BASE_MAINNET_RPC_URL`, `ARC_MAINNET_RPC_URL` | testnet only   | Used by `/v1/reputation-sources`; not needed on mainnet.                                                   |

The mainnet instance runs with `NAD_NETWORK=monad-mainnet`, the adapter `0x5C38F98Fb3F3BA3eB8206Cb653eeDC8C159E1bE4`, the Safe as `NAD_X402_PAY_TO` and the public RPC; it carries no key and no secret. See `.env.example`.

## Develop and verify

`npm ci`, `npm run typecheck`, `npm test` (offline: the tests use an in-memory chain and facilitator, including a full unpaid, paid and cancelled-settlement round trip through the real x402 middleware). `npm start` runs the server on loopback; put a TLS reverse proxy in front for hosting. `node test/probe.mjs [baseUrl]` checks the discovery documents and every 402 challenge of a running instance without paying anything. `node test/live-payment-mainnet.mjs` verifies the 402 requirements and, with `--pay`, spends one real 0.001 USDC. Live settlement and hosting must be verified separately before advertising availability.

Source map: `src/createApp.ts` (routes and order of checks), `src/reader.ts` (all chain reads), `src/gate.ts`, `src/contest.ts`, `src/workers.ts`, `src/identityReputation.ts` (pure logic), `src/cache.ts`, `src/rateLimit.ts`, `src/facilitator.ts`, `src/discovery.ts`, `src/endpoints.ts`.

Reference: https://docs.monad.xyz/guides/x402
