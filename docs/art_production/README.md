# 美术生产输出策略

本目录不再保存批量预览、线框、联系表、下载缓存和旧候选模型。它们曾占用约 328MB，但不参与游戏运行，也不是当前可编辑母版。

当前交付基线：

- 运行资产：`public/models/`
- 可编辑母版：`art-source/`
- 自动化完整性门禁：`tests/model-assets.test.mjs` 与 `tests/art-source.test.mjs`
- 生产工具：`tools/art_pipeline/`

临时评审产物应输出到未跟踪的本地目录；只有成为当前母版或运行依赖后才提交。
