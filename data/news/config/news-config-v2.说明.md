# news-config-v2.json 配置说明

> 热点管线 v2 的全部业务开关集中在此文件。**JSON 不支持注释**，故用本表说明每个配置项的含义、默认值、单位与影响。
> 改动配置后重跑 `node scripts/build-news.js --min` 生效。

## schedule —— 抓取周期与时刻

> 注意：`*_cron` 值是 **UTC**（GitHub Actions 的 `schedule` cron 固定按 UTC 执行，不支持指定时区）；`*_tz` 表示意图时区（北京时间）。下表同时列出意图的北京时间时刻。此段为声明性记录，实际调度在 `.github/workflows/collect-news.yml`（cron 与此处保持一致）。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `youtube_cron` | `"0 12 * * *"` | YouTube 抓取 cron（UTC 值；意图北京时间每天 20:00 触发，管线内 72h 到期闸决定是否真正采集）。不用 `*/3` 的原因：`*/3` 是月历日（1,4,…,28,31），月末出现 31→1 背靠背 |
| `youtube_interval_hours` | `72` | YouTube 两次调度采集的最小间隔（小时）。距上次「调度触发」成功采集不足该间隔 → 当次跳过（`not_due`）。仅调度运行受闸并写状态；手动/本地运行不受闸、不写状态 |
| `youtube_tz` | `"Asia/Shanghai"` | YouTube 抓取意图时区（北京时间） |
| `youtube_window_days` | `3` | YouTube 采集窗口天数（回看 N 天内的新视频） |
| `x_cron_hot` | `"30 0 * * *"` | X 热半区抓取 cron（UTC 值；北京时间每天 08:30 触发，覆盖前一日 20:00 至当日 08:00 发布高峰） |
| `x_cron_cold` | `"30 12 * * *"` | X 冷半区抓取 cron（UTC 值；北京时间每天 20:30 触发，覆盖当日 08:00 至 20:00 白天发布） |
| `x_tz` | `"Asia/Shanghai"` | X 抓取意图时区（北京时间） |

X 采集窗口按方案 A 双半区连续覆盖：
- **热半区**：覆盖北京时间 `[前一日 20:00, 当日 08:00)`，08:30 启动；
- **冷半区**：覆盖北京时间 `[当日 08:00, 当日 20:00)`，20:30 启动；
两次采集窗口连续无重叠，去重后合并入单状态轴候选层。调度触发时每次只采 X，不采 YouTube。

## collection —— 配额上限 / 公开数量 / 审核量 / 网络

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 热点采集应用层总开关；仅严格布尔 `true` 启用。GitHub 还要求 Repository Variable `NEWS_COLLECTION_ENABLED=true`，两层任一关闭即零网络、零写入 |
| `youtube_search_max_per_run` | `100` | 每次运行 search.list 调用上限（独立桶 100 次/天硬上限） |
| `youtube_search_cost_units` | `1` | 单次 search.list 配额成本（单位） |
| `youtube_daily_quota_units` | `10000` | YouTube 合并桶每日配额（videos/comments/categories 共享） |
| `youtube_videos_batch_size` | `50` | videos.list 单批查询视频数上限 |
| `youtube_comments_top_n` | `10` | 每条视频抓取的评论数（点赞最高的前 N 条） |
| `youtube_fallback_enabled` | `true` | search 桶耗尽时自动降级 videos.list mostPopular（热门榜，合并桶计费） |
| `youtube_fallback_popular_pages` | `2` | 降级热门榜最多翻页数（每页 50 条） |
| `x_credits_per_hot_run` | `7500` | X 热半区单次运行 credits 硬上限；允许设为 `0` 完全停用，上限 7500 |
| `x_credits_per_cold_run` | `2500` | X 冷半区单次运行 credits 硬上限；允许设为 `0` 完全停用，上限 2500 |
| `x_credits_per_tweet` | `15` | X 单条返回推文 credits 成本；不得低于供应商安全下界 15 |
| `x_credits_per_article` | `100` | X 长文请求单次尝试的 credits 成本；空正文、失败与重试也保留预占，不得低于 100 |
| `x_tweets_per_request_max` | `20` | tweet 请求发出前的最大返回条数预占上界；不得低于供应商单页安全上界 20，超量响应按完整条数结算并停止后续请求 |
| `max_output_items_daily` | `5` | 每日公开热点最大数（无 YouTube 时 = 5，即"3~5"的上限） |
| `min_output_items_daily` | `3` | 每日公开热点目标最小数（R1 拍板，投影不强凑；不足 3 条按实际显示） |
| `max_output_with_youtube` | `8` | 当日有 YouTube 候选进池时公开最大数（"3~8"的上限） |
| `review_top_pure_x` | `10` | 纯 X 日人工审 top N（`min-review list --top` 缺省值） |
| `review_top_with_youtube` | `15` | 有 YouTube 日人工审 top N（同上） |
| `concurrency` | `5` | 并发上限：YouTube 评论抓取 + AI 分类/审核并发池 |
| `request_timeout_ms` | `15000` | 单次网络请求超时（毫秒） |
| `max_retries` | `2` | 网络请求失败重试次数 |
| `retry_base_ms` | `750` | 重试退避基数（毫秒，递增） |
| `twitter_api_base_url` | `https://api.twitterapi.io` | TwitterAPI.io 基地址 |

