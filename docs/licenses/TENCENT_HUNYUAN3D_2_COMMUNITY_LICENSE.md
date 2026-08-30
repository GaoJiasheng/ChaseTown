# Tencent Hunyuan3D-2 角色几何来源与发行审查记录

> 适用对象：使用 Kid/Villain Hunyuan 衍生几何的正式、LOD 与 bootstrap 运行资产
>
> 记录日期：2026-08-28
>
> 状态：**来源事实已建档；不代表产品法务已批准公开发行**

## 1. 资产来源链

Villain A2 的连续人体与服装几何来自既有
`Villain_PrecisionRemodel_v21.blend` 母版；Kid 的人体、头发与服装几何
来自 `Kid_PrecisionRemodel_v21.blend` 母版。历史制作脚本
`tools/art_pipeline/run_hunyuan_multiview_textured_v18.py` 通过 Gradio
Client 调用 Hugging Face Space `tencent/Hunyuan3D-2` 的
`/generation_all` 端点，给定的默认参数为 `steps=30`、
`seed=20260713`、`octree_resolution=256`。

A2 轮次没有重新调用 Hunyuan 服务；它在既有母版上完成了
剪影重塑、材质分区、网格化简、蒙皮保持或清理、贴图重制和动画重定向。
最终 M1 运行时产物的 SHA-256 与体积由同批
`character-bootstrap` 报告及 M1 验收报告记录；本文档不用旧 A2
候选哈希冒充重建后的最终哈希。

### 已固定的本地证据

| 证据 | SHA-256 / 大小 | 说明 |
|---|---|---|
| `origin/local-polish-line` 原始 `SOURCE_AND_LICENSES.md` | `ccd9a02a2b20d4973bd06df35df917d9ccaea74157fbbee8bf19fa2dfb03d32b` | 通过精确路径 checkout 保留的 A2 原始记录 |
| M1 适配后 `SOURCE_AND_LICENSES.md` | `172d30d4f6e4a3b99f1e77b1a1511c1c00b99da83e4168dd7d507a7d7c66924f` | 只更新官方固定链接、源 atlas 哈希、远端 8-clip 合同与发行门禁 |
| `tools/art_pipeline/run_hunyuan_multiview_textured_v18.py` | `a9b4007ddc924d7090113cdd0747e0e3a31b94aa349942a6207f7f76561910fa` | 历史生成路由与参数 |
| `Villain_A2_visual_rework_build_report.json` | `809834f2a353203cce7d89eb14ea232d5b041f97bb03203288cfc55da4fd7432` | 从 local-polish 精确取回的历史制作快照，经 M1 补固定条款链接、源 atlas 哈希、输入/工具链记录和历史字段语义；默认生成器改写到独立 generated report，不覆盖此快照 |
| `Char_Villain_A2_MaterialAtlas_Source.png` | `1f2257217d72568a1d024d166f083b9c3159e7f54a5eebfffe2239dd6748bf05` | 本轮保留的 ImageGen 材质源 atlas；与来源记录和 build report 双向绑定 |
| A2 候选 `villain.glb` | `75f42eee49450f5eb4bbd25dbc406ab9f09ac3e6202efffa117b4e66618c711b` / 1,090,124 B | 只是 M1 的几何/视觉来源，不是直接部署件 |

### 生成 revision 缺口

历史脚本没有把远端 Space 或模型 revision 固定到请求中，仓库也没有
保留该次远端生成的 `generation.json` 或原始返回 GLB。2026-08-28
查询到的 Space revision 是
`40b9abf02675534b9e80e3150bd97b85c135c8c8`，但它只能证明查询时的服务
版本，不能被写成历史生成时的已知 revision。本项是显式的可复现性缺口，
本轮不伪造证据补齐。

## 2. 其他组成的来源

| 组成 | 来源与许可 |
|---|---|
| 鼻口 relief | 裁切自本地 MakeHuman/MPFB 来源，CC0 1.0；见 `docs/licenses/MAKEHUMAN_CORE_ASSETS_CC0.md` |
| A2 材质 | 2026-08-28 为本项目生成的 OpenAI ImageGen 输出；未提供参考图，未引入外部下载素材 |
| gameplay 动画 | Quaternius Universal Animation Library 2.0 Standard 经项目重定向和二次制作，CC0 1.0；见 `docs/licenses/QUATERNIUS_UNIVERSAL_ANIMATION_LIBRARY_CC0.md` |
| 远程旧材质（若最终融合） | 只有最终产物实际使用 Poly Haven `fabric_leather_01` 时，才适用 `docs/licenses/POLY_HAVEN_CC0.md`；不得虚报未使用的来源 |

## 3. 固定的官方条款快照

本项目以 Tencent-Hunyuan 官方 GitHub 仓库 commit
`f8db63096c8282cb27354314d896feba5ba6ff8a`（2025-10-28）为本轮审计快照：

