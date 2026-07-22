# Web 版实施与验证报告

> 文档日期：2026-07-22
> 当前状态：`REVIEW` — 本地全量回归、真实浏览器冒烟、Sites v13 发布与线上复核均已通过，等待用户体验验收
> 工作分支：`codex/top-tier-web-vertical-slice`

## 1. 发布标识

| 项目 | 值 |
|---|---|
| 部署运行 Commit | `a23abcf5e0331155e5c01a288962c48bba587241` |
| 托管项目 / 版本 | `appgprj_6a562ff04ac081918664612f375c3fda` / Sites `v13` |
| 线上地址 | `https://chasing-school-escape.gavingao.chatgpt.site` |
| 访问策略 | `Private / custom`；仅 Gavin Gao，0 个共享群组 |
| 最终验证日期与执行人 | `2026-07-22` / Codex QA |
| 发布结论 | `PASS`；工程与线上门禁通过，主观体验验收状态为 REVIEW |

本报告中的“已实现”表示代码、正式资产和对应专项门禁已经落入仓库。部署运行 Commit、完整测试数、浏览器截图和线上版本均已回填；状态保留为 `REVIEW`，直到用户完成主观体验验收。

## 2. 本次交付边界

- 项目已成为纯 Web 3D 游戏：React 19、TypeScript、Three.js 0.185.1、vinext / Vite 与 WebGL 渲染，不再依赖 Unity 工程或桌面游戏引擎。
- 第一关形成从出生点、探索、追逐、断开视线、躲藏 / 窥视、重新逃跑到抵达警察局的完整闭环。
- 浏览器按关卡清单从 `public/models/` 的 26 个正式 GLB 中按需加载角色、当前主题套件与语义道具；七个与主题套件重复且永不请求的旧墙体 / 地面回退 GLB 已删除，`.blend`、`.fbx` 和制作贴图仍作为源美术保留，不进入运行请求。
- Kid / Villain 使用 v21 批准母版，Police 使用修复后的 v22 母版；三个正式角色均有 skin、骨架、PBR 贴图和专用动作集。
- 音乐采用两条同拍、同长度 AAC stem，由危险值连续混音；不使用振荡器蜂鸣或单一 loop 直出代替配乐。

不在本次结论中偷换的边界：桌面浏览器自动化截图不等价于低端手机实机测试；阶段性测试通过不等价于最终发布提交通过；Khronos Validator 的 warning 不等价于 error。

## 3. 已实现并进入专项门禁的游戏系统

| 系统 | 落地结果 | 可复核门禁 |
|---|---|---|
| 固定步长模拟 | 移动、碰撞、感知、搜索和躲藏状态使用确定性固定步长更新，避免帧率改变难度 | `tests/game-simulation.test.mjs` |
| 公平感知 | 追捕者只根据距离、视锥、墙体遮挡和已经观察到的证据决策；丢失目标后前往最后已知点搜索 | `tests/game-simulation.test.mjs` |
| 躲藏闭环 | 靠近指定 Locker 后依次执行对齐、开门、进入、关门、隐藏、窥视和退出；搜索时追捕者可检查藏点 | `tests/game-simulation.test.mjs`、`tests/actor-runtime.test.mjs` |
| 防证据泄漏 | 零开启量的快速窥视不会在柜门视觉关闭时把玩家位置泄漏给 AI | 专项回归用例位于 `tests/game-simulation.test.mjs` |
| 正式角色动作 | Kid 12 个、Villain 8 个、Police 5 个动作均由 GLB `AnimationClip` 与 `AnimationMixer` 驱动 | `tests/animation-assets.test.mjs`、`tests/actor-runtime.test.mjs` |
| 原地转身 | Kid 的 90° TurnLeft / TurnRight 为 0.6 秒脚锁动作；180° 明确拆成两段，并由运行时 heading 与 clip 同步 | [动作与脚锁报告](art_production/reports/kid-turn-production-animation.json) |
| Locker 演出 | Hero Locker 使用正式 GLB 与六段真实柜门动画，不用程序几何替代 | `tests/animation-assets.test.mjs`、`tests/no-placeholder-art.test.mjs` |
| 相机与遮挡 | 采用固定世界方位镜头，角色转身只改变角色朝向、不改变操作轴；追逐最低距离由 FOV、aspect、双方分离量和角色边距反算，手动缩放不能越过安全画幅；墙体或大物件只在遮挡角色的局部走廊内淡出并自动恢复 | `tests/input.test.mjs`、`tests/presentation.test.mjs` + 运行态 smoke 场景 |
| 自适应音乐 | 38.02 秒 Explore / Threat stem 同步启动，按威胁 attack / release 平滑混音，并支持静音 | `tests/adaptive-score.test.mjs` |
| 桌面与触控输入 | 键盘、Pointer Events 与屏幕控制共享屏幕坐标意图，再通过固定相机基向量转换到世界坐标；支持躲藏、按住窥视、静音、缩放和重开 | `tests/input.test.mjs`、响应式 smoke 场景 |
| 追捕者世界可见性 | AI / HUD 的情报可观察性与 3D 模型渲染彻底分离；追捕者在逃跑、断视线、搜索和失败阶段保持正式模型，只有真实墙体、深度、画幅和柜门视野可自然遮挡 | `tests/presentation.test.mjs` + 真实追逐 / 断视线 smoke |
| 胜负演出 | 被抓与逃脱成功均切换正式动作并延迟出现结果层，避免立即切断角色表演 | `tests/actor-runtime.test.mjs`、运行态 smoke 场景 |

