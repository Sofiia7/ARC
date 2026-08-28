// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "forge-std/Script.sol";
import "../src/BountyAdapter.sol";
import "../src/base/AgenticCommerce.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @dev Just enough of the IdentityRegistry to prove it is the real one: the
///      8004 registries are ERC-721s named "AgentIdentity".
interface IIdentityRegistryName {
    function name() external view returns (string memory);
}

/// @notice Base **mainnet** deploy (BaseBounty). Same shape as the Base Sepolia
///         rehearsal — self-deployed escrow (no canonical ERC-8183 on Base),
///         official ERC-8004 team registries — with mainnet addresses and a
///         hard chainId guard so it can never be pointed at another chain.
///         Arc is never touched by this script.
///
/// Addresses re-verified on-chain against Base mainnet before this deploy:
/// USDC symbol()=="USDC"/decimals()==6, and both 8004 registries have code.
///
/// Required env: BASE_MAINNET_DEPLOYER_KEY, FEE_RECIPIENT.
/// Optional env: MAX_BOUNTY_AMOUNT (defaults to 500 USDC — the TZ's mainnet
///         safety cap; `setMaxBountyAmount` can raise it later via the owner).
contract DeployBaseMainnet is Script {
    uint256 constant BASE_MAINNET_CHAIN_ID = 8453;

    // Base mainnet (chainId 8453).
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    // The 8004 team's Base MAINNET registries. The Base *Sepolia* pair
    // (0x8004A818…/0x8004B663…) sat here until 2026-08-28 and shipped: those
    // addresses hold 263 bytes of uninitialised proxy on mainnet too, so the
    // code-length checks below passed while every call to them reverted.
    address constant IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant REPUTATION_REGISTRY = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;

    function run() external {
        require(block.chainid == BASE_MAINNET_CHAIN_ID, "wrong chain: expected Base mainnet (8453)");

        uint256 deployerKey = vm.envUint("BASE_MAINNET_DEPLOYER_KEY");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");
        uint256 maxBountyAmount = vm.envOr("MAX_BOUNTY_AMOUNT", uint256(500e6));

        // Fail before spending gas rather than after: a typo'd registry would
        // otherwise deploy fine and only revert on the first bounty.
        //
        // Call the registries, do not measure them. Code length was the check
        // here until 2026-08-28, and it passed on a pair of Base Sepolia
        // addresses that carry an uninitialised proxy on mainnet as well - so
        // the adapter shipped wired to two contracts that revert on every call,
        // and agentOnly bounties were untakeable on Base mainnet from day one.
        // A registry that answers a view call is a registry; one that merely
        // has bytecode is an address.
        require(USDC.code.length > 0, "USDC has no code");
        require(
            keccak256(bytes(IIdentityRegistryName(IDENTITY_REGISTRY).name())) == keccak256("AgentIdentity"),
            "identity registry does not answer name() == AgentIdentity"
        );
        // The reputation registry has no name(); getSummary reverts with its
        // own require string ("clientAddresses required") when it is live, and
        // with no reason at all when the address is a dead proxy. Distinguish
        // the two rather than accepting both.
        (bool ok, bytes memory ret) = REPUTATION_REGISTRY.staticcall(
            abi.encodeWithSignature("getSummary(uint256,address[],string,string)", uint256(1), new address[](0), "", "")
        );
        require(!ok, "reputation registry: getSummary unexpectedly succeeded with no clients");
        require(ret.length > 0, "reputation registry does not answer getSummary - wrong address for this chain");

        // vm.addr(key), NOT msg.sender: inside run() msg.sender is Foundry's
        // default sender (0x1804c8AB…), which startBroadcast does not change —
        // it only rewrites the sender of the calls the script makes. Reading
        // msg.sender here is what granted the Base Sepolia escrow's
        // DEFAULT_ADMIN_ROLE to that keyless address (see DEPLOYMENTS.md).
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        // ── AgenticCommerce (UUPS proxy) ────────────────────────────────────
        AgenticCommerce impl = new AgenticCommerce();
        ERC1967Proxy proxy =
            new ERC1967Proxy(address(impl), abi.encodeCall(AgenticCommerce.initialize, (USDC, feeRecipient, deployer)));
        AgenticCommerce escrow = AgenticCommerce(address(proxy));
        // platformFeeBP / evaluatorFeeBP stay 0 on initialize — matches Arc's
        // live configuration, which BountyAdapter's balance-delta payout
        // forwarding assumes. Left unset intentionally.

        // ── BountyAdapter ────────────────────────────────────────────────────
        BountyAdapter adapter = new BountyAdapter(
            address(escrow),
            IDENTITY_REGISTRY,
            REPUTATION_REGISTRY,
            USDC,
            feeRecipient,
            100, // 1% in BPS — matches Arc
            maxBountyAmount
        );

        vm.stopBroadcast();

        // The upgrade authority is the one thing that cannot be repaired after
        // the fact — assert it landed on the deployer before anything else.
        require(escrow.hasRole(0x00, deployer), "escrow DEFAULT_ADMIN_ROLE did not land on the deployer");
        require(adapter.owner() == deployer, "adapter owner did not land on the deployer");

        console.log("AgenticCommerce impl:", address(impl));
        console.log("AgenticCommerce proxy:", address(escrow));
        console.log("BountyAdapter:", address(adapter));
        console.log("fee recipient:", feeRecipient);
        console.log("owner/arbitrator (deployer, pre-handshake):", deployer);
        console.log("maxBountyAmount (atomic):", maxBountyAmount);
    }
}
