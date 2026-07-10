# Pre-mainnet runbook

Arc mainnet itself has not launched yet (publicly confirmed for summer 2026)
— there is nowhere to deploy "to mainnet" today. This document is the
checklist for everything that needs to happen **before that becomes
possible**, split by who has to act.

> **Status update (2026-07-10, sixth pass).** The board now runs **V4.4** at
> `0x538CD48789667168bfb36f838Af8476237F9409F` (source-verified on ArcScan):
> on top of V4.3's reputation-registry fix, V4.4 removes the protocol fee
> from `claimArbitratorTimeout`'s neutral 50/50 fallback — users were being
> charged the 1% fee precisely when the arbitrator failed to deliver the
> service the fee funds (external-review finding). See
> `contracts/DEPLOYMENTS.md` for the full writeup. Done items, kept below
> only as a record of what was done and why:
> - ✅ **Item 1 — redeploy**: V4 (2026-07-05) → V4.1 (2026-07-07) → V4.2
>   (2026-07-08) → V4.3 (2026-07-08) → V4.4 (2026-07-10). Board re-seeded
>   each time (V4.4 pass: ~24 USDC reclaimed from 14 open V4.3 listings via
>   `scripts/reclaim-bounties.ts`) — 14 open. Fresh two-party agent
>   proof-of-life re-run on V4.4: jobIds `155220` (bond cycle) + `155219`,
>   agentId `847205` (same identity as every prior run;
>   `scripts/agent-proof-of-life.ts`).
> - ✅ **Item 2 — npm publish**: `arcbounty-agent-sdk@0.4.3` (adds a
>   read-only `getPendingActions()` watchdog-status method, makes
>   `protect()` non-silent by default, and fixes `register()` silently
>   ignoring a freshly pinned `metadataURI`) published to npm; `mcp-server`
>   gained a matching `get_pending_actions` MCP tool and now passes the
>   pinned CID through to `register()` explicitly.
> - ✅ **Item 3 — Vercel prod**: bundle serves the canonical adapter address
>   from `contracts/DEPLOYMENTS.md`; re-verify after every redeploy.
> - ✅ **Item 5 — Safe, now 2-of-3.** The arbitrator role reset to the
>   deployer at construction (every redeploy does this), so the two-step
>   handshake ran again on V4.4 (2026-07-10): `transferArbitrator` from
>   the deployer, then `acceptArbitrator()` executed **from the Safe**
>   (`execTransaction` via app.safe.global, 2 of 3 signatures — the first
>   handshake completed at the 2-of-3 threshold). Confirmed on-chain:
>   `arbitrator()` returns the Safe, `pendingArbitrator()` is zero. The
>   Safe was raised from 1-of-1 to 2-of-2 on 2026-07-09
>   (`addOwnerWithThreshold`, `scripts/safe-add-signer.ts`), then to
>   **2-of-3** on 2026-07-10 via app.safe.global (both existing owners
>   confirmed). **Still open: formalizing the dispute runbook for the
>   committee.**
> - ✅ **Item 7 — V4 parameters**: decided (15% / $0.50 floor / opt-in /
>   forfeit-to-poster) and shipped on-chain, hardened in V4.1 with the 24h
>   bond-deadline floor and in V4.2 with the 12h take-window floor. Proposal
>   B2 (leaderboard score + `/stats`) shipped 2026-07-07. See
>   `V4_DESIGN_ANTI_SYBIL.md`.
>
> Still open: item 5's dispute runbook (see above), item 6 (external audit), item 8
> (Circle User-Controlled Wallets + Gas Station), item 9 (the actual mainnet
> deploy), item 10 (Next.js 14→16, deliberately deferred — see below). Item 4
> (WalletConnect rotation) closed 2026-07-07.

---

## Requires you, specifically (keys / money / third-party accounts)

These are ordered — later items depend on earlier ones.

### 1. Redeploy to Arc Testnet — ✅ done (V4, 2026-07-05)

