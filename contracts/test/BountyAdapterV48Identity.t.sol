// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Test.sol";
import "../src/monad/BountyAdapterV48.sol";
import "../src/base/AgenticCommerce.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MockUSDC, MockAgenticCommerce, MockReputationRegistry} from "./BountyAdapter.t.sol";

contract MockV48IdentityRegistry {
    mapping(uint256 => address) public owners;
    mapping(uint256 => address) public wallets;
    bool public unavailable;
    bool public walletUnavailable;

    function ownerOf(uint256 agentId) external view returns (address) {
        require(!unavailable, "registry unavailable");
        require(owners[agentId] != address(0), "unknown identity");
        return owners[agentId];
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        require(!walletUnavailable, "wallet read unavailable");
        return wallets[agentId];
    }

    function setOwner(uint256 agentId, address next) external {
        owners[agentId] = next;
        delete wallets[agentId]; // ERC-8004 clears the working wallet on transfer.
    }

    function setWallet(uint256 agentId, address next) external {
        wallets[agentId] = next;
    }

    function setUnavailable(bool value) external {
        unavailable = value;
    }

    function setWalletUnavailable(bool value) external {
        walletUnavailable = value;
    }
}

/// @dev Adversarial token callback tests the shared settlement reentrancy guard.
contract CallbackUSDC is ERC20 {
    address internal callbackAdapter;
    uint256 internal callbackJob;
    bool internal enabled;
    bool public attempted;
    bool public reentered;
    bytes public reentryReason;

    constructor() ERC20("USDC", "USDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function configureCallback(address target, uint256 jobId) external {
        callbackAdapter = target;
        callbackJob = jobId;
        enabled = true;
    }

    function _update(address from, address to, uint256 amount) internal override {
        super._update(from, to, amount);
        if (enabled && from != address(0) && to == callbackAdapter) {
            enabled = false;
            attempted = true;
            (reentered, reentryReason) =
                callbackAdapter.call(abi.encodeCall(BountyAdapterV48.autoApprove, (callbackJob)));
        }
    }
}

