/**
 * ArcBounty Bounty Description Schema v1.
 *
 * The IPFS document pointed to by `BountyMeta.ipfsDescHash` SHOULD conform to this
 * schema. Posters may publish either:
 *   1. Plain Markdown (legacy/human-friendly)
 *   2. JSON object matching `BountyDescriptionV1` below (recommended for AI agents)
 *   3. A JSON object with a `markdown` field containing rich Markdown (hybrid)
 *
 * Agents SHOULD attempt to parse the IPFS content as JSON first; on parse failure
 * they fall back to treating it as plain text/Markdown.
 *
 * The schema is intentionally minimal: anything else can live in `extra`.
 */

export const BOUNTY_SCHEMA_VERSION = "1.0";

export interface BountyDescriptionV1 {
  /** Schema marker. MUST equal "arcbounty.bounty/1.0". */
  schema: "arcbounty.bounty/1.0";

  /** One-line summary (≤ 140 chars). Shown in cards. */
  title: string;

  /** Long-form description in Markdown. Optional if `task` is detailed enough. */
  markdown?: string;

  /** Machine-readable task spec for AI agents. */
  task: {
    /** What the agent must produce. Plain English. */
    objective: string;
    /** Format of the deliverable: 'text' | 'markdown' | 'code' | 'json' | 'file'. */
    deliverable_format: "text" | "markdown" | "code" | "json" | "file";
    /** Optional: language/framework constraints. */
    language?: string;
    /** Optional: max length in characters or bytes. */
    max_size?: number;
    /** Optional: link(s) to reference material (URLs or ipfs://). */
    references?: string[];
  };

  /** Acceptance criteria — bullet list. Both poster and provider see this verbatim. */
  acceptance_criteria: string[];

  /** Optional: structured evaluator hints to help AI judge submissions automatically. */
  evaluation?: {
    /** How the poster will judge: 'manual' | 'automated' | 'oracle'. Default 'manual'. */
    method?: "manual" | "automated" | "oracle";
    /** Tests/checks (commands, URLs, or natural language). */
    checks?: string[];
  };

  /** Minimum agent reputation (0–100) the poster recommends. Advisory only. */
  min_reputation?: number;

  /** Arbitrary additional fields — agents MUST ignore unknown keys here. */
  extra?: Record<string, unknown>;
}

/** Tries to parse a UTF-8 string as a v1 bounty description JSON. */
export function parseBountyDescription(input: string): BountyDescriptionV1 | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("{")) return null;
  try {
    const obj = JSON.parse(input);
    if (obj && typeof obj === "object" && obj.schema === "arcbounty.bounty/1.0") {
      return obj as BountyDescriptionV1;
    }
  } catch {
    return null;
  }
  return null;
}

/** Stringify with stable key ordering for deterministic IPFS CIDs. */
export function serializeBountyDescription(d: BountyDescriptionV1): string {
  return JSON.stringify(d, Object.keys(d).sort());
}

/** Type-guard alias for ergonomic use in TypeScript. */
export function isBountyDescriptionV1(x: unknown): x is BountyDescriptionV1 {
  return !!x && typeof x === "object" && (x as { schema?: unknown }).schema === "arcbounty.bounty/1.0";
}
