# 热点信息操作全流程

> 本文档逐模块梳理本仓库「AI 热点」从采集、处理、审核到发布的全链路。**所有描述均依据当前源码**（`src/news/**`、`src/content/**`、`scripts/**`、`.github/workflows/**`），以**热点管线 v2**（默认主链）为准。
>
> 2026-08-08：v1 管线（旧重架构：registry/scheduler/quota/candidates 双轴、`build-news.js` 旧编排、`news-sources.json` 来源清单等）已整体删除，v2 是**唯一**主链（构建默认走 `runMin`，`--min` 仅兼容 no-op）。历史背景见 §十六。
>
> 模块入口与职责索引见 [CODEBASE-MAP](../CODEBASE-MAP.md)；运维命令速查见 [operations.md](operations.md)。

---

## 一、整体架构与数据流向

```
外部平台 API（YouTube Data API v3 / TwitterAPI.io）
   │              ← data/news/config/news-config-v2.json（keywords 搜索词 + x_accounts / account_groups 博主名单）
   ▼
采集 v2  src/news/collectors/
   ├─ collector-youtube-v2.js —— search.list 关键词发现（3 天窗口）→ videos.list 补详情
   │        → videoCategories.list 分类名 → commentThreads.list 点赞最高 10 条评论（并发池）
   │        ⚠️ search 独立桶（100 次/天）耗尽 → 自动降级 videos.list mostPopular（合并桶计费）
   └─ collector-x-v2.js —— 账号组 advanced_search + 关键词发现 + 长文 article 补读
          （四桶预算账本 account / discovery / article_retry / tail_recheck：
            热半区 7500 / 冷半区 2500，请求前预占、按返回量结算）
   ▼
去重/过滤  projection.dedupeItems（platform:native_id）+ review-v2.l0HardFilter
   │        缺 title/url/published_at、未命中 content_keywords、命中广告词 → 直接标 discarded
   ▼
分类  content-classifier.classifyCandidate → content_type（L0 规则式 → L1 外部 provider 兜底回退）
   ▼
评分  scoring-v2.assessItemV2（6 权重加权）+ history-store（source-history.json 三率长期质量）
   ▼
审核  review-v2.applyL1Verdicts（L0 硬审 → L1 AI 审 → L2 AI 建议 + 人工；单状态轴）
   ▼
候选层  data/news/runtime/min-candidates.json（单状态轴 pending / approved / discarded）
   ▼
总结/本地化  content-summarizer / content-localizer（只处理 kept 中仍 pending 的候选）
   ▼
每日公开投影  min/daily-projection.buildDailyProjection（approved && top_selected 按天取 top N）
            + pipeline/projection.enrichHotspotProjection（hot_score / evidence_excerpt / related_resources）
            + core/news-public-gate.filterProjectionByWindow（近期窗口 + 公开字段完整）
            → data/news/output/hotspots.json
   ▼
前端  src/web/（i18n 框架：UI 文案 t() 读字典 + 内容 getLocalizedField 读 localizations.zh；
       coverage.collectors.{youtube,x} 采集状态）→ RSS（public/feed.xml 同规则过滤）
```

**关键位置**：
- **唯一构建入口**：`scripts/build-news.js` → `src/news/min/pipeline-min.js` 的 `runMin()`（热点管线 v2 为默认；`--platforms youtube|x` 分时采集；`--fixture` 注入 mock 采集零落盘跑通全链；`--min` 兼容 no-op）。
- **运维入口**：`scripts/news-cli.js` → `src/news/cli/news-cli.js` 的 `main()`（`min-review` 命令组 + `classify preview` / `localize preview`）。
- **发布入口**：`scripts/publish-news.js`（从 v2 候选层重建公开投影，逻辑与 `runMin` 第 10 步同构）。

---

## 二、配置与来源（人工维护）

### 2.1 配置数据文件

| 文件 | 路径 | 说明 |
|---|---|---|
| v2 配置 | `data/news/config/news-config-v2.json` | **热点管线 v2 唯一配置**：采集/评分/审核/收尾全部业务开关 |
| 配置说明 | `data/news/config/news-config-v2.说明.md` | 逐字段含义/默认值/单位（JSON 不支持注释，故用此表） |
| 人工文件夹 | `data/manual/` | 审核清单/字幕清单/提纯候选/待补卡（运行时产物，入库但不发布） |

- **来源名单**：v2 **没有** `news-sources.json`。X 博主名单写在 `news-config-v2.json` 的 `x_accounts`（52 个 handle），并按 `account_groups`（7 个账号组，含 priority / max_pages / high_frequency）轮次调度采集；YouTube 靠 `keywords.youtube_queries` 关键词搜索发现，无固定频道名单。
- 路径常量集中在 `src/shared/paths.js`（`NEWS_FILES` / `DIRS`）。`NEWS_FILES` 现登记键：`configV2 / minCandidates / minCandidatesHistory / sourceHistory / lastRun / scheduleState / hotspots / xCheckpoints`，外加三个关键词提纯清单 `keywordRefine / youtubeQueriesRefine / xQueriesRefine`。

### 2.2 schedule —— 抓取周期（`config.schedule`）

| 字段 | 默认值 | 说明 |
|---|---|---|
| `youtube_cron` | `"13 12 * * *"` | YouTube 每日调度（北京时间 20:13 = UTC 12:13），配合管线内 72h 到期闸（`youtube_interval_hours: 72`）触发实际采集 |
| `x_cron_hot` | `"37 0 * * *"` | X 热半区抓取（北京时间 08:37 = UTC 00:37） |
| `x_cron_cold` | `"43 12 * * *"` | X 冷半区抓取（北京时间 20:43 = UTC 12:43） |
| `youtube_interval_hours` | `72` | YouTube 两次有效采集之间的最小间隔（小时），避免 Actions cron 跨月连续触发缺陷 |
| `youtube_window_days` | `3` | YouTube 回看窗口天数 |

### 2.3 collection —— 配额 / 数量 / 网络（`config.collection`）

- **YouTube**：`youtube_search_max_per_run 100`（search.list 独立桶 100 次/天硬上限）、`youtube_search_cost_units 1`、`youtube_daily_quota_units 10000`（videos/comments/categories 共享合并桶）、`youtube_videos_batch_size 50`、`youtube_comments_top_n 10`。
- **X**：`x_credits_per_hot_run 7500` / `x_credits_per_cold_run 2500`（热/冷半区总额，采集器按四桶拆分预占，见 §4.2）；`x_credits_per_tweet 15` / `x_credits_per_article 100` / `x_tweets_per_request_max 20` 仅由 validate-news 校验下限，实际计费以四桶预算账本为准。
- **公开数量**：`max_output_items_daily 5`（纯 X 日公开上限）、`min_output_items_daily 3`（目标最小数，投影不强凑）、`max_output_with_youtube 8`（有 YouTube 日公开上限，即"3~5 / 3~8"的上界）。
- **审核范围**：`review_top_pure_x 10` / `review_top_with_youtube 15`（`min-review list --top` 与 `ai-top` 的缺省待选项数量）。
- **网络**：`concurrency 5`（评论抓取 + AI 分类/审核并发池）、`request_timeout_ms 15000`、`max_retries 2`、`retry_base_ms 750`、`twitter_api_base_url`。

### 2.4 review / long_term_quality / keywords / scoring / feedback / transcripts / manual_folder

