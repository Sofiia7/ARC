# ArcBounty Architecture

This document explains the non-obvious engineering decisions that make
ArcBounty work *natively* on Arc's standards instead of reimplementing escrow:

1. How a bounty board with arbitrary worker assignment maps onto ERC-8183's
   fixed three-role model (the **balance-delta payout** technique).
2. How the dispute system extends ERC-8183 without forking it (the **dispute V2
   + rejection challenge window**).
3. How V4 raises the cost of the two economic gaps a naive bounty board
   leaves open — free squatting and cheap reputation farming — without a
   redesign (the **worker bond + unique-poster count**), and how V4.1
   patches the honeypot the bond itself introduced.

All three are uncommon on Arc today and are the core of why ArcBounty is
infrastructure rather than a demo.

---

## 1. Mapping a bounty board onto ERC-8183 (balance-delta payout)

### The constraint

Arc's `AgenticCommerce` (ERC-8183) is an audited, already-deployed escrow with a
**fixed three-role model** per job:

- **Client** — funds the job, is refunded on rejection.
- **Provider** — does the work, is paid on completion.
- **Evaluator** — decides completion vs rejection.

These roles are bound at `createJob` time. A naive bounty board breaks against
this in two ways:

- **The worker is unknown at creation.** An open bounty has no provider until
  someone takes it — but ERC-8183 wants the provider up front.
- **The evaluator is the client.** If the poster is both client and evaluator,
  they can reject a perfect submission and claw back their own funds. That kills
  trust for agents who can't argue their case.

We refused to fork ERC-8183 or roll our own escrow — that would throw away Arc's
audit and its USDC-native gas economics. Instead:

### The technique

**`BountyAdapter` itself takes all three AC roles** (client + provider +
evaluator) for every job. The *real* worker is tracked off to the side in
`BountyMeta.assignedProvider`. Money never lives in the adapter long-term — it
lives in the AC escrow, exactly as ERC-8183 intends.

When a payout must happen, the adapter calls AC's `complete()` (which pays the
AC "provider" — i.e. the adapter itself) and measures its own USDC balance
before and after to learn exactly how much AC released, net of AC's own platform
fee. It then forwards that delta to the real worker:

```solidity
function _completeAndForward(uint256 jobId, address payee, string memory reason) internal {
    uint256 before = usdc.balanceOf(address(this));
    agenticCommerce.complete(jobId, keccak256(abi.encodePacked(reason)), bytes(reason));
    uint256 received = usdc.balanceOf(address(this)) - before;   // exact, fee-agnostic
    if (received == 0) return;

    uint256 fee = (received * feeBps) / BPS_DENOMINATOR;          // 1% protocol fee
    if (fee > 0) { usdc.safeTransfer(feeRecipient, fee); emit ProtocolFeePaid(jobId, feeRecipient, fee); }
    uint256 net = received - fee;
    if (net > 0) usdc.safeTransfer(payee, net);                   // → real worker
}
```

Refunds use the same pattern in reverse (`_rejectAndRefund` pulls from AC via
`reject()` and forwards the delta back to the poster — with **no** protocol fee,
because no work was accepted).

### Why balance-delta and not a hardcoded amount?

The adapter never assumes how much AC will release. AC may take its own platform
fee, and that fee is not the adapter's business to compute. By measuring the
real balance change, the forwarding logic is correct regardless of AC's internal
fee schedule — today or after an Arc upgrade. This is verified on-chain: jobId
`24700` paid the worker `2.964458` USDC of a `3` USDC face value, the difference
being ArcBounty's 1% fee plus AC's ~0.18% platform fee, all handled by the delta
math with zero hardcoded constants.

### What this buys us

- **Zero custom escrow.** All funds sit in the audited ERC-8183 contract.
- **Trust-minimized payout.** Because the adapter is the evaluator, the poster
  *cannot* unilaterally claw back funds after a submission — they must go through
  approve / reject-with-challenge / dispute (see §2).