## 4. 正式资产证据

### 4.1 角色 GLB

| 角色 | 版本 | 大小 | SHA-256 | 动作数 |
|---|---|---:|---|---:|
| Kid | v21 + 正式 pivot turn | 9,997,836 bytes | `08952a54915ede2de2c24d9c8abdc7ad2287fa0dff01f1cbd6b3cb71aec2e32a` | 12 |
| Villain | v21 | 10,748,024 bytes | `cee4c14fbf0a5d4d9598b611eddd8998a6f42a44261bd7fd2bb03b8790a67392` | 8 |
| Police | v22 修复版 | 9,791,372 bytes | `b088e02b7eb4dadf0a1707a92bf2cf605b0a796b4951f1ac3c25289b4ef50dc3` | 5 |

三者均低于 12 MiB、各含一个 21-joint skin、无外链 URI，主要材质包含内嵌 BaseColor、Normal、Occlusion 与 Metallic-Roughness 贴图。最终角色总门禁见 [final_candidate_contract_audit.json](art_production/reports/final_candidate_contract_audit.json)；报告记录 `passedProductionContract=true` 与 `passedStrictRoundTripIdentity=true`。

补充证据：

- [Kid PBR 后处理报告](art_production/reports/kid-pbr-turn-production-report.json)
- [Kid 转身逐帧运行时复核](art_production/reports/kid-turn-in-place-review.json)
- [Police v22 蒙皮与附件修复报告](art_production/reports/police-v22-production-repaired.json)
- [Police 动作重烘报告](art_production/reports/police-v22-production-repaired-animation.json)
- [Police PBR 后处理报告](art_production/reports/police-pbr-production-report.json)

### 4.2 关键环境资产

| 资产 | 大小 | SHA-256 | 说明 |
|---|---:|---|---|
| `public/models/environment/locker.glb` | 1,602,276 bytes | `6442702bb232543e2c9aad680b7a9ffccc1de2a09707a7dbf77ed9f41f5fbf04` | Hero Locker；真实百叶、门内骨架、三点锁杆、层架与六段柜门动作；Meshopt 压缩 |
| `public/models/environment/themes/campus-kit.glb` | 1,751,288 bytes | `c9846edfd3402d62ad44e0e245fd541afa8b48f3b4458881c2683fd626c1847a` | 校园经典、图书馆、科学楼三套独占叙事模块；无量化 Meshopt |
| `public/models/environment/themes/hospital-kit.glb` | 1,108,964 bytes | `01a4f2b87ceb98c598b450cb5b5358fc4ab1aa16402db974b568127e570457e0` | 门诊与隔离区两套独占叙事模块；药房柜正反两面完整精修；无量化 Meshopt |
| `public/models/environment/themes/fire-station-kit.glb` | 1,160,524 bytes | `a11811d2081dffe6e643dca1a04d6315c482f3d7662275ec6429dd043cb60836` | 车库与训练区两套独占叙事模块；无量化 Meshopt |
| `public/models/environment/themes/factory-kit.glb` | 1,710,888 bytes | `9cfb9ed643106d904987497e7cade87bc2d4335985613cd3292fcfeb2a1f74b3` | 装配、涡轮与铸造三套独占叙事模块；无量化 Meshopt |
| `public/models/environment/ceiling-light.glb` | 37,164 bytes | `587e11a8bbddb1ed8c967b9a08bda0b6ab369f69940c2998c2d85b7693fdd596` | 精修灯体、紧固件、真实 PBR 表面、显式切线与规范化自发光 |
| `public/models/environment/station.glb` | 184,976 bytes | `1ee9145154bcf93c6a4c574f838cd6dd3a1d94b626596dc7593d4ba1560543f5` | 精修警察站建筑、门窗、立面构件、显式切线与规范化自发光 |

