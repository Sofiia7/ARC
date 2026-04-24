// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Minimal interface for Arc ERC-8004 ReputationRegistry contract
interface IReputationRegistry {
    struct ReputationScore {
        uint256 averageScore;
        uint256 totalFeedbacks;
        uint256 totalJobs;
    }

    function giveFeedback(
        uint256 agentId,
        uint256 score,
        uint256 feedbackType,
        string calldata context,
        string calldata field1,
        string calldata field2,
        string calldata field3,
        bytes32 feedbackHash
    ) external;

    function getReputation(uint256 agentId) external view returns (ReputationScore memory);
}
