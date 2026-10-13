// Read-only smoke check of a running facade: discovery documents and every 402 challenge. Pays nothing.
// Usage: node test/probe.mjs [baseUrl]   (default https://nadbounty-facade.vercel.app)
const base = (process.argv[2] ?? "https://nadbounty-facade.vercel.app").replace(/\/+$/, "");
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
  console.log(`${condition ? "ok  " : "FAIL"} ${message}`);
};
const get = (path) => fetch(`${base}${path}`, { signal: AbortSignal.timeout(60000) });

for (const path of ["/health", "/v1", "/openapi.json", "/.well-known/x402.json", "/llms.txt"]) {
  const response = await get(path);
  check(response.status === 200, `${path} is free (200, got ${response.status})`);
  await response.text();
}

const json = async (path) => {
  try {
    return await (await get(path)).json();
  } catch {
    return {};
  }
};
const index = await json("/v1");
const openapi = await json("/openapi.json");
const manifest = await json("/.well-known/x402.json");
check(openapi.openapi === "3.1.0", "OpenAPI 3.1");
check((index.endpoints?.length ?? 0) >= 4, `index lists ${index.endpoints?.length ?? 0} paid endpoints`);
if (!index.endpoints || !manifest.endpoints) {
  console.error("\nDiscovery documents are missing; this is not the new facade.");
  process.exit(1);
}

for (const endpoint of index.endpoints) {
  const response = await fetch(endpoint.example.replace(index.baseUrl, base), { signal: AbortSignal.timeout(60000) });
  check(response.status === 402, `${endpoint.method} ${endpoint.path} answers 402 (got ${response.status})`);
  const header = response.headers.get("payment-required");
  await response.text();
  if (!header) {
    check(false, `${endpoint.path} carries a PAYMENT-REQUIRED header`);
    continue;
  }
  const required = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  const [accept] = required.accepts;
  check(required.x402Version === 2 && required.accepts.length === 1, `${endpoint.path} offers one x402 v2 option`);
  check(
    accept.scheme === "exact" && accept.network === index.payment.network,
    `${endpoint.path} uses exact on ${index.payment.network}`,
  );
  check(
    accept.amount === endpoint.price.amount,
    `${endpoint.path} charges ${endpoint.price.label} (${accept.amount} atomic)`,
  );
  check(accept.payTo.toLowerCase() === index.payment.payTo.toLowerCase(), `${endpoint.path} pays the treasury`);
  check(accept.asset.toLowerCase() === index.payment.asset.address.toLowerCase(), `${endpoint.path} charges in USDC`);
  const operation = openapi.paths[endpoint.path]?.get;
  check(operation?.["x-x402-price"] === endpoint.price.label, `${endpoint.path} OpenAPI price matches`);
  check(
    manifest.endpoints.some((e) => e.path === endpoint.path && e.price === endpoint.price.label),
    `${endpoint.path} manifest price matches`,
  );
}

for (const path of [
  "/v1/bounties/0",
  "/v1/reputation/abc",
  "/v1/workers/verified?minJobs=0",
  "/v1/contests/x/result",
]) {
  const response = await get(path);
  check(response.status === 400, `${path} is rejected before payment (400, got ${response.status})`);
  await response.text();
}
const head = await fetch(`${base}/v1/reputation/10388`, { method: "HEAD", signal: AbortSignal.timeout(60000) });
check(head.status === 405, `HEAD on a paid route is refused (405, got ${head.status})`);

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed; nothing was paid.");