- `review`：`l1_input_include_comments true`（L1 审核把点赞最高 N 条评论拼进输入）、`l1_comments_top_n 10`、`l1_confidence_auto_approve 0.85`（L1 判 approve 且置信度 ≥ 此值自动落 approved）、`l1_confidence_auto_discard 0.9`（L1 判 discard 且置信度 ≥ 此值才自动剔除）、`l2_enabled true`（L2 AI 建议供人工参考）、`web_verify true`（hold/discard 建议联网查证，显式 false 关闭）。
- `long_term_quality`：`observation_period_count 3`（样本 ≤3 走中性）、`observation_score_range [20,60]`（3~4 个样本走观察分）、`window_n 10`（滑动窗口最近 10 个样本）、`window_months_youtube 6` / `window_months_x 2`（窗口时限）、`min_samples 5`（≥5 走真实长期分）、`neutral_score 50`。
- `keywords`：`content_keywords` 36 词（L0 硬过滤判定与提纯基准）、`youtube_queries` 20 条（YouTube 采集搜索词）、`x_discovery_queries` 4 条（X 关键词发现），`excluded_content_keywords / excluded_youtube_queries / excluded_x_discovery_queries` 三段排除词（与正式段重叠即校验失败），`refine_rule_top_n 30 / refine_batch_size 8 / refine_max_output 20 / refine_timeout_ms 600000`（提纯参数）。
- `scoring.weights`（六权重合计 1.00）：`long_term_quality 0.20 / recent_timeliness 0.15 / light_user_experience 0.05 / source_reliability 0.15 / interaction_quality 0.15 / type_preference 0.30`；`type_preference_score`：`ai_tool 90 / ai_product 90 / ai_concept 70 / ai_industry 60 / ai_technology 50 / other 30 / unclassified 30`；`neutral_score 50`。
- `feedback`：`tool_feedback true` / `concept_feedback true`（工具/概念反哺开关）。
- `transcripts`：`notify_count "3to5"`（字幕通知区间，取低值 3）。
- `manual_folder`：`"data/manual"`（需人工修改的清单统一输出目录）。

---

## 三、构建主流程（`runMin`，10 步）

`runMin(options)` 是热点管线 v2 的总指挥（`src/news/min/pipeline-min.js`）。**每步失败不抛错**：降级继续并把原因记进 `coverage`（子模块自身的失败语义已保证：LLM 失败 → 降级对象 / verdict null，绝不 reject）。一次构建完整流程：

1. **采集**（`options.platforms` 缺省 `['youtube','x']` 并行；分时采集传单平台）。各平台失败降级返回空、`coverage.collectors[platform].status='failed'`，不抛错。未启用平台保持 `{ status:'not_run', items:0, error:null }`。
2. **去重**：`projection.dedupeItems` 按 `platform:native_id`（保留先出现者）。
3. **L0 规则硬过滤**（`review-v2.l0HardFilter`）：缺 title/url/published_at、未命中 `content_keywords`、命中广告词、简介命中 AI 生成披露模板（`ai_generated_disclosure`）→ 标 `review_status='discarded'`、`discard_stage='l0'`、`discard_reason`，**不进入分类/评分/审核链**；AI 生成披露按硬排除语义直接不落盘，其余保留为 discarded 审计记录随候选层落盘（不再进入人工审核清单）。记 `coverage.l0_dropped`。
4. **分类**：对过 L0 的每条 `classifyCandidate` 填 `content_type`（失败留 unclassified，不阻塞），按 `config.collection.concurrency` 并发。
5. **评分**：先 `appendSamples` 把本轮 metrics 追加进历史库并 `writeHistoryStore`（source-history.json），再对每条 `assessItemV2`（`sourceKey` 用 `history-store.sourceKeyOf`，保证写/查同 key）。
6. **L1/L2 审核**：`review-v2.applyL1Verdicts` → `{ kept, discarded }`。审核失败降级：全部保留为 pending（AI 审核失败绝不误杀）。
7. **候选落地**：`mergeCandidatesMin(store, [...kept, ...discarded, ...l0Failed])` → `writeMinStore`。已存在候选保留既有 `review_status` / `top_selected` / `reviewed_at`（人工结论不因重新采集被重置）。
8/9. **总结 + 本地化**：只处理 kept 中仍 `pending` 的候选（`summarizeCandidates` / `localizeCandidates`，自动 approved/discarded 不进入，避免为确定性结果消费 token）。随后按顺序落盘：`writeHistoryStore`（source-history.json）→ `writeMinStore`（min-candidates.json）→ 有 X 断点补丁时原子写 `x-checkpoints.json`。LLM 失败降级（summary/localizations 不写，前端回退原文）。
10. **每日公开投影**：`buildDailyProjection(merged, config)` → `enrichHotspotProjection(projection.items)`（经 `buildProjectionInputs` 注入 catalog 工具链接/关联词典，补 hot_score/evidence_excerpt/related_resources）→ 组装 `{ schema_version, generated_at, items, coverage }` → `filterProjectionByWindow`（近期窗口 + 公开字段完整，剔除悬空引用）→ 写 `hotspots.json`。**空投影保护**：无 approved 内容时不覆盖旧文件，保留上一版公开数据。
10.5. **可选自愈 + 人工清单 + 运行记录**：`options.autoRepair=true` 时使用 GLM 对残缺候选修复；`buildReviewList` 自动生成/追加 `data/manual/review.json` 待审清单（文件已存在时追加新 pending、不覆盖人工结论）；收尾写 `data/news/runtime/last-run.json`（"最后一次采集记录"唯一权威来源，`ai-top` 判定 hasYouTube 用）。

**覆盖状态汇总**：`coverage.status` = 启用平台全部采集失败 → `failed`；任一步降级 → `partial`；否则 `complete`。`coverage.collectors.{youtube,x}` 带 `status/items/reason`，供前端状态条消费。

**注入点（测试 mock 用）**：`options.collectors` / `options.platforms` / `options.classify` / `options.review` / `options.summarize` / `options.localize` / `options.score` / `options.config` / `options.now` / `options.xWindow` / `options.minStoreIn|Out` / `options.historyIn|Out` / `options.runId`。`--fixture` 即注入内存存根（零落盘，不污染 min-candidates.json / source-history.json）。

---

## 四、采集器实现（`src/news/collectors/`）

### 4.1 YouTube（collector-youtube-v2.js）—— 关键词发现

- 走 **YouTube Data API v3**，按 `youtube_queries` 关键词 `search.list` 发现近 N 日（`youtube_window_days`，默认 3 天）视频，**不依赖旧版 RSS/playlist 与来源名单**。
- **配额模型**：
  - `search.list` 独立桶：1 单位/次，每次运行上限 `youtube_search_max_per_run`（100）；**2026-06 后 Google 将 search 绑定独立桶（100 次/天），耗尽不会自动切合并桶** → `youtube_fallback_enabled=true` 时自动降级 `videos.list mostPopular` 热门榜（合并桶计费，最多 `youtube_fallback_popular_pages` 2 页），保证 search 桶用尽后仍能出数据。
  - `videos.list`（≤50 ID/批，1 单位/批）、`videoCategories.list`（1 次）、`commentThreads.list`（每条视频 1 次）都从 `youtube_daily_quota_units`（10000）合并桶扣。
  - `usedQuota` 累计所有端点消耗，`searchCalls` 单独累计 search 次数；任一超出即停止，降级返回部分结果，不抛错。
- **详情补齐**：`videos.list`（statistics+contentDetails+snippet → 标题/描述/播放量/点赞/评论数/时长/标签）→ `videoCategories.list` 分类名 → `commentThreads.list` 点赞最高 10 条评论（并发池抓取，每条视频 1 次）。
- 错误区分：`requestText` 附 `error.body`（响应体含 API `error.code`），`isQuotaExceeded` 精确匹配 `quotaExceeded / dailyLimitExceeded` 类错误码（区别于普通 429 限流）。
- 无 `YOUTUBE_API_KEY` → 返回 `{ items: [], coverage: { status:'failed', reason:'missing_api_key' } }`。
- 内容模型：`buildItem` 产出统一模型（`id: youtube-<hash>`、`source_id/author_id = youtube-<hash(channelId)>`、`metrics`、`comments`、`duration_seconds` 等）。

### 4.2 X / Twitter（collector-x-v2.js）—— 博主时间窗 + 关键词

- 走 **TwitterAPI.io**（`twitter_api_base_url`，带 `X-API-Key` 头），**博主名单来自 `config.x_accounts` 并按 `account_groups` 轮次公平调度**，关键词发现来自 `config.keywords.x_discovery_queries`，不依赖旧版 registry/quota/scheduler。
- **配额模型（四桶预算账本，预付-结算制，`x-search/budget.js`）**：
  - 账号组查询（`account`）、关键词发现（`discovery`）、长文补读（`article_retry`）、尾部重查（`tail_recheck`）四桶独立计费、严禁桶间借用：热半区 7500 = account 5500 + discovery 800 + article_retry 750 + tail_recheck 450；冷半区 2500 = account 1300 + discovery 300 + article_retry 300 + tail_recheck 600；
  - 请求前先在桶内预占额度（推文请求默认预占 300、长文读取预占 100），成功后按实际返回量结算（最低 15 credits/条，返回 >20 条的部分记 overage）；网络异常/超时的预占划入 `unknown_reserved` 不释放；
  - 桶余额不足（`BUDGET_EXHAUSTED`）即停止并记 `failures` 降级返回；
  - 关键词与博主结果按 `native_id` 全局去重（重复推文只输出一次）。
