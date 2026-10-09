// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Test.sol";
import "../src/BountyAdapter.sol";
import "../src/base/AgenticCommerce.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MockUSDC, MockIdentityRegistry, MockReputationRegistry} from "./BountyAdapter.t.sol";
import {KeeperReceiver} from "../src/monad/KeeperReceiver.sol";

contract KeeperReceiverBaseTest is Test {
    function testBaseV47RealEscrowAutoApproveAndReplay() public {
        vm.warp(1000);
        MockUSDC usdc = new MockUSDC();
        MockIdentityRegistry identity = new MockIdentityRegistry();
        MockReputationRegistry reputation = new MockReputationRegistry();
        AgenticCommerce implementation = new AgenticCommerce();
        AgenticCommerce escrow = AgenticCommerce(
            address(
                new ERC1967Proxy(
                    address(implementation),
                    abi.encodeCall(AgenticCommerce.initialize, (address(usdc), address(0xFEE), address(this)))
                )
            )
        );
        BountyAdapter adapter = BountyAdapter(
            deployCode(
                "BountyAdapter.sol:BountyAdapter",
                abi.encode(
                    address(escrow),
                    address(identity),
                    address(reputation),
                    address(usdc),
                    address(0xFEE),
                    uint256(100),
                    uint256(0)
                )
            )
        );
        KeeperReceiver receiver =
            new KeeperReceiver(address(this), address(0x1234), address(adapter), KeeperReceiver.AdapterKind.BaseV47);
        usdc.mint(address(this), 10e6);
        usdc.approve(address(adapter), 10e6);
        BountyAdapter.CreateParams memory p;
        p.reward = 10e6;
        p.deadline = vm.getBlockTimestamp() + 7 days;
        p.ipfsDescHash = "ipfs://description";
        p.category = "dev";
        p.tags = new string[](0);
        uint256 job = adapter.createBounty(p);
        vm.startPrank(address(0xB0B));
        adapter.takeBounty(job, 0);
        adapter.submitWork(job, "ipfs://work");
        vm.stopPrank();
        vm.warp(adapter.getBountyMeta(job).submittedAt + 14 days + 1);
        KeeperReceiver.Action[] memory actions = new KeeperReceiver.Action[](3);
        actions[0] = KeeperReceiver.Action(0, job);
        actions[1] = KeeperReceiver.Action(0, job);
        actions[2] = KeeperReceiver.Action(6, job);
        vm.prank(address(0x1234));
        (uint256 successes, uint256 failures) = receiver.execute(actions);
        assertEq(successes, 1);
        assertEq(failures, 2);
        assertEq(usdc.balanceOf(address(0xB0B)), 9.9e6);
        assertEq(usdc.balanceOf(address(0xFEE)), 0.1e6);
        assertTrue(adapter.getBountyMeta(job).resolved);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }
}
