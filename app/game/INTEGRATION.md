# 纯逻辑层接线说明

本目录不依赖 React、Three.js、DOM 或音频 API。`GameSimulation` 是唯一规则真相；渲染、动画、UI 和声音只能读取快照与事件，不能反向修改状态。

## 1. 创建与重开

```ts
import { GameSimulation } from "./game/simulation.ts";

const simulation = new GameSimulation({ autoStart: false });
simulation.start(); // 开始或完整重开
```

需要调难度时通过 `config` 覆盖 `DEFAULT_GAME_CONFIG`，不要在渲染循环里散落速度、视距或时间常量。测试关卡可通过 `level` 注入。

## 2. 输入与固定步更新

```ts
const state = simulation.advance(renderDeltaSeconds, {
  move: { x: moveX, y: moveY },
  interactPressed,
  peekHeld,
});
```

- `move` 和 `peekHeld` 是持续量，每个渲染帧提交当前值。
- `interactPressed` 是按下沿，只在一个渲染帧为 `true`；键盘重复事件不能重复触发。
- 窗口失焦、页面隐藏、pointer cancel 时立即把持续输入清零。
- 不要自行按 60 Hz 循环。`advance()` 内部已经用 `fixedStepSeconds` 累积和推进，并限制异常的大帧间隔。
- 一个渲染帧可能包含多个固定步；返回的 `state.events` 会保留这些固定步产生的全部事件。

### 主动主题机关

周期主题事件仍可继续使用 `sampleThemeMechanic(theme, elapsedSeconds)`。需要把铃声、呼叫器、排烟阀或蒸汽阀落到真实位置时，使用纯状态机：

```ts
import {
  createMechanicInstance,
  createThemeMechanicDefinition,
  stepMechanicInstance,
} from "./game/theme-mechanics.ts";

let bell = createMechanicInstance(
  createThemeMechanicDefinition("campus", "bell-west", { x: 7, y: 5 }),
);

const result = stepMechanicInstance(bell, {
  deltaSeconds,
  nowSeconds: simulation.getState().elapsedSeconds,
  activationRequested: interactPressed,
  actorPosition: simulation.getState().player.position,
});
bell = result.instance;

if (result.emittedSoundStimulus) {
  simulation.emitWorldSound(result.emittedSoundStimulus);
}
simulation.advance(deltaSeconds, {
  environmentSoundMasking: result.sample.soundMasking,
  visionRangeMultiplier: result.sample.visionRangeMultiplier,
});
```

- `warning-started` 用于预警灯、拉杆动画和提示音；不要在玩家按键瞬间直接跳到满强度效果。
- `activation-cost-applied` 是公开表现合同，按 `noise / exposure / time` 播放对应代价反馈。
- `emittedSoundStimulus` 只能交给 `emitWorldSound()`；该入口仍会经过导航距离、听觉范围和位置误差，禁止直接构造 AI 目标。
- 同一稳定环境声源被连续滥用会降低置信度；视觉以及目击进柜证据始终优先。
- 环境声源驱动的后续搜索从真实导航岔路生成 3–5 条可达假设；原有十关视觉/脚步搜索继续使用已经认证的局部搜索顺序。

### 两阶段主题任务

`theme-objectives.ts` 提供校园、医院、消防站、工厂四套不同动词的任务定义。每套任务都有两个可任意排序的准备目标，以及一个第二阶段出口释放目标：

```ts
import {
  auditThemeMissionSoftlock,
  createInitialThemeMissionState,
  stepThemeMission,
  themeMissionDefinition,
} from "./game/theme-objectives.ts";

const mission = themeMissionDefinition(level.campaign.theme);
const audit = auditThemeMissionSoftlock(level, mission, objectivePlacements);
if (!audit.passed) throw new Error(audit.failures.join("; "));

let missionState = createInitialThemeMissionState(mission);
missionState = stepThemeMission(mission, missionState, interactedObjectiveId).state;
```

- 只有 `missionState.exitUnlocked` 为 `true` 时，出口接触才能结算胜利。
- 准备阶段的两个目标必须都能从出生点抵达，并能以两种顺序继续到最终控制器和出口；场景加载时必须执行 `auditThemeMissionSoftlock()`。
- 所有必做目标都满足 retryable、不提前消耗唯一资源、不关闭剩余必经路线的合同。表现层可以播放失败动画，但不能制造一次性失败窗口。
- `availableThemeObjectiveIds()` 是交互提示和目标高亮的唯一任务可用性来源；渲染层不得自行跳过前置条件。

