// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "forge-std/Test.sol";
import "../script/DeployArcMainnet.s.sol";

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

/// @dev Rehearses DeployArcMainnet.s.sol end to end against real Arc mainnet
///      state, before anything exists on-chain: creates the arbitrator Safe on
///      the fork, runs the script unmodified, then plays the Safe's side of the
///      handoff. Run with:
///        forge test --fork-url https://rpc.mainnet.arc.io \
///                   --match-contract DeployArcMainnetForkTest -vvv
///      Self-skips on any other chain.
contract DeployArcMainnetForkTest is Test {
    // Canonical Safe v1.4.1 - the same addresses and proxy creation code on
    // Arc mainnet and Base mainnet.
    address constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address constant SAFE_L2_SINGLETON = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address constant SAFE_FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;

    // BaseBounty's arbitrator Safe. Its owners, threshold and salt 0 reproduce
    // the same address on Arc mainnet, which this test pins.
    address constant BASE_ARBITRATOR_SAFE = 0x74678c072Ca546f11466CD44eB7e21730a312a54;

    address constant FEE_RECIPIENT = 0xADac7534d3fE868E28c77df5CD930f2635bcb63A;
    uint256 constant DEPLOYER_KEY = uint256(keccak256("arcbounty arc-mainnet fork deployer"));

    address safe;
    address deployer;
    AgenticCommerce escrow;
    BountyAdapter adapter;

    function testFork_deployScriptWiresEverythingToTheSafe() public {
        if (block.chainid != 5042) {
            emit log("skipped: not forked on Arc mainnet (5042)");
            return;
        }
        _createArbitratorSafe();
        _runScript();
        _assertDeployerCannotUpgradeEscrow();
        _assertPausedUntilOwnerDecides();
        _playSafeHandoff();
        _assertDeployerHoldsNothing();
    }

    function _createArbitratorSafe() internal {
        address[] memory owners = new address[](3);
        owners[0] = 0xed733FC13B1413966cf056866B6d80eF7b490eEc;
        owners[1] = 0x403A027b6c217C5E08cE4497A55732056067FD2D;
        owners[2] = 0xC6B48f603C439B4a6b55462AfCae10594D31242A;
        bytes memory initializer = abi.encodeWithSignature(
            "setup(address[],uint256,address,bytes,address,address,uint256,address)",
            owners,
            uint256(2),
            address(0),
            bytes(""),
            SAFE_FALLBACK_HANDLER,
            address(0),
            uint256(0),
            address(0)
        );
        safe = ISafeProxyFactory(SAFE_PROXY_FACTORY).createProxyWithNonce(SAFE_L2_SINGLETON, initializer, 0);
        assertEq(safe, BASE_ARBITRATOR_SAFE, "Arc Safe does not land on the Base Safe's address");
    }

    function _runScript() internal {
        deployer = vm.addr(DEPLOYER_KEY);
        vm.setEnv("PRIVATE_KEY", vm.toString(bytes32(DEPLOYER_KEY)));
        vm.setEnv("FEE_RECIPIENT", vm.toString(FEE_RECIPIENT));
        vm.setEnv("ARC_SAFE", vm.toString(safe));
        vm.setEnv("MAX_BOUNTY_AMOUNT", "500000000");

        DeployArcMainnet script = new DeployArcMainnet();
        script.run();
        escrow = script.escrow();
        adapter = script.adapter();
        assertEq(adapter.maxBountyAmount(), 500e6);
        assertEq(adapter.feeBps(), 100);
    }

    function _assertDeployerCannotUpgradeEscrow() internal {
        address newImpl = address(new AgenticCommerce());
        vm.prank(deployer);
        vm.expectRevert();
        escrow.upgradeToAndCall(newImpl, "");
    }

    function _assertPausedUntilOwnerDecides() internal {
        string[] memory tags = new string[](1);
        tags[0] = "fork";
        BountyAdapter.CreateParams memory p;
        p.reward = 1e6;
        p.deadline = block.timestamp + 2 days;
        p.ipfsDescHash = "ipfs://QmArcMainnetForkTest";
        p.category = "dev";
        p.tags = tags;
        p.humanOnly = true;
        vm.expectRevert(bytes("paused"));
        adapter.createBounty(p);
    }

    /// @dev What execTransaction from the Safe does on the real chain.
    function _playSafeHandoff() internal {
        vm.startPrank(safe);
        adapter.acceptOwner();
        adapter.acceptArbitrator();
        adapter.setPaused(false);
        vm.stopPrank();
        assertEq(adapter.owner(), safe);
        assertEq(adapter.arbitrator(), safe);
        assertEq(adapter.pendingOwner(), address(0));
        assertEq(adapter.pendingArbitrator(), address(0));
        assertFalse(adapter.paused());
    }

    function _assertDeployerHoldsNothing() internal {
        vm.startPrank(deployer);
        vm.expectRevert(bytes("only owner"));
        adapter.setPaused(true);
        vm.expectRevert(bytes("only arbitrator"));
        adapter.transferArbitrator(deployer);
        vm.stopPrank();
    }
}
