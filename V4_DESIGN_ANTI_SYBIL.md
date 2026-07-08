# V4 design: anti-Sybil reputation + worker-bond

**Status: FULLY IMPLEMENTED** — Proposal A + Proposal B1 shipped on-chain
2026-07-05 (with numbers picked by the user, not guessed by whoever wrote
the patch); Proposal B2 (frontend/leaderboard display weighting) shipped
2026-07-07 as the leaderboard "ArcBounty score" + "Unique posters" columns
and the `/stats` dashboard. See "What shipped vs what didn't" at the end.

Shipped parameters:
- `WORKER_BOND_BPS = 1500` (15%), `MIN_WORKER_BOND = 0.5e6` (0.50 USDC floor)
- Opt-in via `CreateParams.requireWorkerBond`
- Refunded in full at `submitWork`; forfeited to the poster at `expireBounty`
  if the bounty was taken with no submission
- `uniquePosterCount(agentId)` — increments on `approveBounty`/`autoApprove`
  the first time a distinct poster completes with that agent
- **V4.1 (2026-07-07): `MIN_BOND_BOUNTY_DURATION = 24h`** — a bond bounty's
  deadline must be at least 24h out at creation. Closes the bond-honeypot
  found in the pre-audit review: a near-immediate deadline let a poster farm
  forfeited bonds from auto-taking agents that never had a real chance to
  deliver.
- **V4.2 (2026-07-08): `MIN_BOND_TAKE_WINDOW = 12h`** — closes the residual
  gap the V4.1 fix left open: the 24h floor only bounds a listing's total
  duration *at creation*, so an aged bond listing could still be *taken*
  minutes before its deadline, trapping the taker's bond with no realistic
  chance to submit. `takeBounty` now additionally requires ≥ 12h left on the
  clock for bond bounties (bond-free bounties are unaffected). Known residual
  limitation (disclosed, accepted, unchanged by either fix): the bond deters
  take-and-vanish only — a squatter can still reclaim their bond by
  submitting garbage, which routes the poster into the reject/challenge
  path. See `ARCHITECTURE.md` §3 for the full trade-off discussion.

The rest of this document is kept as-written (the original design rationale
and the options that were considered) for context on *why* these numbers.

---

## Problem 1: reputation farming via self-dealing

**Mechanism.** A poster and a worker can be the same person operating two
wallets. Create a bounty at `MIN_REWARD` ($1), take it with the second
wallet, submit trivial work, approve with `reputationScore = 100`.

**Cost per cycle**, at current V3.3 parameters (`feeBps = 100`, MIN_REWARD =
$1):
- Protocol fee: 1% of $1 = $0.01
- AC's own platform fee (observed ~0.18% in `ARCHITECTURE.md`'s worked
  example): ~$0.0018
