// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Minimal interface for Arc ERC-8183 AgenticCommerce contract
/// @dev Based on Arc documentation — verify against deployed contract before mainnet
interface IAgenticCommerce {
    enum JobStatus { OPEN, ASSIGNED, FUNDED, SUBMITTED, COMPLETED, EXPIRED, REJECTED }

    struct Job {
        address poster;
        address provider;
        address evaluator;
        uint256 deadline;
        JobStatus status;
        bytes32 deliverable;
    }

    function createJob(
        address provider,
        address evaluator,
        uint256 deadline,
        string calldata description,
        address hook
    ) external returns (uint256 jobId);

    function setBudget(
        uint256 jobId,
        uint256 amount,
        bytes calldata data
    ) external;

    function fund(
        uint256 jobId,
        bytes calldata data
    ) external;

    function submit(
        uint256 jobId,
        bytes32 deliverable,
        bytes calldata data
    ) external;

    function complete(
        uint256 jobId,
        bytes32 reason,
        bytes calldata data
    ) external;

    function refund(
        uint256 jobId,
        bytes calldata data
    ) external;

    function expire(
        uint256 jobId,
        bytes calldata data
    ) external;

    function getJob(uint256 jobId) external view returns (Job memory);
}
