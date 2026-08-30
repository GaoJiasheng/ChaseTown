# M1 Police 角色视觉移植报告

> 日期：2026-08-29
> 工作分支：codex/remote-trunk-port
> 起点：681c282 feat: port villain visual asset to remote trunk
> 交付边界：本报告、Police 资产、Police 展示层接入与对应测试位于同一个 Police 独立提交；Kid、M2、M3 未启动。

## 1. 逐条状态

| 条目 | 状态 | 可复算证据 |
|---|---|---|
| Police 视觉几何与材质返工 | **完成** | 远端 v22 MakeHuman/MPFB 母版经 v23 剪影、制服分区、帽徽、警徽与肩章返工；制作源前后同机位图位于 A2 报告 evidence 目录 |
| 远端五 clip 权威合同 | **完成** | high/bootstrap 均保留 Alert、Idle、Interact、Resolve、Run；每 clip 22 tracks，浏览器双时间点定帧与三次连续播放采样均已固化 |
| Meshopt、KTX2、bootstrap 派生 | **完成** | 两档均为 Meshopt + 7 张内嵌 KTX2；bootstrap 只替换图像载荷，几何、骨骼、动画和非图像传输合同保持一致 |
| 21 关节与蒙皮覆盖 | **完成** | 每个关节名恰好一次；29,394 蒙皮顶点，零权重 0，最多 4 influence，LeftHand 2,143、RightHand 2,122 |
| 朝向、落地与单位尺度 | **完成** | glTF 朝向 +Z、脚底 Y=0、root scale [1,1,1]；未增加运行时补偿 |
| Police 按需加载协议 | **完成** | Kid/Villain 仍为首绘阻塞，Police 仍按近出口/胜利按需加载；production 首屏没有 Police 角色请求 |
| QA 实际响应身份 | **完成** | QA 快照记录实际响应字节、SHA-256、源 glTF 拓扑、运行时 Mesh/Skeleton/Bone 数和 clip；不是按文件名推测 |
| 正式相机桌面与 375px 证据 | **完成** | 桌面同姿态 A/B 为 1280×720；窄屏连续 Resolve A/B 的文件像素为 375×812、DPR 1；另有正常游玩相机 67.726px 尺寸探针 |
| 1/5/10 关与十关可玩回归 | **完成** | QA resolution hook 在 1/5/10 关到达 won、mission complete、exit unlocked；十关完整可玩性由确定性路线回归证明 |
| Resolve 与 reduced-motion | **完成** | 普通胜利为 Resolve/protect；通过暂停菜单启用减少动态后降级为 Idle/idle，随后已恢复偏好 |
| 来源与 notice 事实链 | **完成（事实链）** | MakeHuman/MPFB、Quaternius、实际输入 SHA 和 notice 已补齐；Concept 03 元数据缺口明确保留为发行审核门禁 |
| Kid、M2、M3 | **跳过** | 遵守串行纪律，Police 独立复验收货前不进入后续阶段 |

## 2. 制作路线与视觉取舍

本轮没有直接部署 origin/local-polish-line 的 Police GLB。该资产与远端五 clip、Meshopt/KTX2 图集和 bootstrap 派生合同不同构，直接替换会同时破坏动画和加载协议。最终路线是：

1. 以远端 HumanAnatomyRemodel v22 作为共享骨骼、UV、材质槽和动画合同基底。
2. 在 Blender 5.1.2 / Python 3.13.9 中生成 v23 视觉母版。
3. 经远端 gltfpack Meshopt、PBR 门禁、KTX2 和 bootstrap 管线生成正式运行时 GLB。

正式俯视机位的定量修改如下：

- 上身宽度 1.07×，加强挺拔、稳定的警察剪影。
- 帽冠 1.12×、帽檐 1.14×、帽徽主轴 1.90×。
- 胸徽 1.30×、腰带扣 1.80×，肩章和肩袋同步加强。
- 制服蓝、长裤蓝、皮革、金色徽章与银色金属保持独立材质语义。

这些修改的目标是增强帽形、肩线和材质分区提示；报告不声称 34px 角色高度下可直接阅读细小徽章文字。精细材质证据由制作源同机位图与解码纹理统计承担。

制作源同机位对比：

