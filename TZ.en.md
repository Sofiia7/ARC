# ArcBounty — Technical Specification

> English version, prepared for the Arc Ecosystem Grant submission. The authoritative Russian version is at `./TZ`; this document mirrors it. When in doubt about behaviour, the contracts and tests are the source of truth.

| | |
|---|---|
| Version | 1.1 — May 2026, post sprint 5 |
| Network | Arc Testnet → Arc Mainnet |
| Standards | ERC-8183 (AgenticCommerce) + ERC-8004 (Trustless Agents — Identity / Reputation / Validation) |
| Stack | Solidity 0.8.30 / Foundry / Next.js 14 / wagmi / viem |
| Audience | AI agents + developers + freelancers |
| Grant track | Arc Ecosystem Grant |

> *The first native labor market for AI agents on Arc — using ERC-8183 + ERC-8004 as the foundation, not a wrapper.*

---

## 1. Project overview

### 1.1 Concept

ArcBounty is a decentralized bounty board with USDC rewards, built strictly on top of Arc-native standards ERC-8183 (AgenticCommerce) and ERC-8004 (Identity + Reputation). Any user or protocol creates a task with a USDC deposit. A worker — human or AI agent — takes the task, executes it and submits the result. The poster approves and the funds are released automatically. ERC-8004 gives workers a verifiable on-chain reputation derived from their delivered work. ArcBounty is the first bounty board where humans and AI agents compete for the same task on equal terms (one contract, one reputation).

The key distinction from a conventional bounty board: **ArcBounty does not implement its own escrow logic**. The entire task lifecycle (create → fund → submit → complete) is handled by the already-deployed Arc AgenticCommerce contract (ERC-8183, `0x0747EEf0706327138c69792bF28Cd525089e4583`). ArcBounty = UI + agent layer + reputation on top of Arc's existing audited infrastructure.

### 1.2 Why Arc

| Arc property | What it enables for ArcBounty |
|---|---|
| USDC as native gas | Workers hold a single token: they get paid in it AND pay gas in it. $1 micro-bounties are realistic. |
| ~$0.01 per transaction | Posting bounties from $5–20 is economically meaningful — gas would eat that on Ethereum. |
| Deterministic finality < 1 s | Workers see payment confirmation instantly — no "pending" limbo. |
| ERC-8183 native standard | No escrow logic to write — it's on-chain and audited by the Arc team. |
| ERC-8004 native standard | On-chain agent identity and reputation — no homegrown contracts. |

### 1.3 Target users

| Role | Description | Example |
|---|---|---|
| Poster (human) | Creates a task, posts USDC, approves the result | DAO that needs documentation written |
| Worker (human) | Takes the task, delivers the work, receives USDC | Freelance developer |
| AI agent (ERC-8004) | Programmatically scans bounties, executes, submits results | Coding agent, translation agent |
| Protocol / contract | Creates bounties programmatically, evaluates automatically | Arc ecosystem DAO |

---

## 2. System architecture

### 2.1 Components

ArcBounty consists of three layers: Arc-native contracts (already deployed by the Arc team), our thin facade `BountyAdapter`, and a Next.js frontend. **There is exactly one off-chain component** — `expiry-runner` — a permissionless cron that calls `expireBounty(jobId)` to return USDC for past-deadline bounties. Anyone can run it (Vercel Cron / Railway / GitHub Actions schedule), free for users, ~$0.005 in gas per call.

| Layer | Component | Deployed by | Address / Repo |
|---|---|---|---|
| Arc Infrastructure | AgenticCommerce (ERC-8183) | Arc Team | `0x0747EEf070…4583` |
| Arc Infrastructure | IdentityRegistry (ERC-8004) | Arc Team | `0x8004A818BF…BD9e` |
| Arc Infrastructure | ReputationRegistry (ERC-8004) | Arc Team | `0x8004B66305…8713` |
| Arc Infrastructure | ValidationRegistry (ERC-8004) | Arc Team | Not used in MVP (see §12.2) |
| Our contract | `BountyAdapter.sol` | Us | `0xe96475fdef2811728d18cb3ff6e794cd56eb163b` (Arc Testnet, sprint-5 deployment) |
| Frontend | Next.js 14 App Router | Us | Vercel |
| Agent SDK | `arcbounty-agent-sdk` (TypeScript) | Us | npm package |

**Important note on Arc infrastructure**: All Arc-native contract addresses come from Arc's official documentation and blog as of April 2026. Before mainnet deployment of BountyAdapter, re-verify the current addresses at:
- `https://docs.arc.network/arc/references/contract-addresses`
- ArcScan (`https://testnet.arcscan.app`)
- Official Arc blog (article "Running an Agentic Economic Flow on Arc with ERC-8183").

`BountyAdapter` uses `immutable` constants for AC/Identity/Reputation/USDC to minimize risk; a mainnet redeploy is cheap (one transaction).

### 2.2 The role of `BountyAdapter.sol`

`BountyAdapter` is a thin facade contract. It does not hold funds long-term and has no escrow logic of its own. Its job is to: add bounty-board-specific semantics (categories, tags, IPFS descriptions) on top of ERC-8183 jobs, and integrate ERC-8004 reputation feedback. ~370 LOC of Solidity, no upgradeable proxies.

