// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IAgenticCommerce.sol";
import "./interfaces/IIdentityRegistry.sol";
import "./interfaces/IReputationRegistry.sol";

/// @title BountyAdapter
/// @notice Thin facade over Arc ERC-8183 AgenticCommerce — adds bounty-board semantics
///         (categories, tags, IPFS descriptions, ERC-8004 reputation) without storing funds.
contract BountyAdapter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IAgenticCommerce    public immutable agenticCommerce;
    IIdentityRegistry   public immutable identityRegistry;
    IReputationRegistry public immutable reputationRegistry;
    IERC20              public immutable usdc;

    address public immutable feeRecipient;
    address public immutable arbitrator;
    uint256 public immutable feeBps; 
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MIN_REWARD = 1e6;

    struct BountyMeta {
        uint256  jobId;
        address  poster;
        uint256  reward;
        uint256  deadline;
        string   ipfsDescHash;
        string   category;
        string[] tags;
        uint256  agentId;
        bool     agentOnly;
        address  assignedProvider;
        string   submittedResultHash;
        bool     funded;
        bool     inDispute;
        bool     isTaken;
    }

    mapping(uint256 => BountyMeta) public bounties;
    uint256[] public allJobIds;

    event BountyCreated(uint256 indexed jobId, address indexed poster, uint256 reward, string category, uint256 deadline);
    event BountyTaken(uint256 indexed jobId, address indexed provider, uint256 agentId);
    event BountyFunded(uint256 indexed jobId, uint256 amount);
    event WorkSubmitted(uint256 indexed jobId, address indexed provider, string ipfsResultHash);
    event BountyCompleted(uint256 indexed jobId, uint256 agentId, uint256 reputationScore);
    event BountyCancelled(uint256 indexed jobId, string reason);
    event BountyExpired(uint256 indexed jobId);
    event DisputeRaised(uint256 indexed jobId);
    event DisputeResolved(uint256 indexed jobId, bool payProvider);

    constructor(
        address _agenticCommerce,
        address _identityRegistry,
        address _reputationRegistry,
        address _usdc,
        address _feeRecipient,
        uint256 _feeBps
    ) {
        agenticCommerce   = IAgenticCommerce(_agenticCommerce);
        identityRegistry  = IIdentityRegistry(_identityRegistry);
        reputationRegistry = IReputationRegistry(_reputationRegistry);
        usdc              = IERC20(_usdc);
        feeRecipient      = _feeRecipient;
        arbitrator        = msg.sender;
        feeBps            = _feeBps;
    }

    function createBounty(
        address  provider,
        uint256  reward,
        uint256  deadline,
        string   calldata ipfsDescHash,
        string   calldata category,
        string[] calldata tags,
        bool     agentOnly
    ) external nonReentrant returns (uint256 jobId) {
        require(reward >= MIN_REWARD, "reward too low");
        require(deadline > block.timestamp, "deadline in past");
        require(bytes(ipfsDescHash).length > 0, "empty ipfs hash");
        require(_validCategory(category), "invalid category");

        require(usdc.allowance(msg.sender, address(this)) >= reward, "insufficient USDC allowance");
        usdc.safeTransferFrom(msg.sender, address(this), reward);

        uint256 fee = (reward * feeBps) / BPS_DENOMINATOR;
        uint256 netReward = reward - fee;
        if (fee > 0) {
            usdc.safeTransfer(feeRecipient, fee);
        }

        usdc.approve(address(agenticCommerce), netReward);
        // Adapter acts as both Client and Evaluator
        jobId = agenticCommerce.createJob(provider, address(this), deadline, ipfsDescHash, address(0));

        BountyMeta storage meta = bounties[jobId];
        meta.jobId       = jobId;
        meta.poster      = msg.sender;
        meta.reward      = netReward;
        meta.deadline    = deadline;
        meta.ipfsDescHash = ipfsDescHash;
        meta.category    = category;
        meta.agentOnly   = agentOnly;
        meta.isTaken     = false;
        meta.inDispute   = false;
        for (uint256 i = 0; i < tags.length; i++) {
            meta.tags.push(tags[i]);
        }
        allJobIds.push(jobId);

        emit BountyCreated(jobId, msg.sender, netReward, category, deadline);
    }

    function takeBounty(uint256 jobId, uint256 agentId) external nonReentrant {
        BountyMeta storage meta = bounties[jobId];
        require(meta.poster != address(0), "bounty not found");
        require(!meta.isTaken, "already taken");
        require(block.timestamp <= meta.deadline, "bounty expired");

        if (meta.agentOnly) {
            require(agentId != 0, "agent only: provide agentId");
        }

        if (agentId != 0) {
            require(identityRegistry.ownerOf(agentId) == msg.sender, "caller is not agent owner");
            require(identityRegistry.isRegistered(agentId), "agent not registered");
            meta.agentId = agentId;
        }

        meta.isTaken = true;
        meta.assignedProvider = msg.sender;
        
        agenticCommerce.setProvider(jobId, msg.sender);
        agenticCommerce.setBudget(jobId, meta.reward, bytes("Bounty Taken"));

        emit BountyTaken(jobId, msg.sender, agentId);
    }

    function fundBounty(uint256 jobId) external nonReentrant {
        BountyMeta storage meta = bounties[jobId];
        require(meta.poster == msg.sender, "only poster");
        require(!meta.funded, "already funded");
        require(meta.isTaken, "must be taken first");

        agenticCommerce.fund(jobId, bytes(""));
        meta.funded = true;

        emit BountyFunded(jobId, meta.reward);
    }

    function submitWork(uint256 jobId, string calldata ipfsResultHash) external nonReentrant {
        BountyMeta storage meta = bounties[jobId];
        require(meta.assignedProvider == msg.sender, "not assigned provider");
        require(bytes(ipfsResultHash).length > 0, "empty result hash");
        require(block.timestamp <= meta.deadline, "bounty expired");

        bytes32 deliverable = keccak256(abi.encodePacked(ipfsResultHash));
        agenticCommerce.submit(jobId, deliverable, bytes(""));
        meta.submittedResultHash = ipfsResultHash;

        emit WorkSubmitted(jobId, msg.sender, ipfsResultHash);
    }

    function approveBounty(uint256 jobId, uint8 reputationScore) external nonReentrant {
        BountyMeta storage meta = bounties[jobId];
        require(meta.poster == msg.sender, "only poster");
        require(bytes(meta.submittedResultHash).length > 0, "no submission");
        require(!meta.inDispute, "Bounty is in dispute");

        if (meta.agentId > 0) {
            bytes32 feedbackHash = keccak256(abi.encodePacked("bounty_completed", jobId));
            reputationRegistry.giveFeedback(
                meta.agentId,
                reputationScore,
                0,
                "bounty_completed",
                "", "", "",
                feedbackHash
            );
        }

        agenticCommerce.complete(jobId, keccak256("approved"), bytes("Poster approved"));
        emit BountyCompleted(jobId, meta.agentId, reputationScore);
    }

    function disputeBounty(uint256 jobId) external nonReentrant {
        BountyMeta storage meta = bounties[jobId];
        require(msg.sender == meta.poster || msg.sender == meta.assignedProvider, "Unauthorized to dispute");
        require(!meta.inDispute, "Already in dispute");
        
        meta.inDispute = true;
        emit DisputeRaised(jobId);
    }

    function resolveDispute(uint256 jobId, bool payProvider, uint8 reputationPenalty) external nonReentrant {
        require(msg.sender == arbitrator, "Only arbitrator");
        BountyMeta storage meta = bounties[jobId];
        require(meta.inDispute, "Not in dispute");

        meta.inDispute = false;

        if (payProvider) {
            agenticCommerce.complete(jobId, keccak256("dispute_resolved_provider"), bytes("Arbitrator ruled for provider"));
            emit DisputeResolved(jobId, true);
        } else {
            if (meta.agentId > 0) {
                reputationRegistry.giveFeedback(
                    meta.agentId, 
                    reputationPenalty, 
                    0, 
                    "bounty_failed", 
                    "", "", "", 
                    keccak256("rejected")
                );
            }
            agenticCommerce.reject(jobId, keccak256("dispute_resolved_poster"), bytes("Arbitrator ruled for poster"));
            emit DisputeResolved(jobId, false);
        }
    }

    function rejectBounty(uint256 jobId, string calldata reason) external nonReentrant {
        BountyMeta storage meta = bounties[jobId];
        require(meta.poster == msg.sender, "only poster");
        require(bytes(meta.submittedResultHash).length > 0, "no submission");
        require(!meta.inDispute, "Bounty is in dispute");

        agenticCommerce.reject(jobId, keccak256(abi.encodePacked(reason)), bytes(reason));
        emit BountyCancelled(jobId, reason);
    }

    function cancelBounty(uint256 jobId) external nonReentrant {
        BountyMeta storage meta = bounties[jobId];
        require(meta.poster == msg.sender, "only poster");
        require(!meta.isTaken, "already taken, cannot cancel");

        agenticCommerce.reject(jobId, keccak256("cancelled"), bytes("cancelled by poster"));
        emit BountyCancelled(jobId, "cancelled by poster");
    }

    function expireBounty(uint256 jobId) external nonReentrant {
        BountyMeta storage meta = bounties[jobId];
        require(meta.poster != address(0), "bounty not found");
        require(block.timestamp > meta.deadline, "not expired yet");

        agenticCommerce.expire(jobId, bytes(""));
        emit BountyExpired(jobId);
    }

    // ─── View functions ───────────────────────────────────────────────────────────

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
                if (matched >= offset) {
                    result[added++] = allJobIds[i];
                }
                matched++;
            }
        }
    }

    function getBountyMeta(uint256 jobId) external view returns (BountyMeta memory) {
        return bounties[jobId];
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

    // ─── Internal helpers ─────────────────────────────────────────────────────────

    function _isOpenMatch(
        uint256 jobId,
        bool filterCategory,
        bytes32 categoryHash
    ) internal view returns (bool) {
        BountyMeta storage meta = bounties[jobId];
        if (meta.isTaken) return false;
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

    function _validCategory(string calldata cat) internal pure returns (bool) {
        bytes32 h = keccak256(bytes(cat));
        return h == keccak256("dev")
            || h == keccak256("design")
            || h == keccak256("content")
            || h == keccak256("data")
            || h == keccak256("other");
    }
}
