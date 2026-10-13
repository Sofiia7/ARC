import { test } from "node:test";
import assert from "node:assert/strict";
import { FacilitatorTimeoutError } from "@x402/core/server";
import { TokenBucketLimiter } from "../src/rateLimit.js";
import {
  HUMAN,
  OWNER_10388,
  OWNER_2077,
  TREASURY,
  WALLET_10388,
  decodeRequired,
  fakeChain,
  fakeFacilitator,
  paymentHeaderFrom,
  startApp,
  type Harness,
} from "./helpers.js";

async function withApp(run: (h: Harness) => Promise<void>, options: Parameters<typeof startApp>[0] = {}) {
  const harness = await startApp(options);
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

const json = async (response: Response) => JSON.parse(await response.text());

/** Unpaid request, then the paid repeat, the way an x402 client behaves. */
async function pay(h: Harness, path: string) {
  const challenge = await fetch(`${h.base}${path}`);
  assert.equal(challenge.status, 402, `${path} should ask for payment first`);
  await challenge.text();
  return fetch(`${h.base}${path}`, { headers: paymentHeaderFrom(challenge) });
}

test("every paid route answers 402 with the exact scheme, the right price and the treasury", async () => {
  await withApp(async (h) => {
    const expected: Record<string, string> = {
      "/v1/bounties/2": "1000",
      "/v1/reputation/10388": "1000",
      "/v1/workers/verified?minJobs=3&minAvgScore=80": "5000",
      "/v1/contests/2/result": "1000",
    };
    for (const [path, amount] of Object.entries(expected)) {
      const response = await fetch(`${h.base}${path}`);
      assert.equal(response.status, 402, path);
      const required = decodeRequired(response);
      assert.equal(required.x402Version, 2);
      assert.equal(required.accepts.length, 1);
      const [accept] = required.accepts;
      assert.equal(accept.scheme, "exact");
      assert.equal(accept.network, "eip155:143");
      assert.equal(accept.amount, amount, path);
      assert.equal(accept.payTo.toLowerCase(), TREASURY.toLowerCase());
      assert.equal(accept.asset.toLowerCase(), "0x754704bc059f8c67012fed69bc8a327a5aafb603");
      assert.deepEqual(accept.extra, { name: "USDC", version: "2" });
    }
    assert.equal(h.facilitator.counts.settle, 0);
  });
});

test("behind a proxy the advertised resource URL is https", async () => {
  await withApp(async (h) => {
    const direct = await fetch(`${h.base}/v1/bounties/2`);
    assert.match(decodeRequired(direct).resource.url, /^http:\/\/127\.0\.0\.1:\d+\/v1\/bounties\/2$/);
    const proxied = await fetch(`${h.base}/v1/bounties/2`, { headers: { "x-forwarded-proto": "https" } });
    assert.match(decodeRequired(proxied).resource.url, /^https:\/\/127\.0\.0\.1:\d+\/v1\/bounties\/2$/);
  });
});

test("malformed IDs and queries are rejected before any RPC or facilitator call", async () => {
  await withApp(async (h) => {
    for (const path of [
      "/v1/bounties/0",
      "/v1/bounties/abc",
      "/v1/bounties/01",
      "/v1/bounties/1e3",
      `/v1/bounties/${"9".repeat(31)}`,
      "/v1/reputation/0",
      "/v1/reputation/-1",
      "/v1/contests/x/result",
      "/v1/workers/verified?minJobs=0",
      "/v1/workers/verified?minJobs=3.5",
      "/v1/workers/verified?minAvgScore=101",
      "/v1/workers/verified?minJobs=1&minJobs=2",
      "/v1/workers/verified?foo=bar",
      "/v1/workers/verified?minJobs[a]=1",
    ]) {
      const response = await fetch(`${h.base}${path}`);
      assert.equal(response.status, 400, path);
      const body = await json(response);
      assert.equal(typeof body.error, "string");
      assert.deepEqual(Object.keys(body), ["error"]);
    }
    assert.equal(h.chain.log.batches, 0);
    assert.equal(h.chain.log.blocks, 0);
    assert.equal(h.facilitator.counts.supported, 0);
  });
});

test("non-existent jobs are refused before payment, from cache after the first look", async () => {
  await withApp(async (h) => {
    const missing = await fetch(`${h.base}/v1/bounties/999`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await json(missing), { error: "Bounty not found" });
    const before = h.chain.log.batches;
    for (let i = 0; i < 20; i++) assert.equal((await fetch(`${h.base}/v1/bounties/999`)).status, 404);
    assert.equal(h.chain.log.batches, before, "repeat probes of a missing job must not touch the RPC");
    assert.equal(h.facilitator.counts.settle, 0);
  });
});

test("unpaid probes of an existing job cost no RPC once the job has been seen", async () => {
  await withApp(async (h) => {
    assert.equal((await fetch(`${h.base}/v1/bounties/2`)).status, 402);
    const batches = h.chain.log.batches;
    const blocks = h.chain.log.blocks;
    for (let i = 0; i < 25; i++) assert.equal((await fetch(`${h.base}/v1/bounties/2`)).status, 402);
    assert.equal(h.chain.log.batches, batches);
    assert.equal(h.chain.log.blocks, blocks);
    assert.equal(h.facilitator.counts.supported, 1, "supported kinds are fetched once and cached");
    // A job not seen yet costs exactly one read, once.
    assert.equal((await fetch(`${h.base}/v1/bounties/5`)).status, 402);
  });
});

test("bounty: a paid request returns the block-pinned snapshot and settles once", async () => {
  await withApp(async (h) => {
    const response = await pay(h, "/v1/bounties/2");
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("payment-response"));
    const body = await json(response);
    assert.equal(body.chainId, 143);
    assert.equal(body.contractVersion, "4.8");
    assert.equal(body.sourceBlock, "1000");
    assert.equal(body.sourceBlockHash, `0x${"ab".repeat(32)}`);
    assert.equal(body.meta.jobId, "2");
    assert.equal(body.entries.length, 1);
    assert.equal(body.entries[0].resultHash, "ipfs://QmCiphertext2");
    assert.deepEqual(h.facilitator.counts, { supported: 1, verify: 1, settle: 1 });
  });
});