- **时间窗**：`sinceIso` / `untilIso` 由编排层 `resolveXWindow` 计算（缺省"今天 0 点 → now"）；窗外推文不消耗配额。
- **长文补读**：`hasArticleSignal`（`articleId / article 对象 / note_tweet / /i/articles/ 链接`）→ `extractArticleText` 解析正文并入 `description`。
- `normalizeXV2Tweet`：兼容多套字段命名（`id/id_str/tweetId/rest_id`、`text/full_text/fullText/content` 等）；全缺时以推文 JSON hash 兜底 `native_id`；缺正文或时间返回 `null`（不进入管线）；`source_type='x_post'`。
- 无 `X_API_KEY` → 返回 `{ items: [], coverage: { status:'failed', reason:'missing_api_key' } }`。

### 4.3 说明：B 站与字幕采集已整链删除

- **B 站（news-bilibili.js）已整链删除**（v1 删除清单，2026-08-08）：`x_accounts` / `account_groups` 与 `keywords` 段覆盖的 YouTube、X 之外的平台不再采集。
- **字幕主链（news-transcripts.js）已删除**：v2 不再在采集链路内抓取/存储字幕（`transcripts/` 目录删除）。改为**收尾环节** `min-review transcripts` 输出“待人工获取字幕”清单（§十），由维护者人工 yt-dlp 抓取后回填候选层（`transcript-notify.js`，完全分离、不碰主链）。
- **字幕回填走维护者工作台上传链路（`src/news/min/transcript-workflow.js`）**：top 选中后维护者在前端上传字幕文件（`.srt/.vtt/.txt`，`POST /news/transcripts/upload`）→ 文件存 `data/manual/transcripts/<candidate_id>/`（可提交、不发布），文本截断至 60000 字符写入候选 `transcript` 字段（不进公开投影）→ 维护者显式确认成本后经外部默认 provider 重新总结（`POST /news/transcripts/summarize`，单次 ≤8 条），写回 `summary` / `summary_key_points` 随 approved 进公开投影。

---

## 五、候选层、去重与合并（`src/news/min/`，单状态轴）

### 5.1 候选层（min-store.js）—— v2 单状态轴

数据文件 `data/news/runtime/min-candidates.json`（不发布到 dist/）。**单状态轴，无 `ai_processing_status` 双轴、无 `held`**：

| 状态 | 含义 | 进公开? |
|---|---|---|
| `pending` | 新采集 / L1 判 approve 或 hold（待人工细看）/ LLM 失败保留 | 否 |
| `approved` | 人工 `min-review set/batch --status approved` | 是（唯一通道） |
| `discarded` | L0/L1 自动落，或人工设置；终态（审核 mutation 只流转 pending，已审状态不可改写） | 否 |

- `MIN_REVIEW_STATUSES = ['pending','approved','discarded']`（合法枚举，validate-news 读此校验）。
- **合并语义 `mergeCandidatesMin`**：新条目按 id 覆盖内容字段；**已存在条目保留既有 `review_status`（任何值，包括 pending）**、`top_selected`、`reviewed_at`——即重新采集不会重置任何已落盘的审核结论；L1 自动剔除因此只对**首次出现**的候选生效。新条目缺省 `pending`、`top_selected=false`。
- **公开字段白名单 `MIN_PUBLIC_FIELDS`**：`id/platform/native_id/content_type/url/title/description/published_at/fetched_at/author_id/author_name/source_id/language/source_tags/thumbnail/metrics/explicit_links/hot_score/evidence_excerpt/related_resources/source_type/category/comments/summary/summary_key_points/localizations`。
- **内部字段 `MIN_INTERNAL_FIELDS`**（绝不进公开）：`review_status / reviewed_at / ai_advice / l1_review / discard_stage / discard_reason / localizations_meta`。
- `toPublicItemMin`：按白名单保留 + 防御性剔除内部字段。
- **公开资格（两段）**：`isMinPublicEligible`（`review_status==='approved'`）；`isMinDisplayEligible`（`approved && top_selected===true`，第二阶段"被选中显示"）。
- `setReviewStatusMin` / `setBatchReviewStatusMin` / `setTopSelectedMin`：写 `reviewed_at`；batch 只处理显式列出的 ids，未命中汇入 `missing`。

### 5.2 去重（projection.dedupeItems）

按 `platform:native_id` 去重，保留先出现条目。**v2 主链只调用 dedupeItems，不构建溯源/事件聚合**（热点视图 v2 schema 不消费 provenance/events；投影结构即 `{ schema_version, generated_at, items, coverage }`）。

### 5.3 已删除的旧核心模块（不再作为当前状态）

v1 的 `news-registry.js`（唯一真相源/双轴状态机）、`news-scheduler.js`（五层时间窗调度）、`news-quota.js`（额度账本）、`news-authorization.js`（授权任务）、`news-review-events.js`（审核事件日志）、`news-candidates.js`（双状态轴候选层）均已删除。v2 的成本控制改由**采集器内建配额计数**（YouTube 独立桶+合并桶、X credits）承担，调度改由 **GitHub Actions cron 分时**承担（§十一）。

---

## 六、评分与来源长期质量历史库

### 6.1 评分（scoring-v2.js）—— 6 权重加权

```
final_score = clamp(Σ weight_i × score_i, 0, 100)   （config.scoring.weights，合计 1.00）
```

| 权重 | 分值 | 权重值 |
|---|---|---|
| `long_term_quality` | `history-store.evaluateLongTermQuality`（纯本地统计） | 0.20 |
| `recent_timeliness` | 指数衰减 `100 × exp(-ln2 × ageDays / half_life_days)`，半衰期取 `config.scoring.half_life_days`（按首标签）或默认 7 天；published_at 缺失 → 中性 50 | 0.15 |
| `light_user_experience` | 标题/描述命中体验信号词（`实测/上手/使用/体验/教程/工作流` 等，可配）→ 70，否则 50 | 0.05 |
| `source_reliability` | **仅 X 用**：平台认证（`is_verified/verified/author_verified`）→ 90，无认证数据 → 50；**YouTube 不评此项（score 0，权重并入 long_term_quality，保持合计 1.00）** | 0.15 |
| `interaction_quality` | 单条三率加权（与 history-store 同一套三率算法） | 0.15 |
| `type_preference` | 按 `content_type` 查 `type_preference_score`：`ai_tool/ai_product 90`（实用最高）、`ai_concept/ai_industry 60`、`ai_technology 40`、`other/unclassified 50` | 0.30 |

对比 v1 `scoring.js`（已删）：v2 用历史库做长期质量、用真实互动三率做互动质量，不再依赖 `source.quality_prior` 先验与互动占位中性分。输出 `{ content_id, final_score, score_breakdown（含 applied_weights/long_term_status）, assessed_at }`。

### 6.2 来源长期质量历史库（history-store.js）

- 数据文件 `data/news/runtime/source-history.json`（不发布到 dist/）：`{ sources: { "<platform>:<sourceKey>": { samples: [...], seen_native_ids: [...] } } }`。`sourceKey` = X 用 handle、YouTube 用 channelId（`sourceKeyOf`：优先 `item.source_key`，否则去 `source_id` 的 `<platform>-` 前缀）。
- `appendSamples`：按 `<platform>:<sourceKey>` 追加互动样本，`seen_native_ids` 幂等去重（同 native_id 不重复追加）。
- `evaluateLongTermQuality` 分档：
  - 窗口时限内（YouTube 6 月 / X 2 月）最近 `window_n=10` 个样本；
  - 样本数 < `observation_period_count`（3）→ `insufficient`（中性 50）；
  - 样本数 3~4 → `observation`（三率原始分压缩映射到 `[20,60]`）；
  - 样本数 ≥ `min_samples`（5）→ `long_term`（三率原始分直接 0~100）。
