# 概念图来源与权利记录

> 审计日期：2026-08-31
>
> 范围：`art-source/Concepts/` 下 8 个已跟踪 PNG
>
> 状态：**仅供项目内部参考；公开发行前必须完成权利确认或替换**

本文只记录仓库内可以复核的事实，不构成法律意见。文件存在于 Git、被后续美术制作引用，或带有生成服务元数据，都不等于已经证明作者身份、版权归属、输入素材权利或公开发行授权。

## 1. 审计方法与证据边界

- 文件身份：对当前 Git 跟踪文件执行 `shasum -a 256` 与字节统计。
- 首次入库：对每个路径执行 `git log --diff-filter=A --format=... -- <path>`。8 个文件均首次出现在提交 `eafa8221258482f3546100a98b8abe120f34e8ce`，提交时间为 `2026-07-15T13:44:01+08:00`，提交说明为 `Initialize Chasing Web 3D game`。该提交只证明文件何时进入仓库，不证明提交者是图像作者或权利人。
- 生成元数据：PNG 内嵌 C2PA claim 声明 `c2pa.created`，`softwareAgent.name=gpt-image`、`softwareAgent.version=2.0`、`digitalSourceType=trainedAlgorithmicMedia`；claim generator 为 `OpenAI Media Service API`，同时记录 `org.contentauth.c2pa_rs 0.79.2` 与 C2PA spec `2.2.0`。
- 当前环境没有可用的 C2PA 签名验证器。本记录固定并转录已提交 PNG 中的 claim 字段，但不把“字段可读”写成“签名链已独立验证”。发行前若要把 C2PA 签名有效性作为权利证据，必须用固定版本验证器重新验证并保存报告。
- 仓库全文与 Git 历史未发现这 8 张图的生成 prompt、请求账户/组织、委托或雇佣创作记录、参考图清单、上游 URL 或当时适用协议的留档。`docs/02_Codex外包资产规格.md` 等文件只记录下游用途，不是生成 prompt 或权利证明。
- C2PA claim 未发现可读的 ingredient/placed-source 记录；这不能证明生成时没有使用参考图。因此“是否使用参考图”统一记为**未确认**。

## 2. 逐文件身份与创建记录

| 文件 | SHA-256 | 字节数 | C2PA `created.when` | XMP instance ID |
|---|---|---:|---|---|
| `00_art_direction_overview.png` | `de1434f93c8ecadd3d78c5a6d4fc58f3e08c126323a60cbcb00f5e67dce8b3dc` | 2,463,648 | `2026-07-11T00:00:00Z` | `xmp:iid:1e365f85-b932-4cf0-a95a-d4dacf16e488` |
| `01_kid_character_sheet.png` | `13d96f94936df69ed1f793202b1235e4250e62b9e0f1b447ed45bd15ea4c2017` | 2,227,358 | `2026-07-11T00:00:00Z` | `xmp:iid:b519c248-7c32-4d78-a849-d1ed022af7da` |
| `02_villain_character_sheet.png` | `10fcd9c3efb41df29e52a1c85625ac8c9a3be67217edf7fa3a937237e05b49f3` | 2,267,110 | `2026-07-11T00:00:00Z` | `xmp:iid:b4756c13-0774-4d3f-a76c-c7d783a0890f` |
| `03_police_character_sheet.png` | `a551266ed8458d8f256236425d971a4437050b5c8d5a235db4d51dc08dcc6ae2` | 2,275,478 | `2026-07-11T00:00:00Z` | `xmp:iid:b05bc249-8bd1-4274-880a-12a333a5443f` |
| `04_school_environment_sheet.png` | `3ad670508b69a57e7ec6e0c27409c4605d521f12d471539e3cdcff376d30c891` | 2,523,024 | `2026-07-11T00:00:00Z` | `xmp:iid:d316a46c-02f4-4dc9-b318-f7a2a9c11ae7` |
| `Rework_2026-07-12/01_kid_high_bar_model_sheet.png` | `48006416cdbd4ee9458b1f085f1375f91c0d91623d302b22c071bcce5ee5c13d` | 2,210,861 | `2026-07-12T00:00:00Z` | `xmp:iid:3024e786-ee15-4dc4-96eb-145539bf01c6` |
| `Rework_2026-07-12/02_villain_high_bar_model_sheet.png` | `130ed1d1edaebd72b1414f5e93bb27fe13fac9ac74d6e0e3bca3caba885cc451` | 2,239,184 | `2026-07-12T00:00:00Z` | `xmp:iid:e144445b-41ca-40f1-aeff-2005cffa9fab` |
| `Rework_2026-07-12/03_police_high_bar_model_sheet.png` | `db22860000ccc18f2f4cf9f1c329f2e1b5502aa2d677c286b04b993bad0ea573` | 2,101,639 | `2026-07-12T00:00:00Z` | `xmp:iid:8a5329a4-6ef9-458c-ad4a-1779c1da14a3` |

