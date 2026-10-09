// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "./BountyAdapterV48Contest.t.sol";

/// @dev Real pinned escrow, concurrent jobs, current identities and actual token
/// balances. Ghost violations persist instead of reverting inside the handler,
/// so the default invariant fail_on_revert=false cannot hide a discovered bug.
contract V48MixedHandler is Test {
    BountyAdapterV48 public immutable adapter;
    MockUSDC public immutable usdc;
    MockAgenticCommerce public immutable escrow;
    MockV48IdentityRegistry public immutable identity;
    address public immutable governance;
    address public constant FEE = address(0xFEE);
    address[6] public actors =
        [address(0xA1), address(0xA2), address(0xA3), address(0xB1), address(0xB2), address(0xB3)];
    uint256[] public jobs;
    uint256 public totalMinted;
    bool public terminalViolation;
    bool public overpaid;
    mapping(uint256 => bool) public wasResolved;
    mapping(uint256 => uint256) public allocated;
    mapping(uint256 => mapping(uint256 => uint256)) public awards;
    mapping(bytes4 => uint256) public successfulCalls;

    constructor(BountyAdapterV48 a, MockUSDC token, MockAgenticCommerce ac, MockV48IdentityRegistry id, address admin) {
        adapter = a;
        usdc = token;
        escrow = ac;
        identity = id;
        governance = admin;
    }

    function bootstrap() external {
        require(totalMinted == 0, "initialized");
        usdc.mint(address(this), 1_000_000e6);
        totalMinted = 1_000_000e6;
        usdc.approve(address(adapter), type(uint256).max);
        for (uint256 i; i < 6; ++i) {
            usdc.mint(actors[i], 1000e6);
            totalMinted += 1000e6;
            vm.prank(actors[i]);
            usdc.approve(address(adapter), type(uint256).max);
        }
        for (uint256 i; i < 3; ++i) {
            identity.setOwner(i + 1, actors[i]);
            identity.setWallet(i + 1, actors[i + 3]);
        }
        adapter.acceptArbitrator();
        // Several funded contests, funded/submitted single jobs, an unfunded
        // deposit and an outstanding worker bond exist at the initial state.
        for (uint256 i; i < 8; ++i) {
            _fresh(i);
        }
    }

    function fresh(uint256 seed) external {
        if (jobs.length < 40) _fresh(seed);
    }

    /// @dev Deterministic model coverage, excluded from random target selectors.
    function exerciseMatrix() external {
        for (uint8 scenario; scenario < 13; ++scenario) {
            vm.prank(governance);
            adapter.setPaused(false);
            identity.setUnavailable(false);
            identity.setOwner(1, actors[0]);
            identity.setWallet(1, actors[3]);
            usdc.setBlacklisted(address(this), false);
            for (uint256 i; i < 6; ++i) {
                usdc.setBlacklisted(actors[i], false);
            }
            _fresh(scenario == 2 ? 2 : uint256(scenario) * 4);
            uint256 job = jobs[jobs.length - 1];
            uint8[] memory indices = new uint8[](1);
            uint8[] memory scores = new uint8[](1);
            scores[0] = 95;
            if (scenario == 0) {
                _attempt(job, address(this), abi.encodeCall(adapter.pickContestWinners, (job, indices, scores)));
                continue;
            }
            vm.warp(adapter.getBountyMeta(job).deadline);
            if (scenario == 1) {
                vm.warp(vm.getBlockTimestamp() + 14 days + 1);
                _attempt(job, address(this), abi.encodeCall(adapter.settleContestSilence, (job)));
                continue;
            }
            if (scenario == 2) {
                _attempt(job, address(this), abi.encodeCall(adapter.expireBounty, (job)));
                continue;
            }
            if (scenario != 11) {
                _attempt(job, address(this), abi.encodeCall(adapter.rejectAllContestEntries, (job, "ipfs://reject")));
            }
            if (scenario != 3 && scenario != 11 && scenario != 12) {
                _attempt(job, actors[0], abi.encodeCall(adapter.challengeContestRejection, (job, 0, "ipfs://evidence")));
                _attempt(job, actors[4], abi.encodeCall(adapter.challengeContestRejection, (job, 1, "ipfs://evidence")));
            }
            if (scenario == 4) {
                identity.setOwner(1, actors[2]);
                _attempt(job, address(this), abi.encodeCall(adapter.acceptContestChallengers, (job, indices, scores)));
                continue;
            }
            if (scenario == 5 || scenario == 6 || scenario == 8 || scenario == 9) {
                _attempt(
                    job, address(this), abi.encodeCall(adapter.respondToContestChallenges, (job, "ipfs://response"))
                );
            }
            vm.warp(vm.getBlockTimestamp() + 48 hours + 1);
            if (scenario == 3) _attempt(job, address(this), abi.encodeCall(adapter.finalizeContestRejection, (job)));
            if (scenario == 5 || scenario == 6) {
                _attempt(
                    job,
                    address(this),
                    abi.encodeCall(
                        adapter.resolveContestDispute, (job, scenario == 5 ? indices : new uint8[](0), "ipfs://ruling")
                    )
                );
            }
            if (scenario == 7) _attempt(job, address(this), abi.encodeCall(adapter.claimContestDefault, (job)));
            if (scenario == 8) {
                vm.warp(adapter.getBountyMeta(job).disputeRaisedAt + 30 days + 1);
                identity.setUnavailable(true);
                usdc.setBlacklisted(address(this), true);
                _attempt(job, address(this), abi.encodeCall(adapter.claimContestArbitratorTimeout, (job)));
            }
            if (scenario >= 9) {
                vm.warp(escrow.getJob(job).expiredAt);
                escrow.claimRefund(job);
                _attempt(job, address(this), abi.encodeCall(adapter.reconcileExpiredEscrow, (job)));
            }
        }
        // Replay attempts and independent single-taker obligations still coexist.
        this.act(0, 2, 0);
        this.act(1, 2, 0);
        this.act(3, 11, 0);
        this.act(5, 12, 0);
        this.act(7, 3, 0);
    }

    function _fresh(uint256 seed) internal {
        BountyAdapterV48.CreateParams memory p;
        p.reward = 1e6 + seed % 50e6;
        p.deadline = vm.getBlockTimestamp() + 7 days;
        p.ipfsDescHash = "ipfs://description";
        p.category = "dev";
        p.tags = new string[](0);
        p.contest = seed % 2 == 0;
        p.maxEntries = 3;
        p.winners = 2;
        p.requireWorkerBond = !p.contest && seed % 3 == 0;
        try adapter.createBounty(p) returns (uint256 job) {
            jobs.push(job);
            if (p.contest) {
                if (seed % 4 == 0) {
                    _attempt(job, identity.owners(1), abi.encodeCall(adapter.enterContest, (job, 1, "ipfs://cipher")));
                    _attempt(job, actors[4], abi.encodeCall(adapter.enterContest, (job, 0, "ipfs://cipher")));
                }
            } else if (seed % 5 != 0) {
                _attempt(job, actors[3], abi.encodeCall(adapter.takeBounty, (job, 0)));
                if (!p.requireWorkerBond) {
                    _attempt(job, actors[3], abi.encodeCall(adapter.submitWork, (job, "ipfs://work")));
                }
            }
        } catch {}
    }

    function tick(uint256 seed) external {
        vm.warp(vm.getBlockTimestamp() + 1 + seed % (100 days));
    }

    function rotate(uint256 seed, bool transfer, bool unavailable) external {
        uint256 id = 1 + seed % 3;
        if (transfer) identity.setOwner(id, actors[(seed / 3) % 6]);
        else identity.setWallet(id, actors[(seed / 3) % 6]);
        identity.setUnavailable(unavailable);
    }

    function blacklist(uint256 seed, bool value) external {
        address who = seed % 8 < 6 ? actors[seed % 8] : (seed % 8 == 6 ? FEE : address(this));
        usdc.setBlacklisted(who, value);
    }

    function pause(bool value) external {
        vm.prank(governance);
        adapter.setPaused(value);
    }

    function withdraw(uint256 seed, bool byIdentity) external {
        if (byIdentity) {
            uint256 id = 1 + seed % 3;
            vm.prank(identity.owners(id));
            try adapter.withdrawIdentity(id) {} catch {}
        } else {
            address who = seed % 8 < 6 ? actors[seed % 8] : (seed % 8 == 6 ? FEE : address(this));
            vm.prank(who);
            try adapter.withdraw() {} catch {}
        }
    }

    function externalRefund(uint256 seed) external {
        uint256 job = jobs[seed % jobs.length];
        try escrow.claimRefund(job) {} catch {}
    }

    function act(uint256 seed, uint8 choice, uint8 selection) external {
        uint256 job = jobs[seed % jobs.length];
        BountyAdapterV48.BountyMeta memory m = adapter.getBountyMeta(job);
        uint8[] memory indices = new uint8[](1);
        indices[0] = selection % 3;
        uint8[] memory scores = new uint8[](1);
        scores[0] = uint8(seed % 101);
        address caller = address(this);
        bytes memory data;
        if (m.contest) {
            uint256 count = adapter.getContestEntries(job).length;
            uint8 index = count == 0 ? 0 : uint8(selection % count);
            BountyAdapterV48.ContestEntry[] memory entries = adapter.getContestEntries(job);
            address entrant = count == 0
                ? actors[0]
                : (entries[index].agentId == 0 ? entries[index].entrant : identity.owners(entries[index].agentId));
            uint8 kind = choice % 13;
            if (kind == 0) {
                caller = actors[seed % 6];
                data = abi.encodeCall(adapter.enterContest, (job, 0, "ipfs://cipher"));
            }
            if (kind == 1) {
                caller = entrant;
                data = abi.encodeCall(adapter.replaceContestEntry, (job, index, "ipfs://replacement"));
            }
            if (kind == 2) data = abi.encodeCall(adapter.pickContestWinners, (job, indices, scores));
            if (kind == 3) data = abi.encodeCall(adapter.rejectAllContestEntries, (job, "ipfs://reject"));
            if (kind == 4) {
                caller = entrant;
                data = abi.encodeCall(adapter.challengeContestRejection, (job, index, "ipfs://evidence"));
            }
            if (kind == 5) data = abi.encodeCall(adapter.respondToContestChallenges, (job, "ipfs://response"));
            if (kind == 6) data = abi.encodeCall(adapter.acceptContestChallengers, (job, indices, scores));
            if (kind == 7) {
                data = abi.encodeCall(
                    adapter.resolveContestDispute, (job, selection % 2 == 0 ? indices : new uint8[](0), "ipfs://ruling")
                );
            }
            if (kind == 8) data = abi.encodeCall(adapter.finalizeContestRejection, (job));
            if (kind == 9) data = abi.encodeCall(adapter.claimContestDefault, (job));
            if (kind == 10) data = abi.encodeCall(adapter.claimContestArbitratorTimeout, (job));
            if (kind == 11) data = abi.encodeCall(adapter.settleContestSilence, (job));
            if (kind == 12) data = abi.encodeCall(adapter.reconcileExpiredEscrow, (job));
        } else {
            uint8 kind = choice % 13;
            if (kind == 0) {
                caller = actors[seed % 6];
                data = abi.encodeCall(adapter.takeBounty, (job, seed % 2 == 0 ? 1 : 0));
            }
            if (kind == 1) {
                caller = m.agentId == 0 ? m.assignedProvider : identity.owners(m.agentId);
                data = abi.encodeCall(adapter.submitWork, (job, "ipfs://work"));
            }
            if (kind == 2) data = abi.encodeCall(adapter.approveBounty, (job, uint8(seed % 101)));
            if (kind == 3) data = abi.encodeCall(adapter.autoApprove, (job));
            if (kind == 4) data = abi.encodeCall(adapter.rejectBounty, (job, "ipfs://reject"));
            if (kind == 5) data = abi.encodeCall(adapter.finalizeRejection, (job));
            if (kind == 6) {
                caller = m.agentId == 0 ? m.assignedProvider : identity.owners(m.agentId);
                data = abi.encodeCall(adapter.challengeRejection, (job, "ipfs://evidence"));
            }
            if (kind == 7) data = abi.encodeCall(adapter.respondToDispute, (job, "ipfs://response"));
            if (kind == 8) {
                data = abi.encodeCall(adapter.resolveDispute, (job, selection % 2 == 0, "ipfs://ruling", 0));
            }
            if (kind == 9) data = abi.encodeCall(adapter.claimDefaultRuling, (job));
            if (kind == 10) data = abi.encodeCall(adapter.claimArbitratorTimeout, (job));
            if (kind == 11) data = abi.encodeCall(adapter.expireBounty, (job));
            if (kind == 12) data = abi.encodeCall(adapter.cancelBounty, (job));
        }
        _attempt(job, caller, data);
    }

    function _attempt(uint256 job, address caller, bytes memory data) internal {
        uint256 heldBefore = usdc.balanceOf(address(adapter)) + usdc.balanceOf(address(escrow));
        uint256 pendingBefore = pending();
        BountyAdapterV48.BountyMeta memory beforeMeta = adapter.getBountyMeta(job);
        vm.recordLogs();
        vm.prank(caller);
        (bool ok,) = address(adapter).call(data);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        BountyAdapterV48.BountyMeta memory afterMeta = adapter.getBountyMeta(job);
        uint256 heldAfter = usdc.balanceOf(address(adapter)) + usdc.balanceOf(address(escrow));
        uint256 pendingAfter = pending();
        if (ok) successfulCalls[bytes4(data)]++;
        if (beforeMeta.resolved && (!afterMeta.resolved || heldAfter != heldBefore || pendingAfter != pendingBefore)) {
            terminalViolation = true;
        }
        if (!beforeMeta.resolved && afterMeta.resolved) {
            if (heldAfter > heldBefore || pendingAfter < pendingBefore) {
                overpaid = true;
            } else {
                allocated[job] += heldBefore - heldAfter + pendingAfter - pendingBefore;
                if (allocated[job] > beforeMeta.reward + beforeMeta.workerBond) overpaid = true;
            }
        }
        if (afterMeta.resolved) wasResolved[job] = true;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(adapter) && logs[i].topics.length == 3
                    && logs[i].topics[0] == keccak256("ContestAwarded(uint256,uint8,uint256,bool,uint8)")
            ) {
                ++awards[uint256(logs[i].topics[1])][uint256(logs[i].topics[2])];
            }
        }
    }

    function pending() public view returns (uint256 sum) {
        sum = adapter.pendingWithdrawals(address(this)) + adapter.pendingWithdrawals(FEE);
        for (uint256 i; i < 6; ++i) {
            sum += adapter.pendingWithdrawals(actors[i]);
        }
        for (uint256 i = 1; i <= 3; ++i) {
            sum += adapter.pendingIdentityWithdrawals(i);
        }
    }

    function circulating() external view returns (uint256 sum) {
        sum = usdc.balanceOf(address(this)) + usdc.balanceOf(FEE) + usdc.balanceOf(address(adapter))
            + usdc.balanceOf(address(escrow));
        for (uint256 i; i < 6; ++i) {
            sum += usdc.balanceOf(actors[i]);
        }
    }

    function jobCount() external view returns (uint256) {
        return jobs.length;
    }
}