### 多藏身类型

`hide-archetypes.ts` 在不改变旧关卡数据的前提下提供硬柜、软质遮挡和穿越式藏点：

```ts
import {
  auditHideArchetypeLevelSafety,
  queryLegalHideCandidates,
} from "./game/hide-archetypes.ts";

const audit = auditHideArchetypeLevelSafety(level);
if (!audit.passed) throw new Error(audit.failures.join("; "));

const activeSpot = simulation.getActiveHideSpotArchetype();
const exitSelection = simulation.getHideExitSelection();
simulation.advance(deltaSeconds, {
  interactPressed,
  hideExitChoice: chooseAlternate ? "alternate" : "origin",
});

const legalChecks = queryLegalHideCandidates(
  level,
  [],
  publicPerceptionEvidence,
  { maximumRouteDistance: simulation.config.searchHideRadiusCells },
);
```

- 未配置 archetype/binding 的现有 `HideSpotDefinition` 自动解析为 `hard-locker`；不能迁移的旧关卡也可通过 `GameSimulationOptions.hideArchetypeBindings` 适配。
- `GameSimulation` 已按 profile 驱动三类藏点的进出时长、窥视能力和交互声音；软质遮挡的 `occupiedVisualDisturbance` 已进入合法视觉采样。
- 穿越式藏点必须提供可达的 `alternateExit`；玩家通过 `hideExitChoice` 选择，完成退出后逻辑位置才切到对应出口。
- UI/render 通过 `getHideSpotArchetype()`、`getActiveHideSpotArchetype()` 和 `getHideExitSelection()` 读取公开 profile、出口列表与当前选择。
- `queryLegalHideCandidates()` 的签名没有占用状态、`concealed` 或玩家位置。只有 `hide-entry-visible` 可返回 exact 检查；普通声音和最后目击只能按公开几何排序候选。
- 三类藏点的正式动画/美术仍需分别接表现合同，禁止用同一柜体简单换色。

## 3. 快照、事件与渲染

每帧按以下顺序接线：

1. 采样输入并调用 `advance()`。
2. 消费 `state.events`，触发一次性动画、声音和镜头反馈。
3. 用 `state.player`、`state.chaser` 和 `state.hideSpots` 更新 Three.js 表现对象。
4. HUD 只需以 5–10 Hz 把必要字段同步给 React，不能让 React state 驱动模拟。

`getState()` 返回防外部修改的副本。渲染平滑应在表现层对当前视觉 transform 做插值/阻尼；不得把平滑后的坐标写回模拟。

大型场景道具的落位必须同步写入 `level.movementBlockers`。这些格仍渲染正式地面，但玩家、AI 寻路和视线均不可穿过；墙挂、小型散落物应贴边摆放，不得占据单格走廊中心。

事件建议：

| 事件 | 表现层职责 |
|---|---|
| `player-mode-changed` | 切换一次性进柜、出柜、被抓或逃脱动作 |
| `chaser-mode-changed` | 切换警觉、追逐、丢失、搜索和搜柜动作；同步音乐层与镜头模式 |
| `hide-check-completed` | 在正式搜柜动作接触点结算门、音效和结果反馈 |
| `phase-changed` | 播放胜负演出并更新 HUD；不要提前弹出面板遮住角色动作 |

## 4. 躲藏交互

UI 使用 `simulation.getHideInteraction()`：

- `{ kind: "enter", hideSpotId }`：结合 `getHideSpotArchetype()` 显示对应藏点动作。
- `{ kind: "exit", hideSpotId }`：结合 `getHideExitSelection()` 显示可选出口。
- `null`：隐藏交互提示。

场景中的正式 `HideSpotView` 必须与 `level.hideSpots[].id` 一一对应。`approach` 是导航/规则位置，`concealed` 是柜内视觉锚点：