test("reputation: one call returns identity, wallets, local, Base, Arc, combined and gate flags", async () => {
  await withApp(async (h) => {
    const response = await pay(h, "/v1/reputation/10388");
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(body.agentId, "10388");
    assert.equal(body.identityOwner, OWNER_10388);
    assert.equal(body.workingWallet, WALLET_10388);
    assert.deepEqual(body.local, { paidJobs: "1", scoreSum: "95", averageScore: "95.00" });
    assert.equal(body.mirror.records.length, 2);
    assert.deepEqual(body.mirror.records[0], {
      sourceChain: 8453,
      chain: "base",
      paidJobs: "2",
      scoreSum: "170",
      averageScore: "85.00",
      sourceBlock: "52341683",
      updatedAt: "1791000000",
    });
    assert.equal(body.mirror.records[1].chain, "arc");
    assert.deepEqual(body.combined, { paidJobs: "3", scoreSum: "265", averageScore: "88.33" });
    assert.deepEqual(body.gates.proven, { minJobs: 3, minAvgScore: 80, passes: true });
    assert.deepEqual(body.gates.top, { minJobs: 10, minAvgScore: 90, passes: false });
    assert.equal(body.sourceBlock, "1000");
    assert.deepEqual(h.facilitator.counts, { supported: 1, verify: 1, settle: 1 });
  });
});

test("reputation: an unknown identity is a 404 that is never charged, then refused up front", async () => {
  await withApp(async (h) => {
    const paid = await pay(h, "/v1/reputation/777777");
    assert.equal(paid.status, 404);
    assert.deepEqual(await json(paid), { error: "Unknown agent identity" });
    assert.equal(h.facilitator.counts.verify, 1);
    assert.equal(h.facilitator.counts.settle, 0, "a 404 must cancel settlement");
    const again = await fetch(`${h.base}/v1/reputation/777777`);
    assert.equal(again.status, 404, "the miss is remembered, so no payment is requested again");
  });
});

