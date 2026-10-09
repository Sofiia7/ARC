// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Test.sol";
import "../src/monad/BountyAdapterV48.sol";
import "../src/base/AgenticCommerce.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MockUSDC, MockAgenticCommerce, MockReputationRegistry} from "./BountyAdapter.t.sol";
import {MockV48IdentityRegistry, CallbackUSDC} from "./BountyAdapterV48Identity.t.sol";

abstract contract V48ContestFixture is Test {
    BountyAdapterV48 internal adapter;
    MockUSDC internal usdc;
    MockAgenticCommerce internal commerce;
    MockV48IdentityRegistry internal identity;
    MockReputationRegistry internal reputation;
    ReputationMirror internal mirror;
    address internal constant POSTER = address(0x1001);
    address internal constant OWNER = address(0x1002);
    address internal constant WORKING = address(0x1003);
    address internal constant NEXT_OWNER = address(0x1004);
    address internal constant HUMAN = address(0x1005);
    address internal constant OTHER = address(0x1006);
    address internal constant FEE = address(0x1007);
    uint256 internal constant REWARD = 10e6;
    uint256 internal constant NET = 9.9e6;

    function setUp() public virtual {
        vm.warp(1000);
        usdc = new MockUSDC();
        commerce = new MockAgenticCommerce(address(usdc));
        _setupAdapter();
    }

    function _setupAdapter() internal {
        identity = new MockV48IdentityRegistry();
        reputation = new MockReputationRegistry();
        mirror = new ReputationMirror(address(this), address(this));
        adapter = BountyAdapterV48(
            deployCode(
                "BountyAdapterV48.sol:BountyAdapterV48",
                abi.encode(
                    address(commerce), address(identity), address(reputation), address(usdc), FEE, address(mirror)
                )
            )
        );
        adapter.setPaused(false);
        identity.setOwner(1, OWNER);
        identity.setWallet(1, WORKING);
        usdc.mint(POSTER, 1000e6);
        vm.prank(POSTER);
        usdc.approve(address(adapter), type(uint256).max);
    }

    function _params() internal view returns (BountyAdapterV48.CreateParams memory p) {
        p.reward = REWARD;
        p.deadline = block.timestamp + 7 days;
        p.ipfsDescHash = "ipfs://description";
        p.category = "dev";
        p.tags = new string[](0);
        p.contest = true;
        p.maxEntries = 10;
        p.winners = 3;
    }

    function _create(BountyAdapterV48.CreateParams memory p) internal returns (uint256) {
        vm.prank(POSTER);
        return adapter.createBounty(p);
    }

    function _enter(uint256 job, address caller, uint256 agentId) internal {
        vm.prank(caller);
        adapter.enterContest(job, agentId, "ipfs://encrypted");
    }

    function _indices(uint8 count) internal pure returns (uint8[] memory indices) {
        indices = new uint8[](count);
        for (uint8 i; i < count; ++i) {
            indices[i] = i;
        }
    }

    function _pick(uint256 job, uint8 count) internal {
        uint8[] memory scores = new uint8[](count);
        for (uint8 i; i < count; ++i) {
            scores[i] = 90;
        }
        vm.prank(POSTER);
        adapter.pickContestWinners(job, _indices(count), scores);
    }

    function _closed(uint256 job) internal {
        vm.warp(adapter.getBountyMeta(job).deadline);
    }

    function _silence(uint256 job) internal {
        _closed(job);
        vm.warp(adapter.contestClosedAt(job) + 14 days + 1);
        adapter.settleContestSilence(job);
    }

    function _local(uint256 agentId, address human, uint256 jobs, uint256 sum) internal view {
        (uint256 actualJobs, uint256 actualSum) = adapter.localReputation(adapter.identityKey(agentId, human));
        assertEq(actualJobs, jobs);
        assertEq(actualSum, sum);
    }
}

