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

/// @dev Just enough of a Safe to prove ARC_SAFE is a live multisig on this chain.
interface ISafeView {
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
}

/// @notice Arc **mainnet** deploy (ArcBounty). Base's shape, not Arc testnet's:
///         Arc testnet wraps Circle's own reference ERC-8183 escrow
///         (0x0747EE…4583), but no instance exists on Arc mainnet at launch
///         (2026-09-16: no code at that address, and docs.arc.io's mainnet
///         contract list has no ERC-8183 entry). So, exactly as on Base, the
///         escrow is self-deployed from contracts/src/base/.
///
///         The ERC-8004 registries ARE live on Arc mainnet, at the 8004 team's
///         mainnet addresses - the same proxies over the same implementations
///         as Base mainnet, getVersion() == "2.0.0" (checked 2026-09-16).
///
///         Two deliberate differences from DeployBaseMainnet.s.sol:
///         - The escrow's DEFAULT_ADMIN_ROLE (its UUPS upgrade authority) and
///           ADMIN_ROLE go to the arbitrator Safe inside initialize(). On Base
///           they landed on the deployer's hot key and are still there.
///         - The adapter ships paused, with both role handoffs to the Safe
///           already started. The deployer stays owner until the Safe accepts,
///           so it can still run the smoke test and unpause.
///
///         Also runs on Arc testnet (5042002) as a rehearsal of this exact code
///         path against testnet's registry pair. Addresses are keyed by chain
///         id and never read from env, so a wrong RPC fails the chain check
///         instead of wiring the adapter to another network's registries.
///
///         Deployer key: PRIVATE_KEY on both networks. Reusing the testnet
///         deployer (0xde427f…2edA) on mainnet was the owner's call on
///         2026-09-16, overriding PRE_MAINNET_RUNBOOK.md §9 for launch speed.
///         What bounds that: the key never holds the escrow's upgrade
///         authority, and owner/arbitrator leave it once the Safe accepts.
///
/// Required env: PRIVATE_KEY, FEE_RECIPIENT, ARC_SAFE (the arbitrator Safe,
///         already created on this chain).
/// Optional env: MAX_BOUNTY_AMOUNT (defaults to 500 USDC, the Base mainnet cap).
contract DeployArcMainnet is Script {
    uint256 constant ARC_MAINNET_CHAIN_ID = 5042;
    uint256 constant ARC_TESTNET_CHAIN_ID = 5042002;

    // Arc's USDC ERC-20 interface - the same system address on both networks.
    address constant USDC = 0x3600000000000000000000000000000000000000;

    // The 8004 team's mainnet registries (identical to Base mainnet's).
    address constant MAINNET_IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant MAINNET_REPUTATION_REGISTRY = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;

    // Arc testnet's registries - rehearsal only.
    address constant TESTNET_IDENTITY_REGISTRY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address constant TESTNET_REPUTATION_REGISTRY = 0x8004B663056A597Dffe9eCcC1965A193B7388713;

    /// @notice Set by run(), so a fork test can inspect exactly what was deployed.
    AgenticCommerce public escrow;
    BountyAdapter public adapter;

    function run() external {
        bool mainnet = block.chainid == ARC_MAINNET_CHAIN_ID;
        require(
            mainnet || block.chainid == ARC_TESTNET_CHAIN_ID,
            "wrong chain: expected Arc mainnet (5042) or the Arc testnet rehearsal (5042002)"
        );
        address identityRegistry = mainnet ? MAINNET_IDENTITY_REGISTRY : TESTNET_IDENTITY_REGISTRY;
        address reputationRegistry = mainnet ? MAINNET_REPUTATION_REGISTRY : TESTNET_REPUTATION_REGISTRY;

        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");
        address safe = vm.envAddress("ARC_SAFE");
        uint256 maxBountyAmount = vm.envOr("MAX_BOUNTY_AMOUNT", uint256(500e6));
        // vm.addr(key), not msg.sender - see DeployBaseMainnet.s.sol's note.
        address deployer = vm.addr(deployerKey);

        _checkExternalContracts(identityRegistry, reputationRegistry);
        _checkSafe(safe, deployer);

        vm.startBroadcast(deployerKey);

        AgenticCommerce impl = new AgenticCommerce();
        escrow = AgenticCommerce(
            address(new ERC1967Proxy(address(impl), abi.encodeCall(AgenticCommerce.initialize, (USDC, feeRecipient, safe))))
        );
        // platformFeeBP / evaluatorFeeBP stay 0, which BountyAdapter's
        // balance-delta payout forwarding assumes. Only the Safe can change them.

        adapter = new BountyAdapter(
            address(escrow), identityRegistry, reputationRegistry, USDC, feeRecipient, 100, maxBountyAmount
        );
        adapter.setPaused(true);
        adapter.transferArbitrator(safe);
        adapter.transferOwner(safe);

        vm.stopBroadcast();

        _checkDeployment(safe, deployer);

        console.log(mainnet ? "network: Arc mainnet (5042)" : "network: Arc testnet REHEARSAL (5042002)");
        console.log("AgenticCommerce impl:", address(impl));
        console.log("AgenticCommerce proxy:", address(escrow));
        console.log("BountyAdapter (PAUSED):", address(adapter));
        // The fork block the script simulated against - never later than the
        // real deploy block, so it is a safe lower bound for log scans.
        console.log("adapterDeployBlock lower bound:", block.number);
        console.log("escrow admin + pending owner/arbitrator (Safe):", safe);
        console.log("owner/arbitrator until the Safe accepts (deployer):", deployer);
        console.log("fee recipient:", feeRecipient);
        console.log("maxBountyAmount (atomic):", maxBountyAmount);
    }

    /// @dev Fail before spending gas. Call the contracts rather than measure
    ///      them - code presence is what let Sepolia's registries ship to Base
    ///      mainnet once already (see DEPLOYMENTS.md).
    function _checkExternalContracts(address identityRegistry, address reputationRegistry) internal view {
        require(keccak256(bytes(IERC20MetadataView(USDC).symbol())) == keccak256("USDC"), "USDC symbol mismatch");
        require(IERC20MetadataView(USDC).decimals() == 6, "USDC decimals mismatch (expected 6 for the ERC-20 interface)");
        require(
            keccak256(bytes(IIdentityRegistryName(identityRegistry).name())) == keccak256("AgentIdentity"),
            "identity registry does not answer name() == AgentIdentity"
        );
        // getSummary reverts with its own reason ("clientAddresses required")
        // when the registry is live, and with no data at all from a dead proxy.
        (bool ok, bytes memory ret) = reputationRegistry.staticcall(
            abi.encodeWithSignature("getSummary(uint256,address[],string,string)", uint256(1), new address[](0), "", "")
        );
        require(!ok, "reputation registry: getSummary unexpectedly succeeded with no clients");
        require(ret.length > 0, "reputation registry does not answer getSummary - wrong address for this chain");
    }

    /// @dev The Safe receives the escrow's upgrade authority in the same
    ///      transaction that creates the escrow, so it has to be a real
    ///      multisig already - a typo would hand an unrecoverable role to a
    ///      dead address.
    function _checkSafe(address safe, address deployer) internal view {
        require(safe != deployer, "ARC_SAFE is the deployer itself");
        require(safe.code.length > 0, "ARC_SAFE has no code on this chain - create the Safe first");
        uint256 threshold = ISafeView(safe).getThreshold();
        require(threshold >= 2, "ARC_SAFE threshold is below 2 - not a multisig");
        require(ISafeView(safe).getOwners().length >= threshold, "ARC_SAFE owner count is below its threshold");
    }

    function _checkDeployment(address safe, address deployer) internal view {
        require(escrow.hasRole(escrow.DEFAULT_ADMIN_ROLE(), safe), "escrow upgrade authority did not land on the Safe");
        require(escrow.hasRole(escrow.ADMIN_ROLE(), safe), "escrow ADMIN_ROLE did not land on the Safe");
        require(!escrow.hasRole(escrow.DEFAULT_ADMIN_ROLE(), deployer), "deployer holds escrow upgrade authority");
        require(!escrow.hasRole(escrow.ADMIN_ROLE(), deployer), "deployer holds escrow ADMIN_ROLE");
        require(address(escrow.paymentToken()) == USDC, "escrow paymentToken is not USDC");
        require(address(adapter.agenticCommerce()) == address(escrow), "adapter is not wired to the new escrow");
        require(adapter.owner() == deployer, "adapter owner did not land on the deployer");
        require(adapter.arbitrator() == deployer, "adapter arbitrator did not land on the deployer");
        require(adapter.pendingOwner() == safe, "owner handoff to the Safe was not started");
        require(adapter.pendingArbitrator() == safe, "arbitrator handoff to the Safe was not started");
        require(adapter.paused(), "adapter did not deploy paused");
    }
}
