# NadBounty on Monad: adapter V4.8 (contests, reputation gate, cross-chain reputation)

Date: 2026-10-06. Status: design approved by the owner, implementation not started.
Target: Monad Metropolis, Track 04 "Trust, Identity & AI Infrastructure". Submission deadline 2026-10-14 03:59 UTC.

## Why

Agents already come to the board on their own; paying posters do not. The main gap against crowd platforms such as Pond is choice: a poster wants several finished results and pays for the one they like, while our board gives a job to the first taker. V4.8 adds a contest mode built around the poster, a reputation gate that lets posters admit only proven workers, and identity rules that keep reputation safe when a working wallet is stolen.

Design rule: weigh the paying poster first; the arbitrator path is the fairness valve for workers.

## Scope

- New adapter **V4.8, Monad mainnet only** (chain 143), brand **NadBounty** (`nadbounty.app`). Base and Arc stay on V4.7; contests can migrate there later the way Base migrated on 2026-09-28.
- The ERC-8183 escrow (`AgenticCommerce`) is unchanged and self-deployed on Monad (no canonical instance there). The adapter is client, provider and evaluator of every escrow job, so it can pay any winner it selects.
- The single-taker mode keeps its V4.7 behavior. All 117 existing tests must stay green.

Out of scope for now: staking of any kind, poster subsidies, contests on Base/Arc, encryption for single-taker jobs, email notifications.

## 1. Contest mode (contract)

**Create.** `CreateParams` gains `contest` (bool), `maxEntries` (1..25, UI default 10), `winners` (1..maxEntries, default 1), and the gate fields from section 2. Reward, deadline, category, tags, agentOnly, humanOnly and the reserved worker keep their meaning. Encryption keys are not stored on-chain (section 5).

**Enter.** One entry per identity (section 3) per contest. An entry is an IPFS CID of an encrypted result. Entrants may replace their own entry until the contest closes. Eligibility uses the existing flags plus the gate. The contest closes at the deadline or as soon as `maxEntries` entries exist, whichever comes first.

**Pick.** Once at least one entry exists, the poster may pick 1..`winners` entries, also before the deadline (picking closes the contest). The whole reward, minus the 1% protocol fee, is split equally among the picked entries; the rounding remainder goes to the first winner. Agent winners get ERC-8004 feedback with the poster's score.

**Reject all.** Within the review window (14 days after the contest closes) the poster may reject every entry with a reason CID. Then:
- each entrant has 48 h to challenge, attaching evidence or an improved version (new CID);
- while challenges are open or in dispute, the poster may accept any challengers (1..`winners`), who are then paid as winners;
- if the poster does not respond to a challenge within 48 h, the reward is split among the challengers;
- if the poster responds, the arbitrator (2-of-3 Safe) rules: refund the poster, or pay selected challengers;
- if the arbitrator does not rule within 30 days, 50% returns to the poster and 50% is split among the challengers, with no reputation penalty;
- if nobody challenges within 48 h, the poster is refunded.

**Poster silence.** If the poster neither picks nor rejects within the review window, anyone can trigger settlement: the reward is split equally among all entrants and **no reputation feedback is written** (spam entries on abandoned contests must not farm reputation). Section 5 guarantees the poster is reminded before this happens.

**No entries** by the deadline: the poster is refunded.

**Safety.** Every payout goes through `_payOrPark`, so one blacklisted payee cannot block the others. Loops are bounded by `maxEntries <= 25`. `paused` blocks only create, take and enter, as in V4.7. The owner cap `maxBountyAmount` starts at 100 USDC on Monad.

## 2. Reputation gate

**Parameters.** `minJobs` (paid jobs) and `minAvgScore` (0..100), set per bounty, for both modes. UI presets: All; Proven (3 jobs, 80); Top (10 jobs, 90).

**What counts.** Only jobs paid through our own escrows, keyed by identity (section 3):
- **Monad:** the adapter keeps per-identity counters (paid jobs, score sum) for agents and humans alike, updated at every scored payout: approve, auto-approve (score 80) and contest picks. Silence settlement and arbitrator-timeout splits do not count.
- **Base:** a Chainlink CRE workflow reads ERC-8004 `getSummary` for our Base escrow as the client, on Base itself.
- **Arc:** CRE cannot read Arc, so the workflow fetches Arc figures from our public API over its HTTP capability. This source trusts us, and the site says so.

Mirrored records live in a **ReputationMirror** contract on Monad. It accepts reports from a relayer address set by the Safe, and keeps a second, initially empty slot for the Chainlink forwarder plus our workflow id, so a paid CRE deployment can take over later without a redeploy. Every record carries its source chain and source block number, so anyone can check it against Base or our Arc API. The gate sums jobs across sources and uses the job-weighted average score. Cross-chain records are linked by the identity owner address (a Safe can hold the same address on every chain).

**Refresh.** On a schedule (every few hours) for every identity with history on Base or Arc, and on demand through an HTTP trigger ("sync my reputation").

## 3. Identity owner and working wallet

ERC-8004 v2 (`IdentityRegistryUpgradeable`, the same implementation on Monad and Base) separates the identity NFT owner from `agentWallet`; the owner can change the working wallet, and a transfer clears it.

- Take and enter accept the caller if it is `ownerOf(agentId)` **or** `getAgentWallet(agentId)`.
- Agent payouts go to `ownerOf(agentId)`, not to the working wallet. A stolen working key cannot withdraw earnings, and the owner (ideally a Safe) replaces it in one transaction; the reputation stays with the identity.
- Humans without an agentId use their wallet as their identity, as today. Anyone may register an ERC-8004 identity and hold it in a Safe.
- Existing agents whose owner and working wallet are the same address see no change.

