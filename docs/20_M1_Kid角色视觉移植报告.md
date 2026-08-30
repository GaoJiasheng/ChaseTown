# M1 Kid 角色视觉移植报告

> 日期：2026-08-29
> 工作分支：`codex/remote-trunk-port`
> 起点：`049cd7c feat: port police visual asset to remote trunk`
> 交付边界：本报告、Kid 三档资产、Kid 展示层/QA 接入、制作链与门禁测试位于同一个 Kid 独立提交；M2、M3 未启动，也未 push。

## 1. 逐条状态

| 条目 | 状态 | 可独立复算证据 |
|---|---|---|
| Kid 视觉返工 | **完成** | 以 Hunyuan3D 衍生 v21 母版为基底，完成头/肩、背包、鞋部远景剪影与语义材质分区返工；制作源前后同机位证据位于 A2 目录 |
| 三档运行时资产 | **完成** | high/lod1/bootstrap 全部重建；三档均为 21 关节、35 skinned meshes、12 materials、3 KTX2、12 clips |
| 远端 12 clip 权威合同 | **完成** | clip 名无删除、无改名；三档各 12 clip × 2 个时间点，共 72 份浏览器状态与 72 张正式相机截图 |
| Hide 四段完整实机循环 | **完成** | 实际 E 进入、柜内 Idle、真实按住“观察”（与键盘 Q 共用 held-q 输入路径）、E 退出；逐段状态、时间与最终响应 SHA 已固化 |
| Caught / EscapeCelebrate | **完成** | 实际碰撞进入 lost/Caught；真实任务完成路径进入 won/EscapeCelebrate；另验证 reduced-motion 胜利降级 Idle |
| 正式相机桌面/375px A/B | **完成** | 桌面最终 54.172px，触屏最终 67.489px，分别落入 34–58px / 42–68px 合同；均为 qaCleanFrame 正式游戏相机 |
| 首绘阻塞与体积红线 | **完成** | bootstrap 1,573,988→1,561,604 B（-12,384 B）；production encoded-transfer 7,716,893 B，低于冻结红线 8,309,819 B，余 592,926 B |
| 1/5/10 关抽验 | **完成** | 三关均 ready、decorative settled、playing，加载最终 Kid SHA，console 为空 |
| 来源与 notice 事实链 | **完成（事实链）** | 独立 `SOURCE_AND_LICENSES.md`、Hunyuan 固定版本审计与 public notice 已补齐；地域/MAU 条款和 Concept 01 来源缺口继续作为公开发行阻断项，由产品/法务裁决 |
| M2 / M3 | **跳过** | 遵守严格串行，本轮未做资产全量压缩或择优渲染移植 |

## 2. 制作路线与正式机位取舍

本轮没有直接把本地线 GLB 覆盖到远端，也没有改变远端 E/Q/C、加载顺序或 gameplay FSM。最终路线为：

1. 以远端 `PrecisionRemodel_2026_07_13_v21` 的共享骨骼、拓扑、UV 和权重为合同基底。
2. 新建 `build_a2_kid_visual_rework.py`，确定性生成 A2 v22 母版。
3. 头宽 1.065×、头深 1.055×、肩宽 1.045×；背包 1.10×/1.08×/1.06×，鞋带与袜带强调件 1.12×/1.06×/1.08×。最大主体顶点位移 0.0110102m，静止骨架不变。
4. 把既有项目语义顶点色 `Kid_v20_NativeBodyHead.BodyPalette` 确定性烘焙为 2048² BaseColor；不烘焙灯光，不改 UV，不调用外部生成服务。
5. 在导出前移除已烘焙的 authoring vertex-color attribute，修复 Validator 曾报告的 `COLOR_2` 连续性错误；经远端动画、PBR、gltfpack/Meshopt、KTX2、LOD1、bootstrap 完整管线生成正式产物。

本轮把显示高度从 1.52 调整到 **1.12**。它只影响角色展示 transform，不改变碰撞、速度、导航、相机、关卡坐标或动画节奏。实拍表明 1.52 在同机位为桌面 61.003px、触屏 84.001px，均超出合同；1.12 收敛到 54.172px / 67.489px，并保留玩家居中辨识度。