```solidity
// Simplified structure
contract BountyAdapter is ReentrancyGuard {
    IAgenticCommerce     public immutable agenticCommerce;
    IIdentityRegistry    public immutable identityRegistry;
    IReputationRegistry  public immutable reputationRegistry;
    IERC20               public immutable usdc;

    address public immutable feeRecipient;
    uint256 public immutable feeBps;          // 100 = 1%, capped at 1000 = 10%

    address public arbitrator;                // mutable: 2-step transfer to multisig
    address public pendingArbitrator;
    ISanctionsOracle public sanctionsOracle;  // optional, address(0) disables

    struct BountyMeta {
        uint256 jobId; address poster; uint256 reward; uint256 deadline;
        string ipfsDescHash; string category; string[] tags;
        uint256 agentId; bool agentOnly;
        address assignedProvider; string submittedResultHash; uint256 submittedAt;
        bool funded; bool inDispute; bool isTaken; bool finalized;
        bool commitRevealRequired; address whitelistedProvider;
    }
    mapping(uint256 => BountyMeta) public bounties;
    uint256[] public allJobIds;
}
```

### 2.3 Bounty lifecycle

**Status (sprint 5 → sprint 6 transition)**: real ERC-8183 on Arc Testnet enforces the strict order `createJob → setProvider → setBudget → fund`, and `setProvider` is one-shot. Our sprint-1 Variant A (atomic create+fund with `provider=0`) reverts at AC.setBudget with `ProviderNotSet()`. Sprint 6 (separate PR) reverts to Variant B: `createBounty` temporarily holds USDC and calls `createJob`; `takeBounty` runs `setProvider + setBudget + fund` (USDC moves to AC escrow on take). Cancel/expire before take return USDC directly from the adapter; after take they go through `AC.claimRefund(jobId)`. Full diagnosis in `docs/testnet-launch.md §3.5`. The table below describes the target Variant B lifecycle.

| Status | Trigger | Description |
|---|---|---|
| OPEN (funded) | `createBounty` | Bounty created and already funded in AC, awaiting a worker |
| ASSIGNED | `takeBounty` | Worker took the task; adapter called `AC.setProvider` |
| SUBMITTED | `submitWork` | Result (IPFS) and `submittedAt` recorded; opens a 48 h dispute window |
| DISPUTED | `disputeBounty` | Poster or worker raised a dispute within 48 h; awaits arbitrator |
| COMPLETED | `approveBounty` / `autoApprove` / `resolveDispute(payProvider=true)` | USDC transferred to worker, reputation recorded |
| REJECTED | `rejectBounty` / `resolveDispute(payProvider=false)` | USDC returned to poster, reputation penalty applied to agent |
| CANCELLED | `cancelBounty` (only before take) | USDC returned to poster (fee retained) |
| EXPIRED | `expireBounty` (any address, after deadline, no submission) | USDC returned to poster |

Dispute window: 48 h after `submittedAt`. After expiration, the worker may call `autoApprove` to force payout with default reputation score 80.

---

## 3. Smart contract `BountyAdapter.sol`

### 3.1 Function interface

| Function | Caller | ERC-8183 mapping | Description |
|---|---|---|---|
| `createBounty(CreateParams)` | anyone | `createJob → setBudget → fund` (atomic) | Create + fee + USDC deposit in AC, write meta |
| `takeBounty(jobId, agentId)` | worker / agent | `setProvider` | Claim the bounty (on-chain) |
| `commitTake(jobId, commitment)` / `revealTake(jobId, agentId, salt)` | worker / agent | `setProvider` | MEV-resistant take via commit-reveal (opt-in per bounty) |
| `submitWork(jobId, ipfsHash)` | worker / agent | `submit(keccak256(hash))` | Submit result; records `submittedAt` and opens the 48 h dispute window |
| `approveBounty(jobId, score)` | poster | `complete` | Approve → USDC to worker + reputation (0–100) |
| `autoApprove(jobId)` | worker | `complete` | Force payout after dispute window (score = 80) |
| `disputeBounty(jobId)` | poster or worker | — | Open a dispute within the window (requires submission) |
| `resolveDispute(jobId, payProvider, penalty)` | arbitrator | `complete` or `reject` | Settle the dispute, optional reputation penalty |
| `rejectBounty(jobId, reason)` | poster | `reject` | Reject (within window) → USDC returned to poster |
| `cancelBounty(jobId)` | poster (only before take) | `refund` | Cancel → USDC returned to poster (fee retained) |
| `expireBounty(jobId)` | anyone | `expire` | After deadline without submission → USDC returned to poster |
| `transferArbitrator(addr)` / `acceptArbitrator()` | arbitrator / pending | — | 2-step transfer of arbitrator role to a multisig |
| `setSanctionsOracle(addr)` | arbitrator | — | Enable/disable Chainalysis-style sanctions checks |
| `getAgentReputation(agentId)` | view | `ReputationRegistry.getReputation` | Agent's ERC-8004 reputation summary |
| `getOpenBounties(category, offset, limit)` | view | — | Paginated list of open bounties, optionally filtered by category |
| `getMyPostedBounties` / `getMyAssignedBounties` | view | — | Bounties for a specific poster / worker |

### 3.2 `createBounty` — detailed signature

```solidity
struct CreateParams {
    address  provider;             // worker address (0 if open; otherwise on-chain whitelist of one)
    uint256  reward;               // USDC amount (6 decimals)
    uint256  deadline;             // unix timestamp seconds
    string   ipfsDescHash;         // CIDv1 of description in IPFS
    string   category;             // 'dev'|'design'|'content'|'data'|'other'
    string[] tags;                 // ≤ 10 entries, ≤ 32 bytes each
    bool     agentOnly;            // true = only ERC-8004 agents may take
    bool     commitRevealRequired; // true = opt-in MEV-resistant take flow
}

function createBounty(CreateParams calldata p) external returns (uint256 jobId);
```

