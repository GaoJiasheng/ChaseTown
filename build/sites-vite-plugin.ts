import { access, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import {
  DEPLOYMENT_SOURCE_ASSET_EXCLUDES,
  FIRST_CAMPAIGN_PRELOAD_ASSETS,
  MAX_DEPLOYED_CLIENT_BYTES,
  RUNTIME_ASSET_MANIFEST_VERSION,
} from "../app/game/runtime-assets";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

// Packages Sites metadata and migrations after Vite finishes compiling.
export function sites(): Plugin {
  let root = process.cwd();

  return {
    name: "sites",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    async closeBundle() {
      const outputDirectory = resolve(root, "dist", ".openai");
      const clientOutputDirectory = resolve(root, "dist", "client");
      const hostingConfig = resolve(root, ".openai", "hosting.json");
      const drizzleSource = resolve(root, "drizzle");

      await rm(outputDirectory, { recursive: true, force: true });
      await mkdir(outputDirectory, { recursive: true });

      if (await exists(hostingConfig)) {
        await cp(hostingConfig, resolve(outputDirectory, "hosting.json"));
      }
      if (await exists(drizzleSource)) {
        await cp(drizzleSource, resolve(outputDirectory, "drizzle"), {
          recursive: true,
        });
      }

      // Vite copies `public/` wholesale. Keep high-resolution source models in
      // the repository for reproducible art builds, but remove them from the
      // production artifact after the client bundle has been emitted.
      for (const relativePath of DEPLOYMENT_SOURCE_ASSET_EXCLUDES) {
        await rm(resolve(clientOutputDirectory, relativePath), {
          recursive: true,
          force: true,
        });
      }
      await writeFile(
        resolve(clientOutputDirectory, "runtime-asset-manifest.json"),
        `${JSON.stringify({
          formatVersion: RUNTIME_ASSET_MANIFEST_VERSION,
          maximumClientBytes: MAX_DEPLOYED_CLIENT_BYTES,
          firstCampaignPreloads: FIRST_CAMPAIGN_PRELOAD_ASSETS,
          sourceAssetsExcludedFromDeployment: DEPLOYMENT_SOURCE_ASSET_EXCLUDES,
        }, null, 2)}\n`,
      );
    },
  };
}
