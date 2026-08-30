# M1 Villain 角色视觉移植报告

> 阶段：M1 / Villain（Villain → Police → Kid 串行交付的第一件）
>
> 工作分支：`codex/remote-trunk-port`
>
> 起点：`6dc310e test: stabilize character bootstrap audit`
>
> 报告日期：2026-08-28
>
> 交付提交：本报告与 Villain 资产、管线、运行接入和证据同一提交；以该提交的 Git 元数据为准。

## 0. 结论与边界

Villain 视觉移植已完成。本次没有把本地线的 GLB 直接覆盖到产品线，而是采用
`PrecisionRemodel_2026_07_13_v21` 的魁梧剪影、前压帽兜、暗化面部、外扩长风衣
与语义材质设计，再保留远端产品线的 21 关节骨架、8 个 gameplay clip、
AnimationMixer alias、Meshopt、KTX2、LOD1、bootstrap 和首绘加载合同。

最终资产在正式俯视相机下达到目标尺度：桌面 `56.80 px`，375 px 触屏
`67.53 px`；帽兜、宽肩、长风衣和靴子仍能一眼识别。Police、Kid、M2、M3
未开工，也没有改动关卡、FSM、胜负、隐藏规则或 E/Q/C 键位；本次不新增
Crouch，`C` 仍是远端线既有的抹迹语义。

公开发行仍受强制门禁约束：
`PUBLIC RELEASE BLOCKED PENDING PRODUCT LEGAL REVIEW`。

## 1. 逐项状态

| 项目 | 状态 | 可独立复算证据 |
|---|---|---|
| A2 与远端现网 Villain 择优 | **完成** | §2 的几何/材质取舍、DCC 对比和正式机位 A/B |
| 远端 8 clip 重定向 | **完成** | §4 的精确 clip 名、时长、21 关节通道；真实 Three.js 四动作双帧证据 |
| 远端 Meshopt + KTX2 + LOD/bootstrap | **完成** | §3 三档 SHA/体积/拆包数据；四条管线 `--check` 全绿 |
| 骨骼、蒙皮、朝向、落地、scale | **完成** | §3.2 三档实测；21 关节各出现一次、双手有权重、零权重点 0 |
| 首绘与 Police 按需协议 | **完成** | §6；Kid/Villain 仍阻塞首绘，Police 仍按需加载，仅 Villain URL 版本升至 `v=5` |
| 正式机位桌面 + 375 px | **完成** | §7 同场景、同状态、同相机前后实拍与状态 JSON |
| 1/5/10 关浏览器冒烟 | **完成** | §8；三关均 `playing`、场景完整、纹理有效、console 空 |
| 十关玩法回归 | **完成** | 554 项测试中的十关追捕、藏身逃生、引导可赢性与三十套 Remix 回归全绿 |
| 来源与 notice 可审查链 | **完成** | §10；SOURCE、build report、atlas 三层 SHA 级联和官方条款固定版本测试 |
| 产品法务批准公开发行 | **跳过：职责边界** | 工程只补事实链与 notice；产品方须基于法律主体、地域和 MAU 决策 |
| Police / Kid 视觉移植 | **跳过：串行范围** | Villain 独立复验通过后才进入后续角色提交 |
| M2 / M3 | **跳过：未放行** | §9 只记录 M3 基线，不实施渲染优化；M2 资产压缩不提前施工 |

## 2. 视觉路线与取舍

### 2.1 候选起点

| 候选 | 字节 | 三角面 | 可见分件 / 材质 | 动画合同 |
|---|---:|---:|---:|---|
| M0 远端现网 high | 4,225,956 | 157,148 | 12 / 6 | 远端 8 clip |
| 本地 A2 候选 | 1,090,124 | 28,939 | 1 / 1 | 本地通用 9 clip，仅作来源 |
| M1 最终 high | 3,123,624 | 74,660 | 12 / 6 | 远端 8 clip |

最终采用“**A2 剪影与材质设计 + 远端语义分件与 gameplay 合同**”：