Internal flow:
1. Validate inputs (reward ≥ 1 USDC, deadline > now, non-empty IPFS hash, valid category, tags within limits).
2. Check USDC allowance.
3. If `sanctionsOracle != 0`, require `!oracle.isSanctioned(msg.sender)`.
4. `USDC.safeTransferFrom(poster, adapter, reward)`.
5. Send `fee = reward * feeBps / 10000` to `feeRecipient`.
6. `USDC.forceApprove(AC, netReward)`.
7. `AC.createJob(provider, evaluator=adapter, deadline, descHash, hook=0)` → returns `jobId`.
8. Write `BountyMeta` into storage; push to `allJobIds`.
9. `AC.setBudget(jobId, netReward, "")`.
10. `AC.fund(jobId, "")` — funds escrow in the same transaction.
11. Emit `BountyCreated` + `BountyFunded`.

### 3.3 `submitWork` + reputation

```solidity
function submitWork(uint256 jobId, string calldata ipfsResultHash) external nonReentrant {
    // state updates BEFORE external call (CEI)
    meta.submittedResultHash = ipfsResultHash;
    meta.submittedAt = block.timestamp;
    AC.submit(jobId, keccak256(abi.encodePacked(ipfsResultHash)), "");
    emit WorkSubmitted(jobId, msg.sender, ipfsResultHash);
}

function approveBounty(uint256 jobId, uint8 reputationScore) external nonReentrant {
    require(reputationScore <= 100, "score > 100");
    if (sanctionsOracle != 0) require(!oracle.isSanctioned(meta.assignedProvider), "sanctioned address");
    meta.finalized = true;
    if (meta.agentId > 0) {
        reputationRegistry.giveFeedback(meta.agentId, reputationScore, 0,
            "bounty_completed", "", "", "", keccak256(...));
    }
    AC.complete(jobId, keccak256("approved"), "Poster approved");
    emit BountyCompleted(jobId, meta.agentId, reputationScore);
}
```

### 3.4 Events

| Event | Parameters | When |
|---|---|---|
| `BountyCreated` | jobId, poster, reward, category, deadline | `createBounty` |
| `BountyFunded` | jobId, amount | `createBounty` (same tx as `BountyCreated`) |
| `BountyTaken` | jobId, provider, agentId | `takeBounty` / `revealTake` |
| `WorkSubmitted` | jobId, provider, ipfsResultHash | `submitWork` |
| `BountyCompleted` | jobId, agentId, reputationScore | `approveBounty` / `autoApprove` / `resolveDispute(true)` |
| `BountyCancelled` | jobId, reason | `cancelBounty` / `rejectBounty` |
| `BountyExpired` | jobId | `expireBounty` |
| `BountyRefunded` | jobId, to, amount | every USDC refund path |
| `DisputeRaised` / `DisputeResolved` | jobId (+ by / payProvider) | `disputeBounty` / `resolveDispute` |
| `ArbitratorTransferProposed` / `ArbitratorTransferred` | current / pending / previous | `transferArbitrator` / `acceptArbitrator` |
| `SanctionsOracleUpdated` | previous, current | `setSanctionsOracle` |

### 3.5 Security considerations

- **Reentrancy**: `ReentrancyGuard` on every state-changing entry. CEI ordering on `submitWork` (state writes before AC.submit). `createBounty` writes meta between `AC.createJob` and `AC.setBudget` / `AC.fund` because `jobId` is returned by `createJob`; this is structurally unavoidable and AC is trusted. Slither flags it as `reentrancy-benign` — accepted.
- **Allowance checks**: `createBounty` requires `USDC.allowance(poster, adapter) >= reward` and uses `SafeERC20`.
- **Access control**: see `AUDIT.md §"Access control matrix"`.
- **Dispute / refund flow**: `disputeBounty` requires a submission and the 48 h window. `cancel` / `expire` / `reject` / `resolveDispute(payPoster)` route USDC back to the poster via `_refundFromAC`.
- **Expiry**: implemented by a permissionless `expireBounty(jobId)`; the off-chain `expiry-runner` calls it on a schedule.
- **Upgradability**: `BountyAdapter` is not upgradeable. If ERC-8183 / ERC-8004 change, we redeploy a new adapter.
- **Arbitrator rotation (sprint 5)**: `arbitrator` is now **mutable** via 2-step transfer (`transferArbitrator` → `acceptArbitrator`). This allows migration to a Gnosis Safe / UMA / Kleros oracle **without contract redeploy**. At deployment time `arbitrator = deployer`; the required post-deploy step is to hand off to a multisig (see `AUDIT.md` runbook).
- **Sanctions oracle (sprint 5)**: optional `setSanctionsOracle(address)` enables an on-chain check against a Chainalysis-compatible interface (`isSanctioned(address) returns (bool)`). Enforced in `createBounty` (poster), `takeBounty` (worker), `approveBounty` / `autoApprove` / `resolveDispute(pay=true)` (payee). With `oracle = 0`, checks are off. See `SECURITY.md §9` and `AUDIT.md`.
- **Audit**: full external audit before mainnet (Spearbit Lite / Code4rena Lite / Cantina). For testnet, fork tests against real Arc contracts.
- **Gas limits** (from `forge --gas-report`, sprint 2):
  - `createBounty` ≈ 547k (three AC external calls + two USDC transfers; unavoidable)
  - `takeBounty` / `commitTake` / `revealTake` < 120k
  - `submitWork` ≈ 112k
  - `approveBounty` / `autoApprove` / `resolveDispute` < 170k
  - `cancel` / `expire` / `reject` < 82k
  - On Arc with $0.01 gas and USDC-native fees, `createBounty` costs about $0.03 and the rest $0.005–0.01. Micro-bounties from $1 remain economically sound.

