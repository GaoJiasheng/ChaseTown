# A2 villain 角色视觉返工验收报告

日期：2026-08-28

状态：**完成，提交独立复验**

范围：仅 villain；police 与 kid 未施工，也未混入本 diff。

最终运行时资产：`public/models/characters/villain.glb`

最终 SHA-256：`75f42eee49450f5eb4bbd25dbc406ab9f09ac3e6202efffa117b4e66618c711b`

## 1. 制作路线与可见改动

本次没有重走 RoleHuman、基础体拼装或“换色即返工”的路线。以现有
Hunyuan3D 多视图连续人体/服装母版为几何源，在 Blender 母版内完成：

1. 肩、胸、上臂加宽，长风衣下摆外扩，手套与源模型鞋底重新塑形；
2. 兜帽整体前探，帽冠降低并软化，帽口做两次局部平滑；
3. 原生面部后退 38 mm，眼区再压暗 18%，形成概念图要求的帽檐阴影；
4. 删除旧的十个眼/眉重叠浮层，仅保留裁切后的 CC0 MPFB 鼻口 relief
   （158 vertices / 244 tris），消除脱离头部的面具边；
5. 保留作者 UV0，用 `A2Tint` 平滑顶点色区分风衣、兜帽、裤、靴/手套、
   皮肤、内衬；一个 PBR 材质承担 Web 合批，不用三角形硬边 atlas；
6. 高模母版 134,608 tris，经 silhouette-aware meshoptimizer 化简为
   28,939 tris，再压缩并嵌回 A1 九段动画。

几何最大位移为 0.061539 m，宽高比变为 0.490544；这是剪影、帽兜、
面部结构和服装体块的实质返工，不是单纯调色。

制作与来源记录见 `../../SOURCE_AND_LICENSES.md`。本批未新增外部下载。
Hunyuan3D-2 的官方条款含地域与分发条件；公开发行前仍需做法务/发行地域
核对并随包提供所需 notice，此处不作法律结论。

## 2. 概念与前后对比证据

- 概念图 + 最终正/侧/背：
  `evidence/concept02_vs_after_front_side_back.png`
- 返工前后同相机、同灯光、同背景、同裁切 2×2 对比：
  `evidence/dcc_before_after_same_camera.png`
- 最终 DCC：`evidence/dcc_after_front.png`、
  `evidence/dcc_after_threequarter.png`、`evidence/dcc_after_side.png`、
  `evidence/dcc_after_back.png`、`evidence/dcc_after_wireframe.png`

肉眼差异：旧版正脸裸露且比例偏瘦；新版面部稳定落入帽兜阴影，肩胸、
手臂、下摆与靴形成更魁梧的倒梯形质量，风衣翻领/兜帽/内搭/裤/靴可分辨，
与 kid 的体型反差明显。侧面 DCC 近景的帽兜投影处仍可见一小片横向
切线/投影 banding；正式游戏投影不足 1 px，桌面/窄屏实拍均不可辨，未
形成闪烁或轮廓破损，因此如实登记，但没有用可能破坏兜帽轮廓的二次强
平滑去掩盖它。

## 3. 贴图质量门禁

源图质量门禁按 `docs/04 §1.1` 的实际脚本复算：

| 纹理 | 源 PNG stddev | 门槛 | 结果 |
|---|---:|---:|---|
| BaseColor 2K | 8.7153（脚本显示 8.72） | ≥8.0 | 通过 |
| Normal 2K | 59.9071（脚本显示 59.91） | ≥4.0 | 通过 |
| AO 2K | 4.1495（脚本显示 4.15） | ≥3.0 | 通过 |
| ORM 2K | 96.7135 | 记录项 | 通过 |

最终 GLB 内嵌 WebP 复算：

| 通道 | 分辨率 | 字节 | stddev | SHA-256 前缀 |
|---|---:|---:|---:|---|
| BaseColor | 2048² | 472,318 | 8.6955 | `deecc505e684` |
| Normal | 2048² | 137,624 | 59.8796 | `a6957e9ec33a` |
| ORM | 2048² | 69,964 | 96.6848；AO(R)=3.9025 | `2d99acd485c1` |

GLB 材质槽实际包含 BaseColor、Normal、Occlusion、MetallicRoughness；
AO 与 MR 共享 ORM，材质实际消费 `COLOR_0`。纹理不是纯色，也未出现旧版
衣服分区的三角锯齿硬边。原始 atlas 与 prompt 均已保留，便于复做。

## 4. 运行时几何、材质与体积

