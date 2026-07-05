# Circle developer-controlled wallets — reference

This is the detailed reference for `CircleSigner` (`src/signers/circleSigner.ts`).
For a quick-start, see the README section ["Circle developer-controlled
wallets"](../README.md#circle-developer-controlled-wallets-no-raw-private-key) —
this doc covers what the quick-start doesn't: entity secret handling, wallet
sets, fee levels, troubleshooting, and the security model.

## One-time setup

1. **Circle Console → API Keys → create a Standard API Key.** Use a Testnet
   key for Arc Testnet work; Production keys are a separate credential and
   only relevant once ArcBounty targets Arc mainnet.
2. **Generate and register an entity secret.**
   ```ts
   import {
     generateEntitySecret,
     registerEntitySecretCiphertext,
   } from "@circle-fin/developer-controlled-wallets";

   generateEntitySecret();
   // prints a 32-byte hex secret to stdout — copy it immediately, it is not
   // retrievable from Circle afterward.

   await registerEntitySecretCiphertext({ apiKey, entitySecret });
   // Circle returns a recovery file (recoveryFile.dat or similar) — store it
   // somewhere durable and offline. You need it if you ever lose the secret
   // and must recover wallets under this API key.
   ```
3. **Create a wallet set, then a wallet on `ARC-TESTNET`:**
   ```ts
   import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

   const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
   const { data: { walletSet } } = await client.createWalletSet({ name: "arcbounty-agents" });
   const { data: { wallets } } = await client.createWallets({
     walletSetId: walletSet.id,
     blockchains: ["ARC-TESTNET"],
     accountType: "EOA", // or "SCA" for smart-contract account UX
     count: 1,
   });
   ```
4. **Fetch and store the on-chain address once** — `CircleSigner` takes it as
   a constructor field (`address`) rather than re-resolving it on every
   startup, to save a round-trip:
   ```ts
   const { data: { wallet } } = await client.getWallet({ id: wallets[0].id });
   console.log(wallet.address); // save this — CIRCLE_WALLET_ADDRESS
   ```
5. **Fund the wallet** with testnet USDC (Arc's native gas token) before
   calling any write method — see the main repo README for the faucet link.

Env vars used by `examples/demo-agent-circle.ts` and any script using
`circleWallet`:

| Var | What |
|---|---|
| `CIRCLE_API_KEY` | Standard API key from Circle Console |
| `ENTITY_SECRET` | The 32-byte hex secret from step 2 |
| `CIRCLE_WALLET_ID` | Wallet ID (not address) from `createWallets`/`listWallets` |
| `CIRCLE_WALLET_ADDRESS` | On-chain address, fetched once in step 4 |

## EOA vs SCA wallets, and transaction hash timing

`CircleSigner.writeContract` calls `getTransaction({ id, waitForTxHash: true })`
and polls until a `txHash` exists or the transaction reaches a terminal
failure state (`CANCELLED` / `DENIED` / `FAILED` / `STUCK`). The timing differs
by wallet type:

- **EOA wallets** get a `txHash` as soon as the transaction is broadcast
  (`SENT` state) — fastest to observe.
- **SCA (smart-contract account) wallets** only get a `txHash` once the
  transaction is `CONFIRMED` on-chain, because the hash is only known after
  the user-operation bundles. Expect a longer wait before `writeContract`
  resolves.

Pick `EOA` for agent scripts where you want the fastest possible feedback
loop; pick `SCA` if you want gas sponsorship / batched calls later (Circle's
Gas Station — see `GRANT_APPLICATION.md` milestone 3, not yet wired into this
SDK).

## Fee level

`CircleSigner` hardcodes `fee: { type: "level", config: { feeLevel: "MEDIUM" } }`
(see `circleSigner.ts`). On Arc Testnet with negligible USDC gas, this doesn't
matter in practice. If Circle ever supports a lower/explicit fee config for
Arc and you want to tune it, that's the one place to change.

## Security model — read this before production use

**The entity secret is the single most powerful credential in this whole
system.** It controls *every* wallet created under the associated API key —
not just one agent's wallet. Compromise of `ENTITY_SECRET` is equivalent to
compromising every Circle-custodied agent wallet you've ever created with
that key, simultaneously. Concretely:

- Never put `ENTITY_SECRET` in the same `.env` file you hand to a task-runner
  LLM, a CI job with broad log retention, or anything that isn't the signing
  process itself.
- Prefer a secrets manager (Vercel encrypted env vars, AWS Secrets Manager,
  1Password CLI, etc.) over a plaintext `.env` file the moment this leaves
  local development — this is flagged as an open item in the project's own
  [`SECURITY_INCIDENT.md`](../../SECURITY_INCIDENT.md) postmortem.
- If you suspect compromise: rotate the entity secret immediately
  (`registerEntitySecretCiphertext` again invalidates the old one), and treat
  every wallet under that API key as compromised until you've confirmed
  balances and re-secured them.
- One API key + entity secret per deployment environment (dev / staging /
  prod), not shared. A leak in a demo script shouldn't threaten a production
  agent fleet.

## Troubleshooting

- **`createContractExecutionTransaction did not return a transaction id`** —
  usually an insufficient-gas-token balance on the wallet, or a malformed
  `callData`. Check the wallet's USDC balance first.
- **Transaction stuck in `STUCK`** — Circle's own dashboard (Console → Wallets
  → transaction history) shows the underlying chain error; this SDK only
  surfaces the terminal state, not the reason.
- **`isRegistered` / registry reverts** — unrelated to Circle; see
  `contracts/DEPLOYMENTS.md` for the live-registry incompatibilities V3.1/V3.2
  already work around.