- **三率加权**：`c`（综合参与率 `(likes+comments+reposts)/views`，权重 0.6）主、`d`（赞评比 `likes/comments` 对数刻度，0.25）修正、`a`（点赞率 `likes/views`，0.15）最小加分；分母不可用该项取中性 50。
- 纯本地统计：不发网络请求、不消耗 API 额度。

---

## 七、AI 内容分类/总结/审核/本地化（`src/news/classify/`）

### 7.1 两级分类（content-classifier.js）

- **L0 规则式基线**：零依赖、零成本、可离线。六类正则 + catalog 词典（tools/glossary）命中，优先级：行业事件 → 模型/技术/研究 → 工具使用/评测 → 产品发布/更新 → 概念/术语/教育 → 兜底 `other`。
- **L1 AI 分类**：`options.provider` 或 `KNOWVIEW_CLASSIFY_PROVIDER` / `INFOCATCHER_CLASSIFY_PROVIDER`（旧变量名继续生效）指定白名单 provider（zhipu / deepseek 等）时启用，传输经 `src/shared/llm-gateway.js` 路由；未配置 provider 时走 L0 基线；任何失败自动回退 L0（`classifier='rule_based_fallback'`），不阻塞管线。
- `content_type_status`：`unclassified → ai_suggested → reviewed`（`ai_suggested`=AI 建议待审，`reviewed`=人工确认）。`classifyCandidates` 跳过已 `reviewed`（人工结论）项，防 AI 覆盖人工确认。
- 分类与审核按 `config.collection.concurrency` 并发执行（`content-reviewer.runPool` 统一并发池，worker 收到 `(item, index)`）。

### 7.2 LLM 网关与任务执行层（llm-gateway.js + llm-provider.js）

- 传输统一经 [src/shared/llm-gateway.js](../src/shared/llm-gateway.js)：provider 路由、端点与模型解析、协议适配、错误分类都由 gateway 与 providers 注册表负责（导出 `requestStructuredJson` / `requestLlmText` / `resolveTransportRoute`）。厂商注册表 [src/shared/providers/](../src/shared/providers)（zhipu / deepseek / local / openai / anthropic），外部默认 `DEFAULT_PROVIDER_NAME='zhipu'`；原本指向本地 Bonsai 的请求在统一网关改走智谱 GLM，且不自动启动本地模型。
- news 域任务执行层 [llm-provider.js](../src/news/classify/llm-provider.js) 导出：`classifyContent` / `summarizeContent`（外部档 `summarizeWithExternal`）/ `reviewContent`（`reviewWithExternal`）/ `localizeContent`（`localizeWithExternal`）/ **`selectTopItems`**（`min-review ai-top` 用，从 approved 候选语义挑选 top 待选项）/ `refineKeywords`（关键词提纯用）；prompt/payload 构造在 `llm-prompts.js` 与 `llm-selection.js`。
- 失败语义：任何错误 resolve `{ ok: false }` 降级对象，绝不 reject。

### 7.3 内容总结（content-summarizer.js）

- 输出公开字段 `summary`（单段中文摘要）+ `summary_key_points`（要点列表）。输入 = 标题 + 描述 + 字幕（候选有 `transcript` 才拼入，无则自动只用 title+desc）。摘要长度/要点数量由 LLM 按信息量自主决定。
- **公开语义**：随候选 `review_status` 门禁进公开——候选 approved 时总结一起公开，pending 时不公开；**不引入独立审核状态机**。前端有总结显示总结、无则回退 description。
- **失败语义**：LLM 失败 resolve 降级、`summary` 置 null，前端回退 description，不阻塞管线。
- 内部痕迹：`summarizer / summary_generated_at / summary_input_chars / summary_llm_error`。
- `enrichCandidateSummaries`（管线钩子）仍在，v2 由 `runMin` 第 8 步经 `summarizeCandidates` 批量调用。

### 7.4 AI 审核建议（content-reviewer.js + web-verifier.js）

- v2 中本模块**只保留** `reviewCandidate / reviewCandidates / runPool`（+ `VERDICTS / AUTO_APPLY_VERDICTS / collectReviewSource`）——旧的 `applyAiReviewVerdicts` / `enrichCandidateReviews` 批量钩子已随 v1 删除。v2 的 L0/L1/L2 审核编排统一在 **`src/news/min/review-v2.js`**（§八）中复用 `reviewCandidate`。
- `reviewCandidate(item)`：对标题+描述+字幕+总结做 LLM 审核，输出 `{ verdict: approve|hold|discard, reasons, confidence, ... }`；LLM 失败 → `verdict null`（不误杀）。`options.webEvidence` 可注入联网核验证据文本（追加进审核 prompt，供复判修订判断）。
- **联网查证（web-verifier.js `verifyAdviceWithWeb`）**：审核 LLM 只凭训练记忆判断真伪，会把真实发布的最新模型误判为"编造"（2026-09-16 Gemini 3.8 Live 事故）。因此 verdict 为 `hold`/`discard` 的建议会自动用标题搜一次 Tavily（共享 `searchTavily`，keyless→keyed 降级），把前 5 条结果拼成证据复判一次，最终建议挂 `web_verification = { query, searched_at, results | search_error }` 随 `ai_advice` 持久化供人工追溯。**全程 fail-open**：搜索/复判失败不抛错、不阻断管线，原建议保留；搜索无有效结果时跳过复判省一次 LLM 调用。
- **联网核验开关**：`config.review.web_verify` 缺省启用，仅显式设置为 `false` 时关闭；关闭后不搜索、不复判，也不为已有建议补核验，保持旧行为。该开关只控制语义查证成本，L0 完整性/广告等必要门禁不受影响。

### 7.5 内容本地化（content-localizer.js）

- 输出公开字段 `localizations[locale] = { title, description }`（当前唯一 locale `zh`）。输入 = 原文标题 + 描述；**原文顶层 `title`/`description` 保留作溯源核验基线**。
- **prompt 契约**：翻译成简体中文；品牌名/产品名/专有名词（DeepSeek、Ollama、Claude 等）、URL、代码、数字、版本号保持原文不译；忠实翻译不增删信息；原文已是中文时做精炼（去 # 标签/emoji/情绪化开场），非逐字翻译。
- **公开语义**：`localizations` 是公开字段进公开投影（中文以数据文件形式存储，前端按语言读取）；`localizations_meta`（localizer/generated_at/input_chars/llm_error）是内部字段，经 `MIN_INTERNAL_FIELDS` 剔除。
- **质量门禁**：中文标题或描述原样复述英文、输出缺字段时不写公开翻译，`localizations_meta.zh.llm_error` 记录原因；修复命令只对这类输出和暂时性网络错误做有上限的重试。
- `enrichCandidateLocalizations` 仍在，v2 由 `runMin` 第 9 步经 `localizeCandidates` 批量调用（只处理无 `localizations[locale]` 的候选，不重复花钱）。
- **执行时机**：放总结/审核之后、投影之前——只消费原文 title/desc，与总结/审核无依赖，放最后避免影响审核用原文素材。

---

## 八、审核层与公开资格门禁

### 8.1 审核层（review-v2.js）—— L0 硬审 → L1 AI 审 → L2 AI 建议 + 人工

本模块**只对传入条目计算判定并原样展开（+ 审核痕迹字段），不自己写 store**，是否持久化由 `runMin` 决定。

- **L0 `l0HardFilter(item, config)`**：规则式硬过滤，零成本零外部依赖。`incomplete`（缺 title/url/published_at）/ `not_ai`（title+description 未命中任一 `content_keywords`）/ `advertising`（命中 `sponsored|advertisement|推广|广告|affiliate|佣金` 等）/ `ai_generated_disclosure`（简介命中明确 AI 生成披露模板，硬排除且不落盘）→ `{ pass:false, reason }`。
- **L1 `l1AiReview`**：复用 `content-reviewer.reviewCandidate` 调外部 provider；`config.review.l1_input_include_comments=true` 且候选有评论时，把点赞最高 `l1_comments_top_n`（10）条评论拼进输入（`[TOP_COMMENTS]` 段），让 AI 过滤无关/吵架评论。**判定分流**：
  - 高置信通过：`verdict==='approve'` 且 `confidence ≥ l1_confidence_auto_approve`（0.85）时自动落 `review_status:'approved'`（保留入库，但仍须人工确认 `top_selected:true` 才进入公开展示）；
  - 高置信剔除：`verdict==='discard'` 且 `confidence ≥ l1_confidence_auto_discard`（0.9）时自动落 `review_status:'discarded'`；
  - 待审保留：`hold`、低置信度或 LLM 失败（verdict null）落 `review_status:'pending'`，并进入 L2 生成辅助建议供人工参考。