- art-source/Characters/Police/ReferenceStandard/A2_VisualRework_2026_08_29/Reports/evidence/police_a2_before_topdown.png
- art-source/Characters/Police/ReferenceStandard/A2_VisualRework_2026_08_29/Reports/evidence/police_a2_after_topdown.png
- art-source/Characters/Police/ReferenceStandard/A2_VisualRework_2026_08_29/Reports/evidence/pbr/police_before_factor_only.png
- art-source/Characters/Police/ReferenceStandard/A2_VisualRework_2026_08_29/Reports/evidence/pbr/police_after_pbr.png

A2 v23 输出目录只保留两份母版：

| 母版 | 字节 | SHA-256 |
|---|---:|---|
| Police_A2_VisualRework_v23.blend | 16,920,224 | fefb1a0cff86bf5d09ebdcc729652eae6dca09265a67a8046f584df7b80b4078 |
| Police_A2_VisualRework_v23_Rigged.blend | 14,438,194 | a3bc56875f9dc63fb56f0fee1d51b0b7942dad6282c6f07eecc56bed26c28dc9 |

HumanAnatomyRemodel v22 输入目录单独保留来源与授权记录。2,244,276 B 的 authoring GLB 是可再生产物，回归发现后已删除，不留在 art-source。

## 3. 运行时资产、骨骼与面数

| 资产 | 字节 | SHA-256 | nodes / meshes / primitives | tris | materials / KTX2 | skin / joints |
|---|---:|---|---:|---:|---:|---:|
| M1 前 high | 6,873,868 | 768841bb45da54f12805e5593a5c1876f2eb6600422da821b9899a583efe9fa4 | 60 / 38 / 39 | 40,120 | 14 / 7 | 1 / 21 |
| M1 前 bootstrap | 1,736,768 | a429aee2b409052888ac59e6f808f9ac963a482eafac37d04f4cee6e6126837a | 60 / 38 / 39 | 40,120 | 14 / 7 | 1 / 21 |
| **M1 后 high** | **7,645,844** | c062148256cbb26c51032e524b7f1401ea06ca5432327b267c7c1d2618113cf5 | **47 / 25 / 26** | **50,800** | **14 / 7** | **1 / 21** |
| **M1 后 bootstrap** | **1,926,584** | 28c5babea7d6cc4a13da1fe6b163050b1a3440b93a893dfd67b19fbd936ef0a1 | **47 / 25 / 26** | **50,800** | **14 / 7** | **1 / 21** |

独立解包蒙皮结果（high/bootstrap 一致）：

| 指标 | 实测 |
|---|---:|
| 唯一骨名 | 21 / 21，每名恰好一次 |
| 蒙皮顶点 | 29,394 |
| 零权重顶点 | 0（0.000%） |
| 最多 influence | 4 |
| LeftHand 非零权重顶点 | 2,143 |
| RightHand 非零权重顶点 | 2,122 |

## 4. 纹理门禁与 glTF Validator

纹理统计使用项目同一份 Basis transcoder，把 GLB 内嵌 KTX2 解码为 RGBA8 后计算 population stddev，不读取源 PNG 文件名代替运行时结果。

| 表面 | high | bootstrap | 门禁 |
|---|---:|---:|---:|
| Skin BaseColor overall | 37.5861 | 37.5255 | ≥8 |
| Uniform BaseColor overall | 14.4510 | 14.8415 | ≥8 |
| Trouser BaseColor overall | 10.4265 | 10.0918 | ≥8 |
| Skin Normal R / G | 13.1014 / 13.1899 | 12.9390 / 13.0467 | R/G 各≥4 |
| Suit Normal R / G | 60.5538 / 60.3976 | 59.9027 / 59.7484 | R/G 各≥4 |
| Skin AO(R) | 3.9231 | 3.9682 | ≥3 |
| Uniform AO(R) | 3.9368 | 3.9919 | ≥3 |

完整结果：docs/porting/m1-police/evidence/decoded-texture-quality.json。apply_character_pbr.py 已把这些阈值改成失败即中止的硬门禁。

| 资产 | Error | Warning | Information |
|---|---:|---:|---:|
| high | **0** | 45 | 9 |
| bootstrap | **0** | 45 | 9 |

