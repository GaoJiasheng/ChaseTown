# Villain Precision Remodel v21 — A2 accepted candidate

> Provenance note: this directory carries only the necessary source/DCC subset
> from the historical `origin/local-polish-line` A2 candidate. The old candidate
> acceptance report is intentionally not migrated because its 9-clip, ~1.09 MB,
> 72-draw-call conclusions and uncarried LFS evidence are not valid M1 runtime
> proof. The authoritative remote-trunk result is
> `docs/18_M1_Villain角色视觉移植报告.md`.

This directory is the authoring source for the A2 villain visual rework. The
runtime deliverable is `public/models/characters/villain.glb`; no file under
`art-source/` is loaded by the game.

## A2 result

- Source route: reshape and clean the existing Hunyuan3D-derived continuous
  body/garment master in Blender, preserve its UV0 and canonical armature, keep
  the native face recessed under the hood, and retain only a cropped CC0 MPFB
  nose/mouth relief patch.
- Visual changes: broader shoulders/chest/arms, flared long-coat hem, enlarged
  gloves and boot soles, forward/lowered hood, dark eye cavity, and smooth
  vertex-color material zoning for coat/hood/trousers/boots/skin/lining.
- Material: the authoring master keeps one seam-free Metallic-Roughness PBR
  atlas with BaseColor, Normal and packed ORM. The animation build partitions
  that continuous sculpt into 12 real skinned garment pieces backed by six
  actually used semantic materials (coat, hood, face shadow, trousers, boots,
  lining/hardware); AO remains the ORM red channel.
- Runtime architecture: the 134,608-triangle A2 authoring mesh is a DCC source.
  The shipped high is a docs/02-compliant 74,660-triangle realistic LOD0;
  LOD1/bootstrap retain the reviewed 25,599-triangle first-paint silhouette. All variants
  keep one exact 21-joint shared skeleton, Meshopt compression, KTX2 textures
  and the eight product-trunk Villain clips.
- Transform: +Z forward, feet at Y=0 (0.205 mm tolerance), scene and rig scale 1.
- Build route: `build_web_character_animation_sets.py` bakes the eight gameplay
  clips into the A2 master; `optimize_runtime_ktx2.mjs`,
  `build_character_lod1.mjs`, and `build_character_bootstrap.mjs` create the
  remote-trunk high/LOD/bootstrap artifacts with role-scoped report updates.

## Evidence

- Build audit: `Reports/Villain_A2_visual_rework_build_report.json`
- Necessary historical visual source evidence only:
  `Reports/A2_Villain_2026_08_28/evidence/concept02_vs_after_front_side_back.png`
  and `Reports/A2_Villain_2026_08_28/evidence/dcc_before_after_same_camera.png`
- Final runtime validation, binary audit and browser QA: the authoritative
  `docs/18_M1_Villain角色视觉移植报告.md` evidence index.
- Source and license record: `SOURCE_AND_LICENSES.md`

The legacy Unity/FBX wording in the earlier prototype README is superseded by
this Web GLB delivery. Police and kid are outside this commit.