- **L2 `l2AiAdvice`**：AI 辅助建议（给人工看的），复用 `reviewCandidate`，**不自动改状态**；`l2_enabled=false` 时跳过。建议生成后经 `web-verifier.verifyAdviceWithWeb` 联网查证复判（hold/discard 才触发，fail-open，见 §7.4），`ai_advice.web_verification` 记录查证痕迹。
- **批量入口 `applyL1Verdicts`**：`{ kept, discarded, advice }`。
  - `kept`：包含高置信自动通过项（`review_status:'approved'`）以及需要人工审核的待审项（`review_status:'pending'`，附 `ai_advice`）；
  - `discarded`：L0 硬审不过（带 `discard_stage:'l0'`）或 L1 高置信 discard（带 `discard_stage:'l1'`）；
  - `advice`：仅 pending 项对应的 `l2AiAdvice` 建议对象列表（自动通过/剔除项不调用 L2）。L1/L2 按 `concurrency` 并发、保持输入顺序。

### 8.2 公开资格门禁（news-public-gate.js，v2 精简为 4 个导出）

共享模块现存导出：`filterPublicItems` / `filterProjectionByWindow` / `isWithinPublicWindow` / `hasCompletePublicFields`（+ `classifyPublicTime` / `resolvePublicWindow` 等内部）。

- **公开总规则**：
  1. 审核门禁：由候选层保证 `review_status==='approved'`（v2 单轴，无 `ai_processing_status`）；
  2. 近期时间窗口：以内容 `published_at` 判断，默认 30 天（`output_retention_days`，v2 配置未显式设置时走默认 30）；未来时间超容错（默认 6 小时）或缺失 → `future/missing`，不进公开；
  3. 公开字段完整：标题、来源链接、发布时间必须完整（`hasCompletePublicFields`）。
- `filterProjectionByWindow`：对已构建投影的 items 按同一窗口规则过滤。hotspots 构建、publish-news、RSS 生成共用同一规则（决策 72 防口径漂移）。

### 8.3 每日公开投影（daily-projection.js）

**纯逻辑模块**：只负责"approved 里按天取 top N"。`buildDailyProjection(store, config, { now })`：

- 取 `isMinDisplayEligible`（`approved && top_selected===true`）候选，按 `published_at` 所在自然日分组（缺失/非法 → 不进投影）。
- 组内按 `final_score` 倒序（缺 final_score 按 hot_score，皆无排最末；同分按 published_at 更新者优先，再按 id 确定性兜底）。
- 每组取 top N：**当天组内有 YouTube 视频 → `max_output_with_youtube`（8）；纯 X → `max_output_items_daily`（5）**；组内不足 N 条取实际数量，不强凑（`min_output_items_daily=3` 是目标值，不强制补足）。
- 输出 `toPublicItemMin` 公开条目（已剔除内部审核字段）。`enrichHotspotProjection`（热度/依据/关联）与 `filterProjectionByWindow`（窗口过滤）由编排层另行调用。

---

## 九、持久化与原子写

### 9.1 底层（json-store.js）

基础 JSON 原子读写与并发锁收口于 [src/shared/json-store.js](../src/shared/json-store.js)（原 `news-storage.js` 已上移为全仓共享基础设施）：

- `writeJsonAtomic(file, value, runId)`：先写唯一临时文件（含 runId/PID/随机 hex，`wx` 独占）→ fsync → 同盘 rename 原子替换；失败删临时文件、目标不变。
- `readJson(file, fallback)`：仅 ENOENT 且传 fallback 时返回 fallback，其他错误抛出。
- 锁原语 `acquireLock / releaseLock / inspectLock / forceUnlock` **仍存在**（`fs.openSync(path,'wx')` 排他创建；`forceUnlock` 必须提供 reason 写审计 `news-admin-audit.json`；锁从不自动过期）。**但 v2 主链不再持锁**：`runMin` 不调 acquireLock，旧 `lock` CLI 命令组已删；并发安全改由 GitHub Actions `concurrency` 组（`collect-ai-news` / `publish-ai-news`）保证。

### 9.2 v2 写入文件与顺序

```
1. data/news/runtime/source-history.json  （writeHistoryStore，总结/本地化后写盘；样本在评分前已追加内存）
2. data/news/runtime/min-candidates.json  （writeMinStore，候选落地 + 总结/本地化统一写盘）
3. data/news/runtime/x-checkpoints.json   （有 X 断点补丁时原子写，minStore 之后）
4. data/manual/review.json                （buildReviewList 自动生成/追加待审清单）
5. data/news/output/hotspots.json         （writeJsonAtomic，公开投影最后写）
   —— 空投影保护：无 approved 内容时不覆盖旧文件，保留上一版公开数据
6. data/news/runtime/last-run.json        （runMin 收尾写，"最后一次采集记录"唯一权威来源）
```

### 9.3 构建失败保护

- `runMin` 每步失败**降级不抛错**（采集失败返回空、LLM 失败置 null、读写失败记 coverage 错误）；启用平台采集全失败 → `coverage.status='failed'`。
- 公开投影为空 → `coverage.public_projection='empty_skipped_write'`，旧 hotspots.json 保持不变，前端不会看到半成品。
- `publish-news.js` 同样有空投影保护（候选层无 approved 时保留旧文件）。

---

## 十、人工审核与收尾环节（`min-review` 命令组）

### 10.1 命令一览（`src/news/cli/cmd-min.js`）

```bash
# 阶段 1：待审核清单 + 人工定夺
node scripts/news-cli.js min-review list            [--status pending|approved|discarded] [--platform ...] [--limit N] [--top N] [--json] [--manual]
node scripts/news-cli.js min-review set    --id <id> --status pending|approved|discarded
node scripts/news-cli.js min-review batch  --ids <id1,id2,...> --status approved
node scripts/news-cli.js min-review apply  --file data/manual/review.json   # 应用清单结论写回候选层

# GLM 加工流（初审/摘要/本地化分批编排 + 残缺修复）
node scripts/news-cli.js min-review enrich   [--batch-size N] [--limit N]
node scripts/news-cli.js min-review repair   [--concurrency N]

# 阶段 2：AI 挑 top 待选项 + 人工确认显示
node scripts/news-cli.js min-review ai-top
node scripts/news-cli.js min-review top-selected --ids <id1,id2,...>
node scripts/news-cli.js min-review top-apply    --file data/manual/top.json

# 收尾环节（独立于主链，只写清单文件交人工）
node scripts/news-cli.js min-review transcripts
node scripts/news-cli.js min-review feedback
node scripts/news-cli.js min-review refine        [--purpose content|youtube|x_discovery]
node scripts/news-cli.js min-review refine-apply  --file data/manual/keyword-refine.json [--purpose ...]

# 每日收尾归档（写轻量历史 → 清空候选层 → 重置当日人工清单）
node scripts/news-cli.js min-review archive

# 调试预览（纯函数，不写入）
node scripts/news-cli.js classify preview  --title <t> [--description <d>]
node scripts/news-cli.js localize preview  --title <t> [--description <d>] [--locale zh]
```

