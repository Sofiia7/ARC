import { test } from "node:test";
import assert from "node:assert/strict";
import { TokenBucketLimiter, clientKey, expandIpv6, normalizeAddress } from "../src/rateLimit.js";

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

test("bucket: a full burst is allowed, the next request is refused with Retry-After", () => {
  const time = clock();
  const limiter = new TokenBucketLimiter({ capacity: 60, refillPerSecond: 1, now: time.now });
  for (let i = 0; i < 60; i++) assert.equal(limiter.take("a").allowed, true, `request ${i}`);
  const refused = limiter.take("a");
  assert.equal(refused.allowed, false);
  assert.equal(refused.allowed === false && refused.retryAfterSeconds, 1);
});

test("bucket: tokens refill at the sustained rate and never above capacity", () => {
  const time = clock();
  const limiter = new TokenBucketLimiter({ capacity: 5, refillPerSecond: 1, now: time.now });
  for (let i = 0; i < 5; i++) limiter.take("a");
  assert.equal(limiter.take("a").allowed, false);
  time.advance(2000);
  assert.equal(limiter.take("a").allowed, true);
  assert.equal(limiter.take("a").allowed, true);
  assert.equal(limiter.take("a").allowed, false);
  time.advance(10 * 60_000);
  for (let i = 0; i < 5; i++) assert.equal(limiter.take("a").allowed, true);
  assert.equal(limiter.take("a").allowed, false);
});

test("bucket: retry-after reflects how long until one token is available", () => {
  const time = clock();
  const limiter = new TokenBucketLimiter({ capacity: 2, refillPerSecond: 0.5, now: time.now });
  limiter.take("a");
  limiter.take("a");
  const refused = limiter.take("a");
  assert.equal(refused.allowed === false && refused.retryAfterSeconds, 2);
});

test("bucket: clients are independent", () => {
  const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 0.1, now: clock().now });
  assert.equal(limiter.take("a").allowed, true);
  assert.equal(limiter.take("a").allowed, false);
  assert.equal(limiter.take("b").allowed, true);
});

test("bucket: memory is bounded and the oldest clients are dropped", () => {
  const time = clock();
  const limiter = new TokenBucketLimiter({ capacity: 3, refillPerSecond: 1, maxKeys: 100, now: time.now });
  for (let i = 0; i < 1000; i++) limiter.take(`ip-${i}`);
  assert.ok(limiter.size <= 100, `size ${limiter.size}`);
  // A dropped client simply starts with a fresh bucket; a recently seen one keeps its state.
  for (let i = 0; i < 3; i++) limiter.take("fresh");
  assert.equal(limiter.take("fresh").allowed, false);
});

test("bucket: rejects nonsense configuration", () => {
  assert.throws(() => new TokenBucketLimiter({ capacity: 0, refillPerSecond: 1 }));
  assert.throws(() => new TokenBucketLimiter({ capacity: 5, refillPerSecond: 0 }));
});

test("client key: first X-Forwarded-For hop wins, then X-Real-IP, then the socket", () => {
  assert.equal(clientKey({ "x-forwarded-for": "203.0.113.7, 10.0.0.1, 10.0.0.2" }, "10.9.9.9"), "203.0.113.7");
  assert.equal(
    clientKey({ "x-forwarded-for": ["198.51.100.4, 10.0.0.1"] as unknown as string }, "10.9.9.9"),
    "198.51.100.4",
  );
  assert.equal(clientKey({ "x-real-ip": "198.51.100.9" }, "10.9.9.9"), "198.51.100.9");
  assert.equal(clientKey({}, "10.9.9.9"), "10.9.9.9");
  assert.equal(clientKey({}, undefined), "unknown");
});

test("client key: garbage headers fall through instead of becoming bucket keys", () => {
  assert.equal(clientKey({ "x-forwarded-for": "not-an-ip, 1.2.3.4" }, "10.9.9.9"), "10.9.9.9");
  assert.equal(clientKey({ "x-forwarded-for": "x".repeat(500) }, "10.9.9.9"), "10.9.9.9");
  assert.equal(clientKey({ "x-forwarded-for": "" }, "10.9.9.9"), "10.9.9.9");
});

test("client key: IPv6 clients share a bucket per /64 and mapped IPv4 collapses to IPv4", () => {
  const a = clientKey({ "x-forwarded-for": "2001:db8:1:2:aaaa:bbbb:cccc:dddd" });
  const b = clientKey({ "x-forwarded-for": "2001:db8:1:2:1::1" });
  const c = clientKey({ "x-forwarded-for": "2001:db8:1:3::1" });
  assert.equal(a, "v6:2001:db8:1:2");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(clientKey({ "x-forwarded-for": "::ffff:203.0.113.7" }), "203.0.113.7");
  assert.equal(normalizeAddress("::1"), "v6:0:0:0:0");
  assert.equal(normalizeAddress("fe80::1%eth0"), "v6:fe80:0:0:0");
  assert.equal(normalizeAddress("1.2.3.4"), "1.2.3.4");
  assert.equal(normalizeAddress("1.2.3"), undefined);
});

test("ipv6 expansion handles :: in every position and embedded IPv4", () => {
  assert.deepEqual(expandIpv6("::"), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(expandIpv6("1::"), [1, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(expandIpv6("::2"), [0, 0, 0, 0, 0, 0, 0, 2]);
  assert.deepEqual(expandIpv6("1:2:3:4:5:6:7:8"), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(expandIpv6("1:2:3:4:5:6:7::"), [1, 2, 3, 4, 5, 6, 7, 0]);
  assert.deepEqual(expandIpv6("::ffff:1.2.3.4"), [0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
  assert.equal(expandIpv6("1.2.3.4"), undefined);
  assert.equal(expandIpv6("1::2::3"), undefined);
});