命令为 @gltf-transform/cli 4.4.1 validate --format csv。warning 在两档一致，来自 KTX2 MIME 枚举、运行时切线、非 root skinned mesh 和扩展图像提示；真实 Three.js Meshopt/KTX2 解码另有浏览器门禁。

## 5. 动画合同与实际浏览器响应

| clip | 时长 | Mixer alias | 产品用途 |
|---|---:|---|---|
| Idle | 2.500000 s | idle | 加载、待机、减少动态胜利降级 |
| Run | 0.933333 s | run | 远端运动合同 |
| Alert | 1.400000 s | alert | 警觉动作 |
| Interact | 2.000000 s | point | 交互与指示 |
| Resolve | 1.233333 s | protect | 胜利解围 |

浏览器直接使用项目 Three.js、MeshoptDecoder、KTX2Loader 与 AnimationMixer：

- high 与 bootstrap 各对五 clip 在 normalized time 0.18 / 0.68 定帧，共 20 张 JPEG 和 20 份状态。
- 两档各对五 clip 真实播放，每 clip 记录三次 playing=true 的推进采样。
- 循环 clip 允许跨循环边界回绕，因此验收依据是连续播放推进，不伪称 normalized time 严格单调。
- 证据记录中的 console error 数均为 0。

QA 实际响应身份：

| 档位 | requested URL | 实际字节 / SHA | 源拓扑 | 运行时拓扑 |
|---|---|---|---|---|
| bootstrap | /models/characters/police-bootstrap.glb?v=4 | 1,926,584 / 28c5babe…ef0a1 | 47 nodes、25 meshes、26 primitives、50,800 tris、14 materials、7 textures、1 skin、21 joints | 26 Mesh、26 SkinnedMesh、1 Skeleton、21 Bone |
| high | /models/characters/police.glb?v=4 | 7,645,844 / c0621482…3cf5 | 同上 | 同上 |

身份数据由实际 fetch 响应的 ArrayBuffer 计算 SHA，并同时交叉检查 parser JSON 与运行时 scene，不依赖仓库文件名。

## 6. bootstrap 忠实度与正式相机证据

### 6.1 bootstrap 对 high

1440×900 真实浏览器配对：silhouette IoU 1.000000，RGB MAE 0.552610，通过 IoU ≥0.9999 / MAE ≤1。对比 PNG 为 328,863 B，SHA-256 为 70275ff3d5f2d24f2d256a26e85d5b289e7fa3c804d09ec6c19bf937d22128ae。

### 6.2 桌面同姿态 A/B

| 机位 | 前资产 | 后资产 | 前 W×H | 后 W×H | 视锥 / 遮挡 | error |
|---|---|---|---:|---:|---|---:|
| L1，1280×720，DPR 1，Idle 68% | a429aee2… / 1,736,768 B | 28c5babe… / 1,926,584 B | 32.409×52.527 px | 33.058×53.076 px | 均 center=true、5/5 clear | 0 / 0 |

两张图使用正式游戏相机、同一 QA 场景和冻结 Idle 68% 姿态。52.527 / 53.076 px 均在桌面 34–58px 目标内。A2 后的帽形、肩线和制服分区提示增强；精细纹理进步由 §2/§4 交叉证明，不夸大远景细节。

### 6.3 真实 375×812 窄屏

正式 A/B 使用实际 375×812 CSS viewport、DPR 1、playing 阶段、同一 L1 场景与冻结 Idle 68% 姿态。qaCleanFrame=1 只用 visibility 隐藏 HUD 遮挡，保留 HUD 所占布局空间、production playfield 尺寸、相机安全区、角色 transform 与后处理；QA 快照同时暴露 qaCleanFrame=true，便于复验它没有切换到 DCC 或独立展示相机。

| A/B | 文件像素 / DPR | Police W×H | center / 可见性 | Idle / 实际身份 | screenshot SHA | error |
|---|---|---:|---|---|---|---:|
| 前 | 375×812 / 1 | 28.804×67.138 px | true；头、躯干、双肩清晰，4/5 射线 | 68%，a429aee2… | 7c755d9b…cb7e | 0 |
| 后 | 375×812 / 1 | 29.807×67.726 px | true；头、躯干、双肩清晰，4/5 射线 | 68%，28c5babe… | 46ec85a3…3aa6 | 0 |

