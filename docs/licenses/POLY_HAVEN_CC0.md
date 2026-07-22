# Poly Haven PBR 素材授权与来源记录

> 适用产物：角色与学校环境 GLB 中经过裁切、调色、通道合并、降采样或烘焙的 PBR 贴图衍生内容
> 本地来源清单：`art-source/_Source/PBR/PolyHaven/polyhaven_pbr_manifest.json`
> 记录日期：2026-07-22

## 来源与许可

- 来源项目：Poly Haven
- 素材总页：https://polyhaven.com/textures
- 许可：CC0 1.0 Universal（公共领域贡献）
- 许可正文：https://creativecommons.org/publicdomain/zero/1.0/

CC0 不要求署名；本项目仍保留素材名称、用途、原始页面、下载时大小和哈希，便于来源审计与可复现重建。精简后的仓库不再保存原始 2K / 4K JPG，只保留清单和最终 GLB 中的优化衍生贴图。

## 清单完整性

当前来源清单的 SHA-256 为：

`cd56ea18f9b2a54d9d491146d6acc2071ac3e797a7f2d817e9ce5472add606e0`

清单记录 11 套素材、56 个原始贴图文件。下表哈希均为清单记录的 MD5；`BaseColor / Normal / AO / Roughness` 的排列顺序固定为 `BC / N / AO / R`。清单中的 56 项 `md5_matched` 均为 `true`，表示下载进入制作缓存时与固定预期值一致。

## 素材与固定输入哈希

| 素材与用途 | 原始页面 | 分辨率 | `BC / N / AO / R` MD5 |
|---|---|---:|---|
| `denim_fabric` — Kid 连帽衫、短裤、背包和鞋面 | https://polyhaven.com/a/denim_fabric | 2K | `5d84c58b94a3094ea1edff88f4ed39d0` / `147f1a6f1eaa07d54b79377141ef7b33` / `597060b1217de5bfafb3dca07c92f4dd` / `b857cc1a739a05e02f402ed587fc362f` |
| 同上 | 同上 | 4K | `ad33865a62ad6ed7254fdd5a78268590` / `7a12dcf035f7aa7a3edaa1a54f9adbca` / `2f7865e94820f1fe66b814ec0b8b0b17` / `2f1af425227f2ac0ce83f47cb4e9aec5` |
| `fabric_leather_01` — Villain 外套、兜帽和手套 | https://polyhaven.com/a/fabric_leather_01 | 2K | `f9c0c71ebadf92071d5779257c12d73a` / `cd8a6ea40e5e732e30e8d004ea62ffba` / `4008c692fcf41c73d1013bfac37474cb` / `6166d7bbd6a96f99a3bc528cfa518506` |
| 同上 | 同上 | 4K | `efc17589fc24476ef033e5063a54d4cb` / `ecc34cc12eec85f2c5850e09328fdf18` / `8710d6d580d362183166462c1576b501` / `f0cc8bff978ab30b680b91333b49f72d` |
| `denim_fabric_03` — Police 深蓝制服 | https://polyhaven.com/a/denim_fabric_03 | 2K | `45a8f73b7995fa723cce650f31295a67` / `f32834732639950888f0f09042c82c6f` / `0f8214608e0f044946b7dcc01219a011` / `aee684c5d8c277762c9b77b5eb4812e0` |
| 同上 | 同上 | 4K | `04942e6b30ba9f045058fcf45a7a87af` / `e9b5879dc79057453312d49cda41fa74` / `f5a0642fc4957cd31cad18c8326af6ef` / `47a4bf1351c85e2200a62cd1af63436c` |
| `painted_plaster_wall` — 学校涂装墙体 | https://polyhaven.com/a/painted_plaster_wall | 2K | `32f4f4e5ded7d20e55e337004d0d9691` / `18faf9f7949aefdb3ae7cef7195cba04` / `b911e43133db837371f58983f5270586` / `7cdd5fbbe56f7becb757fc5b52d11d28` |
| `blue_floor_tiles_01` — 学校走廊地砖 | https://polyhaven.com/a/blue_floor_tiles_01 | 2K | `c506188b16d64ed1e8f9c5df8d1f886d` / `8bb939ee461f3c4e6b6cef8928a3d106` / `c40b4bd2f731ae4f72484ff852fc56f3` / `a9a68aec1925baadcaa1de67299a24da` |
| `wood_floor_worn` — 教室旧木地板 | https://polyhaven.com/a/wood_floor_worn | 2K | `980427517934e2e6441da8915b0b2283` / `e45c1601f170ea0eb4cd9bb10240899f` / `95b4c6251382d57c67c3d7dafbe8d5cb` / `089661983973885fd8df6dca05953ff4` |
| `rubberized_track` — 操场橡胶地面 | https://polyhaven.com/a/rubberized_track | 2K | `5c0c0fe12441db5a1a52147f95d793f9` / `c1f2b1e3d1fbbcb69a898fce59a1d3d7` / `5860c8d7ea80f50b8c6d7db30a57ea85` / `f9ec3178827180f55739612271ca128f` |
| `leafy_grass` — 校园室外草地 | https://polyhaven.com/a/leafy_grass | 2K | `8014f4dace676a62ed71b3dd76119dae` / `ea5e91abe01dc5e5d7028c68c3bc9194` / `f25065162a26693b29a10587582df688` / `b5c551ed91162aab5afbfb03b73ae3f5` |
| `blue_metal_plate` — 门、储物柜和警局道具的蓝色金属 | https://polyhaven.com/a/blue_metal_plate | 2K | `6189f7c443f0b7767d3e046f021b5495` / `c460b1b25b5d418218982d8b100822b8` / `3c496e1431121f0e4b48f94af9da332a` / `4be6436df5c7c5ecce9febb927051d52` |
| `brown_planks_07` — 教室门、长椅和木饰条 | https://polyhaven.com/a/brown_planks_07 | 2K | `a60f13d0ab893db98285891ac8dd39a6` / `e05e14aa473b77e06056acbb75bf5d95` / `99067efad9edb378393078e64a57ad3d` / `9a7d9cbaed4ca9c8e833ef8eff84d277` |
| `metal_plate` — 通用旧金属细节 | https://polyhaven.com/a/metal_plate | 2K | `91b841e7e619e55588f0183a703fb644` / `797c3f3de91da0c03f44f493576e158e` / `00a18906f3bebaa10813d3d0e2356047` / `b2c2bfc0a5e46c1a8bdfddd236daa200` |

## 使用边界

这些素材只作为 PBR 制作输入。正式 Web 运行文件内嵌的是按角色 UV 或环境模块重新处理后的 BaseColor、Normal、AO 与 Metallic-Roughness 数据，不应把清单中的哈希误当成最终 GLB 内嵌图像哈希。需要重建时必须重新取得与清单大小和 MD5 一致的原始文件；任一项不一致都应停止构建并重新审计来源。