contract BountyAdapterV48MixedInvariantTest is Test {
    BountyAdapterV48 internal adapter;
    MockUSDC internal usdc;
    MockAgenticCommerce internal escrow;
    V48MixedHandler internal handler;

    function setUp() public {
        vm.warp(1000);
        usdc = new MockUSDC();
        MockV48IdentityRegistry identity = new MockV48IdentityRegistry();
        AgenticCommerce implementation = new AgenticCommerce();
        escrow = MockAgenticCommerce(
            address(
                new ERC1967Proxy(
                    address(implementation),
                    abi.encodeCall(AgenticCommerce.initialize, (address(usdc), address(0xFEE), address(this)))
                )
            )
        );
        adapter = BountyAdapterV48(
            deployCode(
                "BountyAdapterV48.sol:BountyAdapterV48",
                abi.encode(
                    address(escrow),
                    address(identity),
                    address(new MockReputationRegistry()),
                    address(usdc),
                    address(0xFEE),
                    address(new ReputationMirror(address(this), address(0)))
                )
            )
        );
        adapter.setPaused(false);
        handler = new V48MixedHandler(adapter, usdc, escrow, identity, address(this));
        adapter.transferArbitrator(address(handler));
        handler.bootstrap();
        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = handler.fresh.selector;
        selectors[1] = handler.act.selector;
        selectors[2] = handler.tick.selector;
        selectors[3] = handler.rotate.selector;
        selectors[4] = handler.blacklist.selector;
        selectors[5] = handler.withdraw.selector;
        selectors[6] = handler.externalRefund.selector;
        selectors[7] = handler.pause.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
        targetContract(address(handler));
    }

    function invariant_conservesEveryMintedUnit() public view {
        assertEq(handler.circulating(), handler.totalMinted());
    }

    function testModelExercisesEveryContestExitAndSingleTakerObligations() public {
        handler.exerciseMatrix();
        invariant_conservesEveryMintedUnit();
        invariant_balancesCoverEveryOpenObligationAndParkedClaim();
        invariant_terminalAndPerJobPayoutBounds();
        bytes4[9] memory exits = [
            adapter.pickContestWinners.selector,
            adapter.settleContestSilence.selector,
            adapter.expireBounty.selector,
            adapter.finalizeContestRejection.selector,
            adapter.acceptContestChallengers.selector,
            adapter.resolveContestDispute.selector,
            adapter.claimContestDefault.selector,
            adapter.claimContestArbitratorTimeout.selector,
            adapter.reconcileExpiredEscrow.selector
        ];
        for (uint256 i; i < exits.length; ++i) {
            assertGt(handler.successfulCalls(exits[i]), 0, "model missed exit");
        }
        assertGt(handler.successfulCalls(adapter.approveBounty.selector), 0);
        assertGt(handler.successfulCalls(adapter.autoApprove.selector), 0);
        assertGt(handler.successfulCalls(adapter.cancelBounty.selector), 0);
    }

    function invariant_balancesCoverEveryOpenObligationAndParkedClaim() public view {
        uint256 direct = handler.pending();
        uint256 escrowed;
        for (uint256 i; i < handler.jobCount(); ++i) {
            uint256 job = handler.jobs(i);
            BountyAdapterV48.BountyMeta memory m = adapter.getBountyMeta(job);
            if (m.resolved) continue;
            direct += m.workerBond;
            IAgenticCommerce.JobStatus status = escrow.getJob(job).status;
            if (status == IAgenticCommerce.JobStatus.Funded || status == IAgenticCommerce.JobStatus.Submitted) {
                escrowed += m.reward;
            } else {
                direct += m.reward;
            }
        }
        assertEq(usdc.balanceOf(address(adapter)), direct, "adapter liabilities");
        assertEq(usdc.balanceOf(address(escrow)), escrowed, "escrow liabilities");
    }

    function invariant_terminalAndPerJobPayoutBounds() public view {
        assertFalse(handler.terminalViolation());
        assertFalse(handler.overpaid());
        for (uint256 i; i < handler.jobCount(); ++i) {
            uint256 job = handler.jobs(i);
            BountyAdapterV48.BountyMeta memory m = adapter.getBountyMeta(job);
            if (handler.wasResolved(job)) assertTrue(m.resolved);
            if (!m.contest) continue;
            assertLe(handler.allocated(job), m.reward);
            BountyAdapterV48.ContestEntry[] memory entries = adapter.getContestEntries(job);
            for (uint256 j; j < entries.length; ++j) {
                assertLe(handler.awards(job, j), 1, "duplicate award");
                assertEq(entries[j].awarded, handler.awards(job, j) == 1, "award/event mismatch");
            }
        }
    }
}