contract BountyAdapterV48IdentityTest is Test {
    BountyAdapterV48 internal adapter;
    ReputationMirror internal mirror;
    MockUSDC internal usdc;
    MockAgenticCommerce internal commerce;
    MockV48IdentityRegistry internal identity;
    MockReputationRegistry internal reputation;

    address internal constant POSTER = address(0x1001);
    address internal constant OWNER = address(0x1002);
    address internal constant WORKING = address(0x1003);
    address internal constant NEXT_WORKING = address(0x1004);
    address internal constant NEXT_OWNER = address(0x1005);
    address internal constant HUMAN = address(0x1006);
    address internal constant RELAYER = address(0x1007);
    address internal constant FEE = address(0x1008);
    uint256 internal constant AGENT = 1;
    uint256 internal constant REWARD = 10e6;
    uint256 internal constant NET = 9.9e6;

    function setUp() public {
        vm.warp(1000);
        usdc = new MockUSDC();
        commerce = new MockAgenticCommerce(address(usdc));
        identity = new MockV48IdentityRegistry();
        reputation = new MockReputationRegistry();
        mirror = new ReputationMirror(address(this), RELAYER);
        adapter = new BountyAdapterV48(
            address(commerce), address(identity), address(reputation), address(usdc), FEE, address(mirror)
        );
        adapter.setPaused(false);
        identity.setOwner(AGENT, OWNER);
        identity.setWallet(AGENT, WORKING);
        usdc.mint(POSTER, 1000e6);
        vm.prank(POSTER);
        usdc.approve(address(adapter), type(uint256).max);
        usdc.mint(WORKING, 100e6);
        vm.prank(WORKING);
        usdc.approve(address(adapter), type(uint256).max);
    }

    function _params() internal view returns (BountyAdapterV48.CreateParams memory p) {
        p.reward = REWARD;
        p.deadline = block.timestamp + 7 days;
        p.ipfsDescHash = "ipfs://description";
        p.category = "dev";
        p.tags = new string[](0);
    }

    function _create(BountyAdapterV48.CreateParams memory p) internal returns (uint256 jobId) {
        vm.prank(POSTER);
        return adapter.createBounty(p);
    }

    function _takeSubmit(address caller, uint256 agentId) internal returns (uint256 jobId) {
        jobId = _create(_params());
        vm.startPrank(caller);
        adapter.takeBounty(jobId, agentId);
        adapter.submitWork(jobId, "ipfs://result");
        vm.stopPrank();
    }

    function _approve(uint256 jobId, uint8 score) internal {
        vm.prank(POSTER);
        adapter.approveBounty(jobId, score);
    }

    function _local(uint256 agentId, address humanWallet, uint256 expectedJobs, uint256 expectedSum) internal view {
        (uint256 jobs, uint256 sum) = adapter.localReputation(adapter.identityKey(agentId, humanWallet));
        assertEq(jobs, expectedJobs);
        assertEq(sum, expectedSum);
    }

    function _mirror(address identityOwner, uint256 chain, uint64 jobs, uint128 sum) internal {
        ReputationMirror.Update[] memory updates = new ReputationMirror.Update[](1);
        updates[0] = ReputationMirror.Update(identityOwner, chain, 100, jobs, sum);
        vm.prank(RELAYER);
        mirror.updateRecords(updates);
    }

    function testDeploymentIsPausedWithFixedFeeAndInitialCap() public {
        BountyAdapterV48 fresh = new BountyAdapterV48(
            address(commerce), address(identity), address(reputation), address(usdc), FEE, address(mirror)
        );
        assertTrue(fresh.paused());
        assertEq(fresh.feeBps(), 100);
        assertEq(fresh.maxBountyAmount(), 100e6);
        assertEq(fresh.owner(), address(this));
        assertEq(fresh.arbitrator(), address(this));
        vm.prank(POSTER);
        vm.expectRevert("paused");
        fresh.createBounty(_params());
    }

    function testBytecodeFitsMonadLimits() public view {
        assertLe(address(adapter).code.length, 131072);
        assertLe(type(BountyAdapterV48).creationCode.length + 6 * 32, 262144);
    }

    function testWorkingWalletTakesAndOwnerReceivesApprove() public {
        uint256 jobId = _takeSubmit(WORKING, AGENT);
        _approve(jobId, 90);
        assertEq(usdc.balanceOf(OWNER), NET);
        assertEq(usdc.balanceOf(WORKING), 100e6);
        assertEq(usdc.balanceOf(FEE), REWARD / 100);
        assertEq(adapter.getBountyMeta(jobId).assignedProvider, WORKING);
        _local(AGENT, address(0), 1, 90);
    }

    function testOwnerCanTakeEvenWhenWorkingWalletReadReverts() public {
        identity.setWalletUnavailable(true);
        uint256 jobId = _takeSubmit(OWNER, AGENT);
        _approve(jobId, 100);
        assertEq(usdc.balanceOf(OWNER), NET);
    }

    function testUnknownIdentityAndUnregisteredWorkingKeyCannotTake() public {
        uint256 jobId = _create(_params());
        vm.prank(WORKING);
        vm.expectRevert(BountyAdapterV48.InvalidIdentity.selector);
        adapter.takeBounty(jobId, 999);
        identity.setOwner(AGENT, address(0));
        identity.setWallet(AGENT, WORKING);
        vm.prank(WORKING);
        vm.expectRevert(BountyAdapterV48.InvalidIdentity.selector);
        adapter.takeBounty(jobId, AGENT);
    }

    function testRevokedWorkingKeyCannotTakeOrSubmit() public {
        uint256 taken = _create(_params());
        uint256 open = _create(_params());
        vm.prank(WORKING);
        adapter.takeBounty(taken, AGENT);
        identity.setWallet(AGENT, NEXT_WORKING);
        vm.prank(WORKING);
        vm.expectRevert("not assigned provider");
        adapter.submitWork(taken, "ipfs://stolen-key");
        vm.prank(WORKING);
        vm.expectRevert("agent only: caller is not agent owner");
        adapter.takeBounty(open, AGENT);
        vm.prank(NEXT_WORKING);
        adapter.submitWork(taken, "ipfs://replacement-key");
        _approve(taken, 85);
        assertEq(usdc.balanceOf(OWNER), NET);
    }

    function testTransferClearsWalletAndNewOwnerCanSubmitAndReceivePayment() public {
        uint256 jobId = _create(_params());
        vm.prank(WORKING);
        adapter.takeBounty(jobId, AGENT);
        identity.setOwner(AGENT, NEXT_OWNER);
        vm.prank(OWNER);
        vm.expectRevert("not assigned provider");
        adapter.submitWork(jobId, "ipfs://old-owner");
        vm.prank(WORKING);
        vm.expectRevert("not assigned provider");
        adapter.submitWork(jobId, "ipfs://old-wallet");
        vm.prank(NEXT_OWNER);
        adapter.submitWork(jobId, "ipfs://new-owner");
        _approve(jobId, 91);
        assertEq(usdc.balanceOf(NEXT_OWNER), NET);
        assertEq(usdc.balanceOf(OWNER), 0);
        _local(AGENT, address(0), 1, 91);
    }

    function testTransferAfterSubmissionPaysCurrentOwner() public {
        uint256 jobId = _takeSubmit(WORKING, AGENT);
        identity.setOwner(AGENT, NEXT_OWNER);
        _approve(jobId, 88);
        assertEq(usdc.balanceOf(NEXT_OWNER), NET);
        assertEq(usdc.balanceOf(OWNER), 0);
    }

    function testReservedOwnerAndReservedCallerAllowWorkingWallet() public {
        BountyAdapterV48.CreateParams memory p = _params();
        p.provider = OWNER;
        uint256 jobId = _create(p);
        vm.prank(WORKING);
        adapter.takeBounty(jobId, AGENT);
        // Reservation names the authorized caller or owner, not every sibling key.
        p.provider = WORKING;
        jobId = _create(p);
        vm.prank(WORKING);
        adapter.takeBounty(jobId, AGENT);
        p.provider = HUMAN;
        jobId = _create(p);
        vm.prank(WORKING);
        vm.expectRevert("not whitelisted");
        adapter.takeBounty(jobId, AGENT);
    }

    function testAgentOnlyAndHumanOnlyApplyToWorkingWallet() public {
        BountyAdapterV48.CreateParams memory p = _params();
        p.agentOnly = true;
        uint256 jobId = _create(p);
        vm.prank(WORKING);
        adapter.takeBounty(jobId, AGENT);
        p.agentOnly = false;
        p.humanOnly = true;
        jobId = _create(p);
        vm.prank(WORKING);
        vm.expectRevert("human only: no agentId");
        adapter.takeBounty(jobId, AGENT);
    }

    function testAutoApprovePaysOwnerAndRecordsScore80() public {
        uint256 jobId = _takeSubmit(WORKING, AGENT);
        vm.warp(block.timestamp + adapter.APPROVAL_TIMEOUT() + 1);
        adapter.autoApprove(jobId);
        assertEq(usdc.balanceOf(OWNER), NET);
        _local(AGENT, address(0), 1, 80);
    }

    function testHumanApproveAndAutoApproveUseHumanIdentity() public {
        uint256 jobId = _takeSubmit(HUMAN, 0);
        _approve(jobId, 100);
        jobId = _takeSubmit(HUMAN, 0);
        vm.warp(block.timestamp + adapter.APPROVAL_TIMEOUT() + 1);
        adapter.autoApprove(jobId);
        assertEq(usdc.balanceOf(HUMAN), 2 * NET);
        _local(0, HUMAN, 2, 180);
        _local(AGENT, address(0), 0, 0);
    }

    function testFeedbackFailureCannotBlockEarningsOrLocalScore() public {
        uint256 jobId = _takeSubmit(WORKING, AGENT);
        vm.mockCallRevert(
            address(reputation),
            abi.encodeWithSelector(IReputationRegistry.giveFeedback.selector),
            "registry refuses feedback"
        );
        _approve(jobId, 95);
        assertTrue(adapter.getBountyMeta(jobId).resolved);
        assertEq(usdc.balanceOf(OWNER), NET);
        _local(AGENT, address(0), 1, 95);
    }

    function testWorkerInitiatedDefaultSurvivesWalletRotation() public {
        uint256 jobId = _takeSubmit(WORKING, AGENT);
        vm.prank(WORKING);
        adapter.disputeBounty(jobId, "ipfs://reason");
        identity.setWallet(AGENT, NEXT_WORKING);
        vm.warp(block.timestamp + adapter.DISPUTE_RESPONSE_WINDOW() + 1);
        adapter.claimDefaultRuling(jobId);
        assertEq(usdc.balanceOf(OWNER), NET);
        _local(AGENT, address(0), 0, 0);
    }

    function testWorkerInitiatedDefaultSurvivesIdentityTransfer() public {
        uint256 jobId = _takeSubmit(WORKING, AGENT);
        vm.prank(OWNER);
        adapter.disputeBounty(jobId, "ipfs://reason");
        identity.setOwner(AGENT, NEXT_OWNER);
        vm.warp(block.timestamp + adapter.DISPUTE_RESPONSE_WINDOW() + 1);
        adapter.claimDefaultRuling(jobId);
        assertEq(usdc.balanceOf(NEXT_OWNER), NET);
        assertEq(usdc.balanceOf(OWNER), 0);
    }

    function testPosterDisputeResponseAllowsNewWalletAndRejectsRevokedWallet() public {
        uint256 jobId = _takeSubmit(WORKING, AGENT);
        vm.prank(POSTER);
        adapter.disputeBounty(jobId, "ipfs://reason");
        identity.setWallet(AGENT, NEXT_WORKING);
        vm.prank(WORKING);
        vm.expectRevert("not the respondent");
        adapter.respondToDispute(jobId, "ipfs://old-key");
        vm.prank(NEXT_WORKING);
        adapter.respondToDispute(jobId, "ipfs://new-key");
        adapter.resolveDispute(jobId, true, "ipfs://ruling", 0);
        assertEq(usdc.balanceOf(OWNER), NET);
        _local(AGENT, address(0), 0, 0);
    }

    function testOwnerChallengeSurvivesRotationAndPosterCanRespond() public {
        uint256 jobId = _takeSubmit(WORKING, AGENT);
        vm.prank(POSTER);
        adapter.rejectBounty(jobId, "ipfs://rejection");
        identity.setWallet(AGENT, NEXT_WORKING);
        vm.prank(WORKING);
        vm.expectRevert("only worker");
        adapter.challengeRejection(jobId, "ipfs://stolen-key");
        vm.prank(OWNER);
        adapter.challengeRejection(jobId, "ipfs://evidence");
        vm.prank(POSTER);
        adapter.respondToDispute(jobId, "ipfs://response");
        adapter.resolveDispute(jobId, true, "ipfs://ruling", 0);
        assertEq(usdc.balanceOf(OWNER), NET);
    }

    function testArbitratorTimeoutPaysCurrentOwnerWithoutLocalScoreOrFee() public {
        uint256 jobId = _takeSubmit(WORKING, AGENT);
        vm.prank(WORKING);
        adapter.disputeBounty(jobId, "ipfs://reason");
        vm.prank(POSTER);
        adapter.respondToDispute(jobId, "ipfs://response");
        identity.setOwner(AGENT, NEXT_OWNER);
        vm.warp(block.timestamp + adapter.ARBITRATOR_TIMEOUT() + 1);
        adapter.claimArbitratorTimeout(jobId);
        assertEq(usdc.balanceOf(NEXT_OWNER), REWARD / 2);
        assertEq(usdc.balanceOf(FEE), 0);
        _local(AGENT, address(0), 0, 0);
    }

    function testDisputeLossDoesNotInflatePaidJobCounters() public {
        uint256 jobId = _takeSubmit(WORKING, AGENT);
        vm.prank(POSTER);
        adapter.disputeBounty(jobId, "ipfs://reason");
        adapter.resolveDispute(jobId, false, "ipfs://ruling", 100);
        _local(AGENT, address(0), 0, 0);
        (, int256 penalty,) = reputation.feedbackCalls(0);
        assertEq(penalty, -100);
    }

    function testExpiredEscrowAutoApprovalPaysCurrentOwnerAndScores80() public {
        uint256 jobId = _takeSubmit(WORKING, AGENT);
        uint256 deadline = adapter.getBountyMeta(jobId).deadline;
        identity.setOwner(AGENT, NEXT_OWNER);
        vm.warp(deadline + adapter.AC_EXPIRY_BUFFER() + 1);
        commerce.claimRefund(jobId);
        adapter.reconcileExpiredEscrow(jobId);
        assertEq(usdc.balanceOf(NEXT_OWNER), REWARD);
        assertEq(usdc.balanceOf(FEE), 0);
        _local(AGENT, address(0), 1, 80);
    }

    function testExpiredEscrowWorkerDefaultUsesSideAndCurrentOwner() public {
        uint256 jobId = _takeSubmit(WORKING, AGENT);
        vm.prank(OWNER);
        adapter.disputeBounty(jobId, "ipfs://reason");
        identity.setOwner(AGENT, NEXT_OWNER);
        vm.warp(adapter.getBountyMeta(jobId).deadline + adapter.AC_EXPIRY_BUFFER() + 1);
        commerce.claimRefund(jobId);
        adapter.reconcileExpiredEscrow(jobId);
        assertEq(usdc.balanceOf(NEXT_OWNER), REWARD);
        _local(AGENT, address(0), 0, 0);
    }

    function testBlacklistedOwnerParksAtOwnerAndWorkingKeyCannotWithdraw() public {
        uint256 jobId = _takeSubmit(WORKING, AGENT);
        usdc.setBlacklisted(OWNER, true);
        _approve(jobId, 90);
        assertEq(adapter.pendingWithdrawals(OWNER), NET);
        assertEq(adapter.pendingWithdrawals(WORKING), 0);
        vm.prank(WORKING);
        vm.expectRevert("nothing to withdraw");
        adapter.withdraw();
        usdc.setBlacklisted(OWNER, false);
        vm.prank(OWNER);
        adapter.withdraw();
        assertEq(usdc.balanceOf(OWNER), NET);
        _local(AGENT, address(0), 1, 90);
    }

    function testMalformedBooleanReturnParksOwnerPayoutWithoutReverting() public {
        uint256 jobId = _takeSubmit(WORKING, AGENT);
        vm.mockCall(address(usdc), abi.encodeCall(IERC20.transfer, (OWNER, NET)), abi.encode(uint256(2)));
        _approve(jobId, 90);
        assertTrue(adapter.getBountyMeta(jobId).resolved);
        assertEq(adapter.pendingWithdrawals(OWNER), NET);
        assertEq(usdc.balanceOf(address(adapter)), NET);
        _local(AGENT, address(0), 1, 90);
        vm.clearMockedCalls();
        vm.prank(OWNER);
        adapter.withdraw();
        assertEq(usdc.balanceOf(OWNER), NET);
    }

    function testOwnerLookupFailureParksIdentityWithoutBlockingSettlement() public {
        uint256 jobId = _takeSubmit(WORKING, AGENT);
        identity.setUnavailable(true);
        _approve(jobId, 92);
        assertTrue(adapter.getBountyMeta(jobId).resolved);
        assertEq(adapter.pendingIdentityWithdrawals(AGENT), NET);
        assertEq(adapter.pendingWithdrawals(WORKING), 0);
        assertEq(usdc.balanceOf(FEE), REWARD / 100);
        _local(AGENT, address(0), 1, 92);
        identity.setUnavailable(false);
        vm.prank(WORKING);
        vm.expectRevert("only identity owner");
        adapter.withdrawIdentity(AGENT);
        identity.setOwner(AGENT, NEXT_OWNER);
        vm.prank(NEXT_OWNER);
        adapter.withdrawIdentity(AGENT);
        assertEq(usdc.balanceOf(NEXT_OWNER), NET);
        assertEq(adapter.pendingIdentityWithdrawals(AGENT), 0);
    }

    function testIdentityWithdrawalRevertKeepsCreditAndOtherJobsCanSettle() public {
        uint256 first = _takeSubmit(WORKING, AGENT);
        identity.setUnavailable(true);
        _approve(first, 90);
        identity.setUnavailable(false);
        usdc.setBlacklisted(OWNER, true);
        vm.prank(OWNER);
        vm.expectRevert("Blacklistable: recipient blacklisted");
        adapter.withdrawIdentity(AGENT);
        assertEq(adapter.pendingIdentityWithdrawals(AGENT), NET);
        uint256 second = _takeSubmit(HUMAN, 0);
        _approve(second, 100);
        assertEq(usdc.balanceOf(HUMAN), NET);
        assertEq(usdc.balanceOf(address(adapter)), NET);
    }

    function testUnavailableIdentityDoesNotBlockArbitratorTimeoutOrReconcile() public {
        uint256 timeoutJob = _takeSubmit(WORKING, AGENT);
        uint256 expiredJob = _takeSubmit(WORKING, AGENT);
        vm.prank(WORKING);
        adapter.disputeBounty(timeoutJob, "ipfs://reason");
        vm.prank(POSTER);
        adapter.respondToDispute(timeoutJob, "ipfs://response");
        identity.setUnavailable(true);
        vm.warp(block.timestamp + adapter.ARBITRATOR_TIMEOUT() + 1);
        adapter.claimArbitratorTimeout(timeoutJob);
        vm.warp(adapter.getBountyMeta(expiredJob).deadline + adapter.AC_EXPIRY_BUFFER() + 1);
        commerce.claimRefund(expiredJob);
        adapter.reconcileExpiredEscrow(expiredJob);
        assertEq(adapter.pendingIdentityWithdrawals(AGENT), REWARD / 2 + REWARD);
        _local(AGENT, address(0), 1, 80);
    }

    function testBondReturnRemainsWithOriginalPayerAfterRotation() public {
        BountyAdapterV48.CreateParams memory p = _params();
        p.requireWorkerBond = true;
        uint256 jobId = _create(p);
        vm.prank(WORKING);
        adapter.takeBounty(jobId, AGENT);
        assertEq(usdc.balanceOf(WORKING), 98.5e6);
        assertEq(adapter.getBountyMeta(jobId).bondPayer, WORKING);
        identity.setWallet(AGENT, NEXT_WORKING);
        vm.prank(NEXT_WORKING);
        adapter.submitWork(jobId, "ipfs://result");
        assertEq(usdc.balanceOf(WORKING), 100e6);
        assertEq(usdc.balanceOf(NEXT_WORKING), 0);
        _approve(jobId, 90);
        assertEq(usdc.balanceOf(OWNER), NET);
    }

    function testPauseBlocksAdmissionsButAllowsSubmitApproveAndOwnerClaims() public {
        uint256 jobId = _create(_params());
        uint256 open = _create(_params());
        vm.prank(WORKING);
        adapter.takeBounty(jobId, AGENT);
        adapter.setPaused(true);
        vm.prank(WORKING);
        vm.expectRevert("paused");
        adapter.takeBounty(open, AGENT);
        vm.prank(WORKING);
        adapter.submitWork(jobId, "ipfs://result");
        identity.setUnavailable(true);
        _approve(jobId, 90);
        identity.setUnavailable(false);
        vm.prank(OWNER);
        adapter.withdrawIdentity(AGENT);
        assertEq(usdc.balanceOf(OWNER), NET);
    }

    function testGateValidatesScoreAndFailsEmptyPositiveGate() public {
        BountyAdapterV48.CreateParams memory p = _params();
        p.minAvgScore = 101;
        vm.prank(POSTER);
        vm.expectRevert(BountyAdapterV48.InvalidGateScore.selector);
        adapter.createBounty(p);
        p.minAvgScore = 80;
        uint256 jobId = _create(p);
        vm.prank(WORKING);
        vm.expectRevert(abi.encodeWithSelector(BountyAdapterV48.ReputationGateFailed.selector, 0, 0));
        adapter.takeBounty(jobId, AGENT);
        assertFalse(adapter.getBountyMeta(jobId).isTaken);
        assertEq(usdc.balanceOf(address(commerce)), 0);
    }

    function testLocalGatePassesAtExactThresholdAndFailsAboveIt() public {
        _approve(_takeSubmit(WORKING, AGENT), 80);
        BountyAdapterV48.CreateParams memory p = _params();
        p.minJobs = 1;
        p.minAvgScore = 80;
        uint256 jobId = _create(p);
        vm.prank(WORKING);
        adapter.takeBounty(jobId, AGENT);
        p.minAvgScore = 81;
        jobId = _create(p);
        vm.prank(WORKING);
        vm.expectRevert(abi.encodeWithSelector(BountyAdapterV48.ReputationGateFailed.selector, 1, 80));
        adapter.takeBounty(jobId, AGENT);
        p.minJobs = 2;
        p.minAvgScore = 0;
        jobId = _create(p);
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(BountyAdapterV48.ReputationGateFailed.selector, 1, 80));
        adapter.takeBounty(jobId, AGENT);
    }

    function testGateWeightsLocalBaseAndArcByJobCount() public {
        _approve(_takeSubmit(WORKING, AGENT), 100);
        _mirror(OWNER, 8453, 3, 240);
        _mirror(OWNER, 5042, 6, 480);
        (uint256 jobs, uint256 sum) = adapter.getIdentityReputation(AGENT, address(0));
        assertEq(jobs, 10);
        assertEq(sum, 820);
        BountyAdapterV48.CreateParams memory p = _params();
        p.minJobs = 10;
        p.minAvgScore = 82;
        uint256 jobId = _create(p);
        vm.prank(OWNER);
        adapter.takeBounty(jobId, AGENT);
        p.minAvgScore = 83;
        jobId = _create(p);
        vm.prank(WORKING);
        vm.expectRevert(abi.encodeWithSelector(BountyAdapterV48.ReputationGateFailed.selector, 10, 820));
        adapter.takeBounty(jobId, AGENT);
    }

    function testGateUsesOwnerMirrorNotWorkingWalletMirror() public {
        _mirror(WORKING, 8453, 100, 10000);
        BountyAdapterV48.CreateParams memory p = _params();
        p.minJobs = 3;
        p.minAvgScore = 80;
        uint256 jobId = _create(p);
        vm.prank(WORKING);
        vm.expectRevert(abi.encodeWithSelector(BountyAdapterV48.ReputationGateFailed.selector, 0, 0));
        adapter.takeBounty(jobId, AGENT);
        _mirror(OWNER, 8453, 3, 240);
        vm.prank(WORKING);
        adapter.takeBounty(jobId, AGENT);
    }

    function testHumanGateSumsItsLocalAndMirroredHistory() public {
        _approve(_takeSubmit(HUMAN, 0), 80);
        _mirror(HUMAN, 5042, 2, 160);
        BountyAdapterV48.CreateParams memory p = _params();
        p.minJobs = 3;
        p.minAvgScore = 80;
        uint256 jobId = _create(p);
        vm.prank(HUMAN);
        adapter.takeBounty(jobId, 0);
        (uint256 jobs, uint256 sum) = adapter.getIdentityReputation(0, HUMAN);
        assertEq(jobs, 3);
        assertEq(sum, 240);
    }

    function testIdentityTransferRetainsLocalHistoryAndSwitchesMirrorOwner() public {
        _approve(_takeSubmit(WORKING, AGENT), 100);
        _mirror(OWNER, 8453, 10, 1000);
        _mirror(NEXT_OWNER, 5042, 2, 160);
        identity.setOwner(AGENT, NEXT_OWNER);
        (uint256 jobs, uint256 sum) = adapter.getIdentityReputation(AGENT, address(0));
        assertEq(jobs, 3);
        assertEq(sum, 260);
        BountyAdapterV48.CreateParams memory p = _params();
        p.minJobs = 3;
        p.minAvgScore = 86;
        uint256 jobId = _create(p);
        vm.prank(NEXT_OWNER);
        adapter.takeBounty(jobId, AGENT);
    }

    function testGateIsAdmissionOnlyAndMirrorCorrectionDoesNotTrapTakenWork() public {
        _mirror(OWNER, 8453, 3, 300);
        BountyAdapterV48.CreateParams memory p = _params();
        p.minJobs = 3;
        p.minAvgScore = 90;
        uint256 jobId = _create(p);
        vm.prank(WORKING);
        adapter.takeBounty(jobId, AGENT);
        mirror.invalidateRecord(OWNER, 8453);
        vm.prank(WORKING);
        adapter.submitWork(jobId, "ipfs://result");
        _approve(jobId, 90);
        assertEq(usdc.balanceOf(OWNER), NET);
    }

    function testOpenGateDoesNotDependOnMirrorAvailability() public {
        vm.mockCallRevert(address(mirror), abi.encodeWithSelector(ReputationMirror.getTotals.selector), "mirror down");
        uint256 jobId = _takeSubmit(WORKING, AGENT);
        _approve(jobId, 90);
        assertEq(usdc.balanceOf(OWNER), NET);
    }

    function testHumanAndAgentLocalIdentityDomainsDoNotCollide() public view {
        assertNotEq(adapter.identityKey(AGENT, address(0)), adapter.identityKey(0, address(uint160(AGENT))));
        assertEq(adapter.identityKey(AGENT, WORKING), adapter.identityKey(AGENT, OWNER));
    }

    function testContestWorkerBondFailsBeforeMovingFunds() public {
        BountyAdapterV48.CreateParams memory p = _params();
        p.contest = true;
        p.maxEntries = 10;
        p.winners = 1;
        p.requireWorkerBond = true;
        vm.prank(POSTER);
        vm.expectRevert(BountyAdapterV48.InvalidContestParams.selector);
        adapter.createBounty(p);
    }

    function testDuplicateSettlementCannotIncreaseLocalCounters() public {
        uint256 jobId = _takeSubmit(WORKING, AGENT);
        _approve(jobId, 90);
        vm.prank(POSTER);
        vm.expectRevert("resolved");
        adapter.approveBounty(jobId, 100);
        vm.expectRevert("resolved");
        adapter.autoApprove(jobId);
        _local(AGENT, address(0), 1, 90);
        assertEq(usdc.balanceOf(OWNER), NET);
    }

    function testShortEscrowReceiptCannotConsumeAnotherJobsDepositOrRecordScore() public {
        uint256 jobId = _takeSubmit(WORKING, AGENT);
        uint256 open = _create(_params());
        vm.mockCall(address(commerce), abi.encodeWithSelector(IAgenticCommerce.complete.selector), "");
        vm.prank(POSTER);
        vm.expectRevert(abi.encodeWithSelector(BountyAdapterV48.UnexpectedEscrowAmount.selector, 0, REWARD));
        adapter.approveBounty(jobId, 90);
        assertFalse(adapter.getBountyMeta(jobId).resolved);
        _local(AGENT, address(0), 0, 0);
        assertEq(usdc.balanceOf(address(adapter)), REWARD);
        vm.clearMockedCalls();
        vm.prank(POSTER);
        adapter.cancelBounty(open);
        _approve(jobId, 90);
        assertEq(usdc.balanceOf(OWNER), NET);
    }
}

