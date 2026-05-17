// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IAgenticCommerce.sol";
import "./interfaces/IIdentityRegistry.sol";
import "./interfaces/IReputationRegistry.sol";

/// @notice Chainalysis-style sanctions oracle. `isSanctioned` returns true for OFAC-listed addrs.
interface ISanctionsOracle {
    function isSanctioned(address addr) external view returns (bool);
}

/// @title BountyAdapter
/// @notice Thin facade over Arc ERC-8183 AgenticCommerce — adds bounty-board semantics
///         (categories, tags, IPFS descriptions, ERC-8004 reputation).
///         Variant A lifecycle: createBounty pulls USDC, deducts fee, and funds AC escrow
///         in a single transaction. takeBounty only assigns provider.
contract BountyAdapter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IAgenticCommerce    public immutable agenticCommerce;
    IIdentityRegistry   public immutable identityRegistry;
    IReputationRegistry public immutable reputationRegistry;
    IERC20              public immutable usdc;

    address public immutable feeRecipient;
    uint256 public immutable feeBps;

    /// @notice Dispute arbitrator. Mutable to allow migration to a multisig/oracle.
    address public arbitrator;
    /// @notice Pending arbitrator awaiting acceptance (2-step transfer).
    address public pendingArbitrator;

    /// @notice Optional Chainalysis-style sanctions oracle. address(0) disables checks.
    ISanctionsOracle public sanctionsOracle;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_FEE_BPS     = 1_000; // 10% hard cap
    uint256 public constant MIN_REWARD      = 1e6;   // 1 USDC
    uint256 public constant MAX_TAGS        = 10;
    uint256 public constant MAX_TAG_LEN     = 32;
    uint256 public constant MAX_REPUTATION  = 100;
    uint256 public constant DISPUTE_WINDOW  = 48 hours;

    // MEV protection
    uint256 public constant COMMIT_REVEAL_MIN_BLOCKS = 2;
    uint256 public constant COMMIT_REVEAL_MAX_BLOCKS = 256;

    struct BountyMeta {
        uint256  jobId;
        address  poster;
        uint256  reward;          // net of protocol fee, equals amount locked in AC
        uint256  deadline;
        string   ipfsDescHash;
        string   category;
        string[] tags;
        uint256  agentId;
        bool     agentOnly;
        address  assignedProvider;
        string   submittedResultHash;
        uint256  submittedAt;
        bool     funded;          // always true once createBounty returns (kept for ABI stability)
        bool     inDispute;
        bool     isTaken;
        bool     finalized;       // true after complete/reject/expire/refund
        bool     commitRevealRequired; // MEV protection opt-in
        address  whitelistedProvider;  // 0 = open; non-zero = only this address can take
    }

    /// @dev Per-(jobId, address) commit registry for MEV-resistant takes.
    mapping(uint256 => mapping(address => bytes32)) public commitHash;
    mapping(uint256 => mapping(address => uint256)) public commitBlock;

    mapping(uint256 => BountyMeta) public bounties;
    uint256[] public allJobIds;

    event BountyCreated(uint256 indexed jobId, address indexed poster, uint256 reward, string category, uint256 deadline);
    event BountyFunded(uint256 indexed jobId, uint256 amount);
    event BountyTaken(uint256 indexed jobId, address indexed provider, uint256 agentId);
    event WorkSubmitted(uint256 indexed jobId, address indexed provider, string ipfsResultHash);
    event BountyCompleted(uint256 indexed jobId, uint256 agentId, uint256 reputationScore);
    event BountyCancelled(uint256 indexed jobId, string reason);
    event BountyExpired(uint256 indexed jobId);
    event BountyRefunded(uint256 indexed jobId, address indexed to, uint256 amount);
    event DisputeRaised(uint256 indexed jobId, address indexed by);
    event DisputeResolved(uint256 indexed jobId, bool payProvider);
    event ArbitratorTransferProposed(address indexed current, address indexed pending);
    event ArbitratorTransferred(address indexed previous, address indexed current);
    event SanctionsOracleUpdated(address indexed previous, address indexed current);

    constructor(
        address _agenticCommerce,
        address _identityRegistry,
        address _reputationRegistry,
        address _usdc,
        address _feeRecipient,
        uint256 _feeBps
    ) {
        require(_agenticCommerce    != address(0), "zero agenticCommerce");
        require(_identityRegistry   != address(0), "zero identityRegistry");
        require(_reputationRegistry != address(0), "zero reputationRegistry");
        require(_usdc               != address(0), "zero usdc");
        require(_feeRecipient       != address(0), "zero feeRecipient");
        require(_feeBps             <= MAX_FEE_BPS, "fee too high");

        agenticCommerce    = IAgenticCommerce(_agenticCommerce);
        identityRegistry   = IIdentityRegistry(_identityRegistry);
        reputationRegistry = IReputationRegistry(_reputationRegistry);
        usdc               = IERC20(_usdc);
        feeRecipient       = _feeRecipient;
        arbitrator         = msg.sender;
        feeBps             = _feeBps;
        emit ArbitratorTransferred(address(0), msg.sender);
    }

    // ─── Admin (arbitrator-controlled) ────────────────────────────────────────

    /// @notice Step 1: current arbitrator proposes new one. Use address(0) to cancel pending.
    /// @dev    Zero is an intentional sentinel ("cancel pending"); the live arbitrator never
    ///         changes here, only `pendingArbitrator` does. The zero-check belongs in
    ///         acceptArbitrator (which already requires msg.sender == pendingArbitrator,
    ///         making accept by address(0) impossible).
    // slither-disable-next-line missing-zero-check
    function transferArbitrator(address newArbitrator) external {
        require(msg.sender == arbitrator, "only arbitrator");
        pendingArbitrator = newArbitrator;
        emit ArbitratorTransferProposed(arbitrator, newArbitrator);
    }

    /// @notice Step 2: new arbitrator (typically a multisig) accepts the role.
    function acceptArbitrator() external {
        require(msg.sender == pendingArbitrator, "not pending arbitrator");
        address prev = arbitrator;
        arbitrator = pendingArbitrator;
        pendingArbitrator = address(0);
        emit ArbitratorTransferred(prev, arbitrator);
    }

    /// @notice Enable, swap or disable (address(0)) the sanctions oracle.
    function setSanctionsOracle(address oracle) external {
        require(msg.sender == arbitrator, "only arbitrator");
        address prev = address(sanctionsOracle);
        sanctionsOracle = ISanctionsOracle(oracle);
        emit SanctionsOracleUpdated(prev, oracle);
    }

    // ─── Create (Variant B: USDC parked in adapter until takeBounty) ───────────
    //
    // Real ERC-8183 on Arc enforces order createJob → setProvider → setBudget → fund,
    // and `setProvider` is one-shot. So we cannot pre-fund AC with provider = address(0)
    // and reassign later. Adapter therefore holds the netReward locally until a worker
    // takes the bounty, at which point _take() runs setProvider+setBudget+fund and moves
    // USDC into AC escrow.

    struct CreateParams {
        address  provider;
        uint256  reward;
        uint256  deadline;
        string   ipfsDescHash;
        string   category;
        string[] tags;
        bool     agentOnly;
        bool     commitRevealRequired;
    }

    function createBounty(CreateParams calldata p)
        external
        nonReentrant
        returns (uint256 jobId)
    {
        require(p.reward >= MIN_REWARD, "reward too low");
        require(p.deadline > block.timestamp, "deadline in past");
        require(bytes(p.ipfsDescHash).length > 0, "empty ipfs hash");
        require(_validCategory(p.category), "invalid category");
        require(p.tags.length <= MAX_TAGS, "too many tags");
        for (uint256 i = 0; i < p.tags.length; i++) {
            require(bytes(p.tags[i]).length <= MAX_TAG_LEN, "tag too long");
        }
        require(usdc.allowance(msg.sender, address(this)) >= p.reward, "insufficient USDC allowance");
        _requireNotSanctioned(msg.sender);

        usdc.safeTransferFrom(msg.sender, address(this), p.reward);

        uint256 fee = (p.reward * feeBps) / BPS_DENOMINATOR;
        uint256 netReward = p.reward - fee;
        if (fee > 0) usdc.safeTransfer(feeRecipient, fee);

        // Real ERC-8183 puts hard restrictions on setProvider/setBudget callers:
        //   setProvider — only `client`
        //   setBudget   — only `provider`, status must be Open
        //   fund        — only `client`, status must be Open, provider must be set
        //   submit      — only `provider`
        //   complete    — only `evaluator`
        //   reject      — `client` if Open, `evaluator` if Funded/Submitted
        // So adapter takes ALL three roles at AC (client+provider+evaluator) and tracks the
        // real worker separately in BountyMeta.assignedProvider. AC stays the actual escrow
        // and payout rail; adapter is just the proxy that knows who the human/agent worker is.
        jobId = agenticCommerce.createJob(address(this), address(this), p.deadline, p.ipfsDescHash, address(0));

        _writeMeta(jobId, p, netReward);
        allJobIds.push(jobId);

        // Adapter (as provider) declares the budget while status is still Open.
        agenticCommerce.setBudget(jobId, netReward, bytes(""));

        emit BountyCreated(jobId, msg.sender, netReward, p.category, p.deadline);
        // BountyFunded is emitted from _take(), once USDC actually lands in AC escrow.
    }

    function _writeMeta(uint256 jobId, CreateParams calldata p, uint256 netReward) internal {
        BountyMeta storage meta = bounties[jobId];
        meta.jobId                = jobId;
        meta.poster               = msg.sender;
        meta.reward               = netReward;
        meta.deadline             = p.deadline;
        meta.ipfsDescHash         = p.ipfsDescHash;
        meta.category             = p.category;
        meta.agentOnly            = p.agentOnly;
        meta.funded               = false; // becomes true at takeBounty
        meta.commitRevealRequired = p.commitRevealRequired;
        meta.whitelistedProvider  = p.provider;
        for (uint256 i = 0; i < p.tags.length; i++) {
            meta.tags.push(p.tags[i]);
        }
    }

    // ─── Take ─────────────────────────────────────────────────────────────────

    function takeBounty(uint256 jobId, uint256 agentId) external nonReentrant {
        BountyMeta storage meta = bounties[jobId];
        require(!meta.commitRevealRequired, "use commit-reveal");
        _take(meta, jobId, msg.sender, agentId);
    }

    /// @notice Step 1 of MEV-resistant take. Caller posts a commitment hash; reveal must follow
    ///         after `COMMIT_REVEAL_MIN_BLOCKS`. Commitment is private — bots cannot front-run
    ///         a reveal without knowing the salt.
    /// @dev commitment = keccak256(abi.encode(jobId, msg.sender, agentId, salt))
    function commitTake(uint256 jobId, bytes32 commitment) external nonReentrant {
        BountyMeta storage meta = bounties[jobId];
        require(meta.poster != address(0), "bounty not found");
        require(meta.commitRevealRequired, "commit-reveal disabled");
        require(!meta.isTaken, "already taken");
        require(!meta.finalized, "finalized");
        require(block.timestamp <= meta.deadline, "bounty expired");
        require(commitment != bytes32(0), "empty commitment");

        commitHash[jobId][msg.sender]  = commitment;
        commitBlock[jobId][msg.sender] = block.number;
    }

    function revealTake(uint256 jobId, uint256 agentId, bytes32 salt) external nonReentrant {
        BountyMeta storage meta = bounties[jobId];
        require(meta.commitRevealRequired, "commit-reveal disabled");

        bytes32 expected = keccak256(abi.encode(jobId, msg.sender, agentId, salt));
        bytes32 stored   = commitHash[jobId][msg.sender];
        require(stored != bytes32(0), "no commitment");
        require(stored == expected, "commitment mismatch");

        uint256 cb = commitBlock[jobId][msg.sender];
        require(block.number >= cb + COMMIT_REVEAL_MIN_BLOCKS, "reveal too early");
        require(block.number <= cb + COMMIT_REVEAL_MAX_BLOCKS, "reveal expired");

        // Clear commitment regardless of outcome to prevent replay.
        delete commitHash[jobId][msg.sender];
        delete commitBlock[jobId][msg.sender];

        _take(meta, jobId, msg.sender, agentId);
    }

    function _take(BountyMeta storage meta, uint256 jobId, address taker, uint256 agentId) internal {
        require(meta.poster != address(0), "bounty not found");
        require(!meta.isTaken, "already taken");
        require(!meta.finalized, "finalized");
        require(block.timestamp <= meta.deadline, "bounty expired");
        _requireNotSanctioned(taker);

        // Poster-controlled allowlist (single provider).
        if (meta.whitelistedProvider != address(0)) {
            require(taker == meta.whitelistedProvider, "not whitelisted");
        }
        if (meta.agentOnly) {
            require(agentId != 0, "agent only: provide agentId");
        }
        if (agentId != 0) {
            require(identityRegistry.isRegistered(agentId), "agent not registered");
            require(identityRegistry.ownerOf(agentId) == taker, "caller is not agent owner");
            meta.agentId = agentId;
        }

        // CEI: write internal state first, then fund AC.
        // Adapter is already AC.provider (set at createJob), so setProvider is skipped.
        // Only `fund` runs here, transferring USDC from adapter into AC escrow.
        meta.isTaken          = true;
        meta.assignedProvider = taker;
        meta.funded           = true;

        uint256 amount = meta.reward;
        usdc.forceApprove(address(agenticCommerce), amount);
        agenticCommerce.fund(jobId, bytes(""));

        emit BountyTaken(jobId, taker, agentId);
        emit BountyFunded(jobId, amount);
    }

    // ─── Submit / Approve ─────────────────────────────────────────────────────

    function submitWork(uint256 jobId, string calldata ipfsResultHash) external nonReentrant {
        BountyMeta storage meta = bounties[jobId];
        require(meta.assignedProvider == msg.sender, "not assigned provider");
        require(!meta.finalized, "finalized");
        require(bytes(ipfsResultHash).length > 0, "empty result hash");
        require(block.timestamp <= meta.deadline, "bounty expired");
        require(bytes(meta.submittedResultHash).length == 0, "already submitted");

        // CEI: update state before external call.
        meta.submittedResultHash = ipfsResultHash;
        meta.submittedAt         = block.timestamp;

        bytes32 deliverable = keccak256(abi.encodePacked(ipfsResultHash));
        agenticCommerce.submit(jobId, deliverable, bytes(""));

        emit WorkSubmitted(jobId, msg.sender, ipfsResultHash);
    }

    function approveBounty(uint256 jobId, uint8 reputationScore) external nonReentrant {
        BountyMeta storage meta = bounties[jobId];
        require(meta.poster == msg.sender, "only poster");
        require(!meta.finalized, "finalized");
        require(bytes(meta.submittedResultHash).length > 0, "no submission");
        require(!meta.inDispute, "in dispute");
        require(reputationScore <= MAX_REPUTATION, "score > 100");
        _requireNotSanctioned(meta.assignedProvider);

        meta.finalized = true;
        _giveFeedback(meta.agentId, reputationScore, "bounty_completed", jobId);
        _completeAndForward(jobId, meta.assignedProvider, keccak256("approved"), "Poster approved");

        emit BountyCompleted(jobId, meta.agentId, reputationScore);
    }

    /// @notice Provider can auto-approve payment after DISPUTE_WINDOW elapses without dispute.
    ///         Uses default reputation score 80.
    function autoApprove(uint256 jobId) external nonReentrant {
        BountyMeta storage meta = bounties[jobId];
        require(!meta.finalized, "finalized");
        require(bytes(meta.submittedResultHash).length > 0, "no submission");
        require(!meta.inDispute, "in dispute");
        require(block.timestamp >= meta.submittedAt + DISPUTE_WINDOW, "dispute window open");
        require(msg.sender == meta.assignedProvider, "only provider");
        _requireNotSanctioned(msg.sender);

        meta.finalized = true;
        uint8 defaultScore = 80;
        _giveFeedback(meta.agentId, defaultScore, "bounty_auto_completed", jobId);
        _completeAndForward(jobId, meta.assignedProvider, keccak256("auto_approved"), "Auto-approved after dispute window");

        emit BountyCompleted(jobId, meta.agentId, defaultScore);
    }

    /// @dev AC pays out to AC.provider, which is the adapter. We then forward the actual
    ///      payout (net of any AC-level platform/evaluator fees) to the real worker.
    function _completeAndForward(uint256 jobId, address realProvider, bytes32 reason, bytes memory data) internal {
        uint256 balBefore = usdc.balanceOf(address(this));
        agenticCommerce.complete(jobId, reason, data);
        uint256 received = usdc.balanceOf(address(this)) - balBefore;
        if (received > 0) {
            usdc.safeTransfer(realProvider, received);
        }
    }

    // ─── Dispute ──────────────────────────────────────────────────────────────

    function disputeBounty(uint256 jobId) external nonReentrant {
        BountyMeta storage meta = bounties[jobId];
        require(!meta.finalized, "finalized");
        require(msg.sender == meta.poster || msg.sender == meta.assignedProvider, "unauthorized");
        require(bytes(meta.submittedResultHash).length > 0, "no submission to dispute");
        require(!meta.inDispute, "already in dispute");
        require(block.timestamp <= meta.submittedAt + DISPUTE_WINDOW, "dispute window closed");

        meta.inDispute = true;
        emit DisputeRaised(jobId, msg.sender);
    }

    function resolveDispute(uint256 jobId, bool payProvider, uint8 reputationPenalty)
        external
        nonReentrant
    {
        require(msg.sender == arbitrator, "only arbitrator");
        require(reputationPenalty <= MAX_REPUTATION, "penalty > 100");

        BountyMeta storage meta = bounties[jobId];
        require(meta.inDispute, "not in dispute");
        require(!meta.finalized, "finalized");

        meta.inDispute = false;
        meta.finalized = true;

        if (payProvider) {
            _requireNotSanctioned(meta.assignedProvider);
            _giveFeedback(meta.agentId, uint8(MAX_REPUTATION), "dispute_won_provider", jobId);
            _completeAndForward(jobId, meta.assignedProvider, keccak256("dispute_resolved_provider"), "Arbitrator: provider wins");
            emit DisputeResolved(jobId, true);
        } else {
            _giveFeedback(meta.agentId, reputationPenalty, "bounty_failed", jobId);
            agenticCommerce.reject(jobId, keccak256("dispute_resolved_poster"), bytes("Arbitrator: poster wins"));
            agenticCommerce.claimRefund(jobId);
            _forwardAdapterBalance(meta);
            emit DisputeResolved(jobId, false);
        }
    }

    // ─── Reject / Cancel / Expire (all refund poster) ─────────────────────────

    function rejectBounty(uint256 jobId, string calldata reason) external nonReentrant {
        BountyMeta storage meta = bounties[jobId];
        require(meta.poster == msg.sender, "only poster");
        require(!meta.finalized, "finalized");
        require(bytes(meta.submittedResultHash).length > 0, "no submission");
        require(!meta.inDispute, "in dispute");
        require(block.timestamp <= meta.submittedAt + DISPUTE_WINDOW, "dispute window closed");

        meta.finalized = true;
        agenticCommerce.reject(jobId, keccak256(abi.encodePacked(reason)), bytes(reason));
        agenticCommerce.claimRefund(jobId);
        _forwardAdapterBalance(meta);

        emit BountyCancelled(jobId, reason);
    }

    /// @notice Cancel an open bounty before anyone takes it. Refund comes straight from
    ///         the adapter (USDC was never funded into AC — Variant B parks it locally).
    function cancelBounty(uint256 jobId) external nonReentrant {
        BountyMeta storage meta = bounties[jobId];
        require(meta.poster == msg.sender, "only poster");
        require(!meta.finalized, "finalized");
        require(!meta.isTaken, "already taken, cannot cancel");

        meta.finalized = true;
        _forwardAdapterBalance(meta);

        emit BountyCancelled(jobId, "cancelled by poster");
    }

    function expireBounty(uint256 jobId) external nonReentrant {
        BountyMeta storage meta = bounties[jobId];
        require(meta.poster != address(0), "bounty not found");
        require(!meta.finalized, "finalized");
        require(block.timestamp > meta.deadline, "not expired yet");
        require(bytes(meta.submittedResultHash).length == 0, "already submitted");

        meta.finalized = true;

        if (meta.isTaken) {
            // USDC is in AC escrow — reject the funded job and claim refund.
            agenticCommerce.reject(jobId, keccak256("expired"), bytes("expired past deadline"));
            agenticCommerce.claimRefund(jobId);
        }
        // Whether or not we hit AC, anything that ended up back in the adapter goes to poster.
        _forwardAdapterBalance(meta);

        emit BountyExpired(jobId);
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    /// @dev Forwards adapter's USDC balance back to the poster. Used by every refund path.
    ///      Caps to `meta.reward` so an accidentally-overfunded adapter can't drain via cancel.
    function _forwardAdapterBalance(BountyMeta storage meta) internal {
        uint256 bal = usdc.balanceOf(address(this));
        if (bal > 0) {
            uint256 amount = bal >= meta.reward ? meta.reward : bal;
            usdc.safeTransfer(meta.poster, amount);
            emit BountyRefunded(meta.jobId, meta.poster, amount);
        }
    }

    function _giveFeedback(uint256 agentId, uint8 score, string memory context, uint256 jobId) internal {
        if (agentId == 0) return;
        bytes32 feedbackHash = keccak256(abi.encodePacked(context, jobId));
        reputationRegistry.giveFeedback(
            agentId, uint256(score), 0, context, "", "", "", feedbackHash
        );
    }

    function _requireNotSanctioned(address who) internal view {
        ISanctionsOracle oracle = sanctionsOracle;
        if (address(oracle) == address(0)) return;
        require(!oracle.isSanctioned(who), "sanctioned address");
    }

    function _validCategory(string calldata cat) internal pure returns (bool) {
        bytes32 h = keccak256(bytes(cat));
        return h == keccak256("dev")
            || h == keccak256("design")
            || h == keccak256("content")
            || h == keccak256("data")
            || h == keccak256("other");
    }

    // ─── View functions ───────────────────────────────────────────────────────

    function getBountyMeta(uint256 jobId) external view returns (BountyMeta memory) {
        return bounties[jobId];
    }

    function getAgentReputation(uint256 agentId)
        external
        view
        returns (IReputationRegistry.ReputationScore memory)
    {
        return reputationRegistry.getReputation(agentId);
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

    function totalBounties() external view returns (uint256) {
        return allJobIds.length;
    }

    function _isOpenMatch(uint256 jobId, bool filterCategory, bytes32 categoryHash)
        internal
        view
        returns (bool)
    {
        BountyMeta storage meta = bounties[jobId];
        if (meta.isTaken || meta.finalized) return false;
        if (block.timestamp > meta.deadline) return false;
        if (filterCategory && keccak256(bytes(meta.category)) != categoryHash) return false;
        return true;
    }

    function _filterByPoster(address poster) internal view returns (uint256[] memory) {
        uint256 count = 0;
        for (uint256 i = 0; i < allJobIds.length; i++) {
            if (bounties[allJobIds[i]].poster == poster) count++;
        }
        uint256[] memory result = new uint256[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < allJobIds.length; i++) {
            if (bounties[allJobIds[i]].poster == poster) result[idx++] = allJobIds[i];
        }
        return result;
    }

    function _filterByProvider(address provider) internal view returns (uint256[] memory) {
        uint256 count = 0;
        for (uint256 i = 0; i < allJobIds.length; i++) {
            if (bounties[allJobIds[i]].assignedProvider == provider) count++;
        }
        uint256[] memory result = new uint256[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < allJobIds.length; i++) {
            if (bounties[allJobIds[i]].assignedProvider == provider) result[idx++] = allJobIds[i];
        }
        return result;
    }
}
