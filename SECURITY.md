# Security

This file covers **NadBounty V4.8.1 on Monad mainnet** (chain `143`), the Monad Metropolis submission in this repository. ArcBounty and BaseBounty (V4.7) list their own known issues in the [README](./README.md#-known-issues), and a past credential incident is written up in [`SECURITY_INCIDENT.md`](./SECURITY_INCIDENT.md).

## Not audited externally

**No external security audit of NadBounty exists.** No auditor has signed off on any contract in `contracts/src/monad/` or on the escrow it uses. What exists is internal: the author's own review together with AI coding agents (Anthropic's Claude Code and OpenAI's Codex), forge tests with stateful invariants, Slither triage and rehearsals on Monad Testnet (see "How the claims were checked" below). That is evidence, not independent assurance.

The controls that limit the damage of an undiscovered bug are small and are listed here so you can judge them: a cap of 100 USDC per bounty, a 1% immutable fee, a Safe-controlled pause that blocks only new obligations, and the fact that most exit paths are permissionless and deadline-based. The cap limits each bounty, not the total value held in escrow at one time.

## Reporting a vulnerability

Use GitHub private vulnerability reporting: https://github.com/Sofiia7/ARC/security/advisories/new (it is enabled for this repository). Please do not open a public issue for a security problem.

- Include the contract and function, the steps to reproduce, and a transaction hash, `jobId` or `agentId` where one exists. That is enough to look at anything on chain.
- Never paste private keys, seed phrases or API secrets into a report.
- Please reproduce on a local fork of Monad mainnet instead of sending transactions that touch other people's funds.

In scope: the contracts listed below, `nad-automation`, `nad-facade`, `nadbounty-mcp`, the SDK class `NadBountyAgent` and the Monad build of the web app at https://nadbounty.app. Out of scope here: the canonical ERC-8004 registries and Circle's USDC (report those to their maintainers), and ArcBounty / BaseBounty (see the README).

## Deployed contracts (Monad mainnet, chain 143)

| Contract | Address |
|---|---|
| BountyAdapter V4.8.1 | [`0x5C38F98Fb3F3BA3eB8206Cb653eeDC8C159E1bE4`](https://monadvision.com/address/0x5C38F98Fb3F3BA3eB8206Cb653eeDC8C159E1bE4?tab=Contract) |
| AgenticCommerce proxy (escrow) | [`0x39B37466268c637617BC2573056d41d853372f36`](https://monadvision.com/address/0x39B37466268c637617BC2573056d41d853372f36?tab=Contract) |
| AgenticCommerce implementation | [`0xDDC2C0917acdF1e12053Fd0f5b065B5fC24b1555`](https://monadvision.com/address/0xDDC2C0917acdF1e12053Fd0f5b065B5fC24b1555?tab=Contract) |
| ReputationMirror | [`0x05e17AaCBf7c8e47D4Db4B9108f66f846ceDdAC5`](https://monadvision.com/address/0x05e17AaCBf7c8e47D4Db4B9108f66f846ceDdAC5?tab=Contract) |
| KeeperReceiver | [`0xF55bE023F13F75C23EFbd04e5f6878F323838552`](https://monadvision.com/address/0xF55bE023F13F75C23EFbd04e5f6878F323838552?tab=Contract) |
| Safe 2-of-3 | [`0x74678c072Ca546f11466CD44eB7e21730a312a54`](https://monadvision.com/address/0x74678c072Ca546f11466CD44eB7e21730a312a54) |

All five contracts we deployed are Sourcify exact matches (creation and runtime), checked against the Monad Sourcify API on 2026-10-13. MonadVision shows the adapter as "Contract Source Code Verified (Full Match)". The same sources are also verified on Monadscan through the Etherscan V2 API (confirmed on 2026-10-13 for the adapter, mirror, receiver, escrow implementation and escrow proxy). Every address and transaction hash of the deployment is in [`contracts/DEPLOYMENTS.md`](./contracts/DEPLOYMENTS.md). The adapter source in this repository (`contracts/src/monad/BountyAdapterV48.sol`) is identical to the source stored at Sourcify for the deployed address (compared on 2026-10-13), so the line numbers below refer to the deployed code.

**Deployment history.** The first V4.8 deployment (adapter `0xf88B980B3AB1CD5A2Befd9c0B88B70196f215020`, escrow `0x8F367e17d96EB83c4A51b3349e3CE30447aDB7e2`, mirror `0x59e970574D9aDc30892d094C893DA4B73EBE40a0`, keeper `0x5B7559f1973D371d1b6A1e6ED22BeCbb4594e17f`, escrow implementation `0xD87Ece19382044b69f4E9cb89e71A0Aa3Aeb9f9f`, deployed 2026-10-12) is superseded by V4.8.1, deployed on 2026-10-13 with the fixes listed below. The first adapter is not upgradeable and stays on chain; every settlement and withdrawal path still works there, but the site, the SDK and the MCP server no longer use it. Its details are kept in [`contracts/DEPLOYMENTS.md`](./contracts/DEPLOYMENTS.md).

## What is trusted

Facts about roles below were read from the chain on 2026-10-13.

| Party | What it can do | What limits it |
|---|---|---|
| **Safe 2-of-3** `0x7467...2a54` (Safe v1.4.1, threshold 2 of 3 owners, no Safe modules enabled, so no timelock) | Is the adapter's **owner** (`setPaused`, `setMaxBountyAmount`, role handoffs), **arbitrator** and **fee recipient**; **owner** of ReputationMirror (`setRelayer`, `setForwarder`, `invalidateRecord`) and of KeeperReceiver; and **admin of the AgenticCommerce escrow** (`DEFAULT_ADMIN_ROLE` and `ADMIN_ROLE`), which means the **UUPS upgrade authority over the contract that holds the USDC of funded jobs** and the right to set escrow fees. | The adapter is not upgradeable and its 1% fee is immutable. Through the adapter the Safe cannot withdraw funds outside of ruling in an opened dispute. The escrow upgrade is the largest trust assumption in the system: it is protected only by two of three signatures, with no timelock. Pause blocks `createBounty`, `takeBounty`, `enterContest` and `replaceContestEntry` only; settlement, cancellation, disputes and withdrawals keep working. |
| **Arbitrator** (the Safe) | Rules inside an opened dispute or contest challenge: pays the worker or challengers, or refunds the poster. Cannot touch a job nobody disputed. | If it stays silent, anyone can call `claimDefaultRuling` (respondent silent for 48 hours) or `claimArbitratorTimeout` / `claimContestArbitratorTimeout` (30 days, neutral 50/50 split, no fee). |
| **Reputation relayer** `0x78B3D0e6703906be0509A4dE64f8a6010eeB6904` | A hot key, stored as a GitHub Actions secret and used by the mainnet workflow (scheduled at minutes 12 and 42 of each hour), that writes Base and Arc reputation snapshots into ReputationMirror. The contract does not verify the snapshots: `sourceBlock` is provenance, not proof. A compromised key could inflate mirrored reputation for any identity owner and so pass reputation gates. Arc data is supplied by our API, not proven. | The relayer holds no user funds (only MON for gas) and no other role. The Safe can revoke it (`setRelayer`) and erase records (`invalidateRecord`), then resync. Every record carries its source chain and block, so it can be checked by hand. The Chainlink CRE workflows that would replace this trust pass local simulations only and are not deployed. |
| **Keeper wallet** | Calls permissionless settlement functions after deadlines (anyone can do the same). | It has no on-chain role. The adapter enforces every deadline and state, so a keeper cannot send money anywhere it should not go. KeeperReceiver's relayer and forwarder are zero (disabled). |
| **Canonical ERC-8004 registries** (identity `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, reputation `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`) | The adapter trusts `ownerOf` and `getAgentWallet`, and pays an identity-bound worker to the identity's current owner. The registries are upgradeable by their owners, so a malicious upgrade could change who counts as the owner and redirect such payouts. | Reputation writes are wrapped in `try/catch` and never block a payout. A failed owner read parks the amount (see L-5). |
| **Circle USDC** | Can blacklist an address or pause transfers. | A failed transfer is credited to a pull-payment balance (`withdraw`, `withdrawIdentity`) instead of reverting settlement. |
| **Web app and hosting** | The site, the IPFS pinning proxy and the Telegram reminder service are not custodians. A compromised site build could still ask a user to sign a harmful transaction. | Contract addresses are published here and in the README, so a user can check what they sign. Contest entries are encrypted to a key only the poster holds, and only ciphertext is pinned. |

## Internal review findings (first V4.8 deployment, and what V4.8.1 changed)

Found during our own review on 2026-10-13. Severity labels are ours, not an auditor's. The first deployment is not upgradeable, so fixes needed a new deployment: **Fixed** below means fixed in V4.8.1 (the current deployment), the rest is **disclosed, not fixed**. Function names refer to `contracts/src/monad/BountyAdapterV48.sol`.

| ID | Severity | What the code does | Mitigation or disclosure |
|---|---|---|---|
| M-1 | Medium | The reputation gate (`_checkGate`) counts paid jobs and score sums, local plus mirrored. In the first deployment nothing stopped a poster from taking or entering their own job, so the gate could be inflated by self-posting small jobs (each costs the 1% fee, about 0.01 USDC on a 1 USDC job, plus gas). | **Partly fixed in V4.8.1.** A paid job where the poster is also the worker (the same wallet, or the owner of the identity doing the work) still pays out and still pays the fee, but earns no local score, no ERC-8004 feedback and no unique-poster credit. Farming with several wallets is still possible, and the gate still does not use `uniquePosterCount`. Mirrored history is not covered by the guard: the Base and Arc adapters have no self-deal check and the relayer copies every completed job's feedback, so a wallet that posted and took its own bounty on Base or Arc can import that credit (a filter on poster equals identity owner in the sync is planned); the profile page shows the number of different posters for transparency. Treat the gate as **paid-job history, not proof of quality**, or whitelist a specific provider. |
| M-2 | Medium | A contest closes the moment `maxEntries` is reached (`enterContest`), and the 14-day review clock starts then, which can be earlier than the advertised `deadline`. Without a gate, a fresh wallet can take a slot, so slots can be filled before honest entrants arrive. | **Disclosed, not fixed** (kept on purpose). The post form states the rule, and `getContestState(jobId)` returns the real closing time and review deadline. Posters can set `minJobs` (itself subject to M-1). An entry deposit would need a new adapter. |
| L-1 | Low | In the first deployment `acceptContestChallengers` had no time guard: a poster who missed the 48-hour response window could still choose which challengers are paid before anyone called `claimContestDefault`. | **Fixed in V4.8.1.** It now requires an open challenge, the 30-day arbitrator window and no overdue response, the same limits as `respondToContestChallenges`; after that anyone can claim the default or the neutral split. |
| L-2 | Low | Contests had no equivalent of `withdrawRejection`: after `rejectAllContestEntries` the poster could not take it back. | **Fixed in V4.8.1.** `withdrawContestRejection` lets the poster retract a reject-all before any entrant challenged it. It does not extend the review window. |
| L-3 | Low | Challengers paid by an arbitrator ruling (`resolveContestDispute`) receive no reputation score, and a poster who lost a ruling receives no penalty. | Disclosed as a choice of the ruling path: arbitrator rulings pay challengers but do not score them. |
| L-4 | Low | The adapter requires that the escrow pays out exactly the reward (`received == reward`, lines 778, 1473, 1499, 1522). If the Safe ever set a non-zero platform or evaluator fee on the AgenticCommerce escrow, every payout through the escrow's `complete()` would revert with `UnexpectedEscrowAmount`. Refunds through `reject()` are not affected by those fees. | Both fees are 0 today (read on chain 2026-10-13). Operating rule for the Safe signers: never set them on this escrow; setting them back to 0 restores payouts. |
| L-5 | Low | `withdrawIdentity` reads the identity owner from the registry and reverts if the identity NFT no longer exists. A payout parked for a burned identity (`pendingIdentityWithdrawals`) can then never be claimed. | By design a parked identity payout can only be claimed by the identity's current owner. Do not burn an identity that has unclaimed earnings. |
| N-1 | Info | Stale comments in the first deployment's verified source (contest creation "fails closed"; the pause comments omitted `enterContest` and `replaceContestEntry`). | **Fixed in V4.8.1** (comments corrected, no behaviour change). |

## Reported by others

Reports that came in through private vulnerability reporting. They are not an audit, and the severity labels are ours.

| ID | Severity | What the code does | Mitigation or disclosure |
|---|---|---|---|
| L-6 | Low | On a single-taker bounty (contests have their own challenge path) a worker can open a dispute (`disputeBounty`) as soon as the work is submitted: there is no minimum wait, only the 14-day review window as the upper bound. From then on the poster has 48 hours (`DISPUTE_RESPONSE_WINDOW`) to answer with `respondToDispute`, and `approveBounty` and `rejectBounty` revert while the dispute is open. If the poster stays silent, anyone can call `claimDefaultRuling` after 48 hours and the worker is paid; our keeper makes that call on schedule. An early dispute can therefore shorten the poster's 14-day review to 48 hours. No funds are lost or locked. | **Disclosed, not fixed.** The adapter is not upgradeable; the next adapter version will change this. Until then, check a bounty within 48 hours of a submission and answer any dispute with `respondToDispute`, which hands it to the arbitrator. Posters who linked Telegram on nadbounty.app get a reminder when a dispute needs their response. The same rule is in V4.7 on Arc and Base (see the README). Reported on 2026-10-22 by Vijaygopal Balasa (Judge Protocol), with fork tests of the dispute paths on the Arc V4.7 adapter. |

## Design notes

- **Poster self-participation.** The contract does not forbid a poster from entering or awarding their own contest or job. The reward is the poster's own deposit, the poster pays the 1% protocol fee on any payout, and no other party's funds are moved. Since V4.8.1 such a job earns no reputation (see M-1). Entrants choose which contests to enter and can see the poster's address and history on chain.
- **Entries are visible to the poster.** Contest entries are encrypted so that other entrants and the public cannot read them, but the poster can decrypt every entry, including those they do not award. Enter a contest only with work you are willing to show its poster.
- **Early pick.** A poster may pick winners before a contest closes. Until it closes, an entrant can replace their entry, so a poster who decrypted an entry and then picks it pays for whatever the entry holds when the transaction lands. The site warns about this when picking; pick after the contest closes when you can.
- **Rewards follow the identity, not the working wallet.** For an ERC-8004 identity, payouts go to the identity's current owner; the working wallet signs but never receives the reward.
- **The Safe also controls the escrow.** This is a trust assumption, not a bug; it is listed first in the trust table so nobody has to discover it.

## How the claims were checked

Everything here is internal verification. Where a number is quoted, it is from the cited document.

- **Forge tests and invariants.** `docs/superpowers/plans/2026-10-08-nadbounty-v48-stage6-local-verification.md` records 488 passing checks at the 2026-10-08 checkpoint (317 in the V4.8 suites including new invariants and deployment checks, 171 in the existing adapter, mirror and keeper suites). Three mixed stateful invariants run against the real pinned AgenticCommerce behind an ERC1967 proxy with 256 runs x 128 depth (32,768 actions per property). The numbers were not re-counted after that checkpoint. Fresh Linux CI on the published source passed V4.8 tests, invariants, size bounds, gas snapshots and the configured Slither gate (`docs/security/NADBounty_V48_LAUNCH_READINESS.md`).
- **Slither.** The configured `fail-low` gate passes with one informational finding (the deliberate low-level call in `_payOrPark`). The full adapter report without global detector exclusions has 60 findings (9 incorrect-equality, 7 reentrancy-no-eth, 5 reentrancy-benign, 38 timestamp, 1 low-level-call), reviewed by category; it is not a clean strict gate. Strict checks on KeeperReceiver and ReputationMirror pass (one informational assembly finding and zero findings). Triage notes are in [`contracts/SLITHER.md`](./contracts/SLITHER.md).
- **Forks and rehearsals.** Monad-aware forks exercised the real registries, working-wallet admission, current-owner payouts and feedback writes. Local fork time travel was used only for positive deadline tests. A Monad Testnet rehearsal settled six immediate scenarios, and a real-clock contest default settled on testnet in `0x112b4a4036ece28231d3a28827ecefedd2bd94edd2cdefacfab719b2d8c4107a`. On mainnet, three real-USDC scenarios ran before the Safe handoff (see the README).
- **V4.8.1 review fixes.** A new suite, `contracts/test/BountyAdapterV48ReviewFixes.t.sol`, covers the self-dealt single-taker and contest paths (with controls that independent workers are still credited), the overdue and out-of-window acceptance cases and the retraction behaviour. On 2026-10-13 the V4.8, keeper and mirror suites passed locally under the `monad_local` profile (426 tests, including the stateful invariants), the full CI pipeline including the configured Slither gate passed on the pull request, and the deployed adapter is an exact Sourcify match of that source.
- **CI.** GitHub Actions runs `forge fmt/build/test/snapshot`, a Slither gate, frontend and SDK builds, `scripts/check-consistency.ts` and gitleaks.

Known gaps in that evidence: the legacy RPC-dependent fork tests return early without a configured RPC, so their passing status is not network evidence; local simulation of the CRE workflows proves neither gateway authentication nor multi-node consensus; and the Envio indexer covers Monad Testnet, Base and Arc, not Monad mainnet.

## Operating rules for the Safe signers

1. Never set a non-zero platform or evaluator fee on the Monad escrow (L-4).
2. If the reputation relayer key is ever suspected, revoke it with `setRelayer`, erase affected records with `invalidateRecord`, then resynchronize from the source chains.
3. Pause stops only new obligations (`createBounty`, `takeBounty`, `enterContest`, `replaceContestEntry`); settlement and withdrawals keep working by design.
