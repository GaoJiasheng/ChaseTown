import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const licenseRecordUrl = new URL(
  "../docs/licenses/TENCENT_HUNYUAN3D_2_COMMUNITY_LICENSE.md",
  import.meta.url,
);
const publicNoticesUrl = new URL("../public/THIRD_PARTY_NOTICES.txt", import.meta.url);
const sourceRecordUrl = new URL(
  "../art-source/Characters/Villain/ReferenceStandard/PrecisionRemodel_2026_07_13_v21/SOURCE_AND_LICENSES.md",
  import.meta.url,
);
const buildReportUrl = new URL(
  "../art-source/Characters/Villain/ReferenceStandard/PrecisionRemodel_2026_07_13_v21/Reports/Villain_A2_visual_rework_build_report.json",
  import.meta.url,
);
const sourceAtlasUrl = new URL(
  "../art-source/Characters/Villain/ReferenceStandard/PrecisionRemodel_2026_07_13_v21/Textures/Char_Villain_A2_MaterialAtlas_Source.png",
  import.meta.url,
);

const [licenseRecordBuffer, publicNoticesBuffer, sourceRecord, buildReportBuffer, sourceAtlas] =
await Promise.all([
  readFile(licenseRecordUrl),
  readFile(publicNoticesUrl),
  readFile(sourceRecordUrl),
  readFile(buildReportUrl),
  readFile(sourceAtlasUrl),
]);
const licenseRecord = licenseRecordBuffer.toString("utf8");
const publicNotices = publicNoticesBuffer.toString("utf8");
const buildReport = JSON.parse(buildReportBuffer.toString("utf8"));

function sha256(payload) {
  return createHash("sha256").update(payload).digest("hex");
}

test("Hunyuan villain provenance pins the audited official sources and historical gap", () => {
  assert.match(licenseRecord, /f8db63096c8282cb27354314d896feba5ba6ff8a/);
  assert.match(licenseRecord, /94259df223918a5733677965c1bfe1774a2dba25042d9c3b47a3418ea6c1f324/);
  assert.match(licenseRecord, /9ef89c88faf6fa97a7cc9ffc15deec7a8c27fb7ac9bca1f57e2884a5f8d48f42/);
  assert.match(licenseRecord, /40b9abf02675534b9e80e3150bd97b85c135c8c8/);
  assert.match(licenseRecord, /revision 缺口/u);
  assert.match(licenseRecord, /SOURCE_AND_LICENSES\.md/);
});

test("Hunyuan notice keeps the mandatory distribution notice and unresolved release gate", () => {
  const mandatoryNotice =
    "Tencent Hunyuan 3D 2.0 is licensed under the Tencent Hunyuan 3D 2.0 Community License Agreement, " +
    "Copyright © 2025 Tencent. All Rights Reserved. The trademark rights of “Tencent Hunyuan” are owned by Tencent or its affiliate.";

  assert.ok(publicNotices.includes(mandatoryNotice));
  assert.match(publicNotices, /PUBLIC RELEASE BLOCKED PENDING PRODUCT LEGAL REVIEW/);
  assert.match(publicNotices, /European Union, United Kingdom, and South Korea/);
  assert.match(publicNotices, /1,000,000-monthly-active-user threshold/);
  assert.match(
    publicNotices.replace(/\s+/g, " "),
    /does not know or invent the publisher's full legal name/,
  );
});

test("Hunyuan record does not misrepresent product legal approval", () => {
  assert.match(licenseRecord, /不代表产品法务已批准公开发行/u);
  assert.match(licenseRecord, /本记录只提供可审查事实，不声称/u);
  assert.doesNotMatch(publicNotices, /legal (?:approval|clearance) (?:is|has been) complete/i);
});

test("Hunyuan provenance hashes bind the reviewed source record, build report, and atlas bytes", () => {
  const expected = {
    sourceRecord: "172d30d4f6e4a3b99f1e77b1a1511c1c00b99da83e4168dd7d507a7d7c66924f",
    buildReport: "809834f2a353203cce7d89eb14ea232d5b041f97bb03203288cfc55da4fd7432",
    sourceAtlas: "1f2257217d72568a1d024d166f083b9c3159e7f54a5eebfffe2239dd6748bf05",
  };

  assert.equal(sha256(sourceRecord), expected.sourceRecord);
  assert.equal(sha256(buildReportBuffer), expected.buildReport);
  assert.equal(sha256(sourceAtlas), expected.sourceAtlas);
  for (const digest of Object.values(expected)) assert.ok(licenseRecord.includes(digest));
  assert.equal(buildReport.textures.sourceAtlasSha256, expected.sourceAtlas);
  assert.ok(sourceRecord.toString("utf8").includes(expected.sourceAtlas));
});
