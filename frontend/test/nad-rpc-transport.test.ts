import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, http } from "viem";
import { rpcTransportOptions } from "../lib/rpcTransport";

for (const chainId of [143, 10143, 5042, 5042002, 8453, 84532]) {
  const monad = chainId === 143 || chainId === 10143;
  test(`chain ${chainId} ${monad ? "sends individual RPC requests" : "keeps RPC batching"}`, async () => {
    const bodies: unknown[] = [];
    const client = createPublicClient({
      transport: http(`https://rpc-${chainId}.example.test`, {
        ...rpcTransportOptions(chainId),
        fetchFn: async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          bodies.push(body);
          const reply = (request: { id: number }) => ({ jsonrpc: "2.0", id: request.id, result: "0x1" });
          return Response.json(Array.isArray(body) ? body.map(reply) : reply(body));
        },
      }),
    });
    assert.deepEqual(await Promise.all([
      client.request({ method: "eth_chainId" }),
      client.request({ method: "eth_blockNumber" }),
    ]), ["0x1", "0x1"]);
    assert.equal(bodies.length, monad ? 2 : 1);
    assert.equal(bodies.every(body => Array.isArray(body) === !monad), true);
  });
}

test("preserves browser and server retry settings", () => {
  for (const chainId of [143, 10143, 5042, 5042002, 8453, 84532]) {
    assert.equal(rpcTransportOptions(chainId).retryCount, 3);
    assert.equal(rpcTransportOptions(chainId).retryDelay, 400);
    assert.equal(rpcTransportOptions(chainId, 2, 300).retryCount, 2);
    assert.equal(rpcTransportOptions(chainId, 2, 300).retryDelay, 300);
  }
});
