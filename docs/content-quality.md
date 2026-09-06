# AI 热点质量评估标准

> 人工审核、规则评分和未来 AI 辅助判断的统一口径。本文件定义判定规则，不表示所有能力均已自动实现。

## 1. 判定原则

1. **分离事实、推断和观点**：平台字段与明确披露是事实，规则识别是推断，博主解读是观点。
2. **证据优先**：转载、商单、身份、官方核验和异常判断须附证据；不足时用 `unknown`、`candidate` 或 `needs_review`。
3. **分项可解释**：频率、互动和粉丝量均不直接等于质量，总分必须可展开。
4. **缺失不等于零**：不可获取的信息记为 `null/unknown`，并降低相关判断的置信度。
5. **不误伤正常差异**：低频不降低长期专业质量；质疑、纠错、争论和不同立场可形成有价值观点。
6. **渐进自动化**：AI 只能给出有证据的候选判断，不能直接定性商单、抄袭、事实错误、身份或动机。

## 2. 来源标签与内容类型

来源可同时拥有多个标签：

| 标签 | 主要价值 |
|---|---|
| 横向测评 | 比较使用边界、差异、成本和稳定性 |
| 即时资讯 | 发现产品、研究、政策和行业变化 |
| 深度解读 | 解释机制、背景和长期趋势 |
| 教程实践 | 提供步骤、代码、工作流或复现条件 |
| 行业观点 | 提供政策、商业或社会影响视角 |
| 轻度用户体验 | 补充上手成本、失败、限制和适用人群 |
| 官方来源 | 提供一手公告和事实锚点 |

`cadence_class`（`low_frequency`、`high_frequency`、`unknown`）仅描述发布节奏，不是质量结论。（v1 历史字段，已随 v1 移除；v2 全仓已无此字段。）

内容类型（分类器 `CONTENT_TYPES`）为：`ai_tool`、`ai_product`、`ai_concept`、`ai_technology`、`ai_industry`、`other`、`unclassified`。`youtube_video`/`x_post` 属于 `source_type`（来源形态），不作为内容类型使用。

（v1 历史约定，已随 v1 移除）B站动态与视频、专栏同为一等内容，按原生 ID 去重。v2 仅 YouTube 与 X，去重在采集后用 `platform:native_id`（`dedupeItems`）完成，不按内容类型区分。

## 3. 字段与证据边界

| 类别 | 示例 | 处理 |
|---|---|---|
| 平台事实 | ID、时间、作者、链接、互动量 | 原样保存并记录抓取时间 |
| 明确披露 | 赞助原文、广告标识 | 保存片段和链接，可触发规则 |
| 来源事实 | 官方主页、论文、仓库、产品文档 | 保存可核验 URL |
| 规则推断 | 候选转载、体验信号、主题候选 | 保存规则、证据和置信度 |
| 博主观点 | “该模型更适合编程” | 作为观点保存，不转为事实 |
| 未知信息 | 身份不明、互动缺失 | 使用 `unknown/null`，不猜测 |

## 4. 转载与主题关系

`origin_status`：`confirmed`（有平台标识、原文链接或人工核验）、`candidate`（相似但证据不足）、`unknown`。

`relation`：`original`、`repost`、`commentary`、`translation`、`citation`、`duplicate_observation`。

同一原生内容的重复抓取可合并；转载和评论保留独立记录并通过 provenance 关联。v2 已无 `event/topic_key` 事件聚合：事件聚合与溯源（`buildProvenance`/`buildEvents`）已不在 v2 主链，热点视图 schema 不消费该字段；去重以 `platform:native_id` 为键（`dedupeItems`），min-store 候选层按 id 合并并保留既有审核结论。

## 5. 可解释评分

所有分项归一化为 0—100，v2 评分（`scoring-v2.js`）为六个权重加权：

