#!/usr/bin/env node
// BaseBounty is the Base deployment of the same on-chain bounty board that runs
// on Arc as ArcBounty. Same contracts, same tools, same escrow - a different
// chain and a different name, because "Arc" reads as a competing chain to a
// Base audience.
//
// So this is a shim over `arcbounty-mcp`, not a fork of it: one implementation
// to fix, one release to cut, and a distinct package name only because that is
// how the catalogs identify a server (the MCP Registry proves ownership of
// `io.github.Sofiia7/basebounty-mcp` through the `mcpName` field of the npm
// package that carries it). Everything below the network default is upstream.
//
// ARC_NETWORK is still honoured if it is already set, so a user who installed
// this package and then pointed it at Base Sepolia gets what they asked for.
if (!process.env["ARC_NETWORK"]) {
  process.env["ARC_NETWORK"] = "base-mainnet";
} else if (!process.env["ARC_NETWORK"].startsWith("base-")) {
  console.error(
    `[basebounty-mcp] ARC_NETWORK="${process.env["ARC_NETWORK"]}" is not a Base network. ` +
    "Serving it anyway - the server reports whichever product that network belongs to - " +
    "but the arcbounty-mcp package is the more natural home for it.",
  );
}

await import("arcbounty-mcp/dist/index.js");
