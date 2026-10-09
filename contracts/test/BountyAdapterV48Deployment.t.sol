// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "./BountyAdapterV48Contest.t.sol";
import "../script/BountyAdapterV48Deployment.s.sol";

contract DeploymentTokenHarness is MockUSDC {
    uint8 public decimals = 6;
    string public symbol = "USDC";

    function setMetadata(uint8 d, string calldata s) external {
        decimals = d;
        symbol = s;
    }
}

contract DeploymentIdentityHarness is MockV48IdentityRegistry {
    function name() external pure returns (string memory) {
        return "AgentIdentity";
    }
}

/// @dev Probe-compatible test double, not a deployable multisig implementation.
contract DeploymentSafeHarness {
    uint256 public threshold = 2;
    address[] private owners;

    constructor() {
        owners.push(address(0xA1));
        owners.push(address(0xA2));
        owners.push(address(0xA3));
    }

    function getThreshold() external view returns (uint256) {
        return threshold;
    }

    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    function setThreshold(uint256 t) external {
        threshold = t;
    }

    function setOwners(address[] memory next) external {
        owners = next;
    }

    function execute(address target, bytes calldata data) external {
        (bool ok, bytes memory reason) = target.call(data);
        if (!ok) assembly ("memory-safe") { revert(add(reason, 32), mload(reason)) }
    }
}

contract NadBountyV48DeployHarness is DeployNadBountyV48 {
    function deployForTest(NadBountyDeploymentChecks.Config calldata c)
        external
        returns (NadBountyDeploymentChecks.Deployment memory d)
    {
        d = deploy(c);
        NadBountyDeploymentChecks.prepared(d, c, address(this));
    }

    function verifyReady(NadBountyDeploymentChecks.Deployment calldata d, NadBountyDeploymentChecks.Config calldata c)
        external
        view
    {
        NadBountyDeploymentChecks.ready(d, c);
        bytes32 slot = bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1);
        require(address(uint160(uint256(vm.load(d.escrow, slot)))) == d.implementation, "escrow implementation slot");
    }

    function verifyPreflight(NadBountyDeploymentChecks.Config calldata c) external view {
        NadBountyDeploymentChecks.preflight(c);
    }
}

