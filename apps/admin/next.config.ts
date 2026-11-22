import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    // src/app/globals.css imports the web app's tokens.css and reset.css by
    // relative path, outside this app's root, so both apps share one palette
    // and scripts/checks/pr/check-css-hex-colors.mjs keeps guarding it.
    externalDir: true,
  },
};

export default nextConfig;
