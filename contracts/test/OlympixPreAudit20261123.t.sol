// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "forge-std/Test.sol";
import "../src/BountyAdapter.sol";
import "../src/base/AgenticCommerce.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MockUSDC, MockIdentityRegistry} from "./BountyAdapter.t.sol";

/// @dev A reputation registry whose write costs what the live ERC-8004
///      ReputationRegistry on Arc mainnet costs for an agent's first feedback
///      from the adapter: 163,616 gas, measured on a fork of chain 5042 on
///      2026-11-23 with the call made as the live adapter (later feedback on
///      the same agent costs about 62,000). The write needs that much gas or
///      it runs out, like the real one. BURN 115,000 reproduces today's cost;
///      a larger BURN models a registry upgrade that makes writes dearer.
contract GasHungryReputation {
    uint256 public immutable BURN;
    uint256 public calls;
    int128 public lastValue;

    constructor(uint256 burn) {
        BURN = burn;
    }

    function giveFeedback(
        uint256,
        int128 value,
        uint8,
        string calldata,
        string calldata,
        string calldata,
        string calldata,
        bytes32
    ) external {
        uint256 start = gasleft();
        while (start - gasleft() < BURN) {}
        lastValue = value;
        calls++;
    }

    function getSummary(uint256, address[] calldata, string calldata, string calldata)
        external
        pure
        returns (uint64, int128, uint8)
    {
        return (0, 0, 0);
    }
}

