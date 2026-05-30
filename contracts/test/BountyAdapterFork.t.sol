// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "forge-std/Test.sol";
import "../src/BountyAdapter.sol";

/// @dev Fork-tests against real Arc Testnet AC + Identity + Reputation.
///      Run with:
///        forge test --fork-url $ARC_TESTNET_RPC_URL \
///                   --match-contract BountyAdapterForkTest -vvv
///      Skipped on local runs (no RPC) by checking chain id.
contract BountyAdapterForkTest is Test {
    address constant AGENTIC_COMMERCE = 0x0747EEf0706327138c69792bF28Cd525089e4583;
    address constant IDENTITY_REGISTRY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address constant REPUTATION_REGISTRY = 0x8004B663056A597Dffe9eCcC1965A193B7388713;
    address constant USDC = 0x3600000000000000000000000000000000000000;

    BountyAdapter adapter;
    address poster = address(0xA11CE);
    address worker = address(0xB0B);
    address feeAddr = address(0xFEE);

    function setUp() public {
        // Only run when forked.
        if (block.chainid != 5042002) return;

        adapter = new BountyAdapter(AGENTIC_COMMERCE, IDENTITY_REGISTRY, REPUTATION_REGISTRY, USDC, feeAddr, 100);

        // Hand poster some USDC.
        deal(USDC, poster, 100e6);
        vm.prank(poster);
        (bool ok,) = USDC.call(abi.encodeWithSignature("approve(address,uint256)", address(adapter), type(uint256).max));
        require(ok, "approve failed");
    }

    /// @notice Happy path against real Arc contracts. Asserts the adapter can
    ///         createJob / setBudget / fund / submit / complete against real AC
    ///         and that USDC flows through to the worker.
    function testFork_happyPath() public {
        if (block.chainid != 5042002) {
            emit log("skipped: not forked on Arc Testnet");
            return;
        }

        string[] memory tags = new string[](1);
        tags[0] = "fork";
        BountyAdapter.CreateParams memory p = BountyAdapter.CreateParams({
            provider: address(0),
            reward: 1e6, // $1
            deadline: block.timestamp + 1 days,
            ipfsDescHash: "ipfs://QmForkTestDescription",
            category: "dev",
            tags: tags,
            agentOnly: false,
            humanOnly: true // ensure we don't need to mint an ERC-8004 NFT
        });

        vm.prank(poster);
        uint256 jobId = adapter.createBounty(p);

        vm.prank(worker);
        adapter.takeBounty(jobId, 0);

        vm.prank(worker);
        adapter.submitWork(jobId, "ipfs://QmForkTestResult");

        (bool ok, bytes memory data) = USDC.staticcall(abi.encodeWithSignature("balanceOf(address)", worker));
        require(ok);
        uint256 beforeWorker = abi.decode(data, (uint256));

        vm.prank(poster);
        adapter.approveBounty(jobId, 95);

        (ok, data) = USDC.staticcall(abi.encodeWithSignature("balanceOf(address)", worker));
        require(ok);
        uint256 afterWorker = abi.decode(data, (uint256));

        // Worker should be paid (≥ reward minus our 1% fee minus any AC platform
        // fee). Lower-bound assertion — exact number depends on real AC fees.
        assertGt(afterWorker, beforeWorker, "worker not paid");
        assertLe(afterWorker - beforeWorker, 1e6, "worker overpaid");
    }
}