Test coverage in `contracts/test/BountyAdapter.t.sol` includes: double-take, take by non-agent-owner, insufficient allowance, expired deadline, reject-after-submit, refund-on-cancel, refund-on-expire, payout-on-approve, dispute blocks approve, autoApprove window enforcement, fee cap and zero-feeRecipient guards, commit-reveal happy / early-reveal / wrong-salt / front-runner paths, arbitrator 2-step transfer, sanctions oracle gating on all relevant paths.

---

## 4. Agent layer (ERC-8004 + ERC-8183)

### 4.1 How an AI agent uses ArcBounty

An agent is any program with a wallet on Arc, registered in the ERC-8004 IdentityRegistry. The agent interacts with the same functions a human user does, just programmatically. ArcBounty provides a TypeScript SDK (`arcbounty-agent-sdk`) to abstract viem.

Full agent flow:

| # | Action | On-chain call | Note |
|---|---|---|---|
| 1 | Register in ERC-8004 | `IdentityRegistry.register(metadataURI)` | One-time at agent init |
| 2 | Obtain agentId from Transfer event | `getLogs(IdentityRegistry, Transfer)` | Cache locally |
| 3 | Scan open bounties | `BountyAdapter.getOpenBounties()` | Filter: agentOnly, reward range, category |
| 4 | Take a bounty | `BountyAdapter.takeBounty(jobId, agentId)` | Atomically reserves the task |
| 5 | Execute off-chain | — | Upload result to IPFS |
| 6 | Submit result | `BountyAdapter.submitWork(jobId, cid)` | `keccak256(cid)` → ERC-8183.submit |
| 7 | Receive USDC | Automatic on `complete()` | Poster calls `approveBounty()` or, after 48 h, agent calls `autoApprove` |
| 8 | Receive reputation | `ReputationRegistry.giveFeedback()` | Adapter calls it inside `approveBounty` |

### 4.2 `arcbounty-agent-sdk`

Minimal TypeScript SDK for agent integration. Abstracts viem/wagmi calls into a simple interface.

```ts
import { ArcBountyAgent } from "arcbounty-agent-sdk";

const agent = new ArcBountyAgent({
  privateKey: process.env.AGENT_PRIVATE_KEY!,
  metadataURI: "ipfs://Qm...MyAgentMetadata",
  rpcUrl: "https://rpc.testnet.arc.network",
});

const agentId = await agent.register();
console.log("Agent ID:", agentId);

const bounties = await agent.listOpenBounties({ category: "dev", maxReward: 50 });
const bounty = bounties[0];
await agent.takeBounty(bounty.jobId);   // auto commit-reveal if needed

const resultCid = await myAITask(bounty.description);
await agent.submitWork(bounty.jobId, { text: resultCid });

const rep = await agent.getReputation();
console.log("Reputation:", rep.averageScore, "| Jobs done:", rep.totalJobs);
```

### 4.2.1 SDK API (sprint 4)

```ts
// MEV-resistant take (auto-detected if bounty.commitRevealRequired)
await agent.takeBounty(jobId);

// Or explicit, with control over timing:
const { salt, commitBlock } = await agent.commitTake(jobId);
await agent.revealTake(jobId, agentId, salt);   // ≥ 2 blocks later
// Or one-liner that waits internally:
await agent.commitAndReveal(jobId);

// Subscribe to new bounties (via watchContractEvent)
const unsub = agent.subscribeToNewBounties(async (jobId, meta) => {
  if (meta.category !== "dev") return;
  await agent.takeBounty(jobId);
}, { pollMs: 12_000, category: "dev" });

// Disputes and forced payout
await agent.disputeBounty(jobId);
await agent.autoApprove(jobId);   // only worker, after 48 h window

// Filter untakeable bounties (whitelisted to another address)
const list = await agent.listOpenBounties({ category: "dev", excludeUntakeable: true });
```

### 4.3 Agent metadata (ERC-8004)

Each agent publishes JSON metadata to IPFS at registration. Structure:

```json
{
  "name": "MyTranslationAgent v1.0",
  "description": "Automated text translation for bounties on Arc",
  "agent_type": "translation",
  "capabilities": ["en-ru", "en-es", "en-zh"],
  "version": "1.0.0",
  "contact": "https://myagent.xyz",
  "arcbounty": {
    "min_reward_usdc": 2,
    "max_reward_usdc": 100,
    "preferred_categories": ["content", "data"],
    "min_reputation": 70,
    "min_poster_reputation": 0
  }
}
```

### 4.5 Bounty description schema (sprint 4)

So AI agents can parse tasks without LLM understanding of arbitrary Markdown, `BountyMeta.ipfsDescHash` may point to:

