# Chasing

《追逐 / Chasing》是一款运行在浏览器里的 3D 主题迷宫逃脱游戏。玩家控制小孩穿过校园、医院、消防站与工厂，甩开追捕者并抵达安全出口。项目使用 React、Three.js 与 WebGL，不需要安装桌面游戏引擎。

## 当前目标

- 10 关顺序战役在桌面与手机浏览器中完整可玩，覆盖校园 3 关、医院 2 关、消防站 2 关与工厂 3 关。
- 每个主题拥有独立的建筑墙体、PBR 彩色/法线表面、地标道具、灯光、雾效、环境配色与关卡路线；主题包使用 KTX2 贴图，并以内容哈希跨关卡缓存去重。
- 小孩、坏人和警察都使用正式 3D 角色，而不是几何占位体。
- 小孩、追捕者与警察使用统一骨架的正式动作集，移动、追逐、躲藏、搜索与胜负演出均由 `AnimationMixer` 驱动。
- 玩家可以借助遮挡断开视线、进入带真实柜门动画的储物柜、从门缝观察并择机继续逃跑。
- 追捕者只依据视锥、遮挡和已观察证据行动；丢失玩家后前往最后已知位置搜索，不读取隐藏玩家坐标。
- 所有逻辑碰撞点都有同坐标实体模型；可穿越的视线遮挡点显示为主题烟尘/蒸汽，不存在隐形碰撞或隐形断视线。
- 追捕者的 3D 模型始终存在于游戏世界；HUD 是否掌握其状态与模型渲染分离，只允许墙体、深度和柜门视野自然遮挡。
- 探索与威胁音乐使用两条同拍 stem 随 AI 状态连续混音；脚步、柜门、衣料、撞击和结算使用正式 CC0 Foley。
- 相机锁定世界方位，只平滑跟随位置；追逐拉远按 FOV、屏幕宽高比、双方距离和角色安全边距计算，玩家转身不会旋转操作坐标，手动缩放也不会把追捕者挤出安全画幅。断视线后重新相遇会先经过短暂确认并提前构图，再恢复追逐。
- 玩家、追捕者、进出柜和窥视动作统一按原版节奏提速 20%，后续关卡再用克制的追捕者倍率形成难度曲线。
- 所有运行时模型使用经过浏览器验证和体积优化的 GLB；场景内重复 PBR 纹理会归一为共享 GPU 引用。
- 场景和外链纹理共用可取消、20 秒超时、三并发与指数退避加载策略；切关会释放原始 GLB、实例、贴图、动画与 WebGL 资源。

## 本地运行

要求 Node.js `>=22.13.0`。

```bash
npm install
npm run dev
```

按终端输出的本地地址打开页面即可开始游戏。

常用检查命令：

```bash
npm run lint
npm run typecheck
npm run build
npm test
npm run art:runtime-ktx2:check
```

`npm test` 会先完成生产构建，再执行 227 项自动化检查，覆盖页面渲染、26 个按关卡加载的运行 GLB、10 关路线与难度、PBR/KTX2 主题包、角色骨骼与动作、储物柜动画、公平感知、固定步长模拟、自适应音乐、触控输入和源美术保留清单。

## 操作

- 键盘：`WASD` 或方向键按屏幕方向移动；镜头不会随角色转身改变按键含义。
- 手机：拖动连续虚拟摇杆移动，与键盘共享同一屏幕坐标映射；第二根手指不会抢占当前摇杆。
- 躲藏：靠近储物柜按 `E`（手机点“躲藏 / 离开”）；藏好后按住 `Q`（手机按住“观察”）从门缝窥视。
- 视野：鼠标滚轮缩放；`0` 恢复默认倍率；追逐过程中镜头也会自动拉远。
- 暂停：`Esc` 打开暂停面板；关卡计时、AI、动画和主题事件都会冻结。
- 音乐：`M` 切换静音。
- 重开：`R` 或页面中的“重新开始”。

## 仓库结构

```text
app/                         React 页面、Three.js 场景和游戏逻辑
public/models/               浏览器运行时使用的 GLB、PBR 贴图与四套主题包
scripts/                     可重复生成四套主题 GLB 的 Blender 脚本
art-source/                  当前角色 Blender 母版、环境 FBX、动画与概念图
tools/art_pipeline/          模型转换、压缩、贴图和质量门禁脚本
tests/                       构建与页面回归测试
docs/                        GDD、资产规格、验收与优化文档
.openai/hosting.json         Web 托管配置
package.json                 开发、构建、测试与依赖入口
```