contract BountyAdapterV48DeploymentTest is Test {
    NadBountyV48DeployHarness internal factory;
    DeploymentTokenHarness internal usdc;
    DeploymentIdentityHarness internal identity;
    DeploymentSafeHarness internal safe;
    NadBountyDeploymentChecks.Config internal c;

    function setUp() public {
        vm.chainId(10143);
        usdc = new DeploymentTokenHarness();
        identity = new DeploymentIdentityHarness();
        safe = new DeploymentSafeHarness();
        identity.setOwner(1, address(0xA1));
        factory = NadBountyV48DeployHarness(deployCode("BountyAdapterV48Deployment.t.sol:NadBountyV48DeployHarness"));
        c = NadBountyDeploymentChecks.Config(
            10143,
            address(usdc),
            address(identity),
            address(new MockReputationRegistry()),
            address(safe),
            address(safe),
            address(0x1234),
            1
        );
    }

    function _handoff(NadBountyDeploymentChecks.Deployment memory d) internal {
        safe.execute(d.adapter, abi.encodeCall(BountyAdapterV48.acceptOwner, ()));
        safe.execute(d.adapter, abi.encodeCall(BountyAdapterV48.acceptArbitrator, ()));
    }

    function testPausedDeploymentHasZeroEscrowFeesAndOnlySafeEscrowRoles() public {
        NadBountyDeploymentChecks.Deployment memory d = factory.deployForTest(c);
        BountyAdapterV48 a = BountyAdapterV48(d.adapter);
        AgenticCommerce ac = AgenticCommerce(d.escrow);
        assertTrue(a.paused());
        assertEq(a.feeBps(), 100);
        assertEq(a.maxBountyAmount(), 100e6);
        assertEq(a.owner(), address(factory));
        assertEq(a.pendingOwner(), address(safe));
        assertEq(a.pendingArbitrator(), address(safe));
        assertTrue(ac.hasRole(bytes32(0), address(safe)));
        assertTrue(ac.hasRole(ac.ADMIN_ROLE(), address(safe)));
        assertFalse(ac.hasRole(bytes32(0), address(factory)));
        assertEq(ac.platformFeeBP(), 0);
        assertEq(ac.evaluatorFeeBP(), 0);
        assertEq(KeeperReceiver(d.keeper).adapter(), d.adapter);
        assertEq(ReputationMirror(d.mirror).owner(), address(safe));
    }

    function testReadBackRequiresBothSafeAcceptCallsAndStaysPaused() public {
        NadBountyDeploymentChecks.Deployment memory d = factory.deployForTest(c);
        vm.expectRevert("Safe handoffs incomplete");
        factory.verifyReady(d, c);
        safe.execute(d.adapter, abi.encodeCall(BountyAdapterV48.acceptOwner, ()));
        vm.expectRevert("Safe handoffs incomplete");
        factory.verifyReady(d, c);
        safe.execute(d.adapter, abi.encodeCall(BountyAdapterV48.acceptArbitrator, ()));
        factory.verifyReady(d, c);
        assertTrue(BountyAdapterV48(d.adapter).paused());
    }

    function testMainnetConfigurationUsesSamePausedDeploymentFlow() public {
        vm.chainId(143);
        c.chainId = 143;
        NadBountyDeploymentChecks.Deployment memory d = factory.deployForTest(c);
        _handoff(d);
        factory.verifyReady(d, c);
    }

    function testWrongAndNonMonadChainsFailPreflight() public {
        c.chainId = 143;
        vm.expectRevert("wrong chain");
        factory.verifyPreflight(c);
        c.chainId = 8453;
        vm.chainId(8453);
        vm.expectRevert("unsupported Monad chain");
        factory.deployForTest(c);
    }

    function testMissingDependencyCodeAndZeroFeeFailBeforeDeployment() public {
        address previous = c.usdc;
        c.usdc = address(0xB0B);
        vm.expectRevert("missing dependency code");
        factory.deployForTest(c);
        c.usdc = previous;
        c.feeRecipient = address(0);
        vm.expectRevert("invalid governance/fee");
        factory.deployForTest(c);
    }

    function testWrongTokenMetadataFailsPreflight() public {
        usdc.setMetadata(18, "USDC");
        vm.expectRevert("USDC decimals");
        factory.deployForTest(c);
        usdc.setMetadata(6, "USDT");
        vm.expectRevert("USDC symbol");
        factory.deployForTest(c);
    }

    function testSafeMustHaveThresholdTwoOfThreeDistinctOwners() public {
        safe.setThreshold(1);
        vm.expectRevert("Safe threshold must be 2");
        factory.verifyPreflight(c);
        safe.setThreshold(2);
        address[] memory owners = new address[](2);
        owners[0] = address(1);
        owners[1] = address(2);
        safe.setOwners(owners);
        vm.expectRevert("Safe must have 3 owners");
        factory.verifyPreflight(c);
        owners = new address[](3);
        owners[0] = address(1);
        owners[1] = address(1);
        owners[2] = address(2);
        safe.setOwners(owners);
        vm.expectRevert("duplicate Safe owner");
        factory.verifyPreflight(c);
        owners[1] = address(0);
        safe.setOwners(owners);
        vm.expectRevert("zero Safe owner");
        factory.verifyPreflight(c);
    }

    function testRegistryCodeAloneCannotPassPreflight() public {
        c.identity = address(usdc);
        vm.expectRevert();
        factory.deployForTest(c);
    }

    function testProbeIdentityAndWorkingWalletReadMustBeLive() public {
        c.probeAgentId = 0;
        vm.expectRevert("probe identity missing");
        factory.verifyPreflight(c);
        c.probeAgentId = 2;
        vm.expectRevert("unknown identity");
        factory.verifyPreflight(c);
        c.probeAgentId = 1;
        identity.setWalletUnavailable(true);
        vm.expectRevert("wallet read unavailable");
        factory.verifyPreflight(c);
    }

    function testReputationReadMustAnswerBeforeDeployment() public {
        vm.mockCallRevert(
            c.reputation, abi.encodeWithSelector(IReputationRegistry.getSummary.selector), "registry unavailable"
        );
        vm.expectRevert("registry unavailable");
        factory.deployForTest(c);
    }

    function testZeroRelayerDeploysBothReceiversDisabled() public {
        c.relayer = address(0);
        NadBountyDeploymentChecks.Deployment memory d = factory.deployForTest(c);
        assertEq(KeeperReceiver(d.keeper).relayer(), address(0));
        assertEq(ReputationMirror(d.mirror).relayer(), address(0));
        _handoff(d);
        factory.verifyReady(d, c);
    }

    function testReadBackRejectsUnpausedOrRaisedCapConfiguration() public {
        NadBountyDeploymentChecks.Deployment memory d = factory.deployForTest(c);
        _handoff(d);
        safe.execute(d.adapter, abi.encodeCall(BountyAdapterV48.setPaused, (false)));
        vm.expectRevert("adapter launch safety");
        factory.verifyReady(d, c);
        safe.execute(d.adapter, abi.encodeCall(BountyAdapterV48.setPaused, (true)));
        safe.execute(d.adapter, abi.encodeCall(BountyAdapterV48.setMaxBountyAmount, (101e6)));
        vm.expectRevert("adapter launch safety");
        factory.verifyReady(d, c);
    }

    function testReadBackRejectsWrongImplementationAndRelayer() public {
        NadBountyDeploymentChecks.Deployment memory d = factory.deployForTest(c);
        _handoff(d);
        address previous = d.implementation;
        d.implementation = address(usdc);
        vm.expectRevert("escrow implementation slot");
        factory.verifyReady(d, c);
        d.implementation = previous;
        c.relayer = address(0x999);
        vm.expectRevert("mirror governance");
        factory.verifyReady(d, c);
    }

    function testReadBackRejectsEscrowFeesOrEnabledForwarder() public {
        NadBountyDeploymentChecks.Deployment memory d = factory.deployForTest(c);
        _handoff(d);
        safe.execute(d.escrow, abi.encodeCall(AgenticCommerce.setPlatformFee, (1, c.feeRecipient)));
        vm.expectRevert("escrow fees must be zero");
        factory.verifyReady(d, c);
        safe.execute(d.escrow, abi.encodeCall(AgenticCommerce.setPlatformFee, (0, c.feeRecipient)));
        safe.execute(d.escrow, abi.encodeCall(AgenticCommerce.setEvaluatorFee, (1)));
        vm.expectRevert("escrow fees must be zero");
        factory.verifyReady(d, c);
        safe.execute(d.escrow, abi.encodeCall(AgenticCommerce.setEvaluatorFee, (0)));
        safe.execute(d.mirror, abi.encodeCall(ReputationMirror.setForwarder, (address(0x999), keccak256("workflow"))));
        vm.expectRevert("mirror forwarder must be disabled");
        factory.verifyReady(d, c);
    }
}
