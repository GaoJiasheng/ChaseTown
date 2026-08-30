import { execFileSync } from "node:child_process";
import type { NextConfig } from "next";

function sourceBuildId(): string {
  for (const value of [
    process.env.GITHUB_SHA,
    process.env.CF_PAGES_COMMIT_SHA,
    process.env.SOURCE_VERSION,
  ]) {
    if (value?.trim()) {
      const normalized = value.trim().replace(/[^a-zA-Z0-9_-]/gu, "-");
      if (normalized) return normalized;
    }
  }
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "chasing-local-build";
  }
}

const buildId = sourceBuildId();

const nextConfig: NextConfig = {
  deploymentId: buildId,
  generateBuildId: async () => buildId,
};

export default nextConfig;
