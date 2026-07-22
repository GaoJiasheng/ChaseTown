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

- `{ kind: "enter", hideSpotId }`：显示“躲进储物柜”。
- `{ kind: "exit", hideSpotId }`：显示“离开储物柜”。
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
| `lost-sight` | LoseSight/Brake | 危险反馈平滑衰减，镜头不继续追踪墙后敌人 |
| `go-to-last-known` | SearchWalk/Run | 以玩家为中心，不泄露 AI 路径目标 |
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