X 预算采用请求级预占与四桶分配策略（热半区 7,500 = 账号 5,500 + X 发现 800 + Article/重试 750 + 尾部重查 450；冷半区 2,500 = 账号 1,300 + X 发现 300 + Article/重试 300 + 尾部重查 600）：tweet attempt 先按 `x_tweets_per_request_max × x_credits_per_tweet`（20 × 15 = 300 credits）预占，成功后按全部返回条数结算（窗外、重复和无效条目仍属于平台计费返回；空响应按供应商最低 15 credits）；article attempt 每次预占 100，重试独立计入。失败或无法解析的请求不退款，以避免本地账本低估后台费用。两次标准 cron 配置合计 10,000 credits。

## long_term_quality —— 来源长期质量分

| 字段 | 默认值 | 说明 |
|---|---|---|
| `observation_period_count` | `3` | 观察期：频道视频数 ≤3 走观察分（20–60） |
| `observation_score_range` | `[20, 60]` | 观察分区间（三率加权压缩映射） |
| `window_n` | `10` | 长期分滑动窗口取最近 N 个样本 |
| `window_months_youtube` | `6` | YouTube 长期分窗口时限（月，超过不计入） |
| `window_months_x` | `2` | X 长期分窗口时限（月） |
| `min_samples` | `5` | 样本数 ≥5 走真实长期分（0–100）；3~4 走观察分；<3 中性 |
| `neutral_score` | `50` | 样本不足时长期分中性值 |

## review —— 审核档位

| 字段 | 默认值 | 说明 |
|---|---|---|
| `l1_input_include_comments` | `true` | L1 AI 审核是否把点赞最高 N 条评论拼进输入 |
| `l1_comments_top_n` | `10` | L1 审核取评论条数（点赞最高前 N） |
| `l1_confidence_auto_discard` | `0.9` | L1 判 discard 且置信度 ≥ 此值才自动剔除 |
| `l2_enabled` | `true` | 是否生成 L2 AI 辅助建议（供人工参考，不自动改状态） |

## keywords —— 关键词表与提纯

采用三用途关键词与独立排除词架构：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `content_keywords` | `[36 词]` | 高信号 AI 内容词：L0 硬过滤判定与内容候选匹配基准，剔除宽泛泛称（如 model/code/google/meta 等），聚焦实体与核心词 |
| `youtube_queries` | `[20 词]` | YouTube 视频搜索短语列表，精选高信号搜索词 |
| `x_discovery_queries` | `[4 对象]` | X 关键词发现受控对象数组（`{ id, query, max_pages }`）；时间条件由采集器统一追加，禁止手写时间操作符，单条 ASCII ≤ 768，首期 max_pages=1 |
| `excluded_content_keywords` | `[5 词]` | 内容负向硬排除词列表，命中即剔除；禁止与 content_keywords 重叠 |
| `excluded_youtube_queries` | `[]` | YouTube 搜索排除词列表；禁止与 youtube_queries 重叠 |
| `excluded_x_discovery_queries` | `[]` | X 发现排除词列表；禁止与 x_discovery_queries 重叠 |
| `refine_rule_top_n` | `30` | 规则提纯筛选 top N 候选 |
| `refine_batch_size` | `8` | 提纯每批处理候选数 |
| `refine_max_output` | `20` | 提纯最大输出建议词数 |
| `refine_timeout_ms` | `600000` | 提纯操作超时（毫秒） |

## x_accounts —— X 博主名单

`[52 个 handle]`：X 采集的全量博主名单（经最新清理，包含头部模型机构、国内厂商、工具生态与评测社区账号）。