制作源同机位证据：

- `art-source/Characters/Kid/ReferenceStandard/A2_VisualRework_2026_08_29/Reports/evidence/kid_a2_before_topdown.png`
- `art-source/Characters/Kid/ReferenceStandard/A2_VisualRework_2026_08_29/Reports/evidence/kid_a2_after_topdown.png`
- `art-source/Characters/Kid/ReferenceStandard/A2_VisualRework_2026_08_29/Reports/evidence/pbr/kid_before_factor_only.png`
- `art-source/Characters/Kid/ReferenceStandard/A2_VisualRework_2026_08_29/Reports/evidence/pbr/kid_after_pbr.png`

| A2 母版/纹理 | 字节 | SHA-256 |
|---|---:|---|
| `Kid_A2_VisualRework_v22.blend` | 3,854,848 | `c2deeca9…6ccb9` |
| `Rigged/Kid_A2_VisualRework_v22_Rigged.blend` | 3,854,935 | `c7a13d13…92feb` |
| `Char_Kid_A2_Semantic_BaseColor_2K.png` | 1,187,176 | `9fde5298…c8bbc` |

## 3. 三档资产、骨骼与蒙皮

| 资产 | M1 前字节 / SHA | M1 后字节 / SHA | nodes / meshes / primitives | tris | materials / KTX2 | skin / joints |
|---|---|---|---:|---:|---:|---:|
| high | 4,492,164 / `c278b647…d5c6` | **4,471,520 / `5d097ac2…e989`** | 92 / 35 / 35 | 140,276 | 12 / 3 | 1 / 21 |
| lod1 | 2,946,584 / `f803147b…4395` | **2,935,512 / `8676e31f…0d70`** | 92 / 35 / 35 | 92,680 | 12 / 3 | 1 / 21 |
| bootstrap | 1,573,988 / `ebedbd74…0077` | **1,561,604 / `d0a02cc5…f86`** | 92 / 35 / 35 | 92,680 | 12 / 3 | 1 / 21 |

独立母版蒙皮审计：

| 指标 | 实测 |
|---|---:|
| 唯一关节名 | 21 / 21，每名恰好一次 |
| 蒙皮顶点 | 70,676 |
| 零权重顶点 | 0（0.000%） |
| 最多 influence | 4 |
| LeftHand 非零权重顶点 | 3,801 |
| RightHand 非零权重顶点 | 3,999 |
| 非法权重组 | 0 |

三档都保持 +Z 朝向、脚底 Y=0、root scale=1；运行时没有增加朝向、落地或比例补丁。

## 4. 纹理门禁与 glTF Validator

统计使用项目固定 Basis transcoder，把 GLB 内嵌 KTX2 解码成 RGBA8 后计算 population stddev，不拿源 PNG 或材质 factor 冒充运行时结果。

| 表面 | high / lod1 | bootstrap | 硬门禁 |
|---|---:|---:|---:|
| BaseColor overall | 42.4034 | 41.6954 | ≥8 |
| BaseColor R/G/B | 49.8748 / 39.9896 / 36.0949 | 49.0179 / 39.3514 / 35.4868 | 信息 |
| Normal R/G | 5.1553 / 5.1728 | 5.3632 / 5.3750 | 各≥4 |
| ORM AO(R) | 5.4335 | 5.5507 | ≥3 |

完整结果：`docs/porting/m1-kid/evidence/decoded-texture-quality.json`。

| 资产 | Error | Warning | Information |
|---|---:|---:|---:|
| high | **0** | 42 | 5 |
| lod1 | **0** | 77 | 5 |
| bootstrap | **0** | 77 | 5 |

命令为 `@gltf-transform/cli 4.4.1 validate --format csv`。warning 来自 KTX2 MIME 枚举、运行时切线、非 root skinned mesh 和扩展支持提示；曾出现的 severity-0 `COLOR_2` 问题已修复，CSV 位于 `evidence/validator/`。

## 5. 12 clip 合同与浏览器实测

