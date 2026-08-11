import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep Next.js inside this nested example when it runs from the docs repo.
  turbopack: { root: process.cwd() },
};

export default nextConfig;
