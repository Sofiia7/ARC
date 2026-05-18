// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IAgenticCommerce.sol";
import "./interfaces/IIdentityRegistry.sol";
import "./interfaces/IReputationRegistry.sol";

/// @title BountyAdapter (Variant B+)
/// @notice Bounty-board facade over Arc ERC-8183 AgenticCommerce.
///         The adapter takes all three AC roles (client + provider + evaluator);
///         the real worker is tracked in BountyMeta.assignedProvider. AC remains
///         the escrow rail. Payouts are forwarded via balance-delta accounting.
contract BountyAdapter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IAgenticCommerce    public immutable agenticCommerce;
    IIdentityRegistry   public immutable identityRegistry;
    IReputationRegistry public immutable reputationRegistry;
    IERC20              public immutable usdc;

    address public immutable feeRecipient;
    address public           arbitrator;
    address public           pendingArbitrator;
    uint256 public immutable feeBps;
    uint256 public constant  BPS_DENOMINATOR = 10_000;
    uint256 public constant  MIN_REWARD = 1e6;
    uint256 public constant  DISPUTE_RESPONSE_WINDOW = 48 hours;

    struct CreateParams {
        address  provider;     // 0x0 = open. If non-zero, only this address (or owner of agentId) can take.
        uint256  reward;
        uint256  deadline;
        string   ipfsDescHash;
        string   category;
        string[] tags;
        bool     agentOnly;
        bool     humanOnly;
    }

    struct BountyMeta {
        uint256  jobId;
        address  poster;
        uint256  reward;              // net (after fee)
        uint256  deadline;
        string   ipfsDescHash;
        string   category;
        string[] tags;
        uint256  agentId;
        bool     agentOnly;
        bool     humanOnly;
        address  whitelistedProvider; // if set, only this address may take
        address  assignedProvider;
        string   submittedResultHash;
        bool     isTaken;
        // Dispute state
        bool     inDispute;
        bool     resolved;
        address  disputeInitiator;
        uint256  disputeRaisedAt;
        string   disputeReasonHash;
        string   disputeResponseHash;
        string   disputeRulingHash;
    }

    mapping(uint256 => BountyMeta) private _bounties;
    uint256[] public allJobIds;

    event BountyCreated(uint256 indexed jobId, address indexed poster, uint256 reward, string category, uint256 deadline);
    event BountyTaken(uint256 indexed jobId, address indexed provider, uint256 agentId);
    event WorkSubmitted(uint256 indexed jobId, address indexed provider, string ipfsResultHash);
    event BountyCompleted(uint256 indexed jobId, uint256 agentId, uint256 reputationScore);
    event BountyCancelled(uint256 indexed jobId, string reason);
    event BountyExpired(uint256 indexed jobId);

    event DisputeRaised(uint256 indexed jobId, address indexed initiator, string reasonHash);
    event DisputeResponded(uint256 indexed jobId, address indexed responder, string responseHash);
    event DisputeResolved(uint256 indexed jobId, bool payProvider, string rulingHash, bool defaultRuling);
    event ArbitratorTransferStarted(address indexed previous, address indexed pending);
    event ArbitratorTransferred(address indexed previous, address indexed next);

    constructor(
        address _agenticCommerce,
        address _identityRegistry,
        address _reputationRegistry,
        address _usdc,
        address _feeRecipient,
        uint256 _feeBps
    ) {
        require(_agenticCommerce    != address(0), "ac=0");
        require(_identityRegistry   != address(0), "id=0");
        require(_reputationRegistry != address(0), "rep=0");
        require(_usdc               != address(0), "usdc=0");
        require(_feeRecipient       != address(0), "fee=0");
        require(_feeBps <= 1000, "fee too high");

        agenticCommerce    = IAgenticCommerce(_agenticCommerce);
        identityRegistry   = IIdentityRegistry(_identityRegistry);
        reputationRegistry = IReputationRegistry(_reputationRegistry);
        usdc               = IERC20(_usdc);
        feeRecipient       = _feeRecipient;
        arbitrator         = msg.sender;
        feeBps             = _feeBps;
    }

    // ─── Lifecycle ─────────────────────────────────────────────────────────────

    function createBounty(CreateParams calldata p) external nonReentrant returns (uint256 jobId) {
        require(p.reward >= MIN_REWARD, "reward too low");
        require(p.deadline > block.timestamp, "deadline in past");
        require(bytes(p.ipfsDescHash).length > 0, "empty ipfs hash");
        require(_validCategory(p.category), "invalid category");
        require(!(p.agentOnly && p.humanOnly), "agentOnly+humanOnly");
        require(p.tags.length <= 10, "too many tags");
        for (uint256 i = 0; i < p.tags.length; i++) {
            require(bytes(p.tags[i]).length <= 32, "tag too long");
        }

        require(usdc.allowance(msg.sender, address(this)) >= p.reward, "insufficient USDC allowance");
        usdc.safeTransferFrom(msg.sender, address(this), p.reward);

        uint256 fee = (p.reward * feeBps) / BPS_DENOMINATOR;
        uint256 netReward = p.reward - fee;
        if (fee > 0) {
            usdc.safeTransfer(feeRecipient, fee);
        }

        // Adapter is provider + evaluator. Real worker tracked separately.
        jobId = agenticCommerce.createJob(address(this), address(this), p.deadline, p.ipfsDescHash, address(0));
        agenticCommerce.setBudget(jobId, netReward, bytes(""));

        BountyMeta storage meta = _bounties[jobId];
        meta.jobId               = jobId;
        meta.poster              = msg.sender;
        meta.reward              = netReward;
        meta.deadline            = p.deadline;
        meta.ipfsDescHash        = p.ipfsDescHash;
        meta.category            = p.category;
        meta.agentOnly           = p.agentOnly;
        meta.humanOnly           = p.humanOnly;
        meta.whitelistedProvider = p.provider;
        for (uint256 i = 0; i < p.tags.length; i++) {
            meta.tags.push(p.tags[i]);
        }
        allJobIds.push(jobId);

        emit BountyCreated(jobId, msg.sender, netReward, p.category, p.deadline);
    }

    function takeBounty(uint256 jobId, uint256 agentId) external nonReentrant {
        BountyMeta storage meta = _bounties[jobId];
        require(meta.poster != address(0), "bounty not found");
        require(!meta.isTaken, "already taken");
        require(block.timestamp <= meta.deadline, "bounty expired");

        if (meta.whitelistedProvider != address(0)) {
            require(meta.whitelistedProvider == msg.sender, "not whitelisted");
        }

        if (meta.agentOnly) {
            require(agentId != 0, "agent only: provide agentId");
        }
        if (meta.humanOnly) {
            require(agentId == 0, "human only: no agentId");
        }
        if (agentId != 0) {
            require(identityRegistry.isRegistered(agentId), "agent not registered");
            require(identityRegistry.ownerOf(agentId) == msg.sender, "agent only: caller is not agent owner");
            meta.agentId = agentId;
        }

        meta.isTaken          = true;
        meta.assignedProvider = msg.sender;

        // Fund the AC escrow now (adapter is the client).
        usdc.forceApprove(address(agenticCommerce), meta.reward);
        agenticCommerce.fund(jobId, bytes(""));

        emit BountyTaken(jobId, msg.sender, agentId);
    }

    function submitWork(uint256 jobId, string calldata ipfsResultHash) external nonReentrant {
        BountyMeta storage meta = _bounties[jobId];
        require(meta.assignedProvider == msg.sender, "not assigned provider");
        require(bytes(ipfsResultHash).length > 0, "empty result hash");
        require(block.timestamp <= meta.deadline, "bounty expired");
        require(bytes(meta.submittedResultHash).length == 0, "already submitted");

        meta.submittedResultHash = ipfsResultHash;
        bytes32 deliverable = keccak256(abi.encodePacked(ipfsResultHash));
        agenticCommerce.submit(jobId, deliverable, bytes(""));

        emit WorkSubmitted(jobId, msg.sender, ipfsResultHash);
    }

    function approveBounty(uint256 jobId, uint8 reputationScore) external nonReentrant {
        BountyMeta storage meta = _bounties[jobId];
        require(meta.poster == msg.sender, "only poster");
        require(bytes(meta.submittedResultHash).length > 0, "no submission");
        require(!meta.inDispute, "in dispute");
        require(!meta.resolved, "resolved");
        require(reputationScore <= 100, "score>100");

        meta.resolved = true;
        _completeAndForward(jobId, meta.assignedProvider, "approved");

        if (meta.agentId > 0) {
            reputationRegistry.giveFeedback(
                meta.agentId, reputationScore, 0, "bounty_completed",
                "", "", "", keccak256(abi.encodePacked("bounty_completed", jobId))
            );
        }

        emit BountyCompleted(jobId, meta.agentId, reputationScore);
    }

    function rejectBounty(uint256 jobId, string calldata reason) external nonReentrant {
        BountyMeta storage meta = _bounties[jobId];
        require(meta.poster == msg.sender, "only poster");
        require(bytes(meta.submittedResultHash).length > 0, "no submission");
        require(!meta.inDispute, "in dispute");
        require(!meta.resolved, "resolved");

        meta.resolved = true;
        _rejectAndRefund(jobId, reason);
        emit BountyCancelled(jobId, reason);
    }

    function cancelBounty(uint256 jobId) external nonReentrant {
        BountyMeta storage meta = _bounties[jobId];
        require(meta.poster == msg.sender, "only poster");
        require(!meta.isTaken, "already taken, cannot cancel");
        require(!meta.resolved, "resolved");

        meta.resolved = true;
        // Funds never left adapter (AC not funded until takeBounty). Direct refund.
        usdc.safeTransfer(meta.poster, meta.reward);
        emit BountyCancelled(jobId, "cancelled by poster");
    }

    function expireBounty(uint256 jobId) external nonReentrant {
        BountyMeta storage meta = _bounties[jobId];
        require(meta.poster != address(0), "bounty not found");
        require(block.timestamp > meta.deadline, "not expired yet");
        require(!meta.resolved, "resolved");
        require(bytes(meta.submittedResultHash).length == 0, "has submission");

        meta.resolved = true;
        if (meta.isTaken) {
            // Funds in AC escrow — reject to pull them back, then forward to poster.
            _rejectAndRefund(jobId, "expired");
        } else {
            // Never funded AC — refund directly.
            usdc.safeTransfer(meta.poster, meta.reward);
        }
        emit BountyExpired(jobId);
    }

    // ─── Disputes ──────────────────────────────────────────────────────────────

    function disputeBounty(uint256 jobId, string calldata ipfsReasonHash) external nonReentrant {
        BountyMeta storage meta = _bounties[jobId];
        require(meta.poster != address(0), "bounty not found");
        require(msg.sender == meta.poster || msg.sender == meta.assignedProvider, "unauthorized");
        require(bytes(meta.submittedResultHash).length > 0, "no submission");
        require(!meta.inDispute, "already in dispute");
        require(!meta.resolved, "resolved");
        require(bytes(ipfsReasonHash).length > 0, "empty reason");

        meta.inDispute         = true;
        meta.disputeInitiator  = msg.sender;
        meta.disputeRaisedAt   = block.timestamp;
        meta.disputeReasonHash = ipfsReasonHash;

        emit DisputeRaised(jobId, msg.sender, ipfsReasonHash);
    }

    function respondToDispute(uint256 jobId, string calldata ipfsResponseHash) external nonReentrant {
        BountyMeta storage meta = _bounties[jobId];
        require(meta.inDispute, "not in dispute");
        require(!meta.resolved, "resolved");
        require(bytes(meta.disputeResponseHash).length == 0, "already responded");
        require(bytes(ipfsResponseHash).length > 0, "empty response");
        require(
            block.timestamp <= meta.disputeRaisedAt + DISPUTE_RESPONSE_WINDOW,
            "response window closed"
        );

        // Must be the OTHER party
        address other = meta.disputeInitiator == meta.poster
            ? meta.assignedProvider
            : meta.poster;
        require(msg.sender == other, "not the respondent");

        meta.disputeResponseHash = ipfsResponseHash;
        emit DisputeResponded(jobId, msg.sender, ipfsResponseHash);
    }

    function resolveDispute(
        uint256 jobId,
        bool    payProvider,
        string  calldata ipfsRulingHash,
        uint8   reputationPenalty
    ) external nonReentrant {
        require(msg.sender == arbitrator, "only arbitrator");
        BountyMeta storage meta = _bounties[jobId];
        require(meta.inDispute, "not in dispute");
        require(!meta.resolved, "resolved");
        require(bytes(ipfsRulingHash).length > 0, "empty ruling");
        require(reputationPenalty <= 100, "penalty>100");

        meta.resolved          = true;
        meta.inDispute         = false;
        meta.disputeRulingHash = ipfsRulingHash;

        _finalizeDispute(jobId, payProvider, false);
        _maybePenalize(meta, payProvider, reputationPenalty);

        emit DisputeResolved(jobId, payProvider, ipfsRulingHash, false);
    }

    /// @notice After 48h with no response, anyone may claim the default ruling
    ///         in favor of the dispute initiator. Encodes the policy that silence = forfeit.
    function claimDefaultRuling(uint256 jobId) external nonReentrant {
        BountyMeta storage meta = _bounties[jobId];
        require(meta.inDispute, "not in dispute");
        require(!meta.resolved, "resolved");
        require(bytes(meta.disputeResponseHash).length == 0, "respondent replied");
        require(
            block.timestamp > meta.disputeRaisedAt + DISPUTE_RESPONSE_WINDOW,
            "window still open"
        );

        meta.resolved          = true;
        meta.inDispute         = false;
        meta.disputeRulingHash = "default:no-response";

        // Initiator wins. If poster opened the dispute → refund poster (payProvider=false).
        // If provider opened the dispute → pay provider (payProvider=true).
        bool payProvider = meta.disputeInitiator == meta.assignedProvider;
        _finalizeDispute(jobId, payProvider, true);

        emit DisputeResolved(jobId, payProvider, meta.disputeRulingHash, true);
    }

    function _finalizeDispute(uint256 jobId, bool payProvider, bool /*isDefault*/) internal {
        BountyMeta storage meta = _bounties[jobId];
        if (payProvider) {
            _completeAndForward(jobId, meta.assignedProvider, "dispute:provider");
        } else {
            _rejectAndRefund(jobId, "dispute:poster");
        }
    }

    function _maybePenalize(BountyMeta storage meta, bool payProvider, uint8 penalty) internal {
        if (payProvider || meta.agentId == 0 || penalty == 0) return;
        reputationRegistry.giveFeedback(
            meta.agentId, penalty, 0, "bounty_failed",
            "", "", "", keccak256(abi.encodePacked("dispute_rejected", meta.jobId))
        );
    }

    // ─── Internal payout helpers (balance-delta accounting) ────────────────────

    function _completeAndForward(uint256 jobId, address payee, string memory reason) internal {
        uint256 before = usdc.balanceOf(address(this));
        agenticCommerce.complete(jobId, keccak256(abi.encodePacked(reason)), bytes(reason));
        uint256 received = usdc.balanceOf(address(this)) - before;
        if (received > 0) {
            usdc.safeTransfer(payee, received);
        }
    }

    function _rejectAndRefund(uint256 jobId, string memory reason) internal {
        BountyMeta storage meta = _bounties[jobId];
        uint256 before = usdc.balanceOf(address(this));
        agenticCommerce.reject(jobId, keccak256(abi.encodePacked(reason)), bytes(reason));
        uint256 received = usdc.balanceOf(address(this)) - before;
        if (received > 0) {
            usdc.safeTransfer(meta.poster, received);
        }
    }

    // ─── Arbitrator transfer (2-step) ──────────────────────────────────────────

    function transferArbitrator(address next) external {
        require(msg.sender == arbitrator, "only arbitrator");
        require(next != address(0), "next=0");
        pendingArbitrator = next;
        emit ArbitratorTransferStarted(arbitrator, next);
    }

    function acceptArbitrator() external {
        require(msg.sender == pendingArbitrator, "not pending");
        address prev = arbitrator;
        arbitrator = pendingArbitrator;
        pendingArbitrator = address(0);
        emit ArbitratorTransferred(prev, arbitrator);
    }

    // ─── Views ─────────────────────────────────────────────────────────────────

    function bounties(uint256 jobId) external view returns (BountyMeta memory) {
        return _bounties[jobId];
    }

    function getBountyMeta(uint256 jobId) external view returns (BountyMeta memory) {
        return _bounties[jobId];
    }

    function getOpenBounties(
        string calldata category,
        uint256 offset,
        uint256 limit
    ) external view returns (uint256[] memory result) {
        bool filterCategory = bytes(category).length > 0;
        bytes32 categoryHash = filterCategory ? keccak256(bytes(category)) : bytes32(0);

        uint256 count = 0;
        uint256 total = allJobIds.length;
        for (uint256 i = 0; i < total; i++) {
            if (_isOpenMatch(allJobIds[i], filterCategory, categoryHash)) count++;
        }
        if (offset >= count) return new uint256[](0);
        uint256 resultLen = count - offset;
        if (limit > 0 && resultLen > limit) resultLen = limit;

        result = new uint256[](resultLen);
        uint256 matched = 0;
        uint256 added   = 0;
        for (uint256 i = 0; i < total && added < resultLen; i++) {
            if (_isOpenMatch(allJobIds[i], filterCategory, categoryHash)) {
                if (matched >= offset) result[added++] = allJobIds[i];
                matched++;
            }
        }
    }

    function getMyPostedBounties(address poster) external view returns (uint256[] memory) {
        return _filterByPoster(poster);
    }

    function getMyAssignedBounties(address provider) external view returns (uint256[] memory) {
        return _filterByProvider(provider);
    }

    function getAgentReputation(uint256 agentId) external view returns (IReputationRegistry.ReputationScore memory) {
        return reputationRegistry.getReputation(agentId);
    }

    function totalBounties() external view returns (uint256) {
        return allJobIds.length;
    }

    // ─── Internal helpers ──────────────────────────────────────────────────────

    function _isOpenMatch(uint256 jobId, bool filterCategory, bytes32 categoryHash) internal view returns (bool) {
        BountyMeta storage meta = _bounties[jobId];
        if (meta.isTaken) return false;
        if (meta.resolved) return false;
        if (block.timestamp > meta.deadline) return false;
        if (filterCategory && keccak256(bytes(meta.category)) != categoryHash) return false;
        return true;
    }

    function _filterByPoster(address poster) internal view returns (uint256[] memory) {
        uint256 count;
        for (uint256 i = 0; i < allJobIds.length; i++) {
            if (_bounties[allJobIds[i]].poster == poster) count++;
        }
        uint256[] memory result = new uint256[](count);
        uint256 idx;
        for (uint256 i = 0; i < allJobIds.length; i++) {
            if (_bounties[allJobIds[i]].poster == poster) result[idx++] = allJobIds[i];
        }
        return result;
    }

    function _filterByProvider(address provider) internal view returns (uint256[] memory) {
        uint256 count;
        for (uint256 i = 0; i < allJobIds.length; i++) {
            if (_bounties[allJobIds[i]].assignedProvider == provider) count++;
        }
        uint256[] memory result = new uint256[](count);
        uint256 idx;
        for (uint256 i = 0; i < allJobIds.length; i++) {
            if (_bounties[allJobIds[i]].assignedProvider == provider) result[idx++] = allJobIds[i];
        }
        return result;
    }

    function _validCategory(string calldata cat) internal pure returns (bool) {
        bytes32 h = keccak256(bytes(cat));
        return h == keccak256("dev")
            || h == keccak256("design")
            || h == keccak256("content")
            || h == keccak256("data")
            || h == keccak256("other");
    }
}
