# A2 villain source and license record

Recorded: 2026-08-28

## Geometry lineage

- Existing project master: `Villain_PrecisionRemodel_v21.blend`.
- Historical geometry generator: Tencent Hunyuan3D-2 multiview workflow,
  represented in this repository by
  `tools/art_pipeline/run_hunyuan_multiview_textured_v18.py` and the checked-in
  Blender master. No Hunyuan service call or external download was made during
  the A2 pass.
- Audited Hunyuan3D-2 terms snapshot (commit
  `f8db63096c8282cb27354314d896feba5ba6ff8a`):
  <https://github.com/Tencent-Hunyuan/Hunyuan3D-2/blob/f8db63096c8282cb27354314d896feba5ba6ff8a/LICENSE>
  and
  <https://github.com/Tencent-Hunyuan/Hunyuan3D-2/blob/f8db63096c8282cb27354314d896feba5ba6ff8a/NOTICE>.
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
- Preserved source atlas SHA-256:
  `1f2257217d72568a1d024d166f083b9c3159e7f54a5eebfffe2239dd6748bf05`.
- Prompt: “Eight-cell flat PBR swatch atlas: shadowed adult skin, black scarf,
  muted brass, worn piping, trench leather, hood canvas, trouser wool, combat
  leather; no labels or objects”.
- Pipeline treatment: deterministic neutral-luma normalization, broad patina,
  and generated BaseColor/Normal/AO/ORM maps; authored UV0 and smooth `A2Tint`
  vertex colors provide semantic garment zoning.

## M1 runtime animation source

The remote product trunk keeps its eight authoritative Villain gameplay clips:
`Alert`, `Catch`, `CheckHide`, `Idle`, `LostSight`, `PatrolWalk`, `Run`, and
`Search`. They are rebuilt from the repository's Quaternius Universal Animation
Library 2.0 Standard source and retargeted to this unchanged 21-joint skeleton.
Quaternius releases the library under CC0 1.0; see
`docs/licenses/QUATERNIUS_UNIVERSAL_ANIMATION_LIBRARY_CC0.md`.

The nine-clip local-polish artifact is only a visual/motion reference. It is not
deployed and does not replace, rename, or remove any product-trunk gameplay
clip. The M1 pass does not alter clip aliases, state-machine timing, controls,
or gameplay decisions.

## Release gate

The fixed Hunyuan terms include territory, distribution, downstream-use,
provider-disclosure, and MAU conditions. The auditable fact record and the
unresolved product/legal decisions are maintained in
`docs/licenses/TENCENT_HUNYUAN3D_2_COMMUNITY_LICENSE.md`. This source record is
not a legal approval for public distribution.