| 项 | 实测 | 预算/要求 | 结果 |
|---|---:|---:|---|
| triangles | 28,939 | 20k–32k | 通过 |
| runtime vertices | 21,135 | 记录项 | 通过 |
| mesh / primitive | 1 / 1 | 合批不可回退 | 通过 |
| material / skin | 1 / 1 | 主材质 ≤2 | 通过 |
| villain GLB | 1,090,124 B（1.04 MiB） | ≤2.5 MB | 通过 |
| `public/models` | 8,671,715 B（8.27 MiB） | ≤12 MB | 通过 |
| GLB 前→后 | 1,885,276 → 1,090,124 B | 不增大 | 减少 42.2% |

## 5. 三条历史事故硬检查

### 5.1 共享骨骼唯一性

- skin：1；Three.js `Skeleton` 实例：1；
- joint：21；标准名称与父子层级完全一致；
- `Hips` 至 `RightToes` 每个骨骼名在 GLB node table 中恰好出现 1 次；
- 所有可见 mesh 都是 `SkinnedMesh`，没有按网格复制骨架。

### 5.2 蒙皮覆盖与双手

- 运行时顶点：21,135；零权重顶点：0；比例：0.0000%（要求 <2%）；
- 最大权重和误差：`2.220446049250313e-16`；最多 4 influences；
- LeftHand 非零权重顶点：2,260；RightHand：2,145；
- 高模 authoring 数据另为 67,308 vertices、双手 7,059 / 6,611；最终验收
  以上述运行时 GLB 数字为准，未把高模数字冒充运行时结果。

### 5.3 朝向、脚底与缩放

- scene scale=`[1,1,1]`；rig scale=`[1,1,1]`；
- 动态 rest bounds 最低 Y=`0.0002050043 m`，距 Y=0 仅 0.205 mm；
- 左右 `Toes.z - Foot.z` 均为 `+0.113583 m`，确认面朝 +Z；
- 没有在运行时代码写 scale、旋转或离地补丁。展示层唯一改动是 villain
  资产 cache suffix，防旧 GLB 命中浏览器缓存。

完整机器可读数据：`evidence/runtime_asset_audit.json`。

## 6. glTF Validator 与 Three.js 加载

固定、带 integrity 校验的 `gltf-validator@2.0.0-dev.3.10` 对最终 SHA 运行：

- Error=0；Warning=1；Info=1；Hint=0；
- Warning `NODE_SKINNED_MESH_NON_ROOT` `/nodes/21`：唯一可见 skinned mesh
  位于无 TRS 的 canonical `Rig_Humanoid_Shared` 根节点下；项目 GLTFLoader、
  九 clip、P4 合批和关节阴影测试均验证该层级；
- Info `UNSUPPORTED_EXTENSION`：官方 Validator 不解码
  `EXT_meshopt_compression`；项目 `MeshoptDecoder` 单测与浏览器实载补足；
- 浏览器 `detailsLoaded=18/18`、degraded texture=0、控制台 error=0、
  warning=0，未观察到 404。

原始 Validator：`evidence/gltf_validator_runtime.json`；浏览器记录：
`evidence/browser_smoke.json`。

## 7. A1 九段动画在新模型上的实际播放

项目浏览器 `?qa=1&qaActor=villain&qaClip=<clip>` 实拍；每段两帧，截图请求
间隔 220 ms。截图本身有编码开销，所以 QA clip time 的差值可大于 220 ms；
Run 在 0.633333 s 处正常循环，B 帧回绕不是倒放。

| Clip | A→B clip time (s) | B 帧 current/active | 权重 | 结果 |
|---|---:|---|---:|---|
| Idle | 0.4122→0.7622 | Idle / Idle | 1.0 | 播放 |
| Walk | 0.5968→0.9701 | Walk / Walk | 1.0 | 播放 |
| Run | 0.2661→0.0528 | Run / Run（循环回绕） | 1.0 | 播放 |
| TurnLeft | 0.6537→0.7667 | TurnLeft / TurnLeft | 1.0 | 播放并 clamp |
| TurnRight | 0.6528→0.7667 | TurnRight / TurnRight | 1.0 | 播放并 clamp |
| LookAround | 0.6192→1.0427 | LookAround / LookAround | 1.0 | 播放 |
| ScaredCaught | 0.5969→1.0360 | ScaredCaught / ScaredCaught | 1.0 | 播放 |
| Celebrate | 0.5586→0.9328 | Celebrate / Celebrate | 1.0 | 播放 |
| PointAlert | 0.5391→0.9625 | PointAlert / PointAlert | 1.0 | 播放 |