两档都落在触屏 42–68px 目标内；唯一未通过的髋部射线在两档都命中同一类校园墙基，不影响头、躯干与双肩辨识。正式文件为 before/after-level1-police-idle-mobile-normal-camera-375x812.jpg 及对应 state JSON。mobile-normal-play-target-range-probe.json 保留为最终资产的独立尺寸复核。

Police 在产品中是胜利结算角色，因此另保留正式胜利镜头的连续 Resolve 补充证据，并在结算面板出现前抓帧：

| A/B | 文件像素 / DPR | W×H | center / 遮挡 | Resolve normalized time | 实际身份 | error |
|---|---|---:|---|---:|---|---:|
| 前 | 375×812 / 1 | 42.686×102.484 px | true / 5/5 clear | 0.20436，playing | a429aee2… | 0 |
| 后 | 375×812 / 1 | 44.557×103.713 px | true / 5/5 clear | 0.17517，playing | 28c5babe… | 0 |

胜利镜头是有意的近景，约 103px，不拿它冒充 42–68px 正常游玩尺寸门禁。两张 JPEG 的 SHA 分别为 cb9cdcb…394fb 与 502fdc54…fd3d；文件类型已用独立工具确认确为 375×812 JPEG，而不是扩展名伪装。

## 7. 关卡、胜利演出与减少动态

以下是 QA resolution hook 的确定性演出采样，不冒充从出生点手工完整通关：

| 关卡 | phase / mission / exit | Police | 高度 | calls / tris | shadow calls / tris | error |
|---:|---|---|---:|---:|---:|---:|
| 1 | won / complete / unlocked | Resolve、protect、playing | 74.704 px | 321 / 491,590 | 201 / 253,616 | 0 |
| 5 | won / complete / unlocked | Resolve、protect、playing | 78.803 px | 270 / 441,012 | 206 / 289,622 | 0 |
| 10 | won / complete / unlocked | Resolve、protect、playing | 74.608 px | 272 / 519,482 | 219 / 313,710 | 0 |

十关可玩性由全量回归中的以下确定性用例证明：

- 十关最短路径冲刺均会触发追捕并被抓。
- 十关认证躲藏路线均能断视野并抵达出口。
- 十关 HUD 生存引导与 30 个 remix 软锁校验全部通过。

reduced-motion 证据通过正式暂停菜单打开“减少动态”，L1 胜利时 Police 为 Idle/idle，身份仍为 28c5babe…，error 0；采样后已通过菜单恢复 false。

## 8. 加载三口径与首屏协议

| 口径 | M1 Police 前 | 本轮后 | delta | 结论 |
|---|---:|---:|---:|---|
| 仓库 public/models | 46,533,361 B | 47,495,153 B / 83 文件 | +961,792 B | high + bootstrap 的仓库成本 |
| 部署 dist/client/models | 10,921,429 B | 11,111,245 B / 30 文件 | +189,816 B | 只部署 bootstrap，high 被发布剪枝 |
| manifest encoded-transfer | 7,727,510 B | **7,728,906 B** | +1,396 B | 低于 M1 冻结红线 8,309,819 B，余 580,913 B |
| manifest 原始字节和 | — | 8,965,357 B | — | 不与 encoded-transfer 混用 |
| Police 首次按需 bootstrap | 1,736,768 B | 1,926,584 B | +189,816 B | 已压缩，不阻塞首屏 |

8,309,819 B 是本轮冻结对照红线，不是 manifest 产品上限。manifest.maximumCriticalBytes 为 8,388,608 B，最终余 659,702 B。

production 首屏浏览器盘点：

- DOM 声明的唯一资产 26 项：6 script、1 stylesheet、1 image、18 other。
- 最终 clean build 的角色 bundle 为 chasing-game-bRmSn1KR.js；production 截图 132,557 B，SHA-256 1eb1a940…692b1。
- QA 显示 policeLoaded=false、policeLoadedIdentity=null。
- 没有 /models/characters/police* 请求；唯一带 Police 名称的是环境 police-car.glb。
- runtime loader 首屏关键载荷 6,691,805 B、17 请求、10Mbps 估算 6.633444s，fits=true。
- console error 数为 0。

