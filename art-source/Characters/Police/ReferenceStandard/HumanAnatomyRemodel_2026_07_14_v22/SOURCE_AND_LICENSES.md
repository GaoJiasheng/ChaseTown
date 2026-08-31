# M1 Police source and license record

Recorded: 2026-08-29

## Scope and factual boundary

This record applies to the Police character whose retained M1 input masters are
under `HumanAnatomyRemodel_2026_07_14_v22`, whose M1 visual-authoring outputs
are under `A2_VisualRework_2026_08_29`, and whose runtime derivatives are
published as `public/models/characters/police.glb` and
`public/models/characters/police-bootstrap.glb`.

The current Police lineage uses MakeHuman / MPFB core graphical assets and
project-authored remodeling. **No Tencent Hunyuan model, service, generated
geometry, texture, weight, or other Hunyuan output is used by the Police
character in this M1 round.** The Villain's separate Hunyuan notice does not
apply to Police.

This is a provenance record, not a legal opinion. One internal concept reference
has unresolved authorship and license metadata; that release gate is recorded
below without inventing an answer.

## Retained project source boundary

The following files were present and independently hashed at the start of the
M1 Police pass:

| Retained source | SHA-256 | Bytes | Role |
|---|---|---:|---|
| `Police_HumanAnatomyRemodel_v22.blend` | `ecb2b577d7916ce5861526228ea1c296b0742b0119336ea0c297c4bfb6f48b19` | 1,084,972 | Static remodeled Police master |
| `Rigged/Police_HumanAnatomyRemodel_v22_Rigged.blend` | `4470d21ecd2f66cddf8993a69df62a9ece01b908a3f24e81fecaf1817e2d31b5` | 1,078,925 | 21-joint skinned Police master |

These hashes identify the retained M1 inputs, not a promise that a later
authoring pass will keep the files byte-identical. If M1 changes either master,
the final build report must record both the input hash above and the new output
hash.

The older reports name
`art-source/Characters/Police/Photoreal/MPFBRoleRework_2026_07_12_v29/Police_Photoreal_MPFBHuman_v29.blend`
as an early MPFB intermediate. That Blend is **not retained** in the current
branch, `origin/main`, or `origin/local-polish-line`; its bytes and SHA-256 are
therefore unavailable. The repository must not claim that the missing file is a
reproducible source. The auditable retained-source boundary begins with the two
v22 Blends listed above. Historical report entries for untracked FBX/GLB files,
preview folders, and `/private/tmp` candidates are likewise not substitutes for
checked-in source evidence.

## M1 v22 to v23 production chain

The stable structure of the M1 chain is recorded here now; byte counts and
SHA-256 values for stages that can still change must be filled only after the
final Police asset freeze.

| Stage | Canonical path | Evidence status |
|---|---|---|
| Retained static input | `art-source/Characters/Police/ReferenceStandard/HumanAnatomyRemodel_2026_07_14_v22/Police_HumanAnatomyRemodel_v22.blend` | Fixed M1 input: `ecb2b577…f48b19`, 1,084,972 bytes |
| Retained rigged input | `art-source/Characters/Police/ReferenceStandard/HumanAnatomyRemodel_2026_07_14_v22/Rigged/Police_HumanAnatomyRemodel_v22_Rigged.blend` | Fixed M1 input: `4470d21e…2d31b5`, 1,078,925 bytes |
| v23 visual build | `tools/art_pipeline/build_a2_police_visual_rework.py` | 56,241 B; `ef10e171…1257f`; frozen build report records Blender 5.1.2 / Python 3.13.9 |
| v23 static authoring output | `art-source/Characters/Police/ReferenceStandard/A2_VisualRework_2026_08_29/Police_A2_VisualRework_v23.blend` | 16,920,224 B; `fefb1a0c…4078` |
| v23 rigged authoring output | `art-source/Characters/Police/ReferenceStandard/A2_VisualRework_2026_08_29/Rigged/Police_A2_VisualRework_v23_Rigged.blend` | 14,438,194 B; `a3bc5687…8dc9` |
| Visual build report | `art-source/Characters/Police/ReferenceStandard/A2_VisualRework_2026_08_29/Reports/Police_A2_visual_rework_generated_report.json` | 70,560 B; `26b556a4…a0d`; the validation GLB is byte-identified in the report but generated outside `art-source` and removed after a successful default build |
| Animation report | `art-source/Characters/Police/ReferenceStandard/A2_VisualRework_2026_08_29/Reports/Police_A2_animation_set_report.json` | 2,167 B; `b2704576…5558c`; the exact five clips were promoted and independently checked in both runtime variants; the pre-Meshopt candidate is explicitly ephemeral |
| PBR report | `art-source/Characters/Police/ReferenceStandard/A2_VisualRework_2026_08_29/Reports/Police_A2_pbr_report.json` | 8,122 B; `92e73832…588b9`; generated texture stddev gates all pass and transient paths are host-neutral |
| Runtime high | `public/models/characters/police.glb` | 7,645,844 B; `c0621482…13cf5` |
| Runtime bootstrap | `public/models/characters/police-bootstrap.glb` | 1,926,584 B; `28c5babe…f0a1` |
| Bootstrap report | `art-source/reports/character-bootstrap.json` | 23,314 B; `beb80626…d3826`; regenerated from the frozen runtime pair |
| Bootstrap visual QA | `art-source/reports/character-bootstrap-visual-qa.json` | 2,263 B; `62ca4b97…cd328`; screenshot `70275ff3…128ae` |

