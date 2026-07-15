# Chasing

《追逐 / Chasing》是一款运行在浏览器里的 3D 学校迷宫逃脱游戏。玩家控制小孩穿过学校迷宫、甩开追捕者并抵达警察局。项目使用 React、Three.js 与 WebGL，不需要安装桌面游戏引擎。

## 当前目标

- 第一关在桌面与手机浏览器中完整可玩。
- 小孩、坏人和警察都使用正式 3D 角色，而不是几何占位体。
- 写实卡通、完全写实、盲盒潮玩三套美术风格可以在运行时切换。
- 相机根据玩家与追捕者的位置动态调整视野，并允许玩家手动缩放。
- 所有运行时模型使用经过浏览器验证和体积优化的 GLB。

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
npm run build
npm test
```

`npm test` 会先完成生产构建，再验证页面渲染、29 个运行 GLB、外部纹理、角色骨骼和源美术保留清单。

## 操作

- 键盘：`WASD` 或方向键移动。
- 手机：使用屏幕上的方向按钮移动。
- 视野：鼠标滚轮缩放；`0` 恢复默认倍率；追逐过程中镜头也会自动拉远。
- 重开：`R` 或页面中的“重新开始”。

## 仓库结构

```text
app/                         React 页面、Three.js 场景和游戏逻辑
public/models/               浏览器运行时使用的 GLB、贴图和关卡数据
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
