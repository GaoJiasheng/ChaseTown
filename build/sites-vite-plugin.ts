import { access, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import {
  DEPLOYMENT_SOURCE_ASSET_EXCLUDES,
  FIRST_CAMPAIGN_PRELOAD_ASSETS,
  MAX_DEPLOYED_CLIENT_BYTES,
  RUNTIME_ASSET_MANIFEST_VERSION,
} from "../app/game/runtime-assets";
import {
  assertFirstPlayableBudget,
  createFirstPlayableBudget,
  deduplicateBasisTranscoder,
} from "./release-integrity";

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
    config() {
      return {
        experimental: {
          renderBuiltUrl(filename: string) {
            if (/^(?:assets\/)?basis_transcoder-[^/]+\.(?:js|wasm)$/u.test(filename)) {
              const extension = filename.endsWith(".wasm") ? "wasm" : "js";
              return `/basis/basis_transcoder.${extension}`;
            }
            return undefined;
          },
        },
      };
    },
    configResolved(config) {
      root = config.root;
    },
    async closeBundle() {
      const outputDirectory = resolve(root, "dist", ".openai");
      const clientOutputDirectory = resolve(root, "dist", "client");
      const serverEntry = resolve(root, "dist", "server", "index.js");
      const hostingConfig = resolve(root, ".openai", "hosting.json");
      const drizzleSource = resolve(root, "drizzle");

      await rm(outputDirectory, { recursive: true, force: true });
      await mkdir(outputDirectory, { recursive: true });
      // `closeBundle` runs once for every vinext/Vite environment. On a clean
      // checkout the first environment can finish before the client emitter
      // has created `dist/client`, so every write below must provision its own
      // destination instead of relying on stale output from a prior build.
      await mkdir(clientOutputDirectory, { recursive: true });

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
      // Earlier vinext environments do not have a client bundle yet. Creating
      // the directory above fixes clean builds; release accounting starts only
      // after the Vite client manifest proves the final public assets exist.
      if (!(await exists(resolve(clientOutputDirectory, ".vite", "manifest.json")))) {
        return;
      }

      await deduplicateBasisTranscoder(clientOutputDirectory, serverEntry);
      const firstPlayableBudget = await createFirstPlayableBudget(
        clientOutputDirectory,
        FIRST_CAMPAIGN_PRELOAD_ASSETS,
      );
      assertFirstPlayableBudget(firstPlayableBudget);
      await writeFile(
        resolve(clientOutputDirectory, "runtime-asset-manifest.json"),
        `${JSON.stringify({
          formatVersion: RUNTIME_ASSET_MANIFEST_VERSION,
          releaseIntegrityVersion: 1,
          maximumClientBytes: MAX_DEPLOYED_CLIENT_BYTES,
          firstCampaignPreloads: FIRST_CAMPAIGN_PRELOAD_ASSETS,
          firstPlayableBudget,
          basisTranscoder: {
            canonicalAssets: [
              "/basis/basis_transcoder.js",
              "/basis/basis_transcoder.wasm",
            ],
            duplicateBundlerOutputs: 0,
          },
          sourceAssetsExcludedFromDeployment: DEPLOYMENT_SOURCE_ASSET_EXCLUDES,
        }, null, 2)}\n`,
      );
    },
  };
}
