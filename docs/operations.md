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

密钥仅存放在本地根目录 `.env` 或 GitHub Repository Secrets，不进入代码、JSON、浏览器或 CLI 参数。

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

## CLI 与维护批处理速查

### 常用批处理（Windows 维护入口）

| 批处理文件 | 作用 | 说明 |
|---|---|---|
| `bat/build-dist.bat` | 重建 `dist/` | 复制 `src/web`、`public`、`data` |
| `bat/maintainer-workbench.bat` | 启动维护者审核平台 | 监听 127.0.0.1 本机端口 |
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
node scripts/news-cli.js min-review ai-top
node scripts/news-cli.js min-review top-selected --ids <id1,id2,...>
node scripts/news-cli.js min-review transcripts
node scripts/news-cli.js min-review feedback
node scripts/news-cli.js min-review refine

# 分类 / 本地化试跑
node scripts/news-cli.js classify preview --title <t> [--description <d>]
node scripts/news-cli.js localize preview --title <t> [--description <d>] [--locale zh]
```

## CI、构建与部署

仓库共有 6 个活跃 GitHub Actions 工作流：

| 工作流 | 触发条件 | 核心任务与输出 |
|---|---|---|
| `collect-news.yml` | 每日 cron（YouTube 每日北京 20:00；X 每日北京 13:00 / 22:00）/ 手动 | YouTube 受管线内 72h 到期闸保护；产出 `data/news/output/hotspots.json`、`min-candidates.json`、`source-history.json`、`public/feed.xml` |
| `publish-news.yml` | push `main` 监听 `data/news/runtime/min-candidates.json` 变动 | 从已审核候选重构公开投影，提交 `hotspots.json` 与 `public/feed.xml` |
| `refresh-comparison.yml` | 每日北京 05:17（UTC 21:17）/ 手动 | 抓取各源最新数据并重建 `data/comparison/`（raw 快照 + integrated 索引） |
| `refresh-vibe-hub-cache.yml` | 每日北京 19:00（UTC 11:00，YouTube 采集前 1h）/ 手动 | 刷新超过 3 天 TTL 的概念缓存，更新 `data/manual/registries/vibe-hub-cache.json` |
| `weekly-tool-update-review.yml` | 每周一 UTC 00:17 / 手动 | 扫描官方工具更新源并更新 `data/manual/tools/tool-update-review.json`，发起审核 PR |
| `deploy.yml` | push `main` / 手动 | 执行 `validate.js`、运行全量回归，执行 `build-dist.js` 构建并部署至 GitHub Pages |

`deploy.yml` 运行 `node scripts/build-dist.js`，将 `src/web`、`public` 和浏览器所需 `data` 复制到 `dist/`，再上传 Pages artifact。

## 失败与禁止操作

- 热点构建失败不得以空结果覆盖上一版有效投影。
- 目录研究与合成失败时不得以人工编造记录替代。
- API 密钥仅在 `.env` 或 GitHub Secrets 注入，严禁进入代码、JSON、命令或日志。
- 当前无运行时数据库/Serverless 采集、实时推送或 AI 自动事实裁决。

## 数据维护

```text
用户提交（GitHub Issue）→ 人工审核 → 合并或驳回并说明理由
```

纠错和新工具推荐通过 `.github/ISSUE_TEMPLATE/data-correction.yml` 与 `new-tool.yml` 接收。详细规则见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 运行验证与约束说明

- Edge/CDP 本地浏览器自动化脚本（`scripts/browser-acceptance.js`）支持动态分配调试端口（`--remote-debugging-port=0`），自动规避 Windows 系统保留端口冲突，全量 47 项端到端页面交互测试已全部通过。
- 真实第三方平台连续采集受外部配额与网络窗口约束。
