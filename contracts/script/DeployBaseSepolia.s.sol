// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "forge-std/Script.sol";
import "../src/BountyAdapter.sol";
import "../src/base/AgenticCommerce.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice Base Sepolia rehearsal deploy — see docs/INTEGRATION_NOTES.md for
///         why the escrow is self-deployed (no canonical ERC-8183 on Base)
///         while the ERC-8004 registries are the official 8004-team addresses
///         (canonical deployments exist on Base). Arc is never touched by
///         this script.
///
/// Required env: PRIVATE_KEY, FEE_RECIPIENT.
/// Optional env: MAX_BOUNTY_AMOUNT (defaults to 500 USDC, matching the TZ's
///         mainnet safety-cap default — kept on Sepolia too so the rehearsal
///         exercises the exact code path mainnet will run).
contract DeployBaseSepolia is Script {
    // Base Sepolia (chainId 84532) — see docs/INTEGRATION_NOTES.md, all
    // confirmed on-chain (eth_call symbol()/name() checks) 2026-07-19.
    address constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address constant IDENTITY_REGISTRY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address constant REPUTATION_REGISTRY = 0x8004B663056A597Dffe9eCcC1965A193B7388713;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");
        uint256 maxBountyAmount = vm.envOr("MAX_BOUNTY_AMOUNT", uint256(500e6));

        vm.startBroadcast(deployerKey);
        address deployer = msg.sender;

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

        console.log("AgenticCommerce impl:", address(impl));
        console.log("AgenticCommerce proxy:", address(escrow));
        console.log("BountyAdapter:", address(adapter));
        console.log("maxBountyAmount (atomic):", maxBountyAmount);
    }
}
