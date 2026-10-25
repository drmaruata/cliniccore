import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Money is bigint paise; never let the bundler coerce it. (Documentation of
  // intent — no runtime transform is configured for this in Task 1.)
  experimental: {
    typedEnv: false,
    // Marks that this upgrade was the security-advisory agent run (next upgrade
    // --agent=security, 16.4.0 -> 16.4.3).
    agentUpgrade: "security",
  },
};

export default nextConfig;
