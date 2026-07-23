# 离线美术工具

这里保存 Blender 导出、模型检查和历史生成脚本，不进入 Web 构建。当前仓库采用精简母版策略，部分历史生成入口会重新创建已删除的候选目录，因此默认不应作为日常构建步骤运行。

当前可信边界：

- 游戏运行资产：`public/models/`
- 可编辑母版：`art-source/`
- 运行完整性：`npm test`

如需重新启用一条历史生成路线，先在仓库外的工作目录产出和评审，只把最终母版或游戏实际引用的结果提交回来。

## 角色运行包优化

Blender 重新导出 `kid.glb`、`villain.glb` 或 `police.glb` 后，必须执行：

```bash
npm run art:character-runtime
npm run art:character-runtime:check
```

第一条命令使用仓库锁定的 `gltfpack`，以
`-c -kn -km -ke -noq -af 0 -at 24 -ar 16 -as 24` 生成 Meshopt 运行包。
它不量化角色几何，不改变内嵌贴图，并在替换运行资产前逐一验证命名节点、骨骼、材质、动画片段与时长、包围盒和动画误差。三名角色全部通过后才会写入
`public/models/characters/`，审计结果保存在
`docs/art_production/reports/character-runtime-meshopt.json`。

脚本检测到已经优化的运行包时只做哈希和大小复核，不会重复压缩。要重建资产，应从 Blender 母版重新导出未压缩 GLB，再运行上述命令。

当前没有对角色贴图做 WebP/KTX2 转码：锁定的 Node 版 `gltfpack` 不含 WebP 编码器，KTX2 还需要额外的转码器加载链路与 Safari 真机验证。没有完成这组验证前，保持原始 PNG 字节能避免近景材质退化和浏览器兼容风险。
