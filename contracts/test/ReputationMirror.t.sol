// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ICREReceiver} from "../src/monad/interfaces/ICREReceiver.sol";
import {ReputationMirror} from "../src/monad/ReputationMirror.sol";

contract ReputationMirrorTest is Test {
    ReputationMirror internal mirror;
    address internal constant SAFE = address(0x5AFE);
    address internal constant RELAYER = address(0x1234);
    address internal constant FORWARDER = address(0x5678);
    address internal constant AGENT_OWNER = address(0xA11CE);
    bytes32 internal constant WORKFLOW = keccak256("nadbounty-reputation");

    function setUp() public {
        vm.warp(1000);
        mirror = new ReputationMirror(SAFE, RELAYER);
    }

    function _update(uint256 chain, uint64 sourceBlock, uint64 jobs, uint128 sum)
        internal
        pure
        returns (ReputationMirror.Update memory)
    {
        return ReputationMirror.Update(AGENT_OWNER, chain, sourceBlock, jobs, sum);
    }

    function _one(uint256 chain, uint64 sourceBlock, uint64 jobs, uint128 sum)
        internal
        pure
        returns (ReputationMirror.Update[] memory updates)
    {
        updates = new ReputationMirror.Update[](1);
        updates[0] = _update(chain, sourceBlock, jobs, sum);
    }

    function _write(uint256 chain, uint64 sourceBlock, uint64 jobs, uint128 sum) internal {
        vm.prank(RELAYER);
        mirror.updateRecords(_one(chain, sourceBlock, jobs, sum));
    }

    function _enableForwarder() internal {
        vm.prank(SAFE);
        mirror.setForwarder(FORWARDER, WORKFLOW);
    }

    function testDeploymentUsesSafeAndDisablesForwarder() public view {
        assertEq(mirror.owner(), SAFE);
        assertEq(mirror.relayer(), RELAYER);
        assertEq(mirror.forwarder(), address(0));
        assertEq(mirror.workflowId(), bytes32(0));
        (uint256 jobs, uint256 sum) = mirror.getTotals(AGENT_OWNER);
        assertEq(jobs, 0);
        assertEq(sum, 0);
    }

    function testDeployerCannotConfigureOrReport() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        mirror.setRelayer(address(this));
        vm.expectRevert(ReputationMirror.UnauthorizedReporter.selector);
        mirror.updateRecords(_one(8453, 10, 3, 240));
        vm.expectRevert(ReputationMirror.UnauthorizedReporter.selector);
        mirror.onReport("", abi.encode(_one(8453, 10, 3, 240)));
    }

    function testSourceSnapshotsHaveIndependentBlocksAndWeightedTotals() public {
        _write(8453, 100, 1, 100);
        _write(5042, 50, 9, 720);
        (uint256 jobs, uint256 sum) = mirror.getTotals(AGENT_OWNER);
        assertEq(jobs, 10);
        assertEq(sum, 820);
        assertEq(sum / jobs, 82);
        (uint64 baseJobs, uint128 baseSum, uint64 sourceBlock, uint256 updatedAt) = mirror.records(AGENT_OWNER, 8453);
        assertEq(baseJobs, 1);
        assertEq(baseSum, 100);
        assertEq(sourceBlock, 100);
        assertEq(updatedAt, 1000);
    }

    function testSnapshotsReplaceInsteadOfAccumulatingAndCanCorrectDownwards() public {
        _write(8453, 100, 10, 900);
        vm.warp(1100);
        _write(8453, 101, 2, 150);
        (uint256 jobs, uint256 sum) = mirror.getTotals(AGENT_OWNER);
        assertEq(jobs, 2);
        assertEq(sum, 150);
        (,, uint64 sourceBlock, uint256 updatedAt) = mirror.records(AGENT_OWNER, 8453);
        assertEq(sourceBlock, 101);
        assertEq(updatedAt, 1100);
        _write(8453, 102, 0, 0);
        (jobs, sum) = mirror.getTotals(AGENT_OWNER);
        assertEq(jobs, 0);
        assertEq(sum, 0);
    }

    function testStaleAndConflictingReplayDoNotChangeDataOrFreshness() public {
        _write(8453, 100, 3, 240);
        vm.warp(2000);
        _write(8453, 99, 10, 1000);
        _write(8453, 100, 10, 1000);
        (uint64 jobs, uint128 sum, uint64 sourceBlock, uint256 updatedAt) = mirror.records(AGENT_OWNER, 8453);
        assertEq(jobs, 3);
        assertEq(sum, 240);
        assertEq(sourceBlock, 100);
        assertEq(updatedAt, 1000);
    }

    function testStaleRecordDoesNotWedgeOtherRecordsInBatch() public {
        _write(8453, 100, 3, 240);
        ReputationMirror.Update[] memory updates = new ReputationMirror.Update[](3);
        updates[0] = _update(8453, 99, 1, 1);
        updates[1] = _update(5042, 10, 4, 360);
        updates[2] = ReputationMirror.Update(address(0xB0B), 8453, 101, 2, 190);
        vm.prank(RELAYER);
        mirror.updateRecords(updates);
        (uint256 jobs, uint256 sum) = mirror.getTotals(AGENT_OWNER);
        assertEq(jobs, 7);
        assertEq(sum, 600);
        (jobs, sum) = mirror.getTotals(address(0xB0B));
        assertEq(jobs, 2);
        assertEq(sum, 190);
    }

    function testInvalidRecordRollsBackEntireBatch() public {
        ReputationMirror.Update[] memory updates = new ReputationMirror.Update[](2);
        updates[0] = _update(8453, 10, 3, 240);
        updates[1] = _update(5042, 10, 1, 101);
        vm.prank(RELAYER);
        vm.expectRevert(ReputationMirror.InvalidRecord.selector);
        mirror.updateRecords(updates);
        (uint256 jobs, uint256 sum) = mirror.getTotals(AGENT_OWNER);
        assertEq(jobs, 0);
        assertEq(sum, 0);
    }

    function testRejectsWrongChainAndMonadSelfMirroring() public {
        vm.prank(RELAYER);
        vm.expectRevert(ReputationMirror.UnsupportedSource.selector);
        mirror.updateRecords(_one(143, 10, 3, 240));
        vm.prank(RELAYER);
        vm.expectRevert(ReputationMirror.UnsupportedSource.selector);
        mirror.updateRecords(_one(5042002, 10, 3, 240));
    }

    function testRejectsZeroOwnerZeroBlockAndNonzeroScoreWithoutJobs() public {
        ReputationMirror.Update[] memory updates = _one(8453, 10, 3, 240);
        updates[0].identityOwner = address(0);
        vm.prank(RELAYER);
        vm.expectRevert(ReputationMirror.InvalidRecord.selector);
        mirror.updateRecords(updates);
        vm.prank(RELAYER);
        vm.expectRevert(ReputationMirror.InvalidRecord.selector);
        mirror.updateRecords(_one(8453, 0, 3, 240));
        vm.prank(RELAYER);
        vm.expectRevert(ReputationMirror.InvalidRecord.selector);
        mirror.updateRecords(_one(8453, 10, 0, 1));
    }

    function testBatchBoundsAndMaximumSize() public {
        vm.prank(RELAYER);
        vm.expectRevert(ReputationMirror.InvalidBatchSize.selector);
        mirror.updateRecords(new ReputationMirror.Update[](0));
        vm.prank(RELAYER);
        vm.expectRevert(ReputationMirror.InvalidBatchSize.selector);
        mirror.updateRecords(new ReputationMirror.Update[](101));
        ReputationMirror.Update[] memory updates = new ReputationMirror.Update[](100);
        for (uint256 i; i < updates.length; ++i) {
            updates[i] = _update(8453, uint64(i + 1), uint64(i + 1), uint128((i + 1) * 100));
        }
        vm.prank(RELAYER);
        mirror.onReport("", abi.encode(updates));
        (uint256 jobs, uint256 sum) = mirror.getTotals(AGENT_OWNER);
        assertEq(jobs, 100);
        assertEq(sum, 10000);
    }

    function testRelayerRotationRevokesBothOldEntryPoints() public {
        address next = address(0x9999);
        vm.prank(SAFE);
        mirror.setRelayer(next);
        vm.prank(RELAYER);
        vm.expectRevert(ReputationMirror.UnauthorizedReporter.selector);
        mirror.updateRecords(_one(8453, 10, 1, 90));
        vm.prank(RELAYER);
        vm.expectRevert(ReputationMirror.UnauthorizedReporter.selector);
        mirror.onReport("", abi.encode(_one(8453, 10, 1, 90)));
        vm.prank(next);
        mirror.updateRecords(_one(8453, 10, 1, 90));
        vm.prank(SAFE);
        mirror.setRelayer(address(0));
        vm.prank(next);
        vm.expectRevert(ReputationMirror.UnauthorizedReporter.selector);
        mirror.updateRecords(_one(8453, 11, 2, 180));
    }

    function testForwarderConfigurationRequiresOwnerAndMatchingEnableState() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        mirror.setForwarder(FORWARDER, WORKFLOW);
        vm.prank(SAFE);
        vm.expectRevert(ReputationMirror.InvalidForwarderConfiguration.selector);
        mirror.setForwarder(FORWARDER, bytes32(0));
        vm.prank(SAFE);
        vm.expectRevert(ReputationMirror.InvalidForwarderConfiguration.selector);
        mirror.setForwarder(address(0), WORKFLOW);
    }

    function testForwarderIsDisabledUntilConfigured() public {
        vm.prank(FORWARDER);
        vm.expectRevert(ReputationMirror.UnauthorizedReporter.selector);
        mirror.onReport(abi.encodePacked(WORKFLOW, bytes10(0), SAFE), abi.encode(_one(8453, 10, 1, 90)));
    }

    function testForwarderReportsSupport62AndProduction64ByteMetadata() public {
        _enableForwarder();
        vm.prank(FORWARDER);
        mirror.onReport(abi.encodePacked(WORKFLOW, bytes10("reputation"), SAFE), abi.encode(_one(8453, 10, 1, 90)));
        vm.prank(FORWARDER);
        mirror.onReport(
            abi.encodePacked(WORKFLOW, bytes10("reputation"), SAFE, bytes2(uint16(1))),
            abi.encode(_one(5042, 10, 2, 170))
        );
        (uint256 jobs, uint256 sum) = mirror.getTotals(AGENT_OWNER);
        assertEq(jobs, 3);
        assertEq(sum, 260);
    }

    function testForwarderCannotUseDirectRelayerFunction() public {
        _enableForwarder();
        vm.prank(FORWARDER);
        vm.expectRevert(ReputationMirror.UnauthorizedReporter.selector);
        mirror.updateRecords(_one(8453, 10, 1, 90));
    }

    function testWrongSenderCannotSpoofWorkflowMetadata() public {
        _enableForwarder();
        vm.expectRevert(ReputationMirror.UnauthorizedReporter.selector);
        mirror.onReport(abi.encodePacked(WORKFLOW, bytes10(0), SAFE), abi.encode(_one(8453, 10, 1, 90)));
    }

    function testForwarderRejectsWrongWorkflowOrMetadataLength() public {
        _enableForwarder();
        vm.prank(FORWARDER);
        vm.expectRevert(ReputationMirror.WrongWorkflow.selector);
        mirror.onReport(abi.encodePacked(bytes32(uint256(1)), bytes10(0), SAFE), abi.encode(_one(8453, 10, 1, 90)));
        vm.prank(FORWARDER);
        vm.expectRevert(ReputationMirror.InvalidMetadata.selector);
        mirror.onReport(abi.encodePacked(WORKFLOW), abi.encode(_one(8453, 10, 1, 90)));
        vm.prank(FORWARDER);
        vm.expectRevert(ReputationMirror.InvalidMetadata.selector);
        mirror.onReport(new bytes(63), abi.encode(_one(8453, 10, 1, 90)));
    }

    function testForwarderRotationAndDisableRevokeAccess() public {
        _enableForwarder();
        vm.prank(SAFE);
        mirror.setForwarder(address(0x9999), WORKFLOW);
        vm.prank(FORWARDER);
        vm.expectRevert(ReputationMirror.UnauthorizedReporter.selector);
        mirror.onReport(abi.encodePacked(WORKFLOW, bytes10(0), SAFE), abi.encode(_one(8453, 10, 1, 90)));
        vm.prank(SAFE);
        mirror.setForwarder(address(0), bytes32(0));
        vm.prank(address(0x9999));
        vm.expectRevert(ReputationMirror.UnauthorizedReporter.selector);
        mirror.onReport(abi.encodePacked(WORKFLOW, bytes10(0), SAFE), abi.encode(_one(8453, 10, 1, 90)));
        // The independent trusted writer remains usable.
        _write(8453, 10, 1, 90);
    }

    function testTrustedSimulationRelayerDoesNotRequireDONMetadata() public {
        _enableForwarder();
        vm.prank(RELAYER);
        mirror.onReport("", abi.encode(_one(8453, 10, 1, 90)));
        (uint256 jobs,) = mirror.getTotals(AGENT_OWNER);
        assertEq(jobs, 1);
    }

    function testReportPayloadBoundBeforeDecoding() public {
        uint256 maxBytes = mirror.MAX_REPORT_BYTES();
        vm.prank(RELAYER);
        vm.expectRevert(ReputationMirror.InvalidBatchSize.selector);
        mirror.onReport("", new bytes(maxBytes + 1));
        vm.prank(RELAYER);
        vm.expectRevert(ReputationMirror.InvalidBatchSize.selector);
        mirror.onReport("", abi.encode(new ReputationMirror.Update[](0)));
        vm.prank(RELAYER);
        vm.expectRevert();
        mirror.onReport("", hex"deadbeef");
    }

    function testReceiverSupportsERC165() public view {
        assertTrue(mirror.supportsInterface(type(IERC165).interfaceId));
        assertTrue(mirror.supportsInterface(type(ICREReceiver).interfaceId));
        assertEq(type(ICREReceiver).interfaceId, ICREReceiver.onReport.selector);
        assertFalse(mirror.supportsInterface(0xffffffff));
    }

    function testOwnershipTransferRequiresAcceptance() public {
        address nextSafe = address(0xCAFE);
        vm.prank(SAFE);
        mirror.transferOwnership(nextSafe);
        assertEq(mirror.owner(), SAFE);
        vm.prank(RELAYER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, RELAYER));
        mirror.acceptOwnership();
        vm.prank(nextSafe);
        mirror.acceptOwnership();
        assertEq(mirror.owner(), nextSafe);
        vm.prank(SAFE);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, SAFE));
        mirror.setRelayer(address(0));
        vm.prank(nextSafe);
        mirror.setRelayer(address(0));
    }

    function testSafeCanRecoverPoisonedBlockWithoutClearingOtherSources() public {
        _write(8453, type(uint64).max, 10, 1000);
        _write(5042, 15, 2, 180);
        vm.prank(RELAYER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, RELAYER));
        mirror.invalidateRecord(AGENT_OWNER, 8453);
        vm.prank(SAFE);
        mirror.invalidateRecord(AGENT_OWNER, 8453);
        (uint256 jobs, uint256 sum) = mirror.getTotals(AGENT_OWNER);
        assertEq(jobs, 2);
        assertEq(sum, 180);
        _write(8453, 100, 3, 240);
        (jobs, sum) = mirror.getTotals(AGENT_OWNER);
        assertEq(jobs, 5);
        assertEq(sum, 420);
    }

    function testFuzzTotalsCannotOverflowAndStayWeighted(
        uint64 baseJobs,
        uint64 arcJobs,
        uint8 baseScore,
        uint8 arcScore
    ) public {
        baseScore = uint8(bound(baseScore, 0, 100));
        arcScore = uint8(bound(arcScore, 0, 100));
        uint128 baseSum = uint128(baseJobs) * baseScore;
        uint128 arcSum = uint128(arcJobs) * arcScore;
        _write(8453, 10, baseJobs, baseSum);
        _write(5042, 10, arcJobs, arcSum);
        (uint256 jobs, uint256 sum) = mirror.getTotals(AGENT_OWNER);
        assertEq(jobs, uint256(baseJobs) + uint256(arcJobs));
        assertEq(sum, uint256(baseSum) + uint256(arcSum));
        assertLe(sum, jobs * 100);
    }
}