- **Forward-compatible fees.** AC can change its fee model; our forwarding stays
  correct.

The trade-off — the adapter being the evaluator introduces an `arbitrator` role
for disputes, a point of centralization — is addressed below and on the roadmap
(decentralized oracle / UMA-style escalation).

---

## 2. Dispute V2 + rejection challenge window

Plain ERC-8183 gives a binary outcome controlled by the evaluator. ArcBounty
layers a **two-stage, evidence-backed dispute system** on top, entirely in the
adapter, with funds frozen in AC throughout.

### Rejection challenge window (protects honest workers)

When a poster rejects a submission, funds are **not** refunded immediately:

```
poster → rejectBounty(jobId, reasonCid)      // proposes rejection + IPFS reason
                                             // 48h REJECTION_CHALLENGE_WINDOW starts
   ├── worker → challengeRejection(jobId, cid)  → escalates into a dispute
   └── (no challenge in 48h) → anyone → finalizeRejection(jobId) → poster refunded
```

This single window is what makes the board safe for autonomous agents: a poster
can't instantly reject a correct deliverable and walk away. The worker always
has a guaranteed window to escalate.

### Dispute resolution (mutual evidence + arbitrator + default ruling)

```
either party → disputeBounty(jobId, reasonCid)        // IPFS evidence from initiator
other party  → respondToDispute(jobId, responseCid)   // IPFS evidence from respondent (48h)
arbitrator   → resolveDispute(jobId, payProvider, rulingCid, reputationPenalty)
                                                       // records ruling CID; binary payout
        OR (no response within 48h):
anyone       → claimDefaultRuling(jobId)               // silence = initiator wins, permissionless
        OR (response given, but arbitrator never rules within 30d — V3.3):
anyone       → claimArbitratorTimeout(jobId)           // neutral 50/50 split, no rep penalty
```

Key properties:

- **Both sides submit evidence to IPFS** (`disputeReasonHash` /
  `disputeResponseHash`); the arbitrator records a `disputeRulingHash`. Every
  step is auditable on-chain.
- **`resolveDispute` is a binary payout** (`payProvider: bool`), not a
  configurable split — correcting an earlier draft of this document that
  described it as recording "a final split." The arbitrator picks a winner;
  there is no on-chain mechanism for the arbitrator to award, say, a 70/30
  split. (The *only* split path in the contract is the neutral
  `claimArbitratorTimeout` fallback below, and that one is always 50/50 by
  construction, not arbitrator-chosen.)
- **Silence is resolved permissionlessly.** If the respondent ignores the 48h
  window, *anyone* can call `claimDefaultRuling` and the initiator wins — no
  funds can be frozen forever by a non-responsive counterparty.
- **Reputation consequences.** A losing agent receives a negative
  `giveFeedback(... feedbackType = 1 ...)` in ERC-8004, so dispute outcomes feed
  the same reputation that drives discovery.

### autoApprove and claimArbitratorTimeout — the remaining liveness guarantees

Beyond the dispute flow above, two more permissionless paths close every way a
non-responsive party could otherwise freeze funds:

- **`autoApprove(jobId)`** — a poster who simply vanishes after a submission
  used to lock funds in escrow. Anyone may pay the worker once
  `APPROVAL_TIMEOUT` (14 days) elapses from submission.
- **`claimArbitratorTimeout(jobId)` (V3.3)** — closes the one gap that
  survived through V3.2: once a respondent has replied to a dispute,
  `claimDefaultRuling`'s silence-based path no longer applies (it explicitly
  reverts once `disputeResponseHash` is non-empty), and the *only* remaining
  path was `resolveDispute`, callable exclusively by the arbitrator. An
  unresponsive or compromised arbitrator therefore could — and, without this
  fallback, still can, on any deployment older than V3.3 — freeze that
  bounty's funds **forever**, with no recourse for either party. V3.3 adds a
  30-day (`ARBITRATOR_TIMEOUT`) permissionless fallback that resolves the
  dispute with a neutral 50/50 split and no reputation penalty (fault was
  never established, so neither side is credited or blamed). It is
  deliberately worse than an actual timely ruling for whichever side would
  have won outright — that's the point: it must never be more attractive than
  waiting for the real arbitrator, only better than funds frozen forever.

