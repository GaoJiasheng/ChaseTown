import assert from "node:assert/strict";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ART_ROOT = path.join(ROOT, "art-source");

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolute));
    else files.push(absolute);
  }
  return files;
}

test("compact engine-neutral source-art masters remain intact", async () => {
  const files = await walk(ART_ROOT);
  const counts = new Map();
  for (const filename of files) {
    const basename = path.basename(filename).toLowerCase();
    const extension = basename.includes(".") ? basename.split(".").at(-1) : "";
    counts.set(extension, (counts.get(extension) ?? 0) + 1);
  }

  assert.equal(counts.get("fbx"), 39, "29 environment sources and 10 shared rig/animation FBX files must remain");
  assert.equal(counts.get("blend"), 8, "the static and rigged Blender masters for the current characters must remain");
  assert.equal(counts.get("glb") ?? 0, 0, "runtime GLB exports belong only in public/models");
  assert.equal(counts.get("blend1") ?? 0, 0, "Blender backup files must not inflate the repository");
  assert.equal(counts.get("zip") ?? 0, 0, "generated archives must not inflate the repository");
  assert.equal(counts.get("meta") ?? 0, 0, "retired Unity metadata must not remain");

  const required = [
    "_Shared/Animations/Anim_Idle.fbx",
    "_Shared/Animations/Anim_Walk.fbx",
    "_Shared/Animations/Anim_Run.fbx",
    "_Shared/Animations/Anim_TurnLeft.fbx",
    "_Shared/Animations/Anim_TurnRight.fbx",
    "_Shared/Animations/Anim_LookAround.fbx",
    "_Shared/Animations/Anim_PointAlert.fbx",
    "_Shared/Animations/Anim_ScaredCaught.fbx",
    "_Shared/Animations/Anim_Celebrate.fbx",
    "_Shared/Animations/Rig_Humanoid_Shared.fbx",
    "Characters/Kid/ReferenceStandard/PrecisionRemodel_2026_07_13_v21/Kid_PrecisionRemodel_v21.blend",
    "Characters/Kid/ReferenceStandard/PrecisionRemodel_2026_07_13_v21/Rigged/Kid_PrecisionRemodel_v21_Rigged.blend",
    "Characters/Villain/ReferenceStandard/PrecisionRemodel_2026_07_13_v21/Villain_PrecisionRemodel_v21.blend",
    "Characters/Villain/ReferenceStandard/PrecisionRemodel_2026_07_13_v21/Rigged/Villain_PrecisionRemodel_v21_Rigged.blend",
    "Characters/Police/ReferenceStandard/PrecisionRemodel_2026_07_13_v21/Police_PrecisionRemodel_v21.blend",
    "Characters/Police/ReferenceStandard/PrecisionRemodel_2026_07_13_v21/Rigged/Police_PrecisionRemodel_v21_Rigged.blend",
    "Characters/Police/ReferenceStandard/HumanAnatomyRemodel_2026_07_14_v22/Police_HumanAnatomyRemodel_v22.blend",
    "Characters/Police/ReferenceStandard/HumanAnatomyRemodel_2026_07_14_v22/Rigged/Police_HumanAnatomyRemodel_v22_Rigged.blend",
    "Environment/ModularKit/Wall_Straight_2m.fbx",
    "Environment/Props/Prop_PoliceStationFacade.fbx",
    "Environment/SampleMaze/SampleMaze_ArtLayout.fbx",
    "Concepts/01_kid_character_sheet.png",
    "_Source/PBR/PolyHaven/polyhaven_pbr_manifest.json",
  ];

  for (const relative of required) {
    assert.ok((await stat(path.join(ART_ROOT, relative))).isFile(), `${relative} must be retained`);
  }

  assert.ok(!files.some((filename) => filename.includes(`${path.sep}_Rejected${path.sep}`)), "rejected candidates must not ship");
  assert.ok(!files.some((filename) => filename.includes(`${path.sep}Previews${path.sep}`)), "generated previews must not ship");
  assert.ok(!files.some((filename) => filename.includes(`${path.sep}Wireframes${path.sep}`)), "generated wireframes must not ship");
});
