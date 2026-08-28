# A2 villain source and license record

Recorded: 2026-08-28

## Geometry lineage

- Existing project master: `Villain_PrecisionRemodel_v21.blend`.
- Historical geometry generator: Tencent Hunyuan3D-2 multiview workflow,
  represented in this repository by
  `tools/art_pipeline/run_hunyuan_multiview_textured_v18.py` and the checked-in
  Blender master. No Hunyuan service call or external download was made during
  the A2 pass.
- Official Hunyuan3D-2 terms:
  <https://github.com/Tencent-Hunyuan/Hunyuan3D-2/blob/main/LICENSE> and
  <https://github.com/Tencent-Hunyuan/Hunyuan3D-2/blob/main/NOTICE>.
- Release note: those terms include territory and distribution conditions.
  Before public product distribution, legal/release review must confirm the
  target territories and bundle all required notices. This record is factual,
  not a legal opinion.

## Face cleanup source

- The Hunyuan-integrated face remains the shadowed head volume.
- A cropped 158-vertex / 244-triangle nose-and-mouth relief from the local
  MakeHuman/MPFB source replaces the former detached full-head mask.
- License: CC0 1.0 Universal. Local license text:
  `tools/third_party/mpfb2/LICENSE.ASSETS.md` (duplicate local asset license:
  `tools/third_party/makehuman-assets/LICENSE.txt`).

## Material source

- Tool: OpenAI ImageGen.
- Date: 2026-08-28.
- Reference images: none.
- External downloads in this pass: none.
- Preserved source atlas: `Textures/Char_Villain_A2_MaterialAtlas_Source.png`.
- Prompt: “Eight-cell flat PBR swatch atlas: shadowed adult skin, black scarf,
  muted brass, worn piping, trench leather, hood canvas, trouser wool, combat
  leather; no labels or objects”.
- Pipeline treatment: deterministic neutral-luma normalization, broad patina,
  and generated BaseColor/Normal/AO/ORM maps; authored UV0 and smooth `A2Tint`
  vertex colors provide semantic garment zoning.

## A1 animation source

The runtime GLB embeds the nine already-accepted clips from
`art-source/_Shared/Animations/`. A2 does not alter their source motion,
retargeting, timing or state-machine parameters.
