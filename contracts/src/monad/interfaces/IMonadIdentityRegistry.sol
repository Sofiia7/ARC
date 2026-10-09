// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice ERC-8004 v2 reads used by the Monad adapter.
/// @dev Keep this separate from the interface used by Arc/Base V4.7.
interface IMonadIdentityRegistry {
    function ownerOf(uint256 agentId) external view returns (address);
    function getAgentWallet(uint256 agentId) external view returns (address);
}
