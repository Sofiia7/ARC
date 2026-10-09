# NadBounty x402 facade

Independent read-only instance for Monad. Requires no wallet key. Uses the Monad Foundation facilitator and x402 v2 exact EIP-3009 USDC payments, pinned @x402 packages 2.28.0. This preserves the existing Arc/Base Circle Gateway service.

Run `npm ci`, `npm run typecheck`, `npm test`, then set the variables in `.env.example` in the process environment and run `npm start`. Binds to loopback; put a TLS reverse proxy in front for hosting. `/health` is free; `GET /v1/bounties/7` costs 0.001 USDC. Basic reads remain freely available through the website JSON API and SDK. The paid endpoint returns a single-block bounty/entry snapshot, never decrypted contents or signing keys. Bad IDs, nonexistent bounties and RPC failures are rejected before payment. No cross-request caching of paid responses.

Mainnet has no default adapter and refuses startup until its actual paused deployment address is configured. Startup verifies RPC chain, adapter USDC and facilitator support. Live settlement/hosting must be verified separately before advertising availability.

Reference: https://docs.monad.xyz/guides/x402