目录边界是强约束：

- `art-source/` 只保留仍有编辑价值的精简母版，不会被网页直接请求；历史候选、拒稿、备份和重复导出不进仓库。
- `public/models/` 是唯一的运行时 3D 资产入口；交付物必须为 GLB，并在 Three.js 中通过加载、材质、动画和性能验收。
- `tools/art_pipeline/` 可以读取制作源并生成运行时文件，但不得在应用代码里硬编码源资产路径。

## Web 3D 技术基线

- 应用：React 19、TypeScript、vinext/Vite。
- 3D：Three.js、WebGL 2、`GLTFLoader`、`AnimationMixer`。
- 模型：glTF 2.0 Binary（`.glb`），PBR Metallic-Roughness 材质。
- 输入：Keyboard Events 与 Pointer Events，桌面和触控共用同一移动意图层。
- 部署：由 `.openai/hosting.json` 描述托管项目；生产发布前必须通过 `npm run build` 和 `npm test`。

## 资产接入

1. 在 `art-source/` 中维护当前建模、绑定、动画和必要贴图母版。
2. 通过 `tools/art_pipeline/` 导出并优化为 GLB；需要时执行 Draco/Meshopt 几何压缩与 KTX2 纹理压缩。
3. 把最终文件写入 `public/models/`，同时生成可复核的面数、材质、贴图、动画和体积报告。
4. 在桌面 Chrome/Safari 和手机 Safari/Chrome 中验证：无控制台错误、无 404、材质正确、动画正常、角色可见、帧率达标。
5. 应用只引用 `public/models/...` URL；不得直接加载 `.blend`、`.fbx` 或其他制作源。

详细标准见：

- [`docs/01_游戏设计文档_GDD.md`](docs/01_游戏设计文档_GDD.md)
- [`docs/02_Codex外包资产规格.md`](docs/02_Codex外包资产规格.md)
- [`docs/03_验收Checklist.md`](docs/03_验收Checklist.md)
- [`docs/04_Codex返工规格与验收标准.md`](docs/04_Codex返工规格与验收标准.md)
- [`docs/05_Web版Vertical_Slice_1.0优化实施与验收.md`](docs/05_Web版Vertical_Slice_1.0优化实施与验收.md)
- [`docs/06_Web迁移与美术资产保留清单.md`](docs/06_Web迁移与美术资产保留清单.md)
- [`docs/07_Web版统一优化方案与路线图.md`](docs/07_Web版统一优化方案与路线图.md)
- [`docs/08_躲藏机制与顶级动画执行规格.md`](docs/08_躲藏机制与顶级动画执行规格.md)
- [`docs/09_Web版实施与验证报告.md`](docs/09_Web版实施与验证报告.md)
- [`docs/10_十关主题战役实施与验证.md`](docs/10_十关主题战役实施与验证.md)
- [`docs/12_Web版深度打磨执行与回归方案.md`](docs/12_Web版深度打磨执行与回归方案.md)
- [`docs/web-rendering/evidence/README.md`](docs/web-rendering/evidence/README.md)
- [`docs/art_production/character_web_pbr_postprocess.md`](docs/art_production/character_web_pbr_postprocess.md)
- [`docs/licenses/QUATERNIUS_UNIVERSAL_ANIMATION_LIBRARY_CC0.md`](docs/licenses/QUATERNIUS_UNIVERSAL_ANIMATION_LIBRARY_CC0.md)
- [`docs/licenses/MAKEHUMAN_CORE_ASSETS_CC0.md`](docs/licenses/MAKEHUMAN_CORE_ASSETS_CC0.md)
- [`docs/licenses/POLY_HAVEN_CC0.md`](docs/licenses/POLY_HAVEN_CC0.md)
- [`docs/licenses/APPLE_LOOPS_AUDIO.md`](docs/licenses/APPLE_LOOPS_AUDIO.md)
- [`docs/licenses/KENNEY_AUDIO_CC0.md`](docs/licenses/KENNEY_AUDIO_CC0.md)
- [`public/THIRD_PARTY_NOTICES.txt`](public/THIRD_PARTY_NOTICES.txt)
