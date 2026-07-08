// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "forge-std/Test.sol";
import "../src/BountyAdapter.sol";
import "../src/interfaces/IAgenticCommerce.sol";
import "../src/interfaces/IIdentityRegistry.sol";
import "../src/interfaces/IReputationRegistry.sol";

// ─── Mock USDC ────────────────────────────────────────────────────────────────

contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "insufficient allowance");
        require(balanceOf[from] >= amount, "insufficient balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

// ─── Mock AC that actually moves USDC like real AC ────────────────────────────

contract MockAgenticCommerce {
    uint256 private _nextJobId = 1;
    MockUSDC public usdc;

    enum S {
        OPEN,
        FUNDED,
        SUBMITTED,
        COMPLETED,
        REJECTED,
        EXPIRED
    }

    struct Job {
        address poster; // = client (calls createJob)
        address provider;
        address evaluator;
        uint256 deadline;
        uint256 budget;
        S status;
        bytes32 deliverable;
    }
    mapping(uint256 => Job) public jobs;

    constructor(address _usdc) {
        usdc = MockUSDC(_usdc);
    }

    function createJob(address provider, address evaluator, uint256 deadline, string calldata, address)
        external
        returns (uint256 jobId)
    {
        jobId = _nextJobId++;
        jobs[jobId] = Job(msg.sender, provider, evaluator, deadline, 0, S.OPEN, bytes32(0));
    }

    function setProvider(uint256 jobId, address p) external {
        jobs[jobId].provider = p;
    }

    function setBudget(uint256 jobId, uint256 amount, bytes calldata) external {
        jobs[jobId].budget = amount;
    }

    function fund(uint256 jobId, bytes calldata) external {
        Job storage j = jobs[jobId];
        require(msg.sender == j.poster, "not client");
        require(j.status == S.OPEN, "wrong status");
        usdc.transferFrom(msg.sender, address(this), j.budget);
        j.status = S.FUNDED;
    }

    function submit(uint256 jobId, bytes32 deliverable, bytes calldata) external {
        Job storage j = jobs[jobId];
        require(msg.sender == j.provider, "not provider");
        require(j.status == S.FUNDED, "wrong status");
        j.deliverable = deliverable;
        j.status = S.SUBMITTED;
    }

    function complete(uint256 jobId, bytes32, bytes calldata) external {
        Job storage j = jobs[jobId];
        require(msg.sender == j.evaluator, "not evaluator");
        require(j.status == S.SUBMITTED, "wrong status");
        j.status = S.COMPLETED;
        usdc.transfer(j.provider, j.budget); // pay provider
    }

    function reject(uint256 jobId, bytes32, bytes calldata) external {
        Job storage j = jobs[jobId];
        require(j.status == S.FUNDED || j.status == S.SUBMITTED, "wrong status");
        j.status = S.REJECTED;
        usdc.transfer(j.poster, j.budget); // refund client
    }

    function refund(uint256 jobId, bytes calldata) external {
        Job storage j = jobs[jobId];
        require(j.status == S.REJECTED, "wrong status");
        // no-op (already refunded on reject)
        jobId;
    }

    function expire(uint256 jobId, bytes calldata) external {
        Job storage j = jobs[jobId];
        j.status = S.EXPIRED;
    }

    function getJob(uint256 jobId) external view returns (IAgenticCommerce.Job memory) {
        Job storage j = jobs[jobId];
        return IAgenticCommerce.Job({
            poster: j.poster,
            provider: j.provider,
            evaluator: j.evaluator,
            deadline: j.deadline,
            status: IAgenticCommerce.JobStatus(uint8(j.status)),
            deliverable: j.deliverable
        });
    }
}

contract MockIdentityRegistry {
    mapping(uint256 => address) public owners;

    function register(string calldata) external returns (uint256) {
        return 0;
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        return owners[agentId];
    }

    function getMetadataURI(uint256) external pure returns (string memory) {
        return "";
    }

    function isRegistered(uint256 agentId) external view returns (bool) {
        return owners[agentId] != address(0);
    }

    function setOwner(uint256 agentId, address owner) external {
        owners[agentId] = owner;
    }
}

contract MockReputationRegistry {
    struct FeedbackCall {
        uint256 agentId;
        uint256 score;
        bytes32 feedbackHash;
    }
    FeedbackCall[] public feedbackCalls;

    function giveFeedback(
        uint256 a,
        uint256 s,
        uint256,
        string calldata,
        string calldata,
        string calldata,
        string calldata,
        bytes32 h
    ) external {
        feedbackCalls.push(FeedbackCall(a, s, h));
    }

    function getReputation(uint256) external pure returns (IReputationRegistry.ReputationScore memory) {
        return IReputationRegistry.ReputationScore({averageScore: 90, totalFeedbacks: 5, totalJobs: 5});
    }

    function getFeedbackCount() external view returns (uint256) {
        return feedbackCalls.length;
    }
}

// ─── Test suite ────────────────────────────────────────────────────────────────

contract BountyAdapterTest is Test {
    BountyAdapter adapter;
    MockUSDC usdc;
    MockAgenticCommerce commerce;
    MockIdentityRegistry identity;
    MockReputationRegistry reputation;

    address poster = address(0x1001);
    address worker = address(0x1002);
    address agent = address(0x1003);
    address feeAddr = address(0x1004);
    address stranger = address(0x1005);

    uint256 agentId = 1;
    uint256 reward = 10e6;
    uint256 deadline;

    string constant DESC = "ipfs://QmDesc";
    string constant RESULT = "ipfs://QmResult";
    string constant REASON = "ipfs://QmReason";
    string constant RESP = "ipfs://QmResp";
    string constant RULING = "ipfs://QmRule";
    string constant CAT = "dev";
    string[] tags;

    function setUp() public {
        deadline = block.timestamp + 7 days;
        tags = new string[](2);
        tags[0] = "solidity";
        tags[1] = "arc";

        usdc = new MockUSDC();
        commerce = new MockAgenticCommerce(address(usdc));
        identity = new MockIdentityRegistry();
        reputation = new MockReputationRegistry();

        adapter =
            new BountyAdapter(address(commerce), address(identity), address(reputation), address(usdc), feeAddr, 100);

        identity.setOwner(agentId, agent);
        usdc.mint(poster, 1000e6);
        vm.prank(poster);
        usdc.approve(address(adapter), type(uint256).max);

        // V4: workers need USDC + an allowance to post a worker bond.
        usdc.mint(worker, 1000e6);
        vm.prank(worker);
        usdc.approve(address(adapter), type(uint256).max);
        usdc.mint(agent, 1000e6);
        vm.prank(agent);
        usdc.approve(address(adapter), type(uint256).max);
    }

    function _createWithBond() internal returns (uint256) {
        BountyAdapter.CreateParams memory p = _params(false, false, address(0), CAT);
        p.requireWorkerBond = true;
        vm.prank(poster);
        return adapter.createBounty(p);
    }

    function _params(bool agentOnly, bool humanOnly, address provider, string memory cat)
        internal
        view
        returns (BountyAdapter.CreateParams memory)
    {
        return BountyAdapter.CreateParams({
            provider: provider,
            reward: reward,
            deadline: deadline,
            ipfsDescHash: DESC,
            category: cat,
            tags: tags,
            agentOnly: agentOnly,
            humanOnly: humanOnly,
            requireWorkerBond: false
        });
    }

    function _create() internal returns (uint256) {
        vm.prank(poster);
        return adapter.createBounty(_params(false, false, address(0), CAT));
    }

    function _createAgentOnly() internal returns (uint256) {
        vm.prank(poster);
        return adapter.createBounty(_params(true, false, address(0), CAT));
    }

    function _createHumanOnly() internal returns (uint256) {
        vm.prank(poster);
        return adapter.createBounty(_params(false, true, address(0), CAT));
    }

    // ─── createBounty ─────────────────────────────────────────────────────────

    function testCreate_basic() public {
        uint256 jobId = _create();
        BountyAdapter.BountyMeta memory m = adapter.getBountyMeta(jobId);
        assertEq(m.poster, poster);
        assertEq(m.reward, reward); // gross — fee deferred to payout
        assertFalse(m.agentOnly);
        assertFalse(m.humanOnly);
    }

    function testCreate_noFeeOnCreate() public {
        // Sprint 1: fee is only paid on successful payout, never on create.
        uint256 before = usdc.balanceOf(feeAddr);
        _create();
        assertEq(usdc.balanceOf(feeAddr), before, "fee charged on create");
    }

    function testCreate_parksFundsInAdapter() public {
        _create();
        // Funds stay in adapter (gross) until takeBounty.
        assertEq(usdc.balanceOf(address(adapter)), reward);
        assertEq(usdc.balanceOf(address(commerce)), 0);
    }

    function testCreate_revertRewardTooLow() public {
        vm.prank(poster);
        BountyAdapter.CreateParams memory p = _params(false, false, address(0), CAT);
        p.reward = 0.5e6;
        vm.expectRevert("reward too low");
        adapter.createBounty(p);
    }

    function testCreate_revertDeadlinePast() public {
        vm.prank(poster);
        BountyAdapter.CreateParams memory p = _params(false, false, address(0), CAT);
        p.deadline = block.timestamp - 1;
        vm.expectRevert("deadline in past");
        adapter.createBounty(p);
    }

    function testCreate_revertInvalidCategory() public {
        vm.prank(poster);
        vm.expectRevert("invalid category");
        adapter.createBounty(_params(false, false, address(0), "bogus"));
    }

    function testCreate_revertAgentAndHuman() public {
        vm.prank(poster);
        vm.expectRevert("agentOnly+humanOnly");
        adapter.createBounty(_params(true, true, address(0), CAT));
    }

    function testCreate_revertInsufficientAllowance() public {
        address u = address(0x9999);
        usdc.mint(u, 1000e6);
        vm.prank(u);
        vm.expectRevert("insufficient USDC allowance");
        adapter.createBounty(_params(false, false, address(0), CAT));
    }

    // ─── takeBounty ────────────────────────────────────────────────────────────

    function testTake_human() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        BountyAdapter.BountyMeta memory m = adapter.getBountyMeta(jobId);
        assertEq(m.assignedProvider, worker);
        // Full gross USDC moved to AC escrow.
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertEq(usdc.balanceOf(address(commerce)), m.reward);
        assertEq(m.reward, reward);
    }

    function testTake_agent() public {
        uint256 jobId = _create();
        vm.prank(agent);
        adapter.takeBounty(jobId, agentId);
        BountyAdapter.BountyMeta memory m = adapter.getBountyMeta(jobId);
        assertEq(m.agentId, agentId);
    }

    function testTake_humanOnly_revertWithAgentId() public {
        uint256 jobId = _createHumanOnly();
        vm.prank(agent);
        vm.expectRevert("human only: no agentId");
        adapter.takeBounty(jobId, agentId);
    }

    function testTake_humanOnly_allowsHuman() public {
        uint256 jobId = _createHumanOnly();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
    }

    function testTake_agentOnly_revertHuman() public {
        uint256 jobId = _createAgentOnly();
        vm.prank(worker);
        vm.expectRevert("agent only: provide agentId");
        adapter.takeBounty(jobId, 0);
    }

    function testTake_agentOnly_revertWrongOwner() public {
        uint256 jobId = _createAgentOnly();
        vm.prank(stranger);
        vm.expectRevert("agent only: caller is not agent owner");
        adapter.takeBounty(jobId, agentId);
    }

    function testTake_revertAlreadyTaken() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(stranger);
        vm.expectRevert("already taken");
        adapter.takeBounty(jobId, 0);
    }

    function testTake_revertExpired() public {
        uint256 jobId = _create();
        vm.warp(deadline + 1);
        vm.prank(worker);
        vm.expectRevert("bounty expired");
        adapter.takeBounty(jobId, 0);
    }

    function testTake_whitelistedProvider() public {
        vm.prank(poster);
        uint256 jobId = adapter.createBounty(_params(false, false, worker, CAT));
        vm.prank(stranger);
        vm.expectRevert("not whitelisted");
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
    }

    // ─── full flow ────────────────────────────────────────────────────────────

    function testFullFlow_humanApprove() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);
        uint256 beforeWorker = usdc.balanceOf(worker);
        uint256 beforeFee = usdc.balanceOf(feeAddr);
        vm.prank(poster);
        adapter.approveBounty(jobId, 95);
        // Fee is now paid on payout, not on create.
        assertEq(usdc.balanceOf(worker), beforeWorker + (reward - reward / 100));
        assertEq(usdc.balanceOf(feeAddr), beforeFee + reward / 100);
        assertEq(reputation.getFeedbackCount(), 0); // no agent → no feedback
    }

    function testFullFlow_agentApprove() public {
        uint256 jobId = _create();
        vm.prank(agent);
        adapter.takeBounty(jobId, agentId);
        vm.prank(agent);
        adapter.submitWork(jobId, RESULT);
        vm.prank(poster);
        adapter.approveBounty(jobId, 95);
        assertEq(reputation.getFeedbackCount(), 1);
        (uint256 a, uint256 s,) = reputation.feedbackCalls(0);
        assertEq(a, agentId);
        assertEq(s, 95);
    }

    function testReject_pendingThenFinalize() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);

        uint256 before = usdc.balanceOf(poster);
        vm.prank(poster);
        adapter.rejectBounty(jobId, REASON);
        // Funds must NOT move yet — pending state only.
        assertEq(usdc.balanceOf(poster), before, "poster paid too early");
        assertEq(adapter.getBountyMeta(jobId).resolved, false);

        // Window must elapse first.
        vm.expectRevert("challenge window open");
        adapter.finalizeRejection(jobId);

        vm.warp(block.timestamp + 48 hours + 1);
        vm.prank(stranger); // permissionless
        adapter.finalizeRejection(jobId);
        // Refund is full — no fee on rejection.
        assertEq(usdc.balanceOf(poster), before + reward);
        assertTrue(adapter.getBountyMeta(jobId).resolved);
    }

    // V4.1: rejectBounty must revert once APPROVAL_TIMEOUT has elapsed — a
    // poster can't sit on a correct submission and reject right before
    // autoApprove would otherwise fire, buying extra free delay.
    function testReject_revertAfterApprovalWindowElapsed() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);

        vm.warp(block.timestamp + 14 days + 1);
        vm.prank(poster);
        vm.expectRevert("approval window elapsed, use autoApprove");
        adapter.rejectBounty(jobId, REASON);
    }

    // V4.1: withdrawRejection lets a poster who changed their mind return to
    // the pre-rejection state — approveBounty becomes reachable again.
    function testWithdrawRejection_allowsApproveAfterwards() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);

        vm.prank(poster);
        adapter.rejectBounty(jobId, REASON);
        assertTrue(adapter.getBountyMeta(jobId).rejectedAt > 0);

        vm.prank(poster);
        adapter.withdrawRejection(jobId);
        assertEq(adapter.getBountyMeta(jobId).rejectedAt, 0);
        assertEq(adapter.getBountyMeta(jobId).rejectionReasonHash, "");

        // approveBounty was blocked by "rejection pending" before the
        // withdrawal; now it must succeed.
        uint256 before = usdc.balanceOf(worker);
        vm.prank(poster);
        adapter.approveBounty(jobId, 90);
        assertEq(usdc.balanceOf(worker), before + (reward - reward / 100));
        assertTrue(adapter.getBountyMeta(jobId).resolved);
    }

    function testWithdrawRejection_revertNotPoster() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);
        vm.prank(poster);
        adapter.rejectBounty(jobId, REASON);

        vm.prank(stranger);
        vm.expectRevert("only poster");
        adapter.withdrawRejection(jobId);
    }

    function testWithdrawRejection_revertNoPendingRejection() public {
        uint256 jobId = _create();
        vm.prank(poster);
        vm.expectRevert("no pending rejection");
        adapter.withdrawRejection(jobId);
    }

    function testWithdrawRejection_revertAfterChallenge() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);
        vm.prank(poster);
        adapter.rejectBounty(jobId, REASON);
        vm.prank(worker);
        adapter.challengeRejection(jobId, REASON);

        vm.prank(poster);
        vm.expectRevert("already challenged");
        adapter.withdrawRejection(jobId);
    }

    function testReject_revertEmptyReason() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);
        vm.prank(poster);
        vm.expectRevert("empty reason");
        adapter.rejectBounty(jobId, "");
    }

    function testReject_doubleRejectReverts() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);
        vm.prank(poster);
        adapter.rejectBounty(jobId, REASON);
        vm.prank(poster);
        vm.expectRevert("already rejected");
        adapter.rejectBounty(jobId, REASON);
    }

    function testReject_approveBlockedDuringPending() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);
        vm.prank(poster);
        adapter.rejectBounty(jobId, REASON);
        vm.prank(poster);
        vm.expectRevert("rejection pending");
        adapter.approveBounty(jobId, 95);
    }

    function testChallengeRejection_workerOpensDispute() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);
        vm.prank(poster);
        adapter.rejectBounty(jobId, REASON);

        vm.prank(worker);
        adapter.challengeRejection(jobId, RESP);

        BountyAdapter.BountyMeta memory m = adapter.getBountyMeta(jobId);
        assertTrue(m.inDispute);
        assertEq(m.disputeInitiator, worker);
        assertEq(m.disputeReasonHash, RESP);

        // finalizeRejection now blocked.
        vm.warp(block.timestamp + 48 hours + 1);
        vm.expectRevert("in dispute");
        adapter.finalizeRejection(jobId);
    }

    function testChallengeRejection_revertNotWorker() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);
        vm.prank(poster);
        adapter.rejectBounty(jobId, REASON);
        vm.prank(stranger);
        vm.expectRevert("only worker");
        adapter.challengeRejection(jobId, RESP);
    }

    function testChallengeRejection_revertNoPending() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);
        vm.prank(worker);
        vm.expectRevert("no pending rejection");
        adapter.challengeRejection(jobId, RESP);
    }

    function testChallengeRejection_revertWindowClosed() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);
        vm.prank(poster);
        adapter.rejectBounty(jobId, REASON);

        vm.warp(block.timestamp + 48 hours + 1);
        vm.prank(worker);
        vm.expectRevert("challenge window closed");
        adapter.challengeRejection(jobId, RESP);
    }

    function testDispute_blockedWhenRejectionPending() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);
        vm.prank(poster);
        adapter.rejectBounty(jobId, REASON);
        vm.prank(poster);
        vm.expectRevert("use challengeRejection");
        adapter.disputeBounty(jobId, REASON);
    }

    function testCancel_beforeTake() public {
        uint256 jobId = _create();
        uint256 before = usdc.balanceOf(poster);
        vm.prank(poster);
        adapter.cancelBounty(jobId);
        // Full refund — no protocol fee on cancel.
        assertEq(usdc.balanceOf(poster), before + reward);
        assertEq(usdc.balanceOf(feeAddr), 0);
    }

    function testCancel_revertAlreadyTaken() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(poster);
        vm.expectRevert("already taken, cannot cancel");
        adapter.cancelBounty(jobId);
    }

    function testExpire_beforeTake_refunds() public {
        uint256 jobId = _create();
        vm.warp(deadline + 1);
        uint256 before = usdc.balanceOf(poster);
        vm.prank(stranger);
        adapter.expireBounty(jobId);
        assertEq(usdc.balanceOf(poster), before + reward); // full refund
    }

    function testExpire_afterTake_refundsViaAC() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.warp(deadline + 1);
        uint256 before = usdc.balanceOf(poster);
        vm.prank(stranger);
        adapter.expireBounty(jobId);
        assertEq(usdc.balanceOf(poster), before + reward); // full refund
    }

    function testExpire_revertIfSubmitted() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);
        vm.warp(deadline + 1);
        vm.prank(stranger);
        vm.expectRevert("has submission");
        adapter.expireBounty(jobId);
    }

    // ─── dispute ──────────────────────────────────────────────────────────────

    function testDispute_postRaises_workerResponds_arbiterRulesProvider() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);

        vm.prank(poster);
        adapter.disputeBounty(jobId, REASON);
        vm.prank(worker);
        adapter.respondToDispute(jobId, RESP);

        BountyAdapter.BountyMeta memory m = adapter.getBountyMeta(jobId);
        assertEq(m.disputeReasonHash, REASON);
        assertEq(m.disputeResponseHash, RESP);

        uint256 before = usdc.balanceOf(worker);
        // adapter deployer (this) is arbitrator
        adapter.resolveDispute(jobId, true, RULING, 0);
        assertEq(usdc.balanceOf(worker), before + (reward - reward / 100));

        m = adapter.getBountyMeta(jobId);
        assertEq(m.disputeRulingHash, RULING);
        assertTrue(m.resolved);
        assertFalse(m.inDispute);
    }

    function testDispute_workerRaises_posterResponds_arbiterRulesPoster() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);

        vm.prank(worker);
        adapter.disputeBounty(jobId, REASON);
        vm.prank(poster);
        adapter.respondToDispute(jobId, RESP);

        uint256 before = usdc.balanceOf(poster);
        adapter.resolveDispute(jobId, false, RULING, 0);
        assertEq(usdc.balanceOf(poster), before + reward); // poster wins → full
    }

    function testDispute_respondToDispute_revertNotRespondent() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);
        vm.prank(poster);
        adapter.disputeBounty(jobId, REASON);

        vm.prank(stranger);
        vm.expectRevert("not the respondent");
        adapter.respondToDispute(jobId, RESP);
        // Initiator also cannot self-respond
        vm.prank(poster);
        vm.expectRevert("not the respondent");
        adapter.respondToDispute(jobId, RESP);
    }

    function testDispute_respondToDispute_revertWindowClosed() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);
        vm.prank(poster);
        adapter.disputeBounty(jobId, REASON);

        vm.warp(block.timestamp + 48 hours + 1);
        vm.prank(worker);
        vm.expectRevert("response window closed");
        adapter.respondToDispute(jobId, RESP);
    }

    function testDispute_respondToDispute_revertAlreadyResponded() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);
        vm.prank(poster);
        adapter.disputeBounty(jobId, REASON);
        vm.prank(worker);
        adapter.respondToDispute(jobId, RESP);
        vm.prank(worker);
        vm.expectRevert("already responded");
        adapter.respondToDispute(jobId, RESP);
    }

    function testDispute_resolve_revertEmptyRuling() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);
        vm.prank(poster);
        adapter.disputeBounty(jobId, REASON);
        vm.expectRevert("empty ruling");
        adapter.resolveDispute(jobId, true, "", 0);
    }

    function testDispute_resolve_revertNotArbitrator() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);
        vm.prank(poster);
        adapter.disputeBounty(jobId, REASON);
        vm.prank(stranger);
        vm.expectRevert("only arbitrator");
        adapter.resolveDispute(jobId, true, RULING, 0);
    }

    function testDispute_defaultRuling_initiatorPosterWins() public {
        // Poster raises, worker stays silent for 48h. Anyone may claim default ruling
        // → refunds poster.
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);
        vm.prank(poster);
        adapter.disputeBounty(jobId, REASON);

        vm.warp(block.timestamp + 48 hours + 1);
        uint256 before = usdc.balanceOf(poster);
        vm.prank(stranger);
        adapter.claimDefaultRuling(jobId);
        assertEq(usdc.balanceOf(poster), before + reward); // refund — no fee
    }

    function testDispute_defaultRuling_initiatorProviderWins() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);
        vm.prank(worker);
        adapter.disputeBounty(jobId, REASON);

        vm.warp(block.timestamp + 48 hours + 1);
        uint256 before = usdc.balanceOf(worker);
        vm.prank(stranger);
        adapter.claimDefaultRuling(jobId);
        assertEq(usdc.balanceOf(worker), before + (reward - reward / 100));
    }

    function testDispute_defaultRuling_revertIfResponded() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);
        vm.prank(poster);
        adapter.disputeBounty(jobId, REASON);
        vm.prank(worker);
        adapter.respondToDispute(jobId, RESP);
        vm.warp(block.timestamp + 48 hours + 1);
        vm.prank(stranger);
        vm.expectRevert("respondent replied");
        adapter.claimDefaultRuling(jobId);
    }

    function testDispute_defaultRuling_revertWindowOpen() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);
        vm.prank(poster);
        adapter.disputeBounty(jobId, REASON);
        vm.prank(stranger);
        vm.expectRevert("window still open");
        adapter.claimDefaultRuling(jobId);
    }

    function testDispute_dispute_revertUnauthorized() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);
        vm.prank(stranger);
        vm.expectRevert("unauthorized");
        adapter.disputeBounty(jobId, REASON);
    }

    function testDispute_dispute_revertNoSubmission() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(poster);
        vm.expectRevert("no submission");
        adapter.disputeBounty(jobId, REASON);
    }

    function testDispute_revertAfterApprovalWindow() public {
        // V4.2: a poster blocked from rejecting past APPROVAL_TIMEOUT (V4.1)
        // must not be able to open a dispute instead — same free delay, worse
        // worst case (arbitrator silence → 50/50 split instead of the
        // worker's full autoApprove payout).
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);

        vm.warp(block.timestamp + adapter.APPROVAL_TIMEOUT() + 1);
        vm.prank(poster);
        vm.expectRevert("approval window elapsed, use autoApprove");
        adapter.disputeBounty(jobId, REASON);
        // The worker-side call hits the same bound — harmless, since past the
        // window the worker's strictly better move is autoApprove:
        vm.prank(worker);
        vm.expectRevert("approval window elapsed, use autoApprove");
        adapter.disputeBounty(jobId, REASON);

        // autoApprove remains the live path — the bound never strands funds.
        uint256 before = usdc.balanceOf(worker);
        vm.prank(stranger);
        adapter.autoApprove(jobId);
        assertEq(usdc.balanceOf(worker), before + (reward - reward / 100));
    }

    function testDispute_allowedAtApprovalWindowBoundary() public {
        // Exactly at submittedAt + APPROVAL_TIMEOUT is still allowed (<=),
        // mirroring rejectBounty's V4.1 boundary semantics.
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);
        uint256 submittedAt = adapter.getBountyMeta(jobId).submittedAt;

        vm.warp(submittedAt + adapter.APPROVAL_TIMEOUT());
        vm.prank(poster);
        adapter.disputeBounty(jobId, REASON);
        assertTrue(adapter.getBountyMeta(jobId).inDispute);
    }

    // ─── arbitrator 2-step ────────────────────────────────────────────────────

    function testArbitratorTransfer_twoStep() public {
        address next = address(0xBEEF);
        adapter.transferArbitrator(next);
        assertEq(adapter.arbitrator(), address(this));
        vm.prank(next);
        adapter.acceptArbitrator();
        assertEq(adapter.arbitrator(), next);
    }

    function testArbitratorTransfer_revertNotPending() public {
        adapter.transferArbitrator(address(0xBEEF));
        vm.prank(stranger);
        vm.expectRevert("not pending");
        adapter.acceptArbitrator();
    }

    // ─── views ────────────────────────────────────────────────────────────────

    function testOpen_excludesTakenAndExpiredAndResolved() public {
        uint256 a = _create();
        uint256 b = _create();
        uint256 c = _create();
        // a: taken
        vm.prank(worker);
        adapter.takeBounty(a, 0);
        // c: cancelled
        vm.prank(poster);
        adapter.cancelBounty(c);
        uint256[] memory open = adapter.getOpenBounties("", 0, 10);
        assertEq(open.length, 1);
        assertEq(open[0], b);
    }

    // ─── Sprint 1: autoApprove ────────────────────────────────────────────────

    function testAutoApprove_paysWorkerAfterTimeout() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);

        // before timeout — revert
        vm.expectRevert("approval window open");
        adapter.autoApprove(jobId);

        // After 14 days, anyone can trigger payout to worker.
        vm.warp(block.timestamp + 14 days + 1);
        uint256 beforeWorker = usdc.balanceOf(worker);
        uint256 beforeFee = usdc.balanceOf(feeAddr);
        vm.prank(stranger);
        adapter.autoApprove(jobId);

        assertEq(usdc.balanceOf(worker), beforeWorker + (reward - reward / 100));
        assertEq(usdc.balanceOf(feeAddr), beforeFee + reward / 100);
        assertTrue(adapter.getBountyMeta(jobId).resolved);
    }

    function testAutoApprove_revertNoSubmission() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert("no submission");
        adapter.autoApprove(jobId);
    }

    function testAutoApprove_revertWhenRejected() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);
        vm.prank(poster);
        adapter.rejectBounty(jobId, REASON);
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert("rejection pending");
        adapter.autoApprove(jobId);
    }

    function testAutoApprove_recordsReputation() public {
        uint256 jobId = _create();
        vm.prank(agent);
        adapter.takeBounty(jobId, agentId);
        vm.prank(agent);
        adapter.submitWork(jobId, RESULT);
        vm.warp(block.timestamp + 14 days + 1);
        adapter.autoApprove(jobId);
        assertEq(reputation.getFeedbackCount(), 1);
        (uint256 a, uint256 s,) = reputation.feedbackCalls(0);
        assertEq(a, agentId);
        assertEq(s, 80);
    }

    // ─── Sprint 1: index views ────────────────────────────────────────────────

    function testIndex_postedByPoster() public {
        uint256 a = _create();
        uint256 b = _create();
        uint256[] memory got = adapter.getMyPostedBounties(poster);
        assertEq(got.length, 2);
        assertEq(got[0], a);
        assertEq(got[1], b);
        assertEq(adapter.getPostedCount(poster), 2);
    }

    function testIndex_assignedToProvider() public {
        uint256 a = _create();
        uint256 b = _create();
        vm.prank(worker);
        adapter.takeBounty(a, 0);
        vm.prank(worker);
        adapter.takeBounty(b, 0);
        uint256[] memory got = adapter.getMyAssignedBounties(worker);
        assertEq(got.length, 2);
        assertEq(adapter.getAssignedCount(worker), 2);
    }

    function testIndex_byAgent() public {
        uint256 a = _create();
        vm.prank(agent);
        adapter.takeBounty(a, agentId);
        uint256[] memory got = adapter.getAgentBounties(agentId);
        assertEq(got.length, 1);
        assertEq(got[0], a);
        assertEq(adapter.getAgentBountyCount(agentId), 1);
    }

    // ─── Sprint 1: length caps ────────────────────────────────────────────────

    function testLengthCap_descCidRejected() public {
        BountyAdapter.CreateParams memory p = _params(false, false, address(0), CAT);
        string memory tooLong = new string(97); // > MAX_CID_LEN
        p.ipfsDescHash = tooLong;
        vm.prank(poster);
        vm.expectRevert();
        adapter.createBounty(p);
    }

    function testLengthCap_resultCidRejected() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        string memory tooLong = new string(97);
        vm.prank(worker);
        vm.expectRevert();
        adapter.submitWork(jobId, tooLong);
    }

    function testLengthCap_tagTooLongRejected() public {
        BountyAdapter.CreateParams memory p = _params(false, false, address(0), CAT);
        p.tags = new string[](1);
        p.tags[0] = "this-tag-is-way-longer-than-32-chars-and-must-be-rejected";
        vm.prank(poster);
        vm.expectRevert("tag bad len");
        adapter.createBounty(p);
    }

    // ─── Sprint 1: fee fairness ────────────────────────────────────────────────

    function testFee_neverChargedOnRefundPath() public {
        // Walk every refund path and assert feeRecipient stays empty.
        uint256 a = _create();
        vm.prank(poster);
        adapter.cancelBounty(a);

        uint256 b = _create();
        vm.warp(deadline + 1);
        vm.prank(stranger);
        adapter.expireBounty(b);

        // Reset time so the third one isn't already past deadline.
        vm.warp(block.timestamp + 1);
        deadline = block.timestamp + 7 days;
        uint256 c;
        {
            BountyAdapter.CreateParams memory p = _params(false, false, address(0), CAT);
            p.deadline = deadline;
            vm.prank(poster);
            c = adapter.createBounty(p);
        }
        vm.prank(worker);
        adapter.takeBounty(c, 0);
        vm.prank(worker);
        adapter.submitWork(c, RESULT);
        vm.prank(poster);
        adapter.rejectBounty(c, REASON);
        vm.warp(block.timestamp + 48 hours + 1);
        vm.prank(stranger);
        adapter.finalizeRejection(c);

        assertEq(usdc.balanceOf(feeAddr), 0, "fee leaked on refund path");
    }

    // ─── V3.3: claimArbitratorTimeout ─────────────────────────────────────────

    function testArbitratorTimeout_splitsEvenlyWhenArbitratorGhosts() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);

        vm.prank(poster);
        adapter.disputeBounty(jobId, REASON);
        vm.prank(worker);
        adapter.respondToDispute(jobId, RESP);

        // Arbitrator never calls resolveDispute. 30 days pass.
        vm.warp(block.timestamp + 30 days + 1);

        uint256 posterBefore = usdc.balanceOf(poster);
        uint256 workerBefore = usdc.balanceOf(worker);
        uint256 feeBefore = usdc.balanceOf(feeAddr);

        vm.prank(stranger);
        adapter.claimArbitratorTimeout(jobId);

        uint256 fee = reward / 100; // 1%
        uint256 net = reward - fee;
        uint256 half = net / 2;

        assertEq(usdc.balanceOf(feeAddr), feeBefore + fee);
        assertEq(usdc.balanceOf(poster), posterBefore + half);
        assertEq(usdc.balanceOf(worker), workerBefore + (net - half));

        BountyAdapter.BountyMeta memory m = adapter.getBountyMeta(jobId);
        assertTrue(m.resolved);
        assertFalse(m.inDispute);
        assertEq(m.disputeRulingHash, "timeout:50-50-split");
    }

    function testArbitratorTimeout_noReputationPenaltyOnAgentWorker() public {
        uint256 jobId = _create();
        vm.prank(agent);
        adapter.takeBounty(jobId, agentId);
        vm.prank(agent);
        adapter.submitWork(jobId, RESULT);

        vm.prank(poster);
        adapter.disputeBounty(jobId, REASON);
        vm.prank(agent);
        adapter.respondToDispute(jobId, RESP);

        vm.warp(block.timestamp + 30 days + 1);
        vm.prank(stranger);
        adapter.claimArbitratorTimeout(jobId);

        // Neutral outcome — no giveFeedback call at all (positive or negative).
        assertEq(reputation.getFeedbackCount(), 0);
    }

    function testArbitratorTimeout_revertBeforeWindow() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);
        vm.prank(poster);
        adapter.disputeBounty(jobId, REASON);
        vm.prank(worker);
        adapter.respondToDispute(jobId, RESP);

        vm.warp(block.timestamp + 30 days - 1);
        vm.expectRevert("arbitrator window open");
        adapter.claimArbitratorTimeout(jobId);
    }

    function testArbitratorTimeout_revertIfNoResponse() public {
        // Respondent never replied — claimDefaultRuling is the correct path,
        // not claimArbitratorTimeout.
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);
        vm.prank(poster);
        adapter.disputeBounty(jobId, REASON);

        vm.warp(block.timestamp + 30 days + 1);
        vm.expectRevert("use claimDefaultRuling");
        adapter.claimArbitratorTimeout(jobId);
    }

    function testArbitratorTimeout_revertNotInDispute() public {
        uint256 jobId = _create();
        vm.expectRevert("not in dispute");
        adapter.claimArbitratorTimeout(jobId);
    }

    function testArbitratorTimeout_revertAlreadyResolved() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);
        vm.prank(poster);
        adapter.disputeBounty(jobId, REASON);
        vm.prank(worker);
        adapter.respondToDispute(jobId, RESP);
        adapter.resolveDispute(jobId, true, RULING, 0); // arbitrator (address(this)) rules in time

        // resolveDispute already cleared inDispute, so the "not in dispute"
        // guard (checked before "resolved") is what fires here.
        vm.warp(block.timestamp + 30 days + 1);
        vm.expectRevert("not in dispute");
        adapter.claimArbitratorTimeout(jobId);
    }

    // ─── V3.3: feeRecipient two-step transfer ─────────────────────────────────

    function testFeeRecipientTransfer_twoStep() public {
        address next = address(0xFEE5);
        vm.prank(feeAddr);
        adapter.transferFeeRecipient(next);
        assertEq(adapter.feeRecipient(), feeAddr);
        vm.prank(next);
        adapter.acceptFeeRecipient();
        assertEq(adapter.feeRecipient(), next);
    }

    function testFeeRecipientTransfer_revertNotFeeRecipient() public {
        vm.prank(stranger);
        vm.expectRevert("only fee recipient");
        adapter.transferFeeRecipient(address(0xFEE5));
    }

    function testFeeRecipientTransfer_revertNotPending() public {
        vm.prank(feeAddr);
        adapter.transferFeeRecipient(address(0xFEE5));
        vm.prank(stranger);
        vm.expectRevert("not pending");
        adapter.acceptFeeRecipient();
    }

    // ─── V4: worker bond ───────────────────────────────────────────────────────

    function testWorkerBond_postedAtTake() public {
        uint256 jobId = _createWithBond();
        uint256 expectedBond = (reward * 1500) / 10_000; // 15% of $10 = $1.50, above the floor
        assertEq(expectedBond, 1.5e6);

        uint256 before = usdc.balanceOf(worker);
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);

        assertEq(usdc.balanceOf(worker), before - expectedBond);
        assertEq(adapter.getBountyMeta(jobId).workerBond, expectedBond);
    }

    function testWorkerBond_minimumFloorApplies() public {
        // At MIN_REWARD ($1), 15% = $0.15 — below the $0.50 floor, so the
        // floor governs.
        BountyAdapter.CreateParams memory p = _params(false, false, address(0), CAT);
        p.reward = 1e6;
        p.requireWorkerBond = true;
        vm.prank(poster);
        uint256 jobId = adapter.createBounty(p);

        uint256 before = usdc.balanceOf(worker);
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);

        assertEq(usdc.balanceOf(worker), before - 0.5e6);
        assertEq(adapter.getBountyMeta(jobId).workerBond, 0.5e6);
    }

    function testWorkerBond_notRequiredByDefault() public {
        uint256 jobId = _create(); // requireWorkerBond defaults to false
        uint256 before = usdc.balanceOf(worker);
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);

        assertEq(usdc.balanceOf(worker), before, "no bond should be pulled");
        assertEq(adapter.getBountyMeta(jobId).workerBond, 0);
    }

    function testWorkerBond_refundedAtSubmit() public {
        uint256 jobId = _createWithBond();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);

        uint256 afterTake = usdc.balanceOf(worker);
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);

        assertEq(usdc.balanceOf(worker), afterTake + 1.5e6, "bond must be refunded in full at submit");
        assertEq(adapter.getBountyMeta(jobId).workerBond, 0);
    }

    function testWorkerBond_forfeitedOnExpireWithoutSubmission() public {
        uint256 jobId = _createWithBond();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);

        uint256 posterBefore = usdc.balanceOf(poster);
        vm.warp(deadline + 1);
        vm.prank(stranger);
        adapter.expireBounty(jobId);

        // Poster gets back the reward (via _rejectAndRefund) AND the forfeited bond.
        assertEq(usdc.balanceOf(poster), posterBefore + reward + 1.5e6);
        assertEq(adapter.getBountyMeta(jobId).workerBond, 0);
    }

    function testWorkerBond_revertDeadlineTooSoon() public {
        // V4.1 honeypot guard: a bond bounty with a near-immediate deadline
        // would let the poster farm forfeited bonds from auto-taking agents.
        BountyAdapter.CreateParams memory p = _params(false, false, address(0), CAT);
        p.requireWorkerBond = true;
        p.deadline = block.timestamp + adapter.MIN_BOND_BOUNTY_DURATION() - 1;
        vm.prank(poster);
        vm.expectRevert(bytes("bond bounty: deadline too soon"));
        adapter.createBounty(p);

        // Exactly at the floor is allowed (boundary).
        p.deadline = block.timestamp + adapter.MIN_BOND_BOUNTY_DURATION();
        vm.prank(poster);
        uint256 jobId = adapter.createBounty(p);
        assertTrue(adapter.getBountyMeta(jobId).requireWorkerBond);
    }

    function testWorkerBond_revertTakeTooCloseToDeadline() public {
        // V4.2: the V4.1 creation-time floor alone leaves a residual
        // honeypot — an aged bond listing taken minutes before its deadline
        // still traps the taker's bond. Taking now requires at least
        // MIN_BOND_TAKE_WINDOW left on the clock.
        uint256 jobId = _createWithBond();
        vm.warp(deadline - adapter.MIN_BOND_TAKE_WINDOW() + 1);
        vm.prank(worker);
        vm.expectRevert(bytes("bond bounty: too close to deadline"));
        adapter.takeBounty(jobId, 0);
    }

    function testWorkerBond_takeAtWindowBoundaryAllowed() public {
        // Exactly MIN_BOND_TAKE_WINDOW remaining is allowed (boundary).
        uint256 jobId = _createWithBond();
        vm.warp(deadline - adapter.MIN_BOND_TAKE_WINDOW());
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        assertEq(adapter.getBountyMeta(jobId).workerBond, 1.5e6);
    }

    function testTake_noBond_nearDeadlineStillAllowed() public {
        // The take window is scoped to bond bounties only — taking a
        // bond-free bounty at the last second risks no worker funds.
        uint256 jobId = _create();
        vm.warp(deadline - 1);
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        assertEq(adapter.getBountyMeta(jobId).assignedProvider, worker);
    }

    function testCreate_shortDeadlineStillAllowedWithoutBond() public {
        // The duration floor is scoped to bond bounties only — a bond-free
        // micro-bounty with a short deadline risks no worker funds.
        BountyAdapter.CreateParams memory p = _params(false, false, address(0), CAT);
        p.deadline = block.timestamp + 10 minutes;
        vm.prank(poster);
        uint256 jobId = adapter.createBounty(p);
        assertEq(adapter.getBountyMeta(jobId).deadline, p.deadline);
    }

    // ─── V4: uniquePosterCount ─────────────────────────────────────────────────

    function testUniquePosterCount_incrementsPerDistinctPoster() public {
        assertEq(adapter.uniquePosterCount(agentId), 0);

        // First bounty: poster completes with the agent.
        uint256 a = _create();
        vm.prank(agent);
        adapter.takeBounty(a, agentId);
        vm.prank(agent);
        adapter.submitWork(a, RESULT);
        vm.prank(poster);
        adapter.approveBounty(a, 95);
        assertEq(adapter.uniquePosterCount(agentId), 1);

        // Second bounty, SAME poster — must not double-count.
        uint256 b = _create();
        vm.prank(agent);
        adapter.takeBounty(b, agentId);
        vm.prank(agent);
        adapter.submitWork(b, RESULT);
        vm.prank(poster);
        adapter.approveBounty(b, 95);
        assertEq(adapter.uniquePosterCount(agentId), 1, "same poster must not double-count");

        // Third bounty, a DIFFERENT poster.
        usdc.mint(stranger, 100e6);
        vm.prank(stranger);
        usdc.approve(address(adapter), type(uint256).max);
        BountyAdapter.CreateParams memory p = _params(false, false, address(0), CAT);
        vm.prank(stranger);
        uint256 c = adapter.createBounty(p);
        vm.prank(agent);
        adapter.takeBounty(c, agentId);
        vm.prank(agent);
        adapter.submitWork(c, RESULT);
        vm.prank(stranger);
        adapter.approveBounty(c, 95);
        assertEq(adapter.uniquePosterCount(agentId), 2, "a genuinely new poster must increment");
    }

    function testUniquePosterCount_incrementsOnAutoApprove() public {
        uint256 jobId = _create();
        vm.prank(agent);
        adapter.takeBounty(jobId, agentId);
        vm.prank(agent);
        adapter.submitWork(jobId, RESULT);

        vm.warp(block.timestamp + 14 days + 1);
        vm.prank(stranger);
        adapter.autoApprove(jobId);

        assertEq(adapter.uniquePosterCount(agentId), 1);
    }

    function testUniquePosterCount_noOpForHumanWorker() public {
        uint256 jobId = _create();
        vm.prank(worker);
        adapter.takeBounty(jobId, 0); // agentId = 0 → human
        vm.prank(worker);
        adapter.submitWork(jobId, RESULT);
        vm.prank(poster);
        adapter.approveBounty(jobId, 95);

        assertEq(adapter.uniquePosterCount(0), 0, "agentId=0 must never accrue a count");
    }
}