- 几何保留宽肩胸、粗壮手臂、外扩风衣下摆、前压帽兜、放大手套和完整靴底；
- 面部缩入帽檐阴影，去掉旧浮层眼眉与脱离头部的面罩边；
- 12 个真实蒙皮部件对应 6 个 PBR 语义材质：coat、hood、face shadow、
  pants、boots、lining/hardware；不是 12 套重复骨架，也不是基础体拼人；
- 6 个材质共享同一组三贴图 atlas，不把分件代价放大为重复纹理；
- 未采用本地 1 mesh / 1 material 运行产物，因为正式俯视尺度下，帽兜、面部、
  风衣、裤、靴与五金的物理通道分区比单材质更稳定，且保留远端既有语义节点合同。

语义材质参数（roughness / metallic / normal scale）为：coat
`0.92 / 0 / 0.55`、hood `0.98 / 0 / 0.42`、face shadow
`0.76 / 0 / 0.28`、pants `0.96 / 0 / 0.48`、boots
`0.74 / 0.04 / 0.62`、lining/hardware `0.68 / 0.14 / 0.58`。

DCC 证据只证明源资产改造，不替代浏览器验收：

![A2 源资产前后同机位](../art-source/Characters/Villain/ReferenceStandard/PrecisionRemodel_2026_07_13_v21/Reports/A2_Villain_2026_08_28/evidence/dcc_before_after_same_camera.png)

![Concept 02 与 A2 三视图](../art-source/Characters/Villain/ReferenceStandard/PrecisionRemodel_2026_07_13_v21/Reports/A2_Villain_2026_08_28/evidence/concept02_vs_after_front_side_back.png)

## 3. 运行资产与硬门禁

### 3.1 最终三档

| 运行档 | 字节 | SHA-256 | 三角面 | primitive / 材质 | 贴图 | 动画 |
|---|---:|---|---:|---:|---|---:|
| `villain.glb` | 3,123,624 | `8ff6d59a…e2e7fd` | 74,660 | 12 / 6 | 3×768² UASTC KTX2 | 8 |
| `villain-lod1.glb` | 1,526,192 | `66cccb2e…901352` | 25,599 | 12 / 6 | 与 high 同组三图 | 8 |
| `villain-bootstrap.glb` | 891,784 | `2193dc83…14855a` | 25,599 | 12 / 6 | Base 768² ETC1S；Normal/ORM 384² UASTC | 8 |

完整 SHA：

- high：`8ff6d59ab894a9b60d428e7d9a04f39ade20a69543b5a1ef9f0b2c98efb2e7fd`
- LOD1：`66cccb2e32d0e771a7eef73a113ca8dd773d92563c665c983feba6dfae901352`
- bootstrap：`2193dc833f9b2ebd1864ea0b5af225e2947180e109572e15d8a589f49514855a`

LOD1 相对 high 减少 `51.140%`；bootstrap 相对 LOD1 再减少 `41.568%`。
全角色 LOD 汇总节省率为 `41.270%`。high 从 M0 的 4,225,956 B 降至
3,123,624 B，但远端当前架构仍让 bootstrap 常驻，不声称已实现 high 自动晋升。

### 3.2 骨骼、蒙皮与坐标

| 运行档 | 关节 | 加权顶点 | 零权重点 | LeftHand 非零顶点 | RightHand 非零顶点 |
|---|---:|---:|---:|---:|---:|
| high | 21 | 50,463 | 0（0%） | 5,330 | 4,947 |
| LOD1 | 21 | 20,711 | 0（0%） | 2,252 | 2,097 |
| bootstrap | 21 | 20,711 | 0（0%） | 2,252 | 2,097 |

三档中 21 个骨名均恰好出现一次，层级与顺序一致；12 个部件共享唯一 skin。
角色面朝 `+Z`、脚底 `Y=0`、scene root / joints / named semantic wrappers
均为 unit scale。量化 LOD/bootstrap 有 12 个无名 dequantization mesh child，
因此 raw node count 为 46；34 个命名节点与 21 关节合同没有复制或漂移。

### 3.3 贴图数值与压缩后复核

