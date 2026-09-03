// Produces a factual inventory of every package reachable from the production
// dependency roots, resolved from the committed lockfile rather than from a
// local node_modules tree.
//
// Reachability is computed by walking the graph from `dependencies` in
// package.json, because npm's `dev` / `devOptional` flags are not sufficient on
// their own: platform-specific optional binaries (for example the libvips
// builds behind `sharp`) carry only `optional: true` even when the sole path to
// them runs through a devDependency.
//
// `public/THIRD_PARTY_NOTICES.txt` carries selected license texts for the
// deployed bundle; this file is the complete dependency list a pre-release
// license review starts from. It records what the lockfile declares — it is not
// a legal conclusion about any package.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPORT = path.join(ROOT, "docs/licenses/PRODUCTION_SBOM.json");

const manifest = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
const lockfile = JSON.parse(await readFile(path.join(ROOT, "package-lock.json"), "utf8"));
const packages = lockfile.packages ?? {};

// npm resolution: from `location`, look for node_modules/<name> at that level,
// then walk up one directory at a time until the tree root.
const resolveFrom = (location, name) => {
  let prefix = location;
  for (;;) {
    const candidate = prefix === "" ? `node_modules/${name}` : `${prefix}/node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (prefix === "") return null;
    const cut = prefix.lastIndexOf("/node_modules/");
    prefix = cut === -1 ? "" : prefix.slice(0, cut);
  }
};

const reachable = new Set();
const queue = Object.keys(manifest.dependencies ?? {}).map((name) => ({ from: "", name }));
const missing = new Set();
while (queue.length > 0) {
  const { from, name } = queue.pop();
  const location = resolveFrom(from, name);
  if (!location) {
    missing.add(name);
    continue;
  }
  if (reachable.has(location)) continue;
  reachable.add(location);
  const info = packages[location];
  // Optional dependencies can ship in a production install; dev dependencies of
  // a transitive package are not installed at all and are excluded.
  for (const dependency of [
    ...Object.keys(info.dependencies ?? {}),
    ...Object.keys(info.optionalDependencies ?? {}),
  ]) {
    queue.push({ from: location, name: dependency });
  }
}

const entries = [...reachable].map((location) => {
  const info = packages[location];
  return {
    name: info.name ?? location.slice(location.lastIndexOf("node_modules/") + "node_modules/".length),
    version: info.version ?? null,
    license: info.license ?? null,
    resolved: info.resolved ?? null,
    integrity: info.integrity ?? null,
    optional: info.optional === true,
    location,
  };
});
entries.sort((a, b) => (a.name === b.name
  ? String(a.version).localeCompare(String(b.version))
  : a.name.localeCompare(b.name)));

const licenseCounts = {};
const undeclared = [];
for (const entry of entries) {
  const key = entry.license ?? "UNDECLARED";
  licenseCounts[key] = (licenseCounts[key] ?? 0) + 1;
  if (!entry.license) undeclared.push(`${entry.name}@${entry.version}`);
}

const report = {
  formatVersion: 2,
  source: "package-lock.json, walked from package.json dependencies",
  note: "Factual lockfile inventory for pre-release license review. Not a legal"
    + " conclusion. Optional entries are included and flagged because whether"
    + " they install depends on the target platform.",
  productionRoots: Object.keys(manifest.dependencies ?? {}).sort(),
  lockfileName: lockfile.name,
  lockfileVersion: lockfile.lockfileVersion,
  packageCount: entries.length,
  unresolvedNames: [...missing].sort(),
  licenseCounts: Object.fromEntries(
    Object.entries(licenseCounts).sort(([a], [b]) => a.localeCompare(b)),
  ),
  undeclaredLicenses: undeclared,
  packages: entries,
};

if (process.argv.includes("--check")) {
  const expected = JSON.parse(await readFile(REPORT, "utf8"));
  assert.deepEqual(report, expected, "production SBOM is stale; run npm run sbom:production");
  process.stdout.write(
    `Production SBOM verified: ${entries.length} packages, `
      + `${Object.keys(licenseCounts).length} distinct license declarations.\n`,
  );
} else {
  await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `Production SBOM written: ${entries.length} packages, `
      + `${Object.keys(licenseCounts).length} distinct license declarations.\n`,
  );
}
