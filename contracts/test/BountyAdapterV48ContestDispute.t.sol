// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "./BountyAdapterV48Contest.t.sol";

abstract contract V48ContestDisputeCases is V48ContestFixture {
    function _rejected() internal returns (uint256 job) {
        job = _create(_params());
        _enter(job, WORKING, 1);
        _enter(job, HUMAN, 0);
        _enter(job, OTHER, 0);
        _closed(job);
        vm.prank(POSTER);
        adapter.rejectAllContestEntries(job, "ipfs://reject");
    }

    function _challenge(uint256 job, uint8 index, address caller) internal {
        vm.prank(caller);
        adapter.challengeContestRejection(job, index, "ipfs://evidence");
    }

    function _respond(uint256 job) internal {
        vm.prank(POSTER);
        adapter.respondToContestChallenges(job, "ipfs://response");
    }

    function _afterChallengeWindow(uint256 job) internal {
        vm.warp(adapter.getBountyMeta(job).rejectedAt + 48 hours + 1);
    }

    function _accept(uint256 job, uint8 count) internal {
        uint8[] memory scores = new uint8[](count);
        for (uint256 i; i < count; ++i) {
            scores[i] = 90;
        }
        vm.prank(POSTER);
        adapter.acceptContestChallengers(job, _indices(count), scores);
    }

    function _assertUnscored(uint256 job) internal view {
        _local(1, address(0), 0, 0);
        _local(0, HUMAN, 0, 0);
        _local(0, OTHER, 0, 0);
        assertEq(reputation.getFeedbackCount(), 0);
        assertEq(adapter.uniquePosterCount(1), 0);
        assertTrue(adapter.getBountyMeta(job).resolved);
        assertFalse(adapter.getBountyMeta(job).inDispute);
    }

    function testRejectOnlyPosterAfterClosureWithEntries() public {
        uint256 job = _create(_params());
        vm.prank(POSTER);
        vm.expectRevert("no entries");
        adapter.rejectAllContestEntries(job, "ipfs://reason");
        _enter(job, HUMAN, 0);
        vm.prank(OTHER);
        vm.expectRevert("only poster");
        adapter.rejectAllContestEntries(job, "ipfs://reason");
        vm.prank(POSTER);
        vm.expectRevert("contest still open");
        adapter.rejectAllContestEntries(job, "ipfs://reason");
        _closed(job);
        vm.prank(POSTER);
        adapter.rejectAllContestEntries(job, "ipfs://reason");
        assertEq(adapter.getBountyMeta(job).rejectedAt, vm.getBlockTimestamp());
    }

    function testRejectCapacityClosedContestBeforeDeadline() public {
        BountyAdapterV48.CreateParams memory p = _params();
        p.maxEntries = 1;
        p.winners = 1;
        uint256 job = _create(p);
        _enter(job, HUMAN, 0);
        vm.prank(POSTER);
        adapter.rejectAllContestEntries(job, "ipfs://reason");
        _afterChallengeWindow(job);
        adapter.finalizeContestRejection(job);
        assertEq(usdc.balanceOf(POSTER), 1000e6);
    }

    function testRejectAtReviewBoundaryAndNotAfter() public {
        uint256 first = _create(_params());
        uint256 second = _create(_params());
        _enter(first, HUMAN, 0);
        _enter(second, HUMAN, 0);
        _closed(first);
        vm.warp(adapter.contestClosedAt(first) + 14 days);
        vm.prank(POSTER);
        adapter.rejectAllContestEntries(first, "ipfs://reason");
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(POSTER);
        vm.expectRevert("review ended");
        adapter.rejectAllContestEntries(second, "ipfs://reason");
    }

    function testRejectionCannotResetClockAndBlocksOrdinaryPickAndSilence() public {
        uint256 job = _rejected();
        uint256 rejectedAt = adapter.getBountyMeta(job).rejectedAt;
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.prank(POSTER);
        vm.expectRevert("contest rejected");
        adapter.rejectAllContestEntries(job, "ipfs://again");
        vm.expectRevert("contest rejected");
        _pick(job, 1);
        vm.expectRevert("contest rejected");
        adapter.settleContestSilence(job);
        assertEq(adapter.getBountyMeta(job).rejectedAt, rejectedAt);
    }

    function testRejectAndResponseCidLimitsLeaveStateUnchanged() public {
        uint256 job = _create(_params());
        _enter(job, HUMAN, 0);
        _closed(job);
        vm.prank(POSTER);
        vm.expectRevert("empty ipfsReason");
        adapter.rejectAllContestEntries(job, "");
        vm.prank(POSTER);
        vm.expectRevert("ipfsReason too long");
        adapter.rejectAllContestEntries(job, string(new bytes(97)));
        assertEq(adapter.getBountyMeta(job).rejectedAt, 0);
        vm.prank(POSTER);
        adapter.rejectAllContestEntries(job, "ipfs://reason");
        _challenge(job, 0, HUMAN);
        vm.prank(POSTER);
        vm.expectRevert("ipfsResponse too long");
        adapter.respondToContestChallenges(job, string(new bytes(97)));
        assertEq(adapter.getContestChallenge(job, 0).respondedAt, 0);
        _respond(job);
        _afterChallengeWindow(job);
        vm.expectRevert("ipfsRuling too long");
        adapter.resolveContestDispute(job, _indices(1), string(new bytes(97)));
        assertFalse(adapter.getBountyMeta(job).resolved);
    }

    function testEvidenceCidValidationAndDuplicateChallenge() public {
        uint256 job = _rejected();
        vm.prank(WORKING);
        vm.expectRevert("empty ipfsEvidence");
        adapter.challengeContestRejection(job, 0, "");
        vm.prank(WORKING);
        vm.expectRevert("ipfsEvidence too long");
        adapter.challengeContestRejection(job, 0, string(new bytes(97)));
        _challenge(job, 0, WORKING);
        uint256 first = adapter.getContestChallenge(job, 0).challengedAt;
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.expectRevert("already challenged");
        _challenge(job, 0, OWNER);
        assertEq(adapter.getContestChallenge(job, 0).challengedAt, first);
        assertEq(adapter.getContestChallenge(job, 0).evidenceHash, "ipfs://evidence");
        assertEq(adapter.getContestChallengers(job).length, 1);
    }

    function testChallengeUsesCurrentIdentityAfterWalletRotationAndTransfer() public {
        uint256 job = _rejected();
        identity.setWallet(1, OTHER);
        vm.expectRevert("agent only: caller is not agent owner");
        _challenge(job, 0, WORKING);
        identity.setOwner(1, NEXT_OWNER);
        vm.expectRevert("agent only: caller is not agent owner");
        _challenge(job, 0, OTHER);
        _challenge(job, 0, NEXT_OWNER);
        _accept(job, 1);
        assertEq(usdc.balanceOf(NEXT_OWNER), NET);
        assertEq(usdc.balanceOf(WORKING), 0);
        _local(1, address(0), 1, 90);
    }

    function testHumanChallengeCannotBeSubmittedByOutsider() public {
        uint256 job = _rejected();
        vm.expectRevert("not entrant");
        _challenge(job, 1, OTHER);
        vm.expectRevert("invalid entry");
        _challenge(job, 3, HUMAN);
        _challenge(job, 1, HUMAN);
    }

    function testChallengeRequiresRejectionAndEndsAfter48Hours() public {
        uint256 job = _create(_params());
        _enter(job, HUMAN, 0);
        vm.expectRevert("contest not rejected");
        _challenge(job, 0, HUMAN);
        job = _rejected();
        vm.warp(adapter.getBountyMeta(job).rejectedAt + 48 hours);
        _challenge(job, 0, WORKING);
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.expectRevert("challenge window closed");
        _challenge(job, 1, HUMAN);
    }

    function testNoChallengeRefundRequiresClosedWindowAndChargesNoFee() public {
        uint256 job = _rejected();
        vm.expectRevert("challenge window active");
        adapter.finalizeContestRejection(job);
        vm.warp(adapter.getBountyMeta(job).rejectedAt + 48 hours);
        vm.expectRevert("challenge window active");
        adapter.finalizeContestRejection(job);
        vm.warp(vm.getBlockTimestamp() + 1);
        adapter.finalizeContestRejection(job);
        assertEq(usdc.balanceOf(POSTER), 1000e6);
        assertEq(usdc.balanceOf(FEE), 0);
        _assertUnscored(job);
        vm.expectRevert("resolved");
        adapter.finalizeContestRejection(job);
    }

    function testAnyChallengePermanentlyDisablesRejectionRefund() public {
        uint256 job = _rejected();
        _challenge(job, 0, WORKING);
        _afterChallengeWindow(job);
        vm.expectRevert("has challenges");
        adapter.finalizeContestRejection(job);
    }

    function testUnansweredChallengeDefaultPaysOnlyChallengersWithoutScore() public {
        uint256 job = _rejected();
        _challenge(job, 0, WORKING);
        _challenge(job, 1, HUMAN);
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        vm.expectRevert("challenge window active");
        adapter.claimContestDefault(job);
        vm.warp(vm.getBlockTimestamp() + 1);
        adapter.claimContestDefault(job);
        assertEq(usdc.balanceOf(OWNER), NET / 2);
        assertEq(usdc.balanceOf(HUMAN), NET / 2);
        assertEq(usdc.balanceOf(OTHER), 0);
        assertEq(usdc.balanceOf(FEE), REWARD / 100);
        _assertUnscored(job);
    }

    function testPosterCanRespondAtExact48HourBoundary() public {
        uint256 job = _rejected();
        _challenge(job, 0, WORKING);
        uint256 challenged = adapter.getContestChallenge(job, 0).challengedAt;
        vm.warp(challenged + 48 hours);
        _respond(job);
        assertEq(adapter.getContestChallenge(job, 0).respondedAt, challenged + 48 hours);
        _afterChallengeWindow(job);
        vm.expectRevert("no overdue challenge");
        adapter.claimContestDefault(job);
    }

    function testLatePosterResponseCannotEraseMatureDefault() public {
        uint256 job = _rejected();
        _challenge(job, 0, WORKING);
        _afterChallengeWindow(job);
        vm.expectRevert("response window closed");
        _respond(job);
        assertEq(adapter.getContestChallenge(job, 0).respondedAt, 0);
        adapter.claimContestDefault(job);
        _assertUnscored(job);
    }

    function testLateChallengeAfterResponseGetsIndependent48Hours() public {
        uint256 job = _rejected();
        _challenge(job, 0, WORKING);
        _respond(job);
        uint256 first = adapter.getBountyMeta(job).disputeRaisedAt;
        vm.warp(adapter.getBountyMeta(job).rejectedAt + 48 hours);
        _challenge(job, 1, HUMAN);
        uint256 late = adapter.getContestChallenge(job, 1).challengedAt;
        assertEq(adapter.getBountyMeta(job).disputeRaisedAt, first);
        vm.warp(late + 48 hours);
        vm.expectRevert("no overdue challenge");
        adapter.claimContestDefault(job);
        _respond(job);
        assertEq(adapter.getContestChallenge(job, 1).respondedAt, late + 48 hours);
        assertEq(adapter.getContestChallenge(job, 0).respondedAt, first);
        assertEq(adapter.getBountyMeta(job).disputeRaisedAt, first);
        adapter.resolveContestDispute(job, _indices(2), "ipfs://ruling");
        _assertUnscored(job);
    }

    function testLateChallengeCannotExtendEarlierUnansweredDeadline() public {
        uint256 job = _rejected();
        _challenge(job, 0, WORKING);
        vm.warp(adapter.getBountyMeta(job).rejectedAt + 48 hours);
        _challenge(job, 1, HUMAN);
        vm.warp(vm.getBlockTimestamp() + 1);
        adapter.claimContestDefault(job);
        assertEq(usdc.balanceOf(OWNER), NET / 2);
        assertEq(usdc.balanceOf(HUMAN), NET / 2);
        _assertUnscored(job);
    }

    function testLateUnansweredChallengeOverridesEarlierPosterResponse() public {
        uint256 job = _rejected();
        _challenge(job, 0, WORKING);
        _respond(job);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        _challenge(job, 1, HUMAN);
        vm.warp(vm.getBlockTimestamp() + 48 hours + 1);
        vm.expectRevert("unanswered challenge");
        adapter.resolveContestDispute(job, _indices(1), "ipfs://ruling");
        adapter.claimContestDefault(job);
        assertEq(usdc.balanceOf(HUMAN), NET / 2);
        _assertUnscored(job);
    }

    function testAggregateResponseCoversExistingChallengesWithoutResettingThem() public {
        uint256 job = _rejected();
        _challenge(job, 0, WORKING);
        uint256 first = vm.getBlockTimestamp();
        vm.warp(first + 24 hours);
        _challenge(job, 1, HUMAN);
        _respond(job);
        assertEq(adapter.getContestChallenge(job, 0).challengedAt, first);
        assertEq(adapter.getContestChallenge(job, 1).challengedAt, first + 24 hours);
        assertEq(adapter.getContestChallenge(job, 0).respondedAt, vm.getBlockTimestamp());
        assertEq(adapter.getContestChallenge(job, 1).respondedAt, vm.getBlockTimestamp());
        vm.expectRevert("already responded");
        _respond(job);
        assertEq(adapter.getBountyMeta(job).disputeRaisedAt, first);
    }

    function testRespondRequiresPosterChallengesAndValidCid() public {
        uint256 job = _rejected();
        vm.expectRevert("no challenges");
        _respond(job);
        _challenge(job, 0, WORKING);
        vm.prank(OTHER);
        vm.expectRevert("only poster");
        adapter.respondToContestChallenges(job, "ipfs://response");
        vm.prank(POSTER);
        vm.expectRevert("empty ipfsResponse");
        adapter.respondToContestChallenges(job, "");
        assertEq(adapter.getContestChallenge(job, 0).respondedAt, 0);
    }

    function testAcceptDuringOpenChallengeWindowScoresOnlySelected() public {
        uint256 job = _rejected();
        _challenge(job, 0, WORKING);
        _challenge(job, 1, HUMAN);
        _accept(job, 1);
        assertEq(usdc.balanceOf(OWNER), NET);
        assertEq(usdc.balanceOf(HUMAN), 0);
        assertEq(usdc.balanceOf(FEE), REWARD / 100);
        _local(1, address(0), 1, 90);
        _local(0, HUMAN, 0, 0);
        assertEq(reputation.getFeedbackCount(), 1);
        assertFalse(adapter.getBountyMeta(job).inDispute);
        vm.expectRevert("resolved");
        _challenge(job, 2, OTHER);
    }

    function testAcceptDuringArbitrationPaysAllNetAndCannotRepeat() public {
        uint256 job = _rejected();
        _challenge(job, 0, WORKING);
        _challenge(job, 1, HUMAN);
        _respond(job);
        _afterChallengeWindow(job);
        _accept(job, 2);
        assertEq(usdc.balanceOf(OWNER), NET / 2);
        assertEq(usdc.balanceOf(HUMAN), NET / 2);
        _local(1, address(0), 1, 90);
        _local(0, HUMAN, 1, 90);
        vm.expectRevert("resolved");
        _accept(job, 2);
    }

    function testAcceptRejectsNonChallengerDuplicateScoresAndExcessWinners() public {
        uint256 job = _rejected();
        _challenge(job, 0, WORKING);
        vm.expectRevert("not challenger");
        _accept(job, 2);
        uint8[] memory indices = new uint8[](2);
        uint8[] memory scores = new uint8[](2);
        vm.prank(POSTER);
        vm.expectRevert("duplicate winner");
        adapter.acceptContestChallengers(job, indices, scores);
        vm.prank(POSTER);
        vm.expectRevert("invalid winner count");
        adapter.acceptContestChallengers(job, _indices(4), new uint8[](4));
        vm.prank(POSTER);
        vm.expectRevert("invalid scores");
        adapter.acceptContestChallengers(job, _indices(1), scores);
        scores = new uint8[](1);
        scores[0] = 101;
        vm.prank(POSTER);
        vm.expectRevert("score > 100");
        adapter.acceptContestChallengers(job, _indices(1), scores);
        vm.prank(OTHER);
        vm.expectRevert("only poster");
        adapter.acceptContestChallengers(job, _indices(1), scores);
        assertFalse(adapter.getBountyMeta(job).resolved);
    }

    function testArbitratorRefundIsGrossUnscoredAndTerminal() public {
        uint256 job = _rejected();
        _challenge(job, 0, WORKING);
        _respond(job);
        _afterChallengeWindow(job);
        adapter.resolveContestDispute(job, new uint8[](0), "ipfs://refund-ruling");
        assertEq(usdc.balanceOf(POSTER), 1000e6);
        assertEq(usdc.balanceOf(OWNER), 0);
        assertEq(usdc.balanceOf(FEE), 0);
        _assertUnscored(job);
        vm.expectRevert("resolved");
        adapter.resolveContestDispute(job, _indices(1), "ipfs://again");
    }

    function testArbitratorSelectsChallengersPaysCurrentOwnerWithoutScore() public {
        uint256 job = _rejected();
        _challenge(job, 0, WORKING);
        _challenge(job, 1, HUMAN);
        _respond(job);
        _afterChallengeWindow(job);
        identity.setOwner(1, NEXT_OWNER);
        adapter.resolveContestDispute(job, _indices(1), "ipfs://pay-ruling");
        assertEq(usdc.balanceOf(NEXT_OWNER), NET);
        assertEq(usdc.balanceOf(HUMAN), 0);
        assertEq(usdc.balanceOf(FEE), REWARD / 100);
        _assertUnscored(job);
    }

    function testArbitratorCannotRuleBeforeWindowClosesOrWithoutEveryResponse() public {
        uint256 job = _rejected();
        _challenge(job, 0, WORKING);
        _respond(job);
        vm.expectRevert("challenge window active");
        adapter.resolveContestDispute(job, _indices(1), "ipfs://ruling");
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        _challenge(job, 1, HUMAN);
        _afterChallengeWindow(job);
        vm.expectRevert("unanswered challenge");
        adapter.resolveContestDispute(job, _indices(1), "ipfs://ruling");
        _respond(job);
        adapter.resolveContestDispute(job, _indices(2), "ipfs://ruling");
    }

    function testArbitratorAccessSelectionAndRulingValidation() public {
        uint256 job = _rejected();
        _challenge(job, 0, WORKING);
        _respond(job);
        _afterChallengeWindow(job);
        vm.prank(OTHER);
        vm.expectRevert("only arbitrator");
        adapter.resolveContestDispute(job, _indices(1), "ipfs://ruling");
        vm.expectRevert("empty ipfsRuling");
        adapter.resolveContestDispute(job, _indices(1), "");
        vm.expectRevert("not challenger");
        adapter.resolveContestDispute(job, _indices(2), "ipfs://ruling");
        assertFalse(adapter.getBountyMeta(job).resolved);
    }

    function testArbitratorTimeoutAt30DaysIsNotYetClaimable() public {
        uint256 job = _rejected();
        _challenge(job, 0, WORKING);
        _respond(job);
        vm.warp(adapter.getBountyMeta(job).disputeRaisedAt + 30 days);
        vm.expectRevert("arbitrator window active");
        adapter.claimContestArbitratorTimeout(job);
        adapter.resolveContestDispute(job, _indices(1), "ipfs://last-second");
    }

    function testArbitratorTimeoutSplitsGrossWithoutFeeOrScore() public {
        uint256 job = _rejected();
        _challenge(job, 0, WORKING);
        _challenge(job, 1, HUMAN);
        _respond(job);
        vm.warp(adapter.getBountyMeta(job).disputeRaisedAt + 30 days + 1);
        vm.expectRevert("arbitrator window ended");
        adapter.resolveContestDispute(job, _indices(1), "ipfs://late");
        adapter.claimContestArbitratorTimeout(job);
        assertEq(usdc.balanceOf(POSTER), 1000e6 - REWARD / 2);
        assertEq(usdc.balanceOf(OWNER), REWARD / 4);
        assertEq(usdc.balanceOf(HUMAN), REWARD / 4);
        assertEq(usdc.balanceOf(OTHER), 0);
        assertEq(usdc.balanceOf(FEE), 0);
        _assertUnscored(job);
        vm.expectRevert("resolved");
        adapter.claimContestArbitratorTimeout(job);
    }

    function testTimeoutRequiresAllChallengesAnsweredOtherwiseDefaultApplies() public {
        uint256 job = _rejected();
        _challenge(job, 0, WORKING);
        _respond(job);
        _challenge(job, 1, HUMAN);
        vm.warp(adapter.getBountyMeta(job).disputeRaisedAt + 30 days + 1);
        vm.expectRevert("unanswered challenge");
        adapter.claimContestArbitratorTimeout(job);
        vm.expectRevert("arbitrator window ended");
        _respond(job);
        adapter.claimContestDefault(job);
        assertEq(usdc.balanceOf(OWNER), NET / 2);
        _assertUnscored(job);
    }

    function testOddTimeoutRemainderGoesToFirstChallengerAfterPosterHalf() public {
        BountyAdapterV48.CreateParams memory p = _params();
        p.reward = REWARD + 5;
        uint256 job = _create(p);
        _enter(job, WORKING, 1);
        _enter(job, HUMAN, 0);
        _closed(job);
        vm.prank(POSTER);
        adapter.rejectAllContestEntries(job, "ipfs://reject");
        _challenge(job, 1, HUMAN);
        _challenge(job, 0, WORKING);
        _respond(job);
        vm.warp(adapter.getBountyMeta(job).disputeRaisedAt + 30 days + 1);
        adapter.claimContestArbitratorTimeout(job);
        uint256 workers = (REWARD + 5) - (REWARD + 5) / 2;
        assertEq(usdc.balanceOf(HUMAN), workers / 2 + workers % 2);
        assertEq(usdc.balanceOf(OWNER), workers / 2);
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertEq(usdc.balanceOf(FEE), 0);
        _assertUnscored(job);
    }

    function testPausedAllowsChallengeResponseAcceptanceAndRefund() public {
        uint256 job = _rejected();
        BountyAdapterV48.CreateParams memory p = _params();
        p.maxEntries = 1;
        p.winners = 1;
        uint256 emptyChallenges = _create(p);
        _enter(emptyChallenges, HUMAN, 0);
        vm.prank(POSTER);
        adapter.rejectAllContestEntries(emptyChallenges, "ipfs://reason");
        adapter.setPaused(true);
        _challenge(job, 0, WORKING);
        _respond(job);
        _accept(job, 1);
        _afterChallengeWindow(emptyChallenges);
        adapter.finalizeContestRejection(emptyChallenges);
        assertEq(usdc.balanceOf(OWNER), NET);
        assertEq(usdc.balanceOf(POSTER), 1000e6 - REWARD);
    }

    function testBlacklistedDefaultWinnerAndFeeDoNotBlockOtherChallengers() public {
        uint256 job = _rejected();
        _challenge(job, 0, WORKING);
        _challenge(job, 1, HUMAN);
        usdc.setBlacklisted(OWNER, true);
        usdc.setBlacklisted(FEE, true);
        _afterChallengeWindow(job);
        adapter.claimContestDefault(job);
        assertEq(adapter.pendingWithdrawals(OWNER), NET / 2);
        assertEq(adapter.pendingWithdrawals(FEE), REWARD / 100);
        assertEq(usdc.balanceOf(HUMAN), NET / 2);
        _assertUnscored(job);
    }

    function testBlacklistedTimeoutPosterAndUnavailableIdentityDoNotBlockHuman() public {
        uint256 job = _rejected();
        _challenge(job, 0, WORKING);
        _challenge(job, 1, HUMAN);
        _respond(job);
        usdc.setBlacklisted(POSTER, true);
        identity.setUnavailable(true);
        vm.warp(adapter.getBountyMeta(job).disputeRaisedAt + 30 days + 1);
        adapter.claimContestArbitratorTimeout(job);
        assertEq(adapter.pendingWithdrawals(POSTER), REWARD / 2);
        assertEq(adapter.pendingIdentityWithdrawals(1), REWARD / 4);
        assertEq(usdc.balanceOf(HUMAN), REWARD / 4);
        assertEq(usdc.balanceOf(address(adapter)), REWARD * 3 / 4);
        _assertUnscored(job);
    }

    function testBlacklistedRejectionRefundIsParked() public {
        uint256 job = _rejected();
        usdc.setBlacklisted(POSTER, true);
        _afterChallengeWindow(job);
        adapter.finalizeContestRejection(job);
        assertEq(adapter.pendingWithdrawals(POSTER), REWARD);
        _assertUnscored(job);
    }

    function testExpiredRejectedUnchallengedRefundsGross() public {
        uint256 job = _rejected();
        vm.warp(commerce.getJob(job).expiredAt);
        commerce.claimRefund(job);
        adapter.reconcileExpiredEscrow(job);
        assertEq(usdc.balanceOf(POSTER), 1000e6);
        assertEq(usdc.balanceOf(FEE), 0);
        _assertUnscored(job);
    }

    function testExpiredUnansweredChallengePaysOnlyChallengersGross() public {
        uint256 job = _rejected();
        _challenge(job, 0, WORKING);
        vm.warp(commerce.getJob(job).expiredAt);
        commerce.claimRefund(job);
        identity.setOwner(1, NEXT_OWNER);
        adapter.reconcileExpiredEscrow(job);
        assertEq(usdc.balanceOf(NEXT_OWNER), REWARD);
        assertEq(usdc.balanceOf(HUMAN), 0);
        assertEq(usdc.balanceOf(FEE), 0);
        _assertUnscored(job);
        vm.expectRevert("resolved");
        adapter.reconcileExpiredEscrow(job);
    }

    function testExpiredFullyAnsweredChallengesUseNeutralSplit() public {
        uint256 job = _rejected();
        _challenge(job, 0, WORKING);
        _challenge(job, 1, HUMAN);
        _respond(job);
        vm.warp(commerce.getJob(job).expiredAt);
        commerce.claimRefund(job);
        adapter.reconcileExpiredEscrow(job);
        assertEq(usdc.balanceOf(POSTER), 1000e6 - REWARD / 2);
        assertEq(usdc.balanceOf(OWNER), REWARD / 4);
        assertEq(usdc.balanceOf(HUMAN), REWARD / 4);
        assertEq(usdc.balanceOf(FEE), 0);
        _assertUnscored(job);
    }

    function testExpiredPartiallyAnsweredChallengesUseDefaultNotNeutralSplit() public {
        uint256 job = _rejected();
        _challenge(job, 0, WORKING);
        _respond(job);
        _challenge(job, 1, HUMAN);
        vm.warp(commerce.getJob(job).expiredAt);
        commerce.claimRefund(job);
        adapter.reconcileExpiredEscrow(job);
        assertEq(usdc.balanceOf(OWNER), REWARD / 2);
        assertEq(usdc.balanceOf(HUMAN), REWARD / 2);
        assertEq(usdc.balanceOf(POSTER), 1000e6 - REWARD);
        assertEq(usdc.balanceOf(FEE), 0);
        _assertUnscored(job);
    }

    function testExpiredDisputeRecoveryPreservesOtherDepositAndParkedClaim() public {
        uint256 job = _rejected();
        _challenge(job, 0, WORKING);
        _respond(job);
        BountyAdapterV48.CreateParams memory p = _params();
        p.contest = false;
        uint256 openSingle = _create(p);
        uint256 parkedRefund = _create(p);
        usdc.setBlacklisted(POSTER, true);
        vm.prank(POSTER);
        adapter.cancelBounty(parkedRefund);
        assertEq(adapter.pendingWithdrawals(POSTER), REWARD);
        vm.warp(commerce.getJob(job).expiredAt);
        commerce.claimRefund(job);
        adapter.reconcileExpiredEscrow(job);
        assertEq(adapter.pendingWithdrawals(POSTER), REWARD + REWARD / 2);
        assertEq(usdc.balanceOf(OWNER), REWARD / 2);
        assertEq(usdc.balanceOf(address(adapter)), 2 * REWARD + REWARD / 2);
        usdc.setBlacklisted(POSTER, false);
        vm.prank(POSTER);
        adapter.withdraw();
        vm.prank(POSTER);
        adapter.cancelBounty(openSingle);
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertEq(usdc.balanceOf(POSTER), 1000e6 - REWARD / 2);
        _assertUnscored(job);
    }

    function testRecoveryCannotRunBeforeEscrowRefund() public {
        uint256 job = _rejected();
        _challenge(job, 0, WORKING);
        vm.warp(commerce.getJob(job).expiredAt);
        vm.expectRevert("AC job not expired");
        adapter.reconcileExpiredEscrow(job);
        assertFalse(adapter.getBountyMeta(job).resolved);
    }

    function testEveryDisputeMethodRejectsSingleTakerMode() public {
        BountyAdapterV48.CreateParams memory p = _params();
        p.contest = false;
        uint256 job = _create(p);
        bytes[] memory calls = new bytes[](8);
        calls[0] = abi.encodeCall(adapter.rejectAllContestEntries, (job, "ipfs://reason"));
        calls[1] = abi.encodeCall(adapter.challengeContestRejection, (job, 0, "ipfs://evidence"));
        calls[2] = abi.encodeCall(adapter.respondToContestChallenges, (job, "ipfs://response"));
        calls[3] = abi.encodeCall(adapter.acceptContestChallengers, (job, _indices(1), new uint8[](1)));
        calls[4] = abi.encodeCall(adapter.finalizeContestRejection, (job));
        calls[5] = abi.encodeCall(adapter.claimContestDefault, (job));
        calls[6] = abi.encodeCall(adapter.resolveContestDispute, (job, _indices(1), "ipfs://ruling"));
        calls[7] = abi.encodeCall(adapter.claimContestArbitratorTimeout, (job));
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory reason) = address(adapter).call(calls[i]);
            assertFalse(ok);
            assertEq(reason, abi.encodeWithSelector(BountyAdapterV48.WrongBountyMode.selector));
        }
    }

    function test25ChallengersCanRespondAndTimeoutWithoutExtraReputation() public {
        BountyAdapterV48.CreateParams memory p = _params();
        p.maxEntries = 25;
        p.winners = 25;
        uint256 job = _create(p);
        for (uint256 i; i < 25; ++i) {
            _enter(job, address(uint160(0x2000 + i)), 0);
        }
        vm.prank(POSTER);
        adapter.rejectAllContestEntries(job, "ipfs://reason");
        for (uint8 i; i < 25; ++i) {
            _challenge(job, i, address(uint160(0x2000 + i)));
        }
        _respond(job);
        vm.warp(adapter.getBountyMeta(job).disputeRaisedAt + 30 days + 1);
        adapter.claimContestArbitratorTimeout(job);
        for (uint8 i; i < 25; ++i) {
            assertEq(usdc.balanceOf(address(uint160(0x2000 + i))), REWARD / 2 / 25);
            _local(0, address(uint160(0x2000 + i)), 0, 0);
            assertTrue(adapter.getContestEntries(job)[i].awarded);
        }
        assertEq(usdc.balanceOf(POSTER), 1000e6 - REWARD / 2);
        assertEq(usdc.balanceOf(address(adapter)), 0);
    }
}

contract BountyAdapterV48ContestDisputeTest is V48ContestDisputeCases {}

/// @dev Run the same complete dispute matrix against the pinned escrow proxy.
contract BountyAdapterV48ContestDisputeEscrowTest is V48ContestDisputeCases {
    function setUp() public override {
        vm.warp(1000);
        usdc = new MockUSDC();
        AgenticCommerce implementation = new AgenticCommerce();
        commerce = MockAgenticCommerce(
            address(
                new ERC1967Proxy(
                    address(implementation),
                    abi.encodeCall(AgenticCommerce.initialize, (address(usdc), FEE, address(this)))
                )
            )
        );
        _setupAdapter();
    }
}