| 贴图 | 作者源 stddev | `docs/04` 下限 | high/LOD 解码 | bootstrap 解码 |
|---|---:|---:|---|---|
| BaseColor | 8.7153 | ≥8.0 | stddev 8.1659；PSNR 45.8593 dB；max Δ 7 | stddev 8.2913；PSNR 37.3274 dB；max Δ 18 |
| Normal | 59.9071 | ≥4.0 | R/G stddev 2.3688/1.5023；PSNR 44.1991 dB；max Δ 11 | R/G 2.2409/1.4151；PSNR 45.3186 dB；max Δ 8 |
| AO | 4.1495 | ≥3.0 | ORM.R 3.9342；PSNR 47.2563 dB；max Δ 8 | ORM.R 3.9439；PSNR 48.8593 dB；max Δ 5 |
| ORM | 96.7135 | 记录项 | 三通道打包有效 | 三通道打包有效 |

Normal 的整体 stddev 受法线蓝通道主导，所以运行时另锁定有信息量的 R/G
下限 `2.20 / 1.35`；bootstrap 仍通过。真实链路为：作者 PNG → native
gltfpack WebP q10 / 768 → Sharp 解码临时 PNG → KTX2；这是两个有损阶段，
报告没有把它误写成单次无损转换。兼容字段仍保留 `Sharp 0.35.0` 文案，
实际加载版本已单列为 `0.35.2`。

### 3.4 glTF Validator

固定工具：`gltf-validator 2.0.0-dev.3.10`。

| 运行档 | Error | Warning | Info | Validator vertices / triangles |
|---|---:|---:|---:|---:|
| high | 0 | 18 | 5 | 50,463 / 74,660 |
| LOD1 | 0 | 30 | 5 | 20,711 / 25,599 |
| bootstrap | 0 | 30 | 5 | 20,711 / 25,599 |

high 的 Warning 为 `VALUE_NOT_IN_LIST ×3`、`NODE_SKINNED_MESH_NON_ROOT ×12`、
`IMAGE_UNRECOGNIZED_FORMAT ×3`；Info 为不识别 Meshopt/KTX2 扩展与未使用
fallback 对象。量化两档多出 `NODE_SKINNED_MESH_LOCAL_TRANSFORMS ×12`，对应
gltfpack 在命名 wrapper 下生成的 dequant child。真实 Three.js 浏览器播放中，
同一动画帧的最大骨骼差只有 `0.00000342°`，证明该变换不是蒙皮错位。
原始结果见 `docs/porting/m1-villain/evidence/gltf-validator.json`。

## 4. 远端 gameplay 动画合同

本批保留且只部署以下 8 个 Villain clip，每个 clip 覆盖 21 个 animated joint
channel；没有空 clip、程序摆臂或名称代偿。

| clip | 时长（s） | 用途 |
|---|---:|---|
| `Idle` | 2.5000 | 待机 |
| `PatrolWalk` | 1.4667 | 巡逻 |
| `Run` | 0.8667 | 追捕 |
| `Alert` | 0.6000 | 警觉 |
| `LostSight` | 1.7667 | 丢失视野过渡 |
| `Search` | 1.4333 | 搜索巡视 |
| `CheckHide` | 2.2667 | 检查藏身点 |
| `Catch` | 1.2000 | 抓捕 |

真实浏览器以 normalized time `18%` 和 `68%` 同步采样 LOD1 / bootstrap：

| clip | 同帧 silhouette IoU | 同帧最大骨骼差 | 两帧间最大动作变化 |
|---|---:|---:|---:|
| `PatrolWalk` | 1.00000 / 1.00000 | `0.00000342°` | `44.24°`，RightLowerLeg |
| `Search` | 1.00000 / 1.00000 | `0.00000242°` | `4.01°`，LeftLowerLeg |
| `CheckHide` | 1.00000 / 1.00000 | `0.00000242°` | `13.69°`，RightLowerArm |
| `Catch` | 1.00000 / 1.00000 | `0.00000296°` | `64.07°`，RightLowerArm |

这同时证明量化首绘档与参考档同帧姿态一致、四个动作本身不是静帧。
完整数值与截图 SHA 在
`docs/porting/m1-villain/evidence/villain-gameplay-clips-browser.json`。

