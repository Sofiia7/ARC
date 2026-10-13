export { ArcBountyAgent } from "./ArcBountyAgent.js";
export type {
  ArcBountyAgentConfig,
  BountyMeta,
  ReputationScore,
  OpenBountiesFilter,
  CreateBountyOptions,
  SubmitWorkOptions,
  DisputeEvidenceOptions,
  AgentInfo,
  TxResult,
  CircleWalletConfig,
  PendingAction,
  PendingActionKind,
} from "./types.js";
export {
  NETWORKS,
  resolveNetwork,
  type NetworkName,
  type NetworkConfig,
  type NativeCurrency,
  type Brand,
  // Deprecated 0.4.x aliases - see @deprecated JSDoc in constants.ts; all
  // three are wired to the NETWORKS["arc-testnet"] entry.
  CONTRACTS,
  ARC_TESTNET_RPC,
  ARC_TESTNET_CHAIN_ID,
  MIN_BOND_BOUNTY_DURATION_SEC,
  MIN_BOND_TAKE_WINDOW_SEC,
} from "./constants.js";
export {
  parseUsdc,
  resolveDeadline,
  matchesBountyFilter,
  workerBondFor,
  bondCreateDeadlineOk,
  bondTakeWindowOk,
} from "./logic.js";
export { BOUNTY_ADAPTER_ABI, IDENTITY_REGISTRY_ABI, ERC20_ABI } from "./abi.js";
export {
  pinText, pinTextAuto, pinTextViaSite, pinAuthMessage, pinUrlFor, DEFAULT_PIN_URL,
  fetchIpfsText, fetchIpfsJson, isPinningConfigured,
} from "./ipfs.js";
export type { MessageSigner, PinViaSiteOptions } from "./ipfs.js";
export {
  pinAgentMetadata,
  validateAgentMetadata,
  type AgentMetadata,
  type ArcBountySection,
} from "./metadata.js";

export { NadBountyAgent, MIRROR_SOURCE_CHAINS } from "./NadBountyAgent.js";
export type {
  NadBountyAgentConfig,
  NadBountyCreateParams,
  NadBountyMeta,
  NadAgentReputation,
  NadReputationTotals,
  NadMirrorRecord,
  NadIdentity,
  NadPendingWithdrawals,
} from "./NadBountyAgent.js";
export {
  MONAD_NETWORKS,
  MONAD_MULTICALL3,
  NAD_MIN_REWARD,
  NAD_CATEGORIES,
  type MonadNetworkName,
  type MonadNetworkConfig,
  type NadCategory,
} from "./constants.js";
export { NadBountyError, toNadError, redactUrls } from "./nadErrors.js";
export { validateNadCreateParams, type NadCreateParamsLike } from "./nadParams.js";
export {
  MONAD_IDENTITY_REGISTRY_ABI,
  AGENT_WALLET_MAX_DEADLINE_DELAY_SEC,
  agentWalletTypedData,
  identityKey,
  type AgentWalletConsent,
  type AgentWalletConsentInput,
} from "./nadIdentity.js";
export {
  CONTEST_ENCRYPTION_ALGORITHM,
  createDescription,
  serializeDescription,
  parseNadDescription,
  contestPublicKeyOf,
  pinContestEntry,
  type CreateDescriptionInput,
  type NadContestEncryption,
  type NadDescription,
  type NadKeySource,
  type ParsedNadDescription,
} from "./nadDescription.js";
export { computePendingActions, NAD_WINDOWS } from "./nadPending.js";
export type {
  NadPendingAction,
  NadPendingClaim,
  NadPendingDecision,
  NadPendingContest,
  NadPendingJob,
  NadPendingMeta,
  NadPendingRole,
  NadResponseAction,
} from "./nadPending.js";
export { BOUNTY_ADAPTER_V48_ABI } from "./abi-v48.js";
export { REPUTATION_MIRROR_ABI } from "./reputationMirrorAbi.js";
export { KEEPER_RECEIVER_ABI } from "./keeperReceiverAbi.js";

export { generateContestKeypair, contestKeypairFromSeed, deriveContestKeypair, encryptContestEntry, decryptContestEntry } from "./contestEncryption.js";
export type { ContestEncryptionKeypair, EncryptedContestEntry } from "./contestEncryption.js";
export { selectNadSettlement, NAD_SETTLEMENTS } from './nadKeeper.js';
export type { NadKeeperMeta, NadKeeperContest, NadSettlement } from './nadKeeper.js';