- `list`：列出候选（含 `review_status / final_score / content_type`）。`--top N` 按评分倒序取前 N 供人工审，缺省读 `config.collection.review_top_pure_x`（10）/ `review_top_with_youtube`（15，有 YouTube 候选时用后者）；`--json` 输出机器可读分布；`--manual` 生成待审清单到 `data/manual/review.json`。
- `set / batch`：把 **pending** 候选置 approved/discarded，写 `reviewed_at`；非 pending 条目拒绝（汇入 `not_pending`），已审状态不可改写。状态轴只允许 pending/approved/discarded。
- `apply`：读 `data/manual/review.json` 的人工结论（approved/discarded）批量写回候选层（pending 跳过；目标状态与当前相同幂等跳过）。`top-apply`：读 `top.json` 中 `top_selected=true` 条目批量置候选层。
- `enrich`：GLM 初审/摘要/本地化分批编排（断点续跑），完成后默认修复残缺数据并刷新待审清单。`repair`：使用外部提供方当前默认型号修复残缺数据；429/5xx/网络故障、翻译原样复述或缺字段最多退避重试两次（默认等待 5 秒、15 秒），其余错误不重复请求；`--no-external` 被拒绝。
- `archive`：先写轻量历史（min-candidates-history.json，最近 30 批）→ 清空候选层 → 重置 `data/manual/` 当日人工清单。
- `--store min`：显式标注 v2 数据通道（缺省即 min；其它值报错）。

### 10.2 两阶段人工审核流程（唯一进公开通道）

**阶段 1 —— 审核清单 → 人工定夺**：

```bash
node scripts/news-cli.js min-review list --manual
#    → data/manual/review.json（每条含 score / summary / suggestion / review_status；文件名固定去掉日期后缀，
#      已存在时追加新 pending）
#      待审候选 = 全部 pending，按评分倒序；建议由 suggestReview 按 content_type + 标题特征给出
#      （学习打卡/个人日志 → discarded；AI 产品/工具 → approved；推文线程 → 展开正文核验；其余中性）
node scripts/news-cli.js min-review batch --ids <id1,id2,...> --status approved   # 或 set --status discarded
```

**阶段 2 —— AI 挑 top 待选项 → 人工确认显示**：

```bash
node scripts/news-cli.js min-review ai-top
#    → 从 approved 候选经 llm-gateway（selectTopItems）语义挑 top 待选项
#      （纯 X 10 / 有 YouTube 15，按 last-run.json 判定 hasYouTube；失败一律抛错不降级）
#      写 data/manual/top.json（文件名固定，每条 top_selected=false），每条含
#      score / summary / suggestion / description（汉化完整描述）/ original（原文 http 链接，中文原文省略）/ author_name
node scripts/news-cli.js min-review top-selected --ids <id1,id2,...>
#    → 从待选项确认最终显示 3~5（有 YouTube 日 3~8）条，top_selected 置 true
#    （也可在 top.json 勾选后 min-review top-apply --file data/manual/top.json 应用）
node scripts/publish-news.js
#    → 公开投影只取 approved && top_selected（isMinDisplayEligible）
```

**语义要点**：`approved` 表示审核通过（进待选项池）；`top_selected=true` 表示被选中显示在前端。AI 提供的是候选池不是最终结论，最终条数由维护者从待选项中挑。

### 10.3 收尾环节（独立于主链，只写 data/manual/ 固定格式文件，不自动改数据）

| 命令 | 模块 | 输出文件 | 说明 |
|---|---|---|---|
| `transcripts` | `src/news/transcripts/transcript-notify.js` | `transcript-requests.json` | 候选层挑评分最高的 `notify_count`（`"3to5"` 取低值 3）个 YouTube → 链接清单交人工 yt-dlp 抓取，经工作台上传链路回填（§4.3）；不调采集/总结、不碰主链 |
| `feedback` | `src/news/feedback/tool-feedback.js` | `data/manual/tools/tool-cards-pending.json` / `data/manual/concepts/concept-cards-pending.json` | 从 approved summary 提取工具/概念名（配置外部 provider key 且未关 `feedback.llm_extract` 时走 LLM 提取，失败降级正则；无硬名单一票否决，类型过滤只由 LLM 类型判定产生），与 tools.json/glossary.json 比对：归一化精确同一（`toolExists`）→ 记已收录；非精确命中一律生成待补卡草案，目录有疑似近似卡时附 `similar_in_catalog`（前 3 条）供人工确认，不静默丢弃（2026-09-16 Gemini 3.8 Live 被旧模糊匹配吸附事故后的契约），不直接改知识库 |
| `refine` | `src/news/min/keyword-refine.js` | `keyword-refine.json` / `youtube-queries-refine.json` / `x-queries-refine.json`（`--purpose content\|youtube\|x_discovery`，文件名固定，已存在时拒绝覆盖） | 从 approved 候选原文提炼关键词候选交人工勾选 `adopted_keywords`；人工确认后 `refine-apply` 校验清单并原子幂等追加 `content_keywords` / `youtube_queries` / `x_discovery_queries` |

---

## 十一、发布与 CI 编排

### 11.1 publish-news.js（默认走 v2）

- 触发：`publish-news.yml` 在 `main` 分支 push 且变更 `data/news/runtime/min-candidates.json` 时运行。
- 流程（`mainMin`）：`buildDailyProjection`（approved && top_selected 按天 top N）→ `enrichHotspotProjection` → `filterProjectionByWindow`（近期窗口第二道防线）→ 空投影不覆盖 → 写 `hotspots.json` + `generateRss()`。
- 只提交公开投影（hotspots.json + feed.xml），不含内部候选层，因此不会再次触发本 workflow（paths 仅监听候选层）。
- `--dry-run` 只打印将生成条数不写文件；`--min` 兼容 no-op。

### 11.2 collect-news.yml（构建工作流）

- 触发：三个 schedule cron（`13 12 * * *` YouTube 每日北京 20:13（配合管线内 72h 到期闸实际采集） / `37 0 * * *` X 热半区每日北京 08:37 / `43 12 * * *` X 冷半区每日北京 20:43，均为 UTC 值；刻意错开 :00/:30 整点/半点——GitHub 官方文档警告该时段调度延迟严重，2026-09-14/15 曾实测延迟 4.6~10 小时且整次触发被丢弃）`+` 手动 `workflow_dispatch`（`platforms: both / youtube / x`，含 x 时可带 `x_slot: hot/cold`，可选 `business_date: YYYY-MM-DD` 补采历史窗口，`pipeline: min` 唯一选项）；concurrency 组 `collect-ai-news` 防并行。
- 门禁与步骤：`collection_gate` job（`vars.NEWS_COLLECTION_ENABLED == 'true'` 才运行；YouTube cron 预检 `isYoutubeDue` 读 `schedule-state.json` 判 72h 到期）→ `--sync-baseline` 把开放 Data PR 分支的六个运行时文件播种为读入基线 → `node scripts/validate.js` → `node scripts/check-secrets.js`（密钥扫描）→ **Resolve platforms**（schedule 触发按 cron 映射：YouTube cron → `youtube`，X cron → `x` + 对应 slot；manual 的 platforms/x_slot 优先）→ 调度运行带 `--scheduled --business-date <cron 触发日>`（注入到期闸与业务日期，防 GitHub 延迟跨北京午夜后查到未来窗口）跑 `node scripts/build-news.js --platforms "$NEWS_PLATFORMS" [--slot ...]` → 采集摘要写 step summary → 测试生成数据（11 个 tests/news 测试 + validate）→ `node scripts/deliver-news-data-pr.js` 交付 **Data PR**。
- **Data PR 交付（CAS）**：白名单六文件（`min-candidates.json` / `source-history.json` / `review.json` / `last-run.json` / `schedule-state.json` / `x-checkpoints.json`）逐项校验通过后提交到 `news/review/<batch>` 分支并创建 PR（base main）；已存在开放 Data PR 时推送同一分支并校验 head SHA 未漂移；工作树出现白名单外改动直接停止交付。
- **关键设计**：采集只产生内部候选层（不直接提交 main）；公开投影在 Data PR 合并后由 `publish-news.yml` 重建，保证"人工审核通过 + top_selected"才进公开。

### 11.3 审核 → 发布闭环

```
collect-news.yml 构建 → Data PR（白名单六运行时文件，news/review/<batch> 分支）
   → 维护者按 review.json 审核并应用结论（min-review apply，或 set/batch；阶段 2 走 ai-top / top-selected）
   → 合并 Data PR 到 main（min-candidates.json 更新）
   → publish-news.yml 从候选层重建公开投影 + RSS（只取 approved && top_selected）
   → deploy.yml 校验 → 构建 dist/ 部署 GitHub Pages
```

### 11.4 部署（deploy.yml）与密钥安全

