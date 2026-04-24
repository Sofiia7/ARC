// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "forge-std/Test.sol";
import "../src/BountyAdapter.sol";
import "../src/interfaces/IAgenticCommerce.sol";
import "../src/interfaces/IIdentityRegistry.sol";
import "../src/interfaces/IReputationRegistry.sol";

// ─── Mock contracts ────────────────────────────────────────────────────────────

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

contract MockAgenticCommerce {
    uint256 private _nextJobId = 1;
    mapping(uint256 => IAgenticCommerce.Job) public jobs;
    mapping(uint256 => uint256) public budgets;

    event JobCreated(uint256 jobId, address poster, address provider, address evaluator);
    event JobFunded(uint256 jobId);
    event JobSubmitted(uint256 jobId, bytes32 deliverable);
    event JobCompleted(uint256 jobId);
    event JobRefunded(uint256 jobId);
    event JobExpired(uint256 jobId);

    function createJob(
        address provider,
        address evaluator,
        uint256 deadline,
        string calldata,
        address
    ) external returns (uint256 jobId) {
        jobId = _nextJobId++;
        jobs[jobId] = IAgenticCommerce.Job({
            poster: msg.sender,
            provider: provider,
            evaluator: evaluator,
            deadline: deadline,
            status: IAgenticCommerce.JobStatus.OPEN,
            deliverable: bytes32(0)
        });
        emit JobCreated(jobId, msg.sender, provider, evaluator);
    }

    function setBudget(uint256 jobId, uint256 amount, bytes calldata) external {
        budgets[jobId] = amount;
    }

    function fund(uint256 jobId, bytes calldata) external {
        jobs[jobId].status = IAgenticCommerce.JobStatus.FUNDED;
        emit JobFunded(jobId);
    }

    function submit(uint256 jobId, bytes32 deliverable, bytes calldata) external {
        jobs[jobId].status = IAgenticCommerce.JobStatus.SUBMITTED;
        jobs[jobId].deliverable = deliverable;
        emit JobSubmitted(jobId, deliverable);
    }

    function complete(uint256 jobId, bytes32, bytes calldata) external {
        jobs[jobId].status = IAgenticCommerce.JobStatus.COMPLETED;
        emit JobCompleted(jobId);
    }

    function refund(uint256 jobId, bytes calldata) external {
        jobs[jobId].status = IAgenticCommerce.JobStatus.REJECTED;
        emit JobRefunded(jobId);
    }

    function expire(uint256 jobId, bytes calldata) external {
        jobs[jobId].status = IAgenticCommerce.JobStatus.EXPIRED;
        emit JobExpired(jobId);
    }

    function getJob(uint256 jobId) external view returns (IAgenticCommerce.Job memory) {
        return jobs[jobId];
    }
}

contract MockIdentityRegistry {
    mapping(uint256 => address) public owners;
    uint256 private _nextId = 1;

    function register(string calldata) external returns (uint256 agentId) {
        agentId = _nextId++;
        owners[agentId] = msg.sender;
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        return owners[agentId];
    }

    function getMetadataURI(uint256) external pure returns (string memory) { return ""; }

    function isRegistered(uint256 agentId) external view returns (bool) {
        return owners[agentId] != address(0);
    }

    // Helper for tests: assign ownership directly
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
        uint256 agentId,
        uint256 score,
        uint256,
        string calldata,
        string calldata,
        string calldata,
        string calldata,
        bytes32 feedbackHash
    ) external {
        feedbackCalls.push(FeedbackCall(agentId, score, feedbackHash));
    }

    function getReputation(uint256) external pure returns (IReputationRegistry.ReputationScore memory) {
        return IReputationRegistry.ReputationScore({ averageScore: 90, totalFeedbacks: 5, totalJobs: 5 });
    }

    function getFeedbackCount() external view returns (uint256) {
        return feedbackCalls.length;
    }
}

// ─── Test suite ────────────────────────────────────────────────────────────────

