# Web 运行证据

本目录保存 2026-07-22 发布候选的精简、可入库证据。原始 PNG 与逐帧追踪保存在本地 QA 输出目录；仓库只保留关键 JPEG 和结构化摘要，避免让证据显著放大仓库。

## 截图

- `desktop-ready.jpg`：正式角色、校园、Hero Locker、扩大后的默认视野和开始层。
- `desktop-gameplay.jpg`：真实键盘移动后的运行画面。
- `camera-occlusion.jpg`：相机穿越墙体遮挡走廊时的局部透明处理。
- `locker-hidden.jpg`：玩家完全藏好，角色不再穿出柜体。
- `locker-peek.jpg`：正式柜门与 Kid `HidePeek` 动作同步打开观察视野。
- `capture-performance.jpg`：Kid `Caught` 与 Villain `Catch` 双角色演出。
- `escape-performance.jpg`：Kid `EscapeCelebrate` 与 Police `Resolve` 出口演出。
- `mobile-portrait.jpg`：390 × 844 竖屏触控布局。
- `webgl-context-recovery.jpg`：WebGL context 丢失时的可见恢复卡。

## 结构化摘要

- `runtime-smoke-summary.json`：最终桌面、Locker、重开、音频、移动布局和诊断摘要。
- `production-route-summary.json`：默认生产模拟的失败路线、安全躲藏路线、AI 状态序列与重开复位证据。
- `webgl-context-summary.json`：`WEBGL_lose_context` 故障注入、ready 标记清理、恢复 reload、favicon 与 diagnostics。

这些数据证明的是当前机器上的真实 Chrome / WebGL 运行行为。390 × 844 与 844 × 390 为桌面浏览器设备仿真，不替代低端 iOS / Android 物理设备的 GPU、热降频、内存和 Safari 音频策略测试。
