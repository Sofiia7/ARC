// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "forge-std/Script.sol";
import "../src/BountyAdapter.sol";

/// @dev Just enough of an ERC-20 to verify USDC's identity before broadcasting.
interface IERC20MetadataView {
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}

/// @dev Just enough of the IdentityRegistry to prove it is the real one: the
///      8004 registries are ERC-721s named "AgentIdentity".
interface IIdentityRegistryName {
    function name() external view returns (string memory);
}

/// @dev Just enough of AgenticCommerce to confirm it's actually wired to the
///      same USDC this script was given, not merely present on-chain.
interface IAgenticCommercePaymentToken {
    function paymentToken() external view returns (address);
}

/// @notice Arc deploy — BountyAdapter only. Arc's AgenticCommerce and both
///         ERC-8004 registries are canonical, externally-deployed contracts;
///         this script never deploys its own escrow (contrast with the Base
///         scripts, which self-deploy AgenticCommerce since Base has no
///         canonical ERC-8183 instance — see docs/INTEGRATION_NOTES.md).
///
/// Required env: PRIVATE_KEY, AGENTIC_COMMERCE, IDENTITY_REGISTRY,
///         REPUTATION_REGISTRY, USDC_ADDRESS, FEE_RECIPIENT, EXPECTED_CHAIN_ID.
/// Optional env: MAX_BOUNTY_AMOUNT (0 = uncapped, matches Arc's own history —
///         Arc's live deployment has never been redeployed with a cap).
contract Deploy is Script {
    function run() external {
        // V4.7 (M-09): Arc mainnet's chain id isn't published yet, so unlike
        // DeployBaseMainnet.s.sol this can't be a hardcoded constant — it has
        // to be supplied explicitly every run instead of silently trusting
        // whatever RPC the deployer happens to be pointed at. Real today
        // (Arc testnet's id is 5042002), and correct the day the mainnet id
        // is published, without anyone having to guess or hardcode it here.
        uint256 expectedChainId = vm.envUint("EXPECTED_CHAIN_ID");
        require(block.chainid == expectedChainId, "wrong chain: does not match EXPECTED_CHAIN_ID");

        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address agenticCommerce = vm.envAddress("AGENTIC_COMMERCE");
        address identityRegistry = vm.envAddress("IDENTITY_REGISTRY");
        address reputationRegistry = vm.envAddress("REPUTATION_REGISTRY");
        address usdc = vm.envAddress("USDC_ADDRESS");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");
        // V4.5: unaudited-mainnet safety cap, 0 = uncapped. Arc's own
        // redeploys always pass 0 (or leave unset) — Arc is never redeployed
        // to pick up V4.5 anyway; this default exists so this script stays
        // usable for future Arc-style (uncapped) networks.
        uint256 maxBountyAmount = vm.envOr("MAX_BOUNTY_AMOUNT", uint256(0));

        // Fail before spending gas rather than after — same rationale as
        // DeployBaseMainnet.s.sol: a typo'd registry would otherwise deploy
        // fine and only revert on the first bounty. Code presence alone isn't
        // proof of the right contract (see that script's history), so probe
        // with a real call wherever the contract exposes one.
        require(usdc.code.length > 0, "USDC has no code");
        require(keccak256(bytes(IERC20MetadataView(usdc).symbol())) == keccak256("USDC"), "USDC symbol mismatch");
        require(
            IERC20MetadataView(usdc).decimals() == 6, "USDC decimals mismatch (expected 6 for the ERC-20 interface)"
        );
        require(agenticCommerce.code.length > 0, "AgenticCommerce has no code");
        require(
            IAgenticCommercePaymentToken(agenticCommerce).paymentToken() == usdc,
            "AgenticCommerce.paymentToken() does not match USDC_ADDRESS - wrong pair for this chain"
        );
        require(
            keccak256(bytes(IIdentityRegistryName(identityRegistry).name())) == keccak256("AgentIdentity"),
            "identity registry does not answer name() == AgentIdentity"
        );
        // The reputation registry has no name(); getSummary reverts with its
        // own require string ("clientAddresses required") when it is live,
        // and with no reason at all when the address is a dead/wrong
        // contract. Distinguish the two rather than accepting both.
        (bool ok, bytes memory ret) = reputationRegistry.staticcall(
            abi.encodeWithSignature("getSummary(uint256,address[],string,string)", uint256(1), new address[](0), "", "")
        );
        require(!ok, "reputation registry: getSummary unexpectedly succeeded with no clients");
        require(ret.length > 0, "reputation registry does not answer getSummary - wrong address for this chain");

        // vm.addr(key), not msg.sender — see DeployBaseMainnet.s.sol's note:
        // inside run(), msg.sender is Foundry's keyless default sender, not
        // the broadcaster, and BountyAdapter's constructor reads msg.sender
        // for owner/arbitrator.
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);
        BountyAdapter adapter = new BountyAdapter(
            agenticCommerce, identityRegistry, reputationRegistry, usdc, feeRecipient, 100, maxBountyAmount
        );
        vm.stopBroadcast();

        require(adapter.owner() == deployer, "adapter owner did not land on the deployer");
        require(adapter.arbitrator() == deployer, "adapter arbitrator did not land on the deployer");

        console.log("BountyAdapter deployed at:", address(adapter));
    }
}
