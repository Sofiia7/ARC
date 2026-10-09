// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Script.sol";
import "../src/monad/BountyAdapterV48.sol";
import "../src/monad/KeeperReceiver.sol";
import "../src/base/AgenticCommerce.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

interface IMonadTokenProbe {
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}

interface IMonadSafeProbe {
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
}

/// @dev Shared, testable preflight and read-back. No private keys or RPC URLs.
library NadBountyDeploymentChecks {
    struct Config {
        uint256 chainId;
        address usdc;
        address identity;
        address reputation;
        address safe;
        address feeRecipient;
        address relayer;
        uint256 probeAgentId;
    }

    struct Deployment {
        address implementation;
        address escrow;
        address adapter;
        address mirror;
        address keeper;
    }

    function preflight(Config memory c) internal view {
        require(c.chainId == 143 || c.chainId == 10143, "unsupported Monad chain");
        require(block.chainid == c.chainId, "wrong chain");
        require(
            c.usdc.code.length != 0 && c.identity.code.length != 0 && c.reputation.code.length != 0,
            "missing dependency code"
        );
        require(c.safe.code.length != 0 && c.feeRecipient != address(0), "invalid governance/fee");
        require(IMonadSafeProbe(c.safe).getThreshold() == 2, "Safe threshold must be 2");
        address[] memory owners = IMonadSafeProbe(c.safe).getOwners();
        require(owners.length == 3, "Safe must have 3 owners");
        for (uint256 i; i < owners.length; ++i) {
            require(owners[i] != address(0), "zero Safe owner");
            for (uint256 j; j < i; ++j) {
                require(owners[i] != owners[j], "duplicate Safe owner");
            }
        }
        require(IMonadTokenProbe(c.usdc).decimals() == 6, "USDC decimals");
        require(keccak256(bytes(IMonadTokenProbe(c.usdc).symbol())) == keccak256("USDC"), "USDC symbol");
        require(
            c.probeAgentId != 0 && IMonadIdentityRegistry(c.identity).ownerOf(c.probeAgentId) != address(0),
            "probe identity missing"
        );
        // A working-wallet read must answer even when its value is legitimately zero.
        IMonadIdentityRegistry(c.identity).getAgentWallet(c.probeAgentId);
        address[] memory clients = new address[](1);
        clients[0] = c.safe;
        IReputationRegistry(c.reputation).getSummary(c.probeAgentId, clients, "bounty_completed", "");
    }

    function common(Deployment memory d, Config memory c) internal view {
        preflight(c);
        require(
            d.implementation.code.length != 0 && d.escrow.code.length != 0 && d.adapter.code.length != 0
                && d.mirror.code.length != 0 && d.keeper.code.length != 0,
            "missing deployed code"
        );
        escrowChecks(d, c);
        adapterChecks(d, c);
        receiverChecks(d, c);
    }

    function escrowChecks(Deployment memory d, Config memory c) private view {
        AgenticCommerce ac = AgenticCommerce(d.escrow);
        require(address(ac.paymentToken()) == c.usdc && ac.platformTreasury() == c.feeRecipient, "escrow wiring");
        require(ac.platformFeeBP() == 0 && ac.evaluatorFeeBP() == 0, "escrow fees must be zero");
        require(ac.hasRole(bytes32(0), c.safe) && ac.hasRole(ac.ADMIN_ROLE(), c.safe), "escrow Safe roles");
    }

    function adapterChecks(Deployment memory d, Config memory c) private view {
        BountyAdapterV48 a = BountyAdapterV48(d.adapter);
        require(address(a.agenticCommerce()) == d.escrow && address(a.usdc()) == c.usdc, "adapter escrow/token");
        require(
            address(a.identityRegistry()) == c.identity && address(a.reputationRegistry()) == c.reputation
                && address(a.reputationMirror()) == d.mirror,
            "adapter registries"
        );
        require(
            a.paused() && a.feeBps() == 100 && a.maxBountyAmount() == 100e6 && a.feeRecipient() == c.feeRecipient,
            "adapter launch safety"
        );
    }

    function receiverChecks(Deployment memory d, Config memory c) private view {
        ReputationMirror m = ReputationMirror(d.mirror);
        KeeperReceiver k = KeeperReceiver(d.keeper);
        require(m.owner() == c.safe && m.pendingOwner() == address(0) && m.relayer() == c.relayer, "mirror governance");
        require(m.forwarder() == address(0) && m.workflowId() == bytes32(0), "mirror forwarder must be disabled");
        require(k.owner() == c.safe && k.pendingOwner() == address(0) && k.relayer() == c.relayer, "keeper governance");
        require(k.adapter() == d.adapter && k.adapterKind() == KeeperReceiver.AdapterKind.MonadV48, "keeper target");
        require(k.forwarder() == address(0) && k.workflowId() == bytes32(0), "keeper forwarder must be disabled");
    }

    function prepared(Deployment memory d, Config memory c, address deployer) internal view {
        common(d, c);
        BountyAdapterV48 a = BountyAdapterV48(d.adapter);
        require(deployer != c.safe, "deployer must differ from Safe");
        require(
            a.owner() == deployer && a.arbitrator() == deployer && a.pendingOwner() == c.safe
                && a.pendingArbitrator() == c.safe,
            "pending Safe handoffs"
        );
        AgenticCommerce ac = AgenticCommerce(d.escrow);
        require(
            !ac.hasRole(bytes32(0), deployer) && !ac.hasRole(ac.ADMIN_ROLE(), deployer), "deployer escrow privileges"
        );
    }

    function ready(Deployment memory d, Config memory c) internal view {
        common(d, c);
        BountyAdapterV48 a = BountyAdapterV48(d.adapter);
        require(
            a.owner() == c.safe && a.arbitrator() == c.safe && a.pendingOwner() == address(0)
                && a.pendingArbitrator() == address(0),
            "Safe handoffs incomplete"
        );
    }
}