| 文件 | 固定 URL | SHA-256 |
|---|---|---|
| LICENSE | <https://github.com/Tencent-Hunyuan/Hunyuan3D-2/blob/f8db63096c8282cb27354314d896feba5ba6ff8a/LICENSE> | `94259df223918a5733677965c1bfe1774a2dba25042d9c3b47a3418ea6c1f324` |
| NOTICE | <https://github.com/Tencent-Hunyuan/Hunyuan3D-2/blob/f8db63096c8282cb27354314d896feba5ba6ff8a/NOTICE> | `9ef89c88faf6fa97a7cc9ffc15deec7a8c27fb7ac9bca1f57e2884a5f8d48f42` |

官方 LICENSE 将 Territory 定义为：

> “worldwide territory, excluding the territory of the European Union, United Kingdom and South Korea”

其第 5(c) 节的分发/展示限制原文摘录为：

> “You must not use, reproduce, modify, distribute, or display ... outside the Territory.”

以下是对固定原文的事实性摘要，不是法律意见：

- 协议的权利授予仅限 Territory，即排除欧盟、英国和韩国。
- 第 5(c) 节明确将 Works、Output 与 results 的使用、复制、修改、分发和
  展示纳入地域限制。因此全球可访问的 Web 发行不能只靠追加署名解决。
- 第 4 节的门槛为 1,000,000 MAU：判定时点是 Hunyuan3D-2 发布日
  2025-01-21，统计对象是 Licensee 提供的全部产品或服务在此前一个
  自然月的 MAU。超过门槛时，协议要求向 Tencent 申请另行授权，在获得
  明确许可前不得行使协议权利。
- 第 3(a) 节要求向相关第三方接收者提供当前协议副本；第 3(b) 节要求
  修改文件携带显著变更说明；第 3(d) 节对非 Hosted Service 分发规定了
  必须随包提供的指定 Notice。指定文本已原样收录在
  `public/THIRD_PARTY_NOTICES.txt`。
- 当前第 3(e) 节还要求面向最终用户披露实际服务提供者的完整法律名称，
  并明确 Tencent 与服务没有关联、赞助或背书关系。
- 第 5(a) 节要求在适用的使用/分发协议中落实用途限制并通知后续用户；
  第 5(b) 节禁止把 Works 或 Output 用于改进其他非 Hunyuan AI 模型。
- 第 6(d) 节说明 Tencent 不主张用户生成 Output 的权利，但这不会自动
  消除第 5(c) 对 Output 的地域限制。
- Output 是否触发第 3 节针对 Works 的全部分发义务，以及完整协议副本
  应以何种方式随 Web 产品提供，属于需要产品法务判断的解释边界。

官方 NOTICE 另行列出 Hunyuan3D-2 运行依赖的第三方组件及其许可。
本 Web 游戏不分发 Hunyuan 权重、模型代码或服务端运行依赖；该 NOTICE
仍作为生成工具的官方来源快照保留。

## 4. 已公开的修改说明

Villain 几何不是未修改的 Hunyuan Output。已记录的处理包括：

1. 在 Blender 中重塑肩胸、上臂、长风衣下摆、手套、鞋底与帽兜。
2. 清理重叠眼眉浮层，用裁切的 MakeHuman/MPFB CC0 鼻口 relief 替换旧的
   脱离头部面罩。
3. 制作项目专用的 BaseColor、Normal、AO/ORM 材质数据。
4. 保留并规范化既有 21 关节统一骨架、清理蒙皮、重定向 gameplay 动画，
   并进行 mesh simplification、Meshopt、KTX2 及 bootstrap 派生。

## 5. 发行前强制产品/法务门禁

以下事项未由本仓库事实链解决，也不能由工程人员猜测：

- [ ] 确认 Licensee 的实际法律主体及其在 2025-01-21 条款时点的 MAU。
- [ ] 确定公开 Web 发行是否排除欧盟、英国和韩国，或已取得 Tencent 另行授权，
  或改用不受该地域限制的几何源。
- [ ] 确定 Web 与可下载包的分发类型，以及第 3 节对 Output/集成终端产品的
  实际适用性。
- [ ] 在用户可见位置披露服务提供者的完整法律名称，并展示无 Tencent
  关联/赞助/背书的声明。
- [ ] 审查需要随包提供的完整当前协议、Notice、修改声明、AUP/后续用户通知
  与产品条款。
- [ ] 确认没有将 Hunyuan Works/Output 用于改进其他非 Hunyuan AI 模型。
- [ ] 对最终 M1 正式、LOD 和 bootstrap GLB 的 SHA-256 与实际组成来源做最终签字。

`public/THIRD_PARTY_NOTICES.txt` 中的门禁文本会明确保持
`PUBLIC RELEASE BLOCKED PENDING PRODUCT LEGAL REVIEW`，直到产品方以真实法律
主体、地域与 MAU 证据完成复核。本记录只提供可审查事实，不声称
法务合规性已经得到确认。