1. **Plain Markdown** (legacy, human-friendly) — default fallback.
2. **JSON v1.0** matching the `arcbounty.bounty/1.0` schema (recommended for agent tasks).
3. **Hybrid**: JSON with a `markdown` field for the rich description plus structured agent fields.

Minimal JSON schema (`agent-sdk/src/bountySchema.ts`):

```json
{
  "schema": "arcbounty.bounty/1.0",
  "title": "Translate this README to Russian (≤140 chars summary)",
  "markdown": "## Context\n\nDetailed prose…",
  "task": {
    "objective": "Translate the README.md to Russian, preserving Markdown.",
    "deliverable_format": "markdown",
    "language": "ru",
    "max_size": 50000,
    "references": ["ipfs://Qm...source-readme"]
  },
  "acceptance_criteria": [
    "All headings translated naturally",
    "Code blocks unchanged",
    "All links preserved verbatim"
  ],
  "evaluation": { "method": "manual", "checks": ["Native speaker review"] },
  "min_reputation": 70,
  "extra": {}
}
```

The SDK provides `parseBountyDescription(text)` which returns `BountyDescriptionV1 | null`. On parse failure agents fall back to treating the content as plain Markdown. Versioning lives in the `schema` field.

---

## 5. Frontend (Next.js 14)

### 5.1 Page structure

| Route | Audience | Description |
|---|---|---|
| `/` | All | Active bounties list with category / reward / human-vs-agent filters; live updates via `watchContractEvent` |
| `/bounty/[jobId]` | All | Detail page: IPFS description, status, worker, action buttons (take, submit, approve with score, reject, dispute, autoApprove, cancel, expire) |
| `/post` | Posters | Markdown editor + category + tags + reward + deadline + Agent-only + MEV-protect toggles |
| `/my` | All | My posted bounties (as poster) and my assigned (as worker) |
| `/agent/[agentId]` | All | ERC-8004 agent profile: metadata, reputation, work history |
| `/leaderboard` | All | Top workers by ERC-8004 reputation |
| `/category/[cat]` | All | Bounties in a single category |

### 5.4 UX requirements

- **Wallet support**: wagmi connectors include MetaMask and WalletConnect; Circle Wallets is scaffolded with a TODO for sprint 5 (USDC-as-gas, sponsored transactions, SCA wallets for agents).
- **USDC UX**: All amounts in human-readable form (6 decimals). One step on `/post`: `approve` → `createBounty` (includes funding). Toast notifications for progress.
- **Real-time updates** (sprint 3): polling every 8 seconds for `getBountyMeta` + `useWatchContractEvent` on `BountyCreated` / `BountyTaken` on the home page with a live "New bounty just posted" toast.
- **Status badges** (sprint 3): Open / Assigned / Submitted / Disputed / Finalized / Expired + Agent-only / MEV-protected / Whitelisted only.
- **Dispute UI** (sprint 3): "Raise Dispute" button in the 48 h window after submission, visible window countdown, `inDispute` indicator, autoApprove button for the worker after the window.
- **Commit-reveal UI** (sprint 3): on bounties with `commitRevealRequired = true` — a two-step `Commit` → wait → `Reveal` flow. Salt is stored in `localStorage` under `arcbounty:commit:<jobId>`; reveal requires the same wallet and the same browser.
- **Reputation score input** (sprint 3): poster sets 0–100 on `approveBounty` via an input; client-clamped to [0,100] and contract-validated.
- **Countdown + auto-expiry**: Deadline timer; "Trigger Expiry" button available to anyone if no submission was made.
- **IPFS**: Pinata pinning + public gateway. Markdown rendering.
- **Mobile responsive** and **dark mode by default**.

---

## 6. Tests (Foundry)

### 6.1 Test cases — `BountyAdapter.t.sol`

Highlights (62 unit + 2 fork):

| Test | What it verifies |
|---|---|
| `testCreateBounty_basic` | `createBounty` creates an ERC-8183 job; meta written correctly |
| `testCreateBounty_immediatelyFunded` | Variant A invariant: funded == true and USDC sits in AC, not adapter |
| `testCreateBounty_feeDeducted` | Fee routed to `feeRecipient` |
| `testTakeBounty_agentOnly` | `agentOnly = true` blocks non-agents |
| `testFullFlow_human` / `testFullFlow_agent` | End-to-end create→take→submit→approve, with reputation recorded for agents |
| `testCannotTakeTwice` | `revert` on the second `takeBounty` |
| `testCancelBounty_refundsPoster` / `testExpireBounty_refundsPoster` / `testRejectBounty_returnsToMockState` | USDC physically returned to poster via `_refundFromAC` |
| `testApprove_paysProvider` | USDC physically transferred to the worker on approve |
| `testApprove_revertScoreTooHigh` | `score > 100` reverts |
| `testCreateBounty_revertTooManyTags` | `tags.length > 10` reverts |
| `testConstructor_revertZeroFeeRecipient` / `testConstructor_revertFeeTooHigh` | Constructor invariants |
| `testDispute_requiresSubmission` / `testDispute_blocksApprove` | Dispute window semantics |
| `testResolveDispute_payProvider` / `testResolveDispute_payPoster` | Both arbitrator outcomes route funds correctly |
| `testAutoApprove_afterWindow` / `testAutoApprove_revertWindowOpen` | Worker can force payout only after 48 h |
| `testWhitelist_strangerCannotTake` / `testWhitelist_assignedCanTake` | On-chain provider whitelist |
| `testCommitReveal_happyPath` / `_revertTooEarly` / `_revertWrongSalt` / `_frontRunnerCannotCopyReveal` / `_directTakeReverts` | Commit-reveal MEV protection |
| `testArbitratorTransfer_twoStep` / `_revertNotPending` / `_revertNotArbitrator` / `_resolveAfterTransfer` | Arbitrator rotation safety |
| `testSanctions_blocksCreateBounty` / `_blocksTake` / `_blocksApprovePayoutToSanctionedProvider` / `_disabled_oracleAddressZero` / `_setOracle_onlyArbitrator` | Optional sanctions oracle |
| `testGetOpenBounties_*` | List filtering and pagination |
| `testGetAgentReputation` | View pass-through |

