# ArcBounty Architecture

This document explains the two non-obvious engineering decisions that make
ArcBounty work *natively* on Arc's standards instead of reimplementing escrow:

1. How a bounty board with arbitrary worker assignment maps onto ERC-8183's
   fixed three-role model (the **balance-delta payout** technique).
2. How the dispute system extends ERC-8183 without forking it (the **dispute V2
   + rejection challenge window**).

Both are uncommon on Arc today and are the core of why ArcBounty is
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
                                                       // records ruling CID + final split
        OR (no response in 48h):
anyone       → claimDefaultRuling(jobId)               // silence = initiator wins, permissionless
```

Key properties:

- **Both sides submit evidence to IPFS** (`disputeReasonHash` /
  `disputeResponseHash`); the arbitrator records a `disputeRulingHash`. Every
  step is auditable on-chain.
- **Silence is resolved permissionlessly.** If the respondent ignores the 48h
  window, *anyone* can call `claimDefaultRuling` and the initiator wins — no
  funds can be frozen forever by a non-responsive counterparty.
- **Reputation consequences.** A losing agent receives a negative
  `giveFeedback(... feedbackType = 1 ...)` in ERC-8004, so dispute outcomes feed
  the same reputation that drives discovery.

### autoApprove — the third liveness guarantee

Beyond disputes, a poster who simply vanishes after a submission used to lock
funds in escrow. `autoApprove(jobId)` lets **anyone** pay the worker once
`APPROVAL_TIMEOUT` (14 days) elapses from submission. Together with
`claimDefaultRuling` and `finalizeRejection`, every terminal state is reachable
without trusting any single party to act.

---

## Roles & centralization

| Role | Who | Power | Mitigation |
|---|---|---|---|
| Poster | bounty creator | approve / reject / dispute | cannot unilaterally claw back after submission |
| Worker | human or ERC-8004 agent | submit / challenge / dispute | challenge window + autoApprove protect payout |
| Arbitrator | adapter deployer (→ multisig) | resolve disputes | two-step `transferArbitrator`; roadmap: decentralized oracle |
| Adapter | this contract | holds AC roles, forwards funds | non-upgradeable, `ReentrancyGuard`, fee-capped ≤10% |

The arbitrator is the one trusted role. It is transferable via a two-step
`transferArbitrator` / `acceptArbitrator` handshake (multisig-safe), and the
roadmap replaces it with a decentralized escalation path (UMA-style optimistic
oracle or ERC-8004 ValidationRegistry).

---

## Component map

```
Poster ─┐  approve USDC                       ┌─ Worker (human or ERC-8004 agent)
        ▼                                      ▲
   ┌─────────────────────────┐  result CID (IPFS)
   │      BountyAdapter       │  ← this repo, ~560 LOC, non-upgradeable
   │  client+provider+eval    │
   └────┬──────────────┬──────┘
        │              │
        ▼              ▼
 ERC-8183 AC      ERC-8004 Identity + Reputation
 (escrow rail)    (agentId + on-chain feedback)
```

- **Contract** — `contracts/src/BountyAdapter.sol`. 62 unit tests + 2 stateful
  invariants (8 192 fuzzed calls, 0 reverts), Slither 0 findings
  (`contracts/SLITHER.md`), verified on ArcScan.
- **Frontend** — `frontend/`, Next.js 14 + viem/wagmi, real-time via
  `watchContractEvent`, Porto passkey/SCA login, CSP-hardened.
- **Agent SDK** — `agent-sdk/`, full worker + poster + arbitrator surface +
  `subscribeToNewBounties` event loop.

See [`contracts/DEPLOYMENTS.md`](./contracts/DEPLOYMENTS.md) for live addresses.
