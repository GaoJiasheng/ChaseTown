# Web 角色 PBR、动画与蒙皮生产规范

> 状态：2026-07-22 三个正式 GLB 已由集成任务显式写入 `public/models/characters/`，并与隔离候选 SHA-256 一致。本构建流程本身仍禁止直接覆盖运行时资产。

## 交付合同

| 角色 | 运行时 GLB | 大小 | SHA-256 | 动作 |
|---|---|---:|---|---|
| Kid | `public/models/characters/kid.glb` | 9,997,836 bytes | `08952a54915ede2de2c24d9c8abdc7ad2287fa0dff01f1cbd6b3cb71aec2e32a` | Idle、Walk、Run、TurnLeft、TurnRight、HideEnter、HideIdle、HidePeek、HideExit、Caught、EscapeCelebrate、Interact |
| Villain | `public/models/characters/villain.glb` | 10,748,024 bytes | `cee4c14fbf0a5d4d9598b611eddd8998a6f42a44261bd7fd2bb03b8790a67392` | Idle、PatrolWalk、Run、Alert、LostSight、Search、CheckHide、Catch |
| Police | `public/models/characters/police.glb` | 9,791,372 bytes | `b088e02b7eb4dadf0a1707a92bf2cf605b0a796b4951f1ac3c25289b4ef50dc3` | Idle、Run、Alert、Interact、Resolve |

隔离候选位于 `/tmp/chasing-character-pbr/{kid,villain,police}.glb`，与上表三个运行时文件逐字节一致。

三个角色都必须满足：单文件 `<12 MiB`、只有一个 21-joint skin、没有外链 URI、Khronos Validator 0 error、主要材质同时具有嵌入式 BaseColor / tangent-space Normal / AO / Roughness-Metallic 纹理。不得用纯色因子或程序几何假装 PBR 贴图。

## PBR 制作边界

- Kid / Villain 使用各自 v21 批准网格的原始 2K BaseColor 与完全匹配的 UV；Normal 和 ORM 压到 768 px，身份特征贴图不降到 1K。
- Police v22 的身体使用固定哈希的 MakeHuman 2K skin BaseColor；皮肤 micro-normal、skin ORM、制服/裤子 BaseColor 与 ORM 为 768 px；制服保留完全匹配 UV 的 MakeHuman casual-suit 1K normal。
- Police 远端 CC0 输入只进入临时缓存，并按大小和 SHA-256 双重校验。许可和固定输入见 `docs/licenses/MAKEHUMAN_CORE_ASSETS_CC0.md`。
- Blender 重新导出不写入显式 tangent accessor。此前实测该路径会产生零长度 tangent；Three.js 在 Normal Map 存在时会用 UV 导数构建 TBN，Khronos 规范错误因此为零。
- 后处理仅允许替换白名单主材质，不得生成新几何、改变拓扑、删除附件或改写动作集。

## Police v22 蒙皮修复

### 根因

MPFB 的 anatomical `Left` 位于 `X>0`，而项目 Kid / Villain、动作映射和运行时统一约定 `Left` 位于 `X<0`。旧 Police v22 因而把左右肢体动作送给对侧网格；静止姿势看似正常，Alert / Resolve / Run 会出现上衣拉尖、长颈假象、四肢交叉和肩部附件飞离。

不得回退 Police v21。实际重烘结果证明 v21 在 Alert 中会产生破裂躯干和巨大制服锥体。

### 唯一允许的修复顺序

1. 只交换左右 arm / hand / finger / leg / foot / toe 骨名；Blender 会把对应 vertex group 自动同步。严禁再手工交换 vertex group，否则会 double-swap。
2. 几何后缀 `-1`（`X<0`）附件绑定项目 `Left*`，`+1` 绑定 `Right*`。
3. 肩章和肩章扣绑定正确侧 Shoulder；袖标绑定正确侧 UpperArm；胸前对讲机绑定 Chest，不能绑定旋转幅度大的 Shoulder。
4. 只对 `Police_v22_Uniform` 中央胯缝做窄域稳定：`abs(x)<0.04`、`0.72<z<0.90`、Hips/UpperLeg 合计权重 `>0.5`；上下与横向均用 smoothstep 衰减，Hips 最高 0.90，其余影响比例保持不变。
5. 固定源上必须正好改变 44 / 2,499 个制服顶点；数量变化意味着模型或选择边界发生漂移，构建应失败。

修复报告：[police-v22-production-repaired.json](reports/police-v22-production-repaired.json)。动作重烘报告：[police-v22-production-repaired-animation.json](reports/police-v22-production-repaired-animation.json)。最终正面/侧面 5 动作固定机位图属于本地评审中间产物，不随精简仓库提交。

## Kid TurnLeft / TurnRight 合同

旧共享 `Anim_TurnLeft.fbx` / `Anim_TurnRight.fbx` 只有 Hips 单轴旋转，是不可发布的占位动作。曾评估的行走步态替代方案会读成“边走边转”，也已被视觉审查否决，不得恢复。

正式版本只抽取 Quaternius CC0 `Punch_Cross` 的下半身微幅重心转移；丢弃拳击上半身，叠加项目专用的视线/胸腔先导、克制的手臂反摆、双支撑脚锁和不拉伸肢体的两骨旋转抬脚。TurnRight 为基准动作，TurnLeft 通过 `S R S`（`S=diag(-1,1,1)`）反射旋转并交换左右骨生成，禁止手工猜测 quaternion 符号。

