// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IAgenticCommerce.sol";
import "./interfaces/IIdentityRegistry.sol";
import "./interfaces/IReputationRegistry.sol";

/// @title BountyAdapter (V4.4 — opt-in worker bond + unique-poster reputation signal; fee-free arbitrator-timeout split)
/// @dev V3.1 fixes two live-registry incompatibilities found by an on-chain
///      agent run: (1) takeBounty no longer calls the reverting isRegistered();
///      ownerOf alone gates agents. (2) every reputationRegistry.giveFeedback
///      is wrapped in try/catch so a reverting feedback write can never block a
///      worker payout or dispute settlement.
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
///
/// V3.3 changes vs V3.2:
///  - claimArbitratorTimeout(jobId): closes the one remaining liveness gap —
///    a dispute where the respondent replied (so claimDefaultRuling no longer
///    applies) but the arbitrator never rules used to freeze funds forever,
///    since resolveDispute is arbitrator-only. After ARBITRATOR_TIMEOUT (30d)
///    from disputeRaisedAt, anyone may trigger a neutral 50/50 split with no
///    reputation penalty (fault was never established).
///  - feeRecipient is no longer immutable: two-step transferFeeRecipient /
///    acceptFeeRecipient (self-service — the current fee recipient nominates
///    its own successor, independent of the arbitrator role).
///
/// V4 changes vs V3.3 (see V4_DESIGN_ANTI_SYBIL.md for the full rationale):
///  - Opt-in worker bond (CreateParams.requireWorkerBond): a worker taking
///    such a bounty posts max(MIN_WORKER_BOND, reward * WORKER_BOND_BPS/1e4),
///    refunded in full at submitWork, forfeited to the poster if the bounty
///    expires while taken with no submission. Deters free bounty-squatting
///    without taxing bounties whose poster doesn't opt in.
///  - uniquePosterCount(agentId): increments the first time a distinct
///    poster completes a bounty with that agent as worker (approveBounty /
///    autoApprove). Cheap on-chain signal against reputation farmed via
///    self-dealing with one alt account — faking N unique posters now costs
///    N real funded wallets, not one.
///
/// V4.1 changes vs V4 (internal audit findings; live since 2026-07-07):
///  - rejectBounty now reverts once APPROVAL_TIMEOUT has elapsed since
///    submission. Previously a poster sitting on a correct submission could
///    reject right before autoApprove would otherwise fire, buying another
///    REJECTION_CHALLENGE_WINDOW (or a full dispute) of free delay.
///  - withdrawRejection(jobId): lets a poster who rejected and changed their
///    mind return to the pre-rejection state (so approveBounty becomes
///    reachable again) instead of being forced forward into a challenge or a
///    48h wait for finalizeRejection.
///  - MIN_BOND_BOUNTY_DURATION: a requireWorkerBond bounty must have at least
///    24h between creation and deadline. Without this, a poster could list a
///    bond bounty with a near-immediate deadline as a honeypot: an auto-taking
///    agent posts the bond, cannot plausibly finish, and expireBounty forfeits
///    the bond to the poster — repeatable at gas cost. A 24h floor makes the
///    take genuinely completable, so forfeiture again means "worker vanished",
///    not "worker was trapped". Bond-free bounties keep any deadline.
///
/// V4.2 changes vs V4.1 (external review findings; live since 2026-07-08):
///  - disputeBounty is now bounded by APPROVAL_TIMEOUT, exactly like
///    rejectBounty since V4.1. Without this, the V4.1 fix was only half a
///    fix: a poster blocked from rejecting right before autoApprove could
///    open a *dispute* instead — same free delay, and if the arbitrator
///    never rules the honest worker ends at a 50/50 split via
///    claimArbitratorTimeout instead of full payment. Past the approval
///    window, autoApprove is the only path forward for disputes exactly as
///    for rejections. Harmless to workers: a worker past the window wants
///    autoApprove (full payout), never a dispute.
///  - MIN_BOND_TAKE_WINDOW: taking a requireWorkerBond bounty now requires
///    at least 12h left to the deadline. The V4.1 creation-time floor left a
///    residual honeypot: an aged bond listing could still be taken minutes
///    before its deadline, and an auto-taking agent doing so forfeits its
///    bond with no plausible chance to deliver. Bond-free bounties keep
///    takeable-until-deadline semantics.
///
/// V4.3 changes vs V4.2 (live since 2026-07-08):
///  - IReputationRegistry rewired to the interface of the actually deployed
///    ERC-8004 registry (ReputationRegistryUpgradeable v2.0.0). The previous
///    interface mirrored an assumed draft, so every giveFeedback call carried
///    a wrong selector and silently reverted (swallowed by the adapter's own
///    try/catch — payouts were never at risk) since the first integration.
///    Writes pass the 0-100 score as int128 value with valueDecimals=0;
///    getAgentReputation proxies getSummary(agentId, [address(this)], "", "").
///
/// V4.4 changes vs V4.3 (external review finding; live since 2026-07-10):
///  - claimArbitratorTimeout no longer charges the protocol fee.
///    _completeAndSplit previously deducted feeBps before the neutral 50/50
///    split, meaning users paid the protocol fee even when the arbitrator
///    failed to deliver the service that fee funds. The 50/50 split now
///    divides the full escrowed amount with no deduction.
///
/// V4.5 changes vs V4.4 (Base deployment prerequisite — never deployed to Arc,
/// where V4.4 remains the live, audited-scope contract):
///  - maxBountyAmount: an owner-settable cap on createBounty's reward, 0 means
///    uncapped. A mainnet deployment without an external audit (Base) ships
///    with this set to bound worst-case loss; Arc's own deployment stays on
///    V4.4 and is never redeployed to pick this up.
///  - owner: a new role, separate from arbitrator on purpose (the arbitrator
///    is intentionally decoupled from the dev team via the 2-of-3 Safe; this
///    cap is a team-controlled safety knob, not a dispute-resolution power).
///    Two-step transfer, mirroring the existing arbitrator/feeRecipient
///    pattern.
contract BountyAdapter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IAgenticCommerce public immutable agenticCommerce;
    IIdentityRegistry public immutable identityRegistry;
    IReputationRegistry public immutable reputationRegistry;
    IERC20 public immutable usdc;

    address public feeRecipient;
    address public pendingFeeRecipient;
    address public arbitrator;
    address public pendingArbitrator;
    uint256 public immutable feeBps;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MIN_REWARD = 1e6;

    /// @notice V4.5: owner-settable createBounty cap, 0 = uncapped. See the
    ///         V4.5 changelog note above for why this is a separate role from
    ///         `arbitrator`.
    address public owner;
    address public pendingOwner;
    uint256 public maxBountyAmount;

    uint256 public constant DISPUTE_RESPONSE_WINDOW = 48 hours;
    uint256 public constant REJECTION_CHALLENGE_WINDOW = 48 hours;
    /// @notice After this period from submitWork, anyone may call autoApprove
    ///         and the worker is paid. Protects workers from posters who vanish.
    uint256 public constant APPROVAL_TIMEOUT = 14 days;
    /// @notice After this period from disputeRaisedAt, if the respondent DID
    ///         reply (so claimDefaultRuling's silence-based path doesn't apply)
    ///         but the arbitrator never called resolveDispute, anyone may call
    ///         claimArbitratorTimeout for a neutral 50/50 split. Prevents an
    ///         unresponsive or compromised arbitrator from freezing funds
    ///         forever — the one liveness gap in V3.2.
    uint256 public constant ARBITRATOR_TIMEOUT = 30 days;

    // String length bounds — keep storage cheap and SSTORE refunds predictable.
    uint256 public constant MAX_CID_LEN = 96; // CIDv1 + ipfs:// prefix
    uint256 public constant MAX_CATEGORY = 16;
    uint256 public constant MAX_TAG_LEN = 32;
    uint256 public constant MAX_TAGS = 10;

    // V4: opt-in worker bond, deters free bounty-squatting (take-and-vanish).
    // Bond = max(MIN_WORKER_BOND, reward * WORKER_BOND_BPS / BPS_DENOMINATOR).
    // Refunded in full at submitWork (it only deters vanishing, not quality);
    // forfeited to the poster if the bounty expires while taken, unsubmitted.
    uint256 public constant WORKER_BOND_BPS = 1500; // 15%
    uint256 public constant MIN_WORKER_BOND = 0.5e6; // 0.50 USDC floor
    /// @notice V4.1: minimum createBounty→deadline span for bond bounties.
    ///         Prevents the bond-honeypot: a near-immediate deadline on a
    ///         requireWorkerBond listing would let the poster farm forfeited
    ///         bonds from auto-taking agents that cannot plausibly deliver
    ///         in time. Does not apply to bond-free bounties.
    uint256 public constant MIN_BOND_BOUNTY_DURATION = 24 hours;
    /// @notice V4.2: minimum time left to the deadline for TAKING a bond
    ///         bounty. Complements MIN_BOND_BOUNTY_DURATION (which only
    ///         bounds the listing's total duration at creation): without it,
    ///         an aged bond listing taken minutes before its deadline still
    ///         traps the worker's bond. Set to half the creation floor so a
    ///         fresh minimal-duration (24h) listing is takeable for its
    ///         first 12h. Does not apply to bond-free bounties.
    uint256 public constant MIN_BOND_TAKE_WINDOW = 12 hours;

    struct CreateParams {
        address provider; // 0x0 = open. If non-zero, only this address (or owner of agentId) can take.
        uint256 reward;
        uint256 deadline;
        string ipfsDescHash;
        string category;
        string[] tags;
        bool agentOnly;
        bool humanOnly;
        bool requireWorkerBond; // V4: opt-in — worker must post a bond to take this bounty
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
        // V4: worker bond
        bool requireWorkerBond;
        uint256 workerBond; // 0 once refunded (submitWork) or forfeited (expireBounty)
    }

    /// @dev Our own view-convenience shape for getAgentReputation — NOT a type from
    ///      the registry itself (see IReputationRegistry: it only exposes
    ///      count/summaryValue/summaryValueDecimals via getSummary). Kept identical
    ///      to the pre-V4.3 shape so the frontend ABI didn't need to change.
    struct ReputationScore {
        uint256 averageScore;
        uint256 totalFeedbacks;
        uint256 totalJobs;
    }

    mapping(uint256 => BountyMeta) private _bounties;
    uint256[] public allJobIds;

    // Sprint 1: O(1) index slices.
    mapping(address => uint256[]) private _postedBy;
    mapping(address => uint256[]) private _assignedTo;
    mapping(uint256 => uint256[]) private _byAgent;

    // V4: anti-Sybil signal — count of distinct posters who have actually paid
    // out a completed bounty to a given agent. Cheap, on-chain, tamper-proof:
    // faking N "unique" posters costs N real funded wallets, not one alt
    // account. See V4_DESIGN_ANTI_SYBIL.md.
    mapping(uint256 => mapping(address => bool)) private _hasPostedForAgent;
    mapping(uint256 => uint256) public uniquePosterCount;

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
    event RejectionWithdrawn(uint256 indexed jobId);
    event DisputeRaised(uint256 indexed jobId, address indexed initiator, string reasonHash);
    event DisputeResponded(uint256 indexed jobId, address indexed responder, string responseHash);
    event DisputeResolved(uint256 indexed jobId, bool payProvider, string rulingHash, bool defaultRuling);
    event ArbitratorTransferStarted(address indexed previous, address indexed pending);
    event ArbitratorTransferred(address indexed previous, address indexed next);
    event FeeRecipientTransferStarted(address indexed previous, address indexed pending);
    event FeeRecipientTransferred(address indexed previous, address indexed next);
    event OwnerTransferStarted(address indexed previous, address indexed pending);
    event OwnerTransferred(address indexed previous, address indexed next);
    event MaxBountyAmountUpdated(uint256 previous, uint256 next);
    event ArbitratorTimeoutClaimed(uint256 indexed jobId, uint256 posterAmount, uint256 providerAmount);
    event WorkerBondPosted(uint256 indexed jobId, address indexed worker, uint256 amount);
    event WorkerBondRefunded(uint256 indexed jobId, address indexed worker, uint256 amount);
    event WorkerBondForfeited(uint256 indexed jobId, address indexed poster, uint256 amount);

    constructor(
        address _agenticCommerce,
        address _identityRegistry,
        address _reputationRegistry,
        address _usdc,
        address _feeRecipient,
        uint256 _feeBps,
        uint256 _maxBountyAmount
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
        owner = msg.sender;
        feeBps = _feeBps;
        maxBountyAmount = _maxBountyAmount;
    }

    // ─── Lifecycle ─────────────────────────────────────────────────────────────

    function createBounty(CreateParams calldata p) external nonReentrant returns (uint256 jobId) {
        require(p.reward >= MIN_REWARD, "reward too low");
        require(maxBountyAmount == 0 || p.reward <= maxBountyAmount, "reward exceeds maxBountyAmount");
        require(p.deadline > block.timestamp, "deadline in past");
        if (p.requireWorkerBond) {
            // Bond honeypot guard — see MIN_BOND_BOUNTY_DURATION natspec.
            require(p.deadline >= block.timestamp + MIN_BOND_BOUNTY_DURATION, "bond bounty: deadline too soon");
        }
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
        meta.requireWorkerBond = p.requireWorkerBond;
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
        if (meta.requireWorkerBond) {
            // V4.2 residual-honeypot guard — see MIN_BOND_TAKE_WINDOW natspec.
            require(block.timestamp + MIN_BOND_TAKE_WINDOW <= meta.deadline, "bond bounty: too close to deadline");
        }

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
            // ownerOf is the authoritative check: ERC-721 ownerOf reverts for a
            // non-existent tokenId, so "caller owns this agentId" already proves
            // the agent is registered. We deliberately do NOT call isRegistered()
            // — the live Arc ERC-8004 registry reverts on it, and ownerOf alone
            // gives the same guarantee.
            require(identityRegistry.ownerOf(agentId) == msg.sender, "agent only: caller is not agent owner");
            meta.agentId = agentId;
            _byAgent[agentId].push(jobId);
        }

        meta.isTaken = true;
        meta.assignedProvider = msg.sender;
        _assignedTo[msg.sender].push(jobId);

        // All state written above and here (CEI: effects before the external
        // calls below) — including workerBond, so no write is left dangling
        // after fund()/safeTransferFrom() the way a naive ordering would.
        uint256 bond = 0;
        if (meta.requireWorkerBond) {
            bond = _workerBondFor(meta.reward);
            meta.workerBond = bond;
        }

        // Fund the AC escrow now (adapter is the client).
        usdc.forceApprove(address(agenticCommerce), meta.reward);
        agenticCommerce.fund(jobId, bytes(""));

        if (bond > 0) {
            usdc.safeTransferFrom(msg.sender, address(this), bond);
            emit WorkerBondPosted(jobId, msg.sender, bond);
        }

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
        // Effect (zeroing workerBond) before any interaction below — CEI.
        // Bond only deters taking-and-vanishing — once real work is submitted,
        // refund it immediately rather than holding it through approval/dispute.
        uint256 bond = meta.workerBond;
        meta.workerBond = 0;

        bytes32 deliverable = keccak256(abi.encodePacked(ipfsResultHash));
        agenticCommerce.submit(jobId, deliverable, bytes(""));

        if (bond > 0) {
            usdc.safeTransfer(msg.sender, bond);
            emit WorkerBondRefunded(jobId, msg.sender, bond);
        }

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
        _recordUniquePoster(meta);

        if (meta.agentId > 0) {
            // Reputation write must never block the payout: the worker has
            // already been paid above. The live ERC-8004 registry may revert
            // (e.g. unauthorized feedback), so swallow any failure.
            try reputationRegistry.giveFeedback(
                meta.agentId,
                int128(uint128(reputationScore)),
                0,
                "bounty_completed",
                "",
                "",
                "",
                keccak256(abi.encodePacked("bounty_completed", jobId))
            ) {}
                catch {}
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
        _recordUniquePoster(meta);

        if (meta.agentId > 0) {
            try reputationRegistry.giveFeedback(
                meta.agentId,
                80,
                0,
                "bounty_auto_approved",
                "",
                "",
                "",
                keccak256(abi.encodePacked("auto_approved", jobId))
            ) {}
                catch {}
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
        // Without this bound, a poster could sit on a correct submission for
        // up to APPROVAL_TIMEOUT and then reject right before autoApprove
        // would otherwise fire, buying another REJECTION_CHALLENGE_WINDOW (or
        // a full dispute) of delay for free. Once the approval window has
        // elapsed, autoApprove is the only path forward — matches the
        // permissionless-liveness guarantee the rest of the contract makes.
        require(block.timestamp <= meta.submittedAt + APPROVAL_TIMEOUT, "approval window elapsed, use autoApprove");
        _requireCid(ipfsReasonHash, "reason");

        meta.rejectedAt = block.timestamp;
        meta.rejectionReasonHash = ipfsReasonHash;
        emit RejectionProposed(jobId, msg.sender, ipfsReasonHash);
    }

    /// @notice Lets a poster who rejected a submission and changed their mind
    ///         withdraw the pending rejection before the worker challenges it
    ///         (or before it's finalized). Without this, a poster stuck in
    ///         `rejectedAt != 0` had no way back to `approveBounty` — only
    ///         forward to a challenge/dispute or a 48h wait for finalize.
    function withdrawRejection(uint256 jobId) external nonReentrant {
        BountyMeta storage meta = _bounties[jobId];
        require(meta.poster == msg.sender, "only poster");
        require(meta.rejectedAt != 0, "no pending rejection");
        require(!meta.inDispute, "already challenged");
        require(!meta.resolved, "resolved");

        meta.rejectedAt = 0;
        meta.rejectionReasonHash = "";
        emit RejectionWithdrawn(jobId);
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
        // Effect (zeroing workerBond) before any interaction below — CEI.
        uint256 bond = meta.workerBond;
        meta.workerBond = 0;

        if (meta.isTaken) {
            _rejectAndRefund(jobId, "expired");
            // Worker took the bounty, posted a bond, then vanished without
            // submitting — forfeit the bond to the poster whose listing was
            // blocked for the bounty's whole duration.
            if (bond > 0) {
                usdc.safeTransfer(meta.poster, bond);
                emit WorkerBondForfeited(jobId, meta.poster, bond);
            }
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
        // V4.2: same bound as rejectBounty (V4.1). Without it, a poster
        // blocked from rejecting past the approval window could open a
        // dispute instead — the same free delay the V4.1 fix was meant to
        // close, with a worse worst case (arbitrator silence ends at a 50/50
        // split instead of the worker's full autoApprove payout). Harmless
        // for workers: past the window a worker wants autoApprove, never a
        // dispute.
        require(block.timestamp <= meta.submittedAt + APPROVAL_TIMEOUT, "approval window elapsed, use autoApprove");
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

    /// @notice Permissionless neutral resolution when the arbitrator never
    ///         rules after both parties have already submitted evidence (so
    ///         claimDefaultRuling's silence-based path is unavailable). Splits
    ///         the payout 50/50 between poster and worker; no reputation
    ///         penalty is applied since fault was never adjudicated. This is
    ///         the last-resort liveness path — resolveDispute by the real
    ///         arbitrator remains strictly preferable and should always be
    ///         faster in practice.
    function claimArbitratorTimeout(uint256 jobId) external nonReentrant {
        BountyMeta storage meta = _bounties[jobId];
        require(meta.inDispute, "not in dispute");
        require(!meta.resolved, "resolved");
        require(bytes(meta.disputeResponseHash).length > 0, "use claimDefaultRuling");
        require(block.timestamp > meta.disputeRaisedAt + ARBITRATOR_TIMEOUT, "arbitrator window open");

        meta.resolved = true;
        meta.inDispute = false;
        meta.disputeRulingHash = "timeout:50-50-split";

        (uint256 posterAmount, uint256 providerAmount) = _completeAndSplit(jobId, meta.poster, meta.assignedProvider);

        emit ArbitratorTimeoutClaimed(jobId, posterAmount, providerAmount);
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
        // feedbackType = 1 → "negative". Non-blocking: a dispute resolution must
        // settle funds even if the live registry rejects the feedback write.
        try reputationRegistry.giveFeedback(
            meta.agentId,
            int128(uint128(penalty)),
            0,
            "bounty_failed",
            "",
            "",
            "",
            keccak256(abi.encodePacked("dispute_rejected", meta.jobId))
        ) {}
            catch {}
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

    /// @dev Pulls received USDC from AC via complete() and splits the full
    ///      proceeds 50/50 between the two payees. Used only by
    ///      claimArbitratorTimeout — NO protocol fee here (V4.4): this path
    ///      only fires when the arbitrator failed to provide the service the
    ///      fee is charged for, so charging it on a neutral fault-neither-side
    ///      fallback would tax users for the protocol's own liveness failure.
    function _completeAndSplit(uint256 jobId, address payeeA, address payeeB)
        internal
        returns (uint256 amountA, uint256 amountB)
    {
        uint256 before = usdc.balanceOf(address(this));
        agenticCommerce.complete(jobId, keccak256("arbitrator_timeout"), bytes("arbitrator_timeout"));
        uint256 received = usdc.balanceOf(address(this)) - before;
        if (received == 0) return (0, 0);

        amountA = received / 2;
        amountB = received - amountA; // remainder (if received is odd) goes to payeeB
        if (amountA > 0) usdc.safeTransfer(payeeA, amountA);
        if (amountB > 0) usdc.safeTransfer(payeeB, amountB);
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

    // ─── Fee recipient transfer (2-step, self-service) ─────────────────────────

    /// @notice The current fee recipient nominates its own successor. Kept
    ///         independent of the arbitrator role by design — a compromised
    ///         fee wallet or planned rotation shouldn't require arbitrator
    ///         involvement, and the arbitrator should never be able to
    ///         unilaterally redirect protocol fees.
    function transferFeeRecipient(address next) external {
        require(msg.sender == feeRecipient, "only fee recipient");
        require(next != address(0), "next=0");
        pendingFeeRecipient = next;
        emit FeeRecipientTransferStarted(feeRecipient, next);
    }

    function acceptFeeRecipient() external {
        require(msg.sender == pendingFeeRecipient, "not pending");
        address prev = feeRecipient;
        feeRecipient = pendingFeeRecipient;
        pendingFeeRecipient = address(0);
        emit FeeRecipientTransferred(prev, feeRecipient);
    }

    // ─── Owner transfer (2-step) + safety cap ───────────────────────────────────

    /// @notice V4.5. Kept independent of the arbitrator role by design — see
    ///         the V4.5 changelog note at the top of this contract.
    function transferOwner(address next) external {
        require(msg.sender == owner, "only owner");
        require(next != address(0), "next=0");
        pendingOwner = next;
        emit OwnerTransferStarted(owner, next);
    }

    function acceptOwner() external {
        require(msg.sender == pendingOwner, "not pending");
        address prev = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnerTransferred(prev, owner);
    }

    /// @notice V4.5. 0 = uncapped. Existing bounties above a newly-lowered cap
    ///         are unaffected — this only gates future createBounty calls.
    function setMaxBountyAmount(uint256 next) external {
        require(msg.sender == owner, "only owner");
        emit MaxBountyAmountUpdated(maxBountyAmount, next);
        maxBountyAmount = next;
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

    function getAgentReputation(uint256 agentId) external view returns (ReputationScore memory) {
        address[] memory clients = new address[](1);
        clients[0] = address(this);
        (uint64 count, int128 summaryValue, uint8 summaryValueDecimals) =
            reputationRegistry.getSummary(agentId, clients, "", "");
        // casting to 'uint256' is safe because every value we write via
        // giveFeedback is a uint8 score/penalty (0-255); the `< 0` guard above
        // handles the only other sign this int128 could carry.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 avg = summaryValue < 0 ? 0 : uint256(int256(summaryValue));
        // We always write valueDecimals=0 (a plain 0-100 scale), so this is a
        // no-op in practice — kept so the read stays correct even if a future
        // write path (or a differently-configured caller) starts using decimals.
        if (summaryValueDecimals > 0) avg = avg / (10 ** summaryValueDecimals);
        return ReputationScore({averageScore: avg, totalFeedbacks: count, totalJobs: count});
    }

    function totalBounties() external view returns (uint256) {
        return allJobIds.length;
    }

    // ─── Internal helpers ──────────────────────────────────────────────────────

    /// @dev V4: bond = max(MIN_WORKER_BOND, reward * WORKER_BOND_BPS / BPS_DENOMINATOR).
    function _workerBondFor(uint256 reward) internal pure returns (uint256) {
        uint256 pct = (reward * WORKER_BOND_BPS) / BPS_DENOMINATOR;
        return pct > MIN_WORKER_BOND ? pct : MIN_WORKER_BOND;
    }

    /// @dev V4: increments uniquePosterCount[agentId] the first time a given
    ///      poster completes a bounty with that agent as worker. No-op for
    ///      human workers (agentId == 0) or a poster already counted.
    function _recordUniquePoster(BountyMeta storage meta) internal {
        if (meta.agentId == 0) return;
        if (_hasPostedForAgent[meta.agentId][meta.poster]) return;
        _hasPostedForAgent[meta.agentId][meta.poster] = true;
        uniquePosterCount[meta.agentId]++;
    }

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
