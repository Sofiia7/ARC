// Pure NadBounty post-form rules: validation sentences, tag handling, the cost box, the step plan and the wording of
// what was and was not spent when a step fails. No React, no wagmi, no browser APIs: safe to import from node:test.
// Limits mirror BountyAdapterV48.createBounty (reward 1-100 USDC with the default cap, 10 tags of 1-32 bytes, 25
// entries, bond bounties at least 24 hours at the contract and 2 whole days here because the block moves on while the
// wallet is open).
import { DEFAULT_MAX_REWARD, MIN_REWARD, workerBondFor } from "./nadMoney";
import { DEFAULT_FEE_BPS, formatUsdcUnits, nadFee } from "./nadStats";

export const MAX_TAGS = 10;
export const MAX_TAG_LENGTH = 32;
export const MAX_ENTRIES = 25;
/** Observed mainnet cost of createBounty. Kept approximate on purpose. */
export const APPROX_GAS_PER_TX = "0.1";

export const CONTEST_CLOSING_HINT =
  "The contest closes at the deadline, or as soon as every entry slot is filled. From then you have 14 days to pick winners or reject all entries (you can also pick earlier). If you do nothing, anyone can split the payment evenly among all entries after the 14 days.";
export const KEY_CUSTODY_HINT =
  "Keep this wallet or passkey to decrypt entries later. Passkeys are tied to this site domain; changing domains creates a different wallet.";
export const CHOICE_CONTEST = {
  name: "Contest",
  desc: "Several agents or humans enter sealed entries, you pick the winner(s).",
};
export const CHOICE_SINGLE = {
  name: "Single taker",
  desc: "The first agent or human who takes it does the work.",
};

// ───────── tags ─────────

export function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "-");
}

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/** "Design, Logo ,logo,," -> ["design", "logo"]. At most 10 tags of 1-32 bytes each (the contract counts bytes). */
export function parseTags(raw: string): { ok: true; tags: string[] } | { ok: false; error: string } {
  const tags: string[] = [];
  for (const part of raw.split(",")) {
    const tag = normalizeTag(part);
    if (!tag) continue;
    if (utf8Length(tag) > MAX_TAG_LENGTH) {
      return {
        ok: false,
        error: `Each tag must be 1-${MAX_TAG_LENGTH} characters. "${tag.slice(0, 20)}…" is too long.`,
      };
    }
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > MAX_TAGS) return { ok: false, error: `Use at most ${MAX_TAGS} tags.` };
  return { ok: true, tags };
}

// ───────── reward ─────────

/** "5", "2.5", "0.000001"-style decimal text to USDC base units (6 decimals). */
export function parseRewardUnits(raw: string): bigint | null {
  const text = raw.trim();
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text);
  if (!match) return null;
  return BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0") || "0");
}

// ───────── validation ─────────

export type PostFormValues = {
  contest: boolean;
  description: string;
  reward: string;
  days: string;
  entries: string;
  winners: string;
  bond: boolean;
  tags: string;
  agentOnly: boolean;
  humanOnly: boolean;
};
export type ParsedPost = {
  amount: bigint;
  duration: number;
  capacity: number;
  selected: number;
  tags: string[];
};

/** Plain sentences, no jargon. Returns the first problem. */
export function validatePostForm(v: PostFormValues): { ok: true; value: ParsedPost } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (v.description.trim().length < 10) return fail("Describe the task in at least 10 characters.");
  const amount = parseRewardUnits(v.reward);
  if (amount === null) return fail("Enter the reward as a number, for example 5 or 2.5 (up to 6 decimals).");
  if (amount < MIN_REWARD || amount > DEFAULT_MAX_REWARD) return fail("The reward must be between 1 and 100 USDC.");
  const duration = Number(v.days);
  if (!Number.isInteger(duration) || duration < 1 || duration > 365) {
    return fail("Days to deadline must be a whole number from 1 to 365.");
  }
  if (v.bond && !v.contest && duration < 2)
    return fail("Bounties with a worker deposit need a deadline of at least 2 days.");
  let capacity = 0;
  let selected = 0;
  if (v.contest) {
    capacity = Number(v.entries);
    selected = Number(v.winners);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_ENTRIES) {
      return fail(`Maximum entries must be a whole number from 1 to ${MAX_ENTRIES}.`);
    }
    if (!Number.isInteger(selected) || selected < 1 || selected > capacity) {
      return fail("Winners must be a whole number from 1 up to the maximum number of entries.");
    }
  }
  if (v.agentOnly && v.humanOnly) return fail("Choose either agent only or human only, not both.");
  const tags = parseTags(v.tags);
  if (!tags.ok) return fail(tags.error);
  return { ok: true, value: { amount, duration, capacity, selected, tags: tags.tags } };
}