```text
最终分 = clamp(Σ 权重_i × 分项_i, 0, 100)
权重（news-config-v2.json scoring.weights，合计 1.00）：
  long_term_quality     0.20
  recent_timeliness     0.15
  light_user_experience 0.05
  source_reliability    0.15
  interaction_quality   0.15
  type_preference       0.30
```

权重与半衰期以 `data/news/config/news-config-v2.json` 的 `scoring` 段为准。

- **长期专业质量**：来自 `history-store` 的本地三率统计（`evaluateLongTermQuality`，纯本地不发请求），不按账号名猜身份，不因低频扣分。
- **近期时效性**：采用 `100 × exp(-ln(2) × 年龄天数 / 半衰期)`；半衰期取配置 `scoring.half_life_days`（按首标签），当前配置未设时落回默认固定 7 天（`scoring-v2.js` `DEFAULT_HALF_LIFE_DAYS`）。（旧按内容类型分档的 2/14/21/45 天默认值已随 v1 移除。）
- **轻度用户体验价值**：标题/描述命中体验信号词（实测|上手|使用|体验|教程|工作流，或配置 `light_user_signals`）→ 70，否则 50。
- **来源可靠性**：仅 X 平台评分（认证 → 90，无认证数据 → 中性 50）；YouTube（及非 x 平台）不评此项，该项权重并入长期专业质量，保持权重合计 1.00。
- **互动质量**：单条真实三率加权（`computeThreeRateScore`），与 `history-store` 同一套三率算法。
- **类型偏好**：按 `content_type` 查 `scoring.type_preference_score`（`ai_tool`/`ai_product` 90、`ai_concept`/`ai_industry` 60、`ai_technology` 40、`other`/`unclassified` 50）。

近期沉默只影响当前时效/活跃度，不降低历史内容质量。

## 6. 商业关系与异常

仅在有证据时标记商业关系：

| 证据 | 标签 | 处理 |
|---|---|---|
| 明确赞助声明 | `declared_sponsorship` | 记录证据，按配置有限降权 |
| 平台广告标识 | `platform_ad_label` | 同上 |
| 明确 affiliate 链接 | `affiliate_link` | 同上 |
| 作者披露利益关系 | `declared_interest` | 记录关系和适用范围 |
| 仅推荐产品、无利益证据 | `none_confirmed` | 不扣分 |
| 官方介绍自家产品 | `official_source` | 不自动视为商单，区分事实与宣传 |

判定须保存 `label`、`evidence[]`、`confidence` 和 `penalty`。

（v1 历史约定，已随 v1 移除）v1 曾用中位数 + MAD 或 IQR 做异常检测（`scoring.js` `applyAnomalyDetection`），只提示复核、不自动删除。v2（`scoring-v2.js`）已无 MAD/IQR 异常调整：最终分仅由六权重加权与钳位构成，无商业推广扣分与异常调整两项；互动维度用真实三率（`computeThreeRateScore`）评分。

## 7. 置信度与降级

置信度表示证据完整性（0—1），不等于质量分。

采集状态：`success`（完整）、`partial`（字段缺失）、`failed`（可重试）、`degraded`（达到重试上限或能力受限）。`degraded` 只描述覆盖范围，不代表来源质量下降。

## 8. AI 辅助判断限制

- 输出只可作为候选主题、转载关系、观点、体验信号或商业披露；
- 必须包含证据片段、原文 URL、置信度和无法判断项；
- 不得凭空判断身份、商单、抄袭、事实错误或动机；
- 正常质疑和不同观点不得自动判为低质量；
- 低置信度结果不得影响正式评分；
- 模型、提示词、版本、输入摘要和输出须可追踪；
- 正式启用前须用人工标注样本评估准确率、误报和漏报，并确认调用成本。

## 9. 人工复核与审计

优先复核商业关系候选、来源争议、官方与博主数据冲突、异常互动、标题党、结论冲突、低置信度高影响内容，以及内容重复或类型不明。所有人工调整须保留时间、理由和证据，不静默覆盖自动结果。