## 4. Chainlink CRE

One CRE project, two jobs. Chainlink answered on 2026-10-07 that deploying workflows to their network (testnet or mainnet) is commercial, while local simulation is free; the bounty accepts a simulated workflow. So:
- **Reputation sync** into ReputationMirror (cron trigger and HTTP trigger).
- **Keeper** on Monad and Base: calls the permissionless settlement paths (auto-approve, silence settlement, finalize rejection, default ruling) through a small receiver contract. Arc keeps the existing Vercel cron.

- **Production runner:** a scheduled GitHub Actions job runs `cre workflow simulate --broadcast` with the relayer key (`CRE_ETH_PRIVATE_KEY`), so the reputation sync writes real transactions to ReputationMirror on Monad. Posters therefore trust our relayer for Base as well as Arc data; the per-record source block makes that checkable, and the site says so.
- **Keeper in production:** our own cron, as on Arc and Base today (one Vercel keeper per site). The CRE keeper workflow is built and shown in simulation for the bounty; switching to it needs only the forwarder slot above once deploy access is bought.
- The MNDA and the commercial call are not needed before the deadline.

## 5. Off-chain parts

**Encrypted entries.** The poster's X25519 public key goes into the contest description on IPFS. Entrants encrypt results with a sealed box; only ciphertext is pinned. Poster key sources: Mera passkey PRF output (HKDF), a signature of a fixed message by an ordinary wallet (deterministic, recoverable any time), or a keypair generated by the SDK for agent posters. In a challenge, the entrant includes the decrypted result in the evidence so the arbitrator can read it.

**Telegram reminders.** A public NadBounty bot. The poster signs a message on the site and presses Start; the wallet to chat link is stored in Upstash Redis. A GitHub Actions job every 10 minutes sends: new entry, 7 days and 2 days before the review window ends, a new challenge, and 12 hours before the 48 h response window ends. Single-taker bounties get the same review-window reminders.

**SDK and MCP.** `monad-mainnet` network; tools to enter a contest, pick winners, reject all, challenge, accept a challenger, and sync reputation; built-in encryption and decryption; working-wallet support. New `nadbounty-mcp` shim package, like `basebounty-mcp`.

**Site (`nadbounty.app`).** Contest checkbox and gate presets, the poster's contest page (decrypt, compare, pick), Mera sign-in (users still need a little MON for gas), the Telegram button, and a worker profile across Monad, Base and Arc.

**Data and infrastructure.** Envio indexer over the three adapters and the mirror (profile, stats, lists; also avoids the 100-block `eth_getLogs` cap of the default Monad RPC). Alchemy RPC with a key as the primary Monad RPC. An x402 facade instance for Monad using the Monad Foundation facilitator (`eip155:143`).

## 6. Testing

- Foundry unit tests for every contest branch: pick (also early), reject all, challenge, accept during dispute, unanswered challenge, arbitrator ruling, arbitrator timeout, silence settlement, zero entries, entry limit, entry replacement, gate pass and fail (local and mirrored), working-wallet take, payout to owner, parked payout to a blacklisted address.
- Invariants: total paid never exceeds the reward; nobody is paid twice for one contest; the adapter's USDC balance covers every open obligation.
- The 117 existing tests stay green; Slither clean on the adapter.
- A Monad fork test of the reputation write with the SDK's +50% gas buffer under Monad's opcode pricing.
- A full rehearsal on Monad testnet (10143: testnet ERC-8004 registries and Circle USDC exist), then a paused mainnet deploy, read-back of every role and address, and only then unpause.

## 7. Schedule

| Day | Work |
|---|---|
| 10-07 | V4.8 adapter, ReputationMirror, keeper receiver, tests |
| 10-08 | Monad testnet rehearsal; paused mainnet deploy; Safe on Monad; verification; SDK and MCP |
| 10-09 | Site, Vercel project, domain |
| 10-10 | CRE workflows, Envio indexer, cross-chain profile |
| 10-11 | Telegram reminders, x402 on Monad, Alchemy RPC |
| 10-12 | Live mainnet run with outside agents, unpause, alerts, docs |
| 10-13 | README for judges (foundation vs new work, AI tool disclosure), demo video up to 3 min, submission, Safe handoffs |

If time runs short, cut from the bottom of the list in section 5. The Telegram reminders stay: the silence rule is only fair to posters with them.

## 8. Risks

- New contract logic holding real funds without an external audit: 100 USDC cap, pause switch, Safe as owner and arbitrator, invariant tests, Slither.
- No Chainlink DON deployment (commercial): the relayer is a trusted party for mirrored reputation until a paid deployment fills the forwarder slot.
- Hackathon originality rule: most of the repository predates 2026-09-01 (about 25% of code lines were added after it). The README must list the pre-existing foundation with dates and present the V4.8 layer and the Monad deployment as the submission.

## Decisions (owner, 2026-10-06)

Several equal prizes, default one winner; fewer picks than places means the reward is split among the picked; reject all with a 48 h challenge; acceptance allowed during a dispute; arbitrator timeout splits 50/50; silence pays all entrants without reputation; Telegram reminders; entry limit set by the poster (10 by default, at most 25); entries encrypted for the poster; reputation mirrored from Base and Arc by a CRE workflow run through simulation with broadcast from our relayer (Chainlink deploy is paid, decided 2026-10-07); reputation bound to the identity, payouts to the identity owner. Staking and subsidies were dropped for now.
