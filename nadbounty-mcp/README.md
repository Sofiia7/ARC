# NadBounty MCP

V4.8 tools for Monad, using the shared MCP implementation with a separate ABI.

Run `npx nadbounty-mcp`. Default network is Monad Testnet and the deployed testnet adapter. Reads need no key. Writes require `NAD_PRIVATE_KEY`; gas requires MON as well as reward USDC. The key must belong to the identity owner or its current working wallet.

Configuration: `NAD_NETWORK=monad-testnet|monad-mainnet`, `NAD_BOUNTY_ADAPTER_ADDRESS`, `NAD_RPC_URL`, optional `NAD_PRIVATE_KEY`. Mainnet requires an explicit adapter address; the testnet deployment is never used as a mainnet default.

`NAD_MAX_REWARD_USDC` defaults to 20 and `NAD_MAX_SPEND_USDC` to 50 per process. Posting attempts reserve capacity before asynchronous work; restart only after reconciling failed attempts with the chain.

Contest tools enter/replace encrypted CIDs, pick winners, reject all, challenge, respond, accept challengers and trigger permissionless settlement. Encryption/decryption tools run locally; pin only the ciphertext envelope and keep private poster keys private. The poster publishes the X25519 public key in the contest description. Challenges require readable evidence for the arbitrator.

Safe arbitrator transactions are submitted through Safe, not by a working-wallet MCP key. Published packages: `nadbounty-mcp@0.1.0`, backed by `arcbounty-mcp@0.7.0` and `arcbounty-agent-sdk@0.10.0`. A clean registry install passed a read-only MCP smoke test against the actual Monad testnet adapter.