contract BountyAdapterV48ContestTest is V48ContestFixture {
    function testCreateFundsEscrowImmediatelyAndRemainsListed() public {
        uint256 job = _create(_params());
        IAgenticCommerce.Job memory state = commerce.getJob(job);
        assertEq(uint256(state.status), uint256(IAgenticCommerce.JobStatus.Funded));
        assertEq(state.client, address(adapter));
        assertEq(state.provider, address(adapter));
        assertEq(state.evaluator, address(adapter));
        assertEq(usdc.balanceOf(address(commerce)), REWARD);
        assertEq(usdc.balanceOf(address(adapter)), 0);
        uint256[] memory ids = adapter.getOpenBounties("", 0, 10);
        assertEq(ids.length, 1);
        assertEq(ids[0], job);
    }

    function testSizesAndBondAreValidatedBeforeFundsMove() public {
        BountyAdapterV48.CreateParams memory p = _params();
        p.maxEntries = 0;
        vm.expectRevert(BountyAdapterV48.InvalidContestParams.selector);
        _create(p);
        p.maxEntries = 26;
        vm.expectRevert(BountyAdapterV48.InvalidContestParams.selector);
        _create(p);
        p.maxEntries = 10;
        p.winners = 0;
        vm.expectRevert(BountyAdapterV48.InvalidContestParams.selector);
        _create(p);
        p.winners = 11;
        vm.expectRevert(BountyAdapterV48.InvalidContestParams.selector);
        _create(p);
        p.winners = 1;
        p.requireWorkerBond = true;
        vm.expectRevert(BountyAdapterV48.InvalidContestParams.selector);
        _create(p);
        assertEq(usdc.balanceOf(POSTER), 1000e6);
        assertEq(adapter.totalBounties(), 0);
    }

    function testDuplicateIdentityCannotEnterThroughOwnerAndWallet() public {
        uint256 job = _create(_params());
        _enter(job, WORKING, 1);
        vm.expectRevert("already entered");
        _enter(job, OWNER, 1);
        assertEq(adapter.getContestEntryIndex(job, 1, OWNER), 1);
        assertEq(adapter.getContestEntries(job).length, 1);
        assertEq(adapter.getAgentBountyCount(1), 1);
        assertEq(uint256(commerce.getJob(job).status), uint256(IAgenticCommerce.JobStatus.Submitted));
    }

    function testDuplicateHumanAndDistinctAgentsOfSameOwner() public {
        uint256 job = _create(_params());
        _enter(job, HUMAN, 0);
        vm.expectRevert("already entered");
        _enter(job, HUMAN, 0);
        identity.setOwner(2, OWNER);
        _enter(job, OWNER, 1);
        _enter(job, OWNER, 2);
        assertEq(adapter.getContestEntries(job).length, 3);
    }

    function testReplacementUsesCurrentAuthorizationAndKeepsSingleEntry() public {
        uint256 job = _create(_params());
        _enter(job, WORKING, 1);
        identity.setWallet(1, OTHER);
        vm.prank(WORKING);
        vm.expectRevert("agent only: caller is not agent owner");
        adapter.replaceContestEntry(job, 0, "ipfs://old-key");
        vm.prank(OTHER);
        adapter.replaceContestEntry(job, 0, "ipfs://new-key");
        identity.setOwner(1, NEXT_OWNER);
        vm.prank(OTHER);
        vm.expectRevert("agent only: caller is not agent owner");
        adapter.replaceContestEntry(job, 0, "ipfs://revoked");
        vm.prank(NEXT_OWNER);
        adapter.replaceContestEntry(job, 0, "ipfs://new-owner");
        assertEq(adapter.getContestEntries(job)[0].resultHash, "ipfs://new-owner");
        vm.expectRevert("already entered");
        _enter(job, NEXT_OWNER, 1);
    }

    function testHumanReplacementCannotBeMadeByAnotherWallet() public {
        uint256 job = _create(_params());
        _enter(job, HUMAN, 0);
        vm.prank(OTHER);
        vm.expectRevert("not entrant");
        adapter.replaceContestEntry(job, 0, "ipfs://bad");
        vm.prank(HUMAN);
        adapter.replaceContestEntry(job, 0, "ipfs://replacement");
        assertEq(adapter.getContestEntries(job)[0].resultHash, "ipfs://replacement");
    }

    function testDeadlineClosesAtExactBoundary() public {
        uint256 job = _create(_params());
        _enter(job, HUMAN, 0);
        uint256 deadline = adapter.getBountyMeta(job).deadline;
        vm.warp(deadline - 1);
        vm.prank(HUMAN);
        adapter.replaceContestEntry(job, 0, "ipfs://last-second");
        vm.warp(deadline);
        assertEq(adapter.contestClosedAt(job), deadline);
        vm.expectRevert("contest closed");
        _enter(job, OTHER, 0);
        vm.prank(HUMAN);
        vm.expectRevert("contest closed");
        adapter.replaceContestEntry(job, 0, "ipfs://late");
        uint256[] memory ids = adapter.getOpenBounties("", 0, 10);
        assertEq(ids.length, 0);
    }

    function testCapacityClosesImmediatelyAndDisallowsReplacement() public {
        BountyAdapterV48.CreateParams memory p = _params();
        p.maxEntries = 1;
        p.winners = 1;
        uint256 job = _create(p);
        _enter(job, HUMAN, 0);
        assertEq(adapter.contestClosedAt(job), block.timestamp);
        (uint256 count, uint256 closed, uint256 review, bool resolved) = adapter.getContestState(job);
        assertEq(count, 1);
        assertEq(closed, block.timestamp);
        assertEq(review, closed + 14 days);
        assertFalse(resolved);
        vm.prank(HUMAN);
        vm.expectRevert("contest closed");
        adapter.replaceContestEntry(job, 0, "ipfs://late");
        vm.expectRevert("contest closed");
        _enter(job, OTHER, 0);
    }

    function test25EntriesAndFullSilenceDistribution() public {
        BountyAdapterV48.CreateParams memory p = _params();
        p.maxEntries = 25;
        uint256 job = _create(p);
        for (uint256 i; i < 25; ++i) {
            _enter(job, address(uint160(0x2000 + i)), 0);
        }
        vm.expectRevert("contest closed");
        _enter(job, OTHER, 0);
        uint256 closed = adapter.contestClosedAt(job);
        vm.warp(closed + 14 days + 1);
        adapter.settleContestSilence(job);
        for (uint256 i; i < 25; ++i) {
            assertEq(usdc.balanceOf(address(uint160(0x2000 + i))), NET / 25);
            _local(0, address(uint160(0x2000 + i)), 0, 0);
            assertTrue(adapter.getContestEntries(job)[i].awarded);
        }
        assertEq(usdc.balanceOf(address(adapter)), 0);
    }

    function test25AgentWinnersResolveOwnersAndWriteFeedback() public {
        BountyAdapterV48.CreateParams memory p = _params();
        p.maxEntries = 25;
        p.winners = 25;
        uint256 job = _create(p);
        for (uint256 i; i < 25; ++i) {
            address holder = address(uint160(0x2000 + i));
            identity.setOwner(i + 1, holder);
            _enter(job, holder, i + 1);
        }
        _pick(job, 25);
        for (uint256 i; i < 25; ++i) {
            assertEq(usdc.balanceOf(address(uint160(0x2000 + i))), NET / 25);
            _local(i + 1, address(0), 1, 90);
            assertEq(adapter.uniquePosterCount(i + 1), 1);
        }
        assertEq(reputation.getFeedbackCount(), 25);
        assertEq(usdc.balanceOf(FEE), REWARD / 100);
        assertEq(usdc.balanceOf(address(adapter)), 0);
    }

    function testEarlyPickPaysCurrentOwnerAndRecordsOnlySelected() public {
        uint256 job = _create(_params());
        _enter(job, WORKING, 1);
        _enter(job, HUMAN, 0);
        identity.setOwner(1, NEXT_OWNER);
        _pick(job, 1);
        assertEq(usdc.balanceOf(NEXT_OWNER), NET);
        assertEq(usdc.balanceOf(WORKING), 0);
        assertEq(usdc.balanceOf(HUMAN), 0);
        assertEq(usdc.balanceOf(FEE), REWARD / 100);
        _local(1, address(0), 1, 90);
        _local(0, HUMAN, 0, 0);
        assertEq(reputation.getFeedbackCount(), 1);
        assertEq(adapter.uniquePosterCount(1), 1);
        assertTrue(adapter.getContestEntries(job)[0].awarded);
        assertFalse(adapter.getContestEntries(job)[1].awarded);
        assertEq(adapter.contestClosedAt(job), block.timestamp);
        vm.expectRevert("resolved");
        _enter(job, OTHER, 0);
    }

    function testFewerWinnersGetEntireRewardAndRemainderGoesFirstSelected() public {
        BountyAdapterV48.CreateParams memory p = _params();
        p.reward = REWARD + 3;
        uint256 job = _create(p);
        _enter(job, HUMAN, 0);
        _enter(job, OTHER, 0);
        uint8[] memory indices = _indices(2);
        indices[0] = 1;
        indices[1] = 0;
        uint8[] memory scores = new uint8[](2);
        scores[0] = 100;
        scores[1] = 40;
        vm.prank(POSTER);
        adapter.pickContestWinners(job, indices, scores);
        assertEq(usdc.balanceOf(OTHER), (NET + 3) / 2 + 1);
        assertEq(usdc.balanceOf(HUMAN), (NET + 3) / 2);
        _local(0, OTHER, 1, 100);
        _local(0, HUMAN, 1, 40);
        assertEq(usdc.balanceOf(address(adapter)), 0);
    }

    function testFuzzConservesRewardWithBoundedWinnerCount(uint96 gross, uint8 count) public {
        uint256 reward = bound(gross, 1e6, 100e6);
        count = uint8(bound(count, 1, 25));
        BountyAdapterV48.CreateParams memory p = _params();
        p.reward = reward;
        p.maxEntries = count;
        p.winners = count;
        uint256 job = _create(p);
        for (uint256 i; i < count; ++i) {
            _enter(job, address(uint160(0x2000 + i)), 0);
        }
        _pick(job, count);
        uint256 fee = reward / 100;
        uint256 net = reward - fee;
        uint256 total;
        for (uint256 i; i < count; ++i) {
            uint256 paid = usdc.balanceOf(address(uint160(0x2000 + i)));
            assertEq(paid, net / count + (i == 0 ? net % count : 0));
            total += paid;
        }
        assertEq(total + usdc.balanceOf(FEE), reward);
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertEq(usdc.balanceOf(address(commerce)), 0);
    }

    function testInvalidSelectionAndScoresCannotResolveContest() public {
        uint256 job = _create(_params());
        _enter(job, HUMAN, 0);
        _enter(job, OTHER, 0);
        uint8[] memory indices = _indices(2);
        uint8[] memory scores = new uint8[](2);
        vm.prank(OTHER);
        vm.expectRevert("only poster");
        adapter.pickContestWinners(job, indices, scores);
        indices[1] = 0;
        vm.prank(POSTER);
        vm.expectRevert("duplicate winner");
        adapter.pickContestWinners(job, indices, scores);
        indices[1] = 2;
        vm.prank(POSTER);
        vm.expectRevert("invalid entry");
        adapter.pickContestWinners(job, indices, scores);
        indices[1] = 1;
        scores[0] = 101;
        vm.prank(POSTER);
        vm.expectRevert("score > 100");
        adapter.pickContestWinners(job, indices, scores);
        vm.prank(POSTER);
        vm.expectRevert("invalid scores");
        adapter.pickContestWinners(job, indices, new uint8[](1));
        vm.prank(POSTER);
        vm.expectRevert("invalid winner count");
        adapter.pickContestWinners(job, new uint8[](0), new uint8[](0));
        vm.prank(POSTER);
        vm.expectRevert("invalid winner count");
        adapter.pickContestWinners(job, _indices(4), new uint8[](4));
        assertFalse(adapter.getBountyMeta(job).resolved);
        assertFalse(adapter.getContestEntries(job)[0].awarded);
        assertEq(usdc.balanceOf(address(commerce)), REWARD);
    }

    function testCannotPickWithoutEntries() public {
        uint256 job = _create(_params());
        vm.expectRevert("invalid entry");
        _pick(job, 1);
    }

    function testSilenceHasNoReputationEvenForAgent() public {
        uint256 job = _create(_params());
        _enter(job, WORKING, 1);
        _enter(job, HUMAN, 0);
        _silence(job);
        assertEq(usdc.balanceOf(OWNER), NET / 2);
        assertEq(usdc.balanceOf(HUMAN), NET / 2);
        _local(1, address(0), 0, 0);
        _local(0, HUMAN, 0, 0);
        assertEq(reputation.getFeedbackCount(), 0);
        assertEq(adapter.uniquePosterCount(1), 0);
    }

    function testReviewBoundaryPermitsPickAndPreventsSilence() public {
        uint256 job = _create(_params());
        _enter(job, HUMAN, 0);
        _closed(job);
        vm.warp(adapter.contestClosedAt(job) + 14 days);
        vm.expectRevert("review active");
        adapter.settleContestSilence(job);
        _pick(job, 1);
    }

    function testAfterReviewOnlySilenceCanSettle() public {
        uint256 job = _create(_params());
        _enter(job, HUMAN, 0);
        _closed(job);
        vm.warp(adapter.contestClosedAt(job) + 14 days + 1);
        vm.expectRevert("review ended");
        _pick(job, 1);
        adapter.settleContestSilence(job);
    }

    function testSilenceCannotSettleOpenOrEmptyContest() public {
        uint256 job = _create(_params());
        vm.expectRevert("no entries");
        adapter.settleContestSilence(job);
        _enter(job, HUMAN, 0);
        vm.expectRevert("review active");
        adapter.settleContestSilence(job);
    }

    function testZeroEntriesRefundGrossAtExpiryWithoutFee() public {
        uint256 job = _create(_params());
        vm.warp(adapter.getBountyMeta(job).deadline - 1);
        vm.expectRevert("not expired yet");
        adapter.expireBounty(job);
        _closed(job);
        adapter.expireBounty(job);
        assertEq(usdc.balanceOf(POSTER), 1000e6);
        assertEq(usdc.balanceOf(FEE), 0);
        assertEq(uint256(commerce.getJob(job).status), uint256(IAgenticCommerce.JobStatus.Rejected));
    }

    function testCancelZeroEntriesPullsRefundFromEscrow() public {
        uint256 job = _create(_params());
        vm.prank(POSTER);
        adapter.cancelBounty(job);
        assertEq(usdc.balanceOf(POSTER), 1000e6);
        assertEq(usdc.balanceOf(FEE), 0);
        assertEq(usdc.balanceOf(address(commerce)), 0);
    }

    function testCannotCancelOrExpireEnteredContest() public {
        uint256 job = _create(_params());
        _enter(job, HUMAN, 0);
        vm.prank(POSTER);
        vm.expectRevert("has entries");
        adapter.cancelBounty(job);
        _closed(job);
        vm.warp(block.timestamp + 1);
        vm.expectRevert("has entries");
        adapter.expireBounty(job);
    }

    function testPausedBlocksAdmissionAndReplacementButAllowsPick() public {
        uint256 job = _create(_params());
        _enter(job, HUMAN, 0);
        adapter.setPaused(true);
        vm.expectRevert("paused");
        _enter(job, OTHER, 0);
        vm.prank(HUMAN);
        vm.expectRevert("paused");
        adapter.replaceContestEntry(job, 0, "ipfs://new");
        _pick(job, 1);
        assertEq(usdc.balanceOf(HUMAN), NET);
    }

    function testPausedAllowsSilenceAndRefund() public {
        uint256 job = _create(_params());
        uint256 empty = _create(_params());
        _enter(job, HUMAN, 0);
        adapter.setPaused(true);
        _silence(job);
        adapter.expireBounty(empty);
        assertEq(usdc.balanceOf(HUMAN), NET);
        assertEq(usdc.balanceOf(POSTER), 1000e6 - REWARD);
    }

    function testBadCidsAndUnknownIdentityCannotEnterOrReplace() public {
        uint256 job = _create(_params());
        vm.prank(HUMAN);
        vm.expectRevert("empty ipfsResult");
        adapter.enterContest(job, 0, "");
        vm.prank(HUMAN);
        vm.expectRevert("ipfsResult too long");
        adapter.enterContest(job, 0, string(new bytes(201)));
        vm.expectRevert(BountyAdapterV48.InvalidIdentity.selector);
        _enter(job, OWNER, 42);
        _enter(job, HUMAN, 0);
        vm.prank(HUMAN);
        vm.expectRevert("empty ipfsResult");
        adapter.replaceContestEntry(job, 0, "");
        vm.prank(HUMAN);
        vm.expectRevert("invalid entry");
        adapter.replaceContestEntry(job, 1, "ipfs://new");
        assertEq(adapter.getContestEntries(job).length, 1);
    }

    function testFlagsAndReservationApplyToAdmission() public {
        BountyAdapterV48.CreateParams memory p = _params();
        p.agentOnly = true;
        p.provider = OWNER;
        uint256 job = _create(p);
        vm.expectRevert("agent only: provide agentId");
        _enter(job, HUMAN, 0);
        identity.setOwner(2, OTHER);
        vm.expectRevert("not whitelisted");
        _enter(job, OTHER, 2);
        _enter(job, WORKING, 1);
        p.agentOnly = false;
        p.humanOnly = true;
        p.provider = HUMAN;
        job = _create(p);
        vm.expectRevert("human only: no agentId");
        _enter(job, WORKING, 1);
        vm.expectRevert("not whitelisted");
        _enter(job, OTHER, 0);
        _enter(job, HUMAN, 0);
    }

    function testMirroredGateAndReplacementAfterMirrorCorrection() public {
        ReputationMirror.Update[] memory updates = new ReputationMirror.Update[](1);
        updates[0] = ReputationMirror.Update(OWNER, 8453, 100, 3, 240);
        mirror.updateRecords(updates);
        BountyAdapterV48.CreateParams memory p = _params();
        p.minJobs = 3;
        p.minAvgScore = 80;
        uint256 job = _create(p);
        vm.expectRevert(abi.encodeWithSelector(BountyAdapterV48.ReputationGateFailed.selector, 0, 0));
        _enter(job, HUMAN, 0);
        _enter(job, WORKING, 1);
        updates[0] = ReputationMirror.Update(OWNER, 8453, 101, 0, 0);
        mirror.updateRecords(updates);
        vm.prank(OWNER);
        adapter.replaceContestEntry(job, 0, "ipfs://replacement");
        _pick(job, 1);
        p.minJobs = 1;
        p.minAvgScore = 90;
        job = _create(p);
        _enter(job, WORKING, 1);
    }

    function testLocalHumanGateCountsScoredContestPick() public {
        uint256 job = _create(_params());
        _enter(job, HUMAN, 0);
        _pick(job, 1);
        BountyAdapterV48.CreateParams memory p = _params();
        p.minJobs = 1;
        p.minAvgScore = 90;
        job = _create(p);
        _enter(job, HUMAN, 0);
        vm.expectRevert(abi.encodeWithSelector(BountyAdapterV48.ReputationGateFailed.selector, 0, 0));
        _enter(job, OTHER, 0);
    }

    function testBlacklistedWinnerAndFeeDoNotBlockOtherWinners() public {
        uint256 job = _create(_params());
        _enter(job, WORKING, 1);
        _enter(job, HUMAN, 0);
        usdc.setBlacklisted(OWNER, true);
        usdc.setBlacklisted(FEE, true);
        _pick(job, 2);
        assertEq(adapter.pendingWithdrawals(OWNER), NET / 2);
        assertEq(adapter.pendingWithdrawals(FEE), REWARD / 100);
        assertEq(usdc.balanceOf(HUMAN), NET / 2);
        assertEq(usdc.balanceOf(address(adapter)), NET / 2 + REWARD / 100);
        usdc.setBlacklisted(OWNER, false);
        vm.prank(OWNER);
        adapter.withdraw();
        assertEq(usdc.balanceOf(OWNER), NET / 2);
        _local(1, address(0), 1, 90);
    }

    function testUnavailableRegistryParksIdentityWithoutBlockingHumans() public {
        uint256 job = _create(_params());
        _enter(job, WORKING, 1);
        _enter(job, HUMAN, 0);
        identity.setUnavailable(true);
        _pick(job, 2);
        assertEq(adapter.pendingIdentityWithdrawals(1), NET / 2);
        assertEq(usdc.balanceOf(HUMAN), NET / 2);
        identity.setUnavailable(false);
        identity.setOwner(1, NEXT_OWNER);
        vm.prank(NEXT_OWNER);
        adapter.withdrawIdentity(1);
        assertEq(usdc.balanceOf(NEXT_OWNER), NET / 2);
        _local(1, address(0), 1, 90);
    }

    function testBlacklistedPosterRefundIsParked() public {
        uint256 job = _create(_params());
        usdc.setBlacklisted(POSTER, true);
        vm.prank(POSTER);
        adapter.cancelBounty(job);
        assertEq(adapter.pendingWithdrawals(POSTER), REWARD);
    }

    function testFeedbackFailureDoesNotBlockPayoutOrLocalScore() public {
        uint256 job = _create(_params());
        _enter(job, WORKING, 1);
        vm.mockCallRevert(
            address(reputation), abi.encodeWithSelector(IReputationRegistry.giveFeedback.selector), "registry down"
        );
        _pick(job, 1);
        assertEq(usdc.balanceOf(OWNER), NET);
        _local(1, address(0), 1, 90);
    }

    function testAllSingleTakerEntryPointsRejectContestMode() public {
        uint256 job = _create(_params());
        _enter(job, HUMAN, 0);
        bytes[] memory calls = new bytes[](13);
        calls[0] = abi.encodeCall(adapter.takeBounty, (job, 0));
        calls[1] = abi.encodeCall(adapter.submitWork, (job, "ipfs://work"));
        calls[2] = abi.encodeCall(adapter.approveBounty, (job, 90));
        calls[3] = abi.encodeCall(adapter.autoApprove, (job));
        calls[4] = abi.encodeCall(adapter.rejectBounty, (job, "ipfs://reason"));
        calls[5] = abi.encodeCall(adapter.withdrawRejection, (job));
        calls[6] = abi.encodeCall(adapter.challengeRejection, (job, "ipfs://reason"));
        calls[7] = abi.encodeCall(adapter.finalizeRejection, (job));
        calls[8] = abi.encodeCall(adapter.disputeBounty, (job, "ipfs://reason"));
        calls[9] = abi.encodeCall(adapter.respondToDispute, (job, "ipfs://response"));
        calls[10] = abi.encodeCall(adapter.resolveDispute, (job, true, "ipfs://ruling", 0));
        calls[11] = abi.encodeCall(adapter.claimDefaultRuling, (job));
        calls[12] = abi.encodeCall(adapter.claimArbitratorTimeout, (job));
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory reason) = address(adapter).call(calls[i]);
            assertFalse(ok);
            assertEq(reason, abi.encodeWithSelector(BountyAdapterV48.WrongBountyMode.selector));
        }
        assertFalse(adapter.getBountyMeta(job).resolved);
    }

    function testContestMethodsCannotActOnSingleTakerOrUnknownJob() public {
        BountyAdapterV48.CreateParams memory p = _params();
        p.contest = false;
        uint256 job = _create(p);
        vm.expectRevert(BountyAdapterV48.WrongBountyMode.selector);
        _enter(job, HUMAN, 0);
        vm.expectRevert(BountyAdapterV48.WrongBountyMode.selector);
        _pick(job, 1);
        vm.expectRevert(BountyAdapterV48.WrongBountyMode.selector);
        adapter.settleContestSilence(job);
        vm.expectRevert(BountyAdapterV48.WrongBountyMode.selector);
        adapter.contestClosedAt(999);
    }

    function testTerminalLatchPreventsRepeatedAwardsAndRefund() public {
        uint256 job = _create(_params());
        _enter(job, HUMAN, 0);
        _pick(job, 1);
        vm.expectRevert("resolved");
        _pick(job, 1);
        vm.expectRevert("resolved");
        adapter.settleContestSilence(job);
        vm.prank(POSTER);
        vm.expectRevert("resolved");
        adapter.cancelBounty(job);
        _local(0, HUMAN, 1, 90);
        assertEq(usdc.balanceOf(HUMAN), NET);
    }

    function testShortEscrowReceiptCannotConsumeAnotherJobDeposit() public {
        uint256 job = _create(_params());
        _enter(job, HUMAN, 0);
        BountyAdapterV48.CreateParams memory p = _params();
        p.contest = false;
        uint256 other = _create(p);
        vm.mockCall(address(commerce), abi.encodeWithSelector(IAgenticCommerce.complete.selector), "");
        vm.expectRevert(abi.encodeWithSelector(BountyAdapterV48.UnexpectedEscrowAmount.selector, 0, REWARD));
        _pick(job, 1);
        assertFalse(adapter.getBountyMeta(job).resolved);
        assertFalse(adapter.getContestEntries(job)[0].awarded);
        assertEq(usdc.balanceOf(address(adapter)), REWARD);
        assertEq(usdc.balanceOf(HUMAN), 0);
        vm.prank(POSTER);
        adapter.cancelBounty(other);
        assertEq(usdc.balanceOf(POSTER), 1000e6 - REWARD);
    }

    function testExpiredEscrowRecoveryPaysAllGrossWithoutReputation() public {
        uint256 job = _create(_params());
        _enter(job, WORKING, 1);
        _enter(job, HUMAN, 0);
        BountyAdapterV48.CreateParams memory p = _params();
        p.contest = false;
        uint256 other = _create(p);
        vm.warp(commerce.getJob(job).expiredAt);
        commerce.claimRefund(job);
        identity.setOwner(1, NEXT_OWNER);
        adapter.reconcileExpiredEscrow(job);
        assertEq(usdc.balanceOf(NEXT_OWNER), REWARD / 2);
        assertEq(usdc.balanceOf(HUMAN), REWARD / 2);
        assertEq(usdc.balanceOf(FEE), 0);
        _local(1, address(0), 0, 0);
        assertEq(reputation.getFeedbackCount(), 0);
        assertEq(usdc.balanceOf(address(adapter)), REWARD);
        vm.expectRevert("resolved");
        adapter.reconcileExpiredEscrow(job);
        vm.prank(POSTER);
        adapter.cancelBounty(other);
        assertEq(usdc.balanceOf(address(adapter)), 0);
    }

    function testExpiredEmptyEscrowRecoveryRefundsPoster() public {
        uint256 job = _create(_params());
        vm.warp(commerce.getJob(job).expiredAt);
        commerce.claimRefund(job);
        adapter.reconcileExpiredEscrow(job);
        assertEq(usdc.balanceOf(POSTER), 1000e6);
        assertEq(usdc.balanceOf(FEE), 0);
    }
}