## 9. M3 渲染基线建档

本轮只建档，不在 M1 做渲染优化。QA 会话禁止读取保存的个人 replay，避免个人数据改变证据；运行时仍可能分配不可见 ghost root，因此报告不声称“场景里不存在 ghost 对象”。

同机位条件：1280×720、DPR 1、high、正式 beauty scenario，场景 ready、dressing settled、compiled、transient art prewarmed。

| 关卡 | Police 未加载 calls / tris | shadow calls / tris | memory geo / tex | programs |
|---:|---:|---:|---:|---:|
| 1 | 340 / 620,028 | 187 / 228,415 | 213 / 170 | 84 |
| 5 | 308 / 622,396 | 192 / 264,421 | 194 / 167 | 85 |
| 10 | 362 / 821,604 | 205 / 288,509 | 205 / 156 | 82 |

| 关卡 | Police 已加载 calls / tris | shadow calls / tris | 相对未加载 delta |
|---:|---:|---:|---|
| 1 | 392 / 721,628 | 213 / 279,215 | +52 calls / +101,600 tris；shadow +26 / +50,800 |
| 5 | 360 / 723,996 | 218 / 315,221 | +52 calls / +101,600 tris；shadow +26 / +50,800 |
| 10 | 414 / 923,204 | 231 / 339,309 | +52 calls / +101,600 tris；shadow +26 / +50,800 |

三关增量完全一致，且 loadedIdentity 都是 26 primitives / 50,800 tris 的 28c5babe… 实际响应：主 pass 26 calls / 50,800 tris，加 shadow pass 26 calls / 50,800 tris。这个成本留给 M3 取舍，M1 不通过牺牲 Police 画质来伪造低 draw-call 数。

## 10. 来源、授权与可复建边界

事实链：

- art-source/Characters/Police/ReferenceStandard/HumanAnatomyRemodel_2026_07_14_v22/SOURCE_AND_LICENSES.md
- docs/licenses/MAKEHUMAN_CORE_ASSETS_CC0.md
- docs/licenses/QUATERNIUS_UNIVERSAL_ANIMATION_LIBRARY_CC0.md
- public/THIRD_PARTY_NOTICES.txt

边界结论：

1. 人体、皮肤、头发、眼部与制服基底来自 MakeHuman/MPFB core graphical assets，适用 CC0；七项实际输入都有 path、bytes、SHA。
2. 五段 gameplay clip 来自 Quaternius Universal Animation Library 2.0 Standard，CC0；外部 ZIP 与源 GLB 以字节和 SHA 锁定。
3. 本轮 Police 未使用 Hunyuan，不把 Villain 的 Hunyuan notice 错挂到 Police。
4. MakeHuman 子模块七项实际输入中 5 项相对 pin 为 modified、2 项为 untracked；当前证明的是本机字节身份与 CC0 范围，不伪称干净 clone 能从 pin 还原。本轮未提交这两个脏 submodule。
5. 历史 v29 Blend 不在当前分支、origin/main 或 origin/local-polish-line，不列为可复建输入。
6. Concept 03 只能追溯到初始提交 eafa8221258482f3546100a98b8abe120f34e8ce，作者、生成工具、上游来源和授权未记录。该项保持 PUBLIC RELEASE REVIEW REQUIRED，最终法务结论由产品方确认。

## 11. 回归、修复循环与最终门禁

本轮实际修复循环：

