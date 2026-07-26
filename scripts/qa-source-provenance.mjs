import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

function git(cwd, args, encoding = "utf8") {
  return execFileSync("git", args, {
    cwd,
    encoding,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function collectQaSourceProvenance(cwd = process.cwd()) {
  const commitSha = git(cwd, ["rev-parse", "HEAD"]).trim();
  const status = git(cwd, ["status", "--porcelain=v1", "-z"]);
  const trackedDiff = git(cwd, ["diff", "--binary", "HEAD", "--"], "buffer");
  const untracked = git(
    cwd,
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ).split("\0").filter(Boolean).sort();
  const fingerprint = createHash("sha256");
  fingerprint.update(commitSha);
  fingerprint.update("\0");
  fingerprint.update(trackedDiff);
  for (const relativePath of untracked) {
    fingerprint.update("\0untracked\0");
    fingerprint.update(relativePath);
    fingerprint.update("\0");
    fingerprint.update(readFileSync(path.resolve(cwd, relativePath)));
  }
  const provenance = Object.freeze({
    commitSha,
    dirty: status.length > 0,
    worktreeSha256: fingerprint.digest("hex"),
    changedEntryCount: status.split("\0").filter(Boolean).length,
  });
  const expectedCommit = process.env.CHASING_QA_COMMIT_SHA;
  const formalQa = process.env.CHASING_QA_FORMAL === "true";
  if (formalQa && expectedCommit === undefined) {
    throw new Error(
      "Formal QA requires CHASING_QA_COMMIT_SHA to bind evidence to a clean commit",
    );
  }
  if (expectedCommit !== undefined) {
    if (!/^[0-9a-f]{40}$/u.test(expectedCommit)) {
      throw new Error("CHASING_QA_COMMIT_SHA must be a complete 40-character Git SHA");
    }
    if (provenance.commitSha !== expectedCommit) {
      throw new Error(
        `QA expected ${expectedCommit} but HEAD is ${provenance.commitSha}`,
      );
    }
    if (provenance.dirty) {
      throw new Error("Commit-bound QA requires a clean worktree");
    }
  }
  return provenance;
}