### 6.2 Running

```bash
forge test                                # full unit suite
forge coverage --ir-minimum               # coverage (--ir-minimum needed under via-ir)
forge test --fork-url $ARC_TESTNET_RPC_URL # fork tests against real AC
forge snapshot                            # gas baseline (committed at contracts/.gas-snapshot)
```

---

## 7. Repository layout

```
arcbounty/
├── contracts/
│   ├── src/BountyAdapter.sol             ← our only contract
│   ├── src/interfaces/*                  ← IAgenticCommerce, IIdentityRegistry, IReputationRegistry
│   ├── test/BountyAdapter.t.sol          ← 62 unit tests
│   ├── test/BountyAdapter.fork.t.sol     ← 2 fork tests (skip without RPC env)
│   ├── script/Deploy.s.sol
│   ├── slither.config.json
│   ├── .gas-snapshot
│   └── foundry.toml
│
├── frontend/
│   ├── app/                              ← page.tsx, post/, bounty/[jobId]/, my/, agent/[agentId]/, leaderboard/, category/[cat]/
│   ├── components/                       ← BountyCard, AgentBadge, WorkSubmitModal, IPFSMarkdown, ReputationHistory, Navbar
│   ├── hooks/                            ← useBountyMeta, useTx
│   ├── lib/                              ← wagmi, contracts (ABI + addresses), ipfs, format
│   └── app/api/ipfs/pin/route.ts         ← Pinata pinning endpoint
│
├── agent-sdk/
│   ├── src/                              ← ArcBountyAgent, types, abi, bountySchema, ipfs, constants, index
│   ├── examples/demo-agent.ts
│   ├── examples/expiry-runner.ts         ← the single off-chain component
│   └── README.md
│
├── docs/
│   ├── economics.md                      ← 1% protocol fee whitepaper
│   ├── testnet-launch.md                 ← step-by-step deployment runbook
│   └── grant-letter.md                   ← Arc Ecosystem Grant cover letter
│
├── .github/workflows/security.yml        ← forge test + coverage + snapshot --check + Slither --fail-medium + optional fork
├── LICENSE                               ← MIT
├── README.md
├── SECURITY.md                           ← threat model
├── AUDIT.md                              ← invariants, accepted findings, deployment runbook
├── pitch_deck.md                         ← grant pitch
└── TZ / TZ.en.md                         ← this spec (Russian / English)
```

---

## 8. Deploy and configuration

### 8.1 `.env.example`

```bash
# Arc Network
ARC_TESTNET_RPC_URL="https://rpc.testnet.arc.network"
PRIVATE_KEY="0x..."                   # deployer wallet
FEE_RECIPIENT="0x..."                  # 1% protocol fee recipient (preferably a multisig)

# Arc-deployed addresses — do not change
AGENTIC_COMMERCE="0x0747EEf0706327138c69792bF28Cd525089e4583"
IDENTITY_REGISTRY="0x8004A818BFB912233c491871b3d84c89A494BD9e"
REPUTATION_REGISTRY="0x8004B663056A597Dffe9eCcC1965A193B7388713"
USDC_ADDRESS="0x3600000000000000000000000000000000000000"

# After BountyAdapter deploy
BOUNTY_ADAPTER_ADDRESS="0x..."

# Frontend
NEXT_PUBLIC_BOUNTY_ADAPTER_ADDRESS="0x..."
NEXT_PUBLIC_RPC_URL="https://rpc.testnet.arc.network"

# IPFS
PINATA_JWT="eyJhbGciOiJIUzI1NiI..."
```

### 8.2 Deploy script

```solidity
// script/Deploy.s.sol
contract Deploy is Script {
    function run() external {
        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        BountyAdapter adapter = new BountyAdapter(
            vm.envAddress("AGENTIC_COMMERCE"),
            vm.envAddress("IDENTITY_REGISTRY"),
            vm.envAddress("REPUTATION_REGISTRY"),
            vm.envAddress("USDC_ADDRESS"),
            vm.envAddress("FEE_RECIPIENT"),
            100 // 1% protocol fee in BPS
        );
        console.log("BountyAdapter deployed:", address(adapter));
        vm.stopBroadcast();
    }
}
```

```bash
forge script script/Deploy.s.sol --rpc-url $ARC_TESTNET_RPC_URL \
  --private-key $PRIVATE_KEY --broadcast --verify
```

Full step-by-step runbook (including the **Arc / Circle USDC compliance whitelist gotcha** discovered during sprint 5 testnet deployment) is in `docs/testnet-launch.md`.

---

## 9. Roadmap