## account_groups —— 账号分组（7 组）

采用 7 组结构组织 X Advanced Search，每组具备稳定 `id`、优先级 `priority` (1..7) 与 `max_pages`：

| 组 ID | 名称 | 账号数 | 特点 |
|---|---|---|---|
| `g1` | 头部模型与研究机构 | 9 | OpenAI, AnthropicAI, GoogleDeepMind, GoogleAI, AIatMeta, SpaceXAI, MistralAI, cohere, MicrosoftAI |
| `g2` | 中国 AI 厂商 | 7 | TencentHunyuan, Alibaba_Qwen, deepseek_ai, Zai_org, Kimi_Moonshot, StepFun_ai, Baidu_Inc |
| `g3` | AI 产品、助手与编程工具 | 9 | ChatGPTapp, claudeai, GeminiApp, perplexity_ai, HeyGen, v0, devindesktop, cursor_ai, cognition |
| `g4` | 图像、视频、音频生成 | 12 | midjourney, StabilityAI, bfl_ai, LumaLabsAI, runwayml, pika_labs, ideogram_ai, ElevenLabs, suno, Kling_ai, Hailuo_AI, ViduAI_official |
| `g5` | 推理基础设施与模型平台 | 6 | GroqLLC, togethercompute, cerebras, OpenRouter, upstageai, huggingface |
| `g6` | 评测、开源与社区 | 4 | lmsysorg, ArtificialAnlys, simonw, btibor91 |
| `g7` | 高频隔离（极小组） | 5 | `xiaohu`, `testingcatalog`, `emollick`, `nima_owji`, `NVIDIAAI`；`high_frequency=true`，单次请求容易占满结果，单独隔离调度 |

**严格一致性约束**：所有组 handles 的并集与 `x_accounts` 严格一一对应（不多不少不重复，fail-closed）。

## feedback —— 工具/概念反哺

| 字段 | 默认值 | 说明 |
|---|---|---|
| `tool_feedback` | `true` | 从 approved summary 提取工具名 → 比对工具库 → 缺则待补卡 |
| `concept_feedback` | `true` | 从 approved summary 提取概念名 → 比对概念库 → 缺则待补卡 |
| `llm_extract` | `true` | 用 DeepSeek 提取实体（方案 A：整段摘要 + 完整名 + 排除泛称/人名/机构 + 检查遗漏；无明确名称输出空）。`false` 回退默认正则。需配置 `DEEPSEEK_API_KEY`，否则自动回退正则 |
| `llm_model` | `deepseek-v4-flash` | LLM 提取用的模型（结构化 JSON，须支持 Responses 协议） |

## transcripts —— 字幕通知

| 字段 | 默认值 | 说明 |
|---|---|---|
| `notify_count` | `"3to5"` | 每次通知字幕的视频数区间（`"3to5"` 取低值 3；数值原样取） |

## scoring —— 评分权重

| 字段 | 默认值 | 说明 |
|---|---|---|
| `weights.long_term_quality` | `0.20` | 长期专业质量权重 |
| `weights.recent_timeliness` | `0.15` | 时效权重（指数衰减） |
| `weights.light_user_experience` | `0.05` | 轻度用户体验权重（实测/上手等信号词） |
| `weights.source_reliability` | `0.15` | 来源可靠性权重（仅 X，看认证；YouTube 并入长期质量） |
| `weights.interaction_quality` | `0.15` | 互动质量权重（三率：综合参与率主 + 赞评比修正 + 点赞率最小加分） |
| `weights.type_preference` | `0.30` | 类型偏好权重（实用 > 技术，最高项） |
| `type_preference_score.*` | 见下表 | 各内容类型的类型分 |
| `neutral_score` | `50` | 评分中性兜底值 |

**type_preference_score**（类型偏好分，对应权重 0.30）：

| 类型 | 分 | 含义 |
|---|---|---|
| `ai_tool` | 90 | AI 工具（实用，最高） |
| `ai_product` | 90 | AI 产品（实用，最高） |
| `ai_concept` | 70 | AI 概念 |
| `ai_industry` | 60 | AI 行业事件 |
| `ai_technology` | 50 | AI 技术/论文（实用度低，最低） |
| `other` | 30 | 其他 |
| `unclassified` | 30 | 未分类 |

## manual_folder —— 人工维护文件夹

`"data/manual"`：需人工修改的内容（字幕清单 / 关键词提纯候选 / 待补工具卡）统一输出到此目录，固定格式生成，入库但不发布到站点。