![Patrol 与 Search 双帧](porting/m1-villain/evidence/villain-gameplay-clips-browser-top-1440x900.png)

![CheckHide 与 Catch 双帧](porting/m1-villain/evidence/villain-gameplay-clips-browser-bottom-1440x900.png)

## 5. Bootstrap 真实浏览器视觉回归

回归页使用实际 Three.js 0.185.0、MeshoptDecoder、KTX2Loader 与本地 Basis
transcoder，在同一 Idle 时刻、相机、灯光和曝光下比较参考档与 bootstrap：

| 角色 | 参考档 | silhouette IoU | RGB MAE | 门禁 |
|---|---|---:|---:|---|
| Kid | LOD1 | 1.00000 | 0.4413 | 通过 |
| Villain | LOD1 | 1.00000 | 0.6144 | 通过 |
| Police | Original | 1.00000 | 0.5676 | 通过 |

门禁为 IoU ≥ `0.9999`、MAE ≤ `1`；浏览器 warn/error 为 `[]`。
截图文件保留历史 `.png` 名称，但浏览器接口返回的是 JPEG byte stream；报告记录
真实字节和 SHA，不伪报编码。机器结果见
`art-source/reports/character-bootstrap-visual-qa.json`。

![Bootstrap 真实浏览器回归](porting/m1-villain/evidence/character-bootstrap-comparison-1440x900.png)

## 6. 加载协议与三口径体积

- Kid/Villain bootstrap 仍是首绘 blocker；Police 没有进入首屏，仍在靠近出口或
  胜利时按需预取。
- `app/game/runtime-assets.ts` 只把 Villain 版本参数从 `v=1` 升为 `v=5`，避免
  旧 CDN/browser cache；没有改变加载拓扑。
- 远端当前没有 bootstrap → high 自动晋升，本报告不把“保留 high”写成“已运行 high”。

| 口径 | M0 基线 | M1 Villain | 变化 |
|---|---:|---:|---:|
| 仓库 `public/models` | 49,263,221 B | 46,533,361 B | -2,729,860 B |
| 部署 `dist/client/models` | 11,504,185 B | 10,921,429 B | -582,756 B |
| production 首屏 encoded-transfer | 8,309,819 B | 7,727,510 B | -582,309 B |

production 首屏红线未放宽；当前剩余 `661,098 B`。manifest 中 Villain threat
条目为 `891,784 B / 2193dc83…14855a`。浏览器 QA 的运行资产分类口径为
第 1 关 `6,691,805 B`，它不包含 production manifest 的完整 HTML/JS/CSS/WASM，
因此两者分别记录、不可混算。

## 7. 正式游戏相机前后对比

正式 A/B 固定第 1 关、high 档、`playing + spawn-delay + Idle`，前后相机参数
完全一致。桌面目标区间 34–58 px，触屏目标区间 42–68 px。

| 视口 | M0 前：宽×高 | M1 后：宽×高 | 可见性 |
|---|---:|---:|---|
| 1280×720 | 28.78×55.93 px | 30.50×56.80 px | 居中；头/躯干清晰；采样 1.0 |
| 375×812 | 28.14×66.73 px | 30.29×67.53 px | 居中；采样 1.0 |

桌面宽度提升 `5.96%`，移动宽度提升 `7.63%`；高度保持在门禁上限内。正式
俯视距离仍能读出帽兜、暗面、肩宽和长风衣，而不是靠放大特写制造改善。

| M0 桌面 | M1 桌面 |
|---|---|
| ![M0 桌面](porting/m1-villain/evidence/before-level1-stable-idle-desktop-1280x720.png) | ![M1 桌面](porting/m1-villain/evidence/after-level1-stable-idle-desktop-1280x720.png) |

| M0 375 px | M1 375 px |
|---|---|
| ![M0 手机](porting/m1-villain/evidence/before-level1-stable-idle-mobile-375x812.png) | ![M1 手机](porting/m1-villain/evidence/after-level1-stable-idle-mobile-375x812.png) |

两份 after 状态都直接绑定最终 bootstrap SHA、字节、clip、相机、渲染统计与
`consoleWarnError=[]`；不使用旧资产截图代替最终证据。

