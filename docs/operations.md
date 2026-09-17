# 运维操作

> 环境变量、验证、CLI、CI、部署和恢复操作。

## 凭据与环境变量

| 变量 | 使用方 | 说明 |
|---|---|---|
| `ZHIPU_API_KEY` | `src/shared/providers/zhipu.js`、`src/news/classify/` | 默认外部 AI 提供商（分类、审核、结构化生成） |
| `DEEPSEEK_API_KEY` | `src/shared/providers/deepseek.js` | 备用外部 AI 提供商（provider 切回 deepseek 时生效） |
| `TAVILY_API_KEY` | `src/shared/tavily-client.js`、`src/catalog/core/catalog-research.js` | 官方来源发现、提取与回退抓取 |
| `YOUTUBE_API_KEY` | `src/news/collectors/collector-youtube-v2.js` | YouTube search.list 关键词发现，配额耗尽降级 mostPopular |
| `X_API_KEY` | `src/news/collectors/collector-x-v2.js` | TwitterAPI.io（X 博主时间窗 + 关键词搜索，独立计 credits） |
| `OPENAI_API_KEY` | `src/shared/providers/openai.js` | OpenAI Responses/Chat 提供商密钥，provider 切至 openai 时经 llm-gateway 生效 |
| `ANTHROPIC_API_KEY` | `src/shared/providers/anthropic.js` | Anthropic Messages 提供商密钥，实现标记为预留，网关当前拒绝调用 |

密钥仅存放在本地根目录 `.env` 或 GitHub Repository Secrets，不进入代码、JSON、浏览器或 CLI 参数。

### 仓库变量（Repository Variables）

| 变量 | 使用方 | 说明 |
|---|---|---|
| `NEWS_COLLECTION_ENABLED` | `collect-news.yml`（`collection_gate` job） | 新闻采集总开关：仅设置为字符串 `true` 时采集链路才会执行；其余取值时所有采集 job 直接跳过 |
| `TOOL_UPDATE_AI_FALLBACK_ENABLED` | `weekly-tool-update-review.yml` | 工具更新扫描的语义回退开关：`true` 时允许定时调度进入 hybrid 模式调用外部 AI 回退；手动 dispatch 可用 `enable_ai_fallback` 输入临时覆盖 |

## 验证与本地运行

```bash
node scripts/check-standards.js
node scripts/validate.js
node tests/index.js
node scripts/build-dist.js
```

全量测试通过 `node tests/index.js` 递归执行。构建静态站后本地预览：

```bash
python -m http.server 8000
# 浏览器打开 http://localhost:8000
```

启动维护者工作台：

```bash
node scripts/maintainer-workbench.js
# 仅监听 127.0.0.1，控制台输出带访问 token 的地址
```

## CLI 与维护批处理速查

### 常用批处理（Windows 维护入口）

| 批处理文件 | 作用 | 说明 |
|---|---|---|
| `bat/build-dist.bat` | 重建 `dist/` | 复制 `src/web`、`public`、`data` |
| `bat/after-first-review.bat` | 应用首审结论 | 自动触发关键词提纯与 Top 候选生成 |
| `bat/apply-top.bat` | 标记 Top 候选 | 发布每日热点公开投影 |
| `bat/apply-keywords.bat` | 采纳关键词提纯 | 更新后续采集关键词库 |
| `bat/archive-min.bat` | 归档热点候选 | 压缩历史并重置人工清单 |
| `bat/tool-update-review.bat` | 工具更新审核 | 提供中文菜单交互审核工具更新 |
| `bat/catalog-generator.bat` | 目录生成器 | 转发 Catalog 生成 CLI |
| `bat/concept-generator.bat` | 概念生成器 | 转发 Concept 生成 CLI |
| `bat/identity-review.bat` | 模型身份审计 | 检查模型跨源名称歧义 |

### 热点和人工内容

```bash
# min-review —— 热点管线 v2 候选审核（操作 min-candidates.json）
node scripts/news-cli.js min-review list [--status pending|approved|discarded] [--platform ...] [--limit N] [--top N] [--json]
node scripts/news-cli.js min-review set --id <id> --status approved|discarded
node scripts/news-cli.js min-review batch --ids <id1,id2,...> --status approved|discarded
node scripts/news-cli.js min-review repair [--no-external]
node scripts/news-cli.js min-review ai-top
node scripts/news-cli.js min-review top-selected --ids <id1,id2,...>
node scripts/news-cli.js min-review top-apply --file data/manual/top.json
node scripts/news-cli.js min-review transcripts
node scripts/news-cli.js min-review feedback
node scripts/news-cli.js min-review refine
node scripts/news-cli.js min-review refine-apply --file data/manual/keyword-refine.json

# 分类 / 本地化试跑
node scripts/news-cli.js classify preview --title <t> [--description <d>]
node scripts/news-cli.js localize preview --title <t> [--description <d>] [--locale zh]
```

## CI、构建与部署

仓库共有 6 个活跃 GitHub Actions 工作流：

