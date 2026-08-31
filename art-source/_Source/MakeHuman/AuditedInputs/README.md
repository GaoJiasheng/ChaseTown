# MakeHuman / MPFB Police audited inputs

This directory preserves the exact seven MakeHuman / MPFB core graphical asset inputs used by the Police source-art chain. Their byte sizes and SHA-256 digests are frozen in `manifest.json` and match `docs/licenses/MAKEHUMAN_CORE_ASSETS_CC0.md`.

## Source and license

- Upstream project: MakeHuman / MPFB core assets
- Archived source worktree: `tools/third_party/makehuman-assets`
- Recorded gitlink: `8cf9645b975a98eea056b140df11a1d278da0d10`
- License for the specifically listed core graphical assets: CC0 1.0
- Project evidence and upstream links: `docs/licenses/MAKEHUMAN_CORE_ASSETS_CC0.md`
- Local license copies: `tools/third_party/makehuman-assets/LICENSE.txt` and `tools/third_party/mpfb2/LICENSE.ASSETS.md`

The archive does not claim that unrelated MakeHuman community assets are CC0, and it does not change the license of project-authored derivatives.

## Critical preservation warning

The `tools/third_party/makehuman-assets` worktree contains modified and untracked audited inputs that are not all recoverable from the recorded gitlink. **Do not clean, reset, restore, or force-update that submodule.** The repository-owned archive in this directory is the reproducible evidence boundary.

The six PNG inputs use the repository's existing Git LFS policy. The single OBJ is 100,882 bytes and remains normal Git text: it is small, reviewable, and does not justify broadening the LFS rule for all OBJ sources.