/// @notice Real pinned escrow integration for the working-wallet path.
contract BountyAdapterV48IdentityEscrowTest is Test {
    function testEscrowReceiptCallbackCannotReenterAnotherMatureSettlement() public {
        CallbackUSDC token = new CallbackUSDC();
        MockAgenticCommerce escrow = new MockAgenticCommerce(address(token));
        MockV48IdentityRegistry identity = new MockV48IdentityRegistry();
        MockReputationRegistry reputation = new MockReputationRegistry();
        ReputationMirror mirror = new ReputationMirror(address(this), address(0));
        BountyAdapterV48 adapter = new BountyAdapterV48(
            address(escrow), address(identity), address(reputation), address(token), address(0xFEE), address(mirror)
        );
        adapter.setPaused(false);
        identity.setOwner(1, address(0xCAFE));
        identity.setWallet(1, address(0xB0B));
        token.mint(address(this), 20e6);
        token.approve(address(adapter), 20e6);
        BountyAdapterV48.CreateParams memory p;
        p.reward = 10e6;
        p.deadline = block.timestamp + 7 days;
        p.ipfsDescHash = "ipfs://description";
        p.category = "dev";
        p.tags = new string[](0);
        uint256 first = adapter.createBounty(p);
        uint256 second = adapter.createBounty(p);
        vm.startPrank(address(0xB0B));
        adapter.takeBounty(first, 1);
        adapter.submitWork(first, "ipfs://first");
        adapter.takeBounty(second, 1);
        adapter.submitWork(second, "ipfs://second");
        vm.stopPrank();
        vm.warp(block.timestamp + adapter.APPROVAL_TIMEOUT() + 1);
        token.configureCallback(address(adapter), second);
        adapter.approveBounty(first, 90);
        assertTrue(token.attempted());
        assertFalse(token.reentered());
        assertEq(bytes4(token.reentryReason()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertFalse(adapter.getBountyMeta(second).resolved);
        assertEq(token.balanceOf(address(escrow)), 10e6);
        adapter.autoApprove(second);
        assertEq(token.balanceOf(address(0xCAFE)), 19.8e6);
        assertEq(token.balanceOf(address(0xFEE)), 0.2e6);
        (uint256 jobs, uint256 sum) = adapter.localReputation(adapter.identityKey(1, address(0)));
        assertEq(jobs, 2);
        assertEq(sum, 170);
    }

    function testWorkingWalletFlowThroughRealEscrowPaysIdentityOwner() public {
        MockUSDC token = new MockUSDC();
        MockV48IdentityRegistry identity = new MockV48IdentityRegistry();
        MockReputationRegistry reputation = new MockReputationRegistry();
        AgenticCommerce implementation = new AgenticCommerce();
        AgenticCommerce escrow = AgenticCommerce(
            address(
                new ERC1967Proxy(
                    address(implementation),
                    abi.encodeCall(AgenticCommerce.initialize, (address(token), address(0xFEE), address(this)))
                )
            )
        );
        ReputationMirror mirror = new ReputationMirror(address(this), address(0));
        BountyAdapterV48 adapter = new BountyAdapterV48(
            address(escrow), address(identity), address(reputation), address(token), address(0xFEE), address(mirror)
        );
        adapter.setPaused(false);
        identity.setOwner(1, address(0xCAFE));
        identity.setWallet(1, address(0xB0B));
        token.mint(address(this), 10e6);
        token.approve(address(adapter), 10e6);
        BountyAdapterV48.CreateParams memory p;
        p.reward = 10e6;
        p.deadline = block.timestamp + 7 days;
        p.ipfsDescHash = "ipfs://description";
        p.category = "dev";
        p.tags = new string[](0);
        uint256 jobId = adapter.createBounty(p);
        vm.startPrank(address(0xB0B));
        adapter.takeBounty(jobId, 1);
        adapter.submitWork(jobId, "ipfs://result");
        vm.stopPrank();
        adapter.approveBounty(jobId, 90);
        IAgenticCommerce.Job memory job = IAgenticCommerce(address(escrow)).getJob(jobId);
        assertEq(job.client, address(adapter));
        assertEq(job.provider, address(adapter));
        assertEq(job.evaluator, address(adapter));
        assertEq(uint256(job.status), uint256(IAgenticCommerce.JobStatus.Completed));
        assertEq(token.balanceOf(address(0xCAFE)), 9.9e6);
        assertEq(token.balanceOf(address(0xB0B)), 0);
    }
}
