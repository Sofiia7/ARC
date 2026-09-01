import { describe, it, expect } from "vitest";
import { waitForAllowance } from "../src/logic.js";

const noSleep = async () => {};

describe("waitForAllowance", () => {
  it("returns immediately when the allowance is already visible", async () => {
    let reads = 0;
    const read = async () => { reads++; return 500_000n; };

    await waitForAllowance(read, 500_000n, { sleep: noSleep });

    expect(reads).toBe(1);
  });

  it("keeps polling while the RPC still reports the stale pre-approve allowance", async () => {
    // The approve is mined, but this RPC node has not caught up yet: it reports
    // 0 twice before the new allowance becomes visible. This is the exact shape
    // of the takeBounty failure on the public Base RPC.
    const seen = [0n, 0n, 500_000n];
    let reads = 0;
    const read = async () => seen[reads++]!;

    await waitForAllowance(read, 500_000n, { sleep: noSleep });

    expect(reads).toBe(3);
  });

  it("throws rather than letting the caller proceed on a stale allowance", async () => {
    const read = async () => 0n;

    await expect(
      waitForAllowance(read, 500_000n, { attempts: 3, sleep: noSleep }),
    ).rejects.toThrow(/allowance/i);
  });
});