- `deploy.yml`：`main` 分支 push / 手动 → validate（validate.js + `node --test --test-concurrency=1 tests/` 全量回归）→ `node scripts/build-dist.js`（src/web + public + data → dist/）→ 上传 artifact → GitHub Pages。
- 密钥仅经 GitHub Repository Secrets 注入（`YOUTUBE_API_KEY` / `X_API_KEY` / `ZHIPU_API_KEY` / `DEEPSEEK_API_KEY`），不进入代码、JSON、浏览器或 CLI 参数；`check-secrets.js` 在构建前做密钥/高熵扫描。

---

## 十二、关键文件与导出速查

| 模块 | 文件 | 关键导出 |
|---|---|---|
| 构建编排（v2 总指挥） | [pipeline-min.js](../src/news/min/pipeline-min.js) | `runMin`、`loadV2Config`、`isCollectionEnabled`、`isYoutubeDue`、`normalizeNow`、`resolveXWindow` |
| CLI 分发 | [news-cli.js](../src/news/cli/news-cli.js) | `parseArgs`、`main`、`minReviewCommand` |
| min-review 命令组 | [cmd-min.js](../src/news/cli/cmd-min.js) | `minReviewCommand`、`loadV2Config`、`removeManualLists`、`MANUAL_LIST_FILES` |
| classify/localize 预览 | [cmd-content.js](../src/news/cli/cmd-content.js) | `classifyCommand`、`localizeCommand` |
| 审核清单生成/应用 | [review-list.js](../src/news/min/review-list.js) | `buildReviewList`、`applyReviewList`、`applyTopSelectedList`、`scoreOf`、`suggestReview` |
| 候选层（单状态轴） | [min-store.js](../src/news/min/min-store.js) | `readMinStore`、`writeMinStore`、`mergeCandidatesMin`、`commitMinStoreMutation`、`revisionOfMinStore` |
| 审核/top/字幕 mutation | [min-review-actions.js](../src/news/min/min-review-actions.js) | `reviewPendingCandidates`、`setReviewStatusMin`、`setBatchReviewStatusMin`、`setTopSelectedMin`、`setCandidateTranscriptMin`、`setCandidateTranscriptSummaryMin`、`isMinPublicEligible`、`isMinDisplayEligible`、`toPublicItemMin` |
| 审核层（L0/L1/L2） | [review-v2.js](../src/news/min/review-v2.js) | `l0HardFilter`、`l1AiReview`、`l2AiAdvice`、`applyL1Verdicts` |
| 历史库 | [history-store.js](../src/news/min/history-store.js) | `readHistoryStore`、`writeHistoryStore`、`appendSamples`、`evaluateLongTermQuality`、`computeThreeRateScore`、`sourceKeyOf` |
| 每日公开投影 | [daily-projection.js](../src/news/min/daily-projection.js) | `buildDailyProjection` |
| 关键词提纯 | [keyword-refine.js](../src/news/min/keyword-refine.js) | `refineKeywords`、`tokenize`、`buildWordFreq`、`buildRuleCandidates`、`collectApprovedOriginals` |
| 采集（YouTube v2） | [collector-youtube-v2.js](../src/news/collectors/collector-youtube-v2.js) | `collectYouTubeV2`、`buildItem`、`parseDuration` |
| 采集（X v2） | [collector-x-v2.js](../src/news/collectors/collector-x-v2.js) | `collectXV2`、`normalizeXV2Tweet`、`extractArticleText`、`hasArticleSignal` |
| 字幕通知（收尾） | [transcript-notify.js](../src/news/transcripts/transcript-notify.js) | `notifyTranscripts`、`parseNotifyCount` |
| 字幕上传/总结（工作台） | [transcript-workflow.js](../src/news/min/transcript-workflow.js) | `uploadTranscript`、`summarizeTranscripts` |
| 工具/概念反哺（收尾） | [tool-feedback.js](../src/news/feedback/tool-feedback.js) | `feedbackFromSummaries`、`extractEntities`、`toolExists`、`findSimilarTools`、`conceptExists` |
| 解析与标准化 | [feed-parser.js](../src/news/pipeline/feed-parser.js) | `normalizeUrl`、`hash`、`numberOrNull`、`requestText`、`extractTweetArray` |
| 评分（v2） | [scoring-v2.js](../src/news/pipeline/scoring-v2.js) | `assessItemV2`、`scoreTimelinessV2`、`detectLightExperienceV2`、`scoreSourceReliability`、`scoreTypePreference` |
| 投影/去重/关联 | [projection.js](../src/news/pipeline/projection.js) | `dedupeItems`、`enrichHotspotProjection`、`computeHotScores`、`buildProjectionInputs`、`buildRelatedTitleLexicon`、`matchRelatedByTitle`、`titleContainsKeyword`、`searchConceptKey`、`buildEvidenceExcerpt`、`buildToolUrlIndex`、`resolveRelatedResources` |
| 公开资格门禁 | [news-public-gate.js](../src/news/core/news-public-gate.js) | `filterPublicItems`、`filterProjectionByWindow`、`isWithinPublicWindow`、`hasCompletePublicFields` |
| 存储与锁 | [json-store.js](../src/shared/json-store.js) | `readJson`、`writeJsonAtomic`、`acquireLock`、`releaseLock`、`inspectLock`、`forceUnlock` |
| AI 分类 | [content-classifier.js](../src/news/classify/content-classifier.js) | `classifyRuleBased`、`classifyCandidate`、`classifyCandidates`、`confirmContentType` |
| AI 总结 | [content-summarizer.js](../src/news/classify/content-summarizer.js) | `summarizeCandidate`、`summarizeCandidates`、`enrichCandidateSummaries` |
| AI 审核建议 | [content-reviewer.js](../src/news/classify/content-reviewer.js) | `reviewCandidate`、`reviewCandidates`、`runPool`（无 applyAiReviewVerdicts/enrichCandidateReviews） |
| 审核联网查证 | [web-verifier.js](../src/news/classify/web-verifier.js) | `verifyAdviceWithWeb`（hold/discard 建议 Tavily 查证 + 证据复判，fail-open） |
| AI 本地化 | [content-localizer.js](../src/news/classify/content-localizer.js) | `collectLocalizeSource`、`localizeCandidate`、`localizeCandidates`、`enrichCandidateLocalizations` |
| LLM 网关 | [llm-gateway.js](../src/shared/llm-gateway.js) | `requestStructuredJson`、`requestLlmText`、`resolveTransportRoute` |
| news AI 任务层 | [llm-provider.js](../src/news/classify/llm-provider.js) | `classifyContent`、`summarizeContent`、`reviewContent`、`localizeContent`、`selectTopItems`、`refineKeywords` |
| RSS | [generate-rss.js](../src/content/generate-rss.js) | `getFeedItems`、`generateRss` |
| 路径 | [paths.js](../src/shared/paths.js) | `DIRS`、`NEWS_FILES`（见 §二 2.1） |
| 脚本入口（v2） | [scripts/build-news.js](../scripts/build-news.js) | `main`/`mainMin`、`buildMinFixtureOptions` |
| 发布入口（v2） | [scripts/publish-news.js](../scripts/publish-news.js) | `main`、`mainMin` |

---

## 十三、数据文件一览（data/news/**）

| 文件 | 用途 | 是否发布到 dist/ |
|---|---|---|
| `config/news-config-v2.json` | **v2 唯一配置**（采集/评分/审核/收尾全部开关） | —（非数据产物） |
| `config/news-config-v2.说明.md` | 配置逐字段说明 | 否 |
| `runtime/min-candidates.json` | **v2 候选层（单状态轴 pending/approved/discarded + content_type/summary/localizations + l1_review/ai_advice 内部字段）** | 否 |
| `runtime/source-history.json` | 来源长期质量历史库（评分 v2 数据源） | 否 |
| `runtime/last-run.json` | 最后一次采集运行记录（`ai-top` 判定 hasYouTube 的权威来源） | 否 |
| `runtime/schedule-state.json` | YouTube 调度到期闸状态（仅 CI 调度运行写入） | 否 |
| `runtime/x-checkpoints.json` | X 采集断点与尾部重查观察（30 天滚动） | 否 |
| `runtime/min-candidates-history.json` | 归档的最近 30 批候选轻量历史（仅 id/title） | 否 |
| `output/hotspots.json` | **公开热点投影**（approved && top_selected 按天 top N + hot_score/evidence_excerpt/related_resources） | 是 |
| `public/feed.xml` | RSS 2.0 feed（同公开过滤规则） | 是 |

