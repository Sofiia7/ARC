// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ICREReceiver} from "./interfaces/ICREReceiver.sol";

/// @title Typed permissionless settlement runner for NadBounty / BaseBounty
/// @notice One immutable adapter per receiver. No arbitrary target, calldata,
///         approvals, poster actions or arbitrator authority are exposed.
/// @dev Local simulate --broadcast reports trust the configured relayer, as
///      ReputationMirror does. DON reports require the configured forwarder.
contract KeeperReceiver is Ownable2Step, ERC165, ReentrancyGuard, ICREReceiver {
    enum AdapterKind {
        BaseV47,
        MonadV48
    }
    enum ActionKind {
        AutoApprove,
        ExpireBounty,
        FinalizeRejection,
        DefaultRuling,
        ArbitratorTimeout,
        ReconcileExpiredEscrow,
        ContestSilence,
        ContestFinalizeRejection,
        ContestDefault,
        ContestArbitratorTimeout
    }

    struct Action {
        // Raw uint8 lets an unsupported action fail independently of its batch.
        uint8 kind;
        uint256 jobId;
    }

    uint256 public constant MAX_BATCH_SIZE = 10;
    uint256 public constant MAX_REPORT_BYTES = 64 + MAX_BATCH_SIZE * 64;
    uint256 public constant ACTION_GAS_LIMIT = 5_000_000;
    uint256 public constant POST_CALL_GAS_RESERVE = 100_000;
    address public immutable adapter;
    AdapterKind public immutable adapterKind;
    address public relayer;
    address public forwarder;
    bytes32 public workflowId;

    error InvalidAdapter();
    error UnauthorizedReporter();
    error InvalidForwarderConfiguration();
    error InvalidMetadata();
    error WrongWorkflow();
    error InvalidBatchSize();
    error UnsupportedAction();
    error InsufficientExecutionGas();

    event RelayerUpdated(address indexed previous, address indexed next);
    event ForwarderUpdated(address indexed forwarder, bytes32 indexed workflowId);
    event ActionExecuted(
        uint256 indexed index, uint8 indexed kind, uint256 indexed jobId, bool success, bytes4 errorSelector
    );
    event BatchExecuted(uint256 successes, uint256 failures);

    constructor(address initialOwner, address initialRelayer, address target, AdapterKind kind) Ownable(initialOwner) {
        if (target.code.length == 0) revert InvalidAdapter();
        adapter = target;
        adapterKind = kind;
        // Zero intentionally deploys with the trusted runner disabled.
        // slither-disable-next-line missing-zero-check
        relayer = initialRelayer;
        emit RelayerUpdated(address(0), initialRelayer);
    }

    function setRelayer(address next) external onlyOwner {
        emit RelayerUpdated(relayer, next);
        // Zero is the supported revocation mechanism.
        // slither-disable-next-line missing-zero-check
        relayer = next;
    }

    function setForwarder(address next, bytes32 nextWorkflowId) external onlyOwner {
        if ((next == address(0)) != (nextWorkflowId == bytes32(0))) revert InvalidForwarderConfiguration();
        forwarder = next;
        workflowId = nextWorkflowId;
        emit ForwarderUpdated(next, nextWorkflowId);
    }

    function execute(Action[] calldata actions) external nonReentrant returns (uint256 successes, uint256 failures) {
        if (relayer == address(0) || msg.sender != relayer) revert UnauthorizedReporter();
        if (actions.length == 0 || actions.length > MAX_BATCH_SIZE) revert InvalidBatchSize();
        return _process(actions);
    }

    /// @notice Report is abi.encode(Action[]), with no target or raw calldata.
    function onReport(bytes calldata metadata, bytes calldata report) external override nonReentrant {
        if (relayer == address(0) || msg.sender != relayer) {
            if (forwarder == address(0) || msg.sender != forwarder) revert UnauthorizedReporter();
            if (metadata.length != 62 && metadata.length != 64) revert InvalidMetadata();
            if (bytes32(metadata[:32]) != workflowId) revert WrongWorkflow();
        }
        if (report.length > MAX_REPORT_BYTES) revert InvalidBatchSize();
        _process(abi.decode(report, (Action[])));
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC165, IERC165) returns (bool) {
        return interfaceId == type(ICREReceiver).interfaceId || super.supportsInterface(interfaceId);
    }

    function _process(Action[] memory actions) internal returns (uint256 successes, uint256 failures) {
        if (actions.length == 0 || actions.length > MAX_BATCH_SIZE) revert InvalidBatchSize();
        for (uint256 i; i < actions.length; ++i) {
            Action memory action = actions[i];
            bytes4 selector = _selector(action.kind);
            bool success = false;
            bytes4 reason = UnsupportedAction.selector;
            if (selector != bytes4(0)) {
                // EIP-150 overhead plus a reserve sufficient to report all ten
                // results even if this target consumes its entire call budget.
                if (gasleft() < ACTION_GAS_LIMIT + ACTION_GAS_LIMIT / 63 + POST_CALL_GAS_RESERVE) {
                    reason = InsufficientExecutionGas.selector;
                } else {
                    (success, reason) = _callAdapter(abi.encodeWithSelector(selector, action.jobId));
                }
            }
            if (success) ++successes;
            else ++failures;
            emit ActionExecuted(i, action.kind, action.jobId, success, reason);
        }
        emit BatchExecuted(successes, failures);
    }

    /// @dev Fixed gas and at most four copied return bytes avoid return-data
    ///      bombs. Successful permissionless adapter methods return no value.
    function _callAdapter(bytes memory data) internal returns (bool success, bytes4 reason) {
        address target = adapter;
        uint256 gasLimit = ACTION_GAS_LIMIT;
        assembly ("memory-safe") {
            success := call(gasLimit, target, 0, add(data, 32), mload(data), 0, 0)
            if iszero(success) {
                if gt(returndatasize(), 3) {
                    returndatacopy(0, 0, 4)
                    reason := mload(0)
                }
            }
        }
    }

    function _selector(uint8 kind) internal view returns (bytes4) {
        if (kind == uint8(ActionKind.AutoApprove)) return bytes4(keccak256("autoApprove(uint256)"));
        if (kind == uint8(ActionKind.ExpireBounty)) return bytes4(keccak256("expireBounty(uint256)"));
        if (kind == uint8(ActionKind.FinalizeRejection)) return bytes4(keccak256("finalizeRejection(uint256)"));
        if (kind == uint8(ActionKind.DefaultRuling)) return bytes4(keccak256("claimDefaultRuling(uint256)"));
        if (kind == uint8(ActionKind.ArbitratorTimeout)) return bytes4(keccak256("claimArbitratorTimeout(uint256)"));
        if (kind == uint8(ActionKind.ReconcileExpiredEscrow)) {
            return bytes4(keccak256("reconcileExpiredEscrow(uint256)"));
        }
        if (adapterKind == AdapterKind.BaseV47) return bytes4(0);
        if (kind == uint8(ActionKind.ContestSilence)) return bytes4(keccak256("settleContestSilence(uint256)"));
        if (kind == uint8(ActionKind.ContestFinalizeRejection)) {
            return bytes4(keccak256("finalizeContestRejection(uint256)"));
        }
        if (kind == uint8(ActionKind.ContestDefault)) return bytes4(keccak256("claimContestDefault(uint256)"));
        if (kind == uint8(ActionKind.ContestArbitratorTimeout)) {
            return bytes4(keccak256("claimContestArbitratorTimeout(uint256)"));
        }
        return bytes4(0);
    }
}