26 个运行 GLB 必须全部被应用代码引用；22 张外部环境纹理必须全部被 GLB 引用。23 个环境 GLB 全部使用仓库固定版本的 Meshopt，894 个使用 Normal Map 的 primitive 全部随包携带有效 `TANGENT`。主题套件还必须满足 10 关共 60 个非 alias 独占叙事根节点、节点 / mesh / 三角面 / 材质 / 图片 / 字节预算。`tests/model-assets.test.mjs` 同时检查结构、引用、PBR、Meshopt、切线与主题语义合同，防止精修资产回退。

### 4.3 音乐与展示图

| 产物 | 大小 | SHA-256 | 规格 |
|---|---:|---|---|
| `public/audio/slow-drift-explore.m4a` | 935,976 bytes | `03f0f72bc50758234fe7d50dc419802debfe190abc275c504292672c0c73a611` | AAC-LC、48 kHz、Stereo、38.02 s、-22.24 LUFS |
| `public/audio/slow-drift-threat.m4a` | 958,523 bytes | `300df04317f93e27a830d18bd0713104e3618042771afd984634fca2c2caf3b1` | AAC-LC、48 kHz、Stereo、38.02 s、-20.19 LUFS |
| `public/audio/adaptive-score-manifest.json` | 3,505 bytes | `552da54f73eb70949337304ee59838209402f92c59e540e8b2400e0e967c2dc1` | 源哈希、响度、峰值、时长、循环边界与建议混音 |
| `public/chasing-environment-key-art.jpg` | 272,901 bytes | `7dc1c698748be90a46dc02df6b06b4d33be1c967c71ddf4c6106e439986d90f6` | 1,200 × 630 四主题正式分享图 |

音频许可与原创编排边界见 [Apple Loops 音乐来源与许可记录](licenses/APPLE_LOOPS_AUDIO.md)。角色动作、MakeHuman 与 Poly Haven 来源分别见 [Quaternius CC0](licenses/QUATERNIUS_UNIVERSAL_ANIMATION_LIBRARY_CC0.md)、[MakeHuman CC0](licenses/MAKEHUMAN_CORE_ASSETS_CC0.md) 和 [Poly Haven CC0](licenses/POLY_HAVEN_CC0.md)。生产 Web 包的开源软件 notices 位于 [`public/THIRD_PARTY_NOTICES.txt`](../public/THIRD_PARTY_NOTICES.txt)。

## 5. 最终自动化门禁

最终发布必须在同一 Commit、干净依赖安装和同一工作区中完成下表。阶段性通过记录不能代替最终结果。

| 门禁 | 命令 / 方法 | 最终结果 |
|---|---|---|
| TypeScript | `npm run typecheck` | PASS，0 error |
| ESLint | `npm run lint` | PASS，0 error |
| 生产构建 | `npm run build` | PASS；仅保留单个 client chunk 大于 500 kB 的非阻断体积 warning |
| 全量自动测试 | `npm test` | PASS，104 / 104，失败 0 |
| 生产依赖安全审计 | `npm audit --omit=dev` | PASS，0 vulnerability |
| Git 补丁完整性 | `git diff --check` | PASS |
| Git / LFS 对象完整性 | `git fsck --full`、`git lfs fsck` | PASS |
| 23 个环境 GLB 结构与引用 | Node 测试 + `@gltf-transform/cli 4.4.1 validate` | `PASS — 23 / 23 exit 0；0 error、0 warning、218 information、0 hint` |
| 生产包 notices | 构建后检查 `dist/client/THIRD_PARTY_NOTICES.txt` | PASS |
| 凭据与大文件扫描 | 工作树、构建产物与 Git 差异扫描 | PASS，未发现私钥、常见访问令牌或误入环境文件 |