1. `aligning-hide`：锁定人工输入，以正式 Walk 平滑走到柜前 anchor；到位后以 0.6 秒 TurnLeft/TurnRight 枢轴动作完成朝向，禁止吸附瞬移或脚底原地打滑。90° 使用一个 smootherstep 周期，180° 在 90° 接缝显式重启第二周期；`state.player.hideTurn*` 是表现层唯一时序输入。
2. `entering-hide`：播放 Kid EnterLocker，并按动画 marker 驱动门把、开门和关门。
3. `hidden`：角色视觉对象对齐 `concealed`，播放呼吸 Idle；逻辑位置仍由模拟管理。
4. `entering-peek → peeking → exiting-peek`：门缝打开完成才暴露，关缝期间保持暴露，完全闭合后才恢复隐藏。
5. `exiting-hide`：播放 ExitLocker，完成后恢复自由移动。
6. `check-hide`：追捕者走到对应柜体并播放 CheckLocker；不得由渲染层查询哪个柜子有人来替 AI 选目标。

储物柜是核心互动资源，未加载或缺少正式门层级/动画时应阻止开局并显示素材错误，不能替换成几何占位。

## 5. 状态到动画/UI 的统一映射

### PlayerMode

| 状态 | 正式动画 | UI/交互 |
|---|---|---|
| `free` | 静止用 Idle；位置持续变化时用 Walk/Run，按实际速度校准 timeScale | 正常 HUD；附近有柜体时显示进入提示 |
| `aligning-hide` | Walk 到锚点；随后 TurnLeft/TurnRight 与模拟 heading 共用同一 smootherstep 时线 | 锁定移动并显示“正在对齐柜门” |
| `entering-hide` | EnterLocker，一次性 | 禁用移动；保持紧张反馈 |
| `hidden` | LockerIdle/Breath | 隐藏常规移动控件，显示离开/窥视 |
| `peeking` | LockerPeek | 显示暴露风险，不显示敌人精确墙后坐标 |
| `exiting-hide` | ExitLocker，一次性 | 禁用移动直到动作完成 |
| `caught` | ScaredCaught/Caught | 先完成抓捕演出，再显示失败面板 |
| `escaped` | Celebrate/Rescue | 进入警察保护和胜利演出 |

### ChaserMode

| 状态 | 正式动画 | UI/音乐/镜头 |
|---|---|---|
| `spawn-delay` | Idle 或低频 LookAround | 不显示危险、禁止抓捕 |
| `patrol` | Walk | 基础音乐；无精确敌人指示 |
| `suspicious` | Alert/Turn | 短促警觉提示、轻微升压 |
| `chase` | ChaseRun | 紧张音乐和危险反馈进入主层 |
| `lost-sight` | Run，保持追击动量 | 冻结最后目击点，镜头不继续追踪墙后敌人 |
| `go-to-last-known` | SearchWalk/Run | 以玩家为中心，不泄露 AI 路径目标 |
| `scan-last-known` | SearchLook，根朝向左→右→回中 | 抵达冻结目击点后原地巡视，视锥与模型朝向一致 |
| `search` | SearchLook + SearchWalk | 搜索层音乐；只给方向性环境反馈 |
| `check-hide` | ApproachLocker + CheckLocker | 近距离搜柜反馈，动作/门/音效严格按 marker 同步 |

生产状态不得调用 `poseRig`、角色圆环、常驻标签或基础几何替代动作。调试信息只能存在于显式 QA/debug 模式。

## 6. 公平性边界

`samplePlayerPerception()` 是唯一读取玩家真实模式和位置的 AI 感知入口。`stepChaserBrain()` 只接受 `PerceptionEvidence`，没有玩家或柜体占用参数：

- 只有看到玩家时才更新 `lastKnownPosition`。
- 未目击进柜时不会得到 `hideSpotId`。
- 只有 `hide-entry-visible` 能触发精确 `check-hide`。
- 柜体占用只在检查动作完成后由 `GameSimulation` 结算。

接入时不得为了镜头、HUD 或动画方便，把玩家引用、柜体占用或实时坐标重新传入 `chaser-fsm.ts`。

## 7. 场景资源加载基础设施

`createSceneAssetLoader()` 为一次场景生命周期创建独立的请求队列。主组件应在场景 effect 内创建，在 cleanup 的第一步调用 `abort()`；不要建立跨关卡的全局 loader，否则旧关卡仍可能占用新关卡的带宽。