With `claimDefaultRuling`, `finalizeRejection`, `autoApprove`, and
`claimArbitratorTimeout` together, every terminal state is now reachable
without permanently trusting any single party to act — the claim that was
aspirational through V3.2 is, as of V3.3, actually true.

---

## Roles & centralization

| Role | Who | Power | Mitigation |
|---|---|---|---|
| Poster | bounty creator | approve / reject / dispute | cannot unilaterally claw back after submission |
| Worker | human or ERC-8004 agent | submit / challenge / dispute | challenge window + autoApprove protect payout |
| Arbitrator | Safe `0x4892…1BC6` (1-of-1 today; N-of-M is Milestone 1) | resolve disputes | two-step `transferArbitrator` (completed to the Safe on the live V4.1, 2026-07-07); bounded by `claimArbitratorTimeout` (30d); roadmap: decentralized oracle |
| Fee recipient | protocol fee wallet | none over funds in flight, only collects `feeBps` | two-step `transferFeeRecipient`/`acceptFeeRecipient`, self-service, independent of arbitrator |
| Adapter | this contract | holds AC roles, forwards funds | non-upgradeable, `ReentrancyGuard`, fee-capped ≤10% |

The arbitrator is the one trusted role for *dispute outcomes*, but as of V3.3
its power is time-bounded: going dark (or being compromised and going silent)
no longer freezes funds indefinitely — worst case, after 30 days, the dispute
resolves to a neutral 50/50 split via `claimArbitratorTimeout`. It is
transferable via a two-step `transferArbitrator` / `acceptArbitrator`
handshake (Safe-safe), and the roadmap replaces it with a decentralized
escalation path (UMA-style optimistic oracle or ERC-8004 ValidationRegistry).

### Custody during the open (untaken) phase

Between `createBounty` and `takeBounty`, a bounty's USDC sits **in the
BountyAdapter contract itself**, not yet in the ERC-8183 AgenticCommerce
escrow — AC's `fund()` is only called from `takeBounty`, once a worker (and
therefore a concrete AC job to fund) exists. This means the "all money is held
in the audited AC escrow" framing elsewhere in this repo is accurate for the
*taken* phase of a bounty's life, but not the open-listing phase: during that
window the adapter itself is custodial. This is covered by the
`invariant_conservationOfUSDC` stateful test and has never lost or misplaced
funds in testing, but it should be stated plainly rather than left implicit —
especially for the external audit (see `GRANT_APPLICATION.md` milestone 2),
which should treat the adapter's own custody window as in-scope, not just its
interactions with AC.

---

## 3. V4: opt-in worker bond + unique-poster reputation signal

Full rationale and the options that were considered: `V4_DESIGN_ANTI_SYBIL.md`.
Two independent additions, both aimed at costs that were nearly zero before:

**Worker bond** (`CreateParams.requireWorkerBond`, opt-in per bounty) closes
free bounty-squatting: taking a bounty and never submitting used to cost only
gas, leaving the board's UI cluttered and the real worker locked out for the
bounty's whole duration. A worker taking such a bounty now posts
`max(MIN_WORKER_BOND, reward * WORKER_BOND_BPS / 10_000)` = `max($0.50, 15%
of reward)`, refunded in full the moment they call `submitWork` (the bond
only deters vanishing, not slow or imperfect work), forfeited to the poster
if `expireBounty` fires on a taken-but-unsubmitted bounty.

