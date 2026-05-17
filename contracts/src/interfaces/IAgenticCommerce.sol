// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Minimal interface for Arc ERC-8183 AgenticCommerce contract,
///         matching the implementation deployed on Arc Testnet at
///         0xa316fd02827242d537f84730f8a37d0ba5fd351a (proxy at 0x0747…4583).
///         Verified against on-chain ABI in sprint 6.
interface IAgenticCommerce {
    /// @dev Real ERC-8183 lifecycle:
    ///   createJob → setProvider (one-shot) → setBudget → fund
    ///   → submit → complete (pays provider directly)
    ///   OR after fund: reject + claimRefund (refunds client = the caller of createJob)
    ///
    /// `claimRefund` consolidates what older drafts split between refund/expire.
    /// `provider` cannot be re-assigned after setProvider; design accordingly.

    function createJob(
        address provider,         // 0 means open; can be filled in via setProvider
        address evaluator,
        uint256 deadline,
        string  calldata description,
        address hook
    ) external returns (uint256 jobId);

    function setProvider(uint256 jobId, address provider) external;
    function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external;
    function fund(uint256 jobId, bytes calldata optParams) external;
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external;
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external;

    /// @notice Pulls escrowed budget back to the client (= original createJob caller).
    ///         Permitted after `reject` or after the deadline passes without completion.
    function claimRefund(uint256 jobId) external;

    function jobHasBudget(uint256 jobId) external view returns (bool);

    /// @dev Real on-chain `jobs(uint256)` mapping signature:
    ///   (uint256 id, address client, address provider, address evaluator,
    ///    string description, uint256 budget, uint256 deadline, uint8 status, address hook)
    /// We don't model the full struct in this interface — callers that need it should
    /// invoke the public mapping directly.
}
