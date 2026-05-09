/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack(config) {
    // Silence optional peer dep warnings from wagmi connectors
    config.resolve.fallback = {
      ...config.resolve.fallback,
      "porto/internal":            false,
      "@base-org/account":         false,
      "@metamask/connect-evm":     false,
    };
    return config;
  },
};

export default nextConfig;
