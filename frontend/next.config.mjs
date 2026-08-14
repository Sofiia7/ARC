/** @type {import('next').NextConfig} */

// ──────────────────────────────────────────────────────────────────────────────
// Active-network origins for the CSP below.
//
// next.config.mjs runs directly under plain Node — before Next's own
// TypeScript pipeline exists — so it can't `import` the app's
// lib/networks.ts. This mirrors just the handful of fields the CSP needs
// (RPC + explorer origins) straight from the same NEXT_PUBLIC_* env vars.
// Keep this in sync with lib/networks.ts if either changes.
//
// One build = one network (NEXT_PUBLIC_ARC_NETWORK), so the CSP only ever
// needs to allow the ACTIVE network's origins, never both at once.
// ──────────────────────────────────────────────────────────────────────────────
function readEnv(key) {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : undefined;
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    throw new Error(`[arcbounty] next.config.mjs: "${url}" is not a valid URL.`);
  }
}

function activeNetworkOrigins() {
  const network = readEnv("NEXT_PUBLIC_ARC_NETWORK") ?? "arc-testnet";

  if (network === "arc-testnet") {
    const rpcUrl = readEnv("NEXT_PUBLIC_RPC_URL") ?? "https://rpc.testnet.arc.network";
    return { rpc: originOf(rpcUrl), explorer: originOf("https://testnet.arcscan.app") };
  }

  if (network === "base-sepolia") {
    const rpcUrl = readEnv("NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL") ?? "https://sepolia.base.org";
    // Basescan and the Etherscan V2 API live on different hosts, unlike Arc
    // where the explorer serves its own API — both must be allowed.
    return {
      rpc: originOf(rpcUrl),
      explorer: originOf("https://sepolia.basescan.org"),
      explorerApi: originOf("https://api.etherscan.io"),
    };
  }

  if (network === "base-mainnet") {
    const rpcUrl = readEnv("NEXT_PUBLIC_BASE_MAINNET_RPC_URL") ?? "https://mainnet.base.org";
    // Same split as Base Sepolia: Basescan serves the UI, the Etherscan V2 API
    // lives on its own host, and the CSP must allow both.
    return {
      rpc: originOf(rpcUrl),
      explorer: originOf("https://basescan.org"),
      explorerApi: originOf("https://api.etherscan.io"),
    };
  }

  if (network === "arc-mainnet") {
    const rpcUrl = readEnv("NEXT_PUBLIC_ARC_MAINNET_RPC_URL");
    const explorerUrl = readEnv("NEXT_PUBLIC_ARC_MAINNET_EXPLORER_URL");
    const explorerApiUrl = readEnv("NEXT_PUBLIC_ARC_MAINNET_EXPLORER_API_URL");
    const missing = [
      ["NEXT_PUBLIC_ARC_MAINNET_RPC_URL", rpcUrl],
      ["NEXT_PUBLIC_ARC_MAINNET_EXPLORER_URL", explorerUrl],
      ["NEXT_PUBLIC_ARC_MAINNET_EXPLORER_API_URL", explorerApiUrl],
    ].filter(([, v]) => v === undefined).map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(
        `[arcbounty] next.config.mjs: NEXT_PUBLIC_ARC_NETWORK=arc-mainnet but missing ${missing.join(", ")}. ` +
        "Arc mainnet parameters are published by Circle at https://docs.arc.io/arc/references/contract-addresses " +
        "— see lib/networks.ts.",
      );
    }
    // explorerApiUrl is same-origin as explorerUrl in practice, but derive it
    // separately rather than assume that stays true.
    return { rpc: originOf(rpcUrl), explorer: originOf(explorerUrl), explorerApi: originOf(explorerApiUrl) };
  }

  throw new Error(`[arcbounty] next.config.mjs: NEXT_PUBLIC_ARC_NETWORK="${network}" is not a valid network.`);
}

