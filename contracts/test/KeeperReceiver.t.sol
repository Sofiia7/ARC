// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Test.sol";
import {KeeperReceiver} from "../src/monad/KeeperReceiver.sol";
import {ICREReceiver} from "../src/monad/interfaces/ICREReceiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract KeeperTargetHarness {
    mapping(uint256 => uint8) public modes;
    mapping(uint256 => uint256) public calls;
    mapping(uint256 => bytes4) public selectors;
    KeeperReceiver public receiver;
    bytes public callbackReason;
    error TargetFailure(uint256 jobId);

    function setMode(uint256 jobId, uint8 mode) external {
        modes[jobId] = mode;
    }

    function setReceiver(KeeperReceiver next) external {
        receiver = next;
    }

    fallback() external {
        uint256 job;
        assembly ("memory-safe") { job := calldataload(4) }
        uint8 mode = modes[job];
        if (mode == 1) revert TargetFailure(job);
        if (mode == 2) assembly { invalid() }
        if (mode == 3) {
            // Huge revert data stays in the target's gas budget.
            assembly {
                mstore(0, shl(224, 0xdecafbad))
                revert(0, 1000000)
            }
        }
        if (mode == 4) assembly { return(0, 1000000) }
        if (mode == 5) {
            KeeperReceiver.Action[] memory actions = new KeeperReceiver.Action[](1);
            actions[0] = KeeperReceiver.Action(0, 99);
            try receiver.execute(actions) {}
            catch (bytes memory reason) {
                callbackReason = reason;
            }
        }
        if (mode == 6) {
            assembly ("memory-safe") {
                mstore(0, 1)
                revert(0, 1)
            }
        }
        if (mode == 7) assembly ("memory-safe") { revert(0, 0) }
        ++calls[job];
        selectors[job] = msg.sig;
    }
}

