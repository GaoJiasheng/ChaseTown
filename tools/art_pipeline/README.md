# 离线美术工具

这里保存 Blender 导出、模型检查和历史生成脚本，不进入 Web 构建。当前仓库采用精简母版策略，部分历史生成入口会重新创建已删除的候选目录，因此默认不应作为日常构建步骤运行。

当前可信边界：

- 游戏运行资产：`public/models/`
- 可编辑母版：`art-source/`
- 运行完整性：`npm test`

## Web 运行资产压缩

`compress_runtime_assets.py` 是正式 GLB 导出后的最后一步：

```bash
python3 tools/art_pipeline/compress_runtime_assets.py \
  --source public/models \
  --output public/models \
  --report /tmp/chasing-runtime-assets.json
```

- 29 个 GLB 由随仓库保存的 `gltfpack 1.2.0` 执行 Meshopt 几何压缩和量化；保留命名节点、材质、extras、顶点属性和角色骨架。
- 26 张共享贴图保留 512px 运行分辨率，转为 WebP：颜色贴图质量 85，法线贴图质量 90。
- GLB 仍保留 `.png` 外链语义，并生成 256px 真实 PNG 兼容回退；正式游戏会把请求统一定向同名 WebP。这使旧版 DCC/完整性检查仍可读，不会让兼容文件进入正式首屏网络路径。
- 脚本只读取它收到的导出目录，不读写 `art-source/`。在重新生成未压缩 GLB 后运行，不要对已压缩的产物反复转码。

`vendor/gltfpack/` 只是离线构建工具，不会进入 Web bundle；其版本和许可证与脚本一起锁定，避免构建时临时下载。

如需重新启用一条历史生成路线，先在仓库外的工作目录产出和评审，只把最终母版或游戏实际引用的结果提交回来。

## A1 角色动画资产

三套运行时角色的 9 个共享动作由下面的确定性入口生成：

```bash
python3 tools/art_pipeline/build_character_animation_assets.py
```

该入口先独立导入 `Rig_Humanoid_Shared.fbx` 取得 canonical rest，再用干净场景逐个真实导入
`art-source/_Shared/Animations/Anim_*.fbx`。每个 FBX 都在它自己的 armature 上逐帧评估，用
`inverse(canonicalRestLocal) * poseLocal` 提取旋转增量，然后写成 `targetRest * delta`。
不会把 Action 挂到其他 FBX 的骨架上；非转身动作依照 root-motion-off 约定固定 Hips，
左右转身则以各自首帧 Hips 归零，并把 Blender Z-up 下的 Z 轴 yaw 转换为
glTF/Three.js Y-up 下的 Y 轴 yaw。管线和最终 GLB 测试都会校验 Run/Walk/LookAround/
ScaredCaught/Celebrate/PointAlert/Turn 的关键帧方向与幅度，避免“有轨道但动作语义错误”。
正式 GLB 只追加 quaternion 动画轨道；原有 Meshopt 几何、材质、图片、蒙皮和二进制前缀保持不变。
动画压缩采用恒定轨道剔除与 0.001 弧度误差的关键帧精简，不重新打包角色几何。

脚本会强制检查 29 个 GLB 文件数、12MB 总量、6MB 完整首屏、三角色静态结构/二进制哈希、
官方 `gltf-validator@2.0.0-dev.3.10` Error=0，并输出
`art-source/_Shared/Animations/Reports/A1_runtime_animation_report.json`。只有从旧提交恢复动画前基线时才使用
`--base-ref <git-ref>`；正常重复运行不需要该参数且必须得到相同角色文件哈希。
