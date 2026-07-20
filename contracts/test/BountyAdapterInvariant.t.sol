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
            address(commerce), address(identity), address(reputation), address(usdc), address(0xFEE), 100, 0
        );
        // arbitrator() defaults to msg.sender of the constructor call, i.e.
        // this test contract — pass it through so the Handler can act as
        // arbitrator for resolveDispute.
        handler = new Handler(adapter, usdc, address(this));
        handler.bootstrap();

        targetContract(address(handler));
    }

    /// @dev USDC held by the system (adapter + AC + feeRecipient + handler, as
    ///      poster) plus everything currently held by the worker actors must
    ///      equal what was ever minted — no money created, none destroyed.
    ///      Reading actor balances directly (rather than accumulating a
    ///      running "totalPaidOut" counter across specific call sites) means
    ///      every money-movement path — including ones added later — is
    ///      covered automatically, with nothing to remember to instrument.
    function invariant_conservationOfUSDC() public view {
        uint256 systemHeld = usdc.balanceOf(address(adapter)) + usdc.balanceOf(address(commerce))
            + usdc.balanceOf(address(0xFEE)) + usdc.balanceOf(address(handler)) + handler.totalActorBalances();
        assertEq(systemHeld, handler.totalMinted());
    }

    /// @dev Once a bounty flips to resolved, it never un-resolves — checked
    ///      across every resolution path the handler exercises: approve,
    ///      cancel, expire, rejection-finalize, dispute resolution (by
    ///      arbitrator, default ruling, or arbitrator timeout).
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
    address immutable arbitrator;

    uint256 public constant SEED_PER_HOLDER = 1_000_000e6;
    uint256 public totalMinted;

    mapping(uint256 => bool) public wasResolved;
    uint256[] public knownJobs;

    address[] public actors;

    constructor(BountyAdapter _adapter, MockUSDC _usdc, address _arbitrator) {
        adapter = _adapter;
        usdc = _usdc;
        arbitrator = _arbitrator;
        actors.push(address(0xA1));
        actors.push(address(0xA2));
        actors.push(address(0xA3));
    }

    /// @dev Funds the handler itself (it acts as poster for every created
    ///      bounty) and every worker actor (needed so V4 worker-bond
    ///      `takeBounty` calls — which pull the bond from msg.sender, i.e. the
    ///      actor — don't revert for want of balance/allowance), and tracks
    ///      the grand total minted so the conservation invariant has a
    ///      ground truth that isn't a magic literal.
    function bootstrap() external {
        usdc.mint(address(this), SEED_PER_HOLDER);
        usdc.approve(address(adapter), type(uint256).max);
        totalMinted += SEED_PER_HOLDER;
        for (uint256 i = 0; i < actors.length; i++) {
            usdc.mint(actors[i], SEED_PER_HOLDER);
            totalMinted += SEED_PER_HOLDER;
            vm.prank(actors[i]);
            usdc.approve(address(adapter), type(uint256).max);
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function totalActorBalances() external view returns (uint256 sum) {
        for (uint256 i = 0; i < actors.length; i++) {
            sum += usdc.balanceOf(actors[i]);
        }
    }

    // ─── Lifecycle ──────────────────────────────────────────────────────────

    function createBounty(uint256 rewardSeed, uint256 daysAhead, bool requireBond) external {
        uint256 reward = 1e6 + (rewardSeed % 50e6);
        // Bond bounties must clear MIN_BOND_BOUNTY_DURATION (24h, V4.1
        // honeypot guard) or createBounty reverts and the bond paths would
        // silently stop being fuzzed whenever daysAhead % 30 == 0.
        uint256 minAhead = requireBond ? 1 days : 1;
        uint256 deadline = block.timestamp + minAhead + (daysAhead % 30) * 1 days;
        string[] memory tags = new string[](0);
        BountyAdapter.CreateParams memory p = BountyAdapter.CreateParams({
            provider: address(0),
            reward: reward,
            deadline: deadline,
            ipfsDescHash: "ipfs://Qm",
            category: "dev",
            tags: tags,
            agentOnly: false,
            humanOnly: false,
            requireWorkerBond: requireBond
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
        vm.prank(m.assignedProvider);
        try adapter.submitWork(jobId, "ipfs://res") {} catch {}
    }

    function approveBounty(uint256 seed) external {
        if (knownJobs.length == 0) return;
        uint256 jobId = knownJobs[seed % knownJobs.length];
        BountyAdapter.BountyMeta memory m = adapter.getBountyMeta(jobId);
        if (m.poster == address(0)) return;
        _prankUnlessSelf(m.poster);
        try adapter.approveBounty(jobId, 90) {
            wasResolved[jobId] = true;
        } catch {}
    }

    function cancelBounty(uint256 seed) external {
        if (knownJobs.length == 0) return;
        uint256 jobId = knownJobs[seed % knownJobs.length];
        BountyAdapter.BountyMeta memory m = adapter.getBountyMeta(jobId);
        if (m.poster == address(0)) return;
        _prankUnlessSelf(m.poster);
        try adapter.cancelBounty(jobId) {
            wasResolved[jobId] = true;
        } catch {}
    }

    /// @dev Permissionless — past deadline, no submission, not yet resolved.
    ///      Also exercises the V4 worker-bond forfeit-to-poster path when the
    ///      bounty was taken-and-abandoned.
    function expireBounty(uint256 seed) external {
        if (knownJobs.length == 0) return;
        uint256 jobId = knownJobs[seed % knownJobs.length];
        try adapter.expireBounty(jobId) {
            wasResolved[jobId] = true;
        } catch {}
    }

    // ─── Disputes ───────────────────────────────────────────────────────────

    /// @dev Either the poster (the handler itself) or the assigned provider
    ///      (an actor) may open a dispute after a submission exists.
    function disputeBounty(uint256 seed) external {
        if (knownJobs.length == 0) return;
        uint256 jobId = knownJobs[seed % knownJobs.length];
        BountyAdapter.BountyMeta memory m = adapter.getBountyMeta(jobId);
        if (m.poster == address(0) || bytes(m.submittedResultHash).length == 0) return;

        address initiator = seed % 2 == 0 && m.assignedProvider != address(0) ? m.assignedProvider : m.poster;
        _prankUnlessSelf(initiator); // no-op prank if initiator == address(this)
        try adapter.disputeBounty(jobId, "ipfs://dispute-reason") {} catch {}
    }

    /// @dev The non-initiating party responds within the window.
    function respondToDispute(uint256 seed) external {
        if (knownJobs.length == 0) return;
        uint256 jobId = knownJobs[seed % knownJobs.length];
        BountyAdapter.BountyMeta memory m = adapter.getBountyMeta(jobId);
        if (!m.inDispute) return;
        address other = m.disputeInitiator == m.poster ? m.assignedProvider : m.poster;
        if (other == address(0)) return;
        _prankUnlessSelf(other);
        try adapter.respondToDispute(jobId, "ipfs://dispute-response") {} catch {}
    }

    /// @dev Arbitrator-only ruling — the handler was constructed with the
    ///      real arbitrator address so it can prank as it.
    function resolveDispute(uint256 seed, bool payProvider, uint8 penalty) external {
        if (knownJobs.length == 0) return;
        uint256 jobId = knownJobs[seed % knownJobs.length];
        BountyAdapter.BountyMeta memory m = adapter.getBountyMeta(jobId);
        if (!m.inDispute) return;
        vm.prank(arbitrator);
        try adapter.resolveDispute(jobId, payProvider, "ipfs://ruling", penalty % 101) {
            wasResolved[jobId] = true;
        } catch {}
    }

    /// @dev Permissionless — respondent never replied within the window.
    function claimDefaultRuling(uint256 seed) external {
        if (knownJobs.length == 0) return;
        uint256 jobId = knownJobs[seed % knownJobs.length];
        try adapter.claimDefaultRuling(jobId) {
            wasResolved[jobId] = true;
        } catch {}
    }

    /// @dev Permissionless — both sides replied but the arbitrator ghosted
    ///      for ARBITRATOR_TIMEOUT (30d). Neutral 50/50 split.
    function claimArbitratorTimeout(uint256 seed) external {
        if (knownJobs.length == 0) return;
        uint256 jobId = knownJobs[seed % knownJobs.length];
        try adapter.claimArbitratorTimeout(jobId) {
            wasResolved[jobId] = true;
        } catch {}
    }

    // ─── Time ───────────────────────────────────────────────────────────────

    /// @dev Advances block.timestamp by a bounded random amount so the
    ///      fuzzer can actually cross the contract's time windows (48h
    ///      dispute/rejection windows, 14d approval timeout, 30d arbitrator
    ///      timeout, up to 30d bounty deadlines) instead of every call
    ///      happening at the same instant.
    function warp(uint256 secondsSeed) external {
        uint256 delta = 1 + (secondsSeed % 35 days);
        vm.warp(block.timestamp + delta);
    }

    // ─── Internal ───────────────────────────────────────────────────────────

    /// @dev Pranks as `who` unless `who` is this contract itself (the
    ///      poster of every created bounty) — calling directly as `this`
    ///      needs no prank and pranking as one's own address is a no-op
    ///      distinction Foundry doesn't need help with, but being explicit
    ///      here avoids ever accidentally leaving a stale prank active.
    function _prankUnlessSelf(address who) internal {
        if (who != address(this)) vm.prank(who);
    }
}
