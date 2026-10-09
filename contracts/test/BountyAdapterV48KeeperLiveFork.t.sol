// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {BountyAdapterV48} from "../src/monad/BountyAdapterV48.sol";
import {KeeperReceiver} from "../src/monad/KeeperReceiver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Live deployed receiver/job 7; time moves only inside this local fork.
contract BountyAdapterV48KeeperLiveForkTest is Test {
    address constant SAFE = 0x74678c072Ca546f11466CD44eB7e21730a312a54;
    BountyAdapterV48 adapter;
    KeeperReceiver receiver;
    address reporter;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, vm.envUint("MONAD_FORK_BLOCK"));
        require(block.chainid == 10143, "testnet fork only");
        adapter = BountyAdapterV48(0xf88B980B3AB1CD5A2Befd9c0B88B70196f215020);
        receiver = KeeperReceiver(0x5B7559f1973D371d1b6A1e6ED22BeCbb4594e17f);
        assertEq(receiver.owner(), SAFE);
        assertEq(receiver.relayer(), address(0));
        assertEq(receiver.adapter(), address(adapter));
        assertTrue(adapter.paused());
        assertFalse(adapter.getBountyMeta(7).resolved);
        reporter = makeAddr("local fork keeper reporter");
        vm.prank(SAFE);
        receiver.setRelayer(reporter);
    }

    function _actions() internal pure returns (KeeperReceiver.Action[] memory actions) {
        actions = new KeeperReceiver.Action[](1);
        actions[0] = KeeperReceiver.Action(uint8(KeeperReceiver.ActionKind.ContestDefault), 7);
    }

    function _mature() internal {
        BountyAdapterV48.BountyMeta memory meta = adapter.getBountyMeta(7);
        BountyAdapterV48.ContestChallenge memory challenge = adapter.getContestChallenge(7, 0);
        uint256 cutoff = meta.rejectedAt + adapter.REJECTION_CHALLENGE_WINDOW();
        uint256 response = challenge.challengedAt + adapter.DISPUTE_RESPONSE_WINDOW();
        vm.warp((cutoff > response ? cutoff : response) + 1);
    }

    function testLiveReceiverCannotSettleBeforeRealDeadline() public {
        vm.prank(reporter);
        (uint256 successes, uint256 failures) = receiver.execute{gas: 6_000_000}(_actions());
        assertEq(successes, 0);
        assertEq(failures, 1);
        assertFalse(adapter.getBountyMeta(7).resolved);
        assertTrue(adapter.paused());
    }

    function testLiveReceiverReportPaysCurrentIdentityOwnerOnMatureFork() public {
        _mature();
        BountyAdapterV48.ContestEntry[] memory entries = adapter.getContestEntries(7);
        address identityOwner = adapter.identityRegistry().ownerOf(entries[0].agentId);
        IERC20 usdc = adapter.usdc();
        uint256 ownerBefore = usdc.balanceOf(identityOwner);
        uint256 safeBefore = usdc.balanceOf(SAFE);
        uint256 reward = adapter.getBountyMeta(7).reward;
        uint256 fee = reward * adapter.feeBps() / 10_000;
        uint256 gasBefore = gasleft();
        vm.prank(reporter);
        receiver.onReport{gas: 6_000_000}("", abi.encode(_actions()));
        emit log_named_uint("live receiver report gas consumed on fork", gasBefore - gasleft());
        assertTrue(adapter.getBountyMeta(7).resolved);
        assertEq(usdc.balanceOf(identityOwner) - ownerBefore, reward - fee);
        assertEq(usdc.balanceOf(SAFE) - safeBefore, fee);
        assertTrue(adapter.paused());
    }

    function testLiveBatchIsolatesStaleAndUnsupportedActions() public {
        _mature();
        KeeperReceiver.Action[] memory actions = new KeeperReceiver.Action[](3);
        actions[0] = KeeperReceiver.Action(uint8(KeeperReceiver.ActionKind.ExpireBounty), 1);
        actions[1] = _actions()[0];
        actions[2] = KeeperReceiver.Action(255, 7);
        vm.prank(reporter);
        (uint256 successes, uint256 failures) = receiver.execute{gas: 12_000_000}(actions);
        assertEq(successes, 1);
        assertEq(failures, 2);
        assertTrue(adapter.getBountyMeta(7).resolved);
        assertTrue(adapter.paused());
    }
}
