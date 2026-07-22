# Quaternius Universal Animation Library 2.0 授权与使用记录

> 适用产物：`public/models/characters/kid.glb`、`villain.glb`、`police.glb` 中经过重定向、重命名和二次调整的骨骼动画
> 配套构建：`tools/art_pipeline/build_web_character_animation_sets.py`
> 记录日期：2026-07-22

## 来源与许可

- 作者：Quaternius
- 素材：Universal Animation Library 2.0，Standard 版本
- 官方页面：https://quaternius.com/packs/universalanimationlibrary2.html
- OpenGameArt 镜像与许可记录：https://opengameart.org/content/universal-animation-library
- 许可：CC0 1.0 Universal（公共领域贡献）
- 许可正文：https://creativecommons.org/publicdomain/zero/1.0/

CC0 不要求署名；本记录仍保留作者、来源、版本与哈希，便于复核和后续重建。项目只将动作作为重定向输入，不分发原始下载包。

## 已核验输入

| 输入 | SHA-256 | 大小 |
|---|---|---:|
| `Universal Animation Library 2.0 · Standard.zip` | `18ff1a7215f4852b320203e8aaf02a1578b5c8eef9027fbaedfcedc7b85a3ac2` | 14,541,205 bytes |
| `AnimationLibrary_Godot_Standard.glb` | `1b7bf67866360665426bb99e4c71bd619f19b408453c24e30f0c3071601eee5c` | 6,671,104 bytes |

下载包和原始动画 GLB 不进入仓库。构建脚本仅允许使用匹配哈希的输入，避免来源或版本静默漂移。

## 本项目的二次制作

原动作不会原样作为最终角色表现。构建流程会完成：

1. 将源骨架动作重定向到项目统一的 21 骨 Web 骨架。
2. 烘焙为角色各自的正式动作集并移除运行时 Root Motion。
3. 为潜行闭环制作 HideEnter、HideIdle、HidePeek、HideExit、Caught、CheckHide 等项目专用剪辑。
4. 调整接地、节奏、身体重心、循环首尾和动作间衔接。
5. 用固定机位多帧接触表复核穿地、滑步、静帧、跳姿和穿模。

最终动作名称、时长和质量门禁记录在 `art-source/_Shared/Animations/Reports/*_web_animation_set.json` 与 `tests/animation-assets.test.mjs`。