1. 源母版合同最初未包含两份 v23 Blend，补精确白名单，不放宽断言。
2. 回归发现 2,244,276 B 临时 authoring GLB 泄漏到 art-source，删除中间物并增加防回归。
3. 将默认 authoring GLB、动画 candidate 与 PBR 临时路径改为 ephemeral/host-neutral，增加三条来源可复建测试。
4. QA 实际响应统计最初可能受浏览器缓存污染，改为实际 response ArrayBuffer 的字节、SHA、parser JSON 和 runtime scene 双重身份。
5. 首次最终全量回归为 570/571；静态资产审计无法识别模板化 Police bootstrap URL。修复为“裸路径常量 + 单点版本参数”，原断言保留，定向复测 27/27 后全量 571/571。
6. typecheck 发现 QA 快照重复 preferences 字段与 AnimationAction 可空；删除重复字段并对不可达 null 明确 fail-safe，随后 typecheck 通过。
7. 窄屏截图复核发现旧证据虽声称 375px，文件实际为 1280×720；删除错误证据，在单一干净服务上重拍为真实 375×812、DPR 1，并用文件头和像素尺寸复核。
8. 最终独立审计指出胜利近景约 103px 不能代替 42–68px 正常游玩前后实拍；增加保持 production 布局和相机不变的 qaCleanFrame 只读视觉钩子，重拍 67.138 / 67.726px 正常机位 A/B。
9. 最终静态补丁改变了 production bundle identity；执行新的 clean build，并重拍 chasing-game-bRmSn1KR.js 对应的 26 项首屏拓扑与无 Police 请求证据。

| 门禁 | 最终结果 | 输出摘要 |
|---|---|---|
| npm run lint | 通过 | exit 0；仅 Babel 对超大 chasing-game.tsx 的非阻断提示 |
| npm run typecheck | 通过 | exit 0 |
| npm test | **通过** | clean build 5/5；tests 572 / pass 572 / fail 0 / skipped 0；17.823s |
| Police 定向测试 | 通过 | character-bootstrap、m1-police-asset-gate、runtime performance、QA parser：43/43 |
| 缺失 GLB 合同定向复测 | 通过 | model-assets + runtime-performance：27/27 |
| npm run art:character-runtime:check | 通过 | Meshopt 正式资产和冻结报告一致 |
| npm run art:runtime-ktx2:check | 通过 | 7 个 KTX2 runtime 资产与 22 个 shared textures 对齐 |
| build_character_bootstrap --check --role police | 通过 | high/bootstrap 结构、动画、派生报告一致 |
| 浏览器 | 通过 | 两档五 clip、桌面、真实 375px、1/5/10、reduced-motion 与 production 首屏均有状态和截图；证据 error 数 0 |
| git diff --check | 通过 | 提交前最终执行，exit 0 |

## 12. 证据索引

主目录：docs/porting/m1-police/evidence/

1. 资产制作报告位于 art-source/Characters/Police/ReferenceStandard/A2_VisualRework_2026_08_29/Reports/：
   - Police_A2_visual_rework_generated_report.json
   - Police_A2_animation_set_report.json
   - Police_A2_pbr_report.json
2. 纹理与 Validator：
   - decoded-texture-quality.json
   - gltf-validator.json
   - gltf-validator-high.csv
   - gltf-validator-bootstrap.csv
3. 动画：
   - bootstrap-five-clip-browser-matrix.json
   - high-five-clip-browser-matrix.json
   - bootstrap-five-clip-live-playback.json
   - high-five-clip-live-playback.json
   - 20 张 JPEG 定帧和对应状态 JSON
4. bootstrap 对 high：
   - bootstrap-visual-qa-comparison.png
   - art-source/reports/character-bootstrap-visual-qa.json
5. 正式相机：
   - before/after-level1-police-idle-desktop-target-range-1280x720.jpg 与状态
   - before/after-level1-police-idle-mobile-normal-camera-375x812.jpg 与状态
   - before/after-level1-police-resolution-mobile-375x812.jpg 与状态
   - mobile-normal-play-target-range-probe.json
6. 关卡与减少动态：
   - level-1-5-10-resolution-smoke.json
   - level1/5/10-resolution.jpg 与状态
   - reduced-motion-level1-resolution.jpg 与状态
7. 加载：
   - production-size-budget.json
   - production-first-screen-page-assets.json
   - production-first-screen.jpg
8. M3 基线：
   - environment-standard-level-1-5-10.json
   - police-loaded-render-level-1-5-10.json
   - 各关 JPEG 与状态 JSON

## 13. 结论

Police 已在远端权威动画、加载和玩法合同内完成视觉返工。E/Q/C 语义、追捕 FSM、躲藏机制、十关任务和胜负判定均未修改。当前唯一未闭合的发行事项是 Concept 03 的来源授权元数据；这是产品/法务门禁，不被本报告伪装成已批准。

下一步必须等待 Police 独立复验收货后，才能进入 Kid 轮次。