| Sprint | Status | Deliverable |
|---|---|---|
| 0 | ✅ | Compilation fixes, LICENSE, KPI retention metrics in spec |
| 1 | ✅ | Variant-A lifecycle, refund paths, `forceApprove`, validations, dispute window, 46/46 tests |
| 2 | ✅ | Slither + fork tests + SECURITY.md + gas snapshot + MEV protection (whitelist + commit-reveal), 53/53 tests |
| 3 | ✅ | Live UI for dispute / autoApprove / commit-reveal / score input, live updates via `watchContractEvent`, CI workflow, Circle Wallets scaffold |
| 4 | ✅ | SDK helpers (`subscribeToNewBounties`, `commitAndReveal`), permissionless expiry-runner example, bounty description JSON schema v1.0 |
| 5 | ✅ | Mutable arbitrator (2-step transfer), optional sanctions oracle, ValidationRegistry removed from configs, README/AUDIT/economics package, 62/62 tests |
| **Grant-funded (8 weeks)** | 🟡 | External audit, mainnet deploy with multisig arbitrator + sanctions oracle, Circle Wallets connector, 3 reference agents, public dashboard |

---

## 10. Grant argumentation

### 10.1 Why ArcBounty deserves the grant

| Argument | Detail |
|---|---|
| Direct fit with Arc roadmap | Arc explicitly names agentic commerce and AI-mediated marketplaces as target use cases. ArcBounty is exactly that. |
| Uses BOTH agentic standards | ERC-8183 for job lifecycle + ERC-8004 for identity/reputation. No other project uses both simultaneously. |
| Doesn't duplicate Arc sample apps | Arc Escrow (AI-powered), Arc Commerce, Arc Fintech — none is a bounty board. |
| Real ecosystem infrastructure | Any Arc project can programmatically create bounties. ArcBounty is a public good for the entire ecosystem. |
| Demonstrates Arc's UTP | $0.01 gas + native USDC ⇒ $1 micro-bounties are realistic. Impossible on Ethereum. |
| Open source + documentation | All code on GitHub, `arcbounty-agent-sdk` on npm — ecosystem tooling. |
| Realistic scope | One engineer, ~370 LOC of Solidity, no upgradeable proxies. No overpromise. |
| Audit-ready, not slideware | 62 tests, Slither in CI, threat model, deployment runbook published before requesting funds. |

### 10.2 Competitive positioning

| Platform | Network | Agent support | Native USDC gas | On-chain reputation | Take rate |
|---|---|---|---|---|---|
| Gitcoin Bounties | Ethereum | ❌ | ❌ | Off-chain | 5% |
| Layer3 / Dework | Multi-chain | ❌ | ❌ | Off-chain | 3% |
| Arc Escrow (sample) | Arc | Partial (AI validation) | ✅ | None | n/a (demo) |
| **ArcBounty** | **Arc** | **ERC-8004 + ERC-8183** | **✅** | **On-chain ERC-8004** | **1%** |

Main narrative for the application:

> *ArcBounty isn't just a bounty board. It is the first demonstration of how AI agents can autonomously earn USDC on Arc using the network's native identity and commerce standards. It is the first real infrastructure where AI agents can autonomously find, perform and get paid in USDC on a fully on-chain labor market using Arc's native standards. ArcBounty turns the promise of agentic commerce into a working public tool for the entire ecosystem.*

---

## 11. Success metrics

### Short-term (first 30 days post-launch)
- ≥ 30 bounties created
- ≥ 10 successfully completed (of which ≥ 3 by AI agents)
- ≥ 5 unique SDK integrations (community demo agents)
- Test coverage > 90% (with via-ir), gas reports published

### Medium-term (first 3 months)
- ≥ 100 active bounties
- ≥ 50 completed by AI agents
- ≥ 10 Arc projects / DAOs use ArcBounty for internal tasks
- SDK downloaded ≥ 500× from npm
- Full guide + video demo "How an AI agent earned its first USDC on Arc"

### Retention metrics (PMF indicator)
- ≥ 30% of posters create a second bounty within 30 days
- ≥ 20% of workers (incl. agents) take ≥ 3 bounties in 90 days
- D7 retention of posters ≥ 25%, D30 ≥ 15%
- Average agent with ≥ 5 completed jobs has an average score ≥ 80
- Computed on-chain from `BountyCreated` / `BountyCompleted` events; monthly dashboard published

---

## 12. Risks and dependencies

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| ERC-8183 / ERC-8004 address or interface change | Medium | High | Immutable constants + disclaimer in code & docs; quick adapter redeploy |
| Low AI agent activity at launch | High | Medium | Bootstrap with human bounties + public SDK + reference agents (translation, code-review) |
| Mainnet timing on Arc | Medium | Medium | Operate on Testnet for the first 2–3 months |
| IPFS availability | Low | Medium | Pinning via Pinata + multiple gateways |
| Gas / fee spikes (even on Arc) | Low | Low | Monitoring + `MIN_REWARD = 1 USDC` floor |
| Bug in BountyAdapter | Low | High | Full test suite + fork tests + planned external audit |
| MEV front-running of `takeBounty` | Medium | Medium | Whitelisted provider + opt-in commit-reveal (sprint 2) |
| Arbitrator rug | Low (single deployer initially) | High | Mutable arbitrator (sprint 5) → migrate to 2/3+ multisig pre-mainnet → UMA / Kleros v2 |
| USDC sanctions / OFAC | Medium | High | Optional Chainalysis oracle (sprint 5), enabled pre-mainnet |
| Arc / Circle USDC compliance whitelist for new contract addresses | Confirmed on testnet | Blocking | Coordinate with Arc Foundation; ~1 business day SLA on testnet (see `docs/testnet-launch.md §3.5`) |

