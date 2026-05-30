// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IAgenticCommerce.sol";
import "./interfaces/IIdentityRegistry.sol";
import "./interfaces/IReputationRegistry.sol";

/// @title BountyAdapter (V3 — Sprint 1 hardening)
/// @notice Bounty-board facade over Arc ERC-8183 AgenticCommerce.
///         The adapter takes all three AC roles (client + provider + evaluator);
///         the real worker is tracked in BountyMeta.assignedProvider. AC remains
///         the escrow rail. Payouts are forwarded via balance-delta accounting.
///
/// Sprint 1 changes vs V2:
///  - reward stored as GROSS; protocol fee charged at payout time only.
///    Cancel/expire/reject refund the full amount to the poster (no listing tax).
///  - submittedAt + autoApprove(jobId) closes the "poster ghosted after submit"
///    deadlock that previously left funds in AC escrow.
///  - O(1) index slices for poster / assignedProvider / agentId views.
///  - Length caps on every IPFS / category / reason field to bound storage cost.
contract BountyAdapter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IAgenticCommerce public immutable agenticCommerce;
    IIdentityRegistry public immutable identityRegistry;
    IReputationRegistry public immutable reputationRegistry;
    IERC20 public immutable usdc;

    address public immutable feeRecipient;
    address public arbitrator;
    address public pendingArbitrator;
    uint256 public immutable feeBps;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MIN_REWARD = 1e6;

    uint256 public constant DISPUTE_RESPONSE_WINDOW = 48 hours;
    uint256 public constant REJECTION_CHALLENGE_WINDOW = 48 hours;
    /// @notice After this period from submitWork, anyone may call autoApprove
    ///         and the worker is paid. Protects workers from posters who vanish.
    uint256 public constant APPROVAL_TIMEOUT = 14 days;

    // String length bounds — keep storage cheap and SSTORE refunds predictable.
    uint256 public constant MAX_CID_LEN = 96; // CIDv1 + ipfs:// prefix
    uint256 public constant MAX_CATEGORY = 16;
    uint256 public constant MAX_TAG_LEN = 32;
    uint256 public constant MAX_TAGS = 10;

    struct CreateParams {
        address provider; // 0x0 = open. If non-zero, only this address (or owner of agentId) can take.
        uint256 reward;
        uint256 deadline;
        string ipfsDescHash;
        string category;
        string[] tags;
        bool agentOnly;
        bool humanOnly;
    }

    struct BountyMeta {
        uint256 jobId;
        address poster;
        uint256 reward; // GROSS — fee is split at payout
        uint256 deadline;
        string ipfsDescHash;
        string category;
        string[] tags;
        uint256 agentId;
        bool agentOnly;
        bool humanOnly;
        address whitelistedProvider; // if set, only this address may take
        address assignedProvider;
        string submittedResultHash;
        uint256 submittedAt; // 0 until submitWork; enables autoApprove
        bool isTaken;
        // Pending-rejection state (poster rejected, worker has 48h to challenge)
        uint256 rejectedAt;
        string rejectionReasonHash;
        // Dispute state
        bool inDispute;
        bool resolved;
        address disputeInitiator;
        uint256 disputeRaisedAt;
        string disputeReasonHash;
        string disputeResponseHash;
        string disputeRulingHash;
    }

    mapping(uint256 => BountyMeta) private _bounties;
    uint256[] public allJobIds;

    // Sprint 1: O(1) index slices.
    mapping(address => uint256[]) private _postedBy;
    mapping(address => uint256[]) private _assignedTo;
    mapping(uint256 => uint256[]) private _byAgent;

    event BountyCreated(
        uint256 indexed jobId, address indexed poster, uint256 reward, string category, uint256 deadline
    );
    event BountyTaken(uint256 indexed jobId, address indexed provider, uint256 agentId);
    event WorkSubmitted(uint256 indexed jobId, address indexed provider, string ipfsResultHash);
    event BountyCompleted(uint256 indexed jobId, uint256 agentId, uint256 reputationScore);
    event BountyAutoApproved(uint256 indexed jobId, address indexed provider);
    event BountyCancelled(uint256 indexed jobId, string reason);
    event BountyExpired(uint256 indexed jobId);
    event ProtocolFeePaid(uint256 indexed jobId, address indexed recipient, uint256 amount);

    event RejectionProposed(uint256 indexed jobId, address indexed poster, string reasonHash);
    event RejectionFinalized(uint256 indexed jobId);
    event RejectionChallenged(uint256 indexed jobId, address indexed worker, string reasonHash);
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
        require(_agenticCommerce != address(0), "ac=0");
        require(_identityRegistry != address(0), "id=0");
        require(_reputationRegistry != address(0), "rep=0");
        require(_usdc != address(0), "usdc=0");
        require(_feeRecipient != address(0), "fee=0");
        require(_feeBps <= 1000, "fee too high");

        agenticCommerce = IAgenticCommerce(_agenticCommerce);
        identityRegistry = IIdentityRegistry(_identityRegistry);
        reputationRegistry = IReputationRegistry(_reputationRegistry);
        usdc = IERC20(_usdc);
        feeRecipient = _feeRecipient;
        arbitrator = msg.sender;
        feeBps = _feeBps;
    }

    // ─── Lifecycle ─────────────────────────────────────────────────────────────

    function createBounty(CreateParams calldata p) external nonReentrant returns (uint256 jobId) {
        require(p.reward >= MIN_REWARD, "reward too low");
        require(p.deadline > block.timestamp, "deadline in past");
        _requireCid(p.ipfsDescHash, "ipfsDesc");
        require(_validCategory(p.category), "invalid category");
        require(!(p.agentOnly && p.humanOnly), "agentOnly+humanOnly");
        require(p.tags.length <= MAX_TAGS, "too many tags");
        for (uint256 i = 0; i < p.tags.length; i++) {
            require(bytes(p.tags[i]).length > 0 && bytes(p.tags[i]).length <= MAX_TAG_LEN, "tag bad len");
        }

        require(usdc.allowance(msg.sender, address(this)) >= p.reward, "insufficient USDC allowance");
        usdc.safeTransferFrom(msg.sender, address(this), p.reward);

        // Fee is NOT charged here — only on successful payout.
        jobId = agenticCommerce.createJob(address(this), address(this), p.deadline, p.ipfsDescHash, address(0));
        agenticCommerce.setBudget(jobId, p.reward, bytes(""));

        BountyMeta storage meta = _bounties[jobId];
        meta.jobId = jobId;
        meta.poster = msg.sender;
        meta.reward = p.reward; // gross
        meta.deadline = p.deadline;
        meta.ipfsDescHash = p.ipfsDescHash;
        meta.category = p.category;
        meta.agentOnly = p.agentOnly;
        meta.humanOnly = p.humanOnly;
        meta.whitelistedProvider = p.provider;
        for (uint256 i = 0; i < p.tags.length; i++) {
            meta.tags.push(p.tags[i]);
        }
        allJobIds.push(jobId);
        _postedBy[msg.sender].push(jobId);

        emit BountyCreated(jobId, msg.sender, p.reward, p.category, p.deadline);
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
            _byAgent[agentId].push(jobId);
        }

        meta.isTaken = true;
        meta.assignedProvider = msg.sender;
        _assignedTo[msg.sender].push(jobId);

        // Fund the AC escrow now (adapter is the client).
        usdc.forceApprove(address(agenticCommerce), meta.reward);
        agenticCommerce.fund(jobId, bytes(""));

        emit BountyTaken(jobId, msg.sender, agentId);
    }

    function submitWork(uint256 jobId, string calldata ipfsResultHash) external nonReentrant {
        BountyMeta storage meta = _bounties[jobId];
        require(meta.assignedProvider == msg.sender, "not assigned provider");
        _requireCid(ipfsResultHash, "ipfsResult");
        require(block.timestamp <= meta.deadline, "bounty expired");
        require(bytes(meta.submittedResultHash).length == 0, "already submitted");

        meta.submittedResultHash = ipfsResultHash;
        meta.submittedAt = block.timestamp;
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
        require(meta.rejectedAt == 0, "rejection pending");
        require(reputationScore <= 100, "score>100");

        meta.resolved = true;
        _completeAndForward(jobId, meta.assignedProvider, "approved");

        if (meta.agentId > 0) {
            reputationRegistry.giveFeedback(
                meta.agentId,
                reputationScore,
                0,
                "bounty_completed",
                "",
                "",
                "",
                keccak256(abi.encodePacked("bounty_completed", jobId))
            );
        }

        emit BountyCompleted(jobId, meta.agentId, reputationScore);
    }

    /// @notice Anyone may call after APPROVAL_TIMEOUT from submission. Forwards
    ///         the payout to the worker. Closes the "ghosted poster" deadlock.
    ///         Reputation score is fixed (80) since the poster did not rate.
    function autoApprove(uint256 jobId) external nonReentrant {
        BountyMeta storage meta = _bounties[jobId];
        require(bytes(meta.submittedResultHash).length > 0, "no submission");
        require(!meta.inDispute, "in dispute");
        require(!meta.resolved, "resolved");
        require(meta.rejectedAt == 0, "rejection pending");
        require(block.timestamp > meta.submittedAt + APPROVAL_TIMEOUT, "approval window open");

        meta.resolved = true;
        _completeAndForward(jobId, meta.assignedProvider, "auto_approved");

        if (meta.agentId > 0) {
            reputationRegistry.giveFeedback(
                meta.agentId,
                80,
                0,
                "bounty_auto_approved",
                "",
                "",
                "",
                keccak256(abi.encodePacked("auto_approved", jobId))
            );
        }

        emit BountyAutoApproved(jobId, meta.assignedProvider);
        emit BountyCompleted(jobId, meta.agentId, 80);
    }

    function rejectBounty(uint256 jobId, string calldata ipfsReasonHash) external nonReentrant {
        BountyMeta storage meta = _bounties[jobId];
        require(meta.poster == msg.sender, "only poster");
        require(bytes(meta.submittedResultHash).length > 0, "no submission");
        require(!meta.inDispute, "in dispute");
        require(!meta.resolved, "resolved");
        require(meta.rejectedAt == 0, "already rejected");
        _requireCid(ipfsReasonHash, "reason");

        meta.rejectedAt = block.timestamp;
        meta.rejectionReasonHash = ipfsReasonHash;
        emit RejectionProposed(jobId, msg.sender, ipfsReasonHash);
    }

    function challengeRejection(uint256 jobId, string calldata ipfsReasonHash) external nonReentrant {
        BountyMeta storage meta = _bounties[jobId];
        require(meta.rejectedAt != 0, "no pending rejection");
        require(!meta.resolved, "resolved");
        require(!meta.inDispute, "already in dispute");
        require(msg.sender == meta.assignedProvider, "only worker");
        require(block.timestamp <= meta.rejectedAt + REJECTION_CHALLENGE_WINDOW, "challenge window closed");
        _requireCid(ipfsReasonHash, "reason");

        meta.inDispute = true;
        meta.disputeInitiator = msg.sender;
        meta.disputeRaisedAt = block.timestamp;
        meta.disputeReasonHash = ipfsReasonHash;

        emit RejectionChallenged(jobId, msg.sender, ipfsReasonHash);
        emit DisputeRaised(jobId, msg.sender, ipfsReasonHash);
    }

    function finalizeRejection(uint256 jobId) external nonReentrant {
        BountyMeta storage meta = _bounties[jobId];
        require(meta.rejectedAt != 0, "no pending rejection");
        require(!meta.resolved, "resolved");
        require(!meta.inDispute, "in dispute");
        require(block.timestamp > meta.rejectedAt + REJECTION_CHALLENGE_WINDOW, "challenge window open");

        meta.resolved = true;
        _rejectAndRefund(jobId, "rejection_finalized");
        emit RejectionFinalized(jobId);
        emit BountyCancelled(jobId, meta.rejectionReasonHash);
    }

    function cancelBounty(uint256 jobId) external nonReentrant {
        BountyMeta storage meta = _bounties[jobId];
        require(meta.poster == msg.sender, "only poster");
        require(!meta.isTaken, "already taken, cannot cancel");
        require(!meta.resolved, "resolved");

        meta.resolved = true;
        // Funds never left adapter (AC not funded until takeBounty). Full refund — no fee.
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
            _rejectAndRefund(jobId, "expired");
        } else {
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
        require(meta.rejectedAt == 0, "use challengeRejection");
        _requireCid(ipfsReasonHash, "reason");

        meta.inDispute = true;
        meta.disputeInitiator = msg.sender;
        meta.disputeRaisedAt = block.timestamp;
        meta.disputeReasonHash = ipfsReasonHash;

        emit DisputeRaised(jobId, msg.sender, ipfsReasonHash);
    }

    function respondToDispute(uint256 jobId, string calldata ipfsResponseHash) external nonReentrant {
        BountyMeta storage meta = _bounties[jobId];
        require(meta.inDispute, "not in dispute");
        require(!meta.resolved, "resolved");
        require(bytes(meta.disputeResponseHash).length == 0, "already responded");
        _requireCid(ipfsResponseHash, "response");
        require(block.timestamp <= meta.disputeRaisedAt + DISPUTE_RESPONSE_WINDOW, "response window closed");

        address other = meta.disputeInitiator == meta.poster ? meta.assignedProvider : meta.poster;
        require(msg.sender == other, "not the respondent");

        meta.disputeResponseHash = ipfsResponseHash;
        emit DisputeResponded(jobId, msg.sender, ipfsResponseHash);
    }

    function resolveDispute(uint256 jobId, bool payProvider, string calldata ipfsRulingHash, uint8 reputationPenalty)
        external
        nonReentrant
    {
        require(msg.sender == arbitrator, "only arbitrator");
        BountyMeta storage meta = _bounties[jobId];
        require(meta.inDispute, "not in dispute");
        require(!meta.resolved, "resolved");
        _requireCid(ipfsRulingHash, "ruling");
        require(reputationPenalty <= 100, "penalty>100");

        meta.resolved = true;
        meta.inDispute = false;
        meta.disputeRulingHash = ipfsRulingHash;

        _finalizeDispute(jobId, payProvider);
        _maybePenalize(meta, payProvider, reputationPenalty);

        emit DisputeResolved(jobId, payProvider, ipfsRulingHash, false);
    }

    function claimDefaultRuling(uint256 jobId) external nonReentrant {
        BountyMeta storage meta = _bounties[jobId];
        require(meta.inDispute, "not in dispute");
        require(!meta.resolved, "resolved");
        require(bytes(meta.disputeResponseHash).length == 0, "respondent replied");
        require(block.timestamp > meta.disputeRaisedAt + DISPUTE_RESPONSE_WINDOW, "window still open");

        meta.resolved = true;
        meta.inDispute = false;
        meta.disputeRulingHash = "default:no-response";

        bool payProvider = meta.disputeInitiator == meta.assignedProvider;
        _finalizeDispute(jobId, payProvider);

        emit DisputeResolved(jobId, payProvider, meta.disputeRulingHash, true);
    }

    function _finalizeDispute(uint256 jobId, bool payProvider) internal {
        BountyMeta storage meta = _bounties[jobId];
        if (payProvider) {
            _completeAndForward(jobId, meta.assignedProvider, "dispute:provider");
        } else {
            _rejectAndRefund(jobId, "dispute:poster");
        }
    }

    function _maybePenalize(BountyMeta storage meta, bool payProvider, uint8 penalty) internal {
        if (payProvider || meta.agentId == 0 || penalty == 0) return;
        // feedbackType = 1 → "negative". Real ReputationRegistry must read this.
        reputationRegistry.giveFeedback(
            meta.agentId,
            penalty,
            1,
            "bounty_failed",
            "",
            "",
            "",
            keccak256(abi.encodePacked("dispute_rejected", meta.jobId))
        );
    }

    // ─── Internal payout helpers (balance-delta accounting) ────────────────────

    /// @dev Pulls received USDC from AC, splits fee, forwards remainder to payee.
    function _completeAndForward(uint256 jobId, address payee, string memory reason) internal {
        uint256 before = usdc.balanceOf(address(this));
        agenticCommerce.complete(jobId, keccak256(abi.encodePacked(reason)), bytes(reason));
        uint256 received = usdc.balanceOf(address(this)) - before;
        if (received == 0) return;

        uint256 fee = (received * feeBps) / BPS_DENOMINATOR;
        if (fee > 0) {
            usdc.safeTransfer(feeRecipient, fee);
            emit ProtocolFeePaid(jobId, feeRecipient, fee);
        }
        uint256 net = received - fee;
        if (net > 0) {
            usdc.safeTransfer(payee, net);
        }
    }

    /// @dev Pulls received USDC from AC and refunds poster — NO fee charged.
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

    function getOpenBounties(string calldata category, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory result)
    {
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
        uint256 added = 0;
        for (uint256 i = 0; i < total && added < resultLen; i++) {
            if (_isOpenMatch(allJobIds[i], filterCategory, categoryHash)) {
                if (matched >= offset) result[added++] = allJobIds[i];
                matched++;
            }
        }
    }

    function getMyPostedBounties(address poster) external view returns (uint256[] memory) {
        return _postedBy[poster];
    }

    function getMyAssignedBounties(address provider) external view returns (uint256[] memory) {
        return _assignedTo[provider];
    }

    function getAgentBounties(uint256 agentId) external view returns (uint256[] memory) {
        return _byAgent[agentId];
    }

    function getPostedCount(address poster) external view returns (uint256) {
        return _postedBy[poster].length;
    }

    function getAssignedCount(address provider) external view returns (uint256) {
        return _assignedTo[provider].length;
    }

    function getAgentBountyCount(uint256 agentId) external view returns (uint256) {
        return _byAgent[agentId].length;
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

    function _validCategory(string calldata cat) internal pure returns (bool) {
        bytes memory b = bytes(cat);
        if (b.length == 0 || b.length > MAX_CATEGORY) return false;
        bytes32 h = keccak256(b);
        return h == keccak256("dev") || h == keccak256("design") || h == keccak256("content") || h == keccak256("data")
            || h == keccak256("other");
    }

    function _requireCid(string calldata s, string memory label) internal pure {
        bytes memory b = bytes(s);
        require(b.length > 0, string.concat("empty ", label));
        require(b.length <= MAX_CID_LEN, string.concat(label, " too long"));
    }
}