Temporary `/private/tmp` artifacts and Blender `.blend1` backup files are not
canonical release stages. The rows above are the frozen M1 Police promotion;
the final browser and Validator evidence is indexed from
`docs/19_M1_Police角色视觉移植报告.md`.

## Complete audited input-identity chain

These are the source/reference artifacts byte-identified for this Police
review. The seven MakeHuman / MPFB inputs and two Quaternius inputs have an
independently documented CC0 source. The internal concept is listed to expose,
rather than conceal, its unresolved provenance.

| # | Input | SHA-256 | Bytes | Source / license status |
|---:|---|---|---:|---|
| 1 | `tools/third_party/makehuman-assets/base/skins/textures/young_lightskinned_male_diffuse2.png` | `03efe1f6b0ae52429649dcefc9dcaef6058032f874a251169cc3e2ed473c3874` | 3,595,270 | MakeHuman / MPFB core graphical asset; CC0 1.0 |
| 2 | `tools/third_party/makehuman-assets/base/hair/short01/short01_diffuse.png` | `f34a0957184e3d1e911ed59245f874f8d4843f61ee44ff49f43edb4be0196949` | 2,354,146 | MakeHuman / MPFB core graphical asset; CC0 1.0 |
| 3 | `tools/third_party/makehuman-assets/base/clothes/male_casualsuit03/male_casualsuit03_normal.png` | `412c4610d3b2ea1cb04aa3c0715e747a7c9f61d865133b7d69f70eaa738cf99b` | 9,610,278 | MakeHuman / MPFB core graphical asset; CC0 1.0 |
| 4 | `tools/third_party/makehuman-assets/base/eyebrows/eyebrow001/eyebrow001.png` | `9940f7d0b1b223709a19b05156ba6f6e9e4dbdbced02d7574f4d51d72c58967b` | 89,619 | MakeHuman / MPFB core graphical asset; CC0 1.0 |
| 5 | `tools/third_party/makehuman-assets/base/eyelashes/eyelashes01/eyelashes01.png` | `4b69c0fff2648874460e9caf80c31413c444218a5c50afebc425aeaa65484a35` | 91,600 | MakeHuman / MPFB core graphical asset; CC0 1.0 |
| 6 | `tools/third_party/makehuman-assets/base/eyes/high-poly/high-poly.obj` | `da2493215b708a344c33dc72f2a9a5b8fa985dcc5a70ad3b208995cf871da8e1` | 100,882 | MakeHuman / MPFB core eye geometry; CC0 1.0 |
| 7 | `tools/third_party/makehuman-assets/base/eyes/materials/brown_eye.png` | `4659691c7295ad6206c78b003e5fd0e5f91dcd53032fa914a229bb48cabe424b` | 610,817 | MakeHuman / MPFB core graphical asset; CC0 1.0 |
| 8 | `Universal Animation Library 2.0 · Standard.zip` | `18ff1a7215f4852b320203e8aaf02a1578b5c8eef9027fbaedfcedc7b85a3ac2` | 14,541,205 | Quaternius UAL 2.0 Standard; CC0 1.0; external build input, not distributed |
| 9 | `AnimationLibrary_Godot_Standard.glb` | `1b7bf67866360665426bb99e4c71bd619f19b408453c24e30f0c3071601eee5c` | 6,671,104 | Quaternius UAL 2.0 Standard; CC0 1.0; external retargeting input, not distributed |
| 10 | `art-source/Concepts/03_police_character_sheet.png` | `a551266ed8458d8f256236425d971a4437050b5c8d5a235db4d51dc08dcc6ae2` | 2,275,478 | Internal visual reference; embedded C2PA identifies OpenAI Media Service API / gpt-image 2.0, while author/requestor, prompt, reference inputs, account agreement and license remain unrecorded; product confirmation required |

The seven MakeHuman paths, byte lengths, and hashes describe the audited local
working copy. They do not claim that the root repository's current submodule
pin reproduces all seven bytes: five paths are modified relative to the pin and
two are untracked inside that submodule. See
`docs/licenses/MAKEHUMAN_CORE_ASSETS_CC0.md` for the exact boundary. The
Quaternius archive and source GLB are intentionally not committed; the pipeline
and license record pin their byte identity. The concept image remains in
`art-source/` and is not copied into the public runtime bundle.

## MakeHuman / MPFB core graphical assets

- Project: MakeHuman / MPFB core assets.
- Official MakeHuman license page:
  <https://static.makehumancommunity.org/about/license.html>.
- Official MakeHuman FAQ:
  <https://static.makehumancommunity.org/makehuman/faq/are_makehuman_files_free.html>.
- License applied to the core graphical assets: Creative Commons Zero 1.0
  Universal (CC0 1.0).
