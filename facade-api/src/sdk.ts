import { createRequire } from "node:module";

/**
 * Loads the SDK through its CJS entry on purpose. The ESM build
 * (dist/index.mjs) does a named import from `@circle-fin/developer-controlled-wallets`
 * (a CJS package) that Node's cjs-module-lexer can't statically see — on a
 * real Node ESM runtime (Vercel) that's a SyntaxError at import time. The CJS
 * build require()s the same package and is immune. Local tsx masked this by
 * doing its own interop. Proper fix tracked for arcbounty-agent-sdk 0.4.4;
 * this shim can be deleted once the facade depends on it.
 */
const require = createRequire(import.meta.url);
const sdk = require("arcbounty-agent-sdk") as typeof import("arcbounty-agent-sdk");

export const {
  BOUNTY_ADAPTER_ABI,
  ERC20_ABI,
  CONTRACTS,
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_RPC,
  parseUsdc,
  bondCreateDeadlineOk,
} = sdk;
