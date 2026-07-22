# Web 迁移与精简美术资产清单

> 日期：2026-07-15
> 结论：仓库是纯 Web 3D 游戏；Unity 工程已移除。运行画质所需资产全部保留，源美术改为“当前母版”策略。

## 1. 运行资产是硬边界

`public/models/` 是浏览器唯一的 3D 资产入口：

- 26 个运行 GLB：3 个角色、23 个环境模块与道具。
- 22 张被 GLB 实际引用的 BaseColor/Normal 纹理。
- 三个角色均保留 skin/rig；当前运行模型为 Kid / Villain v21 与 Police v22 的验收绑定版。

自动化测试会解析每个 GLB 的 glTF JSON，验证文件头、长度、骨骼和外部纹理；还会要求所有运行 GLB 都被代码引用，并拒绝未引用贴图。`public/` 解除 Git LFS 过滤，部署拿到的是可直接加载的真实文件。

## 2. 源美术保留范围

精简后的 `art-source/` 约 72MB，共保留：

| 类型 | 数量 | 用途 |
|---|---:|---|
| Blender 母版 | 9 | Kid / Villain v21、Police v22 的静态与绑定版；另保留 Police v21 对照版及可编辑 Locker Hero 母版 |
| FBX | 39 | 29 个正式环境源、共享骨骼和 9 套动画 |
| PNG | 23 | 角色必要纹理与 8 张概念图 |
| 来源记录 | 若干 | 第三方许可证、链接与 PolyHaven 清单 |

当前角色的 GLB 运行副本在 `public/models/characters/`；源目录不再重复保存角色 GLB/FBX 导出。Kid / Villain v21 与 Police v22 均以可编辑 Blender 母版保留，Locker Hero 的交互母版位于 `art-source/Environment/Interactive/Locker_Hero.blend`。Police v21 仅作为蒙皮返工对照保留。

## 3. 已精简内容

以下内容不影响现有 Web 运行质量，已从可达 Git 历史中移除：

- 全部 `_Rejected`、失败候选和旧版角色迭代。
- Kid/Villain/Police 的 BlindBox、Photoreal、Stylized 历史路线。
- v21/v22 之外的 ReferenceStandard 版本。
- `.blend1`、ZIP、缓存、下载包和重复 FBX/GLB 导出。
- 环境 2K 重复母版、预览、线框和中间报告；运行使用的 512 纹理仍完整保留。
- `docs/art_production/` 下约 328MB 的生成样本与历史评审产物。
- 26 张从未被任何运行 GLB 引用的 AO/MetallicSmoothness 贴图。

仓库 LFS 从约 11.33GiB 降至约 70–80MiB；精简通过 amend 写回单一根提交，避免“文件删了但历史仍需上传”的假精简。

## 4. 仍可继续制作

- Kid / Villain v21 与 Police v22 的静态及绑定 `.blend` 可直接编辑。
- Police v21 对照母版和 Locker Hero 交互母版继续保留。
- 29 个环境 FBX、共享骨骼和 9 套动画保留。
- 当前运行 GLB/纹理可作为导出对照和回归基线。
- 第三方许可证与来源信息继续保留。

当前正式角色 GLB 已内置经重定向与二次打磨的动作集，并由 Three.js `AnimationMixer` 驱动。后续动画迭代仍必须从 `art-source/_Shared/Animations/` 与角色 Blender 母版重建，经过动作、蒙皮、PBR 和运行态门禁后再替换运行文件。