九段均报告 `source=embedded-gltf`、`batchMeshes=1`、
`shadowProxyCreated=true`、`shadowSkeletonShared=true`。连续帧接触表：
`evidence/browser_animation_contact_sheet.png`；真实 QA 字段：
`evidence/qa_animation_samples.json`。

A1 原有单测还验证 Idle↔Walk↔Run 的 0.15 s 混权、Search→LookAround、
Caught→ScaredCaught、胜利演出和 reduced-motion 降级；本批不改 A1 状态映射、
转身阻尼、FSM 或计时。

## 8. P4-3 合批、阴影与渲染预算

| 项 | A2 前 | A2 后 | 结果 |
|---|---:|---:|---|
| 同 QA 机位总 draw calls | 77 | 72（动画采样 71–72） | ≤80，通过 |
| 同 QA 机位总 triangles | 1,093,482 | 965,273 | 降低 11.7% |
| actors main calls | 37 | 32 | 降低 5 |
| actors main triangles | 428,996 | 300,787 | 降低 29.9% |
| actors shadow calls / tris | 3 / 1,032 | 3 / 1,032 | 不回退 |
| villain batch | 12→6 / 157,148 tris | 1→1 / 28,939 tris | 无 fallback |
| villain shadow proxy | 344 tris | 344 tris | 跟骨骼，保留 |

浏览器 QA 已确认动画播放时关节化阴影代理共享同一 Skeleton。P4 用例还直接
采样 posed arm vertex，证明动画不是只动主模型而阴影留在 bind pose。

## 9. 正式游戏相机与窄屏可读性

四张截图均固定 `player=(5,1)`、`villain=(3,1)`、`phase=ready`、
`aiState=delay`、`qaReducedMotion=1`，前后使用完全相同的正式游戏相机：

- 桌面 1280×720：`evidence/game_before_desktop_1280x720.png`、
  `evidence/game_after_desktop_1280x720.png`；
- 窄屏 375×812：`evidence/game_before_narrow_375x812.png`、
  `evidence/game_after_narrow_375x812.png`。

桌面相机 position=`[-7.039493,11.445153,-12.714122]`、target distance=15.6；
窄屏 position=`[-2.556532,18.159544,-6.733490]`、target distance=25.647285；
两者 fov=42、zoom=1、threat=0。375 px 俯视下仍能依靠兜帽暗面、魁梧体块
和红色追捕者标记一眼辨认，不与 kid 的蓝色细小轮廓混淆。相机与截图 SHA
详见 `evidence/qa_game_comparison.json`。

## 10. 自动化门禁

- `node --test tests/a2-villain-asset.test.mjs tests/p4-actor-batching.test.mjs`：
  8/8 通过；
- `npm run lint`：exit 0，无 ESLint finding；
- `npm run build`：exit 0，五个构建环境完成；仅保留项目已有的 >500 kB
  非阻断 chunk advisory；
- `npm test`：81/81 通过，0 failed、0 skipped；既有 77 条未删改，新增
  4 条 villain 资产校验通过；
- `git diff --check`：exit 0。

完整摘要：`evidence/verification_gates.txt`。

## 11. 逐项结论

| 验收项 | 状态 | 实际证据 |
|---|---|---|
| 风衣/兜帽/裤/靴分件与压迫剪影 | 完成 | 概念对照、同机位 before/after、五视图/线框 |
| 帽檐压暗面部 | 完成 | 面部后退 38 mm、眼区 -18%、正式相机截图 |
| 21 骨唯一且共享 | 完成 | 21 名称各 1 次、1 skin/1 Skeleton、新测试 |
| 零权重与双手覆盖 | 完成 | 0/21,135；LeftHand 2,260；RightHand 2,145 |
| +Z / Y=0 / scale=1 | 完成 | toe delta +0.113583 m；foot Y 0.205 mm；scale 1 |
| A1 九 clip 兼容 | 完成 | 九段浏览器连续帧、QA time/weight、A1 回归全绿 |
| P4-3 合批与关节阴影 | 完成 | 1→1 mesh；344-tri proxy；测试与 QA 均通过 |
| 体积/面数/材质预算 | 完成 | 1.09 MB；28,939 tris；1 material；模型总量 8.67 MB |
| Validator/浏览器 | 完成 | Error=0；控制台 0 error/0 warning；无观察到 404 |
| 桌面 + 375 px 可读性 | 完成 | 四张同状态正式相机前后实拍 |

没有使用“待浏览器验证”或只给布尔自评；上述数字均绑定最终 GLB SHA。
本角色验收后应先独立复验，不在同一 diff 继续 police 或 kid。
