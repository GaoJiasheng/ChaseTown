# Release `49af54c`

> 记录状态：CONFIRMED
>
> 确认日期：2026-07-27
>
> 记录性质：不可变发布摘要

| 项目 | 已确认值 |
| --- | --- |
| Git commit | `49af54cdfea3ba4e6f2207ef0b25dc05c3ce556d` |
| Git branch | `codex/top-tier-web-vertical-slice` |
| GitHub CI | [run 30241495871](https://github.com/GaoJiasheng/ChaseTown/actions/runs/30241495871) — succeeded |
| Sites project | `appgprj_6a562ff04ac081918664612f375c3fda` |
| Sites display version | v30 |
| Sites deployment | `appgdep_6a66f5c1911081919431ff108c2c1513` |
| Production URL | <https://chasing-school-escape.gavingao.chatgpt.site> |
| Access | Private / owner only |

## 发布内容

- 第 4 关“午夜门诊”升级为药房授权与应急供电两条独立计划，分别拥有任务链、真实操作成本与实体出口。
- 潜行搜索升级为最后目击点抵达、左右巡视、冻结公开搜索假设、区域怀疑和合法藏点扰动闭环。
- 三类藏点加入快速 / 谨慎离开、持久物件扰动和另一侧出口，并修复 HUD 固定步同步竞态。
- 新增隐私安全的十秒失败因果复盘，以及医院四选二战术配置、移动端布局和正式任务物件表现。
- 医院高风险交互的暴露窗口改为精确固定步边界采样，不再少一个 1/60 秒 tick。

## 发布验证

- 全量单元、集成与宿主测试：574/574 通过。
- TypeScript、ESLint、生产 / 工具依赖审计、KTX2 资产审计和 staged diff 检查通过。
- 两次确定性生产构建通过：72 个客户端文件，manifest 前缀 `9cd9baf4e749`。
- 提交绑定的医院专项回归：9 张截图；双路线、双出口、四选二配置、真实任务成本与 390 px 移动交互通过。
- 提交绑定的深度回归：17 张截图；四主题、三类藏点、另一侧出口、任务解锁及 360 / 390 px 移动态通过。
- 两份最终报告均绑定完整 commit，且 `dirty=false`、`changedEntryCount=0`；运行异常、控制台错误、严重日志、HTTP / 网络 / 资源加载失败均为 0。

## 已知非阻断技术债

- 首局关键传输为 8,325,694 / 8,388,608 bytes，只余 62,914 bytes；继续扩内容前必须先做流送与分包。
- 主游戏 chunk 仍有大于 500 kB 的构建提示，运行宿主需要增量拆分。
- Ghost v1 新增离柜样式位；当前版本兼容旧记录，但回滚到旧客户端时可能拒绝新记录。
- 医院领域合同允许保留途中切线状态，正式 UI 仍只在准备页 / 结算页开放换线。

该 Sites v30 部署由上述源码 commit 和同一 commit 的部署归档构建；本记录提交本身未重新部署。