最终浏览器精简摘要见 [runtime-smoke-summary.json](web-rendering/evidence/runtime-smoke-summary.json)、[production-route-summary.json](web-rendering/evidence/production-route-summary.json) 与 [webgl-context-summary.json](web-rendering/evidence/webgl-context-summary.json)。

## 6. 回归返工记录

| 发现 | 根因 | 修复 | 回归证据 |
|---|---|---|---|
| 相机与墙体交叠时大块黑屏 / 角色被挡 | 镜头几何遮挡缺少局部处理 | 改为相机到角色视线走廊内的材质淡出，并在离开遮挡后恢复 | [相机遮挡截图](web-rendering/evidence/camera-occlusion.jpg) |
| 快速点按窥视可能在门仍关闭时泄漏证据 | `exiting-peek` 被无条件判定为视觉暴露 | 暴露条件加入实际过渡开启量，新增零开启量专项用例 | `tests/game-simulation.test.mjs` |
| Ceiling Light / Station 的 emissiveFactor 超出 glTF 范围 | 颜色因子承担了亮度，违反每通道 0–1 规范 | 因子归一化，亮度移入 `KHR_materials_emissive_strength`；加入资产测试与可复现修复脚本 | `tools/art_pipeline/fix_emissive_strength.mjs` |
| Kid 原地转身存在脚滑风险 | clip 与运行时根旋转若分别积分会失步 | 固定 0.6 秒 smootherstep heading 合成、冻结转向计划、按 clip 时间同步；120 Hz 审计最大平面漂移 1.798 mm | [Kid 转身报告](art_production/reports/kid-turn-production-animation.json) |
| 藏好后 Kid 仍有局部穿出柜体 | 运行表现没有按同一视觉暴露合同隐藏角色材质 | Kid 显隐统一复用 `isPlayerVisuallyExposed`；安全 marker 后淡出，hidden root 不渲染，peek / exit 按 marker 恢复 | [Locker hidden](web-rendering/evidence/locker-hidden.jpg)、[Locker peek](web-rendering/evidence/locker-peek.jpg) |
| 音频同步监听失败后接口返回失败但状态仍为 playing | 播放成功后监控初始化异常没有事务回滚；半初始化媒体图也无法重试 | 失败时停止双轨、清 timer / listener 并进入 error；局部 element / source / gain / context 全面清理，下一手势可重建 | `tests/adaptive-score.test.mjs` 的两项故障注入用例 |
| 低于 20 FPS 时游戏与动作相对真实时间减速 | 主 rAF 把所有 delta 固定截断为 0.05 秒 | 模拟、角色、柜门和相机共用 0.25 秒安全上限内的真实 delta；页面恢复重置帧钟 | `tests/presentation.test.mjs` 的 10 FPS / 长停顿用例 |
| 本地 favicon 请求旧线上私有地址并触发 ORB | icon metadata 被 `metadataBase` 解析为绝对生产 URL | 改为显式同源 `/favicon.svg`；最终网络日志为 200 `image/svg+xml`、0 loading failure | [最终 smoke 摘要](web-rendering/evidence/runtime-smoke-summary.json) |
| WebGL context 丢失后缺少恢复反馈 | canvas 未监听 context lost / restored | 丢失时停止推进、清输入与 ready 标记并显示恢复卡；恢复后自动 reload | [WebGL 故障注入摘要](web-rendering/evidence/webgl-context-summary.json) |
| 模型并行加载中卸载可能留下未挂载资源 | `GLTFLoader` promise 完成后只检查 disposed，没有主动释放 | 按关卡清单的模型加载改为 `allSettled`；失败或卸载后统一 dispose 已完成的几何、材质、纹理与骨架 | TypeScript / ESLint / 构建回归 |
| 线上首次开始后 Threat 音乐轨可能晚约 20 秒就绪 | 音频元素遵守首次手势才创建，私有 CDN 冷请求使第二条 stem 尚未缓存 | 3D 加载期间并行 fetch 并完整物化双轨缓存，仍在用户手势内创建 AudioContext / Audio 元素；失败保持可重试退路 | [Sites v13 smoke](web-rendering/evidence/deployed-v13-smoke.json)：两轨 readyState 4、漂移约 1 μs |
| 站点截图机器人额外请求 `/favicon.ico` 产生 404 | 页面显式提供 SVG 图标，但传统 crawler 仍探测 ICO 默认路径 | 增加真实 64 × 64 ICO 与文件签名回归；线上返回 200 `image/vnd.microsoft.icon` | [Sites v13 smoke](web-rendering/evidence/deployed-v13-smoke.json) |
| 上下左右操作会按反，转向后更难判断 | 移动输入直接使用世界坐标，而镜头又持续根据玩家 heading 旋转；不同阻尼还造成残余 bearing 漂移 | 锁定单一世界方位；键盘与触控先按屏幕坐标统一，再由同一固定基向量转换；删除 heading look-ahead 和相机朝向插值 | `tests/input.test.mjs` 的 Three.js 投影用例 + [真实浏览器四向摘要](web-rendering/evidence/camera-visibility-summary.json) |
| 追逐和断视线时坏人凭空消失 | HUD 情报门禁 `canPlayerObserveChaser` 被错误复用于模型透明度、根节点显隐和追逐镜头 | 情报状态只驱动 HUD；玩家暴露时世界模型独立保持 `rootVisible=true / alpha=1`，追逐采用固定方位双人构图；完全藏好时仍按窥视 marker 关闭世界信息 | [追逐截图](web-rendering/evidence/fixed-camera-chase.jpg)、[断视线截图](web-rendering/evidence/chaser-last-known-visible.jpg) 与 [逐帧 / Locker 边界摘要](web-rendering/evidence/camera-visibility-summary.json) |
| 手机竖屏合法追逐间距可能把坏人挤出画面 | 固定 `chaseFocus` 与线性 aspect 补偿没有考虑水平 FOV、模型边距和手动放大 | 追逐焦点采用双方中点，按当前 smoothed focus 逐帧反算最低安全距离；拉远快速响应，手动倍率受安全下限约束 | [390 × 844 六格追逐截图](web-rendering/evidence/mobile-chase-safe-frame.jpg) 与 [缩放前后坐标摘要](web-rendering/evidence/camera-visibility-summary.json) |
| 搜索后重新发现玩家会直接切入追逐，首帧坏人可能仍在竖屏画外 | `lost-sight / go-to-last-known / search / check-hide` 重获目标时没有视觉确认和预构图窗口 | 增加连续 0.2 秒并行确认；原追查移动与计时继续，杜绝短窥视 stun-lock；确认中断时保留新目击点并继续前往，旧搜索超时不得清空证据；可观察时提前双人构图 | [390 × 844 重获追逐截图](web-rendering/evidence/mobile-reacquired-chase-safe-frame.jpg) 与 [逐帧模式 / 画幅摘要](web-rendering/evidence/camera-visibility-summary.json) |
| 搜柜途中短窥视可能取消必查柜体 | 通用可见证据更新会清空 `witnessedHideSpotId`，确认中断又会离开 `check-hide` | 搜柜期间保留强证据与原目标；短窥视关闭后继续走向 / 检查同一柜，只有连续确认成功转 Chase 才清除柜体目标 | `tests/game-simulation.test.mjs` 的 witnessed locker brief-peek 回归 |