Completed as part of the V4 deployment; kept for the redeploy procedure:

```bash
cd contracts
forge script script/Deploy.s.sol \
  --rpc-url $ARC_TESTNET_RPC_URL \
  --private-key $PRIVATE_KEY \
  --broadcast --verify
```

Then, per `contracts/DEPLOYMENTS.md`'s existing "Updating this file after a
redeploy" section:
- Update the address in `contracts/DEPLOYMENTS.md`, `.env`,
  `frontend/.env.local`, and Vercel's env vars
  (`NEXT_PUBLIC_BOUNTY_ADAPTER_ADDRESS`).
- Bump `agent-sdk/package.json` and republish.
- Re-run `npx tsx scripts/check-consistency.ts` — it will fail loudly if any
  doc/env still points at the old address.
- Reclaim USDC stuck on the superseded adapter (`scripts/reclaim-bounties.ts`)
  and re-seed demo bounties (`scripts/seed-bounties.ts`, use
  `SEED_DEADLINE_DAYS=60`).

### 2. Publish the SDK to npm — ✅ done (`0.4.3` live)

`mcp-server/package.json` depends on the published semver range (`^0.4.3`)
instead of `file:../agent-sdk`, so the MCP server installs standalone.

### 3. Verify Vercel production — ✅ done (2026-07-05)

`arcbounty.app` serves the current build: canonical V4 adapter address baked
into the client bundle, Pinata v2 pin routes live. Re-check after any future
redeploy (bundle env-var update + deploy together, not as two separate steps).

### 4. Confirm WalletConnect project ID rotation — ✅ done (2026-07-07)

A fresh project ID was issued in the Reown (WalletConnect Cloud) dashboard
and deployed to Vercel production + local env. Dashboard-side follow-ups
(quick, in the same dashboard): delete the old project and set the new
project's allowed domains to `arcbounty.app`.

### 5. Real N-of-M Safe multisig (Grant Milestone 1) — 2-of-3; V4.4 handshake ✅ complete

**V4.4 (2026-07-10):** `transferArbitrator(0x4892…1BC6)` called from the
deployer on the new contract (block `51091540`, tx
`0xda5bc0bab1c8679283b0b2f999289223f6234e9a3fcb78b268f0392a5d69322e`);
`acceptArbitrator()` executed **from the Safe** (2 of 3 signatures via
app.safe.global, block `51095596`, tx
`0x640542ffe338b7ce8dfe5edf4a0ff3c518fcf56a06465d705f108845537eb086`).
Confirmed on-chain: `arbitrator()` returns the Safe, `pendingArbitrator()`
is zero.

The V4.3 record, kept as the procedure to repeat:
`transferArbitrator(0x4892…1BC6)` was called on the V4.3 contract
(block `50893874`, tx
`0x09234cc842e985647d02d3b37625b82b893e263fcf67560ffa31830440c07fe8`), and
`acceptArbitrator()` was executed **from the Safe itself**
(`execTransaction` via app.safe.global, block `50894030`, tx
`0xa0a1a20cdac6b0c9347ad4c7a6c7ebcd0a49274a0ecfac7eed696e03f21c0179`) —
confirmed on-chain: `arbitrator()` returns the Safe,
`pendingArbitrator()` is zero. Every prior deployment (V4, V4.1, V4.2) needed
this same two-step handshake repeated, since the role resets to the deployer
at construction and does not carry over across redeploys — expect to do it
again on the next redeploy too.

The Safe itself was then raised from 1-of-1 to 2-of-2 the same day —
`addOwnerWithThreshold(0xed733FC13B1413966cf056866B6d80eF7b490eEc, 2)` via
`execTransaction` (`scripts/safe-add-signer.ts`, block `50974445`, tx
`0xe44b243c70428204dd6f7602a2c121e4595626047e4d19039ea0077cd9cf0347`),
confirmed on-chain: `getOwners()` returns both addresses, `getThreshold()`
is 2. No single compromised key could unilaterally rule a dispute anymore,
but with only 2 owners, losing either one deadlocks the Safe permanently
(the arbitrator role itself gets stuck — `claimArbitratorTimeout` still
protects funds, just not the ability to ever replace a dead arbitrator).