// ───────── cost box ─────────

export type CostInput = {
  /** Reward in USDC base units, or null while the field is not a valid amount. */
  reward: bigint | null;
  contest: boolean;
  bond: boolean;
  feeBps?: bigint;
  gasSymbol?: string;
};

/** Sentences for the cost box above the submit button. */
export function costLines(c: CostInput): string[] {
  const gas = `Gas is paid in ${c.gasSymbol ?? "MON"}: about ${APPROX_GAS_PER_TX} ${c.gasSymbol ?? "MON"} per transaction, a fraction of a cent.`;
  if (c.reward === null) return [gas];
  const fee = nadFee(c.reward, c.feeBps ?? DEFAULT_FEE_BPS);
  const lines = [
    `Locks ${formatUsdcUnits(c.reward)} USDC in escrow now.`,
    `1% fee (${formatUsdcUnits(fee)} USDC) is taken from the payout. Refunds carry no fee.`,
    gas,
  ];
  if (!c.contest && c.bond) {
    lines.push(
      `Workers lock a refundable deposit of ${formatUsdcUnits(workerBondFor(c.reward))} USDC (15% of the reward, at least 0.50 USDC) to take it. It is returned when they submit work, and goes to you if they take it and never deliver.`,
    );
  }
  return lines;
}

// ───────── steps ─────────

export type PostStep = "key" | "upload" | "approve" | "create";
export const STEP_NAMES: Record<PostStep, string> = {
  key: "Sign your contest key",
  upload: "Upload description",
  approve: "Approve USDC",
  create: "Create bounty",
};

/** The steps that apply, in order: the key only for a contest, the approval only when the allowance is short. */
export function planPostSteps(o: { contest: boolean; needsApproval: boolean }): PostStep[] {
  const steps: PostStep[] = [];
  if (o.contest) steps.push("key");
  steps.push("upload");
  if (o.needsApproval) steps.push("approve");
  steps.push("create");
  return steps;
}

/** "2/4 Upload description". An unplanned step (the allowance changed on the way) is shown without a count. */
export function stepText(plan: readonly PostStep[], step: PostStep): string {
  const index = plan.indexOf(step);
  return index < 0 ? STEP_NAMES[step] : `${index + 1}/${plan.length} ${STEP_NAMES[step]}`;
}

/** The plan without a step that turned out not to be needed (or with one that turned out to be). */
export function replan(plan: readonly PostStep[], needsApproval: boolean): PostStep[] {
  const has = plan.includes("approve");
  if (has === needsApproval) return [...plan];
  return planPostSteps({ contest: plan.includes("key"), needsApproval });
}

export type PostProgress = { uploaded: boolean; approved: boolean };

/** What already happened and what did not, when `step` failed or was rejected in the wallet. */
export function failureNote(step: PostStep, p: PostProgress): string {
  switch (step) {
    case "key":
      return "Nothing was uploaded or spent.";
    case "upload":
      return "Nothing was spent.";
    case "approve":
      return "Your description is uploaded. No USDC was spent; try again when you are ready.";
    case "create":
      return p.approved
        ? "Your description is uploaded and USDC is approved, but the bounty was not created, so no USDC was spent."
        : "Your description is uploaded, but the bounty was not created, so no USDC was spent.";
  }
}
