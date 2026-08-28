# Villain Precision Remodel v21 — A2 accepted candidate

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
- Material: one glTF Metallic-Roughness PBR material with embedded 2K WebP
  BaseColor, Normal and ORM textures. AO is the ORM red channel.
- Runtime: 28,939 triangles, one mesh/primitive/material/skin, 1,090,124 bytes,
  nine embedded A1 clips, Meshopt compression, exact 21-joint shared skeleton.
- Transform: +Z forward, feet at Y=0 (0.205 mm tolerance), scene and rig scale 1.
- Build command: `python3 tools/art_pipeline/build_a2_villain_runtime.py --install`.

## Evidence

- Build audit: `Reports/Villain_A2_visual_rework_build_report.json`
- Per-role acceptance report: `Reports/A2_Villain_2026_08_28/A2_Villain_验收报告.md`
- Validator, binary audit, browser QA and screenshots:
  `Reports/A2_Villain_2026_08_28/evidence/`
- Source and license record: `SOURCE_AND_LICENSES.md`

The legacy Unity/FBX wording in the earlier prototype README is superseded by
this Web GLB delivery. Police and kid are outside this commit.
