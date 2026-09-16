// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "forge-std/Script.sol";
import "../src/BountyAdapter.sol";

/// @dev Just enough of AgenticCommerce to confirm the existing proxy is
///      actually wired to the USDC this script was given.
interface IAgenticCommercePaymentToken {
    function paymentToken() external view returns (address);
}

/// @dev Just enough of the IdentityRegistry to prove it is the real one: the
///      8004 registries are ERC-721s named "AgentIdentity".
interface IIdentityRegistryName {
    function name() external view returns (string memory);
}

/// @notice V4.7 migration deploy for Base mainnet (BaseBounty). Prepared as
///         part of the 2026-09-07 audit fix pass - NOT yet run.
///
///         `BountyAdapter` is not upgradeable (plain immutable constructor
///         params, no proxy - confirmed by reading the source and by every
///         prior Arc redeploy in contracts/DEPLOYMENTS.md needing a fresh
///         address). Shipping the C-01/C-02/M-01/M-07/M-08 fixes to Base
///         therefore means a new BountyAdapter, not an upgrade.
///
///         Unlike `DeployBaseMainnet.s.sol` (first deploy, self-deploys its
///         own AgenticCommerce since Base had no canonical ERC-8183 instance
///         at the time), this script deploys ONLY a new BountyAdapter and
///         points it at the EXISTING, already-live AgenticCommerce proxy
///         (`0x6D9317eC0Fca3aFd5439d539064DBA94197c4AC4`). AC's own code has
///         no C-01/C-02-class bug — those were entirely in how the adapter
///         talked to AC, not in AC itself — so there is no reason to churn
///         the escrow address too. Migrating the escrow would additionally
///         orphan its own admin-role/upgrade-authority state, which is a
///         separate, still-open problem (see the note below) best not
///         compounded with this one.
///
/// Preconditions checked live in this script (all as of 2026-09-07, verified
/// via `cast call` immediately before this file was written — re-verify
/// again immediately before actually running this):
///   - Live adapter `0x9b0B27c20DF10BFc667F4316d7175166Ff8c4c2c` holds 0 USDC
///     and 0 open bounties. Nothing to reclaim/reseed-migrate as part of this
///     specific cutover — a fresh board, not a live migration of funds.
///   - `arbitrator()` on the live adapter is STILL the deployer EOA
///     (`0x6abc2b575eC66701c17DAD96dDA97F22b837849E`) — `transferArbitrator`
///     to the Safe was sent 2026-08-29 but `acceptArbitrator()` was never
///     executed from the Safe. That handoff is independent of this
///     migration and should happen for the NEW adapter too — see the
///     post-run checklist below, not automated here (accepting a role
///     transfer must be executed from the Safe itself, not this script).
///
/// Required env: BASE_MAINNET_DEPLOYER_KEY, FEE_RECIPIENT.
/// Optional env: MAX_BOUNTY_AMOUNT (defaults to 500 USDC, matching the live
///         V4.6 adapter's current cap — this migration is not the moment to
///         also change that policy; do it as its own deliberate
///         `setMaxBountyAmount` call afterward if desired).
contract MigrateBaseMainnet is Script {
    uint256 constant BASE_MAINNET_CHAIN_ID = 8453;

    // Base mainnet (chainId 8453) — unchanged from DeployBaseMainnet.s.sol.
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant REPUTATION_REGISTRY = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;
    // The EXISTING, already-live AgenticCommerce proxy — reused, not redeployed.
    address constant AGENTIC_COMMERCE = 0x6D9317eC0Fca3aFd5439d539064DBA94197c4AC4;

    function run() external {
        require(block.chainid == BASE_MAINNET_CHAIN_ID, "wrong chain: expected Base mainnet (8453)");

        uint256 deployerKey = vm.envUint("BASE_MAINNET_DEPLOYER_KEY");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");
        uint256 maxBountyAmount = vm.envOr("MAX_BOUNTY_AMOUNT", uint256(500e6));

        // Same rationale as DeployBaseMainnet.s.sol: fail before spending gas,
        // and call rather than merely measure - code presence isn't proof of
        // the right contract (the exact bug that shipped the wrong registry
        // pair to mainnet once already, see DEPLOYMENTS.md).
        require(USDC.code.length > 0, "USDC has no code");
        require(AGENTIC_COMMERCE.code.length > 0, "AgenticCommerce has no code");
        require(
            IAgenticCommercePaymentToken(AGENTIC_COMMERCE).paymentToken() == USDC,
            "AgenticCommerce.paymentToken() does not match USDC - wrong AC address for this chain"
        );
        require(
            keccak256(bytes(IIdentityRegistryName(IDENTITY_REGISTRY).name())) == keccak256("AgentIdentity"),
            "identity registry does not answer name() == AgentIdentity"
        );
        (bool ok, bytes memory ret) = REPUTATION_REGISTRY.staticcall(
            abi.encodeWithSignature("getSummary(uint256,address[],string,string)", uint256(1), new address[](0), "", "")
        );
        require(!ok, "reputation registry: getSummary unexpectedly succeeded with no clients");
        require(ret.length > 0, "reputation registry does not answer getSummary - wrong address for this chain");

        // vm.addr(key), not msg.sender - see DeployBaseMainnet.s.sol's note.
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        BountyAdapter adapter = new BountyAdapter(
            AGENTIC_COMMERCE, IDENTITY_REGISTRY, REPUTATION_REGISTRY, USDC, feeRecipient, 100, maxBountyAmount
        );

        // Ship paused. A migration deploy should be reviewed on-chain (owner,
        // arbitrator, wiring, maybe a single team-run smoke bounty) before
        // it accepts real deposits from anyone else - setPaused(false) is a
        // deliberate, separate, later transaction once that review is done.
        adapter.setPaused(true);

        vm.stopBroadcast();

        require(adapter.owner() == deployer, "adapter owner did not land on the deployer");
        require(adapter.arbitrator() == deployer, "adapter arbitrator did not land on the deployer");
        require(adapter.paused(), "adapter did not deploy paused as expected");

        console.log("BountyAdapter (V4.7 migration) deployed at:", address(adapter));
        console.log("Reused AgenticCommerce proxy:", AGENTIC_COMMERCE);
        console.log("Deployed PAUSED - call setPaused(false) once reviewed.");
        console.log("owner/arbitrator (deployer, pre-handshake):", deployer);
        console.log("maxBountyAmount (atomic):", maxBountyAmount);
    }
}
