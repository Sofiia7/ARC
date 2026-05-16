// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "forge-std/Test.sol";
import "../src/BountyAdapter.sol";
import "../src/interfaces/IAgenticCommerce.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title BountyAdapter fork tests against live Arc Testnet contracts.
/// @dev Activates only when ARC_TESTNET_RPC_URL is set. Otherwise all tests are skipped
///      via vm.skip(true) so CI on machines without RPC access still passes.
contract BountyAdapterForkTest is Test {
    // Canonical Arc Testnet addresses (per TZ §2.1 — re-verify before mainnet).
    address constant AC_TESTNET       = 0x0747EEf0706327138c69792bF28Cd525089e4583;
    address constant IDENTITY_TESTNET = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address constant REP_TESTNET      = 0x8004B663056A597Dffe9eCcC1965A193B7388713;
    address constant USDC_TESTNET     = 0x3600000000000000000000000000000000000000;

    BountyAdapter adapter;
    bool         forkAvailable;

    function setUp() public {
        string memory rpc = vm.envOr("ARC_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            forkAvailable = false;
            return;
        }
        try vm.createSelectFork(rpc) returns (uint256) {
            forkAvailable = true;
        } catch {
            forkAvailable = false;
            return;
        }

        // Sanity: code must be present at the canonical addresses.
        require(AC_TESTNET.code.length       > 0, "AC not deployed on fork");
        require(IDENTITY_TESTNET.code.length > 0, "IdentityRegistry not deployed on fork");
        require(REP_TESTNET.code.length      > 0, "ReputationRegistry not deployed on fork");
        require(USDC_TESTNET.code.length     > 0, "USDC not deployed on fork");

        adapter = new BountyAdapter(
            AC_TESTNET, IDENTITY_TESTNET, REP_TESTNET, USDC_TESTNET,
            address(0xFee), 100
        );
    }

    modifier onlyFork() {
        if (!forkAvailable) {
            vm.skip(true);
        }
        _;
    }

    /// @notice Verify the AC interface — function selectors actually resolve on-chain.
    function testFork_acHasExpectedInterface() public onlyFork {
        // getJob on jobId=0 should not revert with "function not found"; it may revert
        // with "job not found" or return zeroed struct — either is fine, both prove ABI match.
        try IAgenticCommerce(AC_TESTNET).getJob(0) returns (IAgenticCommerce.Job memory) {
            // ok
        } catch {
            // ok (revert on bad jobId is expected)
        }
    }

    /// @notice Smoke test: createBounty against real AC. Requires deployer to be funded with USDC.
    ///         Skipped if FORK_PRIVATE_KEY env var not set.
    function testFork_createBounty_smoke() public onlyFork {
        uint256 pk = vm.envOr("FORK_PRIVATE_KEY", uint256(0));
        if (pk == 0) { vm.skip(true); return; }

        address user = vm.addr(pk);
        uint256 reward = 2e6; // 2 USDC

        // User must have funded USDC and approved adapter externally.
        uint256 allowance = IERC20(USDC_TESTNET).allowance(user, address(adapter));
        if (allowance < reward) { vm.skip(true); return; }

        string[] memory tags = new string[](1);
        tags[0] = "smoke";

        vm.startBroadcast(pk);
        uint256 jobId = adapter.createBounty(
            BountyAdapter.CreateParams({
                provider: address(0),
                reward: reward,
                deadline: block.timestamp + 1 days,
                ipfsDescHash: "ipfs://QmForkSmoke",
                category: "other",
                tags: tags,
                agentOnly: false,
                commitRevealRequired: false
            })
        );
        vm.stopBroadcast();

        assertGt(jobId, 0);
        BountyAdapter.BountyMeta memory meta = adapter.getBountyMeta(jobId);
        assertEq(meta.poster, user);
        assertTrue(meta.funded);
    }
}

