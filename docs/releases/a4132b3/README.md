# Release `a4132b3`

> 记录状态：CONFIRMED
> 确认日期：2026-07-26
> 记录性质：不可变发布摘要

| 项目 | 已确认值 |
| --- | --- |
| Git commit | `a4132b30e4ae9095a461f820b000c65fe860e349` |
| Git branch | `codex/top-tier-web-vertical-slice` |
| Sites project | `appgprj_6a562ff04ac081918664612f375c3fda` |
| Sites display version | v28 |
| Production URL | <https://chasing-school-escape.gavingao.chatgpt.site> |
| Access | Private / owner only |

## 发布内容

- 第 2 关“封馆图书楼”升级为两条可独立完成、可中途切换且分别拥有实体出口的正式任务路线。
- 加入由现有书籍美术资产提取的可投掷笔记本诱饵，并完成库存、冷却、引信、声音证据、调查回执与重复使用衰减闭环。
- 任务进度、路线精通和个人幽灵统一到固定 tick 语义事件；30/60/120/144 Hz 下任务承诺完成 tick 一致。
- 完成桌面与 360/390 px 手机端交互打磨，任务执行期间相机控制自动退出命中层，所有可见触控目标不小于 44 px。
- 新增长期产品与技术路线图、发布来源绑定和专项视觉回归。

## 发布验证

- 全量单元测试：424/424 通过。
- TypeScript、ESLint、生产依赖审计、工具依赖审计和差异完整性检查通过。
- 两次确定性生产构建通过：71 个客户端文件，manifest 前缀 `34e7e589d9d8`。
- 提交绑定的图书馆专项回归：10 张截图；两条路线、真实结果页换路、诱饵生命周期、20 次重置资源回收及窄屏交互态通过。
- 提交绑定的深度回归：17 张截图；四主题、三种躲藏、任务链和桌面/手机态通过；运行异常、控制台错误、严重日志均为 0。
- 两份报告均记录完整 commit，且 `dirty=false`、`changedEntryCount=0`。

## 已知非阻断技术债

- 主游戏 chunk 仍有大于 500 kB 的构建提示。
- eager 首屏预算余量约 0.54 MiB，后续扩展前应先拆包。
- 当前确定性逐文件比较覆盖客户端产物；server 与 hosting metadata 尚待纳入同等级哈希门禁。
