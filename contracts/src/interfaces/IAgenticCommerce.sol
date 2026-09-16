// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @dev Mirrors the real deployed AgenticCommerce.sol exactly (enum order,
///      Job struct shape, function set) - see contracts/src/base/AgenticCommerce.sol.
///      A prior version of this interface declared a fictional ASSIGNED enum
///      value, a Job struct that didn't match on-chain storage, and refund()/
///      expire() functions that don't exist on the real contract (it exposes
///      claimRefund(uint256) instead). BountyAdapter never called getJob/
///      refund/expire through this interface before the fix (V4.7's
///      reconcileExpiredEscrow is the first caller of getJob), so the mismatch
///      was dead surface, not a live bug - but it had to be fixed before
///      anything could rely on it.
interface IAgenticCommerce {
    enum JobStatus {
        Open,
        Funded,
        Submitted,
        Completed,
        Rejected,
        Expired
    }

    struct Job {
        uint256 id;
        address client;
        address provider;
        address evaluator;
        string description;
        uint256 budget;
        uint256 expiredAt;
        JobStatus status;
        address hook;
    }

    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external returns (uint256 jobId);

    function setProvider(uint256 jobId, address provider) external;
    function setBudget(uint256 jobId, uint256 amount, bytes calldata data) external;
    function fund(uint256 jobId, bytes calldata data) external;
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata data) external;
    function complete(uint256 jobId, bytes32 reason, bytes calldata data) external;
    function reject(uint256 jobId, bytes32 reason, bytes calldata data) external;
    function claimRefund(uint256 jobId) external;
    function getJob(uint256 jobId) external view returns (Job memory);
}
