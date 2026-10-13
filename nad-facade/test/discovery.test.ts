import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { configuration } from "../src/config.js";
import { buildIndex, buildLlmsTxt, buildOpenApi, buildX402Manifest } from "../src/discovery.js";
import { PAID_ENDPOINTS, priceLabel, x402Routes } from "../src/endpoints.js";
import { VERSION } from "../src/constants.js";
import { ADAPTER, TREASURY, USDC, mainnetConfig } from "./helpers.js";

const config = mainnetConfig();
const URL_BASE = "https://nadbounty-facade.vercel.app";
const PRICES: Record<string, string> = {
  "/v1/bounties/{jobId}": "$0.001",
  "/v1/reputation/{agentId}": "$0.001",
  "/v1/workers/verified": "$0.005",
  "/v1/contests/{jobId}/result": "$0.001",
};

test("mainnet defaults to the real hosted URL", () => {
  assert.equal(config.publicUrl, URL_BASE);
  assert.equal(config.chainId, 143);
});

test("index: lists every paid endpoint with its real price, URL and an example", () => {
  const index = buildIndex(config);
  assert.equal(index.baseUrl, URL_BASE);
  assert.equal(index.network.caip2, "eip155:143");
  assert.equal(index.payment.payTo, TREASURY);
  assert.equal(index.payment.asset.address, USDC);
  assert.equal(index.endpoints.length, 4);
  for (const endpoint of index.endpoints) {
    assert.equal(endpoint.price.label, PRICES[endpoint.path], endpoint.path);
    assert.equal(endpoint.url, `${URL_BASE}${endpoint.path}`);
    assert.ok(endpoint.example.startsWith(URL_BASE), endpoint.example);
    assert.equal(endpoint.paid, true);
  }
  assert.deepEqual(
    index.endpoints.map((e) => e.price.amount),
    ["1000", "1000", "5000", "1000"],
  );
  assert.ok(index.free.some((entry) => entry.path === "/health"));
  assert.ok(index.free.some((entry) => entry.path === "/v1"));
});

test("index: reputation-sources is explicitly listed as unavailable on mainnet", () => {
  const index = buildIndex(config);
  const entry = index.notAvailable.find((e) => e.path === "/v1/reputation-sources");
  assert.equal(entry?.available, false);
  assert.match(entry?.reason ?? "", /Disabled on Monad mainnet/);
  const testnet = buildIndex(configuration({ NAD_X402_PAY_TO: TREASURY }));
  assert.equal(testnet.notAvailable.find((e) => e.path === "/v1/reputation-sources")?.available, true);
});

test("openapi: 3.1, real server URL, price and 402 on every paid operation", () => {
  const doc = buildOpenApi(config);
  assert.equal(doc.openapi, "3.1.0");
  assert.equal(doc.info.version, VERSION);
  assert.deepEqual(doc.servers, [{ url: URL_BASE }]);
  for (const [path, price] of Object.entries(PRICES)) {
    const operation = (doc.paths as any)[path]?.get;
    assert.ok(operation, path);
    assert.equal(operation["x-x402-price"], price);
    assert.equal(operation["x-payment-info"].price.amount, price.slice(1));
    assert.equal(operation["x-payment-info"].price.mode, "fixed");
    assert.ok(operation.responses["402"], path);
    assert.ok(operation.responses["200"].content["application/json"].schema, path);
    for (const parameter of operation.parameters) assert.ok(parameter.name && parameter.in && parameter.schema, path);
  }
  const workers = (doc.paths as any)["/v1/workers/verified"].get;
  assert.deepEqual(
    workers.parameters.map((p: any) => p.name),
    ["minJobs", "minAvgScore"],
  );
  assert.equal(workers.parameters[0].schema.minimum, 1);
  assert.equal(workers.parameters[1].schema.maximum, 100);
  assert.ok((doc.paths as any)["/health"]);
  assert.equal((doc.paths as any)["/v1/reputation-sources"], undefined);
  assert.equal(doc["x-x402"].payTo, TREASURY);
  assert.equal(doc["x-not-available"][0].path, "/v1/reputation-sources");
});

test("x402 manifest: same shape as the Arc facade, with the real prices", () => {
  const manifest = buildX402Manifest(config);
  assert.equal(manifest.x402Version, 2);
  assert.equal(manifest.network, "eip155:143");
  assert.equal(manifest.openapi, `${URL_BASE}/openapi.json`);
  assert.deepEqual(
    manifest.endpoints.map((e) => [e.method, e.path, e.price]),
    Object.entries(PRICES).map(([path, price]) => ["GET", path, price]),
  );
  assert.equal(manifest.payTo, TREASURY);
  assert.equal(manifest.asset, USDC);
});

test("llms.txt: names the URL, every endpoint with its price and how payment works", () => {
  const text = buildLlmsTxt(config);
  assert.ok(text.includes(URL_BASE));
  for (const [path, price] of Object.entries(PRICES)) assert.ok(text.includes(`GET ${path} (${price} USDC)`), path);
  assert.match(text, /HTTP 402/);
  assert.match(text, /PAYMENT-REQUIRED/);
  assert.match(text, /never charged/);
  assert.match(text, /reputation-sources/);
  assert.ok(text.length < 4000);
});

test("the payment layer, discovery and docs share one price table", () => {
  const routes = x402Routes(config) as Record<string, any>;
  assert.equal(Object.keys(routes).length, PAID_ENDPOINTS.length);
  for (const endpoint of PAID_ENDPOINTS) {
    const route = routes[endpoint.x402Pattern];
    assert.ok(route, endpoint.x402Pattern);
    assert.equal(route.accepts.price.amount, endpoint.priceAtomic.toString());
    assert.equal(route.accepts.price.asset, USDC);
    assert.equal(route.accepts.payTo, TREASURY);
    assert.equal(route.accepts.network, "eip155:143");
    assert.equal(route.accepts.scheme, "exact");
    assert.deepEqual(route.accepts.price.extra, { name: "USDC", version: "2" });
    assert.equal(priceLabel(endpoint.priceAtomic), PRICES[endpoint.templatePath]);
  }
  // Exact routes only: no wildcard that could ask for payment on a path the app does not serve.
  assert.ok(Object.keys(routes).every((key) => !key.includes("*")));
});

test("no document contains an em dash or an en dash", () => {
  const all =
    JSON.stringify([buildIndex(config), buildOpenApi(config), buildX402Manifest(config)]) + buildLlmsTxt(config);
  const forbidden = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`); // en dash, em dash
  assert.doesNotMatch(all, forbidden);
});

test("the version constant matches package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.version, VERSION);
  assert.equal(ADAPTER.length, 42);
});
