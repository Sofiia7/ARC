// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "forge-std/Test.sol";
import "../src/BountyAdapter.sol";
import "./BountyAdapter.t.sol"; // reuse mocks

/// @notice Stateful invariants against the mock harness.
contract BountyAdapterInvariantTest is Test {
    BountyAdapter adapter;
    MockUSDC usdc;
    MockAgenticCommerce commerce;
    MockIdentityRegistry identity;
    MockReputationRegistry reputation;

    Handler handler;

    function setUp() public {
        usdc = new MockUSDC();
        commerce = new MockAgenticCommerce(address(usdc));
        identity = new MockIdentityRegistry();
        reputation = new MockReputationRegistry();
        adapter = new BountyAdapter(
            address(commerce), address(identity), address(reputation), address(usdc), address(0xFEE), 100
        );

        handler = new Handler(adapter, usdc, address(0xFEE));
        usdc.mint(address(handler), 1_000_000e6);
        handler.bootstrapAllowance();

        targetContract(address(handler));
    }

    /// @dev USDC held by the system (adapter + AC + feeRecipient) plus
    ///      everything we've paid out to posters/workers must equal what we
    ///      ever minted to the handler — no money created, none destroyed.
    function invariant_conservationOfUSDC() public view {
        uint256 systemHeld = usdc.balanceOf(address(adapter)) + usdc.balanceOf(address(commerce))
            + usdc.balanceOf(address(0xFEE)) + usdc.balanceOf(address(handler)) + handler.totalPaidOut();
        // Total minted to handler at setUp.
        assertEq(systemHeld, 1_000_000e6);
    }

    /// @dev Once a bounty flips to resolved, it never un-resolves.
    function invariant_resolvedIsTerminal() public view {
        uint256 n = adapter.totalBounties();
        for (uint256 i = 0; i < n; i++) {
            uint256 jobId = adapter.allJobIds(i);
            if (handler.wasResolved(jobId)) {
                BountyAdapter.BountyMeta memory m = adapter.getBountyMeta(jobId);
                assertTrue(m.resolved, "resolved flipped back");
            }
        }
    }
}

/// @notice Bounded random caller. Picks a small action surface so the fuzzer
///         actually exercises the lifecycle rather than spamming reverts.
contract Handler is Test {
    BountyAdapter immutable adapter;
    MockUSDC immutable usdc;
    address immutable feeRecipient;

    uint256 public totalPaidOut;
    mapping(uint256 => bool) public wasResolved;
    uint256[] public knownJobs;

    address[] public actors;

    constructor(BountyAdapter _adapter, MockUSDC _usdc, address _feeRecipient) {
        adapter = _adapter;
        usdc = _usdc;
        feeRecipient = _feeRecipient;
        actors.push(address(0xA1));
        actors.push(address(0xA2));
        actors.push(address(0xA3));
    }

    function bootstrapAllowance() external {
        usdc.approve(address(adapter), type(uint256).max);
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function createBounty(uint256 rewardSeed, uint256 daysAhead) external {
        uint256 reward = 1e6 + (rewardSeed % 50e6);
        uint256 deadline = block.timestamp + 1 + (daysAhead % 30) * 1 days;
        string[] memory tags = new string[](0);
        BountyAdapter.CreateParams memory p = BountyAdapter.CreateParams({
            provider: address(0),
            reward: reward,
            deadline: deadline,
            ipfsDescHash: "ipfs://Qm",
            category: "dev",
            tags: tags,
            agentOnly: false,
            humanOnly: false
        });
        try adapter.createBounty(p) returns (uint256 jobId) {
            knownJobs.push(jobId);
        } catch { /* ignore */ }
    }

    function takeBounty(uint256 seed) external {
        if (knownJobs.length == 0) return;
        uint256 jobId = knownJobs[seed % knownJobs.length];
        address w = _actor(seed);
        vm.prank(w);
        try adapter.takeBounty(jobId, 0) {} catch {}
    }

    function submitWork(uint256 seed) external {
        if (knownJobs.length == 0) return;
        uint256 jobId = knownJobs[seed % knownJobs.length];
        BountyAdapter.BountyMeta memory m = adapter.getBountyMeta(jobId);
        if (m.assignedProvider == address(0)) return;
        uint256 beforePayout = _totalActorBalances();
        vm.prank(m.assignedProvider);
        try adapter.submitWork(jobId, "ipfs://res") {} catch {}
        totalPaidOut += _totalActorBalances() - beforePayout;
    }

    function approveBounty(uint256 seed) external {
        if (knownJobs.length == 0) return;
        uint256 jobId = knownJobs[seed % knownJobs.length];
        BountyAdapter.BountyMeta memory m = adapter.getBountyMeta(jobId);
        if (m.poster == address(0)) return;
        uint256 beforePayout = _totalActorBalances();
        vm.prank(m.poster);
        try adapter.approveBounty(jobId, 90) {
            wasResolved[jobId] = true;
        } catch {}
        totalPaidOut += _totalActorBalances() - beforePayout;
    }

    function cancelBounty(uint256 seed) external {
        if (knownJobs.length == 0) return;
        uint256 jobId = knownJobs[seed % knownJobs.length];
        BountyAdapter.BountyMeta memory m = adapter.getBountyMeta(jobId);
        if (m.poster == address(0)) return;
        uint256 beforePayout = _totalActorBalances();
        vm.prank(m.poster);
        try adapter.cancelBounty(jobId) {
            wasResolved[jobId] = true;
        } catch {}
        totalPaidOut += _totalActorBalances() - beforePayout;
    }

    function _totalActorBalances() internal view returns (uint256 sum) {
        for (uint256 i = 0; i < actors.length; i++) {
            sum += usdc.balanceOf(actors[i]);
        }
    }
}
