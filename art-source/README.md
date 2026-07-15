# Chasing 精简源美术

这里仅保存仍有编辑价值的引擎无关母版。浏览器不会读取本目录；游戏运行时只加载 `public/models/` 中已经验收的 GLB 与外部纹理。

## 保留边界

```text
art-source/
├─ Characters/
│  ├─ Kid/ReferenceStandard/PrecisionRemodel_2026_07_13_v21/
│  ├─ Villain/ReferenceStandard/PrecisionRemodel_2026_07_13_v21/
│  └─ Police/ReferenceStandard/
│     ├─ PrecisionRemodel_2026_07_13_v21/
│     └─ HumanAnatomyRemodel_2026_07_14_v22/
├─ Environment/          29 个正式 FBX
├─ _Shared/Animations/   共用骨骼与 9 套正式动画
├─ Concepts/             8 张定稿/返工概念图
└─ _Source/              许可证、来源链接与 PBR 来源清单
```

角色目录只保留静态与绑定版 `.blend`、必要纹理和质量报告。当前运行 GLB 已逐字节保存在 `public/models/characters/`，不在源目录重复存一份；环境高分辨率贴图也不重复保存，编辑时使用 `public/models/SharedTextures/` 中的实际运行纹理。

## 不进入仓库

- 淘汰方案、失败候选和旧版本迭代。
- `.blend1`、ZIP、缓存、下载包和第三方二进制镜像。
- 重复的 FBX/GLB 导出、预览图、线框图和评审联系表。
- 未被任何运行 GLB 引用的贴图通道。

新增资产时，先在工作目录完成制作和评审；只有成为当前母版或游戏实际依赖后才进入 Git。运行资产仍须通过 `tests/model-assets.test.mjs`，源母版边界由 `tests/art-source.test.mjs` 校验。
