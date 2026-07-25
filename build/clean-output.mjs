import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const GENERATED_DIRECTORIES = Object.freeze([
  ".vinext",
  ".wrangler",
  "dist",
]);

export async function cleanBuildOutputs() {
  await Promise.all(
    GENERATED_DIRECTORIES.map((directory) => rm(
      path.join(ROOT, directory),
      { recursive: true, force: true },
    )),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await cleanBuildOutputs();
}