- Gas: negligible on Arc (~$0.01 ceiling per the project's own thesis)
- **Total: roughly $0.012–0.02 per fabricated "completed job with score 100."**

100 fabricated perfect reviews cost under $2. This directly undercuts the
project's own marketing claim (pitch deck, Slide 8) that ArcBounty's
reputation is "task-backed... not an arbitrary review" — it *is* backed by a
real payout, but the payout itself is nearly free to fabricate at the
minimum reward tier.

## Problem 2: free bounty-squatting

**Mechanism.** `takeBounty` requires no stake from the worker. Anyone can
call `takeBounty` on every open bounty on the board, for the cost of gas
alone, and then simply never call `submitWork`. The bounty is inert until
its deadline passes and someone calls `expireBounty` — the poster's funds are
untouched (they sit in the adapter/AC escrow the whole time and are
refunded), but the *board itself* is unusable for that job's duration, and a
real worker who would have done the job never gets the chance.

---

## Design goals

1. Make both attacks cost meaningfully more than "gas plus a fee on the
   minimum reward" — without pricing out legitimate micro-bounty workers,
   which is the whole point of Arc's sub-cent gas economics.
2. Prefer mechanisms that live in `BountyAdapter`'s own storage over anything
   requiring changes to Arc's `ReputationRegistry` — that registry is owned
   and deployed by the Arc team; we can choose what we write to it, not how
   it aggregates or stores what we write.
3. Don't block the existing happy path. Whatever ships should be opt-in or
   proportional, not a flat tax that makes a $1 bounty impossible.

## Non-goals

- Solving Sybil resistance in general (fake identities, agent farms). ERC-8004
  identity issuance is Arc's concern, not ours — we can only make *reputation
  built through ArcBounty specifically* harder to fake.
- Changing `ReputationRegistry` itself. Out of scope and not ours to change.

---

## Proposal A: worker-bond (addresses Problem 2, and raises the floor on Problem 1)

At `takeBounty`, the worker posts a bond in USDC in addition to the poster's
reward already sitting in the adapter. The bond is:
- **Refunded in full** the moment `submitWork` is called (bond exists only to
  disincentivize taking-and-vanishing, not to punish slow work).
- **Forfeited** if the bounty is later `expireBounty`'d while still
  `isTaken` with no submission.

Open questions requiring sign-off, not defaults I've picked myself:

| Parameter | Options | Trade-off |
|---|---|---|
| Bond size | Flat (e.g. $0.25) vs. proportional (e.g. 10–20% of reward) vs. hybrid (max of the two) | Flat is simplest and doesn't scale with reward (bad for large bounties); proportional scales but a percentage of a $1 bounty is meaningless as a deterrent |
| Where a forfeited bond goes | Back to the poster (their listing was blocked) / to `feeRecipient` / split | Poster-refund best matches "you wasted my listing time"; fee-recipient risks a perverse incentive to induce squats |
| Scope | All bounties vs. only bounties below some reward threshold (where squatting is proportionally worst relative to gas cost) | Blanket is simpler; threshold targets the actual failure mode without taxing high-value bounties where squatting is already irrational |
| Opt-in vs. mandatory | Poster sets `requireWorkerBond: bool` at `createBounty` vs. always required | Opt-in avoids breaking existing UX/SDK examples overnight and lets the market reveal whether posters even value it |

**Recommendation to start the conversation:** opt-in, scoped to bounties
under some threshold (say $10, tunable), bond = `max(flatFloor, bondBps *
reward)`, forfeited bond refunded to poster. This is a recommendation, not a
decision — it needs your sign-off before it becomes a V4 PR.

## Proposal B: reputation weighting (addresses Problem 1)

Two independent layers, because we don't control `ReputationRegistry`'s
internals — only what we feed it and what we display:

### B1 — on-chain: track unique posters per agent (cheap, ships fast)

Add to `BountyMeta`/agent-level storage in `BountyAdapter`:
```solidity
mapping(uint256 => mapping(address => bool)) private _hasPostedForAgent; // agentId => poster => seen
mapping(uint256 => uint256) public uniquePosterCount; // agentId => count
```
Increment `uniquePosterCount[agentId]` the first time a given `poster`
address completes a bounty with that agent as worker. This is a single extra
`SLOAD`+ optional `SSTORE` in the existing `approveBounty`/`autoApprove` path
— cheap, and it's the one number self-dealing *cannot* fake without actually
paying gas + fees from N distinct wallets, which raises the cost of faking
"reputation across many counterparties" from "$0.012 with one alt account"
to "$0.012 × N distinct funded wallets," a materially different economic
bar.

### B2 — off-chain/frontend: reward-weighted display score

`getAgentReputation` today surfaces Arc's raw `averageScore` /
`totalFeedbacks` / `totalJobs`. Nothing stops us from *also* computing a
derived, reward-weighted score from `BountyCompleted` + `ProtocolFeePaid`
event history (already indexed for the leaderboard) and showing both:
"ERC-8004 average: 98 · ArcBounty-weighted: 84 (12 unique posters, $340
total volume)." This needs no contract change, ships as a leaderboard/
agent-profile update, and can be iterated on without a redeploy — the exact
weighting formula (linear by reward? `sqrt(reward)` to avoid one whale bounty
dominating? decay for repeated poster/worker pairs?) is a display-layer
decision, cheap to change later, and doesn't need to be locked in before
shipping something.

**Recommendation:** ship B1 in the V4 contract (small, cheap, permanent) and
B2 immediately in the frontend/leaderboard (no contract dependency at all —
could ship before V4 lands). B2 in particular could go out this sprint if
prioritized.

---

## Suggested rollout order

1. **Now, no contract change:** B2 (reward + unique-poster-weighted display
   score on `/leaderboard` and `/agent/[agentId]`). Immediately blunts the
   *visible* effect of Problem 1 even before any contract change ships.
2. **V4 contract:** B1 (`uniquePosterCount`) — small, additive, low risk.
3. **V4 contract, pending the parameter decisions above:** Proposal A
   (worker-bond), opt-in via `createBounty`.
4. Re-evaluate before mainnet: does the opt-in bond see real adoption? If
   posters never set `requireWorkerBond`, that's a signal the squatting
   problem is smaller in practice than the audit worried, and a mandatory
   bond would just be UX friction for no benefit.

## What this doc deliberately does not include

Solidity for Proposal A — this was true until 2026-07-05. The bond mechanism
touches fund custody on a contract that's supposed to be audit-ready soon
(`GRANT_APPLICATION.md` milestone 2) — writing that code before the
parameters above are agreed would mean either re-writing it after sign-off
(wasted audit surface) or quietly picking the parameters myself on a
fund-custody change, which is exactly the kind of decision this document
exists to avoid making unilaterally.

## What shipped vs what didn't (updated 2026-07-07)

**Shipped, with the parameters stated at the top of this document:**
- Proposal A (worker bond) — opt-in, 15%/$0.50-floor, refund-at-submit,
  forfeit-to-poster-at-expire. Hardened in V4.1 with the 24h
  `MIN_BOND_BOUNTY_DURATION` honeypot guard, then in V4.2 with the 12h
  `MIN_BOND_TAKE_WINDOW` that closes the residual take-near-deadline gap the
  V4.1 fix left open.
- Proposal B1 (on-chain `uniquePosterCount`).
- Proposal B2 (2026-07-07) — the leaderboard now shows an "ArcBounty score"
  (average `reputationScore` weighted by `sqrt(reward)`, so one whale bounty
  can't dominate, computed from `BountyCompleted` + `BountyCreated` events)
  next to the raw ERC-8004 reputation, plus a "Unique posters" column
  surfacing the on-chain B1 signal. The same event pipeline powers the
  `/stats` public dashboard. No contract dependency, exactly as designed.

**Still open:**
- Re-evaluation of bond adoption (item 4 in the rollout order above) — can't
  happen until there's real usage data on the redeployed contract.
- Decentralized dispute resolution and the rest of the roadmap in
  `ARCHITECTURE.md` are unrelated to this document's scope.