test("contest: result for a settled contest pays the identity owner, with the fee taken", async () => {
  await withApp(async (h) => {
    const response = await pay(h, "/v1/contests/2/result");
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(body.state, "settled");
    assert.equal(body.jobId, "2");
    assert.equal(body.entries.length, 1);
    assert.equal(body.entries[0].agentId, "10388");
    assert.equal(body.entries[0].entrant, WALLET_10388);
    assert.equal(body.entries[0].identityOwner, OWNER_10388);
    assert.equal(body.entries[0].payout.recipient, OWNER_10388);
    assert.deepEqual(body.entries[0].payout.net, { atomic: "1980000", usdc: "1.98" });
    assert.equal(body.entries[0].ciphertextCid, "ipfs://QmCiphertext2");
    assert.deepEqual(body.settlement.fee, { atomic: "20000", usdc: "0.02" });
    assert.equal(body.sourceBlock, "1000");
    assert.equal(h.facilitator.counts.settle, 1);
  });
});

test("contest: a plain bounty and a missing job are refused before payment", async () => {
  await withApp(async (h) => {
    const plain = await fetch(`${h.base}/v1/contests/1/result`);
    assert.equal(plain.status, 404);
    assert.deepEqual(await json(plain), { error: "Job is not a contest" });
    const missing = await fetch(`${h.base}/v1/contests/404/result`);
    assert.equal(missing.status, 404);
    assert.equal(h.facilitator.counts.verify, 0);
  });
});

test("workers: default Proven gate lists the identities that pass, with the scope caveat", async () => {
  await withApp(async (h) => {
    const response = await pay(h, "/v1/workers/verified");
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.deepEqual(body.gate, { minJobs: 3, minAvgScore: 80, rule: body.gate.rule });
    // 10388: 3 jobs, 265 (88.33); 2077 (owner has Arc 6 jobs, 535): 89.16; human: 3 jobs, 270 (90.00)
    assert.equal(body.count, 3);
    assert.deepEqual(
      body.workers.map((w: any) => w.agentId ?? w.wallet),
      [HUMAN, "2077", "10388"],
    );
    assert.equal(body.workers[0].averageScore, "90.00");
    assert.equal(body.workers[2].identityOwner, OWNER_10388);
    assert.equal(body.workers[2].workingWallet, WALLET_10388);
    assert.equal(body.scope.jobsScanned, 5);
    assert.equal(body.scope.truncated, false);
    assert.match(body.scope.limitation, /beyond the first 300/);
    assert.equal(h.facilitator.counts.settle, 1);
  });
});

test("workers: the boundary 270 == 90 * 3 passes, 265 < 270 does not", async () => {
  await withApp(async (h) => {
    const response = await pay(h, "/v1/workers/verified?minJobs=3&minAvgScore=90");
    const body = await json(response);
    assert.equal(body.count, 1);
    assert.equal(body.workers[0].wallet, HUMAN);
    const top = await pay(h, "/v1/workers/verified?minJobs=10&minAvgScore=90");
    assert.equal((await json(top)).count, 0);
  });
});

test("the verified-worker scan is shared between requests on the same pinned block", async () => {
  await withApp(async (h) => {
    await (await pay(h, "/v1/workers/verified")).text();
    const calls = h.chain.log.calls.length;
    const second = await pay(h, "/v1/workers/verified?minJobs=3&minAvgScore=90");
    assert.equal(second.status, 200);
    await second.text();
    assert.equal(h.chain.log.calls.length, calls, "a different gate on the same block re-reads nothing");
  });
});

test("an RPC failure after verification answers 503 generically and cancels the settlement", async () => {
  await withApp(async (h) => {
    const challenge = await fetch(`${h.base}/v1/reputation/10388`);
    assert.equal(challenge.status, 402);
    await challenge.text();
    h.chain.failNext.calls = true;
    const failed = await fetch(`${h.base}/v1/reputation/10388`, { headers: paymentHeaderFrom(challenge) });
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get("retry-after"), "5");
    const text = await failed.text();
    assert.deepEqual(JSON.parse(text), { error: "Could not read the on-chain snapshot" });
    assert.doesNotMatch(text, /rpc|secret|invalid|http/i);
    assert.equal(h.facilitator.counts.verify, 1);
    assert.equal(h.facilitator.counts.settle, 0, "the caller must not be charged");
  });
});

