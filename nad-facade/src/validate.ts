const ID_PATTERN = /^[1-9]\d{0,29}$/;
const SMALL_INT = /^(0|[1-9]\d{0,3})$/;

/** A positive integer identifier (job or agent ID) of at most 30 digits, or undefined. */
export function parseId(raw: unknown): bigint | undefined {
  return typeof raw === "string" && ID_PATTERN.test(raw) ? BigInt(raw) : undefined;
}

export const VERIFIED_DEFAULTS = { minJobs: 3, minAvgScore: 80 } as const;
export const VERIFIED_BOUNDS = { minJobs: { min: 1, max: 1000 }, minAvgScore: { min: 0, max: 100 } } as const;

export type VerifiedQuery = { minJobs: number; minAvgScore: number };
export type VerifiedQueryResult = { ok: true; value: VerifiedQuery } | { ok: false; error: string };

/**
 * Strict query parsing for GET /v1/workers/verified: only minJobs and minAvgScore, each a single plain decimal integer
 * (no signs, fractions, exponents, hex or padding) inside its bounds. Missing values take the Proven preset.
 */
export function parseVerifiedQuery(query: Record<string, unknown>): VerifiedQueryResult {
  for (const key of Object.keys(query)) {
    if (key !== "minJobs" && key !== "minAvgScore") return { ok: false, error: "Unknown query parameter" };
  }
  const value: VerifiedQuery = { ...VERIFIED_DEFAULTS };
  for (const key of ["minJobs", "minAvgScore"] as const) {
    const raw = query[key];
    if (raw === undefined) continue;
    const { min, max } = VERIFIED_BOUNDS[key];
    if (typeof raw !== "string" || !SMALL_INT.test(raw) || Number(raw) < min || Number(raw) > max) {
      return { ok: false, error: `Invalid ${key}: expected an integer from ${min} to ${max}` };
    }
    value[key] = Number(raw);
  }
  return { ok: true, value };
}
