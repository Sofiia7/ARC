// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "./BountyAdapterV48Contest.t.sol";
import {KeeperReceiver} from "../src/monad/KeeperReceiver.sol";

contract BountyAdapterV48KeeperTest is V48ContestFixture {
    KeeperReceiver internal receiver;
    address internal constant RELAYER = address(0x1234);
    address internal constant FORWARDER = address(0x5678);
    bytes32 internal constant WORKFLOW = keccak256("nadbounty-keeper");

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
        receiver = new KeeperReceiver(address(this), RELAYER, address(adapter), KeeperReceiver.AdapterKind.MonadV48);
    }

    function _run(uint8 kind, uint256 job) internal {
        KeeperReceiver.Action[] memory actions = new KeeperReceiver.Action[](1);
        actions[0] = KeeperReceiver.Action(kind, job);
        vm.prank(RELAYER);
        (uint256 successes, uint256 failures) = receiver.execute(actions);
        assertEq(successes, 1);
        assertEq(failures, 0);
        assertTrue(adapter.getBountyMeta(job).resolved);
    }

    function _single() internal returns (uint256 job) {
        BountyAdapterV48.CreateParams memory p = _params();
        p.contest = false;
        job = _create(p);
        vm.startPrank(WORKING);
        adapter.takeBounty(job, 1);
        adapter.submitWork(job, "ipfs://work");
        vm.stopPrank();
    }

    function _contest() internal returns (uint256 job) {
        BountyAdapterV48.CreateParams memory p = _params();
        p.maxEntries = 2;
        p.winners = 2;
        job = _create(p);
        _enter(job, WORKING, 1);
        _enter(job, HUMAN, 0);
    }

    function _rejectedContest() internal returns (uint256 job) {
        job = _contest();
        vm.prank(POSTER);
        adapter.rejectAllContestEntries(job, "ipfs://reason");
    }

    function _challengeBoth(uint256 job) internal {
        vm.prank(WORKING);
        adapter.challengeContestRejection(job, 0, "ipfs://evidence");
        vm.prank(HUMAN);
        adapter.challengeContestRejection(job, 1, "ipfs://evidence");
    }

    function testKeeperAutoApprovesSingleTakerWithScore80() public {
        uint256 job = _single();
        vm.warp(adapter.getBountyMeta(job).submittedAt + 14 days + 1);
        _run(0, job);
        assertEq(usdc.balanceOf(OWNER), NET);
        _local(1, address(0), 1, 80);
    }

    function testKeeperExpiresZeroEntryFundedContestAtDeadline() public {
        uint256 job = _create(_params());
        _closed(job);
        _run(1, job);
        assertEq(usdc.balanceOf(POSTER), 1000e6);
        assertEq(usdc.balanceOf(FEE), 0);
    }

    function testKeeperFinalizesSingleTakerRejection() public {
        uint256 job = _single();
        vm.prank(POSTER);
        adapter.rejectBounty(job, "ipfs://reject");
        vm.warp(adapter.getBountyMeta(job).rejectedAt + 48 hours + 1);
        _run(2, job);
        assertEq(usdc.balanceOf(POSTER), 1000e6);
        assertEq(usdc.balanceOf(OWNER), 0);
    }

    function testKeeperClaimsSingleTakerWorkerDefault() public {
        uint256 job = _single();
        vm.prank(WORKING);
        adapter.disputeBounty(job, "ipfs://dispute");
        vm.warp(adapter.getBountyMeta(job).disputeRaisedAt + 48 hours + 1);
        _run(3, job);
        assertEq(usdc.balanceOf(OWNER), NET);
        _local(1, address(0), 0, 0);
    }

    function testKeeperClaimsSingleTakerArbitratorTimeout() public {
        uint256 job = _single();
        vm.prank(WORKING);
        adapter.disputeBounty(job, "ipfs://dispute");
        vm.prank(POSTER);
        adapter.respondToDispute(job, "ipfs://response");
        vm.warp(adapter.getBountyMeta(job).disputeRaisedAt + 30 days + 1);
        _run(4, job);
        assertEq(usdc.balanceOf(OWNER), REWARD / 2);
        assertEq(usdc.balanceOf(POSTER), 1000e6 - REWARD / 2);
        assertEq(usdc.balanceOf(FEE), 0);
        _local(1, address(0), 0, 0);
    }

    function testKeeperReconcilesExpiredEscrowWithoutSecondEscrowCall() public {
        uint256 job = _contest();
        vm.warp(commerce.getJob(job).expiredAt);
        commerce.claimRefund(job);
        _run(5, job);
        assertEq(usdc.balanceOf(OWNER), REWARD / 2);
        assertEq(usdc.balanceOf(HUMAN), REWARD / 2);
        assertEq(usdc.balanceOf(FEE), 0);
        _local(1, address(0), 0, 0);
    }

    function testKeeperSettlesContestSilenceWithoutFeedback() public {
        uint256 job = _contest();
        vm.warp(adapter.contestClosedAt(job) + 14 days + 1);
        _run(6, job);
        assertEq(usdc.balanceOf(OWNER), NET / 2);
        assertEq(usdc.balanceOf(HUMAN), NET / 2);
        _local(1, address(0), 0, 0);
        assertEq(reputation.getFeedbackCount(), 0);
    }

    function testKeeperFinalizesUnchallengedContestRejection() public {
        uint256 job = _rejectedContest();
        vm.warp(adapter.getBountyMeta(job).rejectedAt + 48 hours + 1);
        _run(7, job);
        assertEq(usdc.balanceOf(POSTER), 1000e6);
        assertEq(usdc.balanceOf(FEE), 0);
    }

    function testKeeperClaimsContestDefaultAtPerChallengeDeadline() public {
        uint256 job = _rejectedContest();
        _challengeBoth(job);
        vm.warp(adapter.getContestChallenge(job, 0).challengedAt + 48 hours + 1);
        _run(8, job);
        assertEq(usdc.balanceOf(OWNER), NET / 2);
        assertEq(usdc.balanceOf(HUMAN), NET / 2);
        _local(1, address(0), 0, 0);
    }

    function testKeeperClaimsContestArbitratorTimeout() public {
        uint256 job = _rejectedContest();
        _challengeBoth(job);
        vm.prank(POSTER);
        adapter.respondToContestChallenges(job, "ipfs://response");
        vm.warp(adapter.getBountyMeta(job).disputeRaisedAt + 30 days + 1);
        _run(9, job);
        assertEq(usdc.balanceOf(OWNER), REWARD / 4);
        assertEq(usdc.balanceOf(HUMAN), REWARD / 4);
        assertEq(usdc.balanceOf(POSTER), 1000e6 - REWARD / 2);
        assertEq(usdc.balanceOf(FEE), 0);
        _local(1, address(0), 0, 0);
    }

    function testKeeperMixedBatchSkipsReplayUnknownAndNotMatureJobsWhilePaused() public {
        uint256 silence = _contest();
        vm.warp(adapter.contestClosedAt(silence) + 14 days + 1);
        uint256 rejection = _rejectedContest();
        uint256 immature = _single();
        vm.warp(adapter.getBountyMeta(rejection).rejectedAt + 48 hours + 1);
        adapter.setPaused(true);
        KeeperReceiver.Action[] memory actions = new KeeperReceiver.Action[](5);
        actions[0] = KeeperReceiver.Action(6, silence);
        actions[1] = KeeperReceiver.Action(6, silence);
        actions[2] = KeeperReceiver.Action(0, 999);
        actions[3] = KeeperReceiver.Action(0, immature);
        actions[4] = KeeperReceiver.Action(7, rejection);
        vm.prank(RELAYER);
        (uint256 successes, uint256 failures) = receiver.execute(actions);
        assertEq(successes, 2);
        assertEq(failures, 3);
        assertTrue(adapter.getBountyMeta(silence).resolved);
        assertTrue(adapter.getBountyMeta(rejection).resolved);
        assertFalse(adapter.getBountyMeta(immature).resolved);
        assertEq(usdc.balanceOf(address(commerce)), REWARD);
        assertEq(usdc.balanceOf(OWNER), NET / 2);
        assertEq(usdc.balanceOf(HUMAN), NET / 2);
        _local(1, address(0), 0, 0);
    }

    function testKeeperParksBlacklistedSharesAndDoesNotBlockOtherEntrants() public {
        uint256 job = _contest();
        usdc.setBlacklisted(OWNER, true);
        usdc.setBlacklisted(FEE, true);
        vm.warp(adapter.contestClosedAt(job) + 14 days + 1);
        _run(6, job);
        assertEq(adapter.pendingWithdrawals(OWNER), NET / 2);
        assertEq(adapter.pendingWithdrawals(FEE), REWARD / 100);
        assertEq(usdc.balanceOf(HUMAN), NET / 2);
    }

    function testForwarderReportSettles25AgentTimeoutWithinPerActionGasCap() public {
        BountyAdapterV48.CreateParams memory p = _params();
        p.maxEntries = 25;
        p.winners = 25;
        uint256 job = _create(p);
        for (uint256 i; i < 25; ++i) {
            address holder = address(uint160(0x2000 + i));
            identity.setOwner(i + 1, holder);
            _enter(job, holder, i + 1);
        }
        vm.prank(POSTER);
        adapter.rejectAllContestEntries(job, "ipfs://reason");
        for (uint8 i; i < 25; ++i) {
            vm.prank(address(uint160(0x2000 + i)));
            adapter.challengeContestRejection(job, i, "ipfs://evidence");
        }
        vm.prank(POSTER);
        adapter.respondToContestChallenges(job, "ipfs://response");
        vm.warp(adapter.getBountyMeta(job).disputeRaisedAt + 30 days + 1);
        receiver.setForwarder(FORWARDER, WORKFLOW);
        KeeperReceiver.Action[] memory actions = new KeeperReceiver.Action[](1);
        actions[0] = KeeperReceiver.Action(9, job);
        vm.prank(FORWARDER);
        receiver.onReport(abi.encodePacked(WORKFLOW, bytes10(0), bytes20(0)), abi.encode(actions));
        assertTrue(adapter.getBountyMeta(job).resolved);
        for (uint256 i; i < 25; ++i) {
            assertEq(usdc.balanceOf(address(uint160(0x2000 + i))), REWARD / 2 / 25);
            _local(i + 1, address(0), 0, 0);
        }
        assertEq(usdc.balanceOf(address(commerce)), 0);
        assertEq(usdc.balanceOf(address(adapter)), 0);
    }
}
