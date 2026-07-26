import assert from "node:assert/strict";
import test from "node:test";
import { collectQaSourceProvenance } from "../scripts/qa-source-provenance.mjs";

test("visual QA provenance binds evidence to Git state and rejects placeholders", () => {
  const provenance = collectQaSourceProvenance();
  assert.match(provenance.commitSha, /^[0-9a-f]{40}$/u);
  assert.equal(typeof provenance.dirty, "boolean");
  assert.match(provenance.worktreeSha256, /^[0-9a-f]{64}$/u);
  assert.ok(Number.isInteger(provenance.changedEntryCount));
  assert.ok(provenance.changedEntryCount >= 0);

  const previous = process.env.CHASING_QA_COMMIT_SHA;
  process.env.CHASING_QA_COMMIT_SHA = "working-tree-candidate";
  try {
    assert.throws(
      () => collectQaSourceProvenance(),
      /complete 40-character Git SHA/u,
    );
  } finally {
    if (previous === undefined) delete process.env.CHASING_QA_COMMIT_SHA;
    else process.env.CHASING_QA_COMMIT_SHA = previous;
  }
});
