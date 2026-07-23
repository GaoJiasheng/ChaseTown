import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SOURCE = await readFile(
  new URL("../app/chasing-game.tsx", import.meta.url),
  "utf8",
);

test("scene recovery never navigates or reloads the document", () => {
  assert.equal(SOURCE.includes("location.reload("), false);
  assert.match(
    SOURCE,
    /const handleContextRestored = \(\) => \{\s*requestSceneRecovery\(\);\s*\};/u,
  );
  assert.match(
    SOURCE,
    /onClick=\{retryScene\}>原地重试<\/button>/u,
  );
  assert.match(
    SOURCE,
    /setSceneRevision\(\(revision\) => revision \+ 1\)/u,
  );
});

test("optional dressing failures retain successful assets", () => {
  assert.match(
    SOURCE,
    /const decorationFailures = settledDecorations\.filter/u,
  );
  assert.match(
    SOURCE,
    /keeping successful decorations/u,
  );
  assert.equal(
    /if \(disposed \|\| decorationFailure\)/u.test(SOURCE),
    false,
  );
});

test("non-interactive reflection environment starts only after first playable", () => {
  const readyIndex = SOURCE.indexOf(
    'document.documentElement.dataset.chasingReady = "true";',
  );
  const scheduleIndex = SOURCE.indexOf("scheduleEnvironmentLighting();");
  assert.ok(readyIndex >= 0);
  assert.ok(scheduleIndex > readyIndex);
});