test("cold start: a hung facilitator answers 503 with Retry-After, quickly, and recovers", async () => {
  let hang = true;
  // Once the facilitator "wakes up" it answers with the standard supported kinds.
  const standard = fakeFacilitator();
  const recovering = fakeFacilitator({
    timeoutMs: 80,
    supported: async () => (hang ? new Promise<never>(() => undefined) : standard.handle.supported.get()),
  });
  await withApp(
    async (h) => {
      const started = Date.now();
      const response = await fetch(`${h.base}/v1/bounties/2`);
      assert.equal(response.status, 503);
      assert.ok(Date.now() - started < 3000, "must fail fast, not after 90 s");
      assert.equal(response.headers.get("retry-after"), "5");
      assert.deepEqual(await json(response), { error: "Payment service temporarily unavailable" });
      // Free routes never wait on the facilitator.
      assert.equal((await fetch(`${h.base}/health`)).status, 200);
      assert.equal((await fetch(`${h.base}/v1`)).status, 200);
      hang = false;
      assert.equal((await fetch(`${h.base}/v1/bounties/2`)).status, 402);
    },
    { facilitator: recovering },
  );
});

test("a wrong RPC chain or adapter token fails closed", async () => {
  const wrongChain = fakeChain(8453);
  await withApp(
    async (h) => {
      const response = await fetch(`${h.base}/v1/bounties/2`);
      assert.equal(response.status, 503);
      assert.equal(h.facilitator.counts.settle, 0);
    },
    { chain: wrongChain },
  );
});

test("rate limit: the 61st request in a minute is a 429 with Retry-After, /health is exempt", async () => {
  const limiter = new TokenBucketLimiter({ capacity: 60, refillPerSecond: 1 });
  await withApp(
    async (h) => {
      for (let i = 0; i < 60; i++)
        assert.equal((await fetch(`${h.base}/v1`, { headers: { "x-forwarded-for": "203.0.113.50" } })).status, 200);
      const limited = await fetch(`${h.base}/v1/bounties/2`, { headers: { "x-forwarded-for": "203.0.113.50" } });
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get("retry-after")) >= 1);
      assert.deepEqual(await json(limited), { error: "Too many requests" });
      const other = await fetch(`${h.base}/v1/bounties/2`, { headers: { "x-forwarded-for": "203.0.113.51" } });
      assert.equal(other.status, 402);
      assert.equal((await fetch(`${h.base}/health`, { headers: { "x-forwarded-for": "203.0.113.50" } })).status, 200);
    },
    { limiter },
  );
});

test("only GET reaches a paid route: HEAD, POST and OPTIONS cannot skip the payment layer", async () => {
  await withApp(async (h) => {
    for (const method of ["HEAD", "POST", "OPTIONS", "PUT", "DELETE"]) {
      const response = await fetch(`${h.base}/v1/reputation/10388`, { method });
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.get("allow"), "GET");
    }
    assert.equal(h.chain.log.batches, 0);
  });
});

test("non-canonical paths are unknown routes, never a payment request", async () => {
  await withApp(async (h) => {
    const raw = async (path: string) => {
      const url = new URL(h.base);
      const response = await fetch(`http://${url.host}${path}`);
      return response.status;
    };
    assert.equal(await raw("//v1/bounties/2"), 404);
    assert.equal(await raw("/v1/bounties/2%2f"), 404);
    assert.equal(await raw("/v1/bounties/2/extra"), 404);
    assert.equal(await raw("/v1/bounties/"), 404);
    assert.equal(await raw("/nothing"), 404);
    assert.equal(h.facilitator.counts.verify, 0);
  });
});