```ts
import {
  AssetLoadError,
  createSceneAssetLoader,
  externalAssetUrisFromGlb,
} from "./game/asset-loading.ts";

const sceneAssets = createSceneAssetLoader({
  maximumConcurrentRequests: coarsePointer ? 2 : 3,
  timeoutMilliseconds: 20_000,
  retry: {
    maximumAttempts: 3,
    baseDelayMilliseconds: 350,
    maximumDelayMilliseconds: 4_000,
    jitterRatio: 0.2,
  },
});

async function loadGlb(url: string) {
  const bytes = await sceneAssets.fetchArrayBuffer(url, {
    requestInit: {
      cache: "force-cache",
      credentials: "same-origin",
    },
  });
  const absoluteUrl = new URL(url, location.href);
  const baseUrl = new URL(".", absoluteUrl).href;
  await Promise.all(externalAssetUrisFromGlb(bytes).map(async (uri) => {
    const dependencyUrl = new URL(uri, baseUrl);
    const dependency = await sceneAssets.fetchArrayBuffer(dependencyUrl);
    // 为 dependency 建立 object URL，并用每场景 LoadingManager 的
    // setURLModifier() 把原 URL 映射到它；cleanup 时统一 revoke。
    registerControlledDependency(dependencyUrl, dependency);
  }));
  return gltfLoader.parseAsync(bytes, baseUrl);
}

// effect cleanup：先停网络，再清 Three.js / 音频资源。
sceneAssets.abort(new DOMException("scene disposed", "AbortError"));
```

- 并行调用 `loadGlb()` 即可；队列只允许指定数量的真实 fetch 同时运行，退避等待不会占住并发槽。
- `timeoutMilliseconds` 是每次尝试的 deadline。408、425、429、5xx、网络中断、超时与响应体截断可重试；普通 4xx 和外部取消不可重试。
- 最终错误统一为 `AssetLoadError`。`ASSET_ABORTED` 是正常切关，不显示红色错误；`ASSET_TIMEOUT`、`ASSET_NETWORK` 和可重试的 `ASSET_HTTP` 在耗尽重试后显示“检查网络/重试”；不可重试 HTTP 应显示素材路径与状态码。
- cleanup 必须调用 `abort()`，即使场景已经加载完成，用于移除父级 signal 监听并拒绝仍在队列中的可选素材。
- `parseAsync()` 前必须用 `externalAssetUrisFromGlb()` 枚举外链 buffer/贴图，通过同一队列预取，再用本场景 `LoadingManager.setURLModifier()` 映射到 object URL。这样 GLB 与 PNG/KTX2 共享超时、重试、限流和切关取消；object URL 必须在 Three.js 资源释放后 revoke。

## 8. 几何与阴影质量预算

`RENDER_QUALITY_PROFILES` 除了 DPR、粒子和灯光，还定义以下硬预算：

- `maximumVisibleTriangles`：LOD 与距离裁剪后的可见三角面上限。
- `maximumDrawCalls`：`renderer.info.render.calls` 的整帧提交上限。
- `maximumShadowTriangles` / `maximumShadowDrawCalls`：主光源阴影 pass 的子预算。
- `staticEnvironmentShadows`：静态建筑是否进入实时阴影图；关闭时保留烘焙 AO、接触阴影和角色动态投影。
- `decorativeDistanceMeters`：非碰撞、非任务关键装饰相对玩家的最大显示距离。

接入顺序必须是：

1. 应用装饰距离、LOD、实例批次和静态阴影策略，让实际提交量先满足当前 profile。
2. 每个采样窗口记录 p95 帧时，以及主 pass / shadow pass 的三角面和 draw calls。
3. 调用 `renderWorkloadFitsProfile(profile, sample)` 写入 QA 诊断。
4. 将同一 `sample` 作为第四个参数传给 `nextRenderQuality()`。超载持续 2.5 秒才降一档；帧时有余量、工作量在预算内持续 12 秒才升一档。

```ts
const workload = {
  visibleTriangles,
  drawCalls: renderer.info.render.calls,
  shadowTriangles,
  shadowDrawCalls,
};

const nextTier = nextRenderQuality(
  currentTier,
  p95FrameMilliseconds,
  candidateStableSeconds,
  workload,
);
```

`nextRenderQuality()` 仍兼容原三参数调用，但那种调用只能依据帧时，无法阻止“当前设备帧时暂时正常、场景复杂度已超预算”时的错误升档。每次决策最多变化一档，切档后应清空候选持续时间，避免 high/balanced/mobile 往返抖动。

## 9. 认证重混与主题追捕者接线

认证重混不是任意程序化关卡。每关只接受 `CERTIFIED_REMIX_SEEDS` 中三个经过可达性审计的 seed；未知 seed、跨关卡契约会直接拒绝。传入 `null` 时返回原始关卡对象，旧存档与默认玩法不受影响。

