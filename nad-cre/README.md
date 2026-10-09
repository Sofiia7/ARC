# NadBounty CRE integration — in progress

The `keeper` staging workflow reads explicit job candidates, receiver wiring and real V4.8 state through CRE EVM capabilities. It shares the SDK's deadline planner and checks individual contest challenges plus recovered escrow status. Reports are disabled until reporter authority and Monad gas budgeting are verified; it cannot broadcast even if the config flag is changed. Candidate discovery above 100 jobs requires indexed pagination.

Install dependencies in `reputation-sync`, then run `cre workflow simulate keeper --target staging-settings --trigger-index 0 --non-interactive` from this project. On 2026-10-08, CRE CLI 1.37.0 and Bun 1.4.2 successfully compiled the workflow to WASM and ran its cron trigger against actual Monad testnet. Job 7 was not yet mature, so the workflow correctly returned zero eligible actions with reports disabled. This verifies live reads and execution, not report broadcasting or positive settlement execution. Staging uses the account's available private deployment registry; only `main` is exported, since Javy rejects exported functions with arguments.

Verified WASM binary hash: `4f87f0b8bd10116124bb7335b81b45cd607c6e2c32c6bbbcc6bfe2c7910d337b`; config hash: `ee83c67d362c71c773413feb7292fc469831fd1110ef4abd83dc9eb1a326cdae`. The generated Hello World template was removed: it is not evidence of an integration.

Exact Base/Arc source reading is now implemented and live-verified by `scripts/nad-reputation-snapshot.ts`; see the source proof in `docs/superpowers/plans/2026-10-08-nadbounty-reputation-source-proof.md`. Remaining: durable recipient discovery, reputation workflow (cron plus HTTP trigger), Base keeper branch and receiver, positive-action/report simulation with gas budgeting, and Safe-authorized relayer configuration. The direct permissionless keeper remains the production design; its Nad hosted activation is still pending. Chainlink DON deployment is separate and commercial.

## Verified reputation workflow

On 2026-10-09 both cron and HTTP trigger simulations compiled to actual WASM and completed with default CRE production limits. Binary hash: c72f7f9a1eca1049114e1ab49913e2295601bd4d83c05d351b079fb240ae9119. Both produced identical five-record reports from Base52376037 / Arc25058436. Base reads are batched through Multicall3 (https://github.com/mds1/multicall3/blob/main/src/Multicall3.sol), preserving a pinned finalized block and verifying registry wiring, candidate identities, owners and raw feedback. Monad checks Safe ownership and approved reporter. Arc evidence is trusted HTTP input.

Run from this directory after installing reputation-sync dependencies:

```sh
cre workflow simulate reputation --target staging-settings --trigger-index 0 --non-interactive
cre workflow simulate reputation --target staging-settings --trigger-index 1 --http-payload '{}' --non-interactive
```

These are local simulations, not proof of signed gateway authentication or multi-node DON consensus. Report broadcasting is deliberately disabled. Direct permissionless keeper and exact trusted mirror delivery are active through the separate nad-automation GitHub schedule. Receiver reporting, native Arc attestation, Base keeper and commercial DON deployment remain separate work.
