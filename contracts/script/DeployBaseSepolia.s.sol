// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "forge-std/Script.sol";
import "../src/BountyAdapter.sol";
import "../src/base/AgenticCommerce.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

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

/// @notice Base Sepolia rehearsal deploy — see docs/INTEGRATION_NOTES.md for
///         why the escrow is self-deployed (no canonical ERC-8183 on Base)
///         while the ERC-8004 registries are the official 8004-team addresses
///         (canonical deployments exist on Base). Arc is never touched by
///         this script.
///
/// V4.7 (M-09): brought up to DeployBaseMainnet.s.sol's guard level — this
/// script previously had none of it (no chainid guard, no live registry
/// probe, no post-deploy assertions), despite deploying the same escrow +
/// adapter pair. A staging deploy that silently lands on the wrong chain or
/// wires the wrong registry is exactly the kind of mistake worth catching
/// here before it's rehearsed as if it were the real thing.
///
/// Required env: PRIVATE_KEY, FEE_RECIPIENT.
/// Optional env: MAX_BOUNTY_AMOUNT (defaults to 500 USDC, matching the TZ's
///         mainnet safety-cap default — kept on Sepolia too so the rehearsal
///         exercises the exact code path mainnet will run).
contract DeployBaseSepolia is Script {
    uint256 constant BASE_SEPOLIA_CHAIN_ID = 84532;

    // Base Sepolia (chainId 84532) — see docs/INTEGRATION_NOTES.md, all
    // confirmed on-chain (eth_call symbol()/name() checks) 2026-07-19.
    address constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address constant IDENTITY_REGISTRY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address constant REPUTATION_REGISTRY = 0x8004B663056A597Dffe9eCcC1965A193B7388713;

    function run() external {
        require(block.chainid == BASE_SEPOLIA_CHAIN_ID, "wrong chain: expected Base Sepolia (84532)");

        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");
        uint256 maxBountyAmount = vm.envOr("MAX_BOUNTY_AMOUNT", uint256(500e6));

        // Fail before spending gas rather than after: a typo'd registry would
        // otherwise deploy fine and only revert on the first bounty. Call the
        // registries, don't just measure them — code length isn't proof of
        // the right contract (see DeployBaseMainnet.s.sol's history, where
        // this exact gap shipped the wrong registry pair to mainnet once).
        require(USDC.code.length > 0, "USDC has no code");
        require(keccak256(bytes(IERC20MetadataView(USDC).symbol())) == keccak256("USDC"), "USDC symbol mismatch");
        require(IERC20MetadataView(USDC).decimals() == 6, "USDC decimals mismatch (expected 6)");
        require(
            keccak256(bytes(IIdentityRegistryName(IDENTITY_REGISTRY).name())) == keccak256("AgentIdentity"),
            "identity registry does not answer name() == AgentIdentity"
        );
        (bool ok, bytes memory ret) = REPUTATION_REGISTRY.staticcall(
            abi.encodeWithSignature("getSummary(uint256,address[],string,string)", uint256(1), new address[](0), "", "")
        );
        require(!ok, "reputation registry: getSummary unexpectedly succeeded with no clients");
        require(ret.length > 0, "reputation registry does not answer getSummary - wrong address for this chain");

        // vm.addr(key), NOT msg.sender — see DeployBaseMainnet.s.sol. The
        // 2026-07-19 rehearsal ran the msg.sender version and handed the
        // escrow's DEFAULT_ADMIN_ROLE to Foundry's keyless default sender.
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        // ── AgenticCommerce (UUPS proxy) ────────────────────────────────────
        AgenticCommerce impl = new AgenticCommerce();
        ERC1967Proxy proxy =
            new ERC1967Proxy(address(impl), abi.encodeCall(AgenticCommerce.initialize, (USDC, feeRecipient, deployer)));
        AgenticCommerce escrow = AgenticCommerce(address(proxy));
        // platformFeeBP / evaluatorFeeBP default to 0 on initialize — matches
        // Arc's live configuration, which BountyAdapter's balance-delta
        // payout forwarding assumes. Left unset intentionally.

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
        require(adapter.arbitrator() == deployer, "adapter arbitrator did not land on the deployer");

        console.log("AgenticCommerce impl:", address(impl));
        console.log("AgenticCommerce proxy:", address(escrow));
        console.log("BountyAdapter:", address(adapter));
        console.log("maxBountyAmount (atomic):", maxBountyAmount);
    }
}
