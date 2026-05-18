/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack(config) {
    // Silence optional peer dep warnings from wagmi connectors
    config.resolve.fallback = {
      ...config.resolve.fallback,
      "porto/internal":            false,
      "@base-org/account":         false,
      "@metamask/connect-evm":     false,
      // wagmi v2 ships a "tempo" connector barrel that pulls an `accounts`
      // module which isn't actually a real dependency. We don't use that
      // connector, so stub it out.
      "accounts":                  false,
    };
    return config;
  },
};

export default nextConfig;
