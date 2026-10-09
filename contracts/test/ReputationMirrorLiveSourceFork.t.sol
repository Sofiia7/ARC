// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ReputationMirror} from "../src/monad/ReputationMirror.sol";
import {BountyAdapterV48} from "../src/monad/BountyAdapterV48.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Real finalized Base/Arc payload, applied only to a pinned Monad fork.
contract ReputationMirrorLiveSourceForkTest is Test {
    address constant SAFE = 0x74678c072Ca546f11466CD44eB7e21730a312a54;
    ReputationMirror mirror;
    BountyAdapterV48 adapter;
    address reporter;
    bytes report;
    ReputationMirror.Update[] updates;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, vm.envUint("MONAD_FORK_BLOCK"));
        require(block.chainid == 10143, "expected live testnet fork");
        mirror = ReputationMirror(0x59e970574D9aDc30892d094C893DA4B73EBE40a0);
        adapter = BountyAdapterV48(0xf88B980B3AB1CD5A2Befd9c0B88B70196f215020);
        assertEq(mirror.owner(), SAFE);
        assertTrue(
            mirror.relayer() == address(0) || mirror.relayer() == 0x77eDC6eCfa56019fD57deC360D8F3862c4D44226,
            "unexpected live reputation writer"
        );
        assertEq(mirror.forwarder(), address(0));
        assertEq(address(adapter.reputationMirror()), address(mirror));
        assertTrue(adapter.paused());
        reporter = makeAddr("isolated fork reputation reporter");
        report = vm.envBytes("NAD_SOURCE_REPORT");
        ReputationMirror.Update[] memory decoded = abi.decode(report, (ReputationMirror.Update[]));
        require(decoded.length > 0, "source evidence missing");
        for (uint256 i; i < decoded.length; ++i) {
            updates.push(decoded[i]);
        }
    }

    function _sync() internal {
        vm.prank(SAFE);
        mirror.setRelayer(reporter);
        vm.prank(reporter);
        mirror.onReport("", report);
    }

    function testLivePayloadExactRecordsAndReplay() public {
        _sync();
        vm.prank(reporter);
        mirror.onReport("", report);
        for (uint256 i; i < updates.length; ++i) {
            ReputationMirror.Update memory u = updates[i];
            (uint64 jobs, uint128 sum, uint64 sourceBlock,) = mirror.records(u.identityOwner, u.sourceChain);
            assertEq(jobs, u.paidJobs);
            assertEq(sum, u.scoreSum);
            assertEq(sourceBlock, u.sourceBlock);
        }
        assertTrue(adapter.paused());
    }

    function testLiveAgentReputationAddsExactBaseHistory() public {
        uint256 id = 2077;
        address identityOwner = adapter.identityRegistry().ownerOf(id);
        (uint256 beforeJobs, uint256 beforeSum) = adapter.getIdentityReputation(id, identityOwner);
        (uint256 previousMirrorJobs, uint256 previousMirrorSum) = mirror.getTotals(identityOwner);
        _sync();
        (uint256 sourceJobs, uint256 sourceSum) = mirror.getTotals(identityOwner);
        // This source owner has one actual paid Base job scored 95.
        assertEq(sourceJobs, 1);
        assertEq(sourceSum, 95);
        (uint256 afterJobs, uint256 afterSum) = adapter.getIdentityReputation(id, identityOwner);
        assertEq(afterJobs, beforeJobs - previousMirrorJobs + sourceJobs);
        assertEq(afterSum, beforeSum - previousMirrorSum + sourceSum);
        assertGe(afterSum, 80 * afterJobs);
    }

    function testUnauthorizedReporterAndGovernanceRevocation() public {
        vm.expectRevert(ReputationMirror.UnauthorizedReporter.selector);
        mirror.onReport("", report);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        mirror.setRelayer(reporter);
        _sync();
        vm.prank(SAFE);
        mirror.setRelayer(address(0));
        vm.prank(reporter);
        vm.expectRevert(ReputationMirror.UnauthorizedReporter.selector);
        mirror.onReport("", report);
    }
}