## 8. 1 / 5 / 10 关浏览器冒烟

使用正式游戏相机、1512×982、`qaQuality=high`，等待装饰资产 settled、场景
compile=1、预热=1、`unused=[]` 后采样。三关均进入 `phase=playing`，Villain
处于 `Idle`，追捕者保持 `spawn-delay`。这是 1/5/10 抽查，不冒充十关逐关手工通关。

| 关卡 | ID / 主题 | blocker | obscurer | calls / triangles | shadow tris | 首屏运行资产口径 | console |
|---|---|---:|---:|---:|---:|---:|---|
| 1 | `school-maze-v1` / campus | 7/7 | 1/1 | 324 / 587,714 | 228,415 | 6,691,805 B | `[]` |
| 5 | `hospital-isolation-basement` / hospital | 0/0 | 8/8 | 305 / 609,920 | 264,421 | 5,939,725 B | `[]` |
| 10 | `factory-foundry-final-run` / factory | 0/0 | 10/10 | 354 / 802,008 | 288,509 | 6,192,177 B | `[]` |

三关 `invalidSceneTextures=[]`，没有 404、场景缺件或未收敛加载项。

![第 1 关冒烟](porting/m1-villain/evidence/smoke-level1-1512x982.png)

![第 5 关冒烟](porting/m1-villain/evidence/smoke-level5-1512x982.png)

![第 10 关冒烟](porting/m1-villain/evidence/smoke-level10-1512x982.png)

原始状态、相机、渲染、预算和截图 SHA 位于
`docs/porting/m1-villain/evidence/environment-render-samples.json`。

## 9. M3 渲染基线建档

本节只为后续 M3 建档，不在 Villain 提交里擅自改渲染风格或降画质。按
`scripts/environment-art-qa.mjs` 的正式相机/高质量/settled 规则读取：

| 关卡 | calls | triangles | shadow tris / calls | geometries | textures | programs |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 324 | 587,714 | 228,415 / 187 | 213 | 170 | 84 |
| 5 | 305 | 609,920 | 264,421 / 192 | 194 | 167 | 85 |
| 10 | 354 | 802,008 | 288,509 / 205 | 205 | 156 | 82 |

这些是完整场景总数，不是 Villain 单角色 draw call。M3 后续需按自己的审计
口径分类归因，本批不以角色改造为理由偷偷裁剪环境、阴影或材质。

## 10. 来源、授权与发行门禁

### 10.1 可追溯事实链

| 组成 | 来源 | 固定证据 |
|---|---|---|
| 人体/服装几何 | 既有 Hunyuan3D-2 multiview 派生母版；本轮未重新调用服务 | A2 `SOURCE_AND_LICENSES.md` 与源 Blend SHA |
| 鼻口 relief | MakeHuman/MPFB 裁剪，CC0 1.0 | `docs/licenses/MAKEHUMAN_CORE_ASSETS_CC0.md` |
| 材质 atlas | 2026-08-28 项目内 OpenAI ImageGen；无参考图或外部下载 | 源 atlas SHA `1f225721…bf05` |
| gameplay 动画 | Quaternius UAL 2.0 Standard 重定向，CC0 1.0 | motion SHA `1b7bf678…eee5c` |
| Hunyuan 条款 | 官方仓库固定 commit `f8db63096c8282cb27354314d896feba5ba6ff8a` | LICENSE/NOTICE SHA 与条款摘录 |

SHA 级联：适配后 `SOURCE_AND_LICENSES.md`
`172d30d4f6e4a3b99f1e77b1a1511c1c00b99da83e4168dd7d507a7d7c66924f`；
历史 A2 build report
`809834f2a353203cce7d89eb14ea232d5b041f97bb03203288cfc55da4fd7432`；
源 atlas
`1f2257217d72568a1d024d166f083b9c3159e7f54a5eebfffe2239dd6748bf05`。
测试会重新读取三个文件并计算 SHA，不只匹配文案。

源 Blend 为 5,199,209 B / `dcc7f81c…a2eb05`；rigged Blend 为
9,781,552 B / `3afac037…73764`。工具链记录为 Blender 5.1.2、Python
3.13.9、NumPy 2.3.4。