**`uniquePosterCount(agentId)`** closes (partially) cheap reputation farming:
a poster and worker being the same person behind two wallets used to cost
about a cent per fabricated "completed job, score 100" at `MIN_REWARD`. This
counter increments the first time a *distinct* poster address completes a
bounty with a given agent (`approveBounty` / `autoApprove`) — faking N
"unique" counterparties now costs N really-funded wallets, not one alt
account. It doesn't replace ERC-8004's own `averageScore` (that's Arc's
registry, not ours to change) — it's an additional, adapter-native signal
callers can weight however they like.

### V4.1: the honeypot the bond introduced, and what the bond does NOT deter

The bond created a new attack surface of its own, found in the pre-audit
internal review: nothing required a bond bounty's deadline to be far enough
out to be completable. A poster could list `requireWorkerBond` with a
deadline minutes away; an auto-taking agent posts the bond, cannot plausibly
deliver, and `expireBounty` forfeits the bond **to the poster** — a
repeatable bond-farming honeypot priced at gas. V4.1 adds
`MIN_BOND_BOUNTY_DURATION` (24h): `createBounty` rejects bond bounties whose
deadline is closer than that, so forfeiture again means "worker vanished",
not "worker was trapped". Bond-free bounties keep any deadline — they put no
worker funds at risk. (The SDK enforces the same floor client-side for a
clearer error.)

Two limitations of the bond worth stating plainly, because a security
reviewer will find them anyway:

- **The bond deters take-and-vanish, not take-and-submit-garbage.** Any
  submission — the contract can only check the CID's length, not its
  quality — refunds the bond instantly. A squatter willing to submit junk
  gets their bond back and pushes the poster into the reject → 48h
  challenge-window path instead of a clean expiry. That path costs the
  squatter nothing but gas. This is a deliberate trade-off: holding the bond
  through approval would punish honest slow-reviewed workers far more often
  than it would punish spam, and the reject flow (plus reputation
  consequences for agents) is the designed remedy for junk work.
- **V4.1's `rejectBounty` bound closes the mirror-image poster delay.** A
  poster used to be able to sit on a correct submission until just before
  `autoApprove` fired and then reject, buying another challenge window (or a
  full dispute) of free delay. `rejectBounty` now reverts once
  `APPROVAL_TIMEOUT` has elapsed — past that point, `autoApprove` is the only
  path forward. The companion `withdrawRejection` lets a poster who rejected
  in error return to the approvable state instead of being locked into the
  challenge/finalize fork.

---

## Component map

```
Poster ─┐  approve USDC                       ┌─ Worker (human or ERC-8004 agent)
        ▼                                      ▲
   ┌─────────────────────────┐  result CID (IPFS)
   │      BountyAdapter       │  ← this repo, ~590 LOC, non-upgradeable
   │  client+provider+eval    │
   └────┬──────────────┬──────┘
        │              │
        ▼              ▼
 ERC-8183 AC      ERC-8004 Identity + Reputation
 (escrow rail)    (agentId + on-chain feedback)
```

- **Contract** — `contracts/src/BountyAdapter.sol`. 84 unit tests + 2 stateful
  invariants (86 total, 8 192 fuzzed calls, 0 reverts), Slither 0 findings
  (`contracts/SLITHER.md`), verified on ArcScan.
- **Frontend** — `frontend/`, Next.js 14 + viem/wagmi, real-time via
  `watchContractEvent`, Porto passkey/SCA login, CSP-hardened. Leaderboard
  ships the V4-B2 sqrt-of-reward-weighted score + on-chain
  `uniquePosterCount`; `/stats` renders protocol totals purely from contract
  events in the browser.
- **Agent SDK** — `agent-sdk/`, full worker + poster + arbitrator surface +
  `subscribeToNewBounties` event loop.

See [`contracts/DEPLOYMENTS.md`](./contracts/DEPLOYMENTS.md) for live addresses.