若最终 smoke 再发现问题，必须继续追加本表，并执行“修复 → 自动回归 → 实际运行 → 截图复核”的完整循环，不能只修改后口头关闭。

## 7. 最终浏览器冒烟矩阵

| 场景 | 验收点 | 最终证据 |
|---|---|---|
| 首屏与开始 | 页面无报错；本关模型清单和两条音乐资源可达；开始后 Kid 清晰可见 | PASS；[首屏](web-rendering/evidence/desktop-ready.jpg)、[移动后](web-rendering/evidence/desktop-gameplay.jpg) |
| 移动与碰撞 | WASD / 方向键与四个触控按钮始终对应屏幕上下左右；墙体与大型实体碰撞可靠；滑墙朝向取实际位移；连续转向不改变镜头方位 | PASS；键盘/触控八组真实输入方向点积均为 1.0000，实际 bearing 误差 < 1e-9；[移动端截图](web-rendering/evidence/fixed-camera-mobile-controls.jpg) |
| 相机遮挡与恢复 | 障碍只局部淡出；人物不丢失；离开后材质恢复且不残留透明 | PASS；[遮挡视角](web-rendering/evidence/camera-occlusion.jpg)，峰值 strength 约 1，离开后回到约 0 |
| Locker 进入 | 对齐转身、开门、进入、关门顺序完整；角色不穿柜；隐藏后不可见 | PASS；0.6 秒转身，hidden `rootVisible=false / alpha=0`，[截图](web-rendering/evidence/locker-hidden.jpg) |
| 窥视与退出 | 按住才窥视；释放后关门；门关闭前后视觉暴露与 AI 证据一致；可正常退出继续移动 | PASS；zero-open alpha / mask 均为 0，full peek alpha / mask 均为 1，[截图](web-rendering/evidence/locker-peek.jpg) |
| 丢失、搜索与重获 | 追逐者失去 LOS 后先去最后已知点，再盲目搜索；不会追踪隐藏坐标；情报变未知时世界模型不再被程序删除；重新发现玩家先并行确认再追逐 | PASS；真实路线覆盖 `chase → lost-sight → go-to-last-known → 0.2s confirmation → chase`；重获 Chase 首帧 Villain / Kid 均在竖屏 0.1–0.9 安全区，[截图](web-rendering/evidence/mobile-reacquired-chase-safe-frame.jpg) |
| 被抓 | Catch / Caught 演出可读，结果层延迟正确，重开恢复完整初始状态 | PASS；0.26 秒 staging 后双角色正式动作，[截图](web-rendering/evidence/capture-performance.jpg) |
| 逃脱 | 抵达警察局触发 Police / Kid 正式动作与胜利层，重开正常 | PASS；Kid Celebrate + Police Resolve，[截图](web-rendering/evidence/escape-performance.jpg) |
| 自适应音乐 | 用户交互后 AudioContext 为 running；两 stem 同步；危险混音与静音正常；无解码错误 | PASS；两轨 38.02 秒、readyState 4、media error null，常态漂移为微秒级，长路线重开约 5.3 ms |
| 手机竖屏 390 × 844 | HUD、摇杆、交互、窥视、静音与重开均不遮住关键画面；横向相隔六格、最大手动放大和搜索后重获追逐均保持双人安全画幅 | PASS；scroll 与 viewport 同尺寸，触控热区至少 44 px；[布局截图](web-rendering/evidence/mobile-portrait.jpg)、[六格追逐](web-rendering/evidence/mobile-chase-safe-frame.jpg)、[重获追逐](web-rendering/evidence/mobile-reacquired-chase-safe-frame.jpg) |
| 手机横屏 844 × 390 | 画面和触控区不重叠；可开始、移动、交互和重开 | PASS；设备仿真布局与真实 touch 事件路径通过 |
| 线上私有地址 | TLS 与鉴权正常；首页、29 个 GLB、双轨 M4A、manifest、notices 和图标可达；真实 Chrome 可解码、可交互且无 4xx / 5xx | PASS；Sites v13、[运行截图](web-rendering/evidence/deployed-v13-final.jpg)、[结构化 smoke](web-rendering/evidence/deployed-v13-smoke.json) |

