/** @type {import('next').NextConfig} */

// ──────────────────────────────────────────────────────────────────────────────
// Content-Security-Policy
// Tight enough to neutralize stored-XSS via IPFS content (defence in depth on
// top of rehype-sanitize). Loosen only with eyes open.
//   • script-src: 'unsafe-inline' is required by Next dev + wagmi connectors.
//     A production-hardened build should move to nonce-based CSP — see Sprint 1.
//   • connect-src: covers RPC, Pinata, IPFS gateways, WalletConnect relay.
//   • img-src: needed for IPFS-hosted images in bounty descriptions.
// ──────────────────────────────────────────────────────────────────────────────
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  // api.web3modal.org also serves the wallet icons rendered inside the
  // WalletConnect modal.
  "img-src 'self' data: blob: https://*.pinata.cloud https://ipfs.io https://dweb.link https://nftstorage.link https://*.arcscan.app https://api.web3modal.org",
  "font-src 'self' data: https://fonts.reown.com",
  // *.arcscan.app in connect-src: /stats + leaderboard fetch event logs via
  // ArcScan's Blockscout API (the RPC caps eth_getLogs at 10k blocks).
  // api.web3modal.org + fonts.reown.com: the WalletConnect modal is Reown
  // AppKit, and it loads its config, wallet list, icons and fonts from those
  // two hosts — everything else it touches is already covered by
  // *.walletconnect.*. Without them the modal still opens but comes up with no
  // wallets to pick from, and the console fills with "Failed to fetch usage".
  "connect-src 'self' https://rpc.testnet.arc.network https://*.arc.network https://*.arcscan.app https://*.pinata.cloud https://uploads.pinata.cloud https://ipfs.io https://dweb.link https://nftstorage.link https://*.walletconnect.com https://*.walletconnect.org wss://*.walletconnect.com wss://*.walletconnect.org https://api.web3modal.org",
  "frame-src 'self' https://*.walletconnect.com https://*.walletconnect.org",
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