contract KeeperReceiverTest is Test {
    KeeperReceiver internal receiver;
    KeeperTargetHarness internal target;
    address internal constant SAFE = address(0x5AFE);
    address internal constant NEXT_SAFE = address(0x5AF2);
    address internal constant RELAYER = address(0x1234);
    address internal constant NEXT_RELAYER = address(0x1235);
    address internal constant FORWARDER = address(0x5678);
    bytes32 internal constant WORKFLOW = keccak256("nadbounty-keeper");

    function setUp() public {
        target = new KeeperTargetHarness();
        receiver = new KeeperReceiver(SAFE, RELAYER, address(target), KeeperReceiver.AdapterKind.MonadV48);
    }

    function _one(uint8 kind, uint256 job) internal pure returns (KeeperReceiver.Action[] memory actions) {
        actions = new KeeperReceiver.Action[](1);
        actions[0] = KeeperReceiver.Action(kind, job);
    }

    function _run(KeeperReceiver.Action[] memory actions) internal returns (uint256 successes, uint256 failures) {
        vm.prank(RELAYER);
        return receiver.execute(actions);
    }

    function _metadata(uint256 size, bytes32 workflow) internal pure returns (bytes memory result) {
        result = new bytes(size);
        assembly ("memory-safe") { mstore(add(result, 32), workflow) }
    }

    function _enableForwarder() internal {
        vm.prank(SAFE);
        receiver.setForwarder(FORWARDER, WORKFLOW);
    }

    function _assertResultLog(Vm.Log memory entry, uint256 index, uint8 kind, uint256 job, bool success, bytes4 reason)
        internal
        view
    {
        assertEq(entry.emitter, address(receiver));
        assertEq(entry.topics[0], keccak256("ActionExecuted(uint256,uint8,uint256,bool,bytes4)"));
        assertEq(uint256(entry.topics[1]), index);
        assertEq(uint256(entry.topics[2]), kind);
        assertEq(uint256(entry.topics[3]), job);
        (bool loggedSuccess, bytes4 loggedReason) = abi.decode(entry.data, (bool, bytes4));
        assertEq(loggedSuccess, success);
        assertEq(loggedReason, reason);
    }

    function testDeploymentPinsTargetKindAndSafeAndDisablesForwarder() public view {
        assertEq(receiver.adapter(), address(target));
        assertEq(uint8(receiver.adapterKind()), 1);
        assertEq(receiver.owner(), SAFE);
        assertEq(receiver.relayer(), RELAYER);
        assertEq(receiver.forwarder(), address(0));
        assertEq(receiver.workflowId(), bytes32(0));
    }

    function testRejectsZeroOwnerAndNonContractTargets() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new KeeperReceiver(address(0), RELAYER, address(target), KeeperReceiver.AdapterKind.MonadV48);
        vm.expectRevert(KeeperReceiver.InvalidAdapter.selector);
        new KeeperReceiver(SAFE, RELAYER, address(0), KeeperReceiver.AdapterKind.MonadV48);
        vm.expectRevert(KeeperReceiver.InvalidAdapter.selector);
        new KeeperReceiver(SAFE, RELAYER, RELAYER, KeeperReceiver.AdapterKind.MonadV48);
    }

    function testDeployerAndSafeHaveNoImplicitExecutionRole() public {
        vm.expectRevert(KeeperReceiver.UnauthorizedReporter.selector);
        receiver.execute(_one(0, 1));
        vm.prank(SAFE);
        vm.expectRevert(KeeperReceiver.UnauthorizedReporter.selector);
        receiver.execute(_one(0, 1));
        vm.expectRevert(KeeperReceiver.UnauthorizedReporter.selector);
        receiver.onReport("", abi.encode(_one(0, 1)));
    }

    function testOnlySafeCanConfigure() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        receiver.setRelayer(address(this));
        vm.prank(RELAYER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, RELAYER));
        receiver.setForwarder(FORWARDER, WORKFLOW);
    }

    function testOwnershipUsesTwoStepHandoff() public {
        vm.prank(SAFE);
        receiver.transferOwnership(NEXT_SAFE);
        assertEq(receiver.owner(), SAFE);
        assertEq(receiver.pendingOwner(), NEXT_SAFE);
        vm.prank(NEXT_SAFE);
        receiver.acceptOwnership();
        vm.prank(SAFE);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, SAFE));
        receiver.setRelayer(NEXT_RELAYER);
        vm.prank(NEXT_SAFE);
        receiver.setRelayer(NEXT_RELAYER);
        assertEq(receiver.relayer(), NEXT_RELAYER);
    }

    function testRelayerRotationAndRevocationApplyToBothEntrypoints() public {
        vm.prank(SAFE);
        receiver.setRelayer(NEXT_RELAYER);
        vm.expectRevert(KeeperReceiver.UnauthorizedReporter.selector);
        _run(_one(0, 1));
        vm.prank(RELAYER);
        vm.expectRevert(KeeperReceiver.UnauthorizedReporter.selector);
        receiver.onReport("", abi.encode(_one(0, 1)));
        vm.prank(NEXT_RELAYER);
        receiver.execute(_one(0, 1));
        vm.prank(SAFE);
        receiver.setRelayer(address(0));
        vm.prank(NEXT_RELAYER);
        vm.expectRevert(KeeperReceiver.UnauthorizedReporter.selector);
        receiver.execute(_one(0, 2));
        vm.prank(NEXT_RELAYER);
        vm.expectRevert(KeeperReceiver.UnauthorizedReporter.selector);
        receiver.onReport("", abi.encode(_one(0, 2)));
        assertEq(target.calls(1), 1);
        assertEq(target.calls(2), 0);
    }

    function testZeroRelayerDeploymentCanBeEnabledBySafe() public {
        KeeperReceiver disabled =
            new KeeperReceiver(SAFE, address(0), address(target), KeeperReceiver.AdapterKind.MonadV48);
        vm.prank(RELAYER);
        vm.expectRevert(KeeperReceiver.UnauthorizedReporter.selector);
        disabled.execute(_one(0, 1));
        vm.prank(SAFE);
        disabled.setRelayer(RELAYER);
        vm.prank(RELAYER);
        disabled.execute(_one(0, 1));
        assertEq(target.calls(1), 1);
    }

    function testRelayerSimulationOnReportDoesNotClaimDonMetadataAuth() public {
        vm.prank(RELAYER);
        receiver.onReport("untrusted simulation metadata", abi.encode(_one(0, 1)));
        assertEq(target.calls(1), 1);
    }

    function testForwarderConfigurationRequiresPairedAddressAndWorkflow() public {
        vm.prank(SAFE);
        vm.expectRevert(KeeperReceiver.InvalidForwarderConfiguration.selector);
        receiver.setForwarder(FORWARDER, bytes32(0));
        vm.prank(SAFE);
        vm.expectRevert(KeeperReceiver.InvalidForwarderConfiguration.selector);
        receiver.setForwarder(address(0), WORKFLOW);
        _enableForwarder();
        vm.prank(SAFE);
        receiver.setForwarder(address(0), bytes32(0));
        vm.prank(FORWARDER);
        vm.expectRevert(KeeperReceiver.UnauthorizedReporter.selector);
        receiver.onReport(_metadata(64, WORKFLOW), abi.encode(_one(0, 1)));
    }

    function testForwarderAccepts62And64BytesAndNeedsCorrectWorkflow() public {
        _enableForwarder();
        vm.prank(FORWARDER);
        receiver.onReport(_metadata(62, WORKFLOW), abi.encode(_one(0, 1)));
        vm.prank(FORWARDER);
        receiver.onReport(_metadata(64, WORKFLOW), abi.encode(_one(0, 2)));
        vm.prank(FORWARDER);
        vm.expectRevert(KeeperReceiver.WrongWorkflow.selector);
        receiver.onReport(_metadata(64, keccak256("wrong")), abi.encode(_one(0, 3)));
        assertEq(target.calls(1), 1);
        assertEq(target.calls(2), 1);
        assertEq(target.calls(3), 0);
    }

    function testForwarderRejectsMalformedMetadataAndCannotDirectExecute() public {
        _enableForwarder();
        uint256[5] memory sizes = [uint256(0), 31, 32, 63, 65];
        for (uint256 i; i < sizes.length; ++i) {
            vm.prank(FORWARDER);
            vm.expectRevert(KeeperReceiver.InvalidMetadata.selector);
            receiver.onReport(_metadata(sizes[i], WORKFLOW), abi.encode(_one(0, 1)));
        }
        vm.prank(FORWARDER);
        vm.expectRevert(KeeperReceiver.UnauthorizedReporter.selector);
        receiver.execute(_one(0, 1));
    }

    function testDisabledRelayerDoesNotDisableAuthorizedForwarder() public {
        _enableForwarder();
        vm.prank(SAFE);
        receiver.setRelayer(address(0));
        vm.prank(FORWARDER);
        receiver.onReport(_metadata(64, WORKFLOW), abi.encode(_one(0, 1)));
        assertEq(target.calls(1), 1);
    }

    function testRejectsUnknownReporterEvenWithValidMetadata() public {
        _enableForwarder();
        vm.expectRevert(KeeperReceiver.UnauthorizedReporter.selector);
        receiver.onReport(_metadata(64, WORKFLOW), abi.encode(_one(0, 1)));
    }

    function testSupportsReceiverAndErc165Only() public view {
        assertTrue(receiver.supportsInterface(type(ICREReceiver).interfaceId));
        assertTrue(receiver.supportsInterface(type(IERC165).interfaceId));
        assertFalse(receiver.supportsInterface(0xffffffff));
    }

    function testRejectsEmptyOversizedAndMalformedReportsBeforeAnyAction() public {
        KeeperReceiver.Action[] memory empty = new KeeperReceiver.Action[](0);
        vm.expectRevert(KeeperReceiver.InvalidBatchSize.selector);
        _run(empty);
        vm.prank(RELAYER);
        vm.expectRevert(KeeperReceiver.InvalidBatchSize.selector);
        receiver.onReport("", abi.encode(empty));
        KeeperReceiver.Action[] memory tooMany = new KeeperReceiver.Action[](11);
        vm.expectRevert(KeeperReceiver.InvalidBatchSize.selector);
        _run(tooMany);
        vm.prank(RELAYER);
        vm.expectRevert(KeeperReceiver.InvalidBatchSize.selector);
        receiver.onReport("", abi.encode(tooMany));
        vm.prank(RELAYER);
        vm.expectRevert(KeeperReceiver.InvalidBatchSize.selector);
        receiver.onReport("", new bytes(705));
        vm.prank(RELAYER);
        vm.expectRevert();
        receiver.onReport("", hex"0102");
        assertEq(target.calls(0), 0);
    }

    function testAllTenActionsUseOnlyPinnedTargetAndExpectedSelectors() public {
        string[10] memory names = [
            "autoApprove(uint256)",
            "expireBounty(uint256)",
            "finalizeRejection(uint256)",
            "claimDefaultRuling(uint256)",
            "claimArbitratorTimeout(uint256)",
            "reconcileExpiredEscrow(uint256)",
            "settleContestSilence(uint256)",
            "finalizeContestRejection(uint256)",
            "claimContestDefault(uint256)",
            "claimContestArbitratorTimeout(uint256)"
        ];
        KeeperReceiver.Action[] memory actions = new KeeperReceiver.Action[](10);
        for (uint8 i; i < 10; ++i) {
            actions[i] = KeeperReceiver.Action(i, uint256(i) + 1);
        }
        (uint256 successes, uint256 failures) = _run(actions);
        assertEq(successes, 10);
        assertEq(failures, 0);
        for (uint8 i; i < 10; ++i) {
            assertEq(target.calls(uint256(i) + 1), 1);
            assertEq(target.selectors(uint256(i) + 1), bytes4(keccak256(bytes(names[i]))));
        }
    }

    function testMaximumEncodedReportFitsExactByteBound() public {
        KeeperReceiver.Action[] memory actions = new KeeperReceiver.Action[](10);
        for (uint256 i; i < 10; ++i) {
            actions[i] = KeeperReceiver.Action(0, i + 1);
        }
        bytes memory report = abi.encode(actions);
        assertEq(report.length, receiver.MAX_REPORT_BYTES());
        vm.prank(RELAYER);
        receiver.onReport("", report);
        for (uint256 i; i < 10; ++i) {
            assertEq(target.calls(i + 1), 1);
        }
    }

    function testBaseReceiverRejectsAllContestActionsIndependently() public {
        receiver = new KeeperReceiver(SAFE, RELAYER, address(target), KeeperReceiver.AdapterKind.BaseV47);
        KeeperReceiver.Action[] memory actions = new KeeperReceiver.Action[](10);
        for (uint8 i; i < 10; ++i) {
            actions[i] = KeeperReceiver.Action(i, uint256(i) + 1);
        }
        (uint256 successes, uint256 failures) = _run(actions);
        assertEq(successes, 6);
        assertEq(failures, 4);
        for (uint8 i; i < 10; ++i) {
            assertEq(target.calls(uint256(i) + 1), i < 6 ? 1 : 0);
        }
    }

    function testUnknownActionFailsWithoutWedgingValidNeighbor() public {
        KeeperReceiver.Action[] memory actions = new KeeperReceiver.Action[](2);
        actions[0] = KeeperReceiver.Action(255, 1);
        actions[1] = KeeperReceiver.Action(0, 2);
        vm.recordLogs();
        (uint256 successes, uint256 failures) = _run(actions);
        assertEq(successes, 1);
        assertEq(failures, 1);
        assertEq(target.calls(1), 0);
        assertEq(target.calls(2), 1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        _assertResultLog(logs[0], 0, 255, 1, false, KeeperReceiver.UnsupportedAction.selector);
        _assertResultLog(logs[1], 1, 0, 2, true, bytes4(0));
    }

    function testReportedFailureSelectorAndJobPreserveNeighbors() public {
        KeeperReceiver.Action[] memory actions = new KeeperReceiver.Action[](3);
        actions[0] = KeeperReceiver.Action(0, 1);
        actions[1] = KeeperReceiver.Action(0, 2);
        actions[2] = KeeperReceiver.Action(0, 3);
        target.setMode(2, 1);
        vm.recordLogs();
        (uint256 successes, uint256 failures) = _run(actions);
        assertEq(successes, 2);
        assertEq(failures, 1);
        assertEq(target.calls(1), 1);
        assertEq(target.calls(2), 0);
        assertEq(target.calls(3), 1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        _assertResultLog(logs[1], 1, 0, 2, false, KeeperTargetHarness.TargetFailure.selector);
    }

    function testOneGasExhaustingTargetCannotConsumeNextActionsBudget() public {
        target.setMode(1, 2);
        KeeperReceiver.Action[] memory actions = new KeeperReceiver.Action[](2);
        actions[0] = KeeperReceiver.Action(0, 1);
        actions[1] = KeeperReceiver.Action(0, 2);
        vm.prank(RELAYER);
        (bool ok, bytes memory data) =
            address(receiver).call{gas: 12_000_000}(abi.encodeCall(receiver.execute, (actions)));
        assertTrue(ok);
        (uint256 successes, uint256 failures) = abi.decode(data, (uint256, uint256));
        assertEq(successes, 1);
        assertEq(failures, 1);
        assertEq(target.calls(2), 1);
    }

    function testGasReserveReportsEveryRemainingActionAfterBudgetExhaustion() public {
        target.setMode(1, 2);
        KeeperReceiver.Action[] memory actions = new KeeperReceiver.Action[](10);
        for (uint256 i; i < 10; ++i) {
            actions[i] = KeeperReceiver.Action(0, i + 1);
        }
        vm.recordLogs();
        vm.prank(RELAYER);
        (bool ok, bytes memory data) =
            address(receiver).call{gas: 6_000_000}(abi.encodeCall(receiver.execute, (actions)));
        assertTrue(ok);
        (uint256 successes, uint256 failures) = abi.decode(data, (uint256, uint256));
        assertEq(successes, 0);
        assertEq(failures, 10);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 11);
        _assertResultLog(logs[0], 0, 0, 1, false, 0);
        for (uint256 i = 1; i < 10; ++i) {
            _assertResultLog(logs[i], i, 0, i + 1, false, KeeperReceiver.InsufficientExecutionGas.selector);
            assertEq(target.calls(i + 1), 0);
        }
    }

    function testHugeRevertAndSuccessDataDoNotCopyIntoReceiverMemory() public {
        target.setMode(1, 3);
        target.setMode(2, 4);
        KeeperReceiver.Action[] memory actions = new KeeperReceiver.Action[](3);
        actions[0] = KeeperReceiver.Action(0, 1);
        actions[1] = KeeperReceiver.Action(0, 2);
        actions[2] = KeeperReceiver.Action(0, 3);
        vm.recordLogs();
        (uint256 successes, uint256 failures) = _run(actions);
        assertEq(successes, 2);
        assertEq(failures, 1);
        assertEq(target.calls(3), 1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        _assertResultLog(logs[0], 0, 0, 1, false, 0xdecafbad);
    }

    function testShortAndEmptyRevertDataAreRecordedWithoutDecodeFailure() public {
        target.setMode(1, 6);
        target.setMode(2, 7);
        KeeperReceiver.Action[] memory actions = new KeeperReceiver.Action[](3);
        for (uint256 i; i < 3; ++i) {
            actions[i] = KeeperReceiver.Action(0, i + 1);
        }
        vm.recordLogs();
        (uint256 successes, uint256 failures) = _run(actions);
        assertEq(successes, 1);
        assertEq(failures, 2);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        _assertResultLog(logs[0], 0, 0, 1, false, 0);
        _assertResultLog(logs[1], 1, 0, 2, false, 0);
    }

    function testInsufficientGasIsReportedWithoutAttemptingTarget() public {
        vm.recordLogs();
        vm.prank(RELAYER);
        (bool ok, bytes memory data) =
            address(receiver).call{gas: 200_000}(abi.encodeCall(receiver.execute, (_one(0, 1))));
        assertTrue(ok);
        (uint256 successes, uint256 failures) = abi.decode(data, (uint256, uint256));
        assertEq(successes, 0);
        assertEq(failures, 1);
        assertEq(target.calls(1), 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        _assertResultLog(logs[0], 0, 0, 1, false, KeeperReceiver.InsufficientExecutionGas.selector);
    }

    function testCallbacksCannotReenterBatchEvenWhenTargetIsAuthorizedRelayer() public {
        target.setReceiver(receiver);
        target.setMode(1, 5);
        vm.prank(SAFE);
        receiver.setRelayer(address(target));
        vm.prank(address(target));
        receiver.execute(_one(0, 1));
        assertEq(target.calls(1), 1);
        assertEq(target.calls(99), 0);
        assertEq(target.callbackReason(), abi.encodeWithSelector(bytes4(keccak256("ReentrancyGuardReentrantCall()"))));
    }

    function testFuzzUnknownKindsCannotBecomePrivilegedSelectors(uint8 kind) public {
        kind = uint8(bound(kind, 10, 255));
        (uint256 successes, uint256 failures) = _run(_one(kind, 1));
        assertEq(successes, 0);
        assertEq(failures, 1);
        assertEq(target.calls(1), 0);
    }
}
