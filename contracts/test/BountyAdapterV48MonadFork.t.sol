// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Test.sol";
import "../src/monad/BountyAdapterV48.sol";
import "../src/base/AgenticCommerce.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice Opt-in read/write simulation on a pinned Monad fork. Never broadcasts.
/// @dev No RPC means explicitly skipped tests, not a passing fork result.
///      Run with Monad-aware Foundry; monad_local alone is not gas validation.
interface IMonadForkIdentityActions {
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external;
    function transferFrom(address from, address to, uint256 agentId) external;
}

contract BountyAdapterV48MonadForkTest is Test {
    BountyAdapterV48 internal adapter;
    IERC20 internal token;
    IMonadIdentityRegistry internal identity;
    IReputationRegistry internal reputation;
    uint256 internal agentId;
    address internal owner;
    address internal working;
    address internal poster;
    address internal fee;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        uint256 atBlock = vm.envUint("MONAD_FORK_BLOCK");
        require(atBlock != 0, "pin a nonzero fork block");
        vm.createSelectFork(rpc, atBlock);
        uint256 chainId = vm.envUint("MONAD_CHAIN_ID");
        require((chainId == 143 || chainId == 10143) && block.chainid == chainId, "wrong Monad fork");
        token = IERC20(vm.envAddress("MONAD_USDC"));
        identity = IMonadIdentityRegistry(vm.envAddress("MONAD_IDENTITY_REGISTRY"));
        reputation = IReputationRegistry(vm.envAddress("MONAD_REPUTATION_REGISTRY"));
        require(
            address(token).code.length != 0 && address(identity).code.length != 0
                && address(reputation).code.length != 0,
            "missing live dependencies"
        );
        agentId = vm.envUint("MONAD_PROBE_AGENT_ID");
        require(agentId != 0, "probe identity missing");
        owner = identity.ownerOf(agentId);
        working = identity.getAgentWallet(agentId);
        require(owner != address(0), "probe owner missing");
        poster = makeAddr("fork poster");
        fee = makeAddr("fork fee");
        require(owner != poster && working != poster, "probe collides with poster");
        AgenticCommerce implementation = new AgenticCommerce();
        address escrow = address(
            new ERC1967Proxy(
                address(implementation),
                abi.encodeCall(AgenticCommerce.initialize, (address(token), fee, address(this)))
            )
        );
        adapter = BountyAdapterV48(
            deployCode(
                "BountyAdapterV48.sol:BountyAdapterV48",
                abi.encode(
                    escrow,
                    address(identity),
                    address(reputation),
                    address(token),
                    fee,
                    address(new ReputationMirror(address(this), address(0)))
                )
            )
        );
        adapter.setPaused(false);
        // Fork-only storage funding, not evidence of a live faucet or funded deployment.
        deal(address(token), poster, 100e6);
        vm.prank(poster);
        require(token.approve(address(adapter), type(uint256).max), "approve failed");
    }

    function _create(bool contest) internal returns (uint256 job) {
        BountyAdapterV48.CreateParams memory p;
        p.reward = 10e6;
        p.deadline = block.timestamp + 7 days;
        p.ipfsDescHash = "ipfs://fork-description";
        p.category = "dev";
        p.tags = new string[](0);
        p.contest = contest;
        p.maxEntries = 3;
        p.winners = 1;
        vm.prank(poster);
        job = adapter.createBounty(p);
    }

    function _pick(uint256 job) internal {
        uint8[] memory indices = new uint8[](1);
        uint8[] memory scores = new uint8[](1);
        scores[0] = 90;
        vm.prank(poster);
        adapter.pickContestWinners(job, indices, scores);
    }

    function _assertFeedback() internal view {
        address[] memory clients = new address[](1);
        clients[0] = address(adapter);
        (uint64 count, int128 value, uint8 decimals) = reputation.getSummary(agentId, clients, "bounty_completed", "");
        // Adapter deliberately catches registry write failures. This assertion
        // proves the real write succeeded instead of just proving settlement.
        assertEq(count, 1, "real registry did not record feedback");
        assertEq(value, 90);
        assertEq(decimals, 0);
    }

    function testForkOwnerContestPaysOwnerAndWritesRealFeedback() public {
        uint256 beforeBalance = token.balanceOf(owner);
        uint256 job = _create(true);
        vm.prank(owner);
        adapter.enterContest(job, agentId, "ipfs://fork-result");
        _pick(job);
        assertEq(token.balanceOf(owner) - beforeBalance, 9.9e6);
        assertEq(token.balanceOf(fee), 0.1e6);
        _assertFeedback();
    }

    function testForkWorkingWalletContestPaysCurrentOwner() public {
        _setForkWorkingWallet(0xA11CE);
        uint256 ownerBefore = token.balanceOf(owner);
        uint256 workingBefore = token.balanceOf(working);
        uint256 job = _create(true);
        vm.prank(working);
        adapter.enterContest(job, agentId, "ipfs://fork-result");
        _pick(job);
        assertEq(token.balanceOf(owner) - ownerBefore, 9.9e6);
        assertEq(token.balanceOf(working), workingBefore);
        _assertFeedback();
    }

    /// @dev Uses the live registry's signature validation, only in the fork.
    function _setForkWorkingWallet(uint256 walletKey) internal {
        working = vm.addr(walletKey);
        uint256 deadline = block.timestamp + 5 minutes;
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ERC8004IdentityRegistry"),
                keccak256("1"),
                block.chainid,
                address(identity)
            )
        );
        bytes32 body = keccak256(
            abi.encode(
                keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)"),
                agentId,
                working,
                owner,
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(walletKey, keccak256(abi.encodePacked("\x19\x01", domain, body)));
        vm.prank(owner);
        IMonadForkIdentityActions(address(identity))
            .setAgentWallet(agentId, working, deadline, abi.encodePacked(r, s, v));
        assertEq(identity.getAgentWallet(agentId), working);
    }

    function testForkWalletRotationRevokesOldKey() public {
        _setForkWorkingWallet(0xA11CE);
        address previous = working;
        uint256 job = _create(true);
        vm.prank(working);
        adapter.enterContest(job, agentId, "ipfs://fork-result");
        _setForkWorkingWallet(0xB0B);
        vm.prank(previous);
        vm.expectRevert();
        adapter.replaceContestEntry(job, 0, "ipfs://revoked");
        vm.prank(working);
        adapter.replaceContestEntry(job, 0, "ipfs://rotated");
        _pick(job);
        _assertFeedback();
    }

    function testForkIdentityTransferClearsWalletAndRedirectsPayout() public {
        _setForkWorkingWallet(0xA11CE);
        uint256 job = _create(true);
        vm.prank(working);
        adapter.enterContest(job, agentId, "ipfs://fork-result");
        address nextOwner = makeAddr("fork next identity owner");
        uint256 beforeBalance = token.balanceOf(nextOwner);
        vm.prank(owner);
        IMonadForkIdentityActions(address(identity)).transferFrom(owner, nextOwner, agentId);
        assertEq(identity.ownerOf(agentId), nextOwner);
        assertEq(identity.getAgentWallet(agentId), address(0));
        vm.prank(working);
        vm.expectRevert();
        adapter.replaceContestEntry(job, 0, "ipfs://revoked");
        _pick(job);
        assertEq(token.balanceOf(nextOwner) - beforeBalance, 9.9e6);
        _assertFeedback();
    }

    function testForkSingleTakerOwnerPaysOwnerAndWritesRealFeedback() public {
        uint256 beforeBalance = token.balanceOf(owner);
        uint256 job = _create(false);
        vm.prank(owner);
        adapter.takeBounty(job, agentId);
        vm.prank(owner);
        adapter.submitWork(job, "ipfs://fork-result");
        vm.prank(poster);
        adapter.approveBounty(job, 90);
        assertEq(token.balanceOf(owner) - beforeBalance, 9.9e6);
        _assertFeedback();
    }
}
