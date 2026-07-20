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
            100, // 1% in BPS
            // V4.5: unaudited-mainnet safety cap, 0 = uncapped. Arc's own
            // redeploys always pass 0 (or leave unset) — Arc is never
            // redeployed to pick up V4.5 anyway; this default exists so this
            // script stays usable for future Arc-style (uncapped) networks.
            vm.envOr("MAX_BOUNTY_AMOUNT", uint256(0))
        );

        console.log("BountyAdapter deployed at:", address(adapter));
        vm.stopBroadcast();
    }
}