本地 smoke 使用 Chrome 150、WebGL 2、ANGLE Metal（Apple M5 Max）。5 秒 active rAF：桌面 120 FPS（median 8.3 ms / p95 9.7 ms / max 10.4 ms），竖屏 120 FPS，横屏 120.2 FPS；三组均无帧超过 20 ms。典型桌面约 457 draw calls / 1.628M triangles，遮挡峰值约 526 / 2.010M，离开遮挡后恢复基线。最终控制台 warning / error、exception、HTTP ≥ 400 与 `Network.loadingFailed` 均为 0。证据目录见 [`docs/web-rendering/evidence/`](web-rendering/evidence/README.md)。

## 8. 已知警告、限制与不可误报项

### 8.1 Validator 信息项

`@gltf-transform/cli 4.4.1 validate` 已对 23 / 23 个环境运行 GLB 完成逐文件验证，全部 exit 0。聚合 severity 结果如下；warning 和 information 均不得误称为 error：

| Severity | 数量 | 分类 |
|---:|---:|---|
| 0 — Error | 0 | 无 |
| 1 — Warning | 0 | 无 |
| 2 — Information | 218 | `UNSUPPORTED_EXTENSION` 23；`URI_GLB` 152；`UNUSED_OBJECT` 31；`UNUSED_MESH_TANGENT` 12 |
| 3 — Hint | 0 | 无 |