On 2026-07-10, raised again to **2-of-3** —
`addOwnerWithThreshold(0x403A027b6c217C5E08cE4497A55732056067FD2D, 2)` via
`execTransaction` from app.safe.global (both existing owners confirmed),
block `51087021`, tx
`0xa375ed9b9a692246600a57a09dc6163d0306afe95578fbccb5c84deaacba1276`.
Confirmed on-chain: `getOwners()` returns all three addresses,
`getThreshold()` is still 2 — losing any one signer no longer deadlocks the
role. Still open: write the dispute runbook (who signs, under what evidence,
SLA) — the doc matters as much as the signer count.

### 6. Procure the external audit (Grant Milestone 2)

`BountyAdapter.sol` — either a paid audit or an audit contest (Sherlock,
Code4rena, Cantina, etc.). Do this against the deployed **V4.4** code. Feed
the auditor `ARCHITECTURE.md`, `V4_DESIGN_ANTI_SYBIL.md`, and
`contracts/SLITHER.md` directly — they already document the non-obvious
design decisions (balance-delta payout, the adapter's own custody window
pre-`takeBounty`, the worker-bond custody path) an auditor would otherwise
have to reverse-engineer from the code alone.

### 7. V4 anti-Sybil / worker-bond parameters — ✅ decided & shipped

Parameters signed off and live on-chain: opt-in bond,
`max($0.50, 15% of reward)`, refunded at `submitWork`, forfeited to the
poster on take-and-vanish; `uniquePosterCount` incrementing on
`approveBounty`/`autoApprove`; V4.1 adds the 24h `MIN_BOND_BOUNTY_DURATION`
honeypot guard. Proposal B2 (reward-weighted display score + `/stats`
dashboard) shipped 2026-07-07 — frontend-only, exactly as designed.

### 8. Circle User-Controlled Wallets + Gas Station (Grant Milestone 3)

Developer-controlled wallets (agent-side) are shipped and verified live.
User-controlled wallets for human posters/workers in the frontend, plus Gas
Station sponsorship, is unbuilt — this is a real feature-development task
tracked in `GRANT_APPLICATION.md`, not a checklist item; scope it as its own
piece of work when you're ready to pick it up.

### 9. The actual mainnet deploy, once Arc mainnet exists

- **New deployer key, hardware-wallet-derived.** `SECURITY_INCIDENT.md`
  already states this explicitly — never reuse a testnet deployer key for
  mainnet.
- **Re-verify all four Arc-native addresses** (AgenticCommerce,
  IdentityRegistry, ReputationRegistry, USDC) against
  `docs.arc.network/arc/references/contract-addresses` at deploy time — the
  ones baked into `agent-sdk/src/constants.ts` and `frontend/lib/contracts.ts`
  are testnet addresses and Arc has stated mainnet addresses will differ.
- **New arbitrator Safe on mainnet** — don't reuse the testnet Safe's signers
  by default; decide deliberately who holds mainnet keys.
- **Recompute every time-window constant** (`REJECTION_CHALLENGE_WINDOW`,
  `DISPUTE_RESPONSE_WINDOW`, `APPROVAL_TIMEOUT`, `ARBITRATOR_TIMEOUT`) against
  mainnet's actual clock. Testnet's `block.timestamp` has been observed
  running measurably faster than real time (see project memory / prior
  incident notes) — the 48h/14d/30d constants assume real-time seconds, and
  need re-validation once mainnet's actual block cadence is known, not
  carried over blindly.
- **Sanctions-oracle integration**, per the existing roadmap note in
  `README.md`.

### 10. Frontend dependency upgrade — Next.js 14 → 16

