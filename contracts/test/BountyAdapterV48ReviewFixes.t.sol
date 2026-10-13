// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "./BountyAdapterV48ContestDispute.t.sol";

/// @notice Regression tests for the fixes that came out of the 2026-10-13 internal review of the first
///         V4.8 deployment: no reputation for self-dealt jobs, a time guard on acceptContestChallengers
///         and a way for a poster to retract "reject all" before anyone challenged it.
contract BountyAdapterV48ReviewFixesTest is V48ContestDisputeCases {
    event ContestRejectionWithdrawn(uint256 indexed jobId);

    function _single() internal returns (uint256 job) {
        BountyAdapterV48.CreateParams memory p = _params();
        p.contest = false;
        p.maxEntries = 0;
        p.winners = 0;
        job = _create(p);
    }

    function _work(uint256 job, address worker, uint256 agentId) internal {
        vm.prank(worker);
        adapter.takeBounty(job, agentId);
        vm.prank(worker);
        adapter.submitWork(job, "ipfs://result");
    }

    // ─── Self-dealt jobs pay out but earn no reputation ───────────────────────────────────────────

    function testSelfPostedWalletJobPaysButEarnsNoReputation() public {
        uint256 job = _single();
        _work(job, POSTER, 0);
        vm.prank(POSTER);
        adapter.approveBounty(job, 90);
        assertTrue(adapter.getBountyMeta(job).resolved);
        assertEq(usdc.balanceOf(FEE), REWARD / 100, "the fee is still taken");
        _local(0, POSTER, 0, 0);
        assertEq(reputation.getFeedbackCount(), 0);
    }

    function testJobWhoseIdentityIsOwnedByThePosterEarnsNoReputation() public {
        identity.setOwner(2, POSTER);
        identity.setWallet(2, OTHER);
        uint256 job = _single();
        _work(job, OTHER, 2);
        vm.prank(POSTER);
        adapter.approveBounty(job, 90);
        assertTrue(adapter.getBountyMeta(job).resolved);
        _local(2, address(0), 0, 0);
        assertEq(adapter.uniquePosterCount(2), 0);
        assertEq(reputation.getFeedbackCount(), 0);
    }

    function testIndependentWorkerStillEarnsReputation() public {
        uint256 job = _single();
        _work(job, WORKING, 1);
        vm.prank(POSTER);
        adapter.approveBounty(job, 90);
        _local(1, address(0), 1, 90);
        assertEq(adapter.uniquePosterCount(1), 1);
        assertEq(reputation.getFeedbackCount(), 1);
    }

    function testSelfDealtAutoApproveEarnsNoReputation() public {
        identity.setOwner(2, POSTER);
        identity.setWallet(2, OTHER);
        uint256 job = _single();
        _work(job, OTHER, 2);
        vm.warp(block.timestamp + 14 days + 1);
        adapter.autoApprove(job);
        assertTrue(adapter.getBountyMeta(job).resolved);
        _local(2, address(0), 0, 0);
        assertEq(adapter.uniquePosterCount(2), 0);
        assertEq(reputation.getFeedbackCount(), 0);
    }

    function testIndependentAutoApproveStillEarnsTheDefaultScore() public {
        uint256 job = _single();
        _work(job, WORKING, 1);
        vm.warp(block.timestamp + 14 days + 1);
        adapter.autoApprove(job);
        _local(1, address(0), 1, 80);
        assertEq(adapter.uniquePosterCount(1), 1);
    }

    function testPosterEnteringTheirOwnContestEarnsNoReputation() public {
        uint256 job = _create(_params());
        _enter(job, POSTER, 0);
        _enter(job, HUMAN, 0);
        _closed(job);
        _pick(job, 2);
        assertTrue(adapter.getBountyMeta(job).resolved);
        _local(0, POSTER, 0, 0);
        _local(0, HUMAN, 1, 90);
    }

    function testContestEntryByAnIdentityTheOwnerPostedForEarnsNoReputation() public {
        identity.setOwner(2, POSTER);
        identity.setWallet(2, OTHER);
        uint256 job = _create(_params());
        _enter(job, OTHER, 2);
        _enter(job, WORKING, 1);
        _closed(job);
        _pick(job, 2);
        _local(2, address(0), 0, 0);
        assertEq(adapter.uniquePosterCount(2), 0);
        _local(1, address(0), 1, 90);
        assertEq(adapter.uniquePosterCount(1), 1);
        assertEq(reputation.getFeedbackCount(), 1, "only the independent identity is credited");
    }

    // ─── acceptContestChallengers has the same time limits as respondToContestChallenges ─────────

    function testAcceptChallengersAfterAnUnansweredChallengeIsOverdueReverts() public {
        uint256 job = _rejected();
        _challenge(job, 0, WORKING);
        _afterChallengeWindow(job);
        vm.prank(POSTER);
        vm.expectRevert("response window closed");
        adapter.acceptContestChallengers(job, _indices(1), new uint8[](1));
        // The permissionless default still pays every challenger.
        adapter.claimContestDefault(job);
        assertTrue(adapter.getBountyMeta(job).resolved);
    }

    function testAcceptChallengersAfterTheArbitratorWindowEndedReverts() public {
        uint256 job = _rejected();
        _challenge(job, 0, WORKING);
        _respond(job);
        vm.warp(adapter.getBountyMeta(job).disputeRaisedAt + 30 days + 1);
        vm.prank(POSTER);
        vm.expectRevert("arbitrator window ended");
        adapter.acceptContestChallengers(job, _indices(1), new uint8[](1));
        adapter.claimContestArbitratorTimeout(job);
        assertTrue(adapter.getBountyMeta(job).resolved);
    }

    function testAcceptChallengersWithoutAnyChallengeReverts() public {
        uint256 job = _rejected();
        vm.prank(POSTER);
        vm.expectRevert("no challenges");
        adapter.acceptContestChallengers(job, _indices(1), new uint8[](1));
    }

    function testAcceptChallengersInsideTheWindowStillWorks() public {
        uint256 job = _rejected();
        _challenge(job, 0, WORKING);
        _respond(job);
        _accept(job, 1);
        assertTrue(adapter.getBountyMeta(job).resolved);
        _local(1, address(0), 1, 90);
    }

    // ─── withdrawContestRejection ─────────────────────────────────────────────────────────────────

    function testPosterCanRetractRejectAllAndThenPick() public {
        uint256 job = _rejected();
        vm.prank(HUMAN);
        vm.expectRevert("only poster");
        adapter.withdrawContestRejection(job);

        vm.expectEmit(true, false, false, false, address(adapter));
        emit ContestRejectionWithdrawn(job);
        vm.prank(POSTER);
        adapter.withdrawContestRejection(job);
        BountyAdapterV48.BountyMeta memory meta = adapter.getBountyMeta(job);
        assertEq(meta.rejectedAt, 0);
        assertEq(bytes(meta.rejectionReasonHash).length, 0);

        _pick(job, 2);
        assertTrue(adapter.getBountyMeta(job).resolved);
        _local(1, address(0), 1, 90);
        _local(0, HUMAN, 1, 90);
    }

    function testRetractionCannotExtendTheReviewWindow() public {
        uint256 job = _rejected();
        uint256 closed = adapter.contestClosedAt(job);
        vm.warp(closed + 13 days);
        vm.prank(POSTER);
        adapter.withdrawContestRejection(job);

        vm.warp(closed + 14 days + 1);
        uint8[] memory scores = new uint8[](1);
        scores[0] = 90;
        vm.prank(POSTER);
        vm.expectRevert("review ended");
        adapter.pickContestWinners(job, _indices(1), scores);

        adapter.settleContestSilence(job);
        assertTrue(adapter.getBountyMeta(job).resolved);
    }

    function testRetractionRevertsAfterAChallengeOrWithoutARejectionOrAfterSettlement() public {
        uint256 fresh = _create(_params());
        _enter(fresh, HUMAN, 0);
        vm.prank(POSTER);
        vm.expectRevert("no pending rejection");
        adapter.withdrawContestRejection(fresh);

        uint256 job = _rejected();
        _challenge(job, 0, WORKING);
        vm.prank(POSTER);
        vm.expectRevert("already challenged");
        adapter.withdrawContestRejection(job);

        uint256 refunded = _rejected();
        _afterChallengeWindow(refunded);
        adapter.finalizeContestRejection(refunded);
        vm.prank(POSTER);
        vm.expectRevert("resolved");
        adapter.withdrawContestRejection(refunded);
    }

    function testRetractionStillWorksWhilePaused() public {
        uint256 job = _rejected();
        adapter.setPaused(true);
        vm.prank(POSTER);
        adapter.withdrawContestRejection(job);
        assertEq(adapter.getBountyMeta(job).rejectedAt, 0);
    }
}
