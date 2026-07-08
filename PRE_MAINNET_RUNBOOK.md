# Pre-mainnet runbook

Arc mainnet itself has not launched yet (publicly confirmed for summer 2026)
— there is nowhere to deploy "to mainnet" today. This document is the
checklist for everything that needs to happen **before that becomes
possible**, split by who has to act.

> **Status update (2026-07-08, fourth pass).** The board now runs **V4.2** at
> `0x2e9504EEa0bD80CBaA2464227054fc941EE46cA7` (source-verified on ArcScan):
> the two external-review fixes — `disputeBounty` bounded by
> `APPROVAL_TIMEOUT` (mirrors the V4.1 `rejectBounty` bound) and
> `MIN_BOND_TAKE_WINDOW` (12h floor on taking bond bounties) — are live.
> Done items, kept below only as a record of what was done and why:
> - ✅ **Item 1 — redeploy**: V4 (2026-07-05) → V4.1 (2026-07-07) → V4.2
>   (2026-07-08). Board re-seeded each time (after reclaiming ~28 USDC from
>   17 open V4.1 listings via `scripts/reclaim-bounties.ts`) — 19 seeded, 17
>   open. Fresh two-party agent proof-of-life re-run on V4.2: jobIds
>   `151547` (bond cycle) + `151546`, agentId `847205` (same identity as
>   the prior V4.1 run; `scripts/agent-proof-of-life.ts`).
> - ✅ **Item 2 — npm publish**: `arcbounty-agent-sdk@0.4.1` (adds
>   client-side `bondCreateDeadlineOk`/`bondTakeWindowOk` guards matching
>   V4.2) published to npm.
> - ✅ **Item 3 — Vercel prod**: bundle serves the canonical adapter address
>   from `contracts/DEPLOYMENTS.md`; re-verify after every redeploy.
> - ✅ **Item 5 (first half) — Safe.** The arbitrator role reset to the
>   deployer at construction (every redeploy does this), so the two-step
>   handshake had to run again on V4.2: `transferArbitrator` from the
>   deployer, then `acceptArbitrator()` executed from the Safe itself
>   (`execTransaction` via app.safe.global). Confirmed on-chain:
>   `arbitrator()` returns the Safe, `pendingArbitrator()` is zero. **Still
>   open: adding independent co-signers + raising the threshold.**
> - ✅ **Item 7 — V4 parameters**: decided (15% / $0.50 floor / opt-in /
>   forfeit-to-poster) and shipped on-chain, hardened in V4.1 with the 24h
>   bond-deadline floor and in V4.2 with the 12h take-window floor. Proposal
>   B2 (leaderboard score + `/stats`) shipped 2026-07-07. See
>   `V4_DESIGN_ANTI_SYBIL.md`.
>
> Still open: item 5's co-signers (see above), item 6 (external audit), item 8
> (Circle User-Controlled Wallets + Gas Station), item 9 (the actual mainnet
> deploy). Item 4 (WalletConnect rotation) closed 2026-07-07.

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

### 2. Publish the SDK to npm — ✅ done (`0.4.1` live)

`mcp-server/package.json` depends on the published semver range (`^0.4.0`,
which resolves to `0.4.1`) instead of `file:../agent-sdk`, so the MCP server
installs standalone.

### 3. Verify Vercel production — ✅ done (2026-07-05)

`arcbounty.app` serves the current build: canonical V4 adapter address baked
into the client bundle, Pinata v2 pin routes live. Re-check after any future
redeploy (bundle env-var update + deploy together, not as two separate steps).

### 4. Confirm WalletConnect project ID rotation — ✅ done (2026-07-07)

A fresh project ID was issued in the Reown (WalletConnect Cloud) dashboard
and deployed to Vercel production + local env. Dashboard-side follow-ups
(quick, in the same dashboard): delete the old project and set the new
project's allowed domains to `arcbounty.app`.

### 5. Real N-of-M Safe multisig (Grant Milestone 1) — transfer ✅ done on V4.2, signers still open

`transferArbitrator(0x4892…1BC6)` was called on the live V4.2 contract, and
`acceptArbitrator()` was executed **from the Safe itself**
(`execTransaction` via app.safe.global, tx
`0xd7690941a0e58bf687691438af8a852b7671266306328ca79110e4614c1a3ea7`,
block `50650819`) — confirmed on-chain: `arbitrator()` returns the Safe,
`pendingArbitrator()` is zero. Every prior deployment (V4, V4.1) needed this
same two-step handshake repeated, since the role resets to the deployer at
construction and does not carry over across redeploys — expect to do it
again on the next redeploy too. The Safe is still 1-of-1 with the same key
as before — infrastructure for decentralization, not decentralization
itself. Add independent co-signers and raise the threshold **inside the
Safe UI** — no contract change needed, `BountyAdapter` already only talks to
`arbitrator()`, whatever address that resolves to. Write the accompanying
dispute runbook (who signs, under what evidence, SLA) alongside this — the
doc matters as much as the threshold number.

### 6. Procure the external audit (Grant Milestone 2)

`BountyAdapter.sol` — either a paid audit or an audit contest (Sherlock,
Code4rena, Cantina, etc.). Do this against the deployed **V4.2** code. Feed
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

- **No Safe co-signers added.** Requires real people with real keys — item 5.
- **No audit purchased.** Requires picking and paying a vendor — item 6.
- **Circle User-Controlled Wallets + Gas Station unbuilt.** Grant Milestone 3,
  a real feature-development task — item 8.