上一轮的 1,572 条 `MESH_PRIMITIVE_GENERATED_TANGENT_SPACE` 已全部清零。所有 Normal Map primitive 都随包携带与 `POSITION` 数量一致的有效 `TANGENT`，不再依赖不同浏览器自行生成 tangent space。当前 severity 2 仅为信息项：

- `UNSUPPORTED_EXTENSION`：当前 Validator 版本不解析 `EXT_meshopt_compression`，但 Three.js 已注册官方 Meshopt decoder，浏览器双路径 smoke 通过；
- `URI_GLB`：公用资产有意从 GLB 复用同一组外部 PBR 纹理，避免跨文件重复嵌入；
- `UNUSED_OBJECT` / `UNUSED_MESH_TANGENT`：为压缩容器记录和 Locker 无 Normal Map primitive 的冗余属性提示，不影响结构与渲染。

当前已执行设备上的实机浏览器渲染验证正常：未观察到材质闪烁、黑面、法线方向异常、蒙皮错位或动作层级失效。这一结果只关闭上述兼容警告，不扩大第 8.2 节所列的低端手机实机覆盖范围。

### 8.2 移动端实机限制

390 × 844 与 844 × 390 的桌面 Chrome viewport 自动化只能验证布局和触控事件路径，不能证明低端 Android 或旧 iPhone 的真实 GPU 内存、热降频、Safari 音频策略和持续帧率。最终发布可先通过桌面 smoke，但以下内容必须明确保留为后续实机矩阵，不能写成“完全覆盖”：

- 至少一台 iPhone Safari 与一台中低端 Android Chrome；
- 冷缓存首次加载、弱网重试、切后台再恢复；
- 10 分钟连续游玩后的峰值内存、帧率与温度；
- 手机扬声器 / 耳机的双 stem 循环和切换听感；
- 触控边缘、系统手势冲突与横竖屏旋转。

### 8.3 体积与性能风险

当前 `public/` 为 50,973,478 bytes（48.61 MiB），三个角色约 29 MiB，运行场景以画质优先且尚未引入角色 LOD / KTX2。无量化 Meshopt 在不简化三角面、不改写纹理字节的前提下，把四套主题包从 9,824,920 bytes 降到 5,731,664 bytes，把 18 个公用环境模型从 4,055,108 bytes 降到 2,185,108 bytes。桌面运行统计已记录在第 7 节；低端移动设备若出现内存或首屏等待问题，应优先采用分阶段加载、KTX2 和经视觉对比验收的 LOD，而不是删除正式模型、降低身份贴图或回退到几何占位体。

### 8.4 依赖审计边界

发布硬门禁是 `npm audit --omit=dev` 无生产漏洞。开发依赖中的构建工具若仍存在上游 advisory，必须在最终报告记录数量、影响范围和是否可被生产访问；不得把仅影响本地工具链的问题误报成线上运行漏洞，也不得因此省略后续升级计划。

## 9. 提交、部署与线上复核

1. 最终自动回归通过后，记录 `git status`、差异范围和资产哈希。
2. 提交并推送 `codex/top-tier-web-vertical-slice`，回填 Commit SHA 与远端分支。
3. 使用该 Commit 构建并保存 Sites 版本，保持既定私有访问策略。
4. 部署完成后验证首页、全部模型、音乐、manifest、OG 图和 third-party notices。
5. 对线上版本重复关键 smoke，至少保存首屏、移动、遮挡、隐藏、窥视、搜索、被抓、胜利和移动端布局证据。
6. 任何线上差异都必须返工、重新提交、重新构建和重新部署，不允许只在本地报告 `PASS`。

| 发布项 | 最终值 |
|---|---|
| 远端分支 | `codex/top-tier-web-vertical-slice` |
| 部署运行 Commit SHA | `a23abcf5e0331155e5c01a288962c48bba587241` |
| Sites version ID | `appgprj_6a562ff04ac081918664612f375c3fda~appgver_d8084602f2a48191b77a0e40e51d5efd`（v13） |
| Deployment ID | `appgdep_6a60c8db8c2481919189964709f3a710` |
| 线上 smoke 时间 | `2026-07-22 21:47`（Asia/Singapore） |
| 最终截图 | `docs/web-rendering/evidence/deployed-v13-final.jpg` |
| 最终结论 | `PASS`；线上技术验收关闭，等待用户主观体验 REVIEW |