表中的时间是 PNG 内嵌 C2PA claim 自述的创建时间，不是独立第三方时间戳。原始 5 张文件的本地文件时间为 2026-07-11，返工 3 张为 2026-07-12，与 claim 日期一致；文件系统时间本身仍可被修改，不能单独证明作者或权利。

## 3. 逐图来源与权利状态

以下 8 项共享同一组已证实与未确认事实，但分别列项，避免用一张图的证据替代另一张图：

| 文件 | 生成/绘制方式 | prompt | 参考图 | 服务条款适用情况 | 当前可确认的权利状态 |
|---|---|---|---|---|---|
| `00_art_direction_overview.png` | 内嵌 claim：OpenAI Media Service API / gpt-image 2.0 / trained algorithmic media | 来源不可还原 | 未确认 | 请求账户、组织及生成时适用协议未留档，无法确认 | 来源链不完整；公开发行未就绪 |
| `01_kid_character_sheet.png` | 同上 | 来源不可还原 | 未确认 | 同上 | 来源链不完整；且被 Kid 视觉制作引用，公开发行未就绪 |
| `02_villain_character_sheet.png` | 同上 | 来源不可还原 | 未确认 | 同上 | 来源链不完整；且被 Villain 视觉制作引用，公开发行未就绪 |
| `03_police_character_sheet.png` | 同上 | 来源不可还原 | 未确认 | 同上 | 来源链不完整；且被 Police 视觉制作引用，公开发行未就绪 |
| `04_school_environment_sheet.png` | 同上 | 来源不可还原 | 未确认 | 同上 | 来源链不完整；且被环境制作引用，公开发行未就绪 |
| `Rework_2026-07-12/01_kid_high_bar_model_sheet.png` | 同上 | 来源不可还原 | 未确认 | 同上 | 来源链不完整；公开发行未就绪 |
| `Rework_2026-07-12/02_villain_high_bar_model_sheet.png` | 同上 | 来源不可还原 | 未确认 | 同上 | 来源链不完整；公开发行未就绪 |
| `Rework_2026-07-12/03_police_high_bar_model_sheet.png` | 同上 | 来源不可还原 | 未确认 | 同上 | 来源链不完整；公开发行未就绪 |

OpenAI 当前公开的 [Terms of Use](https://openai.com/policies/terms-of-use/) 与 [Service Terms](https://openai.com/policies/service-terms/) 不能替代生成时账户协议的证据。仓库没有保存这批请求究竟受个人 Terms of Use、OpenAI Services Agreement、其他企业协议还是额外服务条款约束，也没有保存请求主体对输入拥有必要权利的证明。因此本记录不对输出权利归属作肯定结论。

## 4. 缺口关闭方式

每张图都必须在公开发行前完成以下二选一，不能因为文件未进入运行包就忽略它对最终设计的影响：

1. **补证**：由产品方提供可核验的创作/委托记录、请求账户或组织、完整 prompt、参考图清单及其权利、生成时适用服务协议和人工修改记录；产品与法务据此确认可用范围。
2. **替换**：以来源、输入、prompt/绘制过程、工具版本、条款和作者/委托链均可完整记录的新图替换，并把旧图标为 retired；替换及其对衍生模型的影响需另行评估。本批不删除或替换任何概念图。

旧的 Kid/Police 来源文档曾写“生成工具未知”。本次从文件自身恢复了工具、版本和 claim 日期，因此该部分以本文为准；作者、prompt、参考图、请求主体、条款适用性和权利状态仍未解决，旧文档的发行阻断结论继续有效。

## 5. AI 图像版权不确定性（事实记录）

AI 输出是否以及在多大范围内受版权保护，取决于适用司法辖区和具体的人类创作贡献。美国版权局 2025 年报告认为，纯 AI 生成材料或缺少足够人类控制的表达不受美国版权保护；人类创作的选择、编排或修改可能逐案受到保护。WIPO 对国际实践的介绍也指出各法域路径并不一致。参见：

- [U.S. Copyright Office, Copyright and Artificial Intelligence, Part 2: Copyrightability](https://www.copyright.gov/ai/Copyright-and-Artificial-Intelligence-Part-2-Copyrightability-Report.pdf)
- [WIPO, U.S. Copyright Office on AI: Human creativity still matters, legally](https://www.wipo.int/en/web/wipo-magazine/articles/us-copyright-office-on-ai-human-creativity-still-matters-legally-73696)

这只是提醒产品方需要按发行地区审查，不是对本项目图像可版权性或归属的法律结论。
