// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Minimal interface for Arc ERC-8004 IdentityRegistry contract
interface IIdentityRegistry {
    function register(string calldata metadataURI) external returns (uint256 agentId);

    function ownerOf(uint256 agentId) external view returns (address);

    function getMetadataURI(uint256 agentId) external view returns (string memory);

    function isRegistered(uint256 agentId) external view returns (bool);
}
