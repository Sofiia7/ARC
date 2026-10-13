#!/usr/bin/env node
// NadBounty is the Monad port of the same on-chain bounty board that runs on Arc and Base. This package is a launcher
// over `arcbounty-mcp`, not a fork: one implementation to fix and one release to cut, under a package name of its own
// because that is how the catalogs identify a server (the MCP Registry proves ownership of
// `io.github.Sofiia7/nadbounty-mcp` through the `mcpName` field of the npm package that carries it).
//
// The server reports a version at `initialize` and registries show it. It must be this package's version, not
// arcbounty-mcp's, so it is handed over here before the server starts.
import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("../package.json");
process.env["NAD_MCP_VERSION"] = pkg.version;

await import("arcbounty-mcp/nad-cli");
