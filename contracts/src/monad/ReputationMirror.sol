// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ICREReceiver} from "./interfaces/ICREReceiver.sol";

/// @title NadBounty's cross-chain paid-job reputation snapshots
/// @notice Both Base and Arc data are trusted relayer data until the configured
///         CRE forwarder/workflow is used. Source blocks are provenance, not proofs.
/// @dev No funds, external calls or adapter permissions are held by this contract.
contract ReputationMirror is Ownable2Step, ERC165, ICREReceiver {
    uint256 public constant BASE_CHAIN_ID = 8453;
    uint256 public constant ARC_CHAIN_ID = 5042;
    uint256 public constant MAX_BATCH_SIZE = 100;
    // Dynamic-array ABI header (offset + length) and five words per Update.
    uint256 public constant MAX_REPORT_BYTES = 64 + MAX_BATCH_SIZE * 160;

    struct Record {
        uint64 paidJobs;
        uint128 scoreSum;
        uint64 sourceBlock;
        uint256 updatedAt;
    }

    struct Update {
        address identityOwner;
        uint256 sourceChain;
        uint64 sourceBlock;
        uint64 paidJobs;
        uint128 scoreSum;
    }

    address public relayer;
    address public forwarder;
    bytes32 public workflowId;
    mapping(address identityOwner => mapping(uint256 sourceChain => Record)) public records;

    error UnauthorizedReporter();
    error InvalidForwarderConfiguration();
    error InvalidMetadata();
    error WrongWorkflow();
    error InvalidBatchSize();
    error UnsupportedSource();
    error InvalidRecord();

    event RelayerUpdated(address indexed previous, address indexed next);
    event ForwarderUpdated(address indexed forwarder, bytes32 indexed workflowId);
    event ReputationUpdated(
        address indexed identityOwner,
        uint256 indexed sourceChain,
        uint64 sourceBlock,
        uint64 paidJobs,
        uint128 scoreSum
    );
    event StaleRecordIgnored(address indexed identityOwner, uint256 indexed sourceChain, uint64 sourceBlock);
    event RecordInvalidated(address indexed identityOwner, uint256 indexed sourceChain, uint64 previousSourceBlock);

    /// @param initialOwner Safe governance address; deployer has no implicit role.
    /// @param initialRelayer Trusted simulation/broadcast writer, or zero to disable.
    constructor(address initialOwner, address initialRelayer) Ownable(initialOwner) {
        // Zero intentionally deploys without a trusted writer.
        // slither-disable-next-line missing-zero-check
        relayer = initialRelayer;
        emit RelayerUpdated(address(0), initialRelayer);
    }

    /// @notice Zero disables the relayer, including its onReport simulation path.
    function setRelayer(address next) external onlyOwner {
        emit RelayerUpdated(relayer, next);
        // Zero is the supported revocation mechanism, not an invalid payee.
        // slither-disable-next-line missing-zero-check
        relayer = next;
    }

    /// @notice Set both to zero to disable DON reports, or both nonzero to enable.
    /// @dev Governance must check the production forwarder's deployed code.
    function setForwarder(address next, bytes32 nextWorkflowId) external onlyOwner {
        if ((next == address(0)) != (nextWorkflowId == bytes32(0))) revert InvalidForwarderConfiguration();
        forwarder = next;
        workflowId = nextWorkflowId;
        emit ForwarderUpdated(next, nextWorkflowId);
    }

    /// @notice Recover a poisoned snapshot after disabling/replacing its reporter.
    /// @dev A compromised relayer could otherwise set sourceBlock to uint64.max
    ///      and permanently prevent corrections, even after its access is revoked.
    ///      Clear only this owner/source; governance must then request a fresh sync.
    function invalidateRecord(address identityOwner, uint256 sourceChain) external onlyOwner {
        if (sourceChain != BASE_CHAIN_ID && sourceChain != ARC_CHAIN_ID) revert UnsupportedSource();
        if (identityOwner == address(0)) revert InvalidRecord();
        uint64 previousSourceBlock = records[identityOwner][sourceChain].sourceBlock;
        delete records[identityOwner][sourceChain];
        emit RecordInvalidated(identityOwner, sourceChain, previousSourceBlock);
    }

    function updateRecords(Update[] calldata updates) external {
        if (msg.sender != relayer || relayer == address(0)) revert UnauthorizedReporter();
        if (updates.length == 0 || updates.length > MAX_BATCH_SIZE) revert InvalidBatchSize();
        _apply(updates);
    }

    /// @notice CRE report payload is abi.encode(Update[]).
    /// @dev Local simulate --broadcast uses the configured relayer as sender;
    ///      its metadata is untrusted and conveys no DON verification guarantee.
    ///      Other senders must be the enabled forwarder with the expected workflow.
    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != relayer || relayer == address(0)) {
            if (forwarder == address(0) || msg.sender != forwarder) revert UnauthorizedReporter();
            // Production delivers 64 bytes; some simulation tooling uses 62.
            if (metadata.length != 62 && metadata.length != 64) revert InvalidMetadata();
            if (bytes32(metadata[:32]) != workflowId) revert WrongWorkflow();
        }
        if (report.length > MAX_REPORT_BYTES) revert InvalidBatchSize();
        Update[] memory updates = abi.decode(report, (Update[]));
        _apply(updates);
    }

    /// @notice Sum snapshots before dividing; never add rounded source averages.
    function getTotals(address identityOwner) public view returns (uint256 paidJobs, uint256 scoreSum) {
        Record storage base = records[identityOwner][BASE_CHAIN_ID];
        Record storage arc = records[identityOwner][ARC_CHAIN_ID];
        paidJobs = uint256(base.paidJobs) + uint256(arc.paidJobs);
        scoreSum = uint256(base.scoreSum) + uint256(arc.scoreSum);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC165, IERC165) returns (bool) {
        return interfaceId == type(ICREReceiver).interfaceId || super.supportsInterface(interfaceId);
    }

    function _apply(Update[] memory updates) internal {
        uint256 length = updates.length;
        if (length == 0 || length > MAX_BATCH_SIZE) revert InvalidBatchSize();
        for (uint256 i; i < length; ++i) {
            Update memory u = updates[i];
            if (u.sourceChain != BASE_CHAIN_ID && u.sourceChain != ARC_CHAIN_ID) revert UnsupportedSource();
            if (u.identityOwner == address(0) || u.sourceBlock == 0 || uint256(u.scoreSum) > uint256(u.paidJobs) * 100) revert InvalidRecord();
            Record storage previous = records[u.identityOwner][u.sourceChain];
            // Idempotent overlapping cron/manual batches, without rollback.
            if (u.sourceBlock <= previous.sourceBlock) {
                emit StaleRecordIgnored(u.identityOwner, u.sourceChain, u.sourceBlock);
                continue;
            }
            records[u.identityOwner][u.sourceChain] = Record(u.paidJobs, u.scoreSum, u.sourceBlock, block.timestamp);
            emit ReputationUpdated(u.identityOwner, u.sourceChain, u.sourceBlock, u.paidJobs, u.scoreSum);
        }
    }
}