- 单次动作固定为 18 frames / 30 fps = `0.6000 s`，表达 90° 原地枢轴转身。
- Web Actor `Object3D` 独占实际 heading；clip 只保留最大 `13.137662°` 的瞬态骨盆重心扭转，首尾 Hips rotation delta 为 `0°`，因此不会与根节点发生双转。
- TurnLeft 支撑顺序：LeftFoot → RightFoot；TurnRight：RightFoot → LeftFoot。完整脚掌支撑窗为 `[0, 0.42]` 与 `[0.68, 1]`。
- 与运行时相同的 90° smootherstep heading 合成后，以 120 Hz 同时审计 Foot 与 Toes：最大平面漂移 TurnLeft `1.798 mm`、TurnRight `1.747 mm`；最大垂直漂移 `0.604 mm` / `0.811 mm`；最大支撑脚朝向漂移 `0.193827°` / `0.197823°`。
- 移动脚净空 TurnLeft `32.828 mm`、TurnRight `43.095 mm`，足够在游戏机位读出换重心，又不会退化为跨步或高抬腿。
- Idle → Turn、Turn → Idle 的 21 骨最大旋转/位置误差均为零，因此 180° 必须在 90° 接缝处以 `{restart: true}` 重启同方向 clip；不得把单段动作拉伸成 180°。
- Three.js 当前 `yaw = atan2(heading.x, heading.y)` 约定下，标准化最短 `deltaYaw > 0` 选 TurnLeft，`deltaYaw < 0` 选 TurnRight。
- 运行时进入 aligning 时必须冻结 `startYaw` / `targetYaw`，并用 clip 的标准化时间驱动完全相同的 smootherstep 根旋转；不得再用独立的 `rotateTowards` 速度积分，否则离线脚锁补偿与真实根旋转会失步。90° 标准时长为 0.6 s，部分角度可按目标角度同比缩短但仍使用完整归一化曲线；180° 明确拆成两个 0.6 s 周期。

动画构建与脚锁报告：[kid-turn-production-animation.json](reports/kid-turn-production-animation.json)。运行时 root 旋转合成后的逐帧脚位置与合同摘要：[kid-turn-in-place-review.json](reports/kid-turn-in-place-review.json)。90° / 180°固定机位图属于本地评审中间产物，不随精简仓库提交。

角色 PBR 后处理证据：[Kid 报告](reports/kid-pbr-turn-production-report.json)、[Police 报告](reports/police-pbr-production-report.json)。这些报告与最终总门禁一起保留，图片和隔离 GLB 候选仍只存在于可重建的临时工作目录中。

## 可复现构建

```bash
# 1. Police 源级语义/附件/胯缝修复（只写临时候选）
blender -b --python tools/art_pipeline/repair_police_v22_skinning.py -- \
  --input art-source/Characters/Police/ReferenceStandard/HumanAnatomyRemodel_2026_07_14_v22/Rigged/Police_HumanAnatomyRemodel_v22_Rigged.blend \
  --output /tmp/chasing-character-pbr/police-v22-production-repaired.blend \
  --report /tmp/chasing-character-pbr/police-v22-production-repaired.json

# 2. 重烘 Police 或 Kid 正式动作到隔离候选
blender -b --factory-startup --python tools/art_pipeline/build_police_animation_candidate.py -- \
  --role police \
  --source-blend /tmp/chasing-character-pbr/police-v22-production-repaired.blend \
  --source-generation v22-project-side-semantics-radio-chest-crotch44 \
  --output /tmp/chasing-character-pbr/police-v22-production-repaired-animated.glb

blender -b --factory-startup --python tools/art_pipeline/build_police_animation_candidate.py -- \
  --role kid \
  --source-blend art-source/Characters/Kid/ReferenceStandard/PrecisionRemodel_2026_07_13_v21/Rigged/Kid_PrecisionRemodel_v21_Rigged.blend \
  --source-generation v21-plus-grounded-punch-pivot-turn90 \
  --output /tmp/chasing-character-pbr/kid-turn-production-animated.glb

# 3. 动画完成后再做 PBR 后处理；不得颠倒顺序
blender -b --factory-startup --python tools/art_pipeline/apply_character_pbr.py -- \
  --role kid \
  --input /tmp/chasing-character-pbr/kid-turn-production-animated.glb \
  --output /tmp/chasing-character-pbr/kid.glb \
  --report /tmp/chasing-character-pbr/kid-pbr-turn-production-report.json \
  --cache-dir /tmp/chasing-character-pbr-cache \
  --no-download

# 4. 规范、体积、动作、skin、拓扑与 PBR 槽位总门禁
node tools/art_pipeline/validate_character_pbr_candidates.mjs \
  --official-dir public/models/characters \
  --candidate-dir /tmp/chasing-character-pbr \
  --output /tmp/chasing-character-pbr/final_candidate_contract_audit.json

# 5. 用与运行时相同的外部 heading 合成 Turn 证据
blender -b --factory-startup --python tools/art_pipeline/render_turn_in_place_review.py -- \
  --input /tmp/chasing-character-pbr/kid.glb \
  --output /tmp/chasing-character-pbr/kid-turn-pivot-review-v2
```

最终总报告 [final_candidate_contract_audit.json](reports/final_candidate_contract_audit.json) 的 `passedProductionContract` 必须为 `true`。当前已集成版本的三个角色还同时满足 `passedStrictRoundTripIdentity=true`。在集成前若使用旧 Kid GLB 作为 official 对照，新 TurnLeft / TurnRight 会使 strict identity 为 false；这只表示有意更新动作，不能替代 production contract，也不能被误报成数据损坏。