### 10.2 法务状态

固定条款记录了 Territory 对欧盟、英国、韩国的排除，以及分发/展示、下游
使用、服务提供者披露与 1,000,000 MAU 条件。历史 Hunyuan 服务调用未固定
当时远端 revision，仓库也没有原始 generation JSON；当前可查询 revision
不能倒填成历史事实，该缺口已显式保留。

本批只把来源、修改、固定条款和 notice 补到可审查状态，不作法律意见，不
声称产品获得公开发行批准。产品方在签字前必须保留：
`PUBLIC RELEASE BLOCKED PENDING PRODUCT LEGAL REVIEW`。

## 11. 可复现管线与测试

### 11.1 资产管线

本机审计二进制：`gltfpack 1.2`，SHA-256
`037336fafa46f342fe118ce8d17877fecb3deb1cd6dd8f62ee2a95bfaf2b79df`；
外部二进制未提交仓库。本次复核的绝对路径与命令：

```sh
export GLTFPACK_NATIVE=/private/tmp/gltfpack-macos-v1.2/gltfpack
shasum -a 256 "$GLTFPACK_NATIVE"
node tools/art_pipeline/optimize_character_runtime.mjs --check --role villain
node tools/art_pipeline/optimize_runtime_ktx2.mjs --check --only-character villain
node tools/art_pipeline/build_character_lod1.mjs --check --role villain
node tools/art_pipeline/build_character_bootstrap.mjs --check --role villain
```

四条检查均 exit 0。role-scoped check 现在会从代码常量和实际二进制重建策略、
工具、总量与 role 条目；伪造 aggregate/policy 会失败。非默认 output 也必须显式
指定非默认 report，不能污染 canonical report。新增 10 项篡改/输出隔离测试全绿。

### 11.2 项目门禁

| 检查 | 结果 | 真实摘要 |
|---|---|---|
| `npm run lint` | **通过** | exit 0；ESLint 无 error |
| `npm run build` | **通过** | exit 0；5 个构建阶段完成；仅保留既有 >500 kB chunk 提示 |
| `npm test` | **通过** | tests 554；pass 554；fail 0；duration 32,230 ms |
| 既有回归 | **通过** | 原 529 项未删除、未弱化；新增 25 项，合计 554 |
| 浏览器 | **通过** | 正式桌面、375 px、动画页、1/5/10 的 warn/error 均 `[]` |
| `git diff --check` | **通过** | 无 whitespace error |

新增测试分布：Villain 资产门禁 7、管线篡改/隔离 10、Hunyuan 来源 4、
只读 QA 场景参数 4。测试直接拆 GLB、解 Meshopt、读取 KTX2、统计骨骼权重、
核 clip 与 manifest，不以报告中的布尔字段代替事实。

## 12. 独立复验索引

1. 源制作报告：
   `art-source/Characters/Villain/ReferenceStandard/PrecisionRemodel_2026_07_13_v21/Reports/Villain_A2_visual_rework_build_report.json`。
2. 动画与最终运行映射：
   `art-source/_Shared/Animations/Reports/villain_web_animation_set.json`。
3. Meshopt / KTX2 / LOD / bootstrap：
   `docs/art_production/reports/character-runtime-meshopt.json`、
   `docs/art_production/reports/runtime-ktx2.json`、
   `art-source/reports/character-lod1.json`、
   `art-source/reports/character-bootstrap.json`。
4. 浏览器像素回归：
   `art-source/reports/character-bootstrap-visual-qa.json`。
5. 正式机位、动画、Validator、1/5/10 原始证据：
   `docs/porting/m1-villain/evidence/`。
6. 来源与条款：A2 `SOURCE_AND_LICENSES.md`、
   `docs/licenses/TENCENT_HUNYUAN3D_2_COMMUNITY_LICENSE.md`、
   `public/THIRD_PARTY_NOTICES.txt`。

建议独立复验顺序：先跑 `npm test`，再以本报告完整 SHA 拆包三档 GLB，最后
按 §7/§8 URL 重拍浏览器证据。Villain 通过独立复验前，不进入 Police。
