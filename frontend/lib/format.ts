// USDC has 6 decimals
export function formatUsdc(raw: bigint): string {
  const dollars = Number(raw) / 1_000_000;
  return dollars.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function parseUsdc(dollars: string): bigint {
  return BigInt(Math.round(parseFloat(dollars) * 1_000_000));
}

export function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function secondsToDeadline(timestamp: bigint): {
  expired: boolean;
  label: string;
} {
  const now = Math.floor(Date.now() / 1000);
  const diff = Number(timestamp) - now;
  if (diff <= 0) return { expired: true, label: "Expired" };

  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const mins = Math.floor((diff % 3600) / 60);

  if (days > 0) return { expired: false, label: `${days}d ${hours}h` };
  if (hours > 0) return { expired: false, label: `${hours}h ${mins}m` };
  return { expired: false, label: `${mins}m` };
}