```ts
import {
  certifiedRemixContractsForLevel,
  remixGhostStorageKey,
  remixRecordStorageKey,
  remixReplayLevelId,
  resolveCertifiedRemix,
} from "./remix-contracts.ts";

const contract = certifiedRemixContractsForLevel(level)[variantIndex];
const remix = resolveCertifiedRemix(level, contract, rulesetLane);

// 用 remix.level 创建模拟；任务表现优先读取已认证的落点组。
const simulationLevel = remix.level;
const mechanicPlacementGroup = remix.mechanicPlacementGroup;

// 回放、幽灵和成绩使用含 seed + ruleset + mission-v1 的独立身份。
const replayLevelId = remixReplayLevelId(contract, rulesetLane);
const ghostKey = remixGhostStorageKey(contract, rulesetLane);
const recordKey = remixRecordStorageKey(contract, rulesetLane);
```

- `remix.level` 是碰撞、寻路、巡逻、藏点、美术布局和任务软锁审计的共同关卡对象，不能只在 UI 上改布局编号。
- `mechanicPlacementGroup` 是前两个认证任务锚点；其余任务锚点从同一重混关卡的环境构图计划选取，并再次执行 `auditThemeMissionSoftlock()`。
- 每个布局固定改变可选通路、巡逻顺序、任务锚点与藏点供应，UI 必须明示布局编号和“非随机”，让玩家能够重复学习。
- `remixReplayLevelId()` 与记录键同时包含关卡、固定 seed、规则模式和 `mission-v1`，不会覆盖原版、另一布局或 Assisted 记录。
- 不要从 `seed` 临时随机新组合，也不要自行删改 `closedPassageCells`、`hideSupplyIds`。新增变体前必须加入固定白名单并通过 `auditCertifiedRemixContract()`。

主题追捕者规则同样默认关闭；`GameSimulation` 只有收到显式
`chaserArchetypeProfile` 才会启用，省略或传 `null` 会走原 FSM 的完全兼容路径：

```ts
import {
  enabledChaserArchetype,
} from "./chaser-archetypes.ts";
import { GameSimulation } from "./simulation.ts";

const profile = enabledChaserArchetype(level.theme, featureEnabled);
const simulation = new GameSimulation({
  level,
  chaserArchetypeProfile: profile,
});

// 渲染层只读公开 cue / 行动，不向模拟回传玩家真值。
const cue = simulation.getChaserArchetypeRuntime();
```

- `chaser-archetype-telegraph-started` 事件提供 `cueAnimationToken`、
  `cueAudioToken` 和可读提示；整个 `warningSeconds`（下限 0.5 秒）内追捕者
  停止平移。`getChaserArchetypeRuntime()` 同步提供 `cueProgress`，避免表现层
  自己推算时序。
- `chaser-archetype-action-started` 之后才会改变行为：
  - 校园：公开巡逻点确实到达且为三向以上岔路时，原地依次扫过公开支路，
    扫视完成再推进巡逻索引。
  - 医院：仅把同一采样证据交给 `queryLegalHideCandidates()`，导航到返回的
    `approach` 并执行普通检查；选点不读占用，检查完成后的命中结算仍复用
    既有公平检查流程。
  - 消防：只锁定已采样的、不精确声音点，以 `1.16x` 追踪移动形成明确的
    听觉专长；不会用真实声源覆盖采样点，也不会把同一声音重复写入证据账本。
  - 工厂：只从最后目击点到公开出口的合法路径选择前方节点，以 `1.08x`
    切入；玩家改变路线即可反制。
- `chaser-archetype-action-finished` 的 `outcome` 区分完成和被更强公开证据打断。
  UI 不应读取未公开目标；所有合法目标已经由
  `getChaserArchetypeRuntime().navigationTarget` 提供。
- 接线输入严格限于已采样 `PerceptionEvidence`、公开巡逻到达、公开关卡几何
  与 `queryLegalHideCandidates()`。玩家状态、隐藏位置、藏点占用和穿越藏点
  出口选择不会进入主题控制器；占用只在既有检查动作完成后用于命中结算。
- 四种规则的集成测试同时跑 30 / 60 / 120 Hz 渲染步进；决策、事件、位置和
  查询态必须完全一致。新增规则不得以渲染帧率作为随机源或计时源。