| clip | 时长 | runtime state | 用途 |
|---|---:|---|---|
| Idle | 2.500000s | idle | 待机/减少动态胜利降级 |
| Walk | 1.333333s | walk | 轻步/慢速移动 |
| Run | 0.666667s | run | 跑动 |
| TurnLeft / TurnRight | 各 0.600000s | turnLeft / turnRight | 原地转向 |
| HideEnter | 1.300000s | enterHide | 进柜 |
| HideIdle | 1.666667s | hideIdle | 柜内待机 |
| HidePeek | 1.600000s | peekLeft | 按住观察 |
| HideExit | 1.033333s | exitHide | 出柜 |
| Caught | 1.000000s | caught | 被抓 |
| EscapeCelebrate | 1.233333s | celebrate | 胜利 |
| Interact | 2.000000s | point | 交互 |

浏览器使用项目自己的 Three.js、MeshoptDecoder、KTX2Loader 与 AnimationMixer：

- high、lod1、bootstrap 各对 12 clip 在 normalized time 0.18 / 0.68 定帧，共 **72 个样本、72 张 JPEG、72 份状态**。
- 每个状态都记录实际 fetch 的字节、SHA、源 glTF 拓扑、runtime skeleton/bone/skinned-mesh 数；三份 matrix 中 error 均为 0。
- 定帧 matrix 用于穷举 clip 与三档兼容；连续 gameplay 则由下节的完整 Hide、Caught、胜利链证明，不把定帧证据伪称为连续播放。

证据：`bootstrap-twelve-clip-browser-matrix.json`、`lod1-twelve-clip-browser-matrix.json`、`high-twelve-clip-browser-matrix.json`。

## 6. Hide 四段、被抓、胜利与减少动态

### 6.1 实际完整藏柜循环

| 顺序 | 实际输入/状态 | clip / normalized time | 资产身份 | console |
|---:|---|---|---|---:|
| 1 | E 进入；`entering-hide` | HideEnter / 0.45758 | 1,561,604 B / `d0a02cc5…f86` | 0 |
| 2 | 柜内；`hidden` | HideIdle / 0.67684 | 同上 | 0 |
| 3 | 真实按住触屏“观察”；`peeking` | HidePeek / 0.80715 | 同上 | 0 |
| 4 | E 退出；`exiting-hide` | HideExit / 0.31034 | 同上 | 0 |

触屏“按住观察”与键盘 Q 走同一 held-q 输入路径，不是 QA clip override。索引为 `hide-cycle-index.json`，四步各有 JPEG 和完整 QA 状态。

### 6.2 终局动作

| 场景 | 触发路径 | phase / player mode | Kid | reduced-motion | console |
|---|---|---|---|---|---:|
| 被抓 | 实际近距碰撞 | lost / caught | Caught，0.22960，playing | false | 0 |
| 胜利 | QA resolution 走真实任务完成/胜负路径 | won / escaped | EscapeCelebrate | false | 0 |
| 减少动态胜利 | 暂停菜单开启“减少动态”后走同一胜利路径 | won / escaped | Idle，playing | true | 0 |

普通胜利截图取到演出完成态（normalized 1）；该 clip 的运动中间姿态另由三档 0.18/0.68 matrix 覆盖。减少动态偏好在采样后已通过菜单恢复。

## 7. 正式游戏相机 A/B

`qaCleanFrame=1` 只隐藏 HUD 可见性，保留 HUD 布局空间、playfield 尺寸、相机安全区、actor transform 和后处理。所有截图都来自正式游戏相机，不是 DCC 或角色展示相机。

| 机位 | M1 前 | M1 后 | 合同 | 中心/console |
|---|---:|---:|---:|---|
| 1280×720 桌面 | 31.039×61.003px，bootstrap v2 | **27.588×54.172px，lod1 v3** | 34–58px 高 | center=true / 0 |
| 375×812 触屏 | 42.395×84.001px，bootstrap v2 | **33.899×67.489px，lod1 v3** | 42–68px 高 | center=true / 0 |

这里不拿胜利/被抓近景冒充正常游玩尺寸。前后图分别为 `before/after-level1-kid-idle-{desktop|mobile}-normal-camera-*`。最终同机位可见的头发轮廓、肩线、背包体块与鞋部色块均比旧远景更稳定；细纹理提升由制作源图和 §4 解码统计交叉证明。

