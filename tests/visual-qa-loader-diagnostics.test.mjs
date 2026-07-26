import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  isThreeLoaderAssetFailure,
  protocolDiagnosticText,
} from "../scripts/qa-protocol-diagnostics.mjs";

const HARNESSES = [
  "stealth-systems-visual-qa.mjs",
  "active-mechanic-qa.mjs",
  "locker-maze-qa.mjs",
  "library-gold-visual-qa.mjs",
  "deep-gameplay-visual-qa.mjs",
];

function consoleMessage(type, ...values) {
  return {
    method: "Runtime.consoleAPICalled",
    params: {
      type,
      args: values.map((value) => ({ type: "string", value })),
    },
  };
}

test("THREE loader asset failures are severe even when emitted as warnings", () => {
  const textureFailure = consoleMessage(
    "warning",
    "THREE.GLTFLoader: Couldn't load texture blob:http://127.0.0.1/missing",
  );
  assert.equal(isThreeLoaderAssetFailure(textureFailure), true);
  assert.match(protocolDiagnosticText(textureFailure), /Couldn't load texture/u);

  assert.equal(
    isThreeLoaderAssetFailure(consoleMessage(
      "warning",
      "THREE.KTX2Loader: failed to decode texture payload",
    )),
    true,
  );
  assert.equal(
    isThreeLoaderAssetFailure({
      method: "Log.entryAdded",
      params: {
        entry: {
          level: "warning",
          text: "THREE.DRACOLoader: decoder failed for model geometry",
        },
      },
    }),
    true,
  );
});

test("ordinary warnings and unrelated load failures remain non-severe", () => {
  assert.equal(
    isThreeLoaderAssetFailure(consoleMessage(
      "warning",
      "THREE.WebGLRenderer: shader compilation completed with fallback precision",
    )),
    false,
  );
  assert.equal(
    isThreeLoaderAssetFailure(consoleMessage(
      "warning",
      "Couldn't load optional analytics beacon",
    )),
    false,
  );
});

test("all five formal visual harnesses enforce THREE loader diagnostics", () => {
  for (const harness of HARNESSES) {
    const source = readFileSync(
      new URL(`../scripts/${harness}`, import.meta.url),
      "utf8",
    );
    assert.match(source, /isThreeLoaderAssetFailure/u, harness);
    assert.match(
      source,
      /THREE loader emitted|three-loader-asset-failure/u,
      harness,
    );
  }
});

test("storage reset happens before navigation instead of aborting a live art load", () => {
  for (const harness of [
    "library-gold-visual-qa.mjs",
    "deep-gameplay-visual-qa.mjs",
  ]) {
    const source = readFileSync(
      new URL(`../scripts/${harness}`, import.meta.url),
      "utf8",
    );
    assert.match(source, /Storage\.clearDataForOrigin/u, harness);
    assert.doesNotMatch(source, /localStorage\.clear\(\)/u, harness);
  }
});
