// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IAgenticCommerce.sol";
import "./interfaces/IMonadIdentityRegistry.sol";
import "../interfaces/IReputationRegistry.sol";
import "./ReputationMirror.sol";

/// @title NadBounty V4.8, isolated from the live Arc/Base V4.7 adapter
/// @notice Single-taker escrow with identity-owner payouts and reputation gates.
/// @dev Stage 2: contest creation fails closed until its lifecycle is implemented.
///      AgenticCommerce remains the unchanged escrow rail; this adapter holds
///      client/provider/evaluator roles. Deploys paused with 1% fee / 100 USDC cap.
contract BountyAdapterV48 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IAgenticCommerce public immutable agenticCommerce;
    IMonadIdentityRegistry public immutable identityRegistry;
    ReputationMirror public immutable reputationMirror;
    IReputationRegistry public immutable reputationRegistry;
    IERC20 public immutable usdc;

    address public feeRecipient;
    address public pendingFeeRecipient;
    address public arbitrator;
    address public pendingArbitrator;
    uint256 public immutable feeBps;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MIN_REWARD = 1e6;

    /// @notice Owner-settable createBounty cap, 0 = uncapped. The safety role
    ///         remains independent of the dispute-resolution arbitrator role.
    address public owner;
    address public pendingOwner;
    uint256 public maxBountyAmount;

    /// @notice V4.7: real circuit breaker. Blocks only createBounty/takeBounty
    ///         (new obligations) — every exit path stays open.
    bool public paused;

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

    /// @notice V4.7: buffer added to a bounty's own deadline when creating the
    ///         underlying AC job's `expiredAt`. Must exceed the adapter's own
    ///         worst-case post-deadline lifecycle — APPROVAL_TIMEOUT (14d) +
    ///         REJECTION_CHALLENGE_WINDOW (2d) + ARBITRATOR_TIMEOUT (30d) =
    ///         46d — so AC's permissionless claimRefund can never fire while
    ///         the adapter still considers the job live.
    /// @dev This assumes `block.timestamp` tracks real wall-clock time closely
    ///      enough that "46d worst case, 90d buffer" stays a real 2x margin.
    ///      A chain whose clock runs measurably faster than real time (Arc
    ///      Testnet has been observed doing this) shrinks that margin in wall
    ///      time even though the on-chain math is unaffected — acceptable on
    ///      a testnet with no real funds, but re-verify this assumption
    ///      against the actual chain before relying on it for a mainnet
    ///      deployment with a similarly fast clock.
    uint256 public constant AC_EXPIRY_BUFFER = 90 days;

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
        bool contest;
        uint8 maxEntries;
        uint8 winners;
        uint64 minJobs;
        uint8 minAvgScore;
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
        address bondPayer;
        bool disputeByWorker;
        bool contest;
        uint8 maxEntries;
        uint8 winners;
        uint64 minJobs;
        uint8 minAvgScore;
    }

    struct LocalReputation {
        uint256 paidJobs;
        uint256 scoreSum;
    }

    mapping(bytes32 identity => LocalReputation) public localReputation;
    /// @notice Earnings whose identity owner could not be resolved at settlement.
    mapping(uint256 agentId => uint256 amount) public pendingIdentityWithdrawals;

    error InvalidGateScore();
    error ReputationGateFailed(uint256 paidJobs, uint256 scoreSum);
    error InvalidIdentity();
    error WrongBountyMode();
    error InvalidContestParams();
    error UnexpectedEscrowAmount(uint256 received, uint256 expected);

    struct ContestEntry {
        uint256 agentId;
        address entrant;
        string resultHash;
        bool awarded;
    }

    mapping(uint256 jobId => ContestEntry[]) private _contestEntries;
    mapping(uint256 jobId => mapping(bytes32 identity => uint256 indexPlusOne)) private _contestEntryIndex;
    mapping(uint256 jobId => uint256 timestamp) private _contestClosedAt;

    struct ContestChallenge {
        uint256 challengedAt;
        uint256 respondedAt;
        string evidenceHash;
        string responseHash;
    }

    mapping(uint256 jobId => mapping(uint8 entryIndex => ContestChallenge)) private _contestChallenges;
    mapping(uint256 jobId => uint8[]) private _contestChallengers;

    event ContestRejected(uint256 indexed jobId, string reasonHash, uint256 challengeDeadline);
    event ContestChallenged(
        uint256 indexed jobId, uint8 indexed entryIndex, string evidenceHash, uint256 responseDeadline
    );
    event ContestChallengeResponded(uint256 indexed jobId, uint8 indexed entryIndex, string responseHash);
    event ContestRuling(uint256 indexed jobId, bool refundPoster, string rulingHash);
    event ContestRefunded(uint256 indexed jobId, bool escrowRecovery);
    event ContestArbitratorTimeout(
        uint256 indexed jobId, uint256 posterAmount, uint256 challengerAmount, bool escrowRecovery
    );

    event ContestCreated(uint256 indexed jobId, uint8 maxEntries, uint8 winners);
    event ContestEntered(
        uint256 indexed jobId,
        uint8 indexed entryIndex,
        bytes32 indexed identity,
        uint256 agentId,
        address entrant,
        string resultHash
    );
    event ContestEntryReplaced(uint256 indexed jobId, uint8 indexed entryIndex, string resultHash);
    event ContestClosed(uint256 indexed jobId, uint256 closedAt);
    event ContestAwarded(uint256 indexed jobId, uint8 indexed entryIndex, uint256 amount, bool scored, uint8 score);
    event ContestSettled(uint256 indexed jobId, bool scored, bool escrowRecovery);

    event LocalReputationUpdated(bytes32 indexed identity, uint256 paidJobs, uint256 scoreSum);
    event IdentityPayoutParked(uint256 indexed jobId, uint256 indexed agentId, uint256 amount);
    event IdentityWithdrawalClaimed(uint256 indexed agentId, address indexed identityOwner, uint256 amount);

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

    /// @notice USDC owed to an address whose direct payout could not be pushed.
    /// @dev V4.6. Every settlement path used to push with `safeTransfer`, which
    ///      reverts the WHOLE transaction on failure — including the
    ///      `meta.resolved = true` effect that precedes it. USDC (on both Arc
    ///      and Base: `blacklister()` returns a live address on each) reverts
    ///      unconditionally on a transfer to a blacklisted address, so a single
    ///      compliance action against a poster or worker would have stranded
    ///      that bounty permanently — every retry reverting the same way, funds
    ///      left in AC escrow with no recovery path (there is no rescue
    ///      function, by design). Worse, the fee leg pays `feeRecipient` FIRST
    ///      on the main approval path, so blacklisting that one address would
    ///      have frozen payouts protocol-wide, not just one job.
    ///      Failed pushes now park here and the payee pulls them via
    ///      `withdraw()`, so a blacklist event degrades to "funds parked"
    ///      instead of "job permanently stuck".
    mapping(address => uint256) public pendingWithdrawals;

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
    event PausedSet(bool paused);
    event ExternalRefundReconciled(
        uint256 indexed jobId,
        address indexed poster,
        address indexed worker,
        uint256 posterAmount,
        uint256 workerAmount
    );
    event ArbitratorTimeoutClaimed(uint256 indexed jobId, uint256 posterAmount, uint256 providerAmount);
    event WorkerBondPosted(uint256 indexed jobId, address indexed worker, uint256 amount);
    event WorkerBondRefunded(uint256 indexed jobId, address indexed worker, uint256 amount);
    event WorkerBondForfeited(uint256 indexed jobId, address indexed poster, uint256 amount);
    /// @notice A direct payout failed and was credited to `pendingWithdrawals` instead.
    event PayoutParked(uint256 indexed jobId, address indexed payee, uint256 amount);
    event WithdrawalClaimed(address indexed payee, uint256 amount);

    constructor(
        address _agenticCommerce,
        address _identityRegistry,
        address _reputationRegistry,
        address _usdc,
        address _feeRecipient,
        address _reputationMirror
    ) {
        require(_agenticCommerce != address(0), "ac=0");
        require(_identityRegistry != address(0), "id=0");
        require(_reputationRegistry != address(0), "rep=0");
        require(_usdc != address(0), "usdc=0");
        require(_feeRecipient != address(0), "fee=0");
        require(_reputationMirror != address(0), "mirror=0");

        agenticCommerce = IAgenticCommerce(_agenticCommerce);
        identityRegistry = IMonadIdentityRegistry(_identityRegistry);
        reputationMirror = ReputationMirror(_reputationMirror);
        reputationRegistry = IReputationRegistry(_reputationRegistry);
        usdc = IERC20(_usdc);
        feeRecipient = _feeRecipient;
        arbitrator = msg.sender;
        owner = msg.sender;
        feeBps = 100;
        maxBountyAmount = 100e6;
        paused = true;
    }

    // ─── Lifecycle ─────────────────────────────────────────────────────────────

    function createBounty(CreateParams calldata p) external nonReentrant returns (uint256 jobId) {
        require(!paused, "paused");
        if (p.minAvgScore > 100) revert InvalidGateScore();
        if (p.contest) {
            if (
                p.requireWorkerBond || p.maxEntries == 0 || p.maxEntries > 25 || p.winners == 0
                    || p.winners > p.maxEntries
            ) {
                revert InvalidContestParams();
            }
        }
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
        // V4.7: AC's expiredAt is the deadline plus a large buffer, not the
        // bounty deadline itself — see AC_EXPIRY_BUFFER natspec / the V4.7
        // changelog note (closes C-02).
        jobId = agenticCommerce.createJob(
            address(this), address(this), p.deadline + AC_EXPIRY_BUFFER, p.ipfsDescHash, address(0)
        );
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
        meta.contest = p.contest;
        meta.maxEntries = p.maxEntries;
        meta.winners = p.winners;
        meta.minJobs = p.minJobs;
        meta.minAvgScore = p.minAvgScore;
        for (uint256 i = 0; i < p.tags.length; i++) {
            meta.tags.push(p.tags[i]);
        }
        allJobIds.push(jobId);
        _postedBy[msg.sender].push(jobId);

        if (p.contest) {
            usdc.forceApprove(address(agenticCommerce), p.reward);
            agenticCommerce.fund(jobId, bytes(""));
            emit ContestCreated(jobId, p.maxEntries, p.winners);
        }

        emit BountyCreated(jobId, msg.sender, p.reward, p.category, p.deadline);
    }

    /// @notice Ciphertext CID only; encryption and key management are off-chain.
    function enterContest(uint256 jobId, uint256 agentId, string calldata resultHash) external nonReentrant {
        require(!paused, "paused");
        BountyMeta storage meta = _requireContest(jobId);
        require(contestClosedAt(jobId) == 0, "contest closed");
        _requireCid(resultHash, "ipfsResult");
        if (meta.agentOnly) require(agentId != 0, "agent only: provide agentId");
        if (meta.humanOnly) require(agentId == 0, "human only: no agentId");
        address identityOwner = agentId == 0 ? msg.sender : _requireAgentCaller(agentId);
        if (meta.whitelistedProvider != address(0)) {
            require(
                meta.whitelistedProvider == msg.sender || meta.whitelistedProvider == identityOwner, "not whitelisted"
            );
        }
        bytes32 key = identityKey(agentId, msg.sender);
        require(_contestEntryIndex[jobId][key] == 0, "already entered");
        _checkGate(agentId, identityOwner, msg.sender, meta.minJobs, meta.minAvgScore);
        uint256 index = _contestEntries[jobId].length;
        // Admission is bounded by capacity, independently of the closure view.
        require(index < meta.maxEntries, "contest full");
        _contestEntries[jobId].push(ContestEntry(agentId, msg.sender, resultHash, false));
        _contestEntryIndex[jobId][key] = index + 1;
        _assignedTo[msg.sender].push(jobId);
        if (agentId != 0) _byAgent[agentId].push(jobId);
        if (index + 1 == meta.maxEntries) {
            _contestClosedAt[jobId] = block.timestamp;
            emit ContestClosed(jobId, block.timestamp);
        }
        // AC has one deliverable slot. Commit to the contest, not an individual
        // entry, so replacements and multiple winners need no escrow changes.
        if (index == 0) agenticCommerce.submit(jobId, keccak256(abi.encode("NadBounty.contest", jobId)), bytes(""));
        emit ContestEntered(jobId, uint8(index), key, agentId, msg.sender, resultHash);
    }

    function replaceContestEntry(uint256 jobId, uint8 entryIndex, string calldata resultHash) external nonReentrant {
        require(!paused, "paused");
        _requireContest(jobId);
        require(contestClosedAt(jobId) == 0, "contest closed");
        require(entryIndex < _contestEntries[jobId].length, "invalid entry");
        ContestEntry storage entry = _contestEntries[jobId][entryIndex];
        if (entry.agentId == 0) require(msg.sender == entry.entrant, "not entrant");
        else _requireAgentCaller(entry.agentId);
        _requireCid(resultHash, "ipfsResult");
        entry.resultHash = resultHash;
        emit ContestEntryReplaced(jobId, entryIndex, resultHash);
    }

    /// @notice Scores correspond to the selected entry indices, in order.
    function pickContestWinners(uint256 jobId, uint8[] calldata entryIndices, uint8[] calldata scores)
        external
        nonReentrant
    {
        BountyMeta storage meta = _requireContest(jobId);
        require(msg.sender == meta.poster, "only poster");
        require(meta.rejectedAt == 0, "contest rejected");
        uint256 closed = contestClosedAt(jobId);
        require(closed == 0 || block.timestamp <= closed + APPROVAL_TIMEOUT, "review ended");
        require(entryIndices.length > 0 && entryIndices.length <= meta.winners, "invalid winner count");
        require(scores.length == entryIndices.length, "invalid scores");
        _validateContestSelection(jobId, entryIndices);
        for (uint256 i; i < scores.length; ++i) {
            require(scores[i] <= 100, "score > 100");
        }
        _settleContest(jobId, entryIndices, scores, true, false);
    }

    /// @notice Permissionless after the full review window. No reputation credit.
    function settleContestSilence(uint256 jobId) external nonReentrant {
        BountyMeta storage meta = _requireContest(jobId);
        require(meta.rejectedAt == 0, "contest rejected");
        require(_contestEntries[jobId].length > 0, "no entries");
        uint256 closed = contestClosedAt(jobId);
        require(closed != 0 && block.timestamp > closed + APPROVAL_TIMEOUT, "review active");
        _settleContest(jobId, _allContestEntries(jobId), new uint8[](0), false, false);
    }

    function rejectAllContestEntries(uint256 jobId, string calldata reasonHash) external nonReentrant {
        BountyMeta storage meta = _requireContest(jobId);
        require(msg.sender == meta.poster, "only poster");
        require(meta.rejectedAt == 0, "contest rejected");
        require(_contestEntries[jobId].length > 0, "no entries");
        uint256 closed = contestClosedAt(jobId);
        require(closed != 0, "contest still open");
        require(block.timestamp <= closed + APPROVAL_TIMEOUT, "review ended");
        _requireCid(reasonHash, "ipfsReason");
        meta.rejectedAt = block.timestamp;
        meta.rejectionReasonHash = reasonHash;
        emit ContestRejected(jobId, reasonHash, block.timestamp + REJECTION_CHALLENGE_WINDOW);
    }

    function challengeContestRejection(uint256 jobId, uint8 entryIndex, string calldata evidenceHash)
        external
        nonReentrant
    {
        BountyMeta storage meta = _requireContest(jobId);
        require(meta.rejectedAt != 0, "contest not rejected");
        require(block.timestamp <= meta.rejectedAt + REJECTION_CHALLENGE_WINDOW, "challenge window closed");
        require(entryIndex < _contestEntries[jobId].length, "invalid entry");
        ContestEntry storage entry = _contestEntries[jobId][entryIndex];
        if (entry.agentId == 0) require(msg.sender == entry.entrant, "not entrant");
        else _requireAgentCaller(entry.agentId);
        ContestChallenge storage challenge = _contestChallenges[jobId][entryIndex];
        require(challenge.challengedAt == 0, "already challenged");
        _requireCid(evidenceHash, "ipfsEvidence");
        challenge.challengedAt = block.timestamp;
        challenge.evidenceHash = evidenceHash;
        _contestChallengers[jobId].push(entryIndex);
        if (!meta.inDispute) {
            meta.inDispute = true;
            meta.disputeRaisedAt = block.timestamp;
        }
        emit ContestChallenged(jobId, entryIndex, evidenceHash, block.timestamp + DISPUTE_RESPONSE_WINDOW);
    }

    /// @notice Covers every currently unanswered challenge; later challenges
    ///         retain their own 48-hour response deadline and need another call.
    function respondToContestChallenges(uint256 jobId, string calldata responseHash) external nonReentrant {
        BountyMeta storage meta = _requireContest(jobId);
        require(msg.sender == meta.poster, "only poster");
        require(meta.inDispute, "no challenges");
        require(block.timestamp <= meta.disputeRaisedAt + ARBITRATOR_TIMEOUT, "arbitrator window ended");
        _requireCid(responseHash, "ipfsResponse");
        require(!_contestHasOverdueChallenge(jobId), "response window closed");
        uint8[] storage challengers = _contestChallengers[jobId];
        bool responded = false;
        for (uint256 i; i < challengers.length; ++i) {
            ContestChallenge storage challenge = _contestChallenges[jobId][challengers[i]];
            if (challenge.respondedAt != 0) continue;
            challenge.respondedAt = block.timestamp;
            challenge.responseHash = responseHash;
            responded = true;
            emit ContestChallengeResponded(jobId, challengers[i], responseHash);
        }
        require(responded, "already responded");
        meta.disputeResponseHash = responseHash;
    }

    function acceptContestChallengers(uint256 jobId, uint8[] calldata entryIndices, uint8[] calldata scores)
        external
        nonReentrant
    {
        BountyMeta storage meta = _requireContest(jobId);
        require(msg.sender == meta.poster, "only poster");
        _validateChallengerSelection(jobId, entryIndices);
        require(scores.length == entryIndices.length, "invalid scores");
        for (uint256 i; i < scores.length; ++i) {
            require(scores[i] <= 100, "score > 100");
        }
        _settleContest(jobId, entryIndices, scores, true, false);
    }

    /// @notice Permissionless refund when the 48-hour challenge window ends
    ///         without a challenge. A challenge disables this refund forever.
    function finalizeContestRejection(uint256 jobId) external nonReentrant {
        BountyMeta storage meta = _requireContest(jobId);
        require(meta.rejectedAt != 0, "contest not rejected");
        require(block.timestamp > meta.rejectedAt + REJECTION_CHALLENGE_WINDOW, "challenge window active");
        require(_contestChallengers[jobId].length == 0, "has challenges");
        _refundContest(jobId, false);
    }

    /// @notice One unanswered challenge past its own deadline is sufficient.
    ///         The common entry challenge window must also have ended.
    function claimContestDefault(uint256 jobId) external nonReentrant {
        BountyMeta storage meta = _requireContest(jobId);
        require(meta.inDispute, "no challenges");
        require(block.timestamp > meta.rejectedAt + REJECTION_CHALLENGE_WINDOW, "challenge window active");
        require(_contestHasOverdueChallenge(jobId), "no overdue challenge");
        _settleContest(jobId, _contestChallengers[jobId], new uint8[](0), false, false);
    }

    /// @param entryIndices Empty to refund; otherwise 1..winners challengers.
    function resolveContestDispute(uint256 jobId, uint8[] calldata entryIndices, string calldata rulingHash)
        external
        nonReentrant
    {
        BountyMeta storage meta = _requireContest(jobId);
        require(msg.sender == arbitrator, "only arbitrator");
        require(meta.inDispute, "no challenges");
        require(block.timestamp > meta.rejectedAt + REJECTION_CHALLENGE_WINDOW, "challenge window active");
        require(_contestAllResponded(jobId), "unanswered challenge");
        require(block.timestamp <= meta.disputeRaisedAt + ARBITRATOR_TIMEOUT, "arbitrator window ended");
        _requireCid(rulingHash, "ipfsRuling");
        if (entryIndices.length == 0) {
            _refundContest(jobId, false);
        } else {
            _validateChallengerSelection(jobId, entryIndices);
            _settleContest(jobId, entryIndices, new uint8[](0), false, false);
        }
        emit ContestRuling(jobId, entryIndices.length == 0, rulingHash);
    }

    function claimContestArbitratorTimeout(uint256 jobId) external nonReentrant {
        BountyMeta storage meta = _requireContest(jobId);
        require(meta.inDispute, "no challenges");
        require(_contestAllResponded(jobId), "unanswered challenge");
        require(block.timestamp > meta.disputeRaisedAt + ARBITRATOR_TIMEOUT, "arbitrator window active");
        _splitContestTimeout(jobId, false);
    }

    function getContestChallenge(uint256 jobId, uint8 entryIndex) external view returns (ContestChallenge memory) {
        if (!_bounties[jobId].contest) revert WrongBountyMode();
        require(entryIndex < _contestEntries[jobId].length, "invalid entry");
        return _contestChallenges[jobId][entryIndex];
    }

    function getContestChallengers(uint256 jobId) external view returns (uint8[] memory) {
        if (!_bounties[jobId].contest) revert WrongBountyMode();
        return _contestChallengers[jobId];
    }

    function _validateChallengerSelection(uint256 jobId, uint8[] memory indices) internal view {
        require(indices.length > 0 && indices.length <= _bounties[jobId].winners, "invalid winner count");
        _validateContestSelection(jobId, indices);
        for (uint256 i; i < indices.length; ++i) {
            require(_contestChallenges[jobId][indices[i]].challengedAt != 0, "not challenger");
        }
    }

    function _contestAllResponded(uint256 jobId) internal view returns (bool) {
        uint8[] storage indices = _contestChallengers[jobId];
        if (indices.length == 0) return false;
        for (uint256 i; i < indices.length; ++i) {
            if (_contestChallenges[jobId][indices[i]].respondedAt == 0) return false;
        }
        return true;
    }

    function _contestHasOverdueChallenge(uint256 jobId) internal view returns (bool) {
        uint8[] storage indices = _contestChallengers[jobId];
        for (uint256 i; i < indices.length; ++i) {
            ContestChallenge storage challenge = _contestChallenges[jobId][indices[i]];
            if (challenge.respondedAt == 0 && block.timestamp > challenge.challengedAt + DISPUTE_RESPONSE_WINDOW) {
                return true;
            }
        }
        return false;
    }

    function _refundContest(uint256 jobId, bool escrowRecovery) internal {
        BountyMeta storage meta = _bounties[jobId];
        meta.resolved = true;
        meta.inDispute = false;
        if (escrowRecovery) _payOrPark(jobId, meta.poster, meta.reward);
        else _rejectAndRefund(jobId, "contest refunded");
        emit ContestRefunded(jobId, escrowRecovery);
    }

    function _splitContestTimeout(uint256 jobId, bool escrowRecovery) internal {
        BountyMeta storage meta = _bounties[jobId];
        meta.resolved = true;
        meta.inDispute = false;
        uint8[] storage indices = _contestChallengers[jobId];
        for (uint256 i; i < indices.length; ++i) {
            _contestEntries[jobId][indices[i]].awarded = true;
        }
        uint256 gross = escrowRecovery ? meta.reward : _receiveContestReward(jobId);
        (uint256 posterAmount, uint256 workerAmount) = _splitEvenly(gross);
        _payOrPark(jobId, meta.poster, posterAmount);
        uint256 share = workerAmount / indices.length;
        uint256 remainder = workerAmount % indices.length;
        for (uint256 i; i < indices.length; ++i) {
            uint256 amount = share + (i == 0 ? remainder : 0);
            _payContestEntry(jobId, _contestEntries[jobId][indices[i]], amount);
            emit ContestAwarded(jobId, indices[i], amount, false, 0);
        }
        emit ContestArbitratorTimeout(jobId, posterAmount, workerAmount, escrowRecovery);
    }

    function _reconcileContest(uint256 jobId) internal {
        BountyMeta storage meta = _bounties[jobId];
        uint8[] storage challengers = _contestChallengers[jobId];
        if (_contestEntries[jobId].length == 0 || (meta.rejectedAt != 0 && challengers.length == 0)) {
            _refundContest(jobId, true);
        } else if (meta.rejectedAt == 0) {
            _settleContest(jobId, _allContestEntries(jobId), new uint8[](0), false, true);
        } else if (_contestAllResponded(jobId)) {
            _splitContestTimeout(jobId, true);
        } else {
            _settleContest(jobId, challengers, new uint8[](0), false, true);
        }
    }

    function getContestEntries(uint256 jobId) external view returns (ContestEntry[] memory) {
        if (!_bounties[jobId].contest) revert WrongBountyMode();
        return _contestEntries[jobId];
    }

    function getContestEntryIndex(uint256 jobId, uint256 agentId, address humanWallet)
        external
        view
        returns (uint256 indexPlusOne)
    {
        if (!_bounties[jobId].contest) revert WrongBountyMode();
        return _contestEntryIndex[jobId][identityKey(agentId, humanWallet)];
    }

    /// @dev Natural deadline closure needs no transaction. Stored closure can
    ///      only be earlier than the deadline (capacity / early selection).
    function contestClosedAt(uint256 jobId) public view returns (uint256) {
        BountyMeta storage meta = _bounties[jobId];
        if (!meta.contest) revert WrongBountyMode();
        uint256 closed = _contestClosedAt[jobId];
        if (closed != 0) return closed;
        return block.timestamp >= meta.deadline ? meta.deadline : 0;
    }

    function getContestState(uint256 jobId)
        external
        view
        returns (uint256 entryCount, uint256 closedAt, uint256 reviewDeadline, bool resolved)
    {
        closedAt = contestClosedAt(jobId);
        return (
            _contestEntries[jobId].length,
            closedAt,
            closedAt == 0 ? 0 : closedAt + APPROVAL_TIMEOUT,
            _bounties[jobId].resolved
        );
    }

    function _requireContest(uint256 jobId) internal view returns (BountyMeta storage meta) {
        meta = _bounties[jobId];
        if (!meta.contest) revert WrongBountyMode();
        require(!meta.resolved, "resolved");
    }

    function _validateContestSelection(uint256 jobId, uint8[] memory indices) internal view {
        uint256 seen = 0;
        for (uint256 i; i < indices.length; ++i) {
            require(indices[i] < _contestEntries[jobId].length, "invalid entry");
            uint256 bit = uint256(1) << indices[i];
            require(seen & bit == 0, "duplicate winner");
            seen |= bit;
        }
    }

    function _allContestEntries(uint256 jobId) internal view returns (uint8[] memory indices) {
        indices = new uint8[](_contestEntries[jobId].length);
        for (uint256 i; i < indices.length; ++i) {
            indices[i] = uint8(i);
        }
    }

    // Every entry point uses the same nonReentrant guard. The exact delta
    // isolates this receipt from deposits and parked claims for other jobs.
    // slither-disable-next-line reentrancy-balance
    function _receiveContestReward(uint256 jobId) internal returns (uint256 received) {
        uint256 before = usdc.balanceOf(address(this));
        agenticCommerce.complete(jobId, keccak256("contest settled"), bytes(""));
        received = usdc.balanceOf(address(this)) - before;
        if (received != _bounties[jobId].reward) revert UnexpectedEscrowAmount(received, _bounties[jobId].reward);
    }

    function _settleContest(
        uint256 jobId,
        uint8[] memory indices,
        uint8[] memory scores,
        bool scored,
        bool escrowRecovery
    ) internal {
        BountyMeta storage meta = _bounties[jobId];
        meta.resolved = true;
        meta.inDispute = false;
        uint256 closed = contestClosedAt(jobId);
        if (closed == 0) {
            _contestClosedAt[jobId] = block.timestamp;
            emit ContestClosed(jobId, block.timestamp);
        }
        // Mark every award before any escrow/token/registry interaction.
        for (uint256 i; i < indices.length; ++i) {
            _contestEntries[jobId][indices[i]].awarded = true;
        }
        uint256 received = escrowRecovery ? meta.reward : _receiveContestReward(jobId);
        uint256 fee = escrowRecovery ? 0 : received * feeBps / BPS_DENOMINATOR;
        uint256 net = received - fee;
        if (fee != 0) {
            _payOrPark(jobId, feeRecipient, fee);
            emit ProtocolFeePaid(jobId, feeRecipient, fee);
        }
        uint256 share = net / indices.length;
        uint256 remainder = net % indices.length;
        for (uint256 i; i < indices.length; ++i) {
            ContestEntry storage entry = _contestEntries[jobId][indices[i]];
            uint256 amount = share + (i == 0 ? remainder : 0);
            if (scored) _recordContestScore(meta, entry, scores[i]);
            _payContestEntry(jobId, entry, amount);
            emit ContestAwarded(jobId, indices[i], amount, scored, scored ? scores[i] : 0);
        }
        emit ContestSettled(jobId, scored, escrowRecovery);
    }

    // At most 25 calls to the immutable registry per settlement; a failed
    // owner read parks that identity's share and cannot block other entrants.
    // slither-disable-next-line calls-loop
    function _payContestEntry(uint256 jobId, ContestEntry storage entry, uint256 amount) internal {
        address payee = entry.entrant;
        if (entry.agentId != 0) {
            try identityRegistry.ownerOf(entry.agentId) returns (address currentOwner) {
                payee = currentOwner;
            } catch {
                payee = address(0);
            }
            if (payee == address(0)) {
                pendingIdentityWithdrawals[entry.agentId] += amount;
                emit IdentityPayoutParked(jobId, entry.agentId, amount);
                return;
            }
        }
        _payOrPark(jobId, payee, amount);
    }

    // At most 25 immutable-registry feedback calls; each failure is caught.
    // Explicitly tested with 25 agent winners as well as a reverting registry.
    // slither-disable-next-line calls-loop
    function _recordContestScore(BountyMeta storage meta, ContestEntry storage entry, uint8 score) internal {
        bytes32 key = identityKey(entry.agentId, entry.entrant);
        LocalReputation storage local = localReputation[key];
        ++local.paidJobs;
        local.scoreSum += score;
        emit LocalReputationUpdated(key, local.paidJobs, local.scoreSum);
        if (entry.agentId == 0) return;
        if (!_hasPostedForAgent[entry.agentId][meta.poster]) {
            _hasPostedForAgent[entry.agentId][meta.poster] = true;
            ++uniquePosterCount[entry.agentId];
        }
        try reputationRegistry.giveFeedback(
            entry.agentId,
            int128(uint128(score)),
            0,
            "bounty_completed",
            "contest",
            "",
            "",
            keccak256(abi.encode("contest", meta.jobId, entry.agentId))
        ) {}
            catch {}
    }

    function takeBounty(uint256 jobId, uint256 agentId) external nonReentrant {
        require(!paused, "paused");
        BountyMeta storage meta = _bounties[jobId];
        if (meta.contest) revert WrongBountyMode();
        require(meta.poster != address(0), "bounty not found");
        require(!meta.isTaken, "already taken");
        // V4.7 (C-01): without this, a cancelled-and-refunded bounty (isTaken
        // still false) could be taken again, funding AC from whatever other
        // bounty's deposit currently sits in the adapter's pooled balance.
        require(!meta.resolved, "resolved");
        require(block.timestamp <= meta.deadline, "bounty expired");
        if (meta.requireWorkerBond) {
            // V4.2 residual-honeypot guard — see MIN_BOND_TAKE_WINDOW natspec.
            require(block.timestamp + MIN_BOND_TAKE_WINDOW <= meta.deadline, "bond bounty: too close to deadline");
        }

        if (meta.agentOnly) {
            require(agentId != 0, "agent only: provide agentId");
        }
        if (meta.humanOnly) {
            require(agentId == 0, "human only: no agentId");
        }
        address identityOwner = msg.sender;
        if (agentId != 0) {
            identityOwner = _requireAgentCaller(agentId);
            meta.agentId = agentId;
            _byAgent[agentId].push(jobId);
        }
        if (meta.whitelistedProvider != address(0)) {
            require(
                meta.whitelistedProvider == msg.sender || meta.whitelistedProvider == identityOwner, "not whitelisted"
            );
        }
        _checkGate(agentId, identityOwner, msg.sender, meta.minJobs, meta.minAvgScore);

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
            meta.bondPayer = msg.sender;
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
        if (meta.contest) revert WrongBountyMode();
        require(_isWorker(meta, msg.sender), "not assigned provider");
        require(!meta.resolved, "resolved");
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
            _payOrPark(jobId, meta.bondPayer, bond);
            emit WorkerBondRefunded(jobId, meta.bondPayer, bond);
        }

        emit WorkSubmitted(jobId, msg.sender, ipfsResultHash);
    }

    function approveBounty(uint256 jobId, uint8 reputationScore) external nonReentrant {
        BountyMeta storage meta = _bounties[jobId];
        if (meta.contest) revert WrongBountyMode();
        require(meta.poster == msg.sender, "only poster");
        require(bytes(meta.submittedResultHash).length > 0, "no submission");
        require(!meta.inDispute, "in dispute");
        require(!meta.resolved, "resolved");
        require(meta.rejectedAt == 0, "rejection pending");
        require(reputationScore <= 100, "score>100");

        meta.resolved = true;
        _completeAndForward(jobId, "approved");
        _recordUniquePoster(meta);
        _recordScoredJob(meta, reputationScore);

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
        if (meta.contest) revert WrongBountyMode();
        require(bytes(meta.submittedResultHash).length > 0, "no submission");
        require(!meta.inDispute, "in dispute");
        require(!meta.resolved, "resolved");
        require(meta.rejectedAt == 0, "rejection pending");
        require(block.timestamp > meta.submittedAt + APPROVAL_TIMEOUT, "approval window open");

        meta.resolved = true;
        _completeAndForward(jobId, "auto_approved");
        _recordUniquePoster(meta);
        _recordScoredJob(meta, 80);

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
        if (meta.contest) revert WrongBountyMode();
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
        if (meta.contest) revert WrongBountyMode();
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
        if (meta.contest) revert WrongBountyMode();
        require(meta.rejectedAt != 0, "no pending rejection");
        require(!meta.resolved, "resolved");
        require(!meta.inDispute, "already in dispute");
        require(_isWorker(meta, msg.sender), "only worker");
        require(block.timestamp <= meta.rejectedAt + REJECTION_CHALLENGE_WINDOW, "challenge window closed");
        _requireCid(ipfsReasonHash, "reason");

        meta.inDispute = true;
        meta.disputeInitiator = msg.sender;
        meta.disputeByWorker = true;
        meta.disputeRaisedAt = block.timestamp;
        meta.disputeReasonHash = ipfsReasonHash;

        emit RejectionChallenged(jobId, msg.sender, ipfsReasonHash);
        emit DisputeRaised(jobId, msg.sender, ipfsReasonHash);
    }

    function finalizeRejection(uint256 jobId) external nonReentrant {
        BountyMeta storage meta = _bounties[jobId];
        if (meta.contest) revert WrongBountyMode();
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

        if (meta.contest) {
            require(_contestEntries[jobId].length == 0, "has entries");
            meta.resolved = true;
            _rejectAndRefund(jobId, "contest cancelled");
            emit BountyCancelled(jobId, "cancelled by poster");
            return;
        }

        meta.resolved = true;
        // Funds never left adapter (AC not funded until takeBounty). Full refund — no fee.
        _payOrPark(jobId, meta.poster, meta.reward);
        emit BountyCancelled(jobId, "cancelled by poster");
    }

    function expireBounty(uint256 jobId) external nonReentrant {
        BountyMeta storage meta = _bounties[jobId];
        require(meta.poster != address(0), "bounty not found");
        require(meta.contest ? block.timestamp >= meta.deadline : block.timestamp > meta.deadline, "not expired yet");
        require(!meta.resolved, "resolved");
        require(bytes(meta.submittedResultHash).length == 0, "has submission");

        if (meta.contest) {
            require(_contestEntries[jobId].length == 0, "has entries");
            meta.resolved = true;
            _rejectAndRefund(jobId, "contest without entries");
            emit BountyExpired(jobId);
            return;
        }

        meta.resolved = true;
        // Effect (zeroing workerBond) before any interaction below — CEI.
        uint256 bond = meta.workerBond;
        meta.workerBond = 0;

        if (meta.isTaken) {
            _rejectAndRefund(jobId, "expired");
            // Worker took the bounty, posted a bond, then vanished without
            // submitting — forfeit the bond to the poster whose listing was
            // blocked for the bounty's whole duration.
            _forfeitBondToPoster(jobId, meta.poster, bond);
        } else {
            _payOrPark(jobId, meta.poster, meta.reward);
        }
        emit BountyExpired(jobId);
    }

    /// @dev Forfeits a posted worker bond to the poster (take-and-vanish
    ///      case) — shared by expireBounty and reconcileExpiredEscrow so the
    ///      "forfeited bond -> poster, no fee, same event" rule can't drift
    ///      between the two callers. No-op (and no event) when there's no
    ///      bond to forfeit.
    function _forfeitBondToPoster(uint256 jobId, address poster, uint256 bond) internal {
        if (bond == 0) return;
        _payOrPark(jobId, poster, bond);
        emit WorkerBondForfeited(jobId, poster, bond);
    }

    /// @notice V4.7 (C-02 safety net). Permissionless recovery for the case
    ///         where AC's own `claimRefund` fired despite AC_EXPIRY_BUFFER —
    ///         meaning this job sat unresolved for 90+ days (e.g. a dead
    ///         arbitrator role). The refunded USDC already sits in this
    ///         contract's balance (AC's `claimRefund` pays it to `job.client`,
    ///         which is this adapter); this replays whichever normal
    ///         resolution path would have applied had someone called it in
    ///         time, crediting via `pendingWithdrawals` instead of a fresh AC
    ///         settlement (AC already closed the job, so `complete`/`reject`
    ///         can no longer be called on it) — with no protocol fee, same
    ///         rationale as claimArbitratorTimeout's V4.4 fee waiver: don't
    ///         charge users for the protocol's own liveness failure.
    /// @dev Branch order matters: `rejectedAt` is NOT cleared by
    ///      `challengeRejection`, so a rejected-then-challenged job has both
    ///      `rejectedAt > 0` and `inDispute == true` — checking `inDispute`
    ///      first correctly routes that case through dispute-default logic
    ///      (claimDefaultRuling/claimArbitratorTimeout), not a plain
    ///      finalizeRejection refund.
    function reconcileExpiredEscrow(uint256 jobId) external nonReentrant {
        BountyMeta storage meta = _bounties[jobId];
        require(meta.poster != address(0), "bounty not found");
        require(!meta.resolved, "resolved");
        require(agenticCommerce.getJob(jobId).status == IAgenticCommerce.JobStatus.Expired, "AC job not expired");

        if (meta.contest) {
            _reconcileContest(jobId);
            return;
        }

        uint256 reward = meta.reward;
        address poster = meta.poster;
        bool submitted = bytes(meta.submittedResultHash).length > 0;
        bool wasRejected = meta.rejectedAt > 0;
        bool wasDisputed = meta.inDispute;
        bool responded = bytes(meta.disputeResponseHash).length > 0;
        uint256 bond = meta.workerBond;

        meta.resolved = true;
        meta.inDispute = false; // every other terminal path clears this; a job
        // resolved here must not read as "in dispute" forever.
        meta.workerBond = 0;

        uint256 posterAmt = 0;
        uint256 workerAmt = 0;
        bool workerAutoApproved = false;

        if (!submitted) {
            // Mirrors expireBounty: nothing was ever delivered.
            posterAmt = reward;
            _forfeitBondToPoster(jobId, poster, bond);
        } else if (wasDisputed) {
            if (responded) {
                // Mirrors claimArbitratorTimeout: both sides engaged, the
                // arbitrator never ruled — neutral split, no reputation write.
                (posterAmt, workerAmt) = _splitEvenly(reward);
            } else if (meta.disputeByWorker) {
                // Mirrors claimDefaultRuling: worker-initiated, poster
                // (respondent) never replied — worker wins by default.
                workerAmt = reward;
            } else {
                // Mirrors claimDefaultRuling: poster-initiated (including a
                // rejected-then-challenged job, where the worker is the
                // respondent), worker never replied — poster wins by default.
                posterAmt = reward;
            }
        } else if (wasRejected) {
            // Mirrors finalizeRejection: poster rejected, worker never
            // challenged before the (long since closed, 90 days on)
            // challenge window — refund poster.
            posterAmt = reward;
        } else {
            // Submitted, never rejected, never disputed — poster simply went
            // silent past the approval window. Mirrors autoApprove fully,
            // including its reputation write and unique-poster accounting.
            workerAmt = reward;
            workerAutoApproved = true;
        }

        // _payOrPark no-ops on a zero amount, so no need to guard these calls.
        _payOrPark(jobId, poster, posterAmt);
        _payWorker(meta, workerAmt);

        if (workerAutoApproved) {
            _recordUniquePoster(meta);
            _recordScoredJob(meta, 80);
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
        }

        emit ExternalRefundReconciled(jobId, poster, _workerOwnerOrZero(meta), posterAmt, workerAmt);
    }

    // ─── Disputes ──────────────────────────────────────────────────────────────

    function disputeBounty(uint256 jobId, string calldata ipfsReasonHash) external nonReentrant {
        BountyMeta storage meta = _bounties[jobId];
        if (meta.contest) revert WrongBountyMode();
        require(meta.poster != address(0), "bounty not found");
        require(msg.sender == meta.poster || _isWorker(meta, msg.sender), "unauthorized");
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
        meta.disputeByWorker = msg.sender != meta.poster;
        meta.disputeRaisedAt = block.timestamp;
        meta.disputeReasonHash = ipfsReasonHash;

        emit DisputeRaised(jobId, msg.sender, ipfsReasonHash);
    }

    function respondToDispute(uint256 jobId, string calldata ipfsResponseHash) external nonReentrant {
        BountyMeta storage meta = _bounties[jobId];
        if (meta.contest) revert WrongBountyMode();
        require(meta.inDispute, "not in dispute");
        require(!meta.resolved, "resolved");
        require(bytes(meta.disputeResponseHash).length == 0, "already responded");
        _requireCid(ipfsResponseHash, "response");
        require(block.timestamp <= meta.disputeRaisedAt + DISPUTE_RESPONSE_WINDOW, "response window closed");

        require(meta.disputeByWorker ? msg.sender == meta.poster : _isWorker(meta, msg.sender), "not the respondent");

        meta.disputeResponseHash = ipfsResponseHash;
        emit DisputeResponded(jobId, msg.sender, ipfsResponseHash);
    }

    function resolveDispute(uint256 jobId, bool payProvider, string calldata ipfsRulingHash, uint8 reputationPenalty)
        external
        nonReentrant
    {
        require(msg.sender == arbitrator, "only arbitrator");
        BountyMeta storage meta = _bounties[jobId];
        if (meta.contest) revert WrongBountyMode();
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
        if (meta.contest) revert WrongBountyMode();
        require(meta.inDispute, "not in dispute");
        require(!meta.resolved, "resolved");
        require(bytes(meta.disputeResponseHash).length == 0, "respondent replied");
        require(block.timestamp > meta.disputeRaisedAt + DISPUTE_RESPONSE_WINDOW, "window still open");

        meta.resolved = true;
        meta.inDispute = false;
        meta.disputeRulingHash = "default:no-response";

        bool payProvider = meta.disputeByWorker;
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
        if (meta.contest) revert WrongBountyMode();
        require(meta.inDispute, "not in dispute");
        require(!meta.resolved, "resolved");
        require(bytes(meta.disputeResponseHash).length > 0, "use claimDefaultRuling");
        require(block.timestamp > meta.disputeRaisedAt + ARBITRATOR_TIMEOUT, "arbitrator window open");

        meta.resolved = true;
        meta.inDispute = false;
        meta.disputeRulingHash = "timeout:50-50-split";

        (uint256 posterAmount, uint256 providerAmount) = _completeAndSplit(jobId);

        emit ArbitratorTimeoutClaimed(jobId, posterAmount, providerAmount);
    }

    function _finalizeDispute(uint256 jobId, bool payProvider) internal {
        if (payProvider) {
            _completeAndForward(jobId, "dispute:provider");
        } else {
            _rejectAndRefund(jobId, "dispute:poster");
        }
    }

    function _maybePenalize(BountyMeta storage meta, bool payProvider, uint8 penalty) internal {
        if (payProvider || meta.agentId == 0 || penalty == 0) return;
        // V4.7 (M-01): written negative — getAgentReputation's getSummary call
        // averages every feedback value with no tag filter, so a positive
        // penalty value previously pulled the average score UP, and the
        // maximum penalty (100) was indistinguishable from a perfect score.
        // Non-blocking: a dispute resolution must settle funds even if the
        // live registry rejects the feedback write.
        try reputationRegistry.giveFeedback(
            meta.agentId,
            -int128(uint128(penalty)),
            0,
            "bounty_failed",
            "",
            "",
            "",
            keccak256(abi.encodePacked("dispute_rejected", meta.jobId))
        ) {}
            catch {}
    }

    // ─── Payouts: push, or park for later pull (V4.6) ──────────────────────────

    /// @notice Claim USDC that a failed direct payout parked for you.
    /// @dev The only place a settlement amount may still revert — and it can
    ///      only ever affect the caller's own funds, never another job.
    function withdraw() external nonReentrant returns (uint256 amount) {
        amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "nothing to withdraw");
        pendingWithdrawals[msg.sender] = 0; // effect before interaction — CEI
        usdc.safeTransfer(msg.sender, amount);
        emit WithdrawalClaimed(msg.sender, amount);
    }

    /// @notice Only the current owner can claim an identity-bound parked reward.
    /// @dev Working wallets cannot pull earnings. A failed transfer affects only
    ///      this claim and rolls its credit back, exactly like address withdraw().
    function withdrawIdentity(uint256 agentId) external nonReentrant returns (uint256 amount) {
        address identityOwner = _agentOwner(agentId);
        require(msg.sender == identityOwner, "only identity owner");
        amount = pendingIdentityWithdrawals[agentId];
        require(amount > 0, "nothing to withdraw");
        pendingIdentityWithdrawals[agentId] = 0;
        usdc.safeTransfer(identityOwner, amount);
        emit IdentityWithdrawalClaimed(agentId, identityOwner, amount);
    }

    /// @dev Push `amount` to `payee`, or credit `pendingWithdrawals` if that
    ///      fails, so no single unpayable address can wedge a terminal state.
    ///      See the `pendingWithdrawals` docs for why this exists.
    ///
    ///      Deliberately a low-level call, not `safeTransfer` or a typed
    ///      `try usdc.transfer(...)`: SafeERC20 reverts on failure, which is
    ///      the exact behavior being defended against, and a typed try/catch
    ///      still reverts when a token returns no data or malformed data.
    ///      Every failure mode — revert, `false`, unexpected return data — is
    ///      treated identically here: park it.
    function _payOrPark(uint256 jobId, address payee, uint256 amount) internal {
        if (amount == 0) return;
        // Deliberate: safeTransfer reverts on failure, which is the exact
        // behavior being defended against here. See SLITHER.md.
        (bool ok, bytes memory ret) = address(usdc).call(abi.encodeCall(IERC20.transfer, (payee, amount)));
        if (ok && (ret.length == 0 || (ret.length == 32 && abi.decode(ret, (uint256)) == 1))) {
            return;
        }
        // Written after the call above. Unreachable as reentrancy: usdc is
        // immutable real USDC (no callbacks) and every entry point that can
        // reach this is nonReentrant. See SLITHER.md.
        pendingWithdrawals[payee] += amount;
        emit PayoutParked(jobId, payee, amount);
    }

    // ─── Internal payout helpers (balance-delta accounting) ────────────────────

    /// @dev Pulls received USDC from AC, splits fee, forwards remainder to payee.
    // Every caller is nonReentrant; immutable AC/USDC cannot interleave a
    // second settlement. The exact receipt check prevents pooled-fund payouts.
    // slither-disable-next-line reentrancy-balance
    function _completeAndForward(uint256 jobId, string memory reason) internal {
        BountyMeta storage meta = _bounties[jobId];
        uint256 before = usdc.balanceOf(address(this));
        agenticCommerce.complete(jobId, keccak256(abi.encodePacked(reason)), bytes(reason));
        uint256 received = usdc.balanceOf(address(this)) - before;
        if (received != meta.reward) revert UnexpectedEscrowAmount(received, meta.reward);

        uint256 fee = (received * feeBps) / BPS_DENOMINATOR;
        if (fee > 0) {
            _payOrPark(jobId, feeRecipient, fee);
            emit ProtocolFeePaid(jobId, feeRecipient, fee);
        }
        uint256 net = received - fee;
        if (net > 0) {
            _payWorker(meta, net);
        }
    }

    /// @dev Pulls received USDC from AC via complete() and splits the full
    ///      proceeds 50/50 between the two payees. Used only by
    ///      claimArbitratorTimeout — NO protocol fee here (V4.4): this path
    ///      only fires when the arbitrator failed to provide the service the
    ///      fee is charged for, so charging it on a neutral fault-neither-side
    ///      fallback would tax users for the protocol's own liveness failure.
    // Same guarded balance-delta accounting as _completeAndForward.
    // slither-disable-next-line reentrancy-balance
    function _completeAndSplit(uint256 jobId) internal returns (uint256 amountA, uint256 amountB) {
        BountyMeta storage meta = _bounties[jobId];
        uint256 before = usdc.balanceOf(address(this));
        agenticCommerce.complete(jobId, keccak256("arbitrator_timeout"), bytes("arbitrator_timeout"));
        uint256 received = usdc.balanceOf(address(this)) - before;
        if (received != meta.reward) revert UnexpectedEscrowAmount(received, meta.reward);

        (amountA, amountB) = _splitEvenly(received);
        if (amountA > 0) _payOrPark(jobId, meta.poster, amountA);
        _payWorker(meta, amountB);
    }

    /// @dev Shared halving convention (remainder, if any, goes to `b`) so
    ///      `_completeAndSplit` and `reconcileExpiredEscrow` can't drift on
    ///      how a neutral 50/50 split rounds an odd amount.
    function _splitEvenly(uint256 total) internal pure returns (uint256 a, uint256 b) {
        a = total / 2;
        b = total - a;
    }

    /// @dev Pulls received USDC from AC and refunds poster — NO fee charged.
    // Same guarded balance-delta accounting as _completeAndForward.
    // slither-disable-next-line reentrancy-balance
    function _rejectAndRefund(uint256 jobId, string memory reason) internal {
        BountyMeta storage meta = _bounties[jobId];
        uint256 before = usdc.balanceOf(address(this));
        agenticCommerce.reject(jobId, keccak256(abi.encodePacked(reason)), bytes(reason));
        uint256 received = usdc.balanceOf(address(this)) - before;
        if (received != meta.reward) revert UnexpectedEscrowAmount(received, meta.reward);
        if (received > 0) {
            _payOrPark(jobId, meta.poster, received);
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

    /// @notice Owner safety governance remains independent of arbitration.
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

    /// @notice V4.7. Blocks only createBounty/takeBounty — every exit path
    ///         (submit/approve/autoApprove/cancel/expire/disputes/withdraw)
    ///         keeps working while paused, so no one already in a bounty is
    ///         trapped by an emergency stop.
    function setPaused(bool p) external {
        require(msg.sender == owner, "only owner");
        paused = p;
        emit PausedSet(p);
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

    /// @notice Local agent history follows the NFT ID; human history follows its wallet.
    function identityKey(uint256 agentId, address humanWallet) public pure returns (bytes32) {
        if (agentId != 0) return keccak256(abi.encode("NadBounty.agent", agentId));
        if (humanWallet == address(0)) revert InvalidIdentity();
        return keccak256(abi.encode("NadBounty.human", humanWallet));
    }

    /// @notice Local history plus Base/Arc snapshots for the current owner.
    /// @dev Consumers can compute an average for display. Gate comparisons use
    ///      scoreSum directly, so integer division cannot admit a below-threshold worker.
    function getIdentityReputation(uint256 agentId, address humanWallet)
        external
        view
        returns (uint256 paidJobs, uint256 scoreSum)
    {
        address identityOwner = agentId == 0 ? humanWallet : _agentOwner(agentId);
        return _identityTotals(agentId, identityOwner, humanWallet);
    }

    function _agentOwner(uint256 agentId) internal view returns (address identityOwner) {
        if (agentId == 0) revert InvalidIdentity();
        try identityRegistry.ownerOf(agentId) returns (address currentOwner) {
            if (currentOwner == address(0)) revert InvalidIdentity();
            return currentOwner;
        } catch {
            revert InvalidIdentity();
        }
    }

    function _requireAgentCaller(uint256 agentId) internal view returns (address identityOwner) {
        identityOwner = _agentOwner(agentId);
        require(_isAgentCaller(agentId, identityOwner, msg.sender), "agent only: caller is not agent owner");
    }

    function _isAgentCaller(uint256 agentId, address identityOwner, address caller) internal view returns (bool) {
        if (caller == identityOwner) return true;
        try identityRegistry.getAgentWallet(agentId) returns (address workingWallet) {
            return workingWallet != address(0) && caller == workingWallet;
        } catch {
            return false;
        }
    }

    function _workerOwnerOrZero(BountyMeta storage meta) internal view returns (address) {
        if (meta.agentId == 0) return meta.assignedProvider;
        try identityRegistry.ownerOf(meta.agentId) returns (address identityOwner) {
            return identityOwner;
        } catch {
            return address(0);
        }
    }

    function _isWorker(BountyMeta storage meta, address caller) internal view returns (bool) {
        if (!meta.isTaken) return false;
        if (meta.agentId == 0) return caller == meta.assignedProvider;
        address identityOwner = _workerOwnerOrZero(meta);
        return identityOwner != address(0) && _isAgentCaller(meta.agentId, identityOwner, caller);
    }

    function _identityTotals(uint256 agentId, address identityOwner, address humanWallet)
        internal
        view
        returns (uint256 paidJobs, uint256 scoreSum)
    {
        LocalReputation storage local = localReputation[identityKey(agentId, humanWallet)];
        (uint256 mirroredJobs, uint256 mirroredSum) = reputationMirror.getTotals(identityOwner);
        return (local.paidJobs + mirroredJobs, local.scoreSum + mirroredSum);
    }

    function _checkGate(uint256 agentId, address identityOwner, address humanWallet, uint64 minJobs, uint8 minAvgScore)
        internal
        view
    {
        if (minJobs == 0 && minAvgScore == 0) return;
        (uint256 jobs, uint256 sum) = _identityTotals(agentId, identityOwner, humanWallet);
        if (jobs < minJobs || (jobs == 0 && minAvgScore != 0) || sum < uint256(minAvgScore) * jobs) {
            revert ReputationGateFailed(jobs, sum);
        }
    }

    function _recordScoredJob(BountyMeta storage meta, uint8 score) internal {
        bytes32 key = identityKey(meta.agentId, meta.assignedProvider);
        LocalReputation storage local = localReputation[key];
        ++local.paidJobs;
        local.scoreSum += score;
        emit LocalReputationUpdated(key, local.paidJobs, local.scoreSum);
    }

    /// @dev Never fall back to a working wallet or a stale cached owner.
    function _payWorker(BountyMeta storage meta, uint256 amount) internal {
        if (amount == 0) return;
        address identityOwner = _workerOwnerOrZero(meta);
        if (meta.agentId != 0 && identityOwner == address(0)) {
            pendingIdentityWithdrawals[meta.agentId] += amount;
            emit IdentityPayoutParked(meta.jobId, meta.agentId, amount);
            return;
        }
        _payOrPark(meta.jobId, identityOwner, amount);
    }

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
        if (meta.contest) {
            if (contestClosedAt(jobId) != 0) return false;
        } else if (block.timestamp > meta.deadline) {
            return false;
        }
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
