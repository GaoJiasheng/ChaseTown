# MakeHuman 核心美术资产授权与使用记录

> 适用产物：Police v22/v23 制作源，以及 `public/models/characters/police.glb`、`police-bootstrap.glb` 中的人体、皮肤、毛发、眼部与制服衍生内容
> 配套构建：`tools/art_pipeline/apply_character_pbr.py`、Police v22 制作脚本及 M1 Police A2 构建链
> 初始记录：2026-07-22；Police 七项输入审计补录：2026-08-29

## 来源与许可

- 项目：MakeHuman / MPFB core assets
- 官方许可说明：https://static.makehumancommunity.org/about/license.html
- 官方 FAQ：https://static.makehumancommunity.org/makehuman/faq/are_makehuman_files_free.html
- 许可：Creative Commons Zero（CC0）
- 许可正文：https://creativecommons.org/publicdomain/zero/1.0/

MakeHuman 官方许可页明确将 core graphical assets 以 CC0 发布。本记录只覆盖下表明确列出的 MakeHuman / MPFB core asset 字节，不把未列出的用户贡献资产、概念图或其他第三方内容推定为 CC0。角色网格、贴图、服装和附件随后经过本项目重建、重拓扑/蒙皮修复、PBR 绑定与动画烘焙。

## Police 七项许可范围与本机审计输入

下列大小和 SHA-256 均从 2026-08-29 的本机工作副本重新计算。它们固定了本次审计所见字节，但不等于声明根仓库当前的 submodule pin 可以还原全部原始文件。

| 本机路径 | 用途 | SHA-256 | 大小 |
|---|---|---|---:|
| `tools/third_party/makehuman-assets/base/skins/textures/young_lightskinned_male_diffuse2.png` | 皮肤 Base Color 来源 | `03efe1f6b0ae52429649dcefc9dcaef6058032f874a251169cc3e2ed473c3874` | 3,595,270 bytes |
| `tools/third_party/makehuman-assets/base/hair/short01/short01_diffuse.png` | 短发颜色来源 | `f34a0957184e3d1e911ed59245f874f8d4843f61ee44ff49f43edb4be0196949` | 2,354,146 bytes |
| `tools/third_party/makehuman-assets/base/clothes/male_casualsuit03/male_casualsuit03_normal.png` | 制服/长裤法线来源 | `412c4610d3b2ea1cb04aa3c0715e747a7c9f61d865133b7d69f70eaa738cf99b` | 9,610,278 bytes |
| `tools/third_party/makehuman-assets/base/eyebrows/eyebrow001/eyebrow001.png` | 眉毛颜色/形状来源 | `9940f7d0b1b223709a19b05156ba6f6e9e4dbdbced02d7574f4d51d72c58967b` | 89,619 bytes |
| `tools/third_party/makehuman-assets/base/eyelashes/eyelashes01/eyelashes01.png` | 睫毛颜色/形状来源 | `4b69c0fff2648874460e9caf80c31413c444218a5c50afebc425aeaa65484a35` | 91,600 bytes |
| `tools/third_party/makehuman-assets/base/eyes/high-poly/high-poly.obj` | 眼球几何来源 | `da2493215b708a344c33dc72f2a9a5b8fa985dcc5a70ad3b208995cf871da8e1` | 100,882 bytes |
| `tools/third_party/makehuman-assets/base/eyes/materials/brown_eye.png` | 棕色虹膜/眼球颜色来源 | `4659691c7295ad6206c78b003e5fd0e5f91dcd53032fa914a229bb48cabe424b` | 610,817 bytes |

根仓库把 `tools/third_party/makehuman-assets` 记录为 submodule commit `8cf9645b975a98eea056b140df11a1d278da0d10`。审计时，上表前五个路径相对该 submodule pin 为 modified，`high-poly.obj` 与 `brown_eye.png` 为 untracked；pin 本身不能还原全部七项字节。现已把七项输入按原相对路径和原字节归档到 `art-source/_Source/MakeHuman/AuditedInputs/`，由同目录 `manifest.json` 固定原始子模块路径、大小和 SHA-256，并由自动化测试逐项复算。Police 从七项原始输入开始的仓库内可复建证据条件据此关闭。

> **保存警告：** `tools/third_party/makehuman-assets` 的脏工作区含不能从 gitlink 恢复的审计输入。禁止 clean、reset、restore 或 `git submodule update --force`；不得以任何清理操作替代仓库内归档。

## 本地 CC0 条款副本

| 条款副本 | SHA-256 | 大小 |
|---|---|---:|
| `tools/third_party/mpfb2/LICENSE.ASSETS.md` | `f6089cba01cb570a24712b41ab8a586ccd3cc5ef53dc266ca50b95c288956d2c` | 6,962 bytes |
| `tools/third_party/makehuman-assets/LICENSE.txt` | `a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499` | 7,048 bytes |

最终运行 GLB 只应包含经项目修改、压缩、调色和材质组合后的衍生几何/贴图，不包含 MakeHuman 或 MPFB 程序代码与构建缓存。最终 GLB、bootstrap 与报告的动态 SHA 在资产冻结后写入 `docs/19_M1_Police角色视觉移植报告.md`。
