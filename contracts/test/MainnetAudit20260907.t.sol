// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "forge-std/Test.sol";
import "../src/BountyAdapter.sol";
import "../src/base/AgenticCommerce.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MockUSDC, MockIdentityRegistry, MockReputationRegistry} from "./BountyAdapter.t.sol";

/// @notice Regression suite for the 2026-09-07 audit's two P0 findings (C-01,
/// C-02) and M-01, against the real repository AgenticCommerce implementation
/// (not MockAgenticCommerce). These started as PoCs where PASS proved the
/// vulnerability; they now assert the fixed, safe outcome instead.
contract MainnetAudit20260907Test is Test {
    MockUSDC token;
    AgenticCommerce escrow;
    BountyAdapter adapter;
    address poster = address(0x1001);
    address worker = address(0x1002);
    address attacker = address(0xBAD);
    uint256 constant REWARD = 100e6;

    function setUp() public {
        token = new MockUSDC();
        AgenticCommerce impl = new AgenticCommerce();
        escrow = AgenticCommerce(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(AgenticCommerce.initialize, (address(token), address(0xFEE), address(this)))
                )
            )
        );
        adapter = new BountyAdapter(
            address(escrow),
            address(new MockIdentityRegistry()),
            address(new MockReputationRegistry()),
            address(token),
            address(0xFEE),
            100,
            500e6
        );
        token.mint(poster, REWARD);
        token.mint(attacker, REWARD);
        vm.prank(poster);
        token.approve(address(adapter), type(uint256).max);
        vm.prank(attacker);
        token.approve(address(adapter), type(uint256).max);
    }

    function create(address who, uint256 deadline) internal returns (uint256) {
        BountyAdapter.CreateParams memory p = BountyAdapter.CreateParams({
            provider: address(0),
            reward: REWARD,
            deadline: deadline,
            ipfsDescHash: "ipfs://audit-description",
            category: "dev",
            tags: new string[](0),
            agentOnly: false,
            humanOnly: false,
            requireWorkerBond: false
        });
        vm.prank(who);
        return adapter.createBounty(p);
    }

    // ─── C-01: cancelled bounty can no longer be retaken ──────────────────────

    function testRegression_CancelledBountyCannotBeRetaken() public {
        uint256 victimJob = create(poster, block.timestamp + 7 days);
        uint256 cancelledJob = create(attacker, block.timestamp + 3650 days);
        vm.prank(attacker);
        adapter.cancelBounty(cancelledJob);
        assertEq(token.balanceOf(attacker), REWARD, "attacker recovered full capital");

        vm.prank(attacker);
        vm.expectRevert("resolved");
        adapter.takeBounty(cancelledJob, 0);

        // The victim's own deposit was never touched — their cancel refunds
        // directly, no pendingWithdrawals credit needed.
        vm.prank(poster);
        adapter.cancelBounty(victimJob);
        assertEq(token.balanceOf(poster), REWARD, "victim refunded directly");
        assertEq(adapter.pendingWithdrawals(poster), 0, "no phantom withdrawal credit");
    }

    // ─── C-02: AC's expiry buffer + reconcile safety net ──────────────────────

    function testRegression_DirectRefundBlockedBeforeBuffer() public {
        uint256 deadline = block.timestamp + 1 days;
        uint256 job = create(poster, deadline);
        vm.prank(worker);
        adapter.takeBounty(job, 0);
        vm.prank(worker);
        adapter.submitWork(job, "ipfs://audit-result");
        vm.warp(deadline + 1);

        // AC's expiredAt is now deadline + AC_EXPIRY_BUFFER, not the bounty's
        // own deadline — a stranger can no longer force AC to refund right
        // after the bounty deadline while the adapter's approval window (up
        // to 14 more days) is still open.
        vm.prank(attacker);
        vm.expectRevert(AgenticCommerce.WrongStatus.selector);
        escrow.claimRefund(job);

        // The normal adapter path is unaffected by the larger buffer.
        vm.prank(poster);
        adapter.approveBounty(job, 100);
        assertTrue(adapter.getBountyMeta(job).resolved);
        assertEq(token.balanceOf(worker), REWARD - REWARD / 100);
    }

    function testRegression_ExternalRefundAfterBufferPaysWorker() public {
        uint256 deadline = block.timestamp + 1 days;
        uint256 job = create(poster, deadline);
        vm.prank(worker);
        adapter.takeBounty(job, 0);
        vm.prank(worker);
        adapter.submitWork(job, "ipfs://audit-result");

        // Simulate a total liveness failure: nobody approves, rejects, or
        // disputes for the entire AC_EXPIRY_BUFFER window past the deadline.
        vm.warp(deadline + adapter.AC_EXPIRY_BUFFER() + 1);
        escrow.claimRefund(job); // now legitimately reachable, permissionless
        assertEq(uint256(escrow.getJob(job).status), uint256(AgenticCommerce.JobStatus.Expired));
        assertEq(token.balanceOf(address(adapter)), REWARD, "refund landed back on the adapter");

        adapter.reconcileExpiredEscrow(job);
        assertTrue(adapter.getBountyMeta(job).resolved);
        // worker isn't blacklisted, so _payOrPark pushes directly rather than
        // parking - unlike the original bug, where this money was simply
        // stuck in the adapter's balance with no per-job record at all.
        assertEq(token.balanceOf(worker), REWARD, "submitted, undisputed -> full reward pushed to worker");
        assertEq(adapter.pendingWithdrawals(worker), 0, "pushed directly, nothing parked");
        assertEq(adapter.pendingWithdrawals(poster), 0);
    }

    function testRegression_ExternalRefundAfterBufferSplitsWhenDisputed() public {
        uint256 deadline = block.timestamp + 1 days;
        uint256 job = create(poster, deadline);
        vm.prank(worker);
        adapter.takeBounty(job, 0);
        vm.prank(worker);
        adapter.submitWork(job, "ipfs://audit-result");
        vm.prank(poster);
        adapter.disputeBounty(job, "ipfs://audit-dispute");
        vm.prank(worker);
        adapter.respondToDispute(job, "ipfs://audit-response");
        // Arbitrator never rules, and nobody claims the arbitrator timeout.

        vm.warp(deadline + adapter.AC_EXPIRY_BUFFER() + 1);
        escrow.claimRefund(job);

        adapter.reconcileExpiredEscrow(job);
        assertEq(token.balanceOf(poster), REWARD / 2, "unresolved dispute -> neutral split, pushed directly");
        assertEq(token.balanceOf(worker), REWARD - REWARD / 2);
        assertEq(adapter.pendingWithdrawals(poster), 0);
        assertEq(adapter.pendingWithdrawals(worker), 0);
        assertFalse(adapter.getBountyMeta(job).inDispute, "must not read as still in dispute once resolved");
    }

    // A code-review pass on this same fix caught two real bugs in the first
    // draft of reconcileExpiredEscrow before they shipped: it ignored
    // `rejectedAt` entirely (paying the worker in full even when the poster
    // had correctly rejected the work and the worker just never challenged),
    // and its disputed branch always did a neutral 50/50 split even when one
    // side never responded (should mirror claimDefaultRuling, not
    // claimArbitratorTimeout, in that case). These two tests pin down the
    // corrected behavior.

    function testRegression_ReconcileRejectedNeverChallengedRefundsPoster() public {
        uint256 deadline = block.timestamp + 1 days;
        uint256 job = create(poster, deadline);
        vm.prank(worker);
        adapter.takeBounty(job, 0);
        vm.prank(worker);
        adapter.submitWork(job, "ipfs://audit-result");
        vm.prank(poster);
        adapter.rejectBounty(job, "ipfs://audit-rejection");
        // Worker never calls challengeRejection, and nobody ever calls the
        // permissionless finalizeRejection either - the specific neglect
        // this safety net exists for.

        vm.warp(deadline + adapter.AC_EXPIRY_BUFFER() + 1);
        escrow.claimRefund(job);

        adapter.reconcileExpiredEscrow(job);
        assertEq(token.balanceOf(poster), REWARD, "rejected and unchallenged -> poster refunded, not worker paid");
        assertEq(token.balanceOf(worker), 0);
    }

    // Poster-initiated, worker (respondent) never replies -> claimDefaultRuling
    // would refund the poster.
    function testRegression_ReconcileDisputeNoResponsePosterWinsWhenWorkerSilent() public {
        uint256 deadline = block.timestamp + 1 days;
        uint256 job = create(poster, deadline);
        vm.prank(worker);
        adapter.takeBounty(job, 0);
        vm.prank(worker);
        adapter.submitWork(job, "ipfs://audit-result");
        vm.prank(poster);
        adapter.disputeBounty(job, "ipfs://audit-dispute");
        // Worker (respondent) never calls respondToDispute.

        vm.warp(deadline + adapter.AC_EXPIRY_BUFFER() + 1);
        escrow.claimRefund(job);
        adapter.reconcileExpiredEscrow(job);
        assertEq(token.balanceOf(poster), REWARD, "poster-initiated, worker silent -> poster wins by default");
        assertEq(token.balanceOf(worker), 0);
        assertFalse(adapter.getBountyMeta(job).inDispute);
    }

    // Worker-initiated (via challenging a rejection - also exercises
    // rejectedAt staying set alongside inDispute), poster (respondent) never
    // replies -> claimDefaultRuling would pay the worker.
    function testRegression_ReconcileDisputeNoResponseWorkerWinsWhenPosterSilent() public {
        uint256 deadline = block.timestamp + 1 days;
        uint256 job = create(poster, deadline);
        vm.prank(worker);
        adapter.takeBounty(job, 0);
        vm.prank(worker);
        adapter.submitWork(job, "ipfs://audit-result");
        vm.prank(poster);
        adapter.rejectBounty(job, "ipfs://audit-rejection");
        vm.prank(worker);
        adapter.challengeRejection(job, "ipfs://audit-challenge");
        assertTrue(adapter.getBountyMeta(job).rejectedAt > 0, "rejectedAt stays set through a challenge");
        // Poster (respondent) never calls respondToDispute.

        vm.warp(deadline + adapter.AC_EXPIRY_BUFFER() + 1);
        escrow.claimRefund(job);
        adapter.reconcileExpiredEscrow(job);
        assertEq(
            token.balanceOf(worker), REWARD, "worker challenged (initiator), poster silent -> worker wins by default"
        );
        assertEq(token.balanceOf(poster), 0);
        assertFalse(adapter.getBountyMeta(job).inDispute);
    }

    function testRegression_ExternalRefundAfterBufferRefundsPosterWhenUnsubmitted() public {
        uint256 deadline = block.timestamp + 1 days;
        uint256 job = create(poster, deadline);
        vm.prank(worker);
        adapter.takeBounty(job, 0);
        // Never submitted.

        vm.warp(deadline + adapter.AC_EXPIRY_BUFFER() + 1);
        escrow.claimRefund(job);

        adapter.reconcileExpiredEscrow(job);
        assertEq(token.balanceOf(poster), REWARD, "nothing delivered -> poster refunded, pushed directly");
        assertEq(adapter.pendingWithdrawals(poster), 0, "pushed directly, nothing parked");
    }

    // ─── M-01: reputation penalty now pulls the average down, not up ─────────

    function testRegression_MaximumReputationPenaltyWritesNegative100() public {
        MockIdentityRegistry(address(adapter.identityRegistry())).setOwner(1, worker);
        uint256 job = create(poster, block.timestamp + 7 days);
        vm.prank(worker);
        adapter.takeBounty(job, 1);
        vm.prank(worker);
        adapter.submitWork(job, "ipfs://audit-result");
        vm.prank(poster);
        adapter.disputeBounty(job, "ipfs://audit-dispute");
        adapter.resolveDispute(job, false, "ipfs://audit-ruling", 100);
        (uint256 id, int256 score,) = MockReputationRegistry(address(adapter.reputationRegistry())).feedbackCalls(0);
        assertEq(id, 1);
        assertEq(score, -100, "maximum penalty now recorded as -100, pulling the average down");
    }
}