contract BountyAdapterV48ContestEscrowTest is V48ContestFixture {
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

    function testContestReceiptCannotReenterAnotherMatureSettlement() public {
        CallbackUSDC token = new CallbackUSDC();
        AgenticCommerce implementation = new AgenticCommerce();
        AgenticCommerce escrow = AgenticCommerce(
            address(
                new ERC1967Proxy(
                    address(implementation),
                    abi.encodeCall(AgenticCommerce.initialize, (address(token), FEE, address(this)))
                )
            )
        );
        BountyAdapterV48 target = BountyAdapterV48(
            deployCode(
                "BountyAdapterV48.sol:BountyAdapterV48",
                abi.encode(
                    address(escrow), address(identity), address(reputation), address(token), FEE, address(mirror)
                )
            )
        );
        target.setPaused(false);
        token.mint(address(this), 2 * REWARD);
        token.approve(address(target), 2 * REWARD);
        BountyAdapterV48.CreateParams memory p = _params();
        uint256 contest = target.createBounty(p);
        vm.prank(WORKING);
        target.enterContest(contest, 1, "ipfs://encrypted");
        p.contest = false;
        uint256 single = target.createBounty(p);
        vm.startPrank(WORKING);
        target.takeBounty(single, 1);
        target.submitWork(single, "ipfs://single");
        vm.stopPrank();
        vm.warp(block.timestamp + 14 days + 1);
        token.configureCallback(address(target), single);
        uint8[] memory scores = new uint8[](1);
        scores[0] = 90;
        target.pickContestWinners(contest, _indices(1), scores);
        assertTrue(token.attempted());
        assertFalse(token.reentered());
        assertEq(token.reentryReason(), abi.encodeWithSelector(bytes4(keccak256("ReentrancyGuardReentrantCall()"))));
        assertTrue(target.getBountyMeta(contest).resolved);
        assertFalse(target.getBountyMeta(single).resolved);
        assertEq(token.balanceOf(address(escrow)), REWARD);
        target.autoApprove(single);
        assertEq(token.balanceOf(OWNER), 2 * NET);
        assertEq(token.balanceOf(FEE), 2 * REWARD / 100);
        (uint256 jobs, uint256 sum) = target.localReputation(target.identityKey(1, address(0)));
        assertEq(jobs, 2);
        assertEq(sum, 170);
    }

    function testRealEscrowCapacityPickAndParkedWinner() public {
        BountyAdapterV48.CreateParams memory p = _params();
        p.maxEntries = 2;
        p.winners = 2;
        uint256 job = _create(p);
        _enter(job, WORKING, 1);
        _enter(job, HUMAN, 0);
        usdc.setBlacklisted(OWNER, true);
        _pick(job, 2);
        assertEq(uint256(commerce.getJob(job).status), uint256(IAgenticCommerce.JobStatus.Completed));
        assertEq(adapter.pendingWithdrawals(OWNER), NET / 2);
        assertEq(usdc.balanceOf(HUMAN), NET / 2);
        assertEq(usdc.balanceOf(FEE), REWARD / 100);
        assertEq(usdc.balanceOf(address(commerce)), 0);
    }

    function testRealEscrowReplacementAndSilence() public {
        uint256 job = _create(_params());
        _enter(job, WORKING, 1);
        _enter(job, HUMAN, 0);
        vm.prank(OWNER);
        adapter.replaceContestEntry(job, 0, "ipfs://replacement");
        _silence(job);
        assertEq(usdc.balanceOf(OWNER), NET / 2);
        assertEq(usdc.balanceOf(HUMAN), NET / 2);
        assertEq(reputation.getFeedbackCount(), 0);
        assertEq(usdc.balanceOf(address(commerce)), 0);
    }

    function testRealEscrowFundedCancellationAndEmptyExpiry() public {
        uint256 job = _create(_params());
        vm.prank(POSTER);
        adapter.cancelBounty(job);
        job = _create(_params());
        _closed(job);
        vm.warp(block.timestamp + 1);
        adapter.expireBounty(job);
        assertEq(usdc.balanceOf(POSTER), 1000e6);
        assertEq(usdc.balanceOf(address(commerce)), 0);
    }

    function testRealEscrowPermissionlessRefundRecoveryWithMultipleJobs() public {
        uint256 job = _create(_params());
        _enter(job, WORKING, 1);
        _enter(job, HUMAN, 0);
        uint256 empty = _create(_params());
        vm.warp(commerce.getJob(job).expiredAt);
        commerce.claimRefund(job);
        commerce.claimRefund(empty);
        adapter.reconcileExpiredEscrow(job);
        adapter.reconcileExpiredEscrow(empty);
        assertEq(usdc.balanceOf(OWNER), REWARD / 2);
        assertEq(usdc.balanceOf(HUMAN), REWARD / 2);
        assertEq(usdc.balanceOf(POSTER), 1000e6 - REWARD);
        assertEq(usdc.balanceOf(FEE), 0);
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertEq(usdc.balanceOf(address(commerce)), 0);
    }
}