**`data/manual/`（运行时产物，入库但不发布到站点）**：

| 文件 | 用途 |
|---|---|
| `review.json` | 阶段 1 待人工审核清单（id/score/summary/suggestion/review_status） |
| `top.json` | 阶段 2 AI top 待选项（top_selected:false，人工确认后置 true） |
| `transcript-requests.json` | 待人工获取字幕清单（标题/URL/评分） |
| `transcripts/<candidate_id>/` | 工作台上传的字幕文件（可提交、不发布） |
| `tools/tool-cards-pending.json` / `concepts/concept-cards-pending.json` | 工具/概念待补卡草案 |
| `keyword-refine.json` / `youtube-queries-refine.json` / `x-queries-refine.json` | 关键词提纯候选清单（交人工勾选 adopted_keywords） |

**已删除的数据文件（v1，2026-08-08）**：`news-sources.json`、`news-config.json`、`news-state.json`、`news-registry.json`、`news-registry-pruned.json`、`news-quota.json`、`pending-authorizations.json`、`review-events.json`、`hotspot-candidates.json`、`news-manual-items.json`、`runtime/transcripts/`。

---

## 十四、测试与验证

- `scripts/validate.js` → `src/maintenance/validate.js`：catalog + news 数据 + 开发原则门禁聚合校验，`process.exit(0/1)`；CI 三处工作流依赖。news 域只校验仍存在的 **hotspots.json**（公开投影）与 **min-candidates.json**（v2 单状态轴：`review_status` ∈ `MIN_REVIEW_STATUSES`、platform ∈ {youtube,x}、approved 缺公开字段仅告警）。
- `scripts/check-secrets.js`：密钥/高熵扫描（validate.js 反向依赖，构建前执行）。
- **测试文件（tests/news/ 30+ 个）**：v2 全链 `news-pipeline-min`（fixture 验证）、`news-rss`、`news-public-gate`、`news-reviewer`、`news-summarizer`、`news-localizer`、`content-classifier-llm`，以及 X 采集 `x-search-*` / `collector-x-*` 系列、Data PR 交付（`news-data-pr-delivery` / `deliver-news-data-pr-script`）、关键词动作与提纯（`keyword-actions` / `keyword-refine`）、字幕工作流（`transcript-workflow`）、本地加工（`local-enrichment`）、审核清单（`news-review-list`）、L0 披露（`review-v2-disclosure`）等。CI collect-news.yml 跑其中 11 个 + validate；deploy.yml 跑全量。`tests/maintenance/` 9 个（含 `check-secrets`、`env`、`validate-news-config`、`config-domain` 等）。
- **fixture**：`tests/fixtures/x.json`（X 响应样例）。`--fixture` 注入 mock 采集器 + 内存存根（`historyIn/Out`、`minStoreIn/Out`、`lastRunOut`、`scheduleStateIn/Out`、`checkpointStoreIn/Out`），**零落盘**，不污染 min-candidates.json / source-history.json；用于验证 v2 全链（采集→去重→L0→分类→评分→审核→合并→总结→本地化→投影）贯通。B 站与 YouTube fixture 已随 v1 删除。

---

## 十五、常见误区与易错点（据源码注释）

1. **时间门禁必须传数字时间戳**：`news-public-gate` 用 `now - time` 做算术，传 ISO 字符串会得到 NaN，导致未来/超窗判定静默失效（`resolvePublicWindow` 已对字符串归一化；`pipeline-min` 第 10 步传 `nowMs` 数字）。
2. **去重键是 `platform:native_id`**：`dedupeItems` 与 v2 候选层 id 一致；历史注释曾宣称"url+title 组合"（语义错误且会误合并），已修正。
3. **候选层合并保留人工结论**：`mergeCandidatesMin` 对已存在候选保留既有 `review_status`（**包括 pending**）、`top_selected`、`reviewed_at`——重新采集不会重置任何已落盘审核结论；**L1 自动剔除只对首次出现的候选生效**。
4. **L0 是硬过滤前置**：缺字段/非 AI/广告/AI 生成披露在进入分类评分前就标 `discarded`（`discard_stage='l0'`）；AI 生成披露（`ai_generated_disclosure`）硬排除不落盘，其余保留为 discarded 审计记录，不是删除。
5. **L1 自动剔除需高置信且只动 discard**：`verdict==='discard'` 且 `confidence ≥ 0.9` 才自动落 discarded；approve / hold / LLM 失败（verdict null）永不自动剔除——审核失败绝不误杀。
6. **L2 建议不自动改状态**：`ai_advice` 只是给人工看的参考（`l2_enabled=true`），最终通过永远由人工 `min-review batch/set --status approved`。
7. **公开投影只取 approved && top_selected**：`isMinDisplayEligible` 双重条件；`approved` 只进待选项池，`top_selected=true` 才显示在前端（每日 3~5 / 有 YouTube 3~8）。
8. **空投影不覆盖旧文件**：候选层无 approved 内容时 `coverage.public_projection='empty_skipped_write'`，保留上一版 hotspots.json，避免前端空白。
9. **ai_advice / l1_review / discard_stage 是内部字段**：经 `MIN_INTERNAL_FIELDS` 剔除不进公开投影；`final_score / score_breakdown` 也不进公开（公开热分 hot_score 由 `enrichHotspotProjection` 单独补）。
10. **总结无独立审核态**：`summary` / `summary_key_points` 随候选门禁进公开（approved 时公开、pending 时不公开）；勿为总结引入独立审核状态机。
11. **总结必须考虑字幕依赖（v2 语义）**：content-summarizer 输入含字幕（候选 `transcript`），v2 无字幕主链后候选通常无 transcript，自动退化为只用 title+desc；收尾环节 `transcripts` 人工回填字幕后再总结时，新增候选的总结会拼入字幕。
12. **localizations 公开、localizations_meta 内部**：`localizations[locale]` 进公开投影（前端按语言读取）；`localizations_meta`（翻译元数据/错误痕迹）经 `MIN_INTERNAL_FIELDS` 剔除。勿混为一谈。
13. **翻译不覆盖原文顶层字段**：翻译只写 `localizations[locale]`，原文顶层 `title`/`description` 保留作溯源核验基线。
14. **X 四桶预算实况**：account / discovery / article_retry / tail_recheck 四桶独立预占-结算（推文请求预占 300、长文读取预占 100，按实际返回量结算、最低 15 credits/条，返回 >20 条的部分记 overage，网络异常预占划入 unknown_reserved）；窗外推文不消耗配额；关键词与博主结果按 native_id 全局去重。
15. **YouTube search 独立桶 vs 合并桶**：search.list 走独立桶（100 次/天），耗尽**不会**自动切合并桶 → 需 `youtube_fallback_enabled=true` 降级 `mostPopular`（合并桶计费）；`requestText` 附 `error.body` 供 `isQuotaExceeded` 区分限流与配额耗尽。
16. **source_reliability 仅 X 评**：YouTube（及非 x 平台）该项 score=0、权重并入 `long_term_quality`（保持合计 1.00）；勿以为 YouTube 也在评来源可靠性。
17. **分类/审核并发执行**：LLM 逐条串行会卡十几分钟，分类与审核（`applyL1Verdicts`）都按 `config.collection.concurrency` 并发池执行。
18. **收尾环节只写清单、不自动改数据**：`transcripts / feedback / refine` 只写 `data/manual/` 固定格式文件交人工；配置变更只能经 `refine-apply`（人工勾选 adopted_keywords 后原子幂等追加），候选层变更只能经 `apply / top-apply / archive` 或 set/batch。
19. **ai-top 待选项不是最终结论**：`ai-top` 输出 top 10/15 待选项（`top_selected:false`），最终条数由维护者 `top-selected --ids` 确认；AI 提供候选池，不是自动发布。
20. **公开出口同一规则**：hotspots 构建、`publish-news.js`、RSS（`generateRss`）共用 `news-public-gate` 的近期窗口 + 公开字段完整规则（决策 72），防口径漂移。
