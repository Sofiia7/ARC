// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @notice Chainlink KeystoneForwarder's consumer interface.
interface ICREReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}