/// @notice Paused deployment only, chain 143 or rehearsal 10143. Never unpauses.
/// @dev Safe must already exist. Its two adapter accept calls are a separate
///      Safe transaction; ReadBackNadBountyV48 refuses readiness until they land.
contract DeployNadBountyV48 is Script {
    function config() internal view returns (NadBountyDeploymentChecks.Config memory c) {
        c.chainId = vm.envUint("MONAD_CHAIN_ID");
        c.usdc = vm.envAddress("MONAD_USDC");
        c.identity = vm.envAddress("MONAD_IDENTITY_REGISTRY");
        c.reputation = vm.envAddress("MONAD_REPUTATION_REGISTRY");
        c.safe = vm.envAddress("MONAD_SAFE");
        c.feeRecipient = vm.envAddress("MONAD_FEE_RECIPIENT");
        c.relayer = vm.envOr("MONAD_RELAYER", address(0));
        c.probeAgentId = vm.envUint("MONAD_PROBE_AGENT_ID");
    }

    function deploy(NadBountyDeploymentChecks.Config memory c)
        internal
        returns (NadBountyDeploymentChecks.Deployment memory d)
    {
        NadBountyDeploymentChecks.preflight(c);
        d.implementation = address(new AgenticCommerce());
        d.escrow = address(
            new ERC1967Proxy(
                d.implementation, abi.encodeCall(AgenticCommerce.initialize, (c.usdc, c.feeRecipient, c.safe))
            )
        );
        d.mirror = address(new ReputationMirror(c.safe, c.relayer));
        BountyAdapterV48 a = new BountyAdapterV48(d.escrow, c.identity, c.reputation, c.usdc, c.feeRecipient, d.mirror);
        d.adapter = address(a);
        d.keeper = address(new KeeperReceiver(c.safe, c.relayer, d.adapter, KeeperReceiver.AdapterKind.MonadV48));
        a.transferOwner(c.safe);
        a.transferArbitrator(c.safe);
    }

    function run() external virtual returns (NadBountyDeploymentChecks.Deployment memory d) {
        NadBountyDeploymentChecks.Config memory c = config();
        NadBountyDeploymentChecks.preflight(c);
        uint256 key = vm.envUint("MONAD_DEPLOYER_KEY");
        address deployer = vm.addr(key);
        require(deployer != c.safe, "deployer must differ from Safe");
        vm.startBroadcast(key);
        d = deploy(c);
        vm.stopBroadcast();
        NadBountyDeploymentChecks.prepared(d, c, deployer);
        console.log("implementation", d.implementation);
        console.log("escrow", d.escrow);
        console.log("adapter (paused)", d.adapter);
        console.log("mirror", d.mirror);
        console.log("keeper", d.keeper);
        console.log("Safe: acceptOwner() and acceptArbitrator() on adapter", c.safe);
    }
}

contract ReadBackNadBountyV48 is DeployNadBountyV48 {
    /// @notice Read-only verification. No signing key is loaded and no broadcast.
    function run() external view override returns (NadBountyDeploymentChecks.Deployment memory d) {
        NadBountyDeploymentChecks.Config memory c = config();
        d.implementation = vm.envAddress("MONAD_ESCROW_IMPLEMENTATION");
        d.escrow = vm.envAddress("MONAD_ESCROW");
        d.adapter = vm.envAddress("MONAD_ADAPTER");
        d.mirror = vm.envAddress("MONAD_MIRROR");
        d.keeper = vm.envAddress("MONAD_KEEPER");
        NadBountyDeploymentChecks.ready(d, c);
        bytes32 slot = bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1);
        require(address(uint160(uint256(vm.load(d.escrow, slot)))) == d.implementation, "escrow implementation slot");
        console.log("Paused configuration and completed Safe handoffs verified", d.adapter);
    }
}