/// @notice Findings of the 2026-11-23 pre-audit review (OLYMPIX_SUBMISSION.md),
///         against the real repository AgenticCommerce behind an ERC1967 proxy.
contract OlympixPreAudit20261123Test is Test {
    MockUSDC token;
    AgenticCommerce escrow;
    BountyAdapter adapter;
    MockIdentityRegistry identity;
    GasHungryReputation reputation;

    address poster = address(0x1001);
    address worker = address(0x1002);
    address stranger = address(0x1005);
    uint256 constant AGENT_ID = 7;
    uint256 constant REWARD = 100e6;
    uint256 deadline;

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
        identity = new MockIdentityRegistry();
        identity.setOwner(AGENT_ID, worker);
        token.mint(poster, 10 * REWARD);
        deadline = block.timestamp + 7 days;
        _deployAdapter(115_000);
    }

    /// @dev (Re)deploys the adapter against a registry with the given write
    ///      cost; the adapter's registry is immutable.
    function _deployAdapter(uint256 burn) internal {
        reputation = new GasHungryReputation(burn);
        adapter = new BountyAdapter(
            address(escrow), address(identity), address(reputation), address(token), address(0xFEE), 100, 500e6
        );
        vm.prank(poster);
        token.approve(address(adapter), type(uint256).max);
    }

    function _createTakeSubmit() internal returns (uint256 job) {
        BountyAdapter.CreateParams memory p = BountyAdapter.CreateParams({
            provider: address(0),
            reward: REWARD,
            deadline: deadline,
            ipfsDescHash: "ipfs://olympix-description",
            category: "dev",
            tags: new string[](0),
            agentOnly: false,
            humanOnly: false,
            requireWorkerBond: false
        });
        vm.prank(poster);
        job = adapter.createBounty(p);
        vm.prank(worker);
        adapter.takeBounty(job, AGENT_ID);
        vm.prank(worker);
        adapter.submitWork(job, "ipfs://olympix-result");
    }

    /// @dev One attempt with an exact gas limit; state is restored afterwards.
    function _trySettle(address caller, bytes memory data, uint256 g) internal returns (bool ok, bool wrote) {
        uint256 snap = vm.snapshotState();
        uint256 before = reputation.calls();
        vm.prank(caller);
        (ok,) = address(adapter).call{gas: g}(data);
        wrote = reputation.calls() > before;
        vm.revertToState(snap);
    }

    /// @dev Counts gas limits at which `data` settled but the reputation write
    ///      did not happen. A gas-starved write can only show up at the bottom
    ///      of the range where the call settles, so the search finds that
    ///      bottom exactly by bisection and then tries every 10 gas above it,
    ///      on top of a coarse sweep of the whole range.
    function _countSilentSkips(address caller, bytes memory data) internal returns (uint256 skips, uint256 settled) {
        bool ok;
        bool wrote;
        for (uint256 g = 100_000; g <= 800_000; g += 1_000) {
            (ok, wrote) = _trySettle(caller, data, g);
            if (ok) {
                settled++;
                if (!wrote) skips++;
            }
        }
        uint256 lo = 30_000;
        uint256 hi = 2_000_000;
        (ok,) = _trySettle(caller, data, hi);
        require(ok, "does not settle even at 2M gas");
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            (ok,) = _trySettle(caller, data, mid);
            if (ok) hi = mid;
            else lo = mid;
        }
        emit log_named_uint("lowest gas limit that settles", hi);
        for (uint256 g = hi; g < hi + 4_000; g += 10) {
            (ok, wrote) = _trySettle(caller, data, g);
            if (ok) {
                settled++;
                if (!wrote) skips++;
            }
        }
    }

    // ─── F-09: reputation writes and the gas kept back by the caller ──

    /// @dev The mock is calibrated to the mainnet measurement, within 5%.
    function test_F09_mockCostMatchesMainnetMeasurement() public {
        vm.prank(address(adapter));
        uint256 g = gasleft();
        reputation.giveFeedback(AGENT_ID, 80, 0, "bounty_auto_approved", "", "", "", bytes32(0));
        uint256 used = g - gasleft();
        assertApproxEqRel(used, 163_616, 0.05e18, "first-write cost vs Arc mainnet fork");
    }

    /// @dev Write costs tried: today's (163,616), about 270,000 (where the
    ///      V4.7 source lets a starved write slip through, see F-09) and about
    ///      450,000 (still inside the floor's margin).
    function _burns() internal pure returns (uint256[3] memory) {
        return [uint256(115_000), 220_000, 400_000];
    }

    function test_F09_approveCannotSettleWithStarvedFeedback() public {
        uint256[3] memory burns = _burns();
        for (uint256 i = 0; i < burns.length; i++) {
            _deployAdapter(burns[i]);
            uint256 job = _createTakeSubmit();
            (uint256 skips, uint256 settled) =
                _countSilentSkips(poster, abi.encodeCall(BountyAdapter.approveBounty, (job, 90)));
            assertGt(settled, 0, "approve settles with enough gas");
            assertEq(skips, 0, "approve settled while giveFeedback ran out of gas");
        }
    }

    function test_F09_autoApproveCannotSettleWithStarvedFeedback() public {
        uint256[3] memory burns = _burns();
        for (uint256 i = 0; i < burns.length; i++) {
            _deployAdapter(burns[i]);
            deadline = vm.getBlockTimestamp() + 7 days; // via_ir can cache block.timestamp across warps
            uint256 job = _createTakeSubmit();
            vm.warp(vm.getBlockTimestamp() + adapter.APPROVAL_TIMEOUT() + 1);
            (uint256 skips, uint256 settled) =
                _countSilentSkips(stranger, abi.encodeCall(BountyAdapter.autoApprove, (job)));
            assertGt(settled, 0, "autoApprove settles with enough gas");
            assertEq(skips, 0, "autoApprove settled while giveFeedback ran out of gas");
        }
    }

    function test_F09_reconcileCannotSettleWithStarvedFeedback() public {
        uint256[3] memory burns = _burns();
        for (uint256 i = 0; i < burns.length; i++) {
            _deployAdapter(burns[i]);
            deadline = vm.getBlockTimestamp() + 7 days; // via_ir can cache block.timestamp across warps
            uint256 job = _createTakeSubmit();
            vm.warp(deadline + adapter.AC_EXPIRY_BUFFER() + 1);
            escrow.claimRefund(job);
            (uint256 skips, uint256 settled) =
                _countSilentSkips(stranger, abi.encodeCall(BountyAdapter.reconcileExpiredEscrow, (job)));
            assertGt(settled, 0, "reconcile settles with enough gas");
            assertEq(skips, 0, "reconcile settled while giveFeedback ran out of gas");
        }
    }

    function test_F09_rulingCannotSettleWithStarvedPenalty() public {
        uint256[3] memory burns = _burns();
        for (uint256 i = 0; i < burns.length; i++) {
            _deployAdapter(burns[i]);
            uint256 job = _createTakeSubmit();
            vm.prank(poster);
            adapter.disputeBounty(job, "ipfs://olympix-dispute");
            vm.prank(worker);
            adapter.respondToDispute(job, "ipfs://olympix-response");
            // The deployer (this contract) is the arbitrator in this setup. On
            // mainnet the arbitrator is a Safe, and whoever executes a signed
            // Safe transaction chooses its gas.
            (uint256 skips, uint256 settled) = _countSilentSkips(
                address(this), abi.encodeCall(BountyAdapter.resolveDispute, (job, false, "ipfs://olympix-ruling", 50))
            );
            assertGt(settled, 0, "ruling settles with enough gas");
            assertEq(skips, 0, "ruling settled while the penalty write ran out of gas");
        }
    }

    function test_F09_agentJobBelowFloorRevertsInsteadOfSkipping() public {
        uint256 job = _createTakeSubmit();
        vm.prank(poster);
        (bool ok,) = address(adapter).call{gas: 450_000}(abi.encodeCall(BountyAdapter.approveBounty, (job, 90)));
        assertFalse(ok, "below the floor the whole call reverts");
        assertFalse(adapter.getBountyMeta(job).resolved);
        vm.prank(poster);
        vm.expectRevert("gas below feedback floor");
        adapter.approveBounty{gas: 450_000}(job, 90);
    }

    /// @dev The floor applies only where a reputation write follows.
    function test_F09_humanJobNeedsNoFloor() public {
        BountyAdapter.CreateParams memory p = BountyAdapter.CreateParams({
            provider: address(0),
            reward: REWARD,
            deadline: deadline,
            ipfsDescHash: "ipfs://olympix-description",
            category: "dev",
            tags: new string[](0),
            agentOnly: false,
            humanOnly: true,
            requireWorkerBond: false
        });
        vm.prank(poster);
        uint256 job = adapter.createBounty(p);
        vm.prank(worker);
        adapter.takeBounty(job, 0);
        vm.prank(worker);
        adapter.submitWork(job, "ipfs://olympix-result");
        vm.prank(poster);
        adapter.approveBounty{gas: 300_000}(job, 90);
        assertTrue(adapter.getBountyMeta(job).resolved);
        assertEq(reputation.calls(), 0);
    }

    /// @dev Control: a registry that reverts must still never block a payout.
    function test_F09_revertingRegistryStillNeverBlocksPayout() public {
        uint256 job = _createTakeSubmit();
        vm.mockCallRevert(address(reputation), abi.encodeWithSelector(GasHungryReputation.giveFeedback.selector), "no");
        vm.prank(poster);
        adapter.approveBounty(job, 90);
        assertTrue(adapter.getBountyMeta(job).resolved);
        assertEq(token.balanceOf(worker), REWARD - REWARD / 100);
    }

    // ─── F-02: agent owner can make the registry refuse a penalty ─────

    /// @dev Fork-only (skips elsewhere): uses the live ERC-8004 registries on
    ///      Arc mainnet. Run with
    ///      forge test --fork-url https://rpc.blockdaemon.mainnet.arc.io --match-test F02_fork
    function _selfAuthScenario(bool workerApprovesAdapter) internal returns (uint64 count, int128 value) {
        address idReg = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
        address repReg = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;
        BountyAdapter a = new BountyAdapter(address(escrow), idReg, repReg, address(token), address(0xFEE), 100, 500e6);
        vm.prank(worker);
        uint256 id = IIdentityRegistry(idReg).register("ipfs://olympix-agent");

        vm.prank(poster);
        token.approve(address(a), type(uint256).max);
        BountyAdapter.CreateParams memory p = BountyAdapter.CreateParams({
            provider: address(0),
            reward: REWARD,
            deadline: deadline,
            ipfsDescHash: "ipfs://olympix-description",
            category: "dev",
            tags: new string[](0),
            agentOnly: true,
            humanOnly: false,
            requireWorkerBond: false
        });
        vm.prank(poster);
        uint256 job = a.createBounty(p);
        vm.prank(worker);
        a.takeBounty(job, id);
        vm.prank(worker);
        a.submitWork(job, "ipfs://olympix-result");
        vm.prank(poster);
        a.disputeBounty(job, "ipfs://olympix-dispute");
        vm.prank(worker);
        a.respondToDispute(job, "ipfs://olympix-response");

        if (workerApprovesAdapter) {
            vm.prank(worker); // ERC-721 approve on the agent NFT
            (bool ok,) = idReg.call(abi.encodeWithSignature("approve(address,uint256)", address(a), id));
            require(ok, "approve failed");
        }

        a.resolveDispute(job, false, "ipfs://olympix-ruling", 100); // this test deployed `a`, so it is the arbitrator
        assertTrue(a.getBountyMeta(job).resolved, "ruling settles either way");

        address[] memory clients = new address[](1);
        clients[0] = address(a);
        (count, value,) = IReputationRegistry(repReg).getSummary(id, clients, "", "");
    }

    function test_F02_fork_penaltyIsWrittenNormally() public {
        if (block.chainid != 5042) return;
        (uint64 count, int128 value) = _selfAuthScenario(false);
        assertEq(count, 1);
        assertEq(value, -100);
    }

    function test_F02_fork_ownerApprovalMakesPenaltyVanish() public {
        if (block.chainid != 5042) return;
        (uint64 count,) = _selfAuthScenario(true);
        assertEq(count, 0, "the registry refused the penalty and the adapter swallowed it");
    }

    // ─── F-03: early worker dispute (open, pins current behavior) ──────

    /// @dev Pins today's behavior so a future change is deliberate: a worker
    ///      can dispute right after submitting, and if the poster does not
    ///      answer within 48 hours the worker is paid by default.
    function test_F03_workerDisputeRightAfterSubmitWinsAfter48h() public {
        uint256 job = _createTakeSubmit();
        vm.prank(worker);
        adapter.disputeBounty(job, "ipfs://olympix-dispute");

        vm.prank(poster);
        vm.expectRevert("in dispute");
        adapter.approveBounty(job, 90);

        vm.warp(block.timestamp + adapter.DISPUTE_RESPONSE_WINDOW() + 1);
        vm.prank(stranger);
        adapter.claimDefaultRuling(job);
        assertEq(token.balanceOf(worker), REWARD - REWARD / 100, "worker paid 48h after submitting");
    }

    /// @dev The mitigation available today: answering hands the dispute to
    ///      the arbitrator and the default ruling is no longer reachable.
    function test_F03_posterAnswerBlocksDefaultRuling() public {
        uint256 job = _createTakeSubmit();
        vm.prank(worker);
        adapter.disputeBounty(job, "ipfs://olympix-dispute");
        vm.prank(poster);
        adapter.respondToDispute(job, "ipfs://olympix-response");
        vm.warp(block.timestamp + adapter.DISPUTE_RESPONSE_WINDOW() + 1);
        vm.expectRevert("respondent replied");
        adapter.claimDefaultRuling(job);
    }

    // ─── F-04: self-dealt jobs earn reputation (open, pins behavior) ──

    function test_F04_posterWhoOwnsTheAgentStillEarnsReputation() public {
        identity.setOwner(AGENT_ID, poster);
        token.mint(poster, REWARD);
        BountyAdapter.CreateParams memory p = BountyAdapter.CreateParams({
            provider: address(0),
            reward: REWARD,
            deadline: deadline,
            ipfsDescHash: "ipfs://olympix-description",
            category: "dev",
            tags: new string[](0),
            agentOnly: true,
            humanOnly: false,
            requireWorkerBond: false
        });
        vm.startPrank(poster);
        uint256 job = adapter.createBounty(p);
        adapter.takeBounty(job, AGENT_ID);
        adapter.submitWork(job, "ipfs://olympix-result");
        adapter.approveBounty(job, 100);
        vm.stopPrank();

        assertEq(reputation.calls(), 1, "self-dealt job wrote ERC-8004 feedback");
        assertEq(reputation.lastValue(), 100);
        assertEq(adapter.uniquePosterCount(AGENT_ID), 1, "own wallet counted as a unique poster");
    }

    // ─── F-01: escrow fund() has no price guard (third-party jobs) ────

    /// @dev Pins the escrow behavior for jobs created directly on it, outside
    ///      the adapter: the provider can raise the budget after the client
    ///      approved the escrow and before `fund` lands.
    function test_F01_providerCanRepriceDirectJobBeforeFund() public {
        address client = address(0xC1);
        address provider = address(0xD1);
        token.mint(client, 50e6);

        vm.prank(client);
        uint256 id = escrow.createJob(provider, provider, block.timestamp + 1 days, "", address(0));
        vm.prank(provider);
        escrow.setBudget(id, 10e6, "");
        vm.prank(client);
        token.approve(address(escrow), type(uint256).max);

        vm.prank(provider); // lands before the client's fund()
        escrow.setBudget(id, 50e6, "");
        vm.prank(client);
        escrow.fund(id, "");
        vm.prank(provider);
        escrow.submit(id, bytes32(0), "");
        vm.prank(provider);
        escrow.complete(id, bytes32(0), "");

        assertEq(token.balanceOf(client), 0, "client paid the repriced budget");
        assertEq(token.balanceOf(provider), 50e6);
    }

    /// @dev Adapter jobs are immune: the adapter is the provider, so nobody
    ///      else can reprice, and it approves exactly the reward.
    function test_F01_outsiderCannotRepriceAdapterJob() public {
        BountyAdapter.CreateParams memory p = BountyAdapter.CreateParams({
            provider: address(0),
            reward: REWARD,
            deadline: deadline,
            ipfsDescHash: "ipfs://olympix-description",
            category: "dev",
            tags: new string[](0),
            agentOnly: false,
            humanOnly: false,
            requireWorkerBond: false
        });
        vm.prank(poster);
        uint256 job = adapter.createBounty(p);
        vm.prank(stranger);
        vm.expectRevert(AgenticCommerce.Unauthorized.selector);
        escrow.setBudget(job, 1, "");
        vm.prank(worker);
        adapter.takeBounty(job, 0);
        assertEq(escrow.getJob(job).budget, REWARD);
        assertEq(token.allowance(address(adapter), address(escrow)), 0, "no leftover allowance");
    }

    // ─── F-08: escrow fee setters are silent and apply to funded jobs ────

    function test_F08_feeChangeEmitsNothingAndHitsFundedJobs() public {
        uint256 job = _createTakeSubmit();
        uint256 workerBefore = token.balanceOf(worker);

        vm.recordLogs();
        escrow.setPlatformFee(10_000, address(0x7EA5)); // this test is the escrow admin
        assertEq(vm.getRecordedLogs().length, 0, "fee change emits no event");

        vm.prank(poster);
        adapter.approveBounty(job, 90);
        assertTrue(adapter.getBountyMeta(job).resolved);
        assertEq(token.balanceOf(worker) - workerBefore, 0, "a 100% escrow fee leaves the worker nothing");
        assertEq(token.balanceOf(address(0x7EA5)), REWARD);
    }

    // ─── F-18: pin the escrow storage layout the adapter relies on ─────

    /// @dev Any escrow upgrade must keep these slots, the Job field order and
    ///      the enum values; the adapter is not upgradeable and reads them
    ///      through IAgenticCommerce. A failing assert here means the
    ///      candidate implementation would break live adapter jobs.
    function test_F18_escrowStorageLayoutIsPinned() public {
        escrow.setPlatformFee(7, address(0x7EA5));
        escrow.setEvaluatorFee(3);
        uint256 job = _createTakeSubmit();

        assertEq(address(uint160(uint256(vm.load(address(escrow), bytes32(uint256(0)))))), address(token), "slot 0");
        assertEq(uint256(vm.load(address(escrow), bytes32(uint256(1)))), 7, "slot 1 platformFeeBP");
        assertEq(address(uint160(uint256(vm.load(address(escrow), bytes32(uint256(2)))))), address(0x7EA5), "slot 2");
        assertEq(uint256(vm.load(address(escrow), bytes32(uint256(3)))), 3, "slot 3 evaluatorFeeBP");
        assertEq(uint256(vm.load(address(escrow), bytes32(uint256(5)))), job, "slot 5 jobCounter");
        assertEq(uint256(vm.load(address(escrow), keccak256(abi.encode(job, uint256(7))))), 1, "slot 7 jobHasBudget");

        bytes32 base = keccak256(abi.encode(job, uint256(4))); // jobs mapping at slot 4
        assertEq(uint256(vm.load(address(escrow), base)), job, "Job.id");
        assertEq(address(uint160(uint256(vm.load(address(escrow), bytes32(uint256(base) + 1))))), address(adapter));
        assertEq(address(uint160(uint256(vm.load(address(escrow), bytes32(uint256(base) + 2))))), address(adapter));
        assertEq(address(uint160(uint256(vm.load(address(escrow), bytes32(uint256(base) + 3))))), address(adapter));
        assertEq(uint256(vm.load(address(escrow), bytes32(uint256(base) + 5))), REWARD, "Job.budget");
        assertEq(
            uint256(vm.load(address(escrow), bytes32(uint256(base) + 6))),
            deadline + adapter.AC_EXPIRY_BUFFER(),
            "Job.expiredAt"
        );
        uint256 slot7 = uint256(vm.load(address(escrow), bytes32(uint256(base) + 7)));
        assertEq(slot7 & 0xff, uint256(AgenticCommerce.JobStatus.Submitted), "Job.status low byte");
        assertEq(slot7 >> 8, 0, "Job.hook is zero for adapter jobs");

        assertEq(uint256(AgenticCommerce.JobStatus.Expired), 5);
        assertEq(uint256(IAgenticCommerce.JobStatus.Expired), uint256(AgenticCommerce.JobStatus.Expired));
    }

    // ─── F-05: losses by silence write no reputation (open, pins behavior) ───

    function test_F05_rejectionFinalizedBySilenceWritesNothing() public {
        uint256 job = _createTakeSubmit();
        vm.prank(poster);
        adapter.rejectBounty(job, "ipfs://olympix-reject");
        vm.warp(block.timestamp + adapter.REJECTION_CHALLENGE_WINDOW() + 1);
        adapter.finalizeRejection(job);
        assertEq(reputation.calls(), 0, "agent that ignored a rejection got no feedback");
    }

    function test_F05_defaultRulingForPosterWritesNothing() public {
        uint256 job = _createTakeSubmit();
        vm.prank(poster);
        adapter.disputeBounty(job, "ipfs://olympix-dispute");
        vm.warp(block.timestamp + adapter.DISPUTE_RESPONSE_WINDOW() + 1);
        adapter.claimDefaultRuling(job);
        assertEq(token.balanceOf(poster), 10 * REWARD, "poster refunded in full");
        assertEq(reputation.calls(), 0, "agent that stayed silent in a dispute got no penalty");
    }

    function test_F05_takeAndVanishWritesNothing() public {
        BountyAdapter.CreateParams memory p = _agentParams();
        vm.prank(poster);
        uint256 job = adapter.createBounty(p);
        vm.prank(worker);
        adapter.takeBounty(job, AGENT_ID);
        vm.warp(deadline + 1);
        adapter.expireBounty(job);
        assertEq(reputation.calls(), 0, "agent that took and vanished got no penalty");
    }

    // ─── F-06: reconcile trusts the escrow's status (open) ───────────────────

    /// @dev Models an escrow that reports Expired without having refunded
    ///      (a faulty or malicious upgrade). reconcile then pays the worker
    ///      out of the adapter's pooled balance, which here is another
    ///      poster's untaken reward.
    function test_F06_reconcileOnEscrowWordAlonePaysFromOtherBountiesFunds() public {
        address victim = address(0x71C);
        token.mint(victim, REWARD);
        vm.prank(victim);
        token.approve(address(adapter), type(uint256).max);
        BountyAdapter.CreateParams memory p = _agentParams();
        vm.prank(victim);
        uint256 victimJob = adapter.createBounty(p); // untaken: its reward stays in the adapter

        uint256 job = _createTakeSubmit(); // funded: its reward sits in the escrow
        assertEq(token.balanceOf(address(adapter)), REWARD, "only the victim's reward is in the adapter");

        AgenticCommerce.Job memory j = escrow.getJob(job);
        j.status = AgenticCommerce.JobStatus.Expired;
        vm.mockCall(address(escrow), abi.encodeWithSelector(AgenticCommerce.getJob.selector, job), abi.encode(j));

        adapter.reconcileExpiredEscrow(job);
        assertEq(token.balanceOf(worker), REWARD, "worker paid from the pool");
        assertEq(token.balanceOf(address(escrow)), REWARD, "the escrow still holds the job's own funds");

        vm.prank(victim);
        adapter.cancelBounty(victimJob);
        assertEq(adapter.pendingWithdrawals(victim), REWARD, "victim's refund could only be parked");
        assertEq(token.balanceOf(address(adapter)), 0, "and nothing backs it");
    }

    // ─── F-07: getOpenBounties scans every bounty ever listed (open) ─────────

    function test_F07_openListingScanGrowsWithCancelledEntries() public {
        uint256 n = 60;
        BountyAdapter.CreateParams memory p = _agentParams();
        p.reward = 1e6;
        for (uint256 i = 0; i < n; i++) {
            vm.prank(poster);
            uint256 job = adapter.createBounty(p);
            vm.prank(poster);
            adapter.cancelBounty(job);
        }
        vm.cool(address(adapter));
        uint256 g = gasleft();
        uint256[] memory open = adapter.getOpenBounties("", 0, 0);
        uint256 used = g - gasleft();
        assertEq(open.length, 0);
        emit log_named_uint("scan gas per cancelled entry", used / n);
        emit log_named_uint("entries to reach a 50M eth_call cap", 50_000_000 / (used / n));
        assertGt(used / n, 4_000, "each dead entry still costs cold reads on every scan");
    }

    // ─── F-10: a failed reputation write is now logged ───────────────────────

    event ReputationWriteFailed(uint256 indexed jobId, uint256 indexed agentId, int128 value);

    function test_F10_failedWriteEmitsEvent() public {
        uint256 job = _createTakeSubmit();
        vm.mockCallRevert(address(reputation), abi.encodeWithSelector(GasHungryReputation.giveFeedback.selector), "no");
        vm.expectEmit(true, true, false, true, address(adapter));
        emit ReputationWriteFailed(job, AGENT_ID, 90);
        vm.prank(poster);
        adapter.approveBounty(job, 90);
        assertTrue(adapter.getBountyMeta(job).resolved);
    }

    function test_F10_failedPenaltyEmitsNegativeValue() public {
        uint256 job = _createTakeSubmit();
        vm.prank(poster);
        adapter.disputeBounty(job, "ipfs://olympix-dispute");
        vm.prank(worker);
        adapter.respondToDispute(job, "ipfs://olympix-response");
        vm.mockCallRevert(address(reputation), abi.encodeWithSelector(GasHungryReputation.giveFeedback.selector), "no");
        vm.expectEmit(true, true, false, true, address(adapter));
        emit ReputationWriteFailed(job, AGENT_ID, -40);
        adapter.resolveDispute(job, false, "ipfs://olympix-ruling", 40);
    }

    function test_F10_successfulWriteEmitsNoFailure() public {
        uint256 job = _createTakeSubmit();
        vm.recordLogs();
        vm.prank(poster);
        adapter.approveBounty(job, 90);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(logs[i].topics[0] != ReputationWriteFailed.selector, "no failure event on success");
        }
        assertEq(reputation.calls(), 1);
        assertEq(reputation.lastValue(), 90);
    }

    // ─── F-11: agent #0 exists on Arc mainnet but is the "no agent" value ────

    function test_F11_agentZeroCannotTakeAgentOnlyBounty() public {
        identity.setOwner(0, worker);
        BountyAdapter.CreateParams memory p = _agentParams();
        vm.prank(poster);
        uint256 job = adapter.createBounty(p);
        vm.prank(worker);
        vm.expectRevert("agent only: provide agentId");
        adapter.takeBounty(job, 0);
    }

    // ─── F-12: _payOrPark parks a non-canonical return word ──────────────────

    function test_F12_nonCanonicalReturnWordIsParkedNotReverted() public {
        BountyAdapter.CreateParams memory p = _agentParams();
        p.agentOnly = false;
        vm.prank(poster);
        uint256 job = adapter.createBounty(p);
        // transfer() succeeds but returns 2, which abi.decode(.., (bool)) rejects
        vm.mockCall(address(token), abi.encodeWithSelector(MockUSDC.transfer.selector), abi.encode(uint256(2)));
        vm.prank(poster);
        adapter.cancelBounty(job);
        assertTrue(adapter.getBountyMeta(job).resolved, "settlement reached its terminal state");
        assertEq(adapter.pendingWithdrawals(poster), REWARD, "and the refund was parked");
    }

    // ─── F-16: submitWork refuses a resolved bounty ──────────────────────────

    function test_F16_submitAfterExpiryHitsResolvedGuard() public {
        BountyAdapter.CreateParams memory p = _agentParams();
        vm.prank(poster);
        uint256 job = adapter.createBounty(p);
        vm.prank(worker);
        adapter.takeBounty(job, AGENT_ID);
        vm.warp(deadline + 1);
        adapter.expireBounty(job);
        vm.prank(worker);
        vm.expectRevert("resolved");
        adapter.submitWork(job, "ipfs://olympix-result");
    }

    function _agentParams() internal view returns (BountyAdapter.CreateParams memory) {
        return BountyAdapter.CreateParams({
            provider: address(0),
            reward: REWARD,
            deadline: deadline,
            ipfsDescHash: "ipfs://olympix-description",
            category: "dev",
            tags: new string[](0),
            agentOnly: true,
            humanOnly: false,
            requireWorkerBond: false
        });
    }
}
