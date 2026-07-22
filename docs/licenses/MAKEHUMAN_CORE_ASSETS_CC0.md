# MakeHuman 核心美术资产授权与使用记录

> 适用产物：`public/models/characters/police.glb` 的人体基础、皮肤、眼睛与制服基础贴图衍生内容
> 配套构建：`tools/art_pipeline/apply_character_pbr.py` 及 Police v22 制作脚本
> 记录日期：2026-07-22

## 来源与许可

- 项目：MakeHuman / MPFB core assets
- 官方许可说明：https://static.makehumancommunity.org/about/license.html
- 官方 FAQ：https://static.makehumancommunity.org/makehuman/faq/are_makehuman_files_free.html
- 许可：Creative Commons Zero（CC0）
- 许可正文：https://creativecommons.org/publicdomain/zero/1.0/

MakeHuman 官方许可页明确将 core graphical assets 以 CC0 发布。项目没有引入用户贡献仓库中许可不明的第三方资产；角色网格、贴图、服装和附件均经过本项目重建、重拓扑/蒙皮修复、PBR 绑定与动画烘焙。

## 固定输入

构建脚本通过大小与 SHA-256 双重校验，来源发生变化时会直接失败：

| 输入 | 官方固定 URL | SHA-256 | 大小 |
|---|---|---|---:|
| `young_lightskinned_male_diffuse2.png` | `free.downloads.tuxfamily.net/makehuman/assets/1.1/base/skins/textures/…` | `03efe1f6b0ae52429649dcefc9dcaef6058032f874a251169cc3e2ed473c3874` | 3,595,270 bytes |
| `male_casualsuit03_normal.png` | `free.downloads.tuxfamily.net/makehuman/assets/1.1/base/clothes/male_casualsuit03/…` | `412c4610d3b2ea1cb04aa3c0715e747a7c9f61d865133b7d69f70eaa738cf99b` | 9,610,278 bytes |

远端原文件只进入临时构建缓存，不作为冗余源文件提交。最终 GLB 内只嵌入经过压缩、调色和材质组合后的运行时贴图。