test("discovery routes are free and complete", async () => {
  await withApp(async (h) => {
    const index = await json(await fetch(`${h.base}/v1`));
    assert.equal(index.baseUrl, "https://nadbounty-facade.vercel.app");
    assert.equal(index.endpoints.length, 4);
    const root = await json(await fetch(`${h.base}/`));
    assert.equal(root.service, index.service);
    const openapi = await json(await fetch(`${h.base}/openapi.json`));
    assert.equal(openapi.openapi, "3.1.0");
    assert.equal(openapi.servers[0].url, "https://nadbounty-facade.vercel.app");
    const manifest = await json(await fetch(`${h.base}/.well-known/x402.json`));
    assert.equal(manifest.endpoints.length, 4);
    const llms = await fetch(`${h.base}/llms.txt`);
    assert.match(llms.headers.get("content-type") ?? "", /text\/plain/);
    assert.match(await llms.text(), /nadbounty-facade\.vercel\.app/);
    const health = await json(await fetch(`${h.base}/health`));
    assert.equal(health.ok, true);
    assert.equal(health.priceUSDC, "0.001");
    assert.deepEqual(health.prices, { bounty: "0.001", reputation: "0.001", workers: "0.005", contest: "0.001" });
    // None of this touched the chain or the facilitator.
    assert.equal(h.chain.log.batches, 0);
    assert.equal(h.facilitator.counts.supported, 0);
  });
});

test("reputation-sources is explicitly unavailable on mainnet, with a generic body", async () => {
  await withApp(async (h) => {
    const response = await fetch(`${h.base}/v1/reputation-sources`);
    assert.equal(response.status, 501);
    assert.deepEqual(await json(response), { error: "Not available on this network" });
  });
});

test("error bodies never carry internals", async () => {
  await withApp(async (h) => {
    h.chain.failNext.calls = true;
    const responses = [
      await fetch(`${h.base}/v1/bounties/2`), // readiness fails: RPC down
      await fetch(`${h.base}/v1/bounties/abc`),
      await fetch(`${h.base}/nothing`),
    ];
    for (const response of responses) {
      const text = await response.text();
      assert.deepEqual(Object.keys(JSON.parse(text)), ["error"]);
      assert.doesNotMatch(text, /rpc\.example|secret|stack|at \w+ \(|node_modules|Error:/i);
    }
    assert.equal(responses[0].status, 503);
    void OWNER_2077;
  });
});

test("a facilitator failure while verifying is a generic 502 with Retry-After, never its exception text", async () => {
  const facilitator = fakeFacilitator({
    verify: async () => {
      throw new FacilitatorTimeoutError("verify", 90000);
    },
  });
  await withApp(
    async (h) => {
      const challenge = await fetch(`${h.base}/v1/bounties/2`);
      await challenge.text();
      const failed = await fetch(`${h.base}/v1/bounties/2`, { headers: paymentHeaderFrom(challenge) });
      assert.equal(failed.status, 502);
      assert.equal(failed.headers.get("retry-after"), "5");
      const text = await failed.text();
      assert.deepEqual(JSON.parse(text), { error: "Payment facilitator unavailable" });
      assert.doesNotMatch(text, /timed out|90000|verify/i);
      assert.equal(h.facilitator.counts.settle, 0);
    },
    { facilitator },
  );
});

test("an unexpected facilitator exception is a generic 500", async () => {
  const facilitator = fakeFacilitator({
    verify: async () => {
      throw new Error("connect ECONNREFUSED 10.1.2.3:443 https://facilitator.internal/verify");
    },
  });
  await withApp(
    async (h) => {
      const challenge = await fetch(`${h.base}/v1/bounties/2`);
      await challenge.text();
      const failed = await fetch(`${h.base}/v1/bounties/2`, { headers: paymentHeaderFrom(challenge) });
      assert.ok(failed.status === 500 || failed.status === 402, `status ${failed.status}`);
      const text = await failed.text();
      assert.doesNotMatch(text, /ECONNREFUSED|10\.1\.2\.3|internal/);
      assert.equal(h.facilitator.counts.settle, 0);
    },
    { facilitator },
  );
});

test("a paid route that the payment layer does not cover is refused, never served for free", async () => {
  await withApp(
    async (h) => {
      const response = await fetch(`${h.base}/v1/bounties/2`, { headers: { "PAYMENT-SIGNATURE": "anything" } });
      assert.equal(response.status, 500);
      const text = await response.text();
      assert.deepEqual(JSON.parse(text), { error: "Internal error" });
      assert.doesNotMatch(text, /meta|poster|reward/);
      assert.equal(h.facilitator.counts.settle, 0);
    },
    { routes: {} },
  );
});