const { rpc: RPC_ORIGIN, explorer: EXPLORER_ORIGIN, explorerApi: EXPLORER_API_ORIGIN } = activeNetworkOrigins();
// Same-origin today for both networks' known values; kept as a set in case that changes.
const EXPLORER_ORIGINS = [...new Set([EXPLORER_ORIGIN, EXPLORER_API_ORIGIN].filter(Boolean))];

// ──────────────────────────────────────────────────────────────────────────────
// Content-Security-Policy
// Tight enough to neutralize stored-XSS via IPFS content (defence in depth on
// top of rehype-sanitize). Loosen only with eyes open.
//   • script-src: 'unsafe-inline' is required by Next dev + wagmi connectors.
//     A production-hardened build should move to nonce-based CSP — see Sprint 1.
//   • connect-src: covers RPC, Pinata, IPFS gateways, WalletConnect relay.
//   • img-src: needed for IPFS-hosted images in bounty descriptions.
//
// RPC_ORIGIN / EXPLORER_ORIGINS are the resolved ACTIVE network's exact
// origins (see activeNetworkOrigins() above) — not a `*.arcscan.app`-style
// wildcard. The previous wildcard was also a bug: it doesn't cover the apex
// `arcscan.app`, only subdomains of it.
// ──────────────────────────────────────────────────────────────────────────────
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  // api.web3modal.org also serves the wallet icons rendered inside the
  // WalletConnect modal.
  [
    "img-src 'self' data: blob:",
    "https://*.pinata.cloud", "https://ipfs.io", "https://dweb.link", "https://nftstorage.link",
    ...EXPLORER_ORIGINS,
    "https://api.web3modal.org",
  ].join(" "),
  "font-src 'self' data: https://fonts.reown.com",
  // Explorer origins in connect-src: /stats + leaderboard fetch event logs via
  // the active network's Blockscout-compatible API (the RPC caps eth_getLogs
  // at 10k blocks).
  // api.web3modal.org + fonts.reown.com: the WalletConnect modal is Reown
  // AppKit, and it loads its config, wallet list, icons and fonts from those
  // two hosts — everything else it touches is already covered by
  // *.walletconnect.*. Without them the modal still opens but comes up with no
  // wallets to pick from, and the console fills with "Failed to fetch usage".
  [
    "connect-src 'self'",
    RPC_ORIGIN,
    ...EXPLORER_ORIGINS,
    "https://*.pinata.cloud", "https://uploads.pinata.cloud",
    "https://ipfs.io", "https://dweb.link", "https://nftstorage.link",
    "https://*.walletconnect.com", "https://*.walletconnect.org",
    "wss://*.walletconnect.com", "wss://*.walletconnect.org",
    "https://api.web3modal.org",
    // Porto (passkey smart-account connector): id.porto.sh serves the signing
    // dialog, rpc.porto.sh is its RPC. Without these the "Sign in with
    // passkey" option — the FIRST entry in the connect modal — silently does
    // nothing: the iframe is blocked and no wallet is ever produced.
    "https://id.porto.sh", "https://rpc.porto.sh",
  ].join(" "),
  "frame-src 'self' https://*.walletconnect.com https://*.walletconnect.org https://id.porto.sh",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy",     value: CSP },
  { key: "X-Frame-Options",             value: "DENY" },
  { key: "X-Content-Type-Options",      value: "nosniff" },
  { key: "Referrer-Policy",             value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security",   value: "max-age=63072000; includeSubDomains; preload" },
  { key: "Permissions-Policy",          value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy",  value: "same-origin" },
];

const nextConfig = {
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
    ];
  },
  webpack(config) {
    // Silence optional peer dep warnings from wagmi connectors
    config.resolve.fallback = {
      ...config.resolve.fallback,
      "porto/internal":            false,
      "@base-org/account":         false,
      "@metamask/connect-evm":     false,
      "accounts":                  false,
    };
    return config;
  },
};

export default nextConfig;