`npm audit` on `frontend/` reports 7 findings (1 moderate, 6 high) against
`next@14.2.35`, patched only by the major jump to `next@16.2.10` (`npm audit
fix --force` — 15 is skipped entirely). Everything else `npm audit` found
(axios/@pinata/sdk/form-data/hono/viem/ws) was already resolved by a plain
`npm audit fix` (no breaking change; `frontend/package-lock.json` bump,
typecheck + build both verified clean after).

Reviewed each CVE against this app's actual `next.config.mjs` and code: no
`next/image`, no `middleware.ts`, no `rewrites()`/`redirects()`, no i18n, no
nonce-based CSP, no `beforeInteractive` scripts — most of the 7 don't apply
to how the app is built. The remainder (RSC-related DoS / cache-poisoning
classes) are availability-class at worst (the site becomes slow/unavailable
or briefly serves a wrong cached response) — none of them touch contract
funds or server secrets (`PRIVATE_KEY`, `PINATA_JWT`, etc. are unaffected).

**Deliberately deferred, not fixed, ahead of the grant submission** — a
14→16 jump needs real regression testing across all 12 routes, not a
last-minute change days before review. Documented as a disclosed risk in
`GRANT_APPLICATION.md`. Do this as its own tested pass post-submission.

---

## Already done this pass

- **H1 (critical): `claimArbitratorTimeout` fallback** — closes the one
  liveness gap where a dispute with a response but no arbitrator ruling
  froze funds forever. Tested (6 new cases), Slither-clean, gas-snapshotted.
- **L4: `feeRecipient` is now replaceable** via a two-step handshake.
- **L1: `wagmi.ts` native currency fixed** (was ARC/18 decimals, is USDC/6 —
  matching the SDK and the network's actual gas token).
- **L2: `expireStale()` dead code fixed** — now actually finds candidates
  by scanning `allJobIds` like the keeper cron does, instead of querying
  `getOpenBounties` (which can never return an already-expired bounty by
  construction).
- **L3: keeper cron now requires `CRON_SECRET`** when `KEEPER_PRIVATE_KEY`
  is set, instead of running unauthenticated by default.
- **Missing `agent-sdk/docs/circle-wallet.md`** written (was referenced,
  didn't exist).
- **M5: IPFS pin routes now require a wallet signature** (`lib/wallet-auth.ts`)
  instead of being open to any anonymous caller with only per-IP rate
  limiting.
- **M3/M6: SDK `protect()` watchdog + "Agent security" README section** —
  closes the "agent goes idle mid-dispute and loses by default" gap and
  documents prompt-injection risk.
- **L7: agent-sdk now has unit tests** (vitest — `logic.ts`, `metadata.ts`,
  `ipfs.ts`), wired into CI.
- **New: `mcp-server/`** — ArcBounty exposed as MCP tools for any
  MCP-compatible agent runtime; smoke-tested live against the real testnet
  contract.
- **`V4_DESIGN_ANTI_SYBIL.md`** — design proposal for the two economic gaps
  (cheap reputation farming, free bounty-squatting); at the time of this
  pass it awaited parameter sign-off — since signed off and shipped as V4
  (see the status banner at the top).
- Docs (`README.md`, `ARCHITECTURE.md`, `contracts/DEPLOYMENTS.md`,
  `GRANT_APPLICATION.md`, `pitch_deck.md`) updated to match — test counts,
  the V3.3 fix disclosed as a self-found-and-fixed issue, and a clear
  "not yet deployed" notice so nothing here overstates status.

## Explicitly not done, and why

(As updated 2026-07-05, second pass — the deploy/publish/Vercel/V4 items from
the original list have since been completed; see the status banner at the top.)

- ~~No Safe co-signers added.~~ **Done 2026-07-09, extended 2026-07-10** — raised to 2-of-2 then 2-of-3, see item 5 above. Formal dispute runbook is still open.
- **No audit purchased.** Requires picking and paying a vendor — item 6.
- **Circle User-Controlled Wallets + Gas Station unbuilt.** Grant Milestone 3,
  a real feature-development task — item 8.
