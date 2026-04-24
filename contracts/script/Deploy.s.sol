// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "forge-std/Script.sol";
import "../src/BountyAdapter.sol";

contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        BountyAdapter adapter = new BountyAdapter(
            vm.envAddress("AGENTIC_COMMERCE"),
            vm.envAddress("IDENTITY_REGISTRY"),
            vm.envAddress("REPUTATION_REGISTRY"),
            vm.envAddress("USDC_ADDRESS"),
            vm.envAddress("FEE_RECIPIENT"),
            100 // 1% in BPS
        );

        console.log("BountyAdapter deployed at:", address(adapter));
        vm.stopBroadcast();
    }
}