bootstrap 对 lod1 的 WebGL2 配对结果：silhouette IoU **1.000000**，RGB MAE **0.440588**，通过 IoU ≥0.9999 / MAE ≤1。对比 PNG 1,998,890 B，SHA-256 `962eea99…c51c`。

## 8. 三关抽验与 M3 渲染建档

本轮只建档，不在 M1 做渲染优化。条件：1280×720、DPR 1、high、正式游戏相机、ready、decorative settled、Kid 最终 bootstrap。

| 关卡 | phase | calls / tris | shadow calls / tris | memory geo / tex | programs | console |
|---:|---|---:|---:|---:|---:|---:|
| 1 校园 | playing | 311 / 526,603 | 187 / 228,409 | 201 / 168 | 76 | 0 |
| 5 医院 | playing | 283 / 461,346 | 192 / 264,415 | 170 / 166 | 75 | 0 |
| 10 工厂 | playing | 316 / 521,294 | 205 / 288,503 | 188 / 155 | 75 | 0 |

总 draw calls 高于本地打磨线的单场景口径，是 M0 已确认的远端主题场景现状；Police 轮已把同量级数字收为 M3 基线。本轮没有通过删环境、关阴影或降角色材质伪造 ≤80，总体优化继续留给 M3。

十关完整玩法由 580 项回归中的十关最短路径被抓、十关认证藏身路线成功、HUD 生存引导与 30 个 remix 软锁合同共同覆盖；本轮浏览器另抽查 1/5/10 三关实际进入。

## 9. 三口径体积与生产首屏

| 口径 | Police 收货基线 | Kid 最终 | delta | 结论 |
|---|---:|---:|---:|---|
| 仓库 `public/models` | 47,495,153 B / 83 | **47,451,053 B / 83** | -44,100 B | 三档总量下降 |
| 部署 `dist/client/models` | 11,111,245 B / 30 | **11,098,861 B / 30** | -12,384 B | 首绘 bootstrap 下降 |
| manifest encoded-transfer | 7,728,906 B | **7,716,893 B** | -12,013 B | 低于冻结红线 8,309,819 B |
| manifest raw asset bytes | 8,965,357 B | **8,954,694 B** | -10,663 B | 不与 encoded 口径混用 |
| 冻结红线余量 | 580,913 B | **592,926 B** | +12,013 B | 未静默放宽 |

clean production 浏览器盘点：

- 1280×720、production server、ready=true、playing、console entries=0。
- 最终首屏实际响应 `/models/characters/kid-bootstrap.glb?v=3`，1,561,604 B，SHA `d0a02cc5…f86`。
- Police 仍为按需角色：`policeLoaded=false`、identity=null；没有 Police 角色声明。`police-car.glb` 是环境物件。
- DOM 去重后 26 项：6 javascript、1 stylesheet、1 image、18 other；19 个首关 preload。
- production Kid 54.540px、center=true、Idle playing；截图 117,116 B，SHA `ba3a72e4…643d`。

完整复算：`production-size-budget.json`、`production-first-screen-page-assets.json`、`production-first-screen.jpg`。

## 10. 来源、授权与可复建边界

事实链：

- `art-source/Characters/Kid/ReferenceStandard/PrecisionRemodel_2026_07_13_v21/SOURCE_AND_LICENSES.md`
- `docs/licenses/TENCENT_HUNYUAN3D_2_COMMUNITY_LICENSE.md`
- `docs/licenses/QUATERNIUS_UNIVERSAL_ANIMATION_LIBRARY_CC0.md`
- `public/THIRD_PARTY_NOTICES.txt`

边界结论：