| 工作流 | 触发条件 | 核心任务与输出 |
|---|---|---|
| `collect-news.yml` | 每日 cron（YouTube 每日北京 20:13；X 热半区每日北京 08:37 / 冷半区每日北京 20:43，均错开 :00/:30 高峰时段）/ 手动 | YouTube 受管线内 72h 到期闸保护；采集结果以 Data PR 交付候选与 runtime 状态（`min-candidates.json`、`source-history.json`、`x-checkpoints.json`、`last-run.json`、`schedule-state.json`、`review.json`），不直接提交 `main`，公开投影与 RSS 由 PR 合并后的 `publish-news.yml` 重建 |
| `publish-news.yml` | push `main` 监听 `data/news/runtime/min-candidates.json` 变动 | 从已审核候选重构公开投影，提交 `hotspots.json` 与 `public/feed.xml` |
| `refresh-comparison.yml` | 每日北京 05:17（UTC 21:17）/ 手动 | 抓取各源最新数据并重建 `data/comparison/`（raw 快照 + integrated 索引）；存在失败源、到期未就绪源或重建失败时工作流红灯，仓库旧数据原样保留 |
| `refresh-vibe-hub-cache.yml` | 每日北京 19:00（UTC 11:00）/ 手动 | 刷新超过 3 天 TTL 的概念缓存，更新 `data/manual/registries/vibe-hub-cache.json`；存在刷新失败条目时工作流红灯，失败条目保留旧值 |
| `weekly-tool-update-review.yml` | cron 为周一每小时 :17（UTC）；实际执行窗口取 `data/news/config/news-config-v2.json` 的 `tool_update_review_hour_utc` / `tool_update_review_minute_utc`（当前 03:17，前后 30 分钟内有效，窗口外的触发自动跳过不执行扫描）/ 手动 | 扫描官方工具更新源并更新 `data/manual/tools/tool-update-review.json`，发起审核 PR |
| `deploy.yml` | push `main` / 手动 | 执行 `validate.js`、运行全量回归，执行 `build-dist.js` 构建并部署至 GitHub Pages；部署完成后对线上首页、`data/catalog/tool-cards.json`、`data/comparison/integrated/index.json`、`data/news/output/hotspots.json`、`feed.xml` 依次 curl 冒烟，任一不可达即红灯 |

`deploy.yml` 运行 `node scripts/build-dist.js`，将 `src/web`、`public` 和浏览器所需 `data` 复制到 `dist/`，再上传 Pages artifact。

## 失败与禁止操作

- 热点构建失败不得以空结果覆盖上一版有效投影。
- 目录研究与合成失败时不得以人工编造记录替代。
- API 密钥仅在 `.env` 或 GitHub Secrets 注入，严禁进入代码、JSON、命令或日志。
- 当前无运行时数据库/Serverless 采集、实时推送或 AI 自动事实裁决。

## 失败处置

- **`refresh-comparison.yml` 红灯**：`fetch-comparison.js run` 在存在失败源、到期未就绪源或 integrated 重建失败时以非零退出（步骤日志末尾有 `fetched/failed/pending/rebuilt` 结构化摘要）。仓库中旧的 `data/comparison/` 数据保持原样有效，站点继续使用旧数据；修复源或网络问题后在 Actions 页面重跑该工作流即可，无需回滚数据。
- **`refresh-vibe-hub-cache.yml` 红灯**：表示本次存在刷新失败的 vibe-hub 缓存条目（脚本 `ok=false` 退出非 0）。失败条目的 `fetched_at` 不变、旧缓存继续生效，仅成功条目前移；修复后重跑工作流即补齐失败条目。
- **Data PR 冲突处置**：采集结果经 `scripts/deliver-news-data-pr.js` 交付到 `news/review/` 或 `news/data/` 前缀分支的 PR。PR 出现冲突或 head 漂移被拒时，入口是重跑 `collect-news.yml`（工作流会先从开放 PR 分支播种六文件基线再续跑管线）；必要时人工在 PR 页面解决冲突后合并。
- **Pages 部署失败排查**：先看 `deploy.yml` 的 `validate` job（数据校验 + 全量测试），再查 `deploy` job 的 `Build dist` 步骤；若两步都绿而内容异常，检查 `Smoke check deployed site` 步骤日志，定位首页、tool-cards.json、integrated/index.json、hotspots.json、feed.xml 五个冒烟地址中哪个不可达。
- **deploy 后 smoke**：smoke 在部署完成后立即对上述 5 个地址执行 `curl -fsS`，任一失败则该步骤失败（工作流红灯）；此时 Pages 线上内容不完整，先修复数据或构建问题并重新部署，再进行对外发布。

## 数据维护

```text
用户提交（GitHub Issue）→ 人工审核 → 合并或驳回并说明理由
```

纠错和新工具推荐通过 `.github/ISSUE_TEMPLATE/data-correction.yml` 与 `new-tool.yml` 接收。详细规则见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 运行验证与约束说明

- Edge/CDP 本地浏览器自动化脚本支持动态分配调试端口（`--remote-debugging-port=0`），自动规避 Windows 系统保留端口冲突。复现方法：`node scripts/build-dist.js` 构建后运行 `node scripts/browser-acceptance.js`（公开静态站；模型卡搜索与详情日期断言按目录数据动态取样，不绑定固定名单），维护者工作台则为 `node scripts/browser-workbench-acceptance.js`（注入内存 fixture 服务，不读写真实 `data/`）。两者都要求本地 `config/browser.local.json` 指向 Edge 可执行文件；未配置时无法运行，应如实标记为未验证。
- 真实第三方平台连续采集受外部配额与网络窗口约束。