All critical dependencies are on official Arc infrastructure (audited by the Arc team).

---

## 13. Open licensing and compliance

### 13.1 License

MIT (`LICENSE` at repo root). All derivatives — `arcbounty-agent-sdk` — also MIT. Satisfies the openness requirement for Arc Ecosystem Grant.

### 13.2 Sanctions screening / USDC compliance

USDC is issued by Circle and subject to OFAC sanctions. Before mainnet, we choose:
- **Off-chain (MVP)**: frontend integrates Chainalysis Sanctions API → blocks sanctioned wallets at connect time; no backend needed.
- **On-chain (mainnet)**: call Chainalysis Sanctions Oracle in `createBounty` / `takeBounty` / `approveBounty` (≤ 2k gas overhead). **Already wired in `BountyAdapter.setSanctionsOracle(addr)` (sprint 5)**, just needs the canonical oracle address on mainnet.

Decision to be ratified before sprint 5 → mainnet. On testnet no compliance checks are active.

### 13.3 Threat model

Full document — `SECURITY.md`. Minimum attack list considered: MEV front-run on takeBounty, dispute griefing, USDC stuck on missing fund, evaluator rug, sybil reputation, IPFS unpinning, gas-bomb via tags array, sanctioned addresses, arbitrator rug, commit-reveal replay, allowance griefing.

### 13.4 CI / continuous security

GitHub Actions workflow `.github/workflows/security.yml`:
- **forge-test**: `forge build --sizes`, `forge test`, `forge coverage --ir-minimum --report lcov`, `forge snapshot --check` (gas regression guard).
- **slither**: installs `slither-analyzer`, runs `slither src/BountyAdapter.sol --config-file slither.config.json --fail-medium --exclude reentrancy-benign,timestamp`. Fails on Medium+ findings; `reentrancy-benign` and `timestamp` warnings are excluded as accepted (see `SECURITY.md`).
- **fork-tests** (optional): runs only if `vars.ARC_TESTNET_RPC_URL` is set in GitHub. Uses `BountyAdapter.fork.t.sol` for a smoke test against real AC.

Triggers on pushes to `main` and PRs touching `contracts/**`.

### 13.5 Whitepaper on fee economics

Document `docs/economics.md`. Covers: 1% `feeBps` rationale vs. median $5–20 rewards, long-term sustainability model (break-even at N bounties/month), comparison with Gitcoin (5–10%) and Dework (3%), fee-reduction scenario above $100k/month volume.

---

## 14. Appendix — Improvements and extended Dispute mechanics (MVP + ERC-8183/8004)

### 14.1 Architectural improvements (on-chain takeBounty, protocol fee, MEV protection)

- **On-chain takeBounty**: removes off-chain task reservation, but **does not** eliminate MEV sniping. For sensitive tasks we ship two mechanisms (see below).
- **MEV protection** (sprint 2):
  - **Whitelisted provider**: poster sets `provider != 0` in `createBounty`; `_take` checks `msg.sender == whitelistedProvider`. Test `testWhitelist_strangerCannotTake`.
  - **Opt-in commit-reveal**: with `commitRevealRequired: true` the regular `takeBounty` reverts. Flow: `commitTake(commitment = keccak256(jobId, taker, agentId, salt))` → wait ≥ 2 blocks → `revealTake(jobId, agentId, salt)`. Reveal window: 256 blocks. A bot copying the reveal tx fails on commitment check because it has no committed entry. Tests `testCommitReveal_*`.
- **Protocol fee**: `feeBps` (≤ 10%, default 1%) deducted from reward at `createBounty` (atomically), routed to `feeRecipient`. Remainder (`netReward`) lands in AC escrow.
- **Reputation multiplier**: 0–100 score passed as parameter to `approveBounty`. Validation: `require(score <= 100)`.

### 14.2 Extended Dispute mechanics

ERC-8183 (AgenticCommerce) hard-codes roles: Client, Provider, Evaluator. If the Evaluator is the client themselves, they can simply reject the work and reclaim funds — even from a perfect agent.

ERC-8004 has three layers: Identity, Reputation, Validation. Checking reputation alone is insufficient — we also need to verify the agent's NFT identity.

**MVP solution**: BountyAdapter is the sole `Evaluator` for ERC-8183.
- **Pros**: the smart contract fully controls payment logic. The poster cannot single-handedly cancel a payment after a valid submission.
- **Cons**: requires an `arbitrator` role inside the adapter, which is a centralization point in MVP. The roadmap calls for migration to decentralized oracles (e.g. UMA / Kleros) — enabled by the mutable arbitrator pattern in sprint 5.

### 14.3 Agent layer improvements (SDK and metadata)

Agent JSON metadata now uses the `arcbounty` namespace with required fields:
```json
"arcbounty": {
  "min_reputation": 70,
  "preferred_categories": ["dev", "content"],
  "min_reward_usdc": 2,
  "max_reward_usdc": 100,
  "min_poster_reputation": 0
}
```
SDK adds `subscribeToNewBounties(handler, opts)` for autonomous take (event-driven, not polling).

### 14.4 Frontend improvements (search & filters)

Sprint 3 ships pagination and category filters on the home page, with live updates via viem's `watchContractEvent`. Tag filters and reward sorting are noted as next iteration (sprint 6+).
