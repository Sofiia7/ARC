import { USDC_DECIMALS } from "./constants.js";

const SCALE = 10n ** BigInt(USDC_DECIMALS);

/** Atomic USDC to a trimmed decimal string: 1000n -> "0.001", 990000n -> "0.99", 1000000n -> "1". */
export function formatUsdc(atomic: bigint): string {
  const whole = atomic / SCALE;
  const fraction = (atomic % SCALE).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

export function usdcAmount(atomic: bigint): { atomic: string; usdc: string } {
  return { atomic: atomic.toString(), usdc: formatUsdc(atomic) };
}

/** Weighted average from raw totals, floored to two decimals ("86.66"); null without any paid job. */
export function averageScore(paidJobs: bigint, scoreSum: bigint): string | null {
  if (paidJobs <= 0n) return null;
  const hundredths = (scoreSum * 100n) / paidJobs;
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}`;
}

/** Unix seconds to ISO-8601; null for zero or out-of-range values. */
export function isoFromUnix(seconds: bigint): string | null {
  if (seconds <= 0n || seconds > 8_640_000_000_000n) return null;
  return new Date(Number(seconds) * 1000).toISOString();
}

/** A unix timestamp as the { unix, iso } pair used across responses. */
export function timestamp(seconds: bigint): { unix: string; iso: string | null } | null {
  return seconds === 0n ? null : { unix: seconds.toString(), iso: isoFromUnix(seconds) };
}
