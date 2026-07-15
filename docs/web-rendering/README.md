# Web 渲染风格参考

参考图：

- `art-source/Concepts/00_art_direction_overview.png`
- `art-source/Concepts/04_school_environment_sheet.png`

Web 运行时保留三套可切换的视觉预设：

- `stylized`：中等对比、偏暖、柔和阴影。
- `photoreal`：更强的环境遮蔽、真实软阴影与克制的颗粒感。
- `blind-box`：高饱和、柔和辉光、适合塑料材质的干净布光。

验收要求：

- 风格切换后，角色与环境仍然属于同一视觉世界。
- 学校起点的冷色氛围与警局出口的暖色安全提示均清晰可读。
- 桌面与移动浏览器均保持稳定帧率，低性能设备可自动降级阴影和后处理。

具体参数与降级策略见 [WEB_RENDERING_PARAMETERS.md](./WEB_RENDERING_PARAMETERS.md)。