1. Kid 几何是 Tencent Hunyuan3D-2 Output 的项目内衍生物；本轮没有再次调用服务，也不分发模型权重或代码。
2. Hunyuan 固定审计版本为 `f8db63096c8282cb27354314d896feba5ba6ff8a`。许可把 Territory 定义为不含 EU、UK、South Korea，并含分发、下游使用、提供者披露与 MAU 条件。notice 已写入，**不是产品法务批准**。
3. 12 段 gameplay 动画来自 Quaternius Universal Animation Library 2.0 Standard 的项目重定向/精修，CC0 1.0；源 GLB 6,671,104 B、SHA `1b7bf678…eee5c`。
4. Concept 01 仅为内部视觉参考，仓库缺作者、生成工具、提示词、参考图权利、上游 URL 与授权。状态保持 `PUBLIC RELEASE REVIEW REQUIRED — CONCEPT 01 PROVENANCE UNCONFIRMED`。
5. 本轮建立可审查事实链；公开发行是否满足 Hunyuan 地域/规模/分发条件，最终由产品方与法务确认。

## 11. 回归—修复循环

1. 初版 A2 导出保留 authoring `COLOR_2`，Validator 报 severity-0；在语义 BaseColor 烘焙后移除该属性，三档 Error 归零。
2. 初版角色显示高度 1.22，375px 实测约 73.17px，仍超过 68px；收敛到 1.12 后为 67.489px，同时桌面为 54.172px。
3. QA clip fixture 曾被正常 locomotion 每帧覆盖；增加只在显式 Kid fixture 下生效的只读保护，随后三档 72 样本稳定。
4. reduced-motion 胜利原来仍触发 Celebrate；改为显式 Idle/Celebrate 双分支，并保留远端“胜利立即动作”旧合同。
5. 连续 HidePeek 首次只得到定帧，不符合输入验收；改用真实长按触屏“观察”，最终状态为 `peeking` / HidePeek。
6. 旧 Kid 源母版精确白名单没有 A2 两份 Blend；把它们加入显式必需列表，没有改成宽松目录匹配。
7. 开发服务器经历多轮资产覆盖后可能保留旧响应；清理并用单一干净服务重拍最终 SHA 证据，最后再用 clean production build 独立盘点。

## 12. 最终门禁

| 门禁 | 最终结果 | 输出摘要 |
|---|---|---|
| `npm run lint` | 通过 | exit 0；仅 Babel 对超大 `chasing-game.tsx` 的非阻断提示 |
| `npm run typecheck` | 通过 | exit 0 |
| `npm test` | **通过** | clean build 5/5；tests **580 / pass 580 / fail 0 / skipped 0**；61.365s |
| Kid 定向测试 | 通过 | art-source、runtime performance、Kid asset gate：28/28 |
| Meshopt role check | 通过 | Kid 正式资产与冻结报告一致 |
| KTX2 role check | 通过 | Kid 三档 KTX2 身份与报告一致 |
| LOD1 / bootstrap role check | 通过 | 三档几何、骨骼、动画、派生链一致 |
| glTF Validator | 通过 | 三档 Error=0 |
| 浏览器 | 通过 | 72 clip 样本、Hide 四段、Caught、胜利、reduced-motion、桌面/375px、1/5/10、production 首屏均有真实状态；控制台 0 |
| `git diff --check` | 通过 | exit 0 |

## 13. 证据索引

主目录：`docs/porting/m1-kid/evidence/`

1. 资产与来源：
   - `decoded-texture-quality.json`
   - `gltf-validator.json` 与 `validator/*.csv`
   - `production-size-budget.json`
2. 三档动画：
   - `bootstrap-twelve-clip-browser-matrix.json`
   - `lod1-twelve-clip-browser-matrix.json`
   - `high-twelve-clip-browser-matrix.json`
3. 核心玩法：
   - `hide-cycle-index.json` 与四段 JPEG/JSON
   - `caught-gameplay-desktop-1280x720.*`
   - `victory-gameplay-desktop-1280x720.*`
   - `victory-reduced-motion-desktop-1280x720.*`
4. 正式机位：
   - `before/after-level1-kid-idle-desktop-normal-camera-1280x720.*`
   - `before/after-level1-kid-idle-mobile-normal-camera-375x812.*`
5. 场景与生产：
   - `environment-standard-level-1-5-10.json` 与三关 JPEG/JSON
   - `production-first-screen-page-assets.json`
   - `production-first-screen.jpg`
6. bootstrap 视觉忠实度：
   - `bootstrap-visual-qa-comparison.png`
   - `visualqa-kid-{lod1|bootstrap}-idle-t68.*`
