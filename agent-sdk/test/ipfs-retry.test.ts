import { describe, it, expect, afterEach } from "vitest";
import { fetchIpfsText } from "../src/ipfs.js";
import { IPFS_GATEWAYS } from "../src/constants.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const noSleep = async () => {};

function gatewayStub(failingCalls: number, body = "# pinned deliverable") {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls <= failingCalls) return new Response("gateway timeout", { status: 504 });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  return () => calls;
}

describe("fetchIpfsText", () => {
  it("retries the whole gateway list when a freshly pinned CID 504s everywhere", async () => {
    // A CID pinned seconds ago 504s on every gateway in the first pass and only
    // resolves once propagation catches up. One pass per gateway is not enough.
    const calls = gatewayStub(IPFS_GATEWAYS.length);

    const text = await fetchIpfsText("ipfs://QmFresh", { sleep: noSleep });

    expect(text).toBe("# pinned deliverable");
    expect(calls()).toBe(IPFS_GATEWAYS.length + 1);
  });

  it("still gives up eventually instead of hanging forever", async () => {
    gatewayStub(Number.MAX_SAFE_INTEGER);

    await expect(
      fetchIpfsText("ipfs://QmNeverThere", { attempts: 2, sleep: noSleep }),
    ).rejects.toThrow(/QmNeverThere/);
  });

  it("returns on the first gateway that answers, without extra requests", async () => {
    const calls = gatewayStub(0);

    await fetchIpfsText("ipfs://QmWarm", { sleep: noSleep });

    expect(calls()).toBe(1);
  });
});