- Canonical CC0 legal code:
  <https://creativecommons.org/publicdomain/zero/1.0/legalcode>.
- Local CC0 copies:
  `tools/third_party/mpfb2/LICENSE.ASSETS.md` and
  `tools/third_party/makehuman-assets/LICENSE.txt`.
- Local CC0 copy SHA-256:
  `f6089cba01cb570a24712b41ab8a586ccd3cc5ef53dc266ca50b95c288956d2c`
  and
  `a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499`.
- Project audit note:
  `docs/licenses/MAKEHUMAN_CORE_ASSETS_CC0.md`.

CC0 applies a copyright-and-related-rights waiver to the greatest extent
permitted by law and supplies a public-license fallback where the waiver is not
effective. Its limitations expressly leave trademark and patent rights
untouched, provide the work as-is, and do not clear unrelated third-party rights.
Attribution is not required by CC0; the project retains this voluntary notice
for traceability.

For Police, the documented MakeHuman / MPFB contribution includes the adult
human basis, skin, hair, eyebrows, eyelashes, eye geometry and texture, uniform
basis, and the seven locally audited core-asset inputs above. The project subsequently
rebuilt and adjusted the Police-specific
silhouette, service cap, badges, epaulets, uniform material response, topology,
UVs, 21-joint skinning, and runtime PBR packing. Tool or cache files are not
embedded in the runtime GLBs.

`docs/licenses/POLY_HAVEN_CC0.md` contains a historical/planned Police material
note, but the audited v22 Police pipeline and runtime image set do not establish
that a Poly Haven texture was consumed. This record therefore does **not** claim
Poly Haven as an actual Police input.

## Quaternius gameplay animation source

- Author: Quaternius.
- Asset: Universal Animation Library 2.0, Standard edition.
- Official page:
  <https://quaternius.com/packs/universalanimationlibrary2.html>.
- OpenGameArt mirror and license record:
  <https://opengameart.org/content/universal-animation-library>.
- License: CC0 1.0 Universal.
- Canonical CC0 legal code:
  <https://creativecommons.org/publicdomain/zero/1.0/legalcode>.
- Project audit note:
  `docs/licenses/QUATERNIUS_UNIVERSAL_ANIMATION_LIBRARY_CC0.md`.

The five authoritative Police runtime clips are retargeted to the unchanged
project 21-joint skeleton, stripped of runtime root motion, adjusted for contact
and transitions, and renamed to the product contract:

| Runtime clip | Audited Quaternius source action | Runtime alias / purpose |
|---|---|---|
| `Idle` | `Idle_Loop` | `idle`; loaded/reset guard pose |
| `Run` | `Jog_Fwd_Loop` | `run`; preserved product clip contract |
| `Alert` | `Idle_Torch_Loop` | `alert`; preserved product clip contract |
| `Interact` | `Interact` | `point`; preserved product clip contract |
| `Resolve` | `Punch_Enter` | `protect`; victory resolution performance |

The M1 Police round does not delete, rename, or replace these five clips with
the local-polish nine-clip set. It does not add a Crouch mechanic or alter the
remote product line's controls, FSM, win condition, or load policy.

## Concept 03 unresolved provenance gate

`art-source/Concepts/03_police_character_sheet.png` is a useful internal design
reference and has a fixed repository hash. Its embedded C2PA claim identifies
`OpenAI Media Service API`, `gpt-image 2.0`, and a
`2026-07-11T00:00:00Z` created action. The available repository history still
does not record its author/requesting entity, prompt or reference inputs,
upstream request record, applicable account agreement, commission terms, or
license. The file's presence in Git and its embedded metadata are not evidence
of ownership or permission. The complete eight-image audit is in
`art-source/Concepts/SOURCE_AND_LICENSES.md`.

The only repository-history anchor found for the concept is its presence in
initial commit `eafa8221258482f3546100a98b8abe120f34e8ce` (2026-07-15). That
commit records the file, not its authorship or license.

Before public release, the product owner must confirm and record one of the
following with evidence:

1. project ownership and the author/commission trail;
2. the generating tool/service, applicable output terms, and any reference-image
   rights; or
3. a replacement concept with a complete source and license chain.

Until then, this record must remain marked:
`PUBLIC RELEASE REVIEW REQUIRED — CONCEPT 03 PROVENANCE UNCONFIRMED`.
No CC0 claim is made for Concept 03.

## Rebuild and reporting contract

The Police runtime pipeline is expected to preserve:

1. one shared 21-joint skin with each joint name appearing exactly once;
2. non-zero `LeftHand` and `RightHand` influence coverage and fewer than 2%
   zero-weight vertices;
3. face direction `+Z`, feet at `Y=0`, and unit scale without runtime patches;
4. the five exact gameplay clip names above;
5. Meshopt + KTX2 runtime delivery and the existing Police on-demand loading
   protocol;
6. a regenerated bootstrap derivative and provenance/visual-QA reports.

Final GLB hashes, texture statistics, Validator results, runtime transfer bytes,
and formal-camera screenshots belong in
`docs/19_M1_Police角色视觉移植报告.md` and must be taken from the completed
artifact rather than copied from this source record.
