# NadBounty testnet automation

Isolated Linux runners use the published SDK 0.10.0 and explicit Monad testnet deployments. Mainnet is refused. The reputation wallet has only the Safe-approved mirror reporting role; the keeper has no roles and calls permissionless settlements after on-chain deadlines. Each write uses exact estimation, rounded +50%, fixed gas price, bounded spending, receipts and state readback.

`npm ci --ignore-scripts`, `npm run typecheck`, `npm test`. Set the dedicated runtime variables from the workflow, then `npm run keeper -- --broadcast` and `npm run sync -- --broadcast`. Both are read-only by default. Keys stay in encrypted Actions secrets; neither the deployer nor any Safe owner key is uploaded. Actions permissions are read-only, PR runs receive no live credentials, and the scheduled live job runs only the reviewed default branch.

Reputation comes from finalized raw ERC-8004 feedback, explicit Base/Arc writers and current same-block identity ownership. All previous recipients are reconstructed from mirror events plus a Redis write-ahead journal and durable cursor. Revocations/transfers produce changed or zero records. Identical existing values skip the transaction: the on-chain source block remains the last delivered snapshot; each run separately records its newly verified source blocks. This is a trusted relayer, not a DON attestation. Discovery fails above 2000 board jobs and needs the indexer at scale.

Separate Redis leases serialize both runners across hosts. If a receipt is uncertain, the runner reports its hash and fails; a later scan checks chain state before retrying. A concurrent keeper may safely lose an already settled candidate. No new contests are opened, and adapter pause is preserved. Job 7 cannot be settled before 2026-10-10T10:12:35Z.

Workflow runs every 30 minutes and manually. Testnet-only secrets are prefixed NAD_AUTOMATION_; budget caps are 0.15 MON per transaction, 0.5 MON per reputation run and 1 MON per keeper run. Monitor the two dedicated balances; funding from the deployer is a separate local bounded operation and never part of the schedule.