contract BountyAdapterTest is Test {
    BountyAdapter       adapter;
    MockUSDC            usdc;
    MockAgenticCommerce commerce;
    MockIdentityRegistry identity;
    MockReputationRegistry reputation;

    address poster    = address(0x1001);
    address worker    = address(0x1002);
    address agent     = address(0x1003);
    address feeAddr   = address(0x1004);
    address stranger  = address(0x1005);

    uint256 agentId   = 1;
    uint256 reward    = 10e6;  // 10 USDC
    uint256 deadline;

    string constant IPFS_DESC   = "ipfs://QmDesc123";
    string constant IPFS_RESULT = "ipfs://QmResult456";
    string constant CATEGORY    = "dev";
    string[] tags;

    function setUp() public {
        deadline = block.timestamp + 7 days;
        tags = new string[](2);
        tags[0] = "solidity";
        tags[1] = "arc";

        usdc       = new MockUSDC();
        commerce   = new MockAgenticCommerce();
        identity   = new MockIdentityRegistry();
        reputation = new MockReputationRegistry();

        adapter = new BountyAdapter(
            address(commerce),
            address(identity),
            address(reputation),
            address(usdc),
            feeAddr,
            100 // 1%
        );

        // Register agent
        identity.setOwner(agentId, agent);

        // Fund poster
        usdc.mint(poster, 1000e6);
        vm.prank(poster);
        usdc.approve(address(adapter), type(uint256).max);
    }

    // ─── Helper ────────────────────────────────────────────────────────────────

    function _createBounty(bool agentOnly) internal returns (uint256 jobId) {
        vm.prank(poster);
        jobId = adapter.createBounty(address(0), reward, deadline, IPFS_DESC, CATEGORY, tags, agentOnly);
    }

    // ─── createBounty ─────────────────────────────────────────────────────────

    function testCreateBounty_basic() public {
        uint256 jobId = _createBounty(false);

        assertTrue(jobId > 0, "jobId should be > 0");

        BountyAdapter.BountyMeta memory meta = adapter.getBountyMeta(jobId);
        assertEq(meta.poster, poster);
        assertEq(meta.category, CATEGORY);
        assertEq(meta.ipfsDescHash, IPFS_DESC);
        assertEq(meta.reward, reward - (reward * 100 / 10_000)); // net of 1% fee
        assertFalse(meta.agentOnly);
        assertEq(meta.assignedProvider, address(0));
        assertEq(adapter.totalBounties(), 1);
    }

    function testCreateBounty_feeDeducted() public {
        uint256 balanceBefore = usdc.balanceOf(feeAddr);
        _createBounty(false);
        uint256 fee = reward * 100 / 10_000; // 1%
        assertEq(usdc.balanceOf(feeAddr), balanceBefore + fee);
    }

    function testCreateBounty_agentOnly() public {
        uint256 jobId = _createBounty(true);
        BountyAdapter.BountyMeta memory meta = adapter.getBountyMeta(jobId);
        assertTrue(meta.agentOnly);
    }

    function testCreateBounty_revertRewardTooLow() public {
        vm.prank(poster);
        vm.expectRevert("reward too low");
        adapter.createBounty(address(0), 0.5e6, deadline, IPFS_DESC, CATEGORY, tags, false);
    }

    function testCreateBounty_revertDeadlineInPast() public {
        vm.prank(poster);
        vm.expectRevert("deadline in past");
        adapter.createBounty(address(0), reward, block.timestamp - 1, IPFS_DESC, CATEGORY, tags, false);
    }

    function testCreateBounty_revertInvalidCategory() public {
        vm.prank(poster);
        vm.expectRevert("invalid category");
        adapter.createBounty(address(0), reward, deadline, IPFS_DESC, "invalid", tags, false);
    }

    function testCreateBounty_revertInsufficientAllowance() public {
        address newUser = address(0x9999);
        usdc.mint(newUser, 1000e6);
        // No approve
        vm.prank(newUser);
        vm.expectRevert("insufficient USDC allowance");
        adapter.createBounty(address(0), reward, deadline, IPFS_DESC, CATEGORY, tags, false);
    }

    // ─── takeBounty ────────────────────────────────────────────────────────────

    function testTakeBounty_human() public {
        uint256 jobId = _createBounty(false);
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);

        BountyAdapter.BountyMeta memory meta = adapter.getBountyMeta(jobId);
        assertEq(meta.assignedProvider, worker);
        assertEq(meta.agentId, 0);
    }

    function testTakeBounty_agent() public {
        uint256 jobId = _createBounty(false);
        vm.prank(agent);
        adapter.takeBounty(jobId, agentId);

        BountyAdapter.BountyMeta memory meta = adapter.getBountyMeta(jobId);
        assertEq(meta.assignedProvider, agent);
        assertEq(meta.agentId, agentId);
    }

    function testTakeBounty_revertAlreadyTaken() public {
        uint256 jobId = _createBounty(false);
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);

        vm.prank(stranger);
        vm.expectRevert("already taken");
        adapter.takeBounty(jobId, 0);
    }

    function testTakeBounty_agentOnly_revertHuman() public {
        uint256 jobId = _createBounty(true);
        vm.prank(worker);
        vm.expectRevert("agent only: provide agentId");
        adapter.takeBounty(jobId, 0);
    }

    function testTakeBounty_agentOnly_revertWrongOwner() public {
        uint256 jobId = _createBounty(true);
        vm.prank(stranger); // stranger doesn't own agentId
        vm.expectRevert("agent only: caller is not agent owner");
        adapter.takeBounty(jobId, agentId);
    }

    function testTakeBounty_revertExpired() public {
        uint256 jobId = _createBounty(false);
        vm.warp(deadline + 1);
        vm.prank(worker);
        vm.expectRevert("bounty expired");
        adapter.takeBounty(jobId, 0);
    }

    // ─── Full flow: human ──────────────────────────────────────────────────────

    function testFullFlow_human() public {
        // create
        uint256 jobId = _createBounty(false);

        // take
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);

        // fund
        vm.prank(poster);
        adapter.fundBounty(jobId);

        // submit
        vm.prank(worker);
        adapter.submitWork(jobId, IPFS_RESULT);

        BountyAdapter.BountyMeta memory meta = adapter.getBountyMeta(jobId);
        assertEq(meta.submittedResultHash, IPFS_RESULT);

        // approve
        vm.prank(poster);
        adapter.approveBounty(jobId);

        // no reputation for human (agentId == 0)
        assertEq(reputation.getFeedbackCount(), 0);
    }

    // ─── Full flow: AI agent ───────────────────────────────────────────────────

    function testFullFlow_agent() public {
        uint256 jobId = _createBounty(false);

        vm.prank(agent);
        adapter.takeBounty(jobId, agentId);

        vm.prank(poster);
        adapter.fundBounty(jobId);

        vm.prank(agent);
        adapter.submitWork(jobId, IPFS_RESULT);

        vm.prank(poster);
        adapter.approveBounty(jobId);

        // Reputation must be recorded
        assertEq(reputation.getFeedbackCount(), 1);
        (uint256 storedAgentId, uint256 score,) = reputation.feedbackCalls(0);
        assertEq(storedAgentId, agentId);
        assertEq(score, 95);
    }

    // ─── submitWork guards ─────────────────────────────────────────────────────

    function testSubmitWork_revertNotProvider() public {
        uint256 jobId = _createBounty(false);
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);

        vm.prank(stranger);
        vm.expectRevert("not assigned provider");
        adapter.submitWork(jobId, IPFS_RESULT);
    }

    function testSubmitWork_revertExpired() public {
        uint256 jobId = _createBounty(false);
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);

        vm.warp(deadline + 1);
        vm.prank(worker);
        vm.expectRevert("bounty expired");
        adapter.submitWork(jobId, IPFS_RESULT);
    }

    // ─── cancelBounty ─────────────────────────────────────────────────────────

    function testCancelBounty_beforeTaken() public {
        uint256 jobId = _createBounty(false);
        vm.prank(poster);
        adapter.cancelBounty(jobId);
    }

    function testCancelBounty_revertAlreadyTaken() public {
        uint256 jobId = _createBounty(false);
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);

        vm.prank(poster);
        vm.expectRevert("already taken, cannot cancel");
        adapter.cancelBounty(jobId);
    }

    function testCancelBounty_revertNotPoster() public {
        uint256 jobId = _createBounty(false);
        vm.prank(stranger);
        vm.expectRevert("only poster");
        adapter.cancelBounty(jobId);
    }

    // ─── rejectBounty ─────────────────────────────────────────────────────────

    function testRejectBounty_returnsToMockState() public {
        uint256 jobId = _createBounty(false);

        vm.prank(worker);
        adapter.takeBounty(jobId, 0);
        vm.prank(poster);
        adapter.fundBounty(jobId);
        vm.prank(worker);
        adapter.submitWork(jobId, IPFS_RESULT);

        vm.prank(poster);
        adapter.rejectBounty(jobId, "bad quality");
    }

    function testRejectBounty_revertNoSubmission() public {
        uint256 jobId = _createBounty(false);
        vm.prank(poster);
        vm.expectRevert("no submission");
        adapter.rejectBounty(jobId, "reason");
    }

    // ─── expireBounty ─────────────────────────────────────────────────────────

    function testExpireBounty_anyoneCanCall() public {
        uint256 jobId = _createBounty(false);
        vm.warp(deadline + 1);

        vm.prank(stranger); // permissionless
        adapter.expireBounty(jobId);
    }

    function testExpireBounty_revertNotExpired() public {
        uint256 jobId = _createBounty(false);
        vm.prank(stranger);
        vm.expectRevert("not expired yet");
        adapter.expireBounty(jobId);
    }

    // ─── getOpenBounties ──────────────────────────────────────────────────────

    function testGetOpenBounties_noFilter() public {
        _createBounty(false);
        _createBounty(false);

        uint256[] memory open = adapter.getOpenBounties("", 0, 10);
        assertEq(open.length, 2);
    }

    function testGetOpenBounties_categoryFilter() public {
        _createBounty(false); // category = "dev"

        // Create another with category "design"
        string[] memory t = new string[](0);
        vm.prank(poster);
        adapter.createBounty(address(0), reward, deadline, IPFS_DESC, "design", t, false);

        uint256[] memory devBounties = adapter.getOpenBounties("dev", 0, 10);
        assertEq(devBounties.length, 1);

        uint256[] memory allBounties = adapter.getOpenBounties("", 0, 10);
        assertEq(allBounties.length, 2);
    }

    function testGetOpenBounties_excludesTaken() public {
        uint256 jobId = _createBounty(false);
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);

        uint256[] memory open = adapter.getOpenBounties("", 0, 10);
        assertEq(open.length, 0);
    }

    function testGetOpenBounties_excludesExpired() public {
        _createBounty(false);
        vm.warp(deadline + 1);

        uint256[] memory open = adapter.getOpenBounties("", 0, 10);
        assertEq(open.length, 0);
    }

    function testGetOpenBounties_pagination() public {
        _createBounty(false);
        _createBounty(false);
        _createBounty(false);

        uint256[] memory page1 = adapter.getOpenBounties("", 0, 2);
        assertEq(page1.length, 2);

        uint256[] memory page2 = adapter.getOpenBounties("", 2, 2);
        assertEq(page2.length, 1);
    }

    // ─── getAgentReputation ───────────────────────────────────────────────────

    function testGetAgentReputation() public view {
        IReputationRegistry.ReputationScore memory score = adapter.getAgentReputation(agentId);
        assertEq(score.averageScore, 90);
        assertEq(score.totalJobs, 5);
    }

    // ─── getMyBounties ────────────────────────────────────────────────────────

    function testGetMyPostedBounties() public {
        _createBounty(false);
        _createBounty(false);
        uint256[] memory mine = adapter.getMyPostedBounties(poster);
        assertEq(mine.length, 2);
    }

    function testGetMyAssignedBounties() public {
        uint256 jobId = _createBounty(false);
        vm.prank(worker);
        adapter.takeBounty(jobId, 0);

        uint256[] memory mine = adapter.getMyAssignedBounties(worker);
        assertEq(mine.length, 1);
        assertEq(mine[0], jobId);
    }

    // ─── fundBounty guards ────────────────────────────────────────────────────

    function testFundBounty_revertNotPoster() public {
        uint256 jobId = _createBounty(false);
        vm.prank(stranger);
        vm.expectRevert("only poster");
        adapter.fundBounty(jobId);
    }

    function testFundBounty_revertAlreadyFunded() public {
        uint256 jobId = _createBounty(false);
        vm.prank(poster);
        adapter.fundBounty(jobId);

        vm.prank(poster);
        vm.expectRevert("already funded");
        adapter.fundBounty(jobId);
    }
}
